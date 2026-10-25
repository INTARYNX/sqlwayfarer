const assert = require('assert');
const ConnectionHandlers = require('../panels/handlers/ConnectionHandlers');

function fakeConnectionManager() {
	return {
		connect: async () => {},
		connectWithSaved: async () => {}
	};
}

function fakeStorage(savedConnections = {}) {
	return {
		getConnection: name => savedConnections[name] || null,
		setLastConnectionName: async () => {}
	};
}

suite('ConnectionHandlers - no two tabs on the same connection', () => {
	test('handleConnect refuses and reveals the other tab when another panel already has this server+login', async () => {
		const posts = [];
		const revealed = [];
		const other = { label: 'other-panel' };
		const panelController = {
			findDuplicate: () => other,
			reveal: panel => revealed.push(panel),
			onConnectionChanged: () => { throw new Error('must not connect when a duplicate is found'); }
		};
		const connectionManager = fakeConnectionManager();
		connectionManager.connect = async () => { throw new Error('must not actually connect'); };
		const handlers = new ConnectionHandlers(m => posts.push(m), connectionManager, fakeStorage(), panelController);

		const ok = await handlers.handleConnect({ server: 'srv', port: 1433, username: 'sa', password: 'pw' });

		assert.strictEqual(ok, false);
		assert.deepStrictEqual(revealed, [other]);
		assert.strictEqual(posts.pop().success, false);
	});

	test('handleConnect proceeds and records the identity when no other tab has it', async () => {
		const posts = [];
		const changed = [];
		const panelController = {
			findDuplicate: () => null,
			reveal: () => { throw new Error('must not reveal anything'); },
			onConnectionChanged: (identity, label) => changed.push({ identity, label })
		};
		const handlers = new ConnectionHandlers(m => posts.push(m), fakeConnectionManager(), fakeStorage(), panelController);

		const ok = await handlers.handleConnect({ server: 'srv', port: 1433, username: 'sa', password: 'pw' });

		assert.strictEqual(ok, true);
		assert.strictEqual(changed.length, 1);
		assert.strictEqual(changed[0].identity, 'srv:1433:sa');
		assert.strictEqual(posts.pop().success, true);
	});

	// handleConnect's ad-hoc connectionConfig has no .name unless the user
	// saved it first (only saveConnection/testConnection set that field) -
	// the tab title falls back to the server address instead.
	test('handleConnect labels the tab by server address when the connection was never saved', async () => {
		const changed = [];
		const panelController = {
			findDuplicate: () => null,
			reveal: () => {},
			onConnectionChanged: (identity, label) => changed.push(label)
		};
		const handlers = new ConnectionHandlers(() => {}, fakeConnectionManager(), fakeStorage(), panelController);

		await handlers.handleConnect({ server: 'myserver', port: 1433, username: 'sa', password: 'pw' });

		assert.strictEqual(changed[0], 'myserver');
	});

	test('handleConnectWithSaved resolves identity from the saved connection and refuses a duplicate the same way', async () => {
		const posts = [];
		const revealed = [];
		const other = { label: 'other-panel' };
		const panelController = {
			findDuplicate: () => other,
			reveal: panel => revealed.push(panel),
			onConnectionChanged: () => { throw new Error('must not connect when a duplicate is found'); }
		};
		const storage = fakeStorage({ Prod: { server: 'srv', port: 1433, username: 'sa' } });
		const handlers = new ConnectionHandlers(m => posts.push(m), fakeConnectionManager(), storage, panelController);

		const ok = await handlers.handleConnectWithSaved('Prod');

		assert.strictEqual(ok, false);
		assert.deepStrictEqual(revealed, [other]);
	});

	test('handleConnectWithSaved labels the tab with the saved connection name', async () => {
		const changed = [];
		const panelController = {
			findDuplicate: () => null,
			reveal: () => {},
			onConnectionChanged: (identity, label) => changed.push(label)
		};
		const storage = fakeStorage({ Prod: { server: 'srv', port: 1433, username: 'sa' } });
		const handlers = new ConnectionHandlers(() => {}, fakeConnectionManager(), storage, panelController);

		await handlers.handleConnectWithSaved('Prod');

		assert.strictEqual(changed[0], 'Prod');
	});
});

// A second tab on the same server+login is not allowed (it would make the
// per-connection query history ambiguous). Auto-connect must therefore not
// even be attempted in that case: the attempt was refused, and the refusal
// used to leave the new tab empty and unusable.
suite('ConnectionHandlers - auto-connect in a new tab', () => {
	function storageWith(connections, lastConnection) {
		return {
			getSavedConnections: () => connections.map(c => ({ name: c.name, ...c })),
			getLastConnectionName: () => lastConnection,
			getAutoConnectEnabled: () => true,
			getConnection: name => connections.find(c => c.name === name) || null
		};
	}

	test('skips the auto-connect and names the busy connection', async () => {
		const posts = [];
		const notified = [];
		const other = { label: 'other-panel' };
		const panelController = {
			findDuplicate: identity => (identity === 'srv:1433:sa' ? other : null),
			reveal: () => {},
			onConnectionChanged: () => {},
			notify: message => notified.push(message)
		};
		const storage = storageWith([{ name: 'Prod', server: 'srv', port: 1433, username: 'sa' }], 'Prod');
		const handlers = new ConnectionHandlers(m => posts.push(m), fakeConnectionManager(), storage, panelController);

		await handlers.handleLoadConnections();

		const message = posts.pop();
		assert.strictEqual(message.command, 'savedConnectionsLoaded');
		assert.strictEqual(message.autoConnect, false, 'must not auto-connect to a connection another tab already has');
		assert.strictEqual(message.busyConnection, 'Prod');
		assert.ok(notified.length === 1 && notified[0].includes('Prod'), 'the user must be told which connection is busy');
		assert.ok(notified[0].includes('one tab at a time'), 'the rule must be stated');
	});

	test('auto-connects normally when no other tab has the connection', async () => {
		const posts = [];
		const panelController = {
			findDuplicate: () => null,
			reveal: () => {},
			onConnectionChanged: () => {},
			notify: () => { throw new Error('must not notify'); }
		};
		const storage = storageWith([{ name: 'Prod', server: 'srv', port: 1433, username: 'sa' }], 'Prod');
		const handlers = new ConnectionHandlers(m => posts.push(m), fakeConnectionManager(), storage, panelController);

		await handlers.handleLoadConnections();

		const message = posts.pop();
		assert.strictEqual(message.autoConnect, true);
		assert.strictEqual(message.busyConnection, null);
	});
});
