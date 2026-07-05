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
		assert.deepStrictEqual(result.messages, ['hello from PRINT']);
		assert.strictEqual(typeof result.durationMs, 'number');

		const hist = posts.find(p => p.command === 'queryHistoryLoaded');
		assert.ok(hist && hist.history.length === 1 && hist.history[0].success === true);
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
