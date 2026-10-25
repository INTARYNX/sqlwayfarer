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

// Minimal ConnectionManager stand-in: acquireConnection() pins one connection
// for the whole script (all GO-separated batches share it), same contract as
// the real ConnectionManager.acquireConnection(). createRequestFn is called
// once per batch/repetition, same as conn.createRequest() in the real code.
function connMock(createRequestFn) {
	return { acquireConnection: async () => ({ createRequest: createRequestFn, release: () => {} }) };
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
		const handlers = new QueryHandlers(m => posts.push(m), connMock(() => new FakeRequest(req => {
			req.emit('recordset', { id: {}, name: {} });
			req.emit('row', { id: 1, name: 'a' });
			req.emit('row', { id: 2, name: 'b' });
			req.emit('rowsaffected', 2);
			req.emit('recordset', { x: {} });
			for (let i = 0; i < 10; i++) req.emit('row', { x: i });
			req.emit('rowsaffected', 10);
			req.emit('info', { message: 'hello from PRINT' });
		})), makeState());

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
		const handlers = new QueryHandlers(m => posts.push(m), connMock(() => new FakeRequest(req => {
			req.emit('recordset', { id: { type: function Int() {} } });
			req.emit('row', { id: 1 });
			req.emit('rowsaffected', 1);
			req.emit('recordset', { 'Microsoft SQL Server 2005 XML Showplan': { type: function NVarChar() {} } });
			req.emit('row', { 'Microsoft SQL Server 2005 XML Showplan': '<ShowPlanXML>plan</ShowPlanXML>' });
		})), makeState());

		await handlers.handleGetActualPlan('MyDb', 'SELECT 1 AS id', 1000);

		const result = posts.find(p => p.command === 'queryResult');
		assert.ok(result, 'queryResult should be posted');
		assert.strictEqual(result.resultSets.length, 1, 'the plan recordset must not be counted as a data result set');
		assert.deepStrictEqual(result.resultSets[0].columns, ['id']);
		assert.deepStrictEqual(result.planXmls, ['<ShowPlanXML>plan</ShowPlanXML>']);
	});

	test('labels each result set with the statement that produced it when counts line up', async () => {
		const posts = [];
		const handlers = new QueryHandlers(m => posts.push(m), connMock(() => new FakeRequest(req => {
			req.emit('recordset', { id: {} });
			req.emit('row', { id: 1 });
			req.emit('recordset', { name: {} });
			req.emit('row', { name: 'a' });
		})), makeState());

		await handlers.handleExecuteQuery('MyDb', 'SELECT 1 AS id;\nSELECT 2 AS name;', 1000);

		const result = posts.find(p => p.command === 'queryResult');
		assert.strictEqual(result.resultSets[0].sourceStatement, 'SELECT 1 AS id');
		assert.strictEqual(result.resultSets[1].sourceStatement, 'SELECT 2 AS name');
	});

	test('does not guess a sourceStatement when the statement count does not match', async () => {
		const posts = [];
		const handlers = new QueryHandlers(m => posts.push(m), connMock(() => new FakeRequest(req => {
			req.emit('recordset', { id: {} });
			req.emit('row', { id: 1 });
			req.emit('recordset', { name: {} });
			req.emit('row', { name: 'a' });
		})), makeState());

		// One EXEC statement yields two recordsets - counts don't line up, so no guess is made.
		await handlers.handleExecuteQuery('MyDb', 'EXEC dbo.uspGetTwoSets;', 1000);

		const result = posts.find(p => p.command === 'queryResult');
		assert.strictEqual(result.resultSets[0].sourceStatement, undefined);
		assert.strictEqual(result.resultSets[1].sourceStatement, undefined);
	});

	test('shifts SQL error line numbers to compensate for the injected USE statement', async () => {
		const posts = [];
		const handlers = new QueryHandlers(m => posts.push(m), connMock(() => new FakeRequest(req => {
			const err = new Error('Invalid object name toto.');
			err.lineNumber = 3;
			req.emit('error', err);
		})), makeState());

		await handlers.handleExecuteQuery('MyDb', 'bad sql', 1000);

		const errMsg = posts.find(p => p.command === 'queryError');
		assert.ok(errMsg.message.includes('Line 2:'), errMsg.message);
	});

	test('cancel aborts the running request and reports it as cancelled', async () => {
		const posts = [];
		let fakeReq;
		const handlers = new QueryHandlers(m => posts.push(m), connMock(() => {
			fakeReq = new FakeRequest(req => {
				if (req.cancelled) {
					req.emit('error', Object.assign(new Error('Canceled.'), { code: 'ECANCEL' }));
				}
			});
			return fakeReq;
		}), makeState());

		const running = handlers.handleExecuteQuery('MyDb', "WAITFOR DELAY '00:10:00'", 1000);
		// acquireConnection() is now a real async step before the request
		// exists - let that microtask chain (and entering the request's own
		// query()) settle so _currentRequest is actually set before
		// cancelling it, same as a real in-flight query would be.
		await new Promise(resolve => setImmediate(resolve));
		handlers.handleCancelQuery();
		await running;

		const cancelMsg = posts.find(m => m.command === 'queryError');
		assert.strictEqual(cancelMsg.cancelled, true);
		assert.strictEqual(cancelMsg.message, 'Query cancelled.');
		assert.ok(fakeReq.cancelled, 'request.cancel() should be invoked');
	});

	// A cancel can race the connection acquire itself - arriving before any
	// request (or _currentRequest) exists at all. It must still stop the
	// script from running any batch, not be silently dropped.
	test('cancel arriving before the connection is even acquired still stops the script', async () => {
		const posts = [];
		let releaseAcquire;
		const acquireGate = new Promise(resolve => { releaseAcquire = resolve; });
		let batchStarted = false;
		const handlers = new QueryHandlers(m => posts.push(m), {
			acquireConnection: async () => {
				await acquireGate;
				return {
					createRequest: () => { batchStarted = true; return new FakeRequest(req => req.emit('rowsaffected', 1)); },
					release: () => {}
				};
			}
		}, makeState());

		const running = handlers.handleExecuteQuery('MyDb', 'SELECT 1', 1000);
		handlers.handleCancelQuery();
		releaseAcquire();
		await running;

		assert.strictEqual(batchStarted, false, 'no batch should ever run once cancelled, even pre-acquire');
		const cancelMsg = posts.find(m => m.command === 'queryError');
		assert.strictEqual(cancelMsg.cancelled, true);
	});

	test('history dedupes identical queries, newest first, and can be cleared', async () => {
		const posts = [];
		const handlers = new QueryHandlers(m => posts.push(m), connMock(() => new FakeRequest(req => { req.emit('rowsaffected', 1); })), makeState());

		await handlers.handleExecuteQuery('Db1', 'UPDATE t SET x=1', 1000);
		await handlers.handleExecuteQuery('Db1', 'UPDATE t SET x=1', 1000);
		await handlers.handleExecuteQuery('Db1', 'SELECT 1', 1000);

		const finalHist = posts.filter(p => p.command === 'queryHistoryLoaded').pop();
		assert.strictEqual(finalHist.history.length, 2, 'identical re-runs should not pile up');
		assert.strictEqual(finalHist.history[0].query, 'SELECT 1');

		await handlers.handleClearQueryHistory();
		assert.strictEqual(posts.pop().history.length, 0);
	});

	// History is scoped per connection (server+login) so two tabs on different
	// servers never share, or clobber, each other's history - see
	// database/connectionIdentity.js.
	test('history is scoped per connection identity, not shared across connections', async () => {
		const posts = [];
		const state = makeState();
		let identity = 'server1:1433:sa';
		const handlers = new QueryHandlers(m => posts.push(m), connMock(() => new FakeRequest(req => { req.emit('rowsaffected', 1); })), state, null, () => identity);

		await handlers.handleExecuteQuery('Db1', 'UPDATE t SET x=1', 1000);
		identity = 'server2:1433:sa';
		await handlers.handleExecuteQuery('Db1', 'UPDATE t SET y=2', 1000);

		await handlers.handleGetQueryHistory();
		const server2Hist = posts.pop();
		assert.strictEqual(server2Hist.history.length, 1, 'server2 must not see server1\'s history');
		assert.strictEqual(server2Hist.history[0].query, 'UPDATE t SET y=2');

		identity = 'server1:1433:sa';
		await handlers.handleGetQueryHistory();
		const server1Hist = posts.pop();
		assert.strictEqual(server1Hist.history.length, 1, 'switching back to server1 must still see its own history, untouched');
		assert.strictEqual(server1Hist.history[0].query, 'UPDATE t SET x=1');
	});

	test('prefixes the query with USE [database]', async () => {
		let captured;
		const handlers = new QueryHandlers(() => {}, connMock(() => {
			captured = new FakeRequest(() => {});
			return captured;
		}), makeState());

		await handlers.handleExecuteQuery('My Db', 'SELECT 1', 1000);
		assert.ok(captured.sql.startsWith('USE [My Db];\n'), captured.sql);
	});

	// S3: a database name containing ']' used to break out of the bracketed
	// identifier and let the rest run as a separate statement.
	test('a database name containing "]" is escaped, not left to break out of the USE statement', async () => {
		let captured;
		const handlers = new QueryHandlers(() => {}, connMock(() => {
			captured = new FakeRequest(() => {});
			return captured;
		}), makeState());

		await handlers.handleExecuteQuery("x]; DROP DATABASE foo;--", 'SELECT 1', 1000);
		assert.ok(captured.sql.startsWith('USE [x]]; DROP DATABASE foo;--];\n'), captured.sql);
	});

	test('destructive queries are cancelled when the user refuses confirmation', async () => {
		const posts = [];
		const analyzer = { analyze: q => q.includes('DELETE') ? ['DELETE without WHERE on dbo.T'] : [] };
		const handlers = new QueryHandlers(m => posts.push(m), connMock(() => new FakeRequest(req => { req.emit('rowsaffected', 1); })), makeState(), analyzer);

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
		const handlers = new QueryHandlers(m => posts.push(m), connMock(() => {
			const req = new FakeRequest(() => {});
			req.query = () => gate;
			return req;
		}), makeState());

		const first = handlers.handleExecuteQuery('Db1', 'SELECT 1', 1000);
		await handlers.handleExecuteQuery('Db1', 'SELECT 2', 1000);

		const busy = posts.find(p => p.command === 'queryError');
		assert.ok(busy && busy.message.includes('already running'), 'concurrent run should be refused');

		release();
		await first;
	});

	// The busy guard (_executing) must also cover the gap between the initial
	// synchronous checks and acquireConnection() actually resolving - a real
	// async boundary, unlike the old synchronous createRequest().
	test('rejects a second query that arrives while still acquiring the connection', async () => {
		const posts = [];
		let releaseAcquire;
		const acquireGate = new Promise(resolve => { releaseAcquire = resolve; });
		const handlers = new QueryHandlers(m => posts.push(m), {
			acquireConnection: async () => {
				await acquireGate;
				return { createRequest: () => new FakeRequest(req => req.emit('rowsaffected', 1)), release: () => {} };
			}
		}, makeState());

		const first = handlers.handleExecuteQuery('Db1', 'SELECT 1', 1000);
		await handlers.handleExecuteQuery('Db1', 'SELECT 2', 1000);

		const busy = posts.find(p => p.command === 'queryError');
		assert.ok(busy && busy.message.includes('already running'), 'concurrent run should be refused even mid-acquire');

		releaseAcquire();
		await first;
	});

	test('a GO-separated script runs each batch as its own request, in order', async () => {
		const posts = [];
		const batchSqls = [];
		const handlers = new QueryHandlers(m => posts.push(m), connMock(() => {
			const req = new FakeRequest(r => {
				const n = batchSqls.length; // this batch's own number, before it's recorded below
				r.emit('recordset', { x: {} });
				r.emit('row', { x: n });
				r.emit('rowsaffected', 1);
			});
			const originalQuery = req.query.bind(req);
			req.query = (text) => { batchSqls.push(text); return originalQuery(text); };
			return req;
		}), makeState());

		await handlers.handleExecuteQuery('MyDb', 'CREATE TABLE T (x int)\nGO\nSELECT * FROM T', 1000);

		assert.strictEqual(batchSqls.length, 2, 'two GO-separated batches must be sent as two separate requests');
		assert.ok(batchSqls[0].includes('CREATE TABLE T (x int)'));
		assert.ok(!batchSqls[0].includes('SELECT * FROM T'), 'the second batch must not leak into the first');
		assert.ok(batchSqls[1].includes('SELECT * FROM T'));
		assert.ok(batchSqls[0].startsWith('USE [MyDb];\n'), 'only the first batch gets the USE prefix');
		assert.ok(!batchSqls[1].includes('USE ['), 'a later batch must not re-force the dropdown database - the connection keeps whatever context the script itself set');

		const result = posts.find(p => p.command === 'queryResult');
		assert.ok(result, 'queryResult should be posted');
		assert.strictEqual(result.resultSets.length, 2, 'both batches\' result sets are aggregated into one result');
	});

	test('"GO 3" re-runs the preceding batch 3 times', async () => {
		const posts = [];
		let calls = 0;
		const handlers = new QueryHandlers(m => posts.push(m), connMock(() => new FakeRequest(req => {
			calls++;
			req.emit('rowsaffected', 1);
		})), makeState());

		await handlers.handleExecuteQuery('MyDb', "INSERT INTO T DEFAULT VALUES\nGO 3", 1000);

		assert.strictEqual(calls, 3, 'the batch before "GO 3" must run 3 times');
		assert.ok(posts.some(p => p.command === 'queryResult'));
	});

	test('GO inside a string literal, comment or bracketed identifier is not treated as a separator', async () => {
		let batchCount = 0;
		const handlers = new QueryHandlers(() => {}, connMock(() => {
			batchCount++;
			return new FakeRequest(() => {});
		}), makeState());

		await handlers.handleExecuteQuery('MyDb', "SELECT 'GO' AS [GO], 1 -- GO\n/* GO */ SELECT [a GO b]", 1000);
		assert.strictEqual(batchCount, 1, 'none of these should be mistaken for a batch separator');
	});

	test('a batch error does not stop later GO-separated batches, and reports the correct original line', async () => {
		const posts = [];
		let call = 0;
		const handlers = new QueryHandlers(m => posts.push(m), connMock(() => {
			call++;
			if (call === 2) {
				return new FakeRequest(req => {
					const err = new Error('Invalid object name missing.');
					err.lineNumber = 1; // line 1 of THIS batch's own sent text - no USE prefix on a non-first batch
					req.emit('error', err);
				});
			}
			return new FakeRequest(req => { req.emit('rowsaffected', 1); });
		}), makeState());

		// Batch 1 spans lines 1-2, GO is line 3, batch 2 (failing) starts at line 4.
		await handlers.handleExecuteQuery('MyDb', 'SELECT 1\nSELECT 2\nGO\nSELECT * FROM missing\nGO\nSELECT 3', 1000);

		assert.strictEqual(call, 3, 'the 3rd batch must still run after the 2nd one failed');
		const err = posts.find(p => p.command === 'queryError');
		assert.ok(err, 'a failing batch surfaces as queryError even though later batches ran');
		// Batch 2's own line 1 ("SELECT * FROM missing") is line 4 of the original script.
		assert.ok(err.message.includes('Line 4:'), err.message);
		assert.ok(err.rowsAffected && err.rowsAffected.length > 0, 'successful batches\' results are still included');
	});

	test('cancelling mid-script stops subsequent GO-separated batches', async () => {
		const posts = [];
		let call = 0;
		let fakeReq;
		const handlers = new QueryHandlers(m => posts.push(m), connMock(() => {
			call++;
			fakeReq = new FakeRequest(req => {
				if (req.cancelled) req.emit('error', Object.assign(new Error('Canceled.'), { code: 'ECANCEL' }));
				else req.emit('rowsaffected', 1);
			});
			return fakeReq;
		}), makeState());

		const running = handlers.handleExecuteQuery('MyDb', "WAITFOR DELAY '00:10:00'\nGO\nSELECT 1", 1000);
		// Let the first batch actually start (see the timing note on the
		// single-batch cancel test above) before cancelling it.
		await new Promise(resolve => setImmediate(resolve));
		handlers.handleCancelQuery();
		await running;

		assert.strictEqual(call, 1, 'the second batch must never start once cancelled');
		const cancelMsg = posts.find(m => m.command === 'queryError');
		assert.strictEqual(cancelMsg.cancelled, true);
	});
});

