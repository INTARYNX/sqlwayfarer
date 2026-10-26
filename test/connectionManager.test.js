const assert = require('assert');
const sql = require('mssql');
const ConnectionManager = require('../database/ConnectionManager');

function manager(storedPassword = null) {
	return new ConnectionManager({
		getConnectionPassword: async () => storedPassword,
		getConnection: () => null
	});
}

suite('ConnectionManager.buildConnectionConfig', () => {
	test('SQL login: user and password passed through', async () => {
		const config = await manager().buildConnectionConfig({
			server: 'srv', username: 'sa', password: 'pw'
		});
		assert.strictEqual(config.user, 'sa');
		assert.strictEqual(config.password, 'pw');
		assert.strictEqual(config.domain, undefined);
	});

	test('Windows login: DOMAIN\\user is split so tedious uses NTLM', async () => {
		const config = await manager().buildConnectionConfig({
			server: 'srv', username: 'CONTOSO\\nicolas', password: 'pw'
		});
		assert.strictEqual(config.domain, 'CONTOSO');
		assert.strictEqual(config.user, 'nicolas');
		assert.strictEqual(config.password, 'pw');
	});

	test('username without domain separator sets no domain', async () => {
		const config = await manager().buildConnectionConfig({
			server: 'srv', username: 'nicolas', password: 'pw'
		});
		assert.strictEqual(config.domain, undefined);
		assert.strictEqual(config.user, 'nicolas');
	});

	test('port is converted to a number', async () => {
		const config = await manager().buildConnectionConfig({
			server: 'srv', port: '1434'
		});
		assert.strictEqual(config.port, 1434);
	});

	test('requestTimeout overrides the 15s mssql default', async () => {
		const config = await manager().buildConnectionConfig({ server: 'srv' });
		assert.strictEqual(config.requestTimeout, 300000);
	});

	test('encrypt and trustServerCertificate land in options', async () => {
		const config = await manager().buildConnectionConfig({
			server: 'srv', encrypt: false, trustServerCertificate: true
		});
		assert.strictEqual(config.options.encrypt, false);
		assert.strictEqual(config.options.trustServerCertificate, true);
	});
});

suite('ConnectionManager.buildConnectionConfig (Entra ID)', () => {
	function entraManager(tokens) {
		let i = 0;
		const fetcher = async () => tokens[Math.min(i++, tokens.length - 1)];
		return new ConnectionManager({
			getConnectionPassword: async () => { throw new Error('no password lookup for Entra ID'); },
			getConnection: () => null
		}, fetcher);
	}

	test('uses an access token, no user and no password, and forces encryption', async () => {
		const config = await entraManager(['tok']).buildConnectionConfig({
			server: 'x.database.windows.net', authType: 'entra', encrypt: false, name: 'prod', isLoadedConnection: true
		});
		assert.strictEqual(config.authentication.type, 'azure-active-directory-access-token');
		assert.deepStrictEqual(config.authentication.options, { token: 'tok' });
		assert.strictEqual(config.user, undefined);
		assert.strictEqual(config.password, undefined);
		assert.strictEqual(config.options.encrypt, true);
	});

	test('the pool reads the renewed token each time it builds a connection config', async () => {
		const manager = entraManager(['tok1']);
		const config = await manager.buildConnectionConfig({ server: 'srv', authType: 'entra' });
		const source = manager._tokenSources.get(config);
		const pool = manager._createEntraPool(config, source);
		assert.strictEqual(pool._config().authentication.options.token, 'tok1');
		source._token = 'tok2';
		assert.strictEqual(pool._config().authentication.options.token, 'tok2');
		assert.strictEqual(pool._config().authentication.type, 'azure-active-directory-access-token');
	});

	test('the token of the live connection is renewed in the background until the connection is disposed', async () => {
		const cm = entraManager(['tok']);
		cm._openPool = async () => ({ close: async () => {} });
		await cm.connect({ server: 'srv', authType: 'entra' });
		const source = cm._activeTokenSource;
		assert.ok(source, 'an Entra ID connection keeps its token source');
		assert.ok(source._timer, 'the renewal timer runs');
		await cm.dispose();
		assert.strictEqual(source._timer, null);
	});

	test('without a token fetcher the connection is refused with a clear message', async () => {
		const m = new ConnectionManager({ getConnectionPassword: async () => null, getConnection: () => null });
		await assert.rejects(() => m.buildConnectionConfig({ server: 'srv', authType: 'entra' }), /Entra ID/);
	});

	test('a SQL login is not affected by the Entra ID path', async () => {
		const config = await manager().buildConnectionConfig({ server: 'srv', authType: 'sql', username: 'sa', password: 'pw' });
		assert.strictEqual(config.authentication, undefined);
		assert.strictEqual(config.user, 'sa');
	});
});

