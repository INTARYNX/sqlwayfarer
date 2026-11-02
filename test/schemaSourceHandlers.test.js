const assert = require('assert');
const SchemaSourceHandlers = require('../panels/handlers/SchemaSourceHandlers');
const ConnectionRouter = require('../database/ConnectionRouter');

const SAVED = [
	{ name: 'PROD', server: 'prod-sql', database: 'AppDb' },
	{ name: 'DEV', server: 'localhost', database: 'AppDb_Dev' }
];

function setup({ failFor = null } = {}) {
	const posted = [];
	const changes = [];
	const managers = [];
	const run = { isConnected: () => true, getServerName: () => 'prod-sql' };
	const router = new ConnectionRouter(run);
	const createManager = () => {
		const manager = {
			connected: false, disposed: false,
			connectWithSaved: async name => {
				if (name === failFor) throw new Error('login failed');
				manager.connected = true; manager.name = name;
			},
			isConnected: () => manager.connected,
			getServerName: () => SAVED.find(c => c.name === manager.name).server,
			dispose: async () => { manager.disposed = true; manager.connected = false; }
		};
		managers.push(manager);
		return manager;
	};
	const handlers = new SchemaSourceHandlers(m => posted.push(m), {
		router, createManager,
		connectionStorage: { getSavedConnections: () => SAVED },
		targetDatabaseService: { getDatabases: async () => ['AppDb', 'Other'] },
		getOwnName: () => 'PROD',
		onChanged: (name, restoring) => changes.push([name, !!restoring])
	});
	return { handlers, router, posted, changes, managers };
}

suite('SchemaSourceHandlers', () => {
	test('lists the saved connections, marking the tab\'s own', () => {
		const { handlers, posted } = setup();
		handlers.handleGetSchemaSources();
		assert.deepStrictEqual(posted[0], {
			command: 'schemaSources', ownName: 'PROD', activeName: null,
			sources: [{ name: 'PROD', server: 'prod-sql', database: 'AppDb', isOwn: true }, { name: 'DEV', server: 'localhost', database: 'AppDb_Dev', isOwn: false }]
		});
	});

	test('plugging the schema on another connection routes the schema services to it', async () => {
		const { handlers, router, posted, changes } = setup();
		assert.strictEqual(await handlers.handleSelectSchemaSource('DEV'), true);
		assert.strictEqual(router.isRouted(), true);
		assert.strictEqual(router.getServerName(), 'localhost');
		assert.deepStrictEqual(posted[0], {
			command: 'schemaSourceChanged', active: true, activeName: 'DEV',
			schema: { name: 'DEV', server: 'localhost' }, run: { name: 'PROD', server: 'prod-sql' }
		});
		assert.deepStrictEqual(changes, [['DEV', false]]);
	});

	test('a connection that fails leaves the schema where it was', async () => {
		const { handlers, router, posted, changes, managers } = setup({ failFor: 'DEV' });
		assert.strictEqual(await handlers.handleSelectSchemaSource('DEV'), false);
		assert.strictEqual(router.isRouted(), false);
		assert.strictEqual(posted[0].active, false);
		assert.ok(/Could not connect to 'DEV': login failed/.test(posted[0].error));
		assert.strictEqual(managers[0].disposed, true, 'the half-open manager is closed');
		assert.deepStrictEqual(changes, []);
	});

	test('choosing the tab\'s own connection, or none, goes back to the run connection and closes the source', async () => {
		const { handlers, router, posted, managers } = setup();
		await handlers.handleSelectSchemaSource('DEV');
		await handlers.handleSelectSchemaSource('PROD');
		assert.strictEqual(router.isRouted(), false);
		assert.strictEqual(managers[0].disposed, true);
		assert.strictEqual(posted[posted.length - 1].active, false);
		assert.strictEqual(handlers.activeName, null);
	});

	test('changing source closes the previous one', async () => {
		const { handlers, managers } = setup();
		await handlers.handleSelectSchemaSource('DEV');
		await handlers.handleSelectSchemaSource('DEV');
		assert.strictEqual(managers[0].disposed, true);
		assert.strictEqual(managers[1].disposed, false);
	});

	test('restoring after a reconnect connects the stored source without resetting the selection', async () => {
		const { handlers, router, changes } = setup();
		await handlers.restore('DEV');
		assert.strictEqual(router.isRouted(), true);
		assert.deepStrictEqual(changes, [['DEV', true]]);
		await handlers.restore('DEV');
		assert.strictEqual(changes.length, 1, 'already connected: nothing to redo');
		await handlers.restore('PROD');
		assert.strictEqual(changes.length, 1, 'the own connection is not a source');
	});

	test('the databases of the run connection are listed apart', async () => {
		const { handlers, posted } = setup();
		await handlers.handleGetQueryDatabases();
		assert.deepStrictEqual(posted[0], { command: 'queryDatabases', databases: ['AppDb', 'Other'] });
	});
});
