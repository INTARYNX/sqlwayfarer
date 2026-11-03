const assert = require('assert');
const path = require('path');
const ConnectionStorage = require('../storage/ConnectionStorage');
const ConnectionImportHandlers = require('../panels/handlers/ConnectionImportHandlers');

const fixture = path.join(__dirname, 'fixtures', 'registered-servers.regsrvr');

function fakeContext() {
	const secrets = new Map();
	const state = new Map();
	return {
		secrets: { get: async k => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async k => { secrets.delete(k); } },
		globalState: { get: k => state.get(k), update: async (k, v) => { state.set(k, v); } },
		_secrets: secrets
	};
}

suite('ConnectionStorage.saveConnections', () => {
	test('several connections are written once, a nameless one is refused, no secret is touched', async () => {
		const context = fakeContext();
		let writes = 0;
		const store = context.secrets.store;
		context.secrets.store = async (k, v) => { writes++; return store(k, v); };
		const storage = new ConnectionStorage(context);
		await storage.initialize();
		const result = await storage.saveConnections([{ name: 'a', server: 'x' }, { name: 'b', server: 'y', password: 'ignored' }, { server: 'nameless' }]);
		assert.deepStrictEqual(result, { saved: ['a', 'b'], failed: [''] });
		assert.strictEqual(writes, 1);
		assert.deepStrictEqual([...context._secrets.keys()], ['sqlwayfarer.connections']);
	});

	test('a failing write leaves the connections as they were', async () => {
		const context = fakeContext();
		const storage = new ConnectionStorage(context);
		await storage.initialize();
		await storage.saveConnections([{ name: 'keep', server: 'x' }]);
		context.secrets.store = async () => { throw new Error('disk full'); };
		await assert.rejects(() => storage.saveConnections([{ name: 'new', server: 'y' }]), /disk full/);
		assert.deepStrictEqual(storage.getSavedConnections().map(c => c.name), ['keep']);
	});
});

suite('connection import into the real storage', () => {
	test('imported connections keep their group, hold no password, and survive a reload', async () => {
		const context = fakeContext();
		const storage = new ConnectionStorage(context);
		await storage.initialize();
		const handlers = new ConnectionImportHandlers(() => {}, storage, {
			ui: { pickSource: async () => 'file', pickFile: async () => fixture, pickEntries: async plan => plan, info() {}, error(m) { throw new Error(m); } }
		});
		await handlers.handleImportConnections();

		const reloaded = new ConnectionStorage(context);
		await reloaded.initialize();
		const all = Object.fromEntries(reloaded.getSavedConnections().map(c => [c.name, c]));
		assert.deepStrictEqual(Object.keys(all).sort(), ['Azure', 'ERP', 'Local dev', 'Paris', 'Sandbox']);
		assert.strictEqual(all.Paris.group, 'Production/Europe');
		assert.deepStrictEqual([all.ERP.server, all.ERP.port, all.ERP.authType, all.ERP.username, all.ERP.database], ['erp-sql\\PROD', '14330', 'sql', 'svc_read', 'Erp']);
		assert.deepStrictEqual([...context._secrets.keys()].filter(k => k.startsWith('sqlwayfarer.password.')), [], 'no password is stored');
	});

	test('importing again overwrites in place and keeps a password the user typed since', async () => {
		const context = fakeContext();
		const storage = new ConnectionStorage(context);
		await storage.initialize();
		const handlers = new ConnectionImportHandlers(() => {}, storage, {
			ui: { pickSource: async () => 'file', pickFile: async () => fixture, pickEntries: async plan => plan.filter(p => p.config.name === 'ERP'), info() {}, error(m) { throw new Error(m); } }
		});
		await handlers.handleImportConnections();
		await storage.saveConnection(Object.assign(storage.getConnection('ERP'), { password: 'typed-later' }), 'ERP');
		await handlers.handleImportConnections();
		assert.strictEqual(storage.getSavedConnections().length, 1);
		assert.strictEqual(await storage.getConnectionPassword('ERP'), 'typed-later');
	});
});
