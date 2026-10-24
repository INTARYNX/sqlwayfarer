const assert = require('assert');
const { EventEmitter } = require('events');
const QueryHandlers = require('../panels/handlers/QueryHandlers');

// Mocked mssql request: replays a scripted sequence of streaming events.
class FakeRequest extends EventEmitter {
	constructor(script) {
		super();
		this.script = script;
		this.cancelled = false;
	}
	query(sql) {
		this.sql = sql;
		return new Promise(resolve => {
			setImmediate(() => {
				this.script(this);
				resolve();
			});
		});
	}
	cancel() {
		this.cancelled = true;
	}
}

// Minimal Memento stand-in for workspaceState.
function makeState() {
	const store = new Map();
	return {
		get: (k, d) => (store.has(k) ? store.get(k) : d),
		update: async (k, v) => { store.set(k, v); }
	};
}

suite('QueryHandlers', () => {
	test('streams multiple result sets and applies the row cap', async () => {
		const posts = [];
		const handlers = new QueryHandlers(m => posts.push(m), {
			createRequest: () => new FakeRequest(req => {
				req.emit('recordset', { id: {}, name: {} });
				req.emit('row', { id: 1, name: 'a' });
				req.emit('row', { id: 2, name: 'b' });
				req.emit('rowsaffected', 2);
				req.emit('recordset', { x: {} });
				for (let i = 0; i < 10; i++) req.emit('row', { x: i });
				req.emit('rowsaffected', 10);
				req.emit('info', { message: 'hello from PRINT' });
			})
		}, makeState());

		await handlers.handleExecuteQuery('MyDb', 'SELECT 1; SELECT 2;', 5);

		const result = posts.find(p => p.command === 'queryResult');
		assert.ok(result, 'queryResult should be posted');
		assert.strictEqual(result.resultSets.length, 2);
		assert.deepStrictEqual(result.resultSets[0].columns, ['id', 'name']);
		assert.strictEqual(result.resultSets[0].totalRows, 2);
		assert.strictEqual(result.resultSets[1].rows.length, 5, 'rows beyond the cap are discarded');
		assert.strictEqual(result.resultSets[1].totalRows, 10, 'total row count is still reported');
		assert.deepStrictEqual(result.timeline, [
			{ type: 'resultSet', index: 0 },
			{ type: 'resultSet', index: 1 },
			{ type: 'message', text: 'hello from PRINT' }
		]);
		assert.strictEqual(typeof result.durationMs, 'number');

		const hist = posts.find(p => p.command === 'queryHistoryLoaded');
		assert.ok(hist && hist.history.length === 1 && hist.history[0].success === true);
	});

	test('actual plan: separates the STATISTICS XML plan recordset from real result sets', async () => {
		const posts = [];
		// Confirmed against a real SQL Server response: the plan recordset's
		// single column is literally named "Microsoft SQL Server 2005 XML
		// Showplan" (a fixed legacy name) and reported as NVarChar, not Xml.
		const handlers = new QueryHandlers(m => posts.push(m), {
			createRequest: () => new FakeRequest(req => {
				req.emit('recordset', { id: { type: function Int() {} } });
				req.emit('row', { id: 1 });
				req.emit('rowsaffected', 1);
				req.emit('recordset', { 'Microsoft SQL Server 2005 XML Showplan': { type: function NVarChar() {} } });
				req.emit('row', { 'Microsoft SQL Server 2005 XML Showplan': '<ShowPlanXML>plan</ShowPlanXML>' });
			})
		}, makeState());

		await handlers.handleGetActualPlan('MyDb', 'SELECT 1 AS id', 1000);

		const result = posts.find(p => p.command === 'queryResult');
		assert.ok(result, 'queryResult should be posted');
		assert.strictEqual(result.resultSets.length, 1, 'the plan recordset must not be counted as a data result set');
		assert.deepStrictEqual(result.resultSets[0].columns, ['id']);
		assert.deepStrictEqual(result.planXmls, ['<ShowPlanXML>plan</ShowPlanXML>']);
	});

	test('labels each result set with the statement that produced it when counts line up', async () => {
		const posts = [];
		const handlers = new QueryHandlers(m => posts.push(m), {
			createRequest: () => new FakeRequest(req => {
				req.emit('recordset', { id: {} });
				req.emit('row', { id: 1 });
				req.emit('recordset', { name: {} });
				req.emit('row', { name: 'a' });
			})
		}, makeState());

		await handlers.handleExecuteQuery('MyDb', 'SELECT 1 AS id;\nSELECT 2 AS name;', 1000);

		const result = posts.find(p => p.command === 'queryResult');
		assert.strictEqual(result.resultSets[0].sourceStatement, 'SELECT 1 AS id');
		assert.strictEqual(result.resultSets[1].sourceStatement, 'SELECT 2 AS name');
	});

	test('does not guess a sourceStatement when the statement count does not match', async () => {
		const posts = [];
		const handlers = new QueryHandlers(m => posts.push(m), {
			createRequest: () => new FakeRequest(req => {
				req.emit('recordset', { id: {} });
				req.emit('row', { id: 1 });
				req.emit('recordset', { name: {} });
				req.emit('row', { name: 'a' });
			})
		}, makeState());

		// One EXEC statement yields two recordsets - counts don't line up, so no guess is made.
		await handlers.handleExecuteQuery('MyDb', 'EXEC dbo.uspGetTwoSets;', 1000);

		const result = posts.find(p => p.command === 'queryResult');
		assert.strictEqual(result.resultSets[0].sourceStatement, undefined);
		assert.strictEqual(result.resultSets[1].sourceStatement, undefined);
	});

	test('shifts SQL error line numbers to compensate for the injected USE statement', async () => {
		const posts = [];
		const handlers = new QueryHandlers(m => posts.push(m), {
			createRequest: () => new FakeRequest(req => {
				const err = new Error('Invalid object name toto.');
				err.lineNumber = 3;
				req.emit('error', err);
			})
		}, makeState());

		await handlers.handleExecuteQuery('MyDb', 'bad sql', 1000);

		const errMsg = posts.find(p => p.command === 'queryError');
		assert.ok(errMsg.message.includes('Line 2:'), errMsg.message);
	});

	test('cancel aborts the running request and reports it as cancelled', async () => {
		const posts = [];
		let fakeReq;
		const handlers = new QueryHandlers(m => posts.push(m), {
			createRequest: () => {
				fakeReq = new FakeRequest(req => {
					if (req.cancelled) {
						req.emit('error', Object.assign(new Error('Canceled.'), { code: 'ECANCEL' }));
					}
				});
				return fakeReq;
			}
		}, makeState());

		const running = handlers.handleExecuteQuery('MyDb', "WAITFOR DELAY '00:10:00'", 1000);
		handlers.handleCancelQuery();
		await running;

		const cancelMsg = posts.find(m => m.command === 'queryError');
		assert.strictEqual(cancelMsg.cancelled, true);
		assert.strictEqual(cancelMsg.message, 'Query cancelled.');
		assert.ok(fakeReq.cancelled, 'request.cancel() should be invoked');
	});

	test('history dedupes identical queries, newest first, and can be cleared', async () => {
		const posts = [];
		const handlers = new QueryHandlers(m => posts.push(m), {
			createRequest: () => new FakeRequest(req => { req.emit('rowsaffected', 1); })
		}, makeState());

		await handlers.handleExecuteQuery('Db1', 'UPDATE t SET x=1', 1000);
		await handlers.handleExecuteQuery('Db1', 'UPDATE t SET x=1', 1000);
		await handlers.handleExecuteQuery('Db1', 'SELECT 1', 1000);

		const finalHist = posts.filter(p => p.command === 'queryHistoryLoaded').pop();
		assert.strictEqual(finalHist.history.length, 2, 'identical re-runs should not pile up');
		assert.strictEqual(finalHist.history[0].query, 'SELECT 1');

		await handlers.handleClearQueryHistory();
		assert.strictEqual(posts.pop().history.length, 0);
	});

	test('prefixes the query with USE [database]', async () => {
		let captured;
		const handlers = new QueryHandlers(() => {}, {
			createRequest: () => {
				captured = new FakeRequest(() => {});
				return captured;
			}
		}, makeState());

		await handlers.handleExecuteQuery('My Db', 'SELECT 1', 1000);
		assert.ok(captured.sql.startsWith('USE [My Db];\n'), captured.sql);
	});

	test('destructive queries are cancelled when the user refuses confirmation', async () => {
		const posts = [];
		const analyzer = { analyze: q => q.includes('DELETE') ? ['DELETE without WHERE on dbo.T'] : [] };
		const handlers = new QueryHandlers(m => posts.push(m), {
			createRequest: () => new FakeRequest(req => { req.emit('rowsaffected', 1); })
		}, makeState(), analyzer);

		handlers._confirmRisks = async () => false;
		await handlers.handleExecuteQuery('Db1', 'DELETE FROM T', 1000);

		const err = posts.find(p => p.command === 'queryError');
		assert.ok(err && err.cancelled, 'refusal must cancel, not fail');
		assert.ok(err.message.includes('DELETE without WHERE'));
		assert.ok(!posts.some(p => p.command === 'queryResult'), 'query must not run');

		// Confirmed → executes normally; safe queries never prompt
		posts.length = 0;
		handlers._confirmRisks = async () => true;
		await handlers.handleExecuteQuery('Db1', 'DELETE FROM T', 1000);
		assert.ok(posts.some(p => p.command === 'queryResult'));
	});

	test('rejects a second query while one is still running', async () => {
		const posts = [];
		let release;
		const gate = new Promise(resolve => { release = resolve; });
		const handlers = new QueryHandlers(m => posts.push(m), {
			createRequest: () => {
				const req = new FakeRequest(() => {});
				req.query = () => gate;
				return req;
			}
		}, makeState());

		const first = handlers.handleExecuteQuery('Db1', 'SELECT 1', 1000);
		await handlers.handleExecuteQuery('Db1', 'SELECT 2', 1000);

		const busy = posts.find(p => p.command === 'queryError');
		assert.ok(busy && busy.message.includes('already running'), 'concurrent run should be refused');

		release();
		await first;
	});
});

