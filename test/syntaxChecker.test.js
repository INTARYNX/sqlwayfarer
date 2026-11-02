const assert = require('assert');
const { EventEmitter } = require('events');
const { SyntaxChecker, toDiagnostics, nearToken } = require('../database/SyntaxChecker');
const SyntaxHandlers = require('../panels/handlers/SyntaxHandlers');

// A server that finds an error in every batch containing "BAD" (line 2 of it), and records what it is sent.
function fakeServer() {
	const sent = [];
	const state = { connected: 0, disposed: 0, acquired: 0 };
	const manager = {
		connectWithSaved: async name => { state.connected++; state.name = name; },
		acquireConnection: async () => {
			state.acquired++;
			return {
				createRequest: () => {
					const request = new EventEmitter();
					request.batch = async text => { sent.push(text); };
					request.query = async text => {
						sent.push(text);
						if (/BAD/.test(text)) {
							const error = Object.assign(new Error("Incorrect syntax near the keyword 'FROM'."), { number: 156, lineNumber: 2 });
							request.emit('error', error);
							throw error;
						}
					};
					request.cancel = () => {};
					return request;
				}
			};
		},
		dispose: async () => { state.disposed++; }
	};
	return { sent, state, manager };
}

const checkerOf = server => new SyntaxChecker({ createManager: () => server.manager, getConnectionName: () => 'DEV' });

suite('SyntaxChecker', () => {
	test('a script without error gives nothing; PARSEONLY is set before every batch, on a connection of its own', async () => {
		const server = fakeServer();
		const checker = checkerOf(server);
		assert.deepStrictEqual(await checker.check('SELECT 1\nGO\nSELECT 2'), []);
		assert.deepStrictEqual(server.sent, ['SET PARSEONLY ON', 'SET PARSEONLY ON', 'SELECT 1\n', 'SET PARSEONLY ON', 'SELECT 2']);
		assert.deepStrictEqual([server.state.connected, server.state.acquired, server.state.name], [1, 1, 'DEV']);
		await checker.check('SELECT 3');
		assert.strictEqual(server.state.connected, 1, 'the session is kept');
	});

	test('the lines of an error are those of the whole script, whatever the batch it is in', async () => {
		const server = fakeServer();
		const diagnostics = await checkerOf(server).check('SELECT 1\nGO\nSELECT BAD\nFROM');
		assert.deepStrictEqual(diagnostics, [{ line: 4, message: "Incorrect syntax near the keyword 'FROM'.", near: 'FROM' }]);
	});

	test('a batch that mentions PARSEONLY is never sent: it could switch the check off', async () => {
		const server = fakeServer();
		const checker = checkerOf(server);
		assert.deepStrictEqual(await checker.check("SET parseonly OFF;\nDROP TABLE x"), []);
		assert.deepStrictEqual(await checker.check("SELECT 1\nGO\nSET  PARSEONLY  off\nGO\nSELECT 2"), []);
		assert.ok(!server.sent.some(text => /DROP TABLE|parseonly\s+off/i.test(text) && !/^SET PARSEONLY ON$/.test(text)), JSON.stringify(server.sent));
		assert.ok(server.sent.includes('SELECT 1\n') && server.sent.includes('SELECT 2'), 'the other batches are still checked');
	});

	test('a script with sqlcmd variables or directives is not checked', async () => {
		const server = fakeServer();
		const checker = checkerOf(server);
		for (const text of ['SELECT $(table)', ':setvar x 1\nSELECT 1', '  :r file.sql']) assert.deepStrictEqual(await checker.check(text), []);
		assert.deepStrictEqual(server.sent, []);
		assert.strictEqual(server.state.connected, 0, 'no connection is even opened');
	});

	test('an empty text is not sent anywhere', async () => {
		const server = fakeServer();
		assert.deepStrictEqual(await checkerOf(server).check('  \n '), []);
		assert.strictEqual(server.state.connected, 0);
	});

	test('a failed session is dropped and not reused', async () => {
		const server = fakeServer();
		let fail = true;
		const original = server.manager.acquireConnection;
		server.manager.acquireConnection = async () => { if (fail) throw new Error('login failed'); return original(); };
		const checker = checkerOf(server);
		await assert.rejects(() => checker.check('SELECT 1'), /login failed/);
		assert.strictEqual(server.state.disposed, 1);
		fail = false;
		assert.deepStrictEqual(await checker.check('SELECT 1'), []);
		assert.strictEqual(server.state.connected, 2, 'the next check opens a new session');
	});

	test('toDiagnostics keeps one error per line and nearToken finds the word', () => {
		const errors = [{ lineNumber: 1, message: "Unclosed quotation mark after the character string 'x'." }, { lineNumber: 1, message: "Incorrect syntax near 'x'." }, { lineNumber: 3, message: "Incorrect syntax near the keyword 'WHERE'." }];
		assert.deepStrictEqual(toDiagnostics(errors, 10).map(d => [d.line, d.near]), [[10, ''], [12, 'WHERE']]);
		assert.strictEqual(nearToken('Incorrect syntax near the keyword FROM.'), '');
		assert.strictEqual(nearToken("Incorrect syntax near ','."), ',');
	});
});

