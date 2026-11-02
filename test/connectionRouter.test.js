const assert = require('assert');
const ConnectionRouter = require('../database/ConnectionRouter');

const fakeManager = (name, connected = true) => {
	const calls = [];
	return {
		name, calls,
		isConnected: () => connected,
		getServerName: () => `${name}-server`,
		executeQuery: async (query, params) => { calls.push(['executeQuery', query, params]); return { from: name }; },
		executeQueryInDatabase: async (database, query, params) => { calls.push(['executeQueryInDatabase', database, query, params]); return { from: name, database }; }
	};
};

suite('ConnectionRouter', () => {
	test('forwards to the run connection by default', async () => {
		const run = fakeManager('prod');
		const router = new ConnectionRouter(run);
		assert.strictEqual(router.isRouted(), false);
		assert.strictEqual(router.getServerName(), 'prod-server');
		assert.deepStrictEqual(await router.executeQueryInDatabase('AppDb', 'SELECT 1', { a: 1 }), { from: 'prod', database: 'AppDb' });
		assert.deepStrictEqual(run.calls[0], ['executeQueryInDatabase', 'AppDb', 'SELECT 1', { a: 1 }]);
	});

	test('forwards to the schema source once one is set, and back when it is cleared', async () => {
		const run = fakeManager('prod');
		const dev = fakeManager('dev');
		const router = new ConnectionRouter(run);
		router.use(dev);
		assert.strictEqual(router.isRouted(), true);
		assert.strictEqual(router.getServerName(), 'dev-server');
		assert.deepStrictEqual(await router.executeQuery('SELECT 2'), { from: 'dev' });
		assert.strictEqual(run.calls.length, 0, 'the run connection is not touched');
		router.use(null);
		assert.strictEqual(router.isRouted(), false);
		assert.strictEqual(router.getServerName(), 'prod-server');
	});

	test('isConnected follows the current connection', () => {
		const router = new ConnectionRouter(fakeManager('prod', true));
		assert.strictEqual(router.isConnected(), true);
		router.use(fakeManager('dev', false));
		assert.strictEqual(router.isConnected(), false);
	});

	test('the index of each source is kept apart: the cache is keyed by the current server', () => {
		const IndexService = require('../database/IndexServices');
		const router = new ConnectionRouter(fakeManager('prod'));
		const service = new IndexService(router, {});
		const prodPath = service._getIndexFilePath('AppDb');
		router.use(fakeManager('dev'));
		const devPath = service._getIndexFilePath('AppDb');
		assert.notStrictEqual(prodPath, devPath);
		assert.ok(prodPath.includes('prod-server') && devPath.includes('dev-server'));
	});
});
