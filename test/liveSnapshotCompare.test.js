const assert = require('assert');
const ConnectionManager = require('../database/ConnectionManager');
const { readSchemaModel } = require('../database/schemaCatalog');
const { diffModels } = require('../database/schemaDiff');
const { getSnapshotSupport, listSnapshots, planSnapshot, createSnapshot, dropSnapshot } = require('../database/dbSnapshots');
const { createDatabase, dropDatabase, runScript } = require('./support/schemaFixture');

// === Live: a snapshot as the reference of a comparison ===
//
// Opt-in through SQLWAYFARER_TEST_SQL (see AGENTS.md). Works in a scratch
// database and its snapshot, both dropped at the end.

const LIVE_CONFIG = process.env.SQLWAYFARER_TEST_SQL;
const DB = 'WayfarerCompareTest';

suite('live SQL Server: snapshots and the comparison', function () {
	this.timeout(120000);
	let manager;
	let snapshot;

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

	test('a user database can have a snapshot, a system one and a missing one cannot', async () => {
		assert.deepStrictEqual(await getSnapshotSupport(manager, DB), { supported: true });
		assert.strictEqual((await getSnapshotSupport(manager, 'master')).supported, false);
		assert.strictEqual((await getSnapshotSupport(manager, 'NoSuchDatabase')).supported, false);
		await assert.rejects(planSnapshot(manager, 'master'), /system database/);
	});

	test('the snapshot is planned, then taken, and listed with its source', async () => {
		const plan = await planSnapshot(manager, DB);
		assert.ok(plan.sql.includes(`AS SNAPSHOT OF [${DB}]`));
		assert.deepStrictEqual(await listSnapshots(manager, DB), []);
		snapshot = await createSnapshot(manager, plan);
		const list = await listSnapshots(manager, DB);
		assert.deepStrictEqual(list.map(s => [s.name, s.source, s.state]), [[snapshot, DB, 'ONLINE']]);
		assert.deepStrictEqual(await listSnapshots(manager, 'Other'), []);
		assert.strictEqual((await getSnapshotSupport(manager, snapshot)).supported, false);
	});

	test('right after, the database and its snapshot are identical', async () => {
		const diff = diffModels(await readSchemaModel(manager, snapshot), await readSchemaModel(manager, DB));
		assert.deepStrictEqual(diff.changes, []);
		assert.strictEqual(diff.identical, true);
	});

	test('what changes in the database after the snapshot is what the comparison says', async () => {
		await runScript(manager, DB, `
			ALTER TABLE Sales.Customer ADD phone varchar(30) NULL;
			ALTER TABLE Sales.Customer ADD tier int NOT NULL CONSTRAINT DF_Customer_tier DEFAULT 1;
			DROP INDEX UX_Customer_email ON Sales.Customer;
			ALTER TABLE Sales.Customer DROP COLUMN email;
			GO
			ALTER TABLE Sales.[Order] ALTER COLUMN total decimal(19,4) NOT NULL;
			ALTER TABLE Sales.Customer ALTER COLUMN note nvarchar(max) COLLATE Latin1_General_CS_AS NOT NULL;
			CREATE INDEX IX_Customer_tier ON Sales.Customer (tier);
			DROP INDEX IX_Customer_name ON Sales.Customer;
			ALTER TABLE Sales.[Order] ADD CONSTRAINT CK_Order_total CHECK (total >= 0);
			CREATE TABLE Sales.Invoice (id int NOT NULL PRIMARY KEY, orderId int NOT NULL);
			DROP TABLE dbo.Log;
			GO
			ALTER PROCEDURE Sales.usp_AddCustomer @name nvarchar(100)
			AS
				INSERT Sales.Customer (name, code) VALUES (@name, 'y');
			GO
			CREATE VIEW Sales.vInvoice AS SELECT id FROM Sales.Invoice;
			GO
			DROP FUNCTION dbo.fnDouble;
		`);

		const diff = diffModels(await readSchemaModel(manager, snapshot), await readSchemaModel(manager, DB));
		const names = diff.changes.map(c => `${c.kind}:${c.name}:${c.status}`);
		assert.deepStrictEqual(names, [
			'table:dbo.Log:removed', 'table:Sales.Customer:modified', 'table:Sales.Invoice:added', 'table:Sales.Order:modified',
			'view:Sales.vInvoice:added', 'function:dbo.fnDouble:removed', 'procedure:Sales.usp_AddCustomer:modified'
		]);

		const ops = name => diff.changes.find(c => c.name === name).ops.map(o => `${o.op}:${o.risk}${o.column && o.column.name ? ':' + o.column.name : o.name ? ':' + o.name : ''}`);
		assert.deepStrictEqual(ops('Sales.Customer'), [
			'dropColumn:destructive:email', 'addColumn:safe:phone', 'addColumn:safe:tier',
			'alterColumn:caution:note', 'dropIndex:safe', 'dropIndex:safe', 'addIndex:safe'
		]);
		const customer = diff.changes.find(c => c.name === 'Sales.Customer');
		assert.deepStrictEqual(customer.ops.filter(o => o.op === 'dropIndex').map(o => o.index.name), ['IX_Customer_name', 'UX_Customer_email']);
		assert.deepStrictEqual(ops('Sales.Order'), ['alterColumn:caution:total', 'addCheck:caution']);
		assert.deepStrictEqual(diff.changes.find(c => c.name === 'Sales.usp_AddCustomer').ops[0].what, ['definition']);
		assert.ok(diff.summary.risks.destructive >= 2);
	});

	test('the snapshot did not move: it still reads as it was', async () => {
		const model = await readSchemaModel(manager, snapshot);
		assert.ok(model.tables['Sales.Customer'].columns.some(c => c.name === 'email'));
		assert.ok(model.tables['dbo.Log']);
		assert.ok(model.modules['dbo.fnDouble']);
	});

	test('the snapshot is dropped, a database that is not one is refused', async () => {
		await assert.rejects(dropSnapshot(manager, DB), /not a database snapshot/);
		await dropSnapshot(manager, snapshot);
		assert.deepStrictEqual(await listSnapshots(manager, DB), []);
		const exists = (await manager.executeQueryInDatabase('master', 'SELECT DB_ID(@name) AS id', { name: DB })).recordset[0].id;
		assert.ok(exists, 'the source database is untouched');
	});
});