suite('ConnectionManager.connect', () => {
	let originalConnect;

	setup(() => {
		originalConnect = sql.connect;
	});

	teardown(() => {
		sql.connect = originalConnect;
	});

	test('a failed reconnect leaves the previous connection active instead of none at all', async () => {
		const cm = manager();
		const firstConnection = { close: async () => {} };
		sql.connect = async () => firstConnection;
		await cm.connect({ server: 'first-server', username: 'sa', password: 'pw' });
		assert.strictEqual(cm.getServerName(), 'first-server');

		sql.connect = async () => { throw new Error('ELOGIN: wrong password'); };
		await assert.rejects(() => cm.connect({ server: 'second-server', username: 'sa', password: 'bad' }));

		// The old connection must still be the active one - connect() closes it
		// only after the new one succeeds, never before attempting it.
		assert.strictEqual(cm.isConnected(), true);
		assert.strictEqual(cm.getServerName(), 'first-server');
	});

	test('reconnecting closes the previous connection only after the new one succeeds', async () => {
		const cm = manager();
		let closed = false;
		const firstConnection = { close: async () => { closed = true; } };
		sql.connect = async () => firstConnection;
		await cm.connect({ server: 'first-server' });

		let secondConnectStartedBeforeClose = null;
		sql.connect = async () => {
			secondConnectStartedBeforeClose = !closed;
			return { close: async () => {} };
		};
		await cm.connect({ server: 'second-server' });

		assert.strictEqual(secondConnectStartedBeforeClose, true, 'the new connect() must be attempted before the old one is closed');
		assert.strictEqual(closed, true, 'the old connection is still closed once the new one is up');
		assert.strictEqual(cm.getServerName(), 'second-server');
	});

	test('getServerName survives a disconnect, instead of falling back to "unknown"', async () => {
		const cm = manager();
		sql.connect = async () => ({ close: async () => {} });
		await cm.connect({ server: 'my-server' });

		await cm.dispose();

		assert.strictEqual(cm.isConnected(), false);
		assert.strictEqual(cm.getServerName(), 'my-server', 'the index cache key must stay stable through a reconnect gap');
	});
});

suite('ConnectionManager.acquireConnection', () => {
	// Pins one physical connection for a caller that runs several statements
	// in sequence (GO-separated batches, or SET SHOWPLAN_XML ON/plan/OFF) and
	// needs them all to land on the exact same session.
	test('pins one connection and releases the exact same one back to the pool', async () => {
		const cm = manager();
		const fakeConnection = { id: 'conn-1' };
		let released = null;
		cm._activeConnection = {
			config: { server: 'srv' },
			collation: 'SQL_Latin1_General_CP1_CI_AS',
			acquire: async () => fakeConnection,
			release: (c) => { released = c; }
		};

		const conn = await cm.acquireConnection();
		assert.strictEqual(typeof conn.createRequest, 'function');
		assert.strictEqual(typeof conn.release, 'function');

		conn.release();
		assert.strictEqual(released, fakeConnection, 'release() must hand back the exact connection acquire() returned');
	});

	test('createRequest() can be called multiple times, each sharing the same pinned connection', async () => {
		const cm = manager();
		const fakeConnection = { id: 'conn-1' };
		let acquireCalls = 0;
		cm._activeConnection = {
			config: {}, collation: null,
			acquire: async () => { acquireCalls++; return fakeConnection; },
			release: () => {}
		};

		const conn = await cm.acquireConnection();
		const req1 = conn.createRequest();
		const req2 = conn.createRequest();

		assert.strictEqual(acquireCalls, 1, 'only one physical connection should ever be acquired from the pool');
		assert.ok(req1 && req2 && req1 !== req2, 'each createRequest() call returns its own Request, sharing the one connection');
	});

	test('rejects when there is no active connection', async () => {
		const cm = manager();
		await assert.rejects(() => cm.acquireConnection(), /No active connection/);
	});
});
