const assert = require('assert');
const ConnectionManager = require('../database/ConnectionManager');
const { readSchemaModel } = require('../database/schemaCatalog');
const { diffModels } = require('../database/schemaDiff');
const { buildMigrationScript } = require('../database/migrationScript');
const { planSnapshot, createSnapshot, dropSnapshot } = require('../database/dbSnapshots');
const { splitBatches } = require('../database/sqlBatches');
const { createDatabase, dropDatabase, runScript, bracket } = require('./support/schemaFixture');

// === Live: the script of a comparison, applied to a real server ===
//
// Opt-in through SQLWAYFARER_TEST_SQL (see AGENTS.md). The whole point of the
// script is that it can be run again whatever state a database is in, so this is
// what is checked: a snapshot is taken, the database is changed in many ways,
// and the script is applied to other databases that are in the state of the
// snapshot, to the database itself, to one half done, and twice.

const LIVE_CONFIG = process.env.SQLWAYFARER_TEST_SQL;
const SRC = 'WayfarerMigSource';
const TARGETS = ['WayfarerMigT1', 'WayfarerMigT2', 'WayfarerMigT3'];

const CHANGES = `
	CREATE SCHEMA Billing;
	GO
	CREATE TABLE Billing.Payment (id int NOT NULL PRIMARY KEY, amount decimal(10,2) NOT NULL CONSTRAINT DF_Payment_amount DEFAULT 0);
	GO
	ALTER TABLE Sales.Customer ADD phone varchar(30) NULL;
	ALTER TABLE Sales.Customer ADD tier int NOT NULL CONSTRAINT DF_Customer_tier DEFAULT 1;
	ALTER TABLE Sales.Customer ADD CONSTRAINT DF_Customer_phone DEFAULT ('n/a') FOR phone;
	DROP INDEX UX_Customer_email ON Sales.Customer;
	ALTER TABLE Sales.Customer DROP COLUMN email;
	GO
	ALTER TABLE Sales.Customer ALTER COLUMN note nvarchar(max) COLLATE Latin1_General_CS_AS NOT NULL;
	ALTER TABLE Sales.Customer ADD CONSTRAINT CK_Customer_tier CHECK (tier > 0);
	CREATE INDEX IX_Customer_tier ON Sales.Customer (tier);
	DROP INDEX IX_Customer_name ON Sales.Customer;
	ALTER TABLE Sales.Customer DROP CONSTRAINT UQ_Customer_code;
	ALTER TABLE Sales.Customer ADD CONSTRAINT UQ_Customer_code UNIQUE (code, name);
	GO
	ALTER TABLE Sales.[Order] ALTER COLUMN total decimal(19,4) NOT NULL;
	ALTER TABLE Sales.[Order] ADD CONSTRAINT CK_Order_total CHECK (total >= 0);
	ALTER TABLE Sales.[Order] DROP CONSTRAINT FK_Order_Customer;
	ALTER TABLE Sales.[Order] ADD CONSTRAINT FK_Order_Customer FOREIGN KEY (customerId) REFERENCES Sales.Customer (id);
	GO
	CREATE TABLE Sales.Invoice (id int NOT NULL PRIMARY KEY, orderId int NOT NULL REFERENCES Sales.[Order] (id), label nvarchar(40) NULL CHECK (len(label) > 0));
	CREATE INDEX IX_Invoice_order ON Sales.Invoice (orderId) INCLUDE (label);
	GO
	DROP TABLE dbo.Log;
	GO
	ALTER PROCEDURE Sales.usp_AddCustomer @name nvarchar(100)
	AS
		INSERT Sales.Customer (name, code, note) VALUES (@name, 'y', N'');
	GO
	CREATE VIEW Sales.vInvoice AS SELECT id, label FROM Sales.Invoice;
	GO
	CREATE VIEW Sales.vInvoiceCount AS SELECT COUNT(*) AS n FROM Sales.vInvoice;
	GO
	DROP FUNCTION dbo.fnDouble;
	GO
	CREATE FUNCTION dbo.fnTriple (@n int) RETURNS int AS BEGIN RETURN @n * 3 END;
	GO
	ALTER TRIGGER Sales.trg_Order ON Sales.[Order] AFTER INSERT, UPDATE AS SET NOCOUNT ON;
	GO
	DISABLE TRIGGER Sales.trg_Order ON Sales.[Order];
`;

