const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const ConnectionManager = require('../database/ConnectionManager');
const DatabaseService = require('../database/DatabaseService');
const IndexService = require('../database/IndexServices');
const RelatedTablesService = require('../database/RelatedTablesService');

// === Live: related tables, FK neighbors and usage neighbors mined from a real index ===
//
// Opt-in through SQLWAYFARER_TEST_SQL (see AGENTS.md). It creates its own
// scratch database and drops it at the end.

const LIVE_CONFIG = process.env.SQLWAYFARER_TEST_SQL;
const DB = 'SqlWayfarerLiveRelatedTables';

suite('live SQL Server: related tables (FK neighbors, usage neighbors)', function () {
	this.timeout(120000);
	let manager;
	let indexService;
	let related;
	let indexDir;

	suiteSetup(async function () {
		if (!LIVE_CONFIG) return this.skip();
		const live = JSON.parse(LIVE_CONFIG);
		manager = new ConnectionManager({
			getConnection: () => ({ name: 'live', server: live.server, authType: 'sql', username: live.user, database: 'master', encrypt: false, trustServerCertificate: true }),
			getConnectionPassword: async () => live.password
		});
		await manager.connectWithSaved('live');
		await manager.executeQuery(`IF DB_ID('${DB}') IS NOT NULL BEGIN ALTER DATABASE ${DB} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${DB}; END; CREATE DATABASE ${DB}`);
		const conn = await manager.acquireConnection();
		const run = async sql => { await conn.createRequest().batch(`USE ${DB}`); await conn.createRequest().batch(sql); };
		// Orders -> Customers is a real FK; Orders <-> Shipments has NO FK at
		// all (the legacy-database case) but every procedure that touches
		// Orders also touches Shipments - the usage signal has to find it
		// where the FK signal structurally cannot.
		await run('CREATE TABLE dbo.Customers (CustomerID int PRIMARY KEY, Name nvarchar(50))');
		await run('CREATE TABLE dbo.Orders (OrderID int PRIMARY KEY, CustomerID int NOT NULL REFERENCES dbo.Customers(CustomerID))');
		await run('CREATE TABLE dbo.Shipments (ShipmentID int PRIMARY KEY, OrderID int NOT NULL)');
		await run('CREATE TABLE dbo.Unrelated (X int PRIMARY KEY)');
		await run('CREATE PROCEDURE dbo.pCreateOrder AS BEGIN INSERT dbo.Orders (OrderID, CustomerID) VALUES (1, 1); INSERT dbo.Shipments (ShipmentID, OrderID) VALUES (1, 1); END');
		await run('CREATE PROCEDURE dbo.pShipOrder AS UPDATE dbo.Shipments SET ShipmentID = ShipmentID WHERE OrderID IN (SELECT OrderID FROM dbo.Orders)');
		await run('CREATE PROCEDURE dbo.pUnrelated AS SELECT * FROM dbo.Unrelated');
		conn.release();
		const databaseService = new DatabaseService(manager);
		indexService = new IndexService(manager, databaseService);
		indexDir = path.join(os.tmpdir(), `sqlwayfarer-live-related-${Date.now()}`);
		indexService._indexDir = indexDir;
		await indexService.forceReindex(DB);
		related = new RelatedTablesService(indexService, databaseService);
	});
	suiteTeardown(async () => {
		if (indexService) await indexService.dispose();
		if (indexDir) await fs.rm(indexDir, { recursive: true, force: true }).catch(() => {});
		if (!manager) return;
		try { await manager.executeQuery(`USE master; ALTER DATABASE ${DB} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${DB}`); } catch { /* ignore */ }
		await manager.dispose();
	});

	test('a real FK neighbor and a usage-only neighbor (no FK at all) are both found', async function () {
		if (!LIVE_CONFIG) return this.skip();
		const result = await related.relatedTables(DB, ['dbo.Orders']);
		const byName = Object.fromEntries(result.map(r => [r.qualifiedName.replace(/^dbo\./i, 'dbo.'), r]));

		assert.ok(byName['dbo.Customers'], 'Customers is found (real FK): ' + JSON.stringify(result));
		assert.strictEqual(byName['dbo.Customers'].via, 'fk');
		assert.strictEqual(byName['dbo.Customers'].direction, 'parent');

		assert.ok(byName['dbo.Shipments'], 'Shipments is found (usage only, no FK at all): ' + JSON.stringify(result));
		assert.strictEqual(byName['dbo.Shipments'].via, 'usage');
		assert.strictEqual(byName['dbo.Shipments'].procCount, 2);

		assert.ok(!byName['dbo.Unrelated'], 'a table no procedure touches alongside Orders is not suggested');
	});
});