suite('QueryHandlers.splitTopLevelStatements', () => {
	test('splits on top-level semicolons and trims whitespace', () => {
		const statements = QueryHandlers.splitTopLevelStatements('SELECT 1;\n  SELECT 2;  ');
		assert.deepStrictEqual(statements, ['SELECT 1', 'SELECT 2']);
	});

	test('ignores semicolons inside string literals, including escaped quotes', () => {
		const statements = QueryHandlers.splitTopLevelStatements("SELECT 'a;b''c;d'; SELECT 2;");
		assert.deepStrictEqual(statements, ["SELECT 'a;b''c;d'", 'SELECT 2']);
	});

	test('ignores semicolons inside line and block comments', () => {
		const statements = QueryHandlers.splitTopLevelStatements(
			'SELECT 1; -- a;b\nSELECT 2; /* c;d */ SELECT 3;'
		);
		// The comments' own semicolons must not cause extra splits - comment text
		// itself is kept as-is, this isn't a full parser.
		assert.strictEqual(statements.length, 3);
		assert.ok(statements[2].includes('SELECT 3'), statements[2]);
	});

	test('ignores semicolons inside bracketed identifiers', () => {
		const statements = QueryHandlers.splitTopLevelStatements('SELECT * FROM [a;b];');
		assert.deepStrictEqual(statements, ['SELECT * FROM [a;b]']);
	});

	test('a trailing statement without a final semicolon is still included', () => {
		const statements = QueryHandlers.splitTopLevelStatements('SELECT 1; SELECT 2');
		assert.deepStrictEqual(statements, ['SELECT 1', 'SELECT 2']);
	});

	test('splits statements on a line break alone, with no semicolons at all', () => {
		const statements = QueryHandlers.splitTopLevelStatements(
			'SELECT TOP 5 * FROM sys.tables\nSELECT TOP 5 * FROM sys.columns'
		);
		assert.deepStrictEqual(statements, [
			'SELECT TOP 5 * FROM sys.tables',
			'SELECT TOP 5 * FROM sys.columns'
		]);
	});

	test('does not split a single statement spanning multiple lines', () => {
		const statements = QueryHandlers.splitTopLevelStatements('SELECT col1,\n col2\nFROM dbo.T');
		assert.deepStrictEqual(statements, ['SELECT col1,\n col2\nFROM dbo.T']);
	});

	test('does not split on a leading keyword inside a parenthesized subquery', () => {
		const statements = QueryHandlers.splitTopLevelStatements(
			'SELECT *\nFROM t\nWHERE EXISTS (\n  SELECT 1\n  FROM u\n)'
		);
		assert.strictEqual(statements.length, 1);
	});

	test('recognizes EXEC, INSERT, UPDATE, DELETE and WITH as statement leaders', () => {
		const statements = QueryHandlers.splitTopLevelStatements(
			'EXEC dbo.uspFoo\nINSERT INTO t VALUES (1)\nUPDATE t SET x = 1\nDELETE FROM t\nWITH cte AS (SELECT 1 AS x) SELECT * FROM cte'
		);
		assert.strictEqual(statements.length, 5);
	});
});
