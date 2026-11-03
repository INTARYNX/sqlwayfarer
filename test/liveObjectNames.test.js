const assert = require('assert');
const ConnectionManager = require('../database/ConnectionManager');
const DatabaseService = require('../database/DatabaseService');
const ScriptGeneratorService = require('../database/ScriptGeneratorService');

// === Live: objects whose names have a dot or a bracket in them ===
//
// Opt-in through SQLWAYFARER_TEST_SQL (see AGENTS.md). It creates its own
// scratch database and drops it at the end.

const LIVE_CONFIG = process.env.SQLWAYFARER_TEST_SQL;
const DB = 'SqlWayfarerLiveNames';

suite('live SQL Server: object names with a dot or a bracket', function () {
	this.timeout(60000);
	let manager;
	let service;
	let scripts;

	suiteSetup(async function () {
		if (!LIVE_CONFIG) return this.skip();
		const live = JSON.parse(LIVE_CONFIG);
		manager = new ConnectionManager({
			getConnection: () => ({ name: 'live', server: live.server, authType: 'sql', username: live.user, database: 'master', encrypt: false, trustServerCertificate: true }),
			getConnectionPassword: async () => live.password
		});
		await manager.connectWithSaved('live');
		await manager.executeQuery(`IF DB_ID('${DB}') IS NOT NULL BEGIN ALTER DATABASE ${DB} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${DB}; END; CREATE DATABASE ${DB}`);
		await manager.executeQuery(`USE ${DB}; EXEC('CREATE SCHEMA Sales'); EXEC('CREATE TABLE dbo.[a.b] (id int PRIMARY KEY, [x]]y] nvarchar(10))'); EXEC('CREATE TABLE dbo.Plain (id int)'); EXEC('INSERT dbo.[a.b] VALUES (1, N''x''), (2, N''y'')')`);
		await manager.executeQuery(`USE ${DB}; EXEC('CREATE PROCEDURE dbo.[p.q] @n int, @s nvarchar(20) = NULL AS SELECT @n AS n'); EXEC('CREATE PROCEDURE Sales.OnlyInSales AS SELECT 1 AS one'); EXEC('CREATE FUNCTION dbo.[f.g](@i int) RETURNS int AS BEGIN RETURN @i END')`);
		service = new DatabaseService(manager);
		scripts = new ScriptGeneratorService(manager, service);
	});
	suiteTeardown(async () => {
		if (!manager) return;
		try { await manager.executeQuery(`ALTER DATABASE ${DB} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${DB}`); } catch { /* ignore */ }
		await manager.dispose();
	});

	test('the columns and the parameters of an object whose name has a dot', async () => {
		assert.deepStrictEqual((await service.getObjectColumns(DB, 'dbo.[a.b]')).map(c => c.name), ['id', 'x]y']);
		assert.deepStrictEqual((await service.getObjectColumns(DB, '[dbo].[a.b]')).map(c => c.name), ['id', 'x]y']);
		assert.deepStrictEqual((await service.getObjectParameters(DB, 'dbo.[p.q]')).map(p => p.name), ['@n', '@s']);
	});

	test('the stats of a table whose name has a dot', async () => {
		const stats = await service.getTableStats(DB, 'dbo.[a.b]');
		assert.strictEqual(Number(stats.rowCount), 2);
	});

	test('the row count of a table, as a number', async () => {
		assert.strictEqual(await service.getTableRowCount(DB, 'dbo.[a.b]'), 2);
		assert.strictEqual(await service.getTableRowCount(DB, 'dbo.Plain'), 0);
	});

	test('the EXEC and SELECT scripts of a procedure and a function whose names have a dot', async () => {
		const exec = await scripts.generateScript(DB, 'dbo.[p.q]', 'Procedure', 'exec');
		assert.ok(exec.includes('@n') && exec.includes('[p.q]'), exec);
		const select = await scripts.generateScript(DB, 'dbo.[f.g]', 'Function', 'select');
		assert.ok(select.includes('[f.g]') && select.includes('@i'), select);
	});

	test('a definition asked by its bare name is found in whatever schema it is', async () => {
		assert.ok((await service.getObjectDefinition(DB, 'OnlyInSales')).includes('OnlyInSales'));
		assert.ok((await service.getObjectDefinition(DB, 'Sales.OnlyInSales')).includes('OnlyInSales'));
		assert.strictEqual(await service.getObjectDefinition(DB, 'NoSuchThing'), null);
	});
});
