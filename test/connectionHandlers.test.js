const assert = require('assert');
const ConnectionHandlers = require('../panels/handlers/ConnectionHandlers');

function fakeConnectionManager() {
	return {
		connectWithSaved: async () => {}
	};
}

function fakeStorage(savedConnections = {}) {
	const lastUsed = [];
	return {
		getConnection: name => savedConnections[name] || null,
		setLastConnectionName: async name => { lastUsed.push(name); },
		lastUsed
	};
}

suite('ConnectionHandlers - no two tabs on the same connection', () => {
	test('handleConnectWithSaved resolves identity from the saved connection and refuses a duplicate', async () => {
		const posts = [];
		const revealed = [];
		const other = { label: 'other-panel' };
		const panelController = {
			findDuplicate: () => other,
			reveal: panel => revealed.push(panel),
			onConnectionChanged: () => { throw new Error('must not connect when a duplicate is found'); }
		};
		const connectionManager = fakeConnectionManager();
		connectionManager.connectWithSaved = async () => { throw new Error('must not actually connect'); };
		const storage = fakeStorage({ Prod: { server: 'srv', port: 1433, username: 'sa' } });
		const handlers = new ConnectionHandlers(m => posts.push(m), connectionManager, storage, panelController);

		const ok = await handlers.handleConnectWithSaved('Prod');

		assert.strictEqual(ok, false);
		assert.deepStrictEqual(revealed, [other]);
		assert.strictEqual(posts.pop().success, false);
	});

	test('handleConnectWithSaved records the identity when no other tab has it', async () => {
		const posts = [];
		const changed = [];
		const panelController = {
			findDuplicate: () => null,
			reveal: () => { throw new Error('must not reveal anything'); },
			onConnectionChanged: (identity, label) => changed.push({ identity, label })
		};
		const storage = fakeStorage({ Prod: { server: 'srv', port: 1433, username: 'sa' } });
		const handlers = new ConnectionHandlers(m => posts.push(m), fakeConnectionManager(), storage, panelController);

		const ok = await handlers.handleConnectWithSaved('Prod');

		assert.strictEqual(ok, true);
		assert.deepStrictEqual(changed, [{ identity: 'srv:1433:sa', label: 'Prod' }]);
		assert.strictEqual(posts.pop().success, true);
	});

	test('the connection status says whether the connection is marked as production', async () => {
		const posts = [];
		const storage = fakeStorage({ Prod: { server: 'srv', production: true }, Dev: { server: 'dev' } });
		const handlers = new ConnectionHandlers(m => posts.push(m), fakeConnectionManager(), storage);

		await handlers.handleConnectWithSaved('Prod');
		await handlers.handleConnectWithSaved('Dev');

		assert.deepStrictEqual(posts.map(p => p.production), [true, false]);
	});

	test('handleConnectWithSaved remembers the connection as the last one used', async () => {
		const storage = fakeStorage({ Prod: { server: 'srv', port: 1433, username: 'sa' } });
		const handlers = new ConnectionHandlers(() => {}, fakeConnectionManager(), storage);

		await handlers.handleConnectWithSaved('Prod');

		assert.deepStrictEqual(storage.lastUsed, ['Prod']);
	});

	test('a failed connection is reported, not remembered', async () => {
		const posts = [];
		const connectionManager = fakeConnectionManager();
		connectionManager.connectWithSaved = async () => { throw new Error('Login failed'); };
		const storage = fakeStorage({ Prod: { server: 'srv', port: 1433, username: 'sa' } });
		const handlers = new ConnectionHandlers(m => posts.push(m), connectionManager, storage);

		const ok = await handlers.handleConnectWithSaved('Prod');

		assert.strictEqual(ok, false);
		assert.deepStrictEqual(storage.lastUsed, []);
		const status = posts.pop();
		assert.strictEqual(status.success, false);
		assert.ok(status.message.includes('Login failed'));
	});
});