const DATA = `
	INSERT Sales.Customer (code, name, email, balance, note) VALUES ('c1', N'Ann', 'a@x.test', 10, N'first'), ('c2', N'Bob', NULL, 20, N'second');
	INSERT Sales.[Order] (customerId, total, placed) SELECT id, 12.5, '2026-01-01' FROM Sales.Customer;
`;

// What the editor does with a script: every batch in order, on one connection, an error
// does not stop the next one (the script does that itself).
async function apply(manager, database, script, { stopAfter = Infinity } = {}) {
	const errors = [];
	const conn = await manager.acquireConnection();
	try {
		await conn.createRequest().batch(`USE ${bracket(database)}`);
		let n = 0;
		for (const b of splitBatches(script)) {
			if (n++ >= stopAfter) break;
			try { await conn.createRequest().batch(b.sql); } catch (error) { errors.push(error.message); }
		}
	} finally {
		try { await conn.createRequest().batch('SET NOEXEC OFF; USE [master]'); } catch { /* ignore */ }
		conn.release();
	}
	return errors;
}

suite('live SQL Server: applying the script of a comparison', function () {
	this.timeout(300000);
	let manager;
	let snapshot;
	let reference;
	let current;
	let diff;

	const read = db => readSchemaModel(manager, db);
	const generate = options => buildMigrationScript(diff, Object.assign({ reference: snapshot, current: SRC }, options));
	const names = d => d.changes.map(c => `${c.kind}:${c.name}:${c.status}`);

	suiteSetup(async function () {
		if (!LIVE_CONFIG) return this.skip();
		const live = JSON.parse(LIVE_CONFIG);
		manager = new ConnectionManager({
			getConnection: () => ({ name: 'live', server: live.server, authType: 'sql', username: live.user, database: 'master', encrypt: false, trustServerCertificate: true }),
			getConnectionPassword: async () => live.password
		});
		await manager.connectWithSaved('live');
		await createDatabase(manager, SRC);
		snapshot = await createSnapshot(manager, await planSnapshot(manager, SRC));
		await runScript(manager, SRC, CHANGES);
		reference = await read(snapshot);
		current = await read(SRC);
		diff = diffModels(reference, current);
		for (const target of TARGETS) {
			await createDatabase(manager, target);
			await runScript(manager, target, DATA);
		}
	});
	suiteTeardown(async () => {
		if (!manager) return;
		for (const db of [SRC, ...TARGETS]) { try { await dropDatabase(manager, db); } catch { /* ignore */ } }
		await manager.dispose();
	});

	test('the changes are all found', () => {
		assert.deepStrictEqual(names(diff), [
			'schema:Billing:added',
			'table:Billing.Payment:added', 'table:dbo.Log:removed', 'table:Sales.Customer:modified', 'table:Sales.Invoice:added', 'table:Sales.Order:modified',
			'view:Sales.vInvoice:added', 'view:Sales.vInvoiceCount:added', 'function:dbo.fnDouble:removed', 'function:dbo.fnTriple:added',
			'procedure:Sales.usp_AddCustomer:modified', 'trigger:Sales.trg_Order:modified'
		]);
	});

	test('without destructive changes, the script runs clean on a database in the state of the snapshot, and nothing is lost', async () => {
		const result = generate();
		assert.deepStrictEqual(result.skipped.map(s => s.op).sort(), ['dropColumn', 'dropTable']);
		const errors = await apply(manager, TARGETS[0], result.script);
		assert.deepStrictEqual(errors, []);

		const after = diffModels(current, await read(TARGETS[0]));
		// What is left is exactly what was left out: the column and the table that were not dropped.
		assert.deepStrictEqual(names(after), ['table:dbo.Log:added', 'table:Sales.Customer:modified']);
		assert.deepStrictEqual(after.changes[1].ops.map(o => `${o.op}:${o.column.name}`), ['addColumn:email']);
		const rows = (await manager.executeQueryInDatabase(TARGETS[0], 'SELECT COUNT(*) AS n, MIN(email) AS email FROM Sales.Customer')).recordset[0];
		assert.deepStrictEqual([rows.n, rows.email], [2, 'a@x.test']);
		const defaults = (await manager.executeQueryInDatabase(TARGETS[0], 'SELECT tier FROM Sales.Customer')).recordset.map(r => r.tier);
		assert.deepStrictEqual(defaults, [1, 1]);
	});

	test('with them, the same script finishes the job: the databases are identical', async () => {
		const result = generate({ allowDestructive: true });
		assert.strictEqual(result.skipped.length, 0);
		assert.deepStrictEqual(await apply(manager, TARGETS[0], result.script), []);
		const after = diffModels(current, await read(TARGETS[0]));
		assert.deepStrictEqual(names(after), []);
	});

	test('run again, it changes nothing and says nothing', async () => {
		const script = generate({ allowDestructive: true }).script;
		const before = JSON.stringify(await read(TARGETS[0]));
		assert.deepStrictEqual(await apply(manager, TARGETS[0], script), []);
		assert.deepStrictEqual(await apply(manager, TARGETS[0], script), []);
		assert.strictEqual(JSON.stringify(await read(TARGETS[0])), before);
	});

	test('run on the database that is already ahead, it does no harm', async () => {
		const before = await read(SRC);
		assert.deepStrictEqual(await apply(manager, SRC, generate({ allowDestructive: true }).script), []);
		// (The server keeps the blanks of CREATE OR ALTER in the text of the code: it is the same code.)
		assert.strictEqual(diffModels(before, await read(SRC)).identical, true);
		assert.strictEqual(diffModels(current, await read(SRC)).identical, true);
	});

	test('run on a database that was half done, it finishes', async () => {
		const script = generate({ allowDestructive: true }).script;
		const total = splitBatches(script).length;
		assert.deepStrictEqual(await apply(manager, TARGETS[1], script, { stopAfter: Math.floor(total / 2) }), []);
		const half = diffModels(current, await read(TARGETS[1]));
		assert.ok(half.changes.length > 0, 'the first half does not do it all');
		assert.deepStrictEqual(await apply(manager, TARGETS[1], script), []);
		assert.deepStrictEqual(names(diffModels(current, await read(TARGETS[1]))), []);
	});

	test('the script stops at the first error, and runs from the top once it is fixed', async () => {
		// A NOT NULL column with no default cannot be added to a table that has rows.
		const wanted = JSON.parse(JSON.stringify(await read(TARGETS[2])));
		wanted.tables['Sales.Customer'].columns.push({ name: 'must', type: 'int', nullable: false, identity: null, computed: null, default: null, collation: null });
		wanted.modules['Sales.vLate'] = { schema: 'Sales', name: 'vLate', type: 'view', definition: 'CREATE VIEW Sales.vLate AS SELECT id FROM Sales.Customer', ansiNulls: true, quotedIdentifier: true };
		const stopDiff = diffModels(await read(TARGETS[2]), wanted);
		const result = buildMigrationScript(stopDiff, {});
		assert.ok(result.warnings.some(w => w.includes('must')));

		const errors = await apply(manager, TARGETS[2], result.script);
		assert.strictEqual(errors.length, 1, errors.join(' | '));
		assert.ok(/non-empty table/.test(errors[0]), errors[0]);
		assert.strictEqual((await manager.executeQueryInDatabase(TARGETS[2], "SELECT OBJECT_ID('Sales.vLate') AS id")).recordset[0].id, null, 'the view after the failed step was not created');
		// The session is back to normal: nothing is skipped any more.
		assert.strictEqual((await manager.executeQueryInDatabase(TARGETS[2], 'SELECT 1 AS one')).recordset[0].one, 1);

		await manager.executeQueryInDatabase(TARGETS[2], 'DELETE Sales.[Order]; DELETE Sales.Customer');
		assert.deepStrictEqual(await apply(manager, TARGETS[2], result.script), []);
		assert.ok((await manager.executeQueryInDatabase(TARGETS[2], "SELECT OBJECT_ID('Sales.vLate') AS id")).recordset[0].id);
	});

	test('before 2016 SP1 the same changes are written without CREATE OR ALTER, and they apply too', async () => {
		const script = generate({ allowDestructive: true, createOrAlter: false }).script;
		assert.ok(!script.includes('CREATE OR ALTER'));
		const db = 'WayfarerMigLegacy';
		try {
			await createDatabase(manager, db);
			await runScript(manager, db, DATA);
			assert.deepStrictEqual(await apply(manager, db, script), []);
			assert.deepStrictEqual(names(diffModels(current, await read(db))), []);
			assert.deepStrictEqual(await apply(manager, db, script), []);
		} finally {
			await dropDatabase(manager, db);
		}
	});

	test('the snapshot is dropped at the end', async () => {
		await dropSnapshot(manager, snapshot);
	});
});
