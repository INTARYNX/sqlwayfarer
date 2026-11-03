const assert = require('assert');
const ConnectionManager = require('../database/ConnectionManager');
const { readRecentChanges, readDefinition } = require('../database/recentChanges');
const { createDatabase, dropDatabase, runScript } = require('./support/schemaFixture');

// === Live: the objects touched lately, from the dates of the server ===
//
// Opt-in through SQLWAYFARER_TEST_SQL (see AGENTS.md). Works in a scratch database.

const LIVE_CONFIG = process.env.SQLWAYFARER_TEST_SQL;
const DB = 'WayfarerRecentTest';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

suite('live SQL Server: what was modified lately', function () {
	this.timeout(60000);
	let manager;
	const names = result => result.items.map(i => `${i.kind}:${i.schema}.${i.name}`);

	suiteSetup(async function () {
		if (!LIVE_CONFIG) return this.skip();
		const live = JSON.parse(LIVE_CONFIG);
		manager = new ConnectionManager({
			getConnection: () => ({ name: 'live', server: live.server, authType: 'sql', username: live.user, database: 'master', encrypt: false, trustServerCertificate: true }),
			getConnectionPassword: async () => live.password
		});
		await manager.connectWithSaved('live');
		await createDatabase(manager, DB);
	});
	suiteTeardown(async () => {
		if (!manager) return;
		try { await dropDatabase(manager, DB); } catch { /* ignore */ }
		await manager.dispose();
	});

	test('a database just created has everything created in the period, tables with their constraints', async () => {
		const result = await readRecentChanges(manager, DB, 60);
		assert.ok(result.items.length > 10);
		assert.ok(result.items.every(i => i.createdInPeriod));
		// A view made once, never touched since, is new; the dates of a table go on moving as its indexes and constraints are added.
		assert.strictEqual(result.items.find(i => i.name === 'vCustomer').status, 'new');
		const kinds = new Set(result.items.map(i => i.kind));
		['table', 'view', 'procedure', 'function', 'trigger', 'constraint'].forEach(k => assert.ok(kinds.has(k), k));
		assert.ok(result.items.some(i => i.kind === 'constraint' && i.name === 'FK_Order_Customer' && i.parent === 'Sales.Order'));
		assert.ok(!result.items.some(i => /^sys|^queue/.test(i.name)), 'nothing of the system');
		assert.match(result.serverTime, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
	});

	test('the newest first, ages worked out by the server', async () => {
		const result = await readRecentChanges(manager, DB, 60);
		const ages = result.items.map(i => i.modifiedAge);
		assert.deepStrictEqual(ages, [...ages].sort((a, b) => a - b));
		assert.ok(ages.every(a => a >= 0 && a < 120), ages.slice(0, 5).join());
	});

	test('what is touched after a pause comes first, as altered; a change to a table, its indexes or its constraints counts', async () => {
		await sleep(2200);
		await runScript(manager, DB, `
			ALTER PROCEDURE Sales.usp_AddCustomer @name nvarchar(100) AS INSERT Sales.Customer (name, code, note) VALUES (@name, 'y', N'');
			GO
			CREATE INDEX IX_Order_total ON Sales.[Order] (total);
			GO
			ALTER TABLE dbo.Log ADD extra int NULL;
			GO
			CREATE VIEW dbo.vBrandNew AS SELECT 1 AS n;
		`);
		const result = await readRecentChanges(manager, DB, 60);
		const top = result.items.slice(0, 4).map(i => `${i.kind}:${i.schema}.${i.name}:${i.status}`).sort();
		assert.deepStrictEqual(top, ['procedure:Sales.usp_AddCustomer:altered', 'table:Sales.Order:altered', 'table:dbo.Log:altered', 'view:dbo.vBrandNew:new']);
		assert.ok(result.items.slice(0, 4).every(i => i.createdInPeriod));
		const sooner = await readRecentChanges(manager, DB, 1);
		assert.ok(sooner.items.length >= 4);
	});

	test('a period of one minute holds what was made a few seconds ago', async () => {
		const result = await readRecentChanges(manager, DB, 1);
		assert.ok(names(result).includes('view:dbo.vBrandNew'));
	});

	test('the definition of a module is read, and nothing for a table or what is not there', async () => {
		assert.ok((await readDefinition(manager, DB, 'Sales', 'vCustomer')).startsWith('CREATE VIEW Sales.vCustomer'));
		assert.ok((await readDefinition(manager, DB, 'dbo', 'fnDouble')).includes('RETURN @n * 2'));
		assert.ok((await readDefinition(manager, DB, 'Sales', 'trg_Order')).includes('TRIGGER'));
		assert.strictEqual(await readDefinition(manager, DB, 'Sales', 'Customer'), null);
		assert.strictEqual(await readDefinition(manager, DB, 'dbo', "no]such'thing"), null);
	});

	test('the connection of the pool is not left in the database', async () => {
		await readRecentChanges(manager, DB, 60);
		const inside = (await manager.executeQuery('SELECT COUNT(*) AS n FROM sys.dm_exec_sessions WHERE database_id = DB_ID(@name)', { name: DB })).recordset[0].n;
		assert.strictEqual(inside, 0);
	});
});
