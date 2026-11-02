const assert = require('assert');
global.SqlContext = require('../webview/sqlContext');
global.SqlMatcher = require('../webview/sqlMatcher');
const SqlAutocomplete = require('../webview/sqlAutocomplete');
const DatabaseService = require('../database/DatabaseService');
const SCENARIOS = require('./support/autocompleteScenarios');

// === Live: the autocompletion scenarios, on the real columns of a real SQL Server ===
//
// Opt-in through SQLWAYFARER_TEST_SQL (see AGENTS.md). Creates two scratch
// databases and drops them at the end; skips itself without the variable.

const LIVE_CONFIG = process.env.SQLWAYFARER_TEST_SQL;
const DB = 'sqlwf_test_scen';
const OTHER = 'sqlwf_test_scen_other';

suite('live SQL Server: autocompletion scenarios', function () {
	this.timeout(120000);
	let pool = null;
	const scratchPools = [];
	let objectsByDb = {};
	let columns = {};
	let parameters = {};
	let foreignKeys = [];

	// The pooled connection selects the database itself: a pool is opened on it.
	async function inDb(db, batch) {
		const sql = require('mssql');
		let p = scratchPools.find(x => x.db === db);
		if (!p) {
			p = { db, pool: await new sql.ConnectionPool(Object.assign({}, JSON.parse(LIVE_CONFIG), { database: db })).connect() };
			scratchPools.push(p);
		}
		await p.pool.request().batch(batch);
	}

	async function dropDatabases() {
		for (const p of scratchPools.splice(0)) await p.pool.close().catch(() => {});
		for (const db of [DB, OTHER]) {
			await pool.request().batch(`USE master; IF DB_ID('${db}') IS NOT NULL BEGIN ALTER DATABASE [${db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${db}]; END`);
		}
	}

	function makeConnectionManager() {
		return {
			isConnected: () => true,
			getServerName: () => pool.config.server,
			executeQuery: q => pool.request().query(q),
			executeQueryInDatabase: async (database, query, params = null) => {
				const request = pool.request();
				for (const [name, value] of Object.entries(params || {})) request.input(name, value);
				return request.query(`USE [${database.replace(/]/g, ']]')}];\n${query}`);
			}
		};
	}

	suiteSetup(async function () {
		if (!LIVE_CONFIG) this.skip();
		pool = await require('mssql').connect(JSON.parse(LIVE_CONFIG));
		await dropDatabases();
		await pool.request().batch(`CREATE DATABASE [${DB}]`);
		await pool.request().batch(`CREATE DATABASE [${OTHER}]`);
		await inDb(OTHER, 'CREATE SCHEMA Person');
		await inDb(OTHER, 'CREATE TABLE Person.Person (BusinessEntityID int PRIMARY KEY, FirstName nvarchar(50), LastName nvarchar(50))');
		await inDb(DB, 'CREATE TABLE dbo.Employees (ID int IDENTITY PRIMARY KEY, Name nvarchar(50), Salary decimal(18,2), DeptID int)');
		await inDb(DB, 'CREATE TABLE dbo.Depts (DeptID int PRIMARY KEY, DeptName nvarchar(50))');
		await inDb(DB, 'CREATE TABLE dbo.[Order Items] ([Item ID] int, [Unit Price] money)');
		await inDb(DB, 'CREATE VIEW dbo.vEmp AS SELECT e.ID, e.Name, d.DeptName FROM dbo.Employees e JOIN dbo.Depts d ON d.DeptID = e.DeptID');
		await inDb(DB, 'CREATE FUNCTION dbo.fnInline(@d int) RETURNS TABLE AS RETURN SELECT ID, Name FROM dbo.Employees WHERE DeptID = @d');
		await inDb(DB, 'CREATE FUNCTION dbo.fnMulti(@d int) RETURNS @r TABLE (EmpID int, Label nvarchar(20)) AS BEGIN INSERT @r SELECT ID, Name FROM dbo.Employees; RETURN END');
		await inDb(DB, 'CREATE FUNCTION dbo.fnScalar(@x int) RETURNS int AS BEGIN RETURN @x END');
		await inDb(DB, 'CREATE PROCEDURE dbo.uspP @a int, @b nvarchar(10) = \'x\' AS SELECT 1');

		// What the host would answer to the requests of the webview.
		const service = new DatabaseService(makeConnectionManager());
		for (const db of [DB, OTHER]) {
			objectsByDb[db] = await service.getObjects(db);
			for (const o of objectsByDb[db]) {
				const key = `${db}::${o.qualified_name.toLowerCase()}`;
				if (o.object_type === 'Procedure') parameters[key] = await service.getObjectParameters(db, o.qualified_name);
				else columns[key] = await service.getObjectColumns(db, o.qualified_name);
			}
		}
		foreignKeys = await service.getForeignKeys(DB);
	});

	suiteTeardown(async () => {
		if (!pool) return;
		await dropDatabases().catch(() => { /* the scratch databases stay behind: harmless */ });
		await pool.close();
		pool = null;
	});

	for (const [name, text0, must, mustNot = []] of SCENARIOS) {
		test(name, () => {
			const real = text0.replace(/OtherDb/g, OTHER);
			const caret = real.indexOf('|');
			const text = real.replace('|', '');
			const env = {
				objects: objectsByDb[DB], foreignKeys, databases: ['master', DB, OTHER], currentDatabase: DB,
				getColumns: (db, q) => columns[`${db || DB}::${q.toLowerCase()}`],
				getParameters: (db, q) => parameters[`${db || DB}::${q.toLowerCase()}`],
				getDatabaseObjects: db => objectsByDb[db], settings: {}, usage: new Map(), force: true
			};
			const inserts = SqlAutocomplete.compute(text, caret, env).items.map(i => i.insert);
			for (const m of must) {
				assert.ok(inserts.some(i => i === m || i.startsWith(m + ' ') || i.toLowerCase() === m.toLowerCase()), `${m} missing in: ${inserts.slice(0, 15)}`);
			}
			for (const m of mustNot) assert.ok(!inserts.includes(m), `${m} must not be offered`);
		});
	}
});
