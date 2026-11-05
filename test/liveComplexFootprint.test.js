const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const ConnectionManager = require('../database/ConnectionManager');
const DatabaseService = require('../database/DatabaseService');
const IndexService = require('../database/IndexServices');
const WriteFootprintService = require('../database/WriteFootprintService');

// === Live: the write footprint on a schema made to be hard ===
//
// Opt-in through SQLWAYFARER_TEST_SQL (see AGENTS.md). It creates its own
// scratch database and drops it at the end. The truth is known by
// construction: every procedure below writes the tables listed with it, no
// more and no less - triggers that fire on the kind of write included.
//

const LIVE_CONFIG = process.env.SQLWAYFARER_TEST_SQL;
const DB = 'SqlWayfarerLiveHard';

const SETUP = [
	'CREATE SCHEMA sales',
	'CREATE SCHEMA hr',
	'CREATE TABLE dbo.Orders (id int IDENTITY PRIMARY KEY, customerId int, total money)',
	'CREATE TABLE dbo.OrderLines (id int IDENTITY PRIMARY KEY, orderId int, qty int)',
	'CREATE TABLE dbo.Inventory (sku int PRIMARY KEY, qty int)',
	'CREATE TABLE dbo.Audit (id int IDENTITY PRIMARY KEY, what nvarchar(50))',
	'CREATE TABLE dbo.Audit2 (id int, what nvarchar(50))',
	'CREATE TABLE dbo.[Log] (id int IDENTITY PRIMARY KEY, what nvarchar(50))',
	'CREATE TABLE dbo.Archive (id int, note nvarchar(50))',
	'CREATE TABLE dbo.Customers (id int PRIMARY KEY, name nvarchar(50))',
	'CREATE TABLE sales.Orders (id int PRIMARY KEY, note nvarchar(50))',
	'CREATE TABLE hr.Employees (id int PRIMARY KEY, name nvarchar(50))',
	'CREATE TABLE dbo.[Order Lines Archive] (id int, note nvarchar(50))',
	'CREATE TABLE dbo.Muted (id int)',
	'CREATE TABLE dbo.MutedLog (id int)',
	'CREATE TABLE dbo.Counter (n int)',
	'CREATE SYNONYM dbo.synOrders FOR dbo.Orders',
	// Triggers: a cascade of two levels, and one per kind of write.
	"CREATE TRIGGER dbo.trgOrdersIns ON dbo.Orders AFTER INSERT AS INSERT dbo.Audit (what) SELECT 'ins' FROM inserted",
	'CREATE TRIGGER dbo.trgAuditIns ON dbo.Audit AFTER INSERT AS INSERT dbo.[Log] (what) SELECT what FROM inserted',
	'CREATE TRIGGER dbo.trgOrdersDel ON dbo.Orders AFTER DELETE AS INSERT dbo.Archive (id, note) SELECT id, N\'del\' FROM deleted',
	"CREATE TRIGGER dbo.trgCustomersIns ON dbo.Customers AFTER INSERT AS INSERT dbo.Audit (what) SELECT 'c' FROM inserted",
	// A trigger that is disabled fires nothing; a trigger that calls a procedure; a trigger that writes its own table.
	'CREATE TRIGGER dbo.trgMuted ON dbo.Muted AFTER INSERT AS INSERT dbo.MutedLog SELECT id FROM inserted',
	'DISABLE TRIGGER dbo.trgMuted ON dbo.Muted',
	'CREATE PROCEDURE dbo.uspAuditInventory AS INSERT dbo.Audit (what) VALUES (N\'inv\')',
	'CREATE TRIGGER dbo.trgInventoryUpd ON dbo.Inventory AFTER UPDATE AS EXEC dbo.uspAuditInventory',
	'CREATE TRIGGER dbo.trgCounterUpd ON dbo.Counter AFTER UPDATE AS IF (SELECT COUNT(*) FROM inserted) > 100 UPDATE dbo.Counter SET n = 0',
	// A view with an INSTEAD OF trigger: the real write is the one of the trigger.
	'CREATE VIEW dbo.vCustomers AS SELECT id, name FROM dbo.Customers',
	'CREATE TRIGGER dbo.trgVCustomersIns ON dbo.vCustomers INSTEAD OF INSERT AS INSERT dbo.Archive (id, note) SELECT id, name FROM inserted',
	'CREATE VIEW dbo.vOrders AS SELECT id, customerId, total FROM dbo.Orders',
	'CREATE FUNCTION dbo.fnOrders(@c int) RETURNS TABLE AS RETURN SELECT id, total FROM dbo.Orders WHERE customerId = @c',
	// Procedures.
	'CREATE PROCEDURE dbo.uspPlaceOrder AS BEGIN INSERT dbo.Orders (customerId, total) VALUES (1, 10); UPDATE dbo.Inventory SET qty = qty - 1 WHERE sku = 1; END',
	'CREATE PROCEDURE dbo.uspCancel AS DELETE FROM dbo.Orders WHERE id = 1',
	'CREATE PROCEDURE dbo.uspNested AS EXEC dbo.uspPlaceOrder',
	"CREATE PROCEDURE dbo.uspDynamicLiteral AS EXEC('INSERT dbo.Customers (id, name) VALUES (1, ''x'')')",
	'CREATE PROCEDURE dbo.uspDynamicVar @t sysname AS BEGIN DECLARE @s nvarchar(200) = N\'DELETE FROM dbo.\' + @t; EXEC sp_executesql @s; END',
	'CREATE PROCEDURE dbo.uspThroughView AS INSERT dbo.vOrders (customerId, total) VALUES (2, 20)',
	'CREATE PROCEDURE sales.uspSameName AS UPDATE Orders SET note = N\'x\' WHERE id = 1',
	'CREATE PROCEDURE dbo.uspMerge AS MERGE dbo.Inventory AS t USING dbo.OrderLines AS s ON t.sku = s.orderId WHEN MATCHED THEN DELETE WHEN NOT MATCHED THEN INSERT (sku, qty) VALUES (s.orderId, s.qty);',
	'CREATE PROCEDURE dbo.uspTemp AS BEGIN SELECT id INTO #t FROM dbo.Orders; DELETE c FROM dbo.Customers c JOIN #t ON #t.id = c.id; END',
	'CREATE PROCEDURE dbo.uspCte AS BEGIN WITH c AS (SELECT * FROM dbo.OrderLines WHERE qty > 1) UPDATE c SET qty = 0; END',
	'CREATE PROCEDURE dbo.uspCursor AS BEGIN DECLARE k CURSOR FOR SELECT id FROM dbo.Orders; OPEN k; EXEC dbo.uspPlaceOrder; CLOSE k; DEALLOCATE k; END',
	"CREATE PROCEDURE dbo.uspOutput AS INSERT dbo.Archive (id, note) OUTPUT inserted.id, 'o' INTO dbo.Audit2 (id, what) SELECT 1, 'a'",
	'CREATE PROCEDURE dbo.uspTruncate AS TRUNCATE TABLE dbo.[Log]',
	'CREATE PROCEDURE dbo.uspIf @x int AS BEGIN IF @x = 1 DELETE FROM dbo.Orders ELSE INSERT dbo.Archive (id, note) VALUES (1, N\'a\'); END',
	'CREATE PROCEDURE dbo.uspTvf AS SELECT * FROM dbo.fnOrders(1)',
	'CREATE PROCEDURE dbo.uspUpdateCustomers AS UPDATE dbo.Customers SET name = N\'y\' WHERE id = 1',
	'CREATE PROCEDURE dbo.uspRecurse @n int AS BEGIN INSERT dbo.[Log] (what) VALUES (N\'r\'); IF @n > 0 BEGIN DECLARE @m int = @n - 1; EXEC dbo.uspRecurse @m; END END',
	'CREATE PROCEDURE dbo.uspSynonym AS INSERT dbo.synOrders (customerId, total) VALUES (3, 30)',
	'CREATE PROCEDURE dbo.uspMutedTrigger AS INSERT dbo.Muted (id) VALUES (1)',
	'CREATE PROCEDURE dbo.uspAliasJoin AS UPDATE o SET total = 0 FROM dbo.Orders o JOIN dbo.Customers c ON c.id = o.customerId WHERE c.name = N\'x\'',
	'CREATE PROCEDURE dbo.uspInsertExec AS INSERT dbo.Archive (id, note) EXEC dbo.uspCancel',
	'CREATE PROCEDURE dbo.uspTriggerCallsProc AS UPDATE dbo.Inventory SET qty = 0',
	'CREATE PROCEDURE dbo.uspSelfTrigger AS UPDATE dbo.Counter SET n = n + 1',
	'CREATE PROCEDURE dbo.uspSelectInto AS SELECT * INTO dbo.Snapshot FROM dbo.Orders',
	'CREATE PROCEDURE dbo.uspUpperCase AS UPDATE DBO.ORDERS SET TOTAL = 1',
	'CREATE PROCEDURE dbo.uspBrackets AS DELETE FROM [dbo].[Order Lines Archive]',
	'CREATE PROCEDURE dbo.uspInsteadOf AS INSERT dbo.vCustomers (id, name) VALUES (9, N\'i\')',
	'CREATE PROCEDURE hr.uspTryCatch AS BEGIN SET NOCOUNT ON; BEGIN TRY UPDATE hr.Employees SET name = N\'z\'; END TRY BEGIN CATCH INSERT dbo.[Log] (what) VALUES (ERROR_MESSAGE()); END CATCH END'
];

