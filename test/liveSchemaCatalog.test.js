const assert = require('assert');
const ConnectionManager = require('../database/ConnectionManager');
const { readSchemaModel } = require('../database/schemaCatalog');
const { createDatabase, dropDatabase } = require('./support/schemaFixture');

// === Live: the schema model read from a real catalog ===
//
// Opt-in through SQLWAYFARER_TEST_SQL (see AGENTS.md). Works in a scratch database.

const LIVE_CONFIG = process.env.SQLWAYFARER_TEST_SQL;
const DB = 'WayfarerCatalogTest';

suite('live SQL Server: schema catalog', function () {
	this.timeout(60000);
	let manager;
	let model;

	suiteSetup(async function () {
		if (!LIVE_CONFIG) return this.skip();
		const live = JSON.parse(LIVE_CONFIG);
		manager = new ConnectionManager({
			getConnection: () => ({ name: 'live', server: live.server, authType: 'sql', username: live.user, database: 'master', encrypt: false, trustServerCertificate: true }),
			getConnectionPassword: async () => live.password
		});
		await manager.connectWithSaved('live');
		await createDatabase(manager, DB);
		model = await readSchemaModel(manager, DB);
	});
	suiteTeardown(async () => {
		if (!manager) return;
		try { await dropDatabase(manager, DB); } catch { /* ignore */ }
		await manager.dispose();
	});

	test('schemas, tables, and the modules of every kind', () => {
		assert.deepStrictEqual(model.schemas, ['Sales']);
		assert.deepStrictEqual(Object.keys(model.tables), ['dbo.Log', 'Sales.Customer', 'Sales.Order']);
		assert.deepStrictEqual(Object.keys(model.modules).sort(), ['Sales.trg_Order', 'Sales.usp_AddCustomer', 'Sales.vCustomer', 'dbo.fnDouble']);
		assert.deepStrictEqual(Object.values(model.modules).map(m => m.type).sort(), ['function', 'procedure', 'trigger', 'view']);
	});

	test('columns: types, identity, computed, defaults (named or not), collation, user-defined type', () => {
		const byName = Object.fromEntries(model.tables['Sales.Customer'].columns.map(c => [c.name, c]));
		assert.deepStrictEqual(model.tables['Sales.Customer'].columns.map(c => c.name), ['id', 'code', 'name', 'email', 'created', 'active', 'nameUpper', 'balance', 'note']);
		assert.deepStrictEqual(byName.id.identity, { seed: '1', increment: '1' });
		assert.strictEqual(byName.code.type, '[dbo].[Code]');
		assert.strictEqual(byName.name.type, 'nvarchar(100)');
		assert.strictEqual(byName.email.type, 'varchar(200)');
		assert.strictEqual(byName.email.nullable, true);
		assert.strictEqual(byName.created.type, 'datetime2(3)');
		assert.deepStrictEqual(byName.created.default, { name: 'DF_Customer_created', definition: '(sysutcdatetime())', systemNamed: false });
		assert.strictEqual(byName.active.default.systemNamed, true);
		assert.strictEqual(byName.active.default.definition, '((1))');
		assert.deepStrictEqual(byName.nameUpper.computed, { definition: '(upper([name]))', persisted: true });
		assert.strictEqual(byName.balance.type, 'decimal(12,2)');
		assert.strictEqual(byName.note.type, 'nvarchar(max)');
		assert.strictEqual(byName.note.collation, 'Latin1_General_CS_AS');
		assert.strictEqual(byName.name.collation, null);
		assert.deepStrictEqual(model.tables['Sales.Order'].columns[0].identity, { seed: '100', increment: '5' });
	});

	test('keys and indexes: primary key, unique constraint, filtered unique index, INCLUDE, descending key', () => {
		const t = model.tables['Sales.Customer'];
		assert.deepStrictEqual(t.primaryKey, { name: 'PK_Customer', systemNamed: false, clustered: true, columns: [{ name: 'id', desc: false }] });
		assert.deepStrictEqual(t.uniques, [{ name: 'UQ_Customer_code', systemNamed: false, clustered: false, columns: [{ name: 'code', desc: false }] }]);
		assert.deepStrictEqual(t.indexes.map(i => i.name), ['IX_Customer_name', 'UX_Customer_email']);
		assert.deepStrictEqual(t.indexes[0], { name: 'IX_Customer_name', unique: false, clustered: false, columns: [{ name: 'name', desc: true }], included: ['balance'], filter: null, disabled: false });
		assert.deepStrictEqual([t.indexes[1].unique, t.indexes[1].filter], [true, '([email] IS NOT NULL)']);
		assert.strictEqual(model.tables['Sales.Order'].primaryKey.systemNamed, true);
		assert.strictEqual(model.tables['dbo.Log'].primaryKey, null);
	});

	test('foreign keys and check constraints', () => {
		assert.deepStrictEqual(model.tables['Sales.Order'].foreignKeys, [{
			name: 'FK_Order_Customer', systemNamed: false, columns: ['customerId'], refSchema: 'Sales', refTable: 'Customer', refColumns: ['id'],
			onDelete: 'CASCADE', onUpdate: 'NO_ACTION', disabled: false
		}]);
		assert.deepStrictEqual(model.tables['Sales.Customer'].checks, [{ name: 'CK_Customer_balance', systemNamed: false, definition: '([balance]>=(0))', disabled: false }]);
	});

	test('modules: the definition as written, the trigger knows its table', () => {
		assert.ok(model.modules['Sales.vCustomer'].definition.startsWith('CREATE VIEW Sales.vCustomer'));
		assert.deepStrictEqual([model.modules['Sales.trg_Order'].parent, model.modules['Sales.trg_Order'].disabled], ['Sales.Order', false]);
		assert.strictEqual(model.modules['dbo.fnDouble'].quotedIdentifier, true);
	});

	test('what is not read is counted: the user-defined type, and the temporal table with its history, which are not in the model', () => {
		assert.deepStrictEqual(model.notCompared, { userTypes: 1, temporalTables: 2 });
		assert.ok(!model.tables['dbo.Audit'] && !model.tables['dbo.AuditHistory']);
	});

	test('reading twice gives the same model, byte for byte', async () => {
		const again = await readSchemaModel(manager, DB);
		assert.strictEqual(JSON.stringify(again), JSON.stringify(model));
	});

	test('the pooled connection is not left in the database', async () => {
		await readSchemaModel(manager, DB);
		const rows = (await manager.executeQuery('SELECT COUNT(*) AS n FROM sys.dm_exec_sessions WHERE database_id = DB_ID(@name)', { name: DB })).recordset;
		assert.strictEqual(rows[0].n, 0);
	});
});
