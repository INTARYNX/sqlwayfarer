const assert = require('assert');
const ConnectionManager = require('../database/ConnectionManager');
const DatabaseService = require('../database/DatabaseService');
const { QuerySession } = require('../database/QuerySession');
const InstanceHandlers = require('../panels/handlers/InstanceHandlers');
const { getDependents } = require('../database/instanceActions');

// === Live: the instance tree lists, renames and deletes on a real server ===
//
// Opt-in through SQLWAYFARER_TEST_SQL (see AGENTS.md). Works in a scratch
// database that is dropped at the end.

const LIVE_CONFIG = process.env.SQLWAYFARER_TEST_SQL;
const DB = 'WayfarerInstanceTest';

suite('live SQL Server: instance tree actions', function () {
	this.timeout(60000);
	let live;
	let manager;
	let session;
	let posts;
	let handlers;
	let confirmed;

	const storage = () => ({
		getConnection: () => ({ name: 'live', server: live.server, authType: 'sql', username: live.user, database: 'master', encrypt: false, trustServerCertificate: true }),
		getConnectionPassword: async () => live.password
	});
	const exists = async name => (await manager.executeQuery(`SELECT OBJECT_ID(N'${DB}.${name}') AS id`)).recordset[0].id !== null;

	suiteSetup(async function () {
		if (!LIVE_CONFIG) return this.skip();
		live = JSON.parse(LIVE_CONFIG);
		manager = new ConnectionManager(storage());
		await manager.connectWithSaved('live');
		await manager.executeQuery(`IF DB_ID('${DB}') IS NOT NULL BEGIN ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DB}]; END; CREATE DATABASE [${DB}]`);
		session = new QuerySession(manager);
		posts = [];
		confirmed = [];
		handlers = new InstanceHandlers(m => posts.push(m), {
			databaseService: new DatabaseService(manager),
			connectionManager: manager,
			// The statement goes through the panel's session, like QueryHandlers.runStatement.
			query: { runStatement: async (db, sqlText) => (await session.get()).createRequest().batch(`USE [${db}];\n${sqlText}`) },
			ask: async () => 'Renamed',
			confirm: async (message, detail) => { confirmed.push(detail); return true; }
		});
	});
	setup(async () => {
		if (!manager) return;
		posts.length = 0;
		confirmed.length = 0;
		await manager.executeQuery(`USE [${DB}];
			IF OBJECT_ID('dbo.Child') IS NOT NULL DROP TABLE dbo.Child;
			IF OBJECT_ID('a.b') IS NOT NULL DROP TABLE a.b;
			IF SCHEMA_ID('a') IS NOT NULL DROP SCHEMA a;
			IF OBJECT_ID(N'dbo.[a.b]') IS NOT NULL DROP TABLE dbo.[a.b];
			IF OBJECT_ID('dbo.vUses') IS NOT NULL DROP VIEW dbo.vUses;
			IF OBJECT_ID('dbo.Renamed') IS NOT NULL DROP TABLE dbo.Renamed;
			IF OBJECT_ID('dbo.Victim') IS NOT NULL DROP TABLE dbo.Victim;
			IF OBJECT_ID(N'dbo.[we]]ird''name]') IS NOT NULL DROP TABLE dbo.[we]]ird'name];`);
		await manager.executeQuery(`USE [${DB}]; EXEC('CREATE TABLE dbo.Victim (id int PRIMARY KEY)'); EXEC('CREATE VIEW dbo.vUses AS SELECT id FROM dbo.Victim')`);
	});
	suiteTeardown(async () => {
		if (session) await session.dispose();
		if (!manager) return;
		try { await manager.executeQuery(`ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DB}]`); } catch { /* ignore */ }
		await manager.dispose();
	});

	test('the databases and the objects are listed, system databases left out', async () => {
		await handlers.handleGetInstanceDatabases();
		assert.ok(posts[0].databases.includes(DB));
		assert.ok(!posts[0].databases.includes('master'));
		await handlers.handleGetInstanceObjects(DB);
		const names = posts[1].objects.map(o => `${o.object_type}:${o.qualified_name}`).sort();
		assert.deepStrictEqual(names, ['Table:dbo.Victim', 'View:dbo.vUses']);
	});

	test('the objects that refer to one are found', async () => {
		assert.deepStrictEqual(await getDependents(manager, DB, 'dbo', 'Victim'), ['dbo.vUses']);
		assert.deepStrictEqual(await getDependents(manager, DB, 'dbo', 'vUses'), []);
	});

	test('rename: the table has the new name, and the confirmation had listed the view that refers to it', async () => {
		await handlers.handleRename(DB, 'dbo', 'Victim', 'Table');
		assert.ok(confirmed[0].includes('dbo.vUses'));
		assert.strictEqual(await exists('dbo.Victim'), false);
		assert.strictEqual(await exists('dbo.Renamed'), true);
		assert.deepStrictEqual(posts.map(p => p.command), ['instanceChanged']);
	});

	test('delete: the table is gone', async () => {
		await handlers.handleDrop(DB, 'dbo', 'vUses', 'View');
		assert.strictEqual(await exists('dbo.vUses'), false);
		assert.strictEqual(await exists('dbo.Victim'), true);
	});

	test('delete of a table a foreign key points to is refused by the server, and reported', async () => {
		await manager.executeQuery(`USE [${DB}]; EXEC('CREATE TABLE dbo.Child (id int, v int REFERENCES dbo.Victim(id))')`);
		await handlers.handleDrop(DB, 'dbo', 'Victim', 'Table');
		assert.strictEqual(posts[0].command, 'error');
		assert.strictEqual(await exists('dbo.Victim'), true);
	});

	test('a name with brackets and quotes is dealt with', async () => {
		await manager.executeQuery(`USE [${DB}]; EXEC('CREATE TABLE dbo.[we]]ird''name] (id int)')`);
		await handlers.handleDrop(DB, 'dbo', "we]ird'name", 'Table');
		assert.strictEqual(await exists("dbo.[we]]ird''name]"), false);
	});

	test('a table named with a dot is dropped, and the one it looks like is left', async () => {
		await manager.executeQuery(`USE [${DB}]; EXEC('CREATE SCHEMA a'); EXEC('CREATE TABLE a.b (id int)'); EXEC('CREATE TABLE dbo.[a.b] (id int)')`);
		await handlers.handleDrop(DB, 'dbo', 'a.b', 'Table');
		assert.strictEqual(await exists('dbo.[a.b]'), false);
		assert.strictEqual(await exists('a.b'), true);
		await manager.executeQuery(`USE [${DB}]; DROP TABLE a.b; DROP SCHEMA a`);
	});
});