suite('live SQL Server: write footprint on a hard schema', function () {
	this.timeout(180000);
	let manager;
	let indexService;
	let footprint;
	let indexDir;

	suiteSetup(async function () {
		if (!LIVE_CONFIG) return this.skip();
		const live = JSON.parse(LIVE_CONFIG);
		manager = new ConnectionManager({
			getConnection: () => ({ name: 'live', server: live.server, authType: 'sql', username: live.user, database: 'master', encrypt: false, trustServerCertificate: true }),
			getConnectionPassword: async () => live.password
		});
		await manager.connectWithSaved('live');
		await manager.executeQueryInDatabase('master', `IF DB_ID('${DB}') IS NOT NULL BEGIN ALTER DATABASE ${DB} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${DB}; END; CREATE DATABASE ${DB}`);
		const conn = await manager.acquireConnection();
		for (const statement of SETUP) {
			await conn.createRequest().batch(`USE ${DB}`);
			await conn.createRequest().batch(statement);
		}
		conn.release();
		const databaseService = new DatabaseService(manager);
		indexService = new IndexService(manager, databaseService);
		indexDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlwayfarer-live-hard-'));
		indexService._indexDir = indexDir;
		await indexService.forceReindex(DB);
		footprint = new WriteFootprintService(manager, indexService, databaseService);
	});
	suiteTeardown(async () => {
		if (indexService) await indexService.dispose();
		if (indexDir) await fs.rm(indexDir, { recursive: true, force: true }).catch(() => {});
		if (!manager) return;
		try { await manager.executeQueryInDatabase('master', `ALTER DATABASE ${DB} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${DB}`); } catch { /* ignore */ }
		await manager.dispose();
	});

	const written = async name => (await footprint.analyze(DB, name)).tables.filter(t => t.access === 'write').map(t => t.qualifiedName).sort();
	const read = async name => (await footprint.analyze(DB, name)).tables.filter(t => t.access === 'read').map(t => t.qualifiedName).sort();

	// procedure -> the tables it writes (triggers that fire included).
	const WRITES = {
		'dbo.uspPlaceOrder': ['dbo.Audit', 'dbo.Inventory', 'dbo.Log', 'dbo.Orders'],
		'dbo.uspNested': ['dbo.Audit', 'dbo.Inventory', 'dbo.Log', 'dbo.Orders'],
		'dbo.uspCursor': ['dbo.Audit', 'dbo.Inventory', 'dbo.Log', 'dbo.Orders'],
		'dbo.uspCancel': ['dbo.Archive', 'dbo.Orders'],
		'dbo.uspIf': ['dbo.Archive', 'dbo.Orders'],
		'dbo.uspUpdateCustomers': ['dbo.Customers'],
		'dbo.uspTemp': ['dbo.Customers'],
		'dbo.uspMerge': ['dbo.Inventory'],
		'dbo.uspCte': ['dbo.OrderLines'],
		'dbo.uspOutput': ['dbo.Archive', 'dbo.Audit2'],
		'dbo.uspRecurse': ['dbo.Log'],
		'sales.uspSameName': ['sales.Orders'],
		'hr.uspTryCatch': ['dbo.Log', 'hr.Employees'],
		'dbo.uspSynonym': ['dbo.Audit', 'dbo.Log', 'dbo.Orders'],
		'dbo.uspMutedTrigger': ['dbo.Muted'],
		'dbo.uspAliasJoin': ['dbo.Orders'],
		'dbo.uspInsertExec': ['dbo.Archive', 'dbo.Orders'],
		'dbo.uspTriggerCallsProc': ['dbo.Audit', 'dbo.Inventory', 'dbo.Log'],
		'dbo.uspSelfTrigger': ['dbo.Counter'],
		'dbo.uspUpperCase': ['dbo.Orders'],
		'dbo.uspBrackets': ['dbo.Order Lines Archive'],
		'dbo.uspInsteadOf': ['dbo.Archive'],
		'dbo.uspDynamicVar': [],
		'dbo.uspTvf': []
	};
	for (const [name, tables] of Object.entries(WRITES)) {
		test(`${name} writes ${tables.length ? tables.join(', ') : 'nothing'}`, async () => {
			assert.deepStrictEqual(await written(name), tables);
		});
	}

	test('a temporary table is not a table of the database, a table only read stays read', async () => {
		assert.deepStrictEqual(await read('dbo.uspTemp'), ['dbo.Orders']);
		assert.deepStrictEqual(await read('dbo.uspMerge'), ['dbo.OrderLines']);
		assert.deepStrictEqual(await read('dbo.uspTvf'), ['dbo.Orders']);
	});

	test('a table with the same name in two schemas is the one of the schema of the procedure', async () => {
		assert.ok(!(await written('sales.uspSameName')).includes('dbo.Orders'));
	});

	test('a procedure that calls itself ends', async () => {
		const result = await footprint.analyze(DB, 'dbo.uspRecurse');
		assert.strictEqual(result.truncated, false);
	});

	test('TRUNCATE TABLE is a write, and fires no trigger', async () => {
		assert.deepStrictEqual(await written('dbo.uspTruncate'), ['dbo.Log']);
	});

	test('a write through a view is a write of the table behind it, triggers included', async () => {
		assert.deepStrictEqual(await written('dbo.uspThroughView'), ['dbo.Audit', 'dbo.Log', 'dbo.Orders']);
		assert.deepStrictEqual((await footprint.analyze(DB, 'dbo.uspThroughView')).unresolved, []);
	});

	test('a statement written as a literal in EXEC(...) is followed, triggers included', async () => {
		assert.deepStrictEqual(await written('dbo.uspDynamicLiteral'), ['dbo.Audit', 'dbo.Customers', 'dbo.Log']);
	});
});