suite('SyntaxHandlers', () => {
	const setup = (checkImpl, enabled = () => true) => {
		const posted = [];
		const calls = [];
		let resets = 0;
		const checker = { check: async text => { calls.push(text); return checkImpl(text); }, reset: async () => { resets++; } };
		let clock = 1000;
		const handlers = new SyntaxHandlers(m => posted.push(m), checker, enabled, () => clock);
		return { handlers, posted, calls, resets: () => resets, tick: ms => { clock += ms; } };
	};

	test('the answer carries the id of the request', async () => {
		const { handlers, posted } = setup(() => [{ line: 1, message: 'm', near: '' }]);
		await handlers.handleCheckSyntax(7, 'SELECT');
		assert.deepStrictEqual(posted, [{ command: 'syntaxResult', requestId: 7, diagnostics: [{ line: 1, message: 'm', near: '' }] }]);
	});

	test('while a check runs only the latest text waits', async () => {
		let release;
		const gate = new Promise(resolve => { release = resolve; });
		const { handlers, posted, calls } = setup(async text => { if (text === 'a') await gate; return []; });
		const first = handlers.handleCheckSyntax(1, 'a');
		await handlers.handleCheckSyntax(2, 'b');
		await handlers.handleCheckSyntax(3, 'c');
		release();
		await first;
		assert.deepStrictEqual(calls, ['a', 'c']);
		assert.deepStrictEqual(posted.map(m => m.requestId), [1, 3]);
	});

	test('switched off, or too long, nothing is checked', async () => {
		const off = setup(() => [], () => false);
		await off.handlers.handleCheckSyntax(1, 'SELECT');
		assert.deepStrictEqual([off.calls, off.posted[0].diagnostics], [[], []]);
		const big = setup(() => []);
		await big.handlers.handleCheckSyntax(1, 'x'.repeat(300001));
		assert.deepStrictEqual(big.calls, []);
	});

	test('after a failure the server is left alone for a while, then asked again', async () => {
		let fail = true;
		const { handlers, posted, calls, tick } = setup(() => { if (fail) throw new Error('unreachable'); return []; });
		await handlers.handleCheckSyntax(1, 'a');
		assert.deepStrictEqual([posted[0].unavailable, posted[0].message], [true, 'unreachable']);
		await handlers.handleCheckSyntax(2, 'b');
		assert.strictEqual(calls.length, 1, 'no try during the pause');
		assert.strictEqual(posted[1].unavailable, true);
		tick(31000);
		fail = false;
		await handlers.handleCheckSyntax(3, 'c');
		assert.deepStrictEqual([calls.length, posted[2].diagnostics], [2, []]);
	});

	test('a reset ends the pause and drops the session', async () => {
		const { handlers, tick, calls, resets } = setup(() => { throw new Error('down'); });
		await handlers.handleCheckSyntax(1, 'a');
		await handlers.reset();
		assert.strictEqual(resets(), 1);
		await handlers.handleCheckSyntax(2, 'b');
		assert.strictEqual(calls.length, 2);
		void tick;
	});
});
