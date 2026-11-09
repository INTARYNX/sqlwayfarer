const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
global.SqlContext = require('../webview/sqlContext');
global.SqlMatcher = require('../webview/sqlMatcher');
const SqlAutocomplete = require('../webview/sqlAutocomplete');
const DatabaseService = require('../database/DatabaseService');
const DependencyService = require('../database/DependencyService');
const IndexService = require('../database/IndexServices');

// === Live: the queries of the autocompletion and the index, on a real SQL Server ===
//
// Opt-in through the SQLWAYFARER_TEST_SQL environment variable, which holds the
// JSON connection of the server (see AGENTS.md):
//   {"server":"localhost","user":"me","password":"...","database":"master",
//    "options":{"trustServerCertificate":true,"encrypt":false}}
// The suite creates the scratch database sqlwf_test_live and drops it at the end.
// Without the variable it skips itself, so `npm test` stays green everywhere.

const LIVE_CONFIG = process.env.SQLWAYFARER_TEST_SQL;
const DB = 'sqlwf_test_live';

suite('live SQL Server: autocompletion queries and index lifecycle', function () {
	this.timeout(120000);
	let pool = null;
	let queryLog = [];
	let indexDir;

	// A batch run inside the scratch database. CREATE SCHEMA / VIEW / PROCEDURE
	// must be alone in their batch, so a USE prefix is not an option: a pool
	// opened on the database is used instead.
	let scratchPool = null;

	async function inScratch(sql) {
		if (!scratchPool) {
			const sql_ = require('mssql');
			scratchPool = await new sql_.ConnectionPool(Object.assign({}, JSON.parse(LIVE_CONFIG), { database: DB })).connect();
		}
		await scratchPool.request().batch(sql);
	}

	async function createScratchDatabase() {
		await dropScratchDatabase();
		await pool.request().batch(`CREATE DATABASE [${DB}]`);
		await inScratch('CREATE SCHEMA Sales');
		await inScratch(`CREATE TABLE dbo.Employees (
			ID int IDENTITY(1,1) NOT NULL CONSTRAINT PK_Employees PRIMARY KEY,
			Name nvarchar(50) NULL,
			Salary decimal(18,2) NOT NULL,
			HiredAt datetime2(3) NULL,
			[Order] int NULL)`);
		await inScratch(`CREATE TABLE Sales.Orders (
			OrderID int NOT NULL CONSTRAINT PK_Orders PRIMARY KEY,
			EmployeeID int NOT NULL CONSTRAINT FK_Orders_Employees FOREIGN KEY REFERENCES dbo.Employees(ID),
			Total money NULL)`);
		await inScratch(`CREATE VIEW Sales.vOrderTotals AS
			SELECT e.Name, SUM(o.Total) AS Total FROM Sales.Orders o JOIN dbo.Employees e ON e.ID = o.EmployeeID GROUP BY e.Name`);
		await inScratch(`CREATE PROCEDURE dbo.uspRaise @Dept int, @Pct decimal(5,2) = 5, @Updated int OUTPUT AS
			BEGIN UPDATE dbo.Employees SET Salary = Salary * (1 + @Pct / 100.0); SET @Updated = @@ROWCOUNT; END`);
		await inScratch('CREATE PROCEDURE dbo.uspNoParams AS SELECT 1 AS One');
		await inScratch('CREATE FUNCTION dbo.fnTax (@amount money) RETURNS money AS BEGIN RETURN @amount * 0.2 END');
	}

	async function dropScratchDatabase() {
		if (scratchPool) {
			await scratchPool.close().catch(() => {});
			scratchPool = null;
		}
		// The pooled connection may have selected the scratch database with USE.
		await pool.request().batch(`
			USE master;
			IF DB_ID('${DB}') IS NOT NULL BEGIN
				ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
				DROP DATABASE [${DB}];
			END`);
	}

	// The connection manager of the extension, on top of the real pool. Every
	// query is logged, to check what reading the index costs.
	function makeConnectionManager() {
		return {
			isConnected: () => true,
			getServerName: () => pool.config.server,
			executeQuery: async (query, params = null) => {
				queryLog.push(query);
				const request = pool.request();
				for (const [name, value] of Object.entries(params || {})) request.input(name, value);
				return request.query(query);
			},
			executeQueryInDatabase: async (database, query, params = null) => {
				queryLog.push(query);
				// Same as the real ConnectionManager: the database is selected by a USE prefix.
				const request = pool.request();
				for (const [name, value] of Object.entries(params || {})) request.input(name, value);
				return request.query(`USE [${database.replace(/]/g, ']]')}];\n${query}`);
			}
		};
	}

	suiteSetup(async function () {
		if (!LIVE_CONFIG) this.skip();
		const sql = require('mssql');
		pool = await sql.connect(JSON.parse(LIVE_CONFIG));
		await createScratchDatabase();
		indexDir = path.join(os.tmpdir(), `sqlwayfarer-live-${Date.now()}`);
	});

	suiteTeardown(async () => {
		if (indexDir) await fs.rm(indexDir, { recursive: true, force: true }).catch(() => {});
		if (!pool) return;
		await dropScratchDatabase().catch(() => { /* the scratch database stays behind: harmless */ });
		await pool.close();
		pool = null;
	});

	// === Columns and parameters ===

	suite('columns and parameters', () => {
		test('a table: full types, nullability, identity and primary key, in column order', async () => {
			const service = new DatabaseService(makeConnectionManager());
			const columns = await service.getObjectColumns(DB, 'dbo.Employees');
			assert.deepStrictEqual(columns, [
				{ name: 'ID', type: 'int', nullable: false, isIdentity: true, isPrimaryKey: true },
				{ name: 'Name', type: 'nvarchar(50)', nullable: true, isIdentity: false, isPrimaryKey: false },
				{ name: 'Salary', type: 'decimal(18,2)', nullable: false, isIdentity: false, isPrimaryKey: false },
				{ name: 'HiredAt', type: 'datetime2(3)', nullable: true, isIdentity: false, isPrimaryKey: false },
				{ name: 'Order', type: 'int', nullable: true, isIdentity: false, isPrimaryKey: false }
			]);
		});

		test('a view', async () => {
			const service = new DatabaseService(makeConnectionManager());
			const columns = await service.getObjectColumns(DB, 'Sales.vOrderTotals');
			assert.deepStrictEqual(columns.map(c => [c.name, c.type]), [['Name', 'nvarchar(50)'], ['Total', 'money']]);
		});

		test('an object that does not exist has no columns (and is not an error)', async () => {
			const service = new DatabaseService(makeConnectionManager());
			assert.deepStrictEqual(await service.getObjectColumns(DB, 'dbo.Ghost'), []);
		});

		test('the parameters of a procedure, in order, with their direction', async () => {
			const service = new DatabaseService(makeConnectionManager());
			assert.deepStrictEqual(await service.getObjectParameters(DB, 'dbo.uspRaise'), [
				{ name: '@Dept', type: 'int', isOutput: false },
				{ name: '@Pct', type: 'decimal(5,2)', isOutput: false },
				{ name: '@Updated', type: 'int', isOutput: true }
			]);
		});

		test('a procedure without parameters, and a function (its return value is not a parameter)', async () => {
			const service = new DatabaseService(makeConnectionManager());
			assert.deepStrictEqual(await service.getObjectParameters(DB, 'dbo.uspNoParams'), []);
			assert.deepStrictEqual(await service.getObjectParameters(DB, 'dbo.fnTax'), [{ name: '@amount', type: 'money', isOutput: false }]);
		});

		test('the foreign keys and the object list have the shape the autocompletion reads', async () => {
			const service = new DatabaseService(makeConnectionManager());
			const fks = await service.getForeignKeys(DB);
			assert.deepStrictEqual(fks, [{ fkName: 'FK_Orders_Employees', fromTable: 'Sales.Orders', fromColumn: 'EmployeeID', toTable: 'dbo.Employees', toColumn: 'ID' }]);
			const objects = await service.getObjects(DB);
			const byName = Object.fromEntries(objects.map(o => [o.qualified_name, o]));
			for (const [name, type] of [['dbo.Employees', 'Table'], ['Sales.Orders', 'Table'], ['Sales.vOrderTotals', 'View'], ['dbo.uspRaise', 'Procedure'], ['dbo.fnTax', 'Function']]) {
				assert.ok(byName[name], `${name} is listed`);
				assert.strictEqual(byName[name].object_type, type, name);
				assert.ok(byName[name].object_name && byName[name].schema_name && byName[name].name, `${name}: names`);
			}
		});
	});

	// === The autocompletion on the real schema ===

	suite('suggestions on the real schema', () => {
		let env;

		suiteSetup(async () => {
			const service = new DatabaseService(makeConnectionManager());
			const objects = await service.getObjects(DB);
			const foreignKeys = await service.getForeignKeys(DB);
			const columns = {};
			for (const o of objects.filter(x => x.object_type === 'Table' || x.object_type === 'View')) {
				columns[o.qualified_name.toLowerCase()] = await service.getObjectColumns(DB, o.qualified_name);
			}
			const parameters = {};
			for (const o of objects.filter(x => x.object_type === 'Procedure')) {
				parameters[o.qualified_name.toLowerCase()] = await service.getObjectParameters(DB, o.qualified_name);
			}
			env = {
				objects, foreignKeys, databases: ['master', DB], currentDatabase: DB,
				getColumns: (db, q) => columns[q.toLowerCase()],
				getParameters: (db, q) => parameters[q.toLowerCase()],
				settings: {}, usage: new Map()
			};
		});

		function suggest(sql, extra = {}) {
			const caret = sql.indexOf('|');
			return SqlAutocomplete.compute(sql.replace('|', ''), caret, Object.assign({}, env, extra));
		}

		test('a column list in table order, with brackets only where needed', () => {
			const items = suggest('SELECT e.| FROM dbo.Employees e').items;
			assert.deepStrictEqual(items.map(i => i.insert), ['ID', 'Name', 'Salary', 'HiredAt', '[Order]']);
			assert.strictEqual(items[0].info, 'dbo.Employees.ID · int · NOT NULL · PK · IDENTITY');
		});

		test('JOIN proposes the foreign-key join first, ON proposes its condition', () => {
			const join = suggest('SELECT * FROM dbo.Employees e JOIN |').items[0];
			assert.strictEqual(join.kind, 'joinCondition');
			assert.strictEqual(join.insert, 'Sales.Orders o ON o.EmployeeID = e.ID');
			const on = suggest('SELECT * FROM dbo.Employees e JOIN Sales.Orders o ON |').items[0];
			assert.strictEqual(on.insert, 'o.EmployeeID = e.ID');
		});

		test('Ctrl+Space after * lists the columns of every table', () => {
			const item = suggest('SELECT *| FROM dbo.Employees e JOIN Sales.Orders o ON o.EmployeeID = e.ID', { force: true }).items[0];
			assert.strictEqual(item.insert, 'e.ID, e.Name, e.Salary, e.HiredAt, e.[Order], o.OrderID, o.EmployeeID, o.Total');
		});

		test('EXEC lists the parameters of the real procedure', () => {
			const items = suggest('EXEC dbo.uspRaise |').items;
			assert.deepStrictEqual(items.map(i => i.label), ['All parameters', '@Dept', '@Pct', '@Updated']);
			assert.strictEqual(items[0].insert, '@Dept = ,\n    @Pct = ,\n    @Updated = ');
		});

		test('a CTE over a real table, and a derived table, expose their columns', () => {
			assert.deepStrictEqual(suggest('WITH c AS (SELECT ID, Name FROM dbo.Employees) SELECT c.| FROM c').items.map(i => i.insert), ['ID', 'Name']);
			assert.deepStrictEqual(suggest('SELECT d.| FROM (SELECT * FROM Sales.Orders) d').items.map(i => i.insert), ['OrderID', 'EmployeeID', 'Total']);
		});

		test('system objects are not offered, the user objects are', () => {
			const items = suggest('SELECT * FROM |').items;
			assert.ok(items.some(i => i.insert === 'dbo.Employees'));
			assert.ok(!items.some(i => /^sys\./i.test(i.insert)));
		});
	});

	// === The index lifecycle ===

	suite('index: built only on request', () => {
		let service;
		let dependencies;

		suiteSetup(() => {
			service = new IndexService(makeConnectionManager(), new DatabaseService(makeConnectionManager()));
			service._indexDir = indexDir;
			dependencies = new DependencyService(makeConnectionManager(), new DatabaseService(makeConnectionManager()));
			dependencies.setIndexService(service);
		});

		suiteTeardown(async () => { if (service) await service.dispose(); });

		test('nothing is built, or even queried, while the user has not asked', async () => {
			queryLog = [];
			assert.strictEqual(await service.peekIndex(DB), null);
			assert.deepStrictEqual(await dependencies.getDependencies(DB, 'Sales.vOrderTotals'), { dependsOn: [], referencedBy: [] });
			assert.deepStrictEqual(await dependencies.getDependencyTree(DB, 'Sales.vOrderTotals'), { name: 'Sales.vOrderTotals', dependencies: [] });
			assert.strictEqual(await service.getColumnUsage(DB, 'dbo.Employees'), null);
			assert.deepStrictEqual(await service.getIndexStatus(DB), { state: 'none' });
			assert.strictEqual(queryLog.length, 0, `queries run: ${queryLog.map(q => q.trim().slice(0, 40)).join(' | ')}`);
		});

		test('the user builds it: the objects are analyzed and the dependencies found', async () => {
			const index = await service.getIndex(DB);
			assert.ok(index.totalObjects >= 6, `${index.totalObjects} objects`);
			const status = await service.getIndexStatus(DB);
			assert.strictEqual(status.state, 'ready');
			assert.ok(status.builtAt);
			const deps = await dependencies.getDependencies(DB, 'Sales.vOrderTotals');
			const names = deps.dependsOn.map(d => d.referenced_object).map(n => String(n).replace(/[[\]]/g, '').toLowerCase());
			assert.ok(names.includes('sales.orders') && names.includes('dbo.employees'), `depends on: ${names}`);
		});

		test('reading afterwards does not query the schema definitions again', async () => {
			queryLog = [];
			await dependencies.getDependencies(DB, 'Sales.vOrderTotals');
			await dependencies.getDependencyTree(DB, 'Sales.vOrderTotals');
			await service.getColumnUsage(DB, 'dbo.Employees');
			assert.strictEqual(queryLog.length, 0);
		});

		test('column usage comes from the parsed definitions', async () => {
			const usage = await service.getColumnUsage(DB, 'dbo.Employees');
			assert.ok(usage && usage.salary, `columns used: ${Object.keys(usage || {})}`);
			assert.ok(usage.salary.some(u => /uspRaise/i.test(u.object)), 'the procedure that updates Salary is listed');
		});

		test('a schema change makes it stale, and looking at it does not update it', async () => {
			await new Promise(resolve => setTimeout(resolve, 50)); // modify_date resolution
			await inScratch('ALTER VIEW Sales.vOrderTotals AS SELECT e.Name, SUM(o.Total) AS Total, COUNT(*) AS N FROM Sales.Orders o JOIN dbo.Employees e ON e.ID = o.EmployeeID GROUP BY e.Name');
			const before = await service.peekIndex(DB);
			const status = await service.getIndexStatus(DB);
			assert.strictEqual(status.state, 'stale');
			assert.deepStrictEqual(status.changes, { modified: ['Sales.vOrderTotals'], added: [], removed: [] });
			assert.strictEqual((await service.peekIndex(DB)).lastFullIndex, before.lastFullIndex);
			assert.strictEqual((await service.getIndexStatus(DB)).state, 'stale', 'still stale: nothing updated it');
		});

		test('the user updates it: only the changed object is re-analyzed', async () => {
			queryLog = [];
			await service.getIndex(DB);
			assert.strictEqual((await service.getIndexStatus(DB)).state, 'ready');
			const analyses = queryLog.filter(q => /sql_expression_dependencies|dm_sql_referenced_entities/i.test(q)).length;
			assert.ok(analyses >= 1 && analyses <= 2, `${analyses} dependency queries for one changed view`);
		});

		test('a new object makes it stale again; force reindex rebuilds from scratch', async () => {
			await new Promise(resolve => setTimeout(resolve, 50));
			await inScratch('CREATE VIEW dbo.vExtra AS SELECT ID FROM dbo.Employees');
			const status = await service.getIndexStatus(DB);
			assert.strictEqual(status.state, 'stale');
			assert.deepStrictEqual(status.changes, { modified: [], added: ['dbo.vExtra'], removed: [] });
			const rebuilt = await service.forceReindex(DB);
			assert.ok(rebuilt.objects['dbo.vExtra']);
			assert.strictEqual((await service.getIndexStatus(DB)).state, 'ready');
		});

		test('method calls on xml / hierarchyid columns are not dependencies', async () => {
			await inScratch('CREATE TABLE dbo.XmlDocs (ID int PRIMARY KEY, Doc xml, Node hierarchyid)');
			await inScratch('CREATE VIEW dbo.vXmlDocs AS SELECT d.ID, d.Doc.value(\'(/a)[1]\', \'int\') AS A, d.Node.GetLevel() AS Lvl, d.Node.ToString() AS Path FROM dbo.XmlDocs d WHERE d.Doc.exist(\'/a\') = 1');
			const index = await service.forceReindex(DB);
			assert.deepStrictEqual(index.objects['dbo.vXmlDocs'].dependencies, ['dbo.XmlDocs']);
		});

		test('a MERGE ... OUTPUT INTO writes the audit table', async () => {
			await inScratch('CREATE TABLE dbo.AuditLive (Action nvarchar(10), Payload int)');
			await inScratch(`CREATE PROCEDURE dbo.uspMergeLive AS
				MERGE dbo.Employees AS t USING (SELECT 1 AS Id) AS s ON t.ID = s.Id
				WHEN MATCHED THEN UPDATE SET t.Name = 'x'
				OUTPUT $action, inserted.ID INTO dbo.AuditLive (Action, Payload);`);
			const index = await service.forceReindex(DB);
			assert.deepStrictEqual([...index.objects['dbo.uspMergeLive'].tableWrites].sort(), ['dbo.auditlive', 'dbo.employees']);
		});

		test('every build is recorded in the statistics, with where the time went', async () => {
			const { runs } = await service.getBuildStats(DB);
			assert.deepStrictEqual(runs.map(r => r.mode).reverse(), ['full', 'incremental', 'force', 'force', 'force']);
			const full = runs[runs.length - 1];
			assert.ok(full.analyzedObjects >= 6 && full.durationMs > 0, 'the full build analyzed the objects');
			assert.ok(full.cumulative.queryMs > 0 && full.cumulative.parseMs > 0, 'the server and the parser both cost something');
			assert.ok(full.slowest.length > 0 && full.byType.length > 0);
			const incremental = runs[runs.length - 2];
			assert.ok(incremental.analyzedObjects >= 1 && incremental.analyzedObjects <= 2, 'an update analyzes only the changed object');
			assert.ok(incremental.reusedObjects >= 4);
		});

		test('the features that need the index say so when it is missing', async () => {
			const fresh = new IndexService(makeConnectionManager(), new DatabaseService(makeConnectionManager()));
			fresh._indexDir = path.join(indexDir, 'empty');
			try {
				await assert.rejects(() => fresh.requireIndex(DB), error => error.code === 'INDEX_NOT_BUILT');
			} finally {
				await fresh.dispose();
			}
		});
	});
});