suite('QueryHandlers.splitBatches', () => {
	test('no GO at all yields a single batch with the original text untouched', () => {
		const batches = QueryHandlers.splitBatches('SELECT 1');
		assert.deepStrictEqual(batches, [{ sql: 'SELECT 1', repeat: 1, startLine: 1 }]);
	});

	test('splits on a standalone GO line, excluding it from either batch', () => {
		const batches = QueryHandlers.splitBatches('SELECT 1\nGO\nSELECT 2');
		assert.strictEqual(batches.length, 2);
		assert.strictEqual(batches[0].sql.trim(), 'SELECT 1');
		assert.strictEqual(batches[1].sql.trim(), 'SELECT 2');
		assert.strictEqual(batches[0].startLine, 1);
		assert.strictEqual(batches[1].startLine, 3);
	});

	test('parses a repeat count from "GO N"', () => {
		const batches = QueryHandlers.splitBatches('INSERT INTO T DEFAULT VALUES\nGO 5');
		assert.strictEqual(batches.length, 1);
		assert.strictEqual(batches[0].repeat, 5);
	});

	test('tolerates a trailing line comment after GO', () => {
		const batches = QueryHandlers.splitBatches('SELECT 1\nGO -- run the next part\nSELECT 2');
		assert.strictEqual(batches.length, 2);
	});

	test('does not split on GO inside a string literal, line comment, block comment or bracketed identifier', () => {
		const batches = QueryHandlers.splitBatches("SELECT 'GO', [GO] -- GO\n/* GO\nmultiline */ SELECT 1");
		assert.strictEqual(batches.length, 1);
	});

	test('does not split on "go" appearing as part of a longer word', () => {
		const batches = QueryHandlers.splitBatches('SELECT * FROM dbo.Goods\nGOOD\nSELECT 2');
		assert.strictEqual(batches.length, 1);
	});

	test('startLine accounts for a multi-line block comment before a later batch', () => {
		const batches = QueryHandlers.splitBatches('SELECT 1\nGO\n/* line2\nline3\nline4 */\nSELECT 2');
		assert.strictEqual(batches.length, 2);
		assert.strictEqual(batches[1].startLine, 3);
	});

	test('a script that is only GO yields no batches', () => {
		assert.deepStrictEqual(QueryHandlers.splitBatches('GO'), []);
	});

	test('handles CRLF line endings', () => {
		const batches = QueryHandlers.splitBatches('SELECT 1\r\nGO\r\nSELECT 2');
		assert.strictEqual(batches.length, 2);
		assert.strictEqual(batches[0].sql.trim(), 'SELECT 1');
		assert.strictEqual(batches[1].sql.trim(), 'SELECT 2');
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
