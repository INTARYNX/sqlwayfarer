const assert = require('assert');
const { QuerySession } = require('../database/QuerySession');

// A pinned connection that remembers what was asked of it.
function fakeConnection(log, state = { count: 0 }) {
	return {
		state,
		released: false,
		transactionCount: async () => { log.push('count'); if (state.broken) throw new Error('gone'); return state.count; },
		endTransaction: async action => { log.push(action); state.count = 0; },
		release() { this.released = true; }
	};
}

suite('QuerySession', () => {
	test('opens one connection and keeps it', async () => {
		let opened = 0;
		const connection = fakeConnection([]);
		const session = new QuerySession({ acquireConnection: async () => { opened++; return connection; } });
		const [a, b] = await Promise.all([session.get(), session.get()]);
		assert.strictEqual(a, connection);
		assert.strictEqual(b, connection);
		assert.strictEqual(await session.get(), connection);
		assert.strictEqual(opened, 1);
		assert.strictEqual(connection.released, false);
	});

	test('no session, no transaction', async () => {
		const session = new QuerySession({ acquireConnection: async () => fakeConnection([]) });
		assert.strictEqual(await session.transactionCount(), 0);
		assert.strictEqual(await session.end('rollback'), 0);
	});

	test('counts the open transactions and ends them', async () => {
		const log = [];
		const connection = fakeConnection(log, { count: 2 });
		const session = new QuerySession({ acquireConnection: async () => connection });
		await session.get();
		assert.strictEqual(await session.transactionCount(), 2);
		assert.strictEqual(await session.end('commit'), 0);
		assert.deepStrictEqual(log, ['count', 'commit', 'count']);
	});

	test('a connection that cannot answer is dropped, and a new one is opened', async () => {
		const first = fakeConnection([], { count: 1, broken: true });
		const second = fakeConnection([]);
		const connections = [first, second];
		const session = new QuerySession({ acquireConnection: async () => connections.shift() });
		await session.get();
		assert.strictEqual(await session.transactionCount(), 0);
		assert.strictEqual(first.released, true);
		assert.strictEqual(await session.get(), second);
	});

	test('closing rolls back what is open and releases the connection', async () => {
		const log = [];
		const connection = fakeConnection(log, { count: 1 });
		const session = new QuerySession({ acquireConnection: async () => connection });
		await session.get();
		await session.dispose();
		assert.deepStrictEqual(log, ['rollback']);
		assert.strictEqual(connection.released, true);
		await session.dispose(); // twice is harmless
	});

	test('closing survives a connection that is already gone', async () => {
		const connection = fakeConnection([]);
		connection.endTransaction = async () => { throw new Error('gone'); };
		const session = new QuerySession({ acquireConnection: async () => connection });
		await session.get();
		await session.dispose();
		assert.strictEqual(connection.released, true);
	});
});
