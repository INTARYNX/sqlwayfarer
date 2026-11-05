const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const ConnectionManager = require('../database/ConnectionManager');
const DatabaseService = require('../database/DatabaseService');
const IndexService = require('../database/IndexServices');
const WriteFootprintService = require('../database/WriteFootprintService');

// === Live: the write footprint follows the triggers that fire on the kind of write ===
//
// Opt-in through SQLWAYFARER_TEST_SQL (see AGENTS.md). It creates its own
// scratch database and drops it at the end.

const LIVE_CONFIG = process.env.SQLWAYFARER_TEST_SQL;
const DB = 'SqlWayfarerLiveFootprint';

suite('live SQL Server: write footprint and triggers', function () {
	this.timeout(120000);
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
		await manager.executeQuery(`IF DB_ID('${DB}') IS NOT NULL BEGIN ALTER DATABASE ${DB} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${DB}; END; CREATE DATABASE ${DB}`);
		const conn = await manager.acquireConnection();
		const run = async sql => { await conn.createRequest().batch(`USE ${DB}`); await conn.createRequest().batch(sql); };
		await run('CREATE TABLE dbo.T (id int PRIMARY KEY, v int)');
		await run('CREATE TABLE dbo.Audit (id int, what nvarchar(10))');
		await run("CREATE TRIGGER dbo.trgT ON dbo.T AFTER INSERT AS INSERT dbo.Audit SELECT id, N'insert' FROM inserted");
		await run('CREATE PROCEDURE dbo.pDelete AS DELETE FROM dbo.T WHERE id = 1');
		await run('CREATE PROCEDURE dbo.pInsert AS INSERT dbo.T (id, v) VALUES (1, 1)');
		await run('CREATE TYPE dbo.Flag FROM bit NOT NULL');
		await run('CREATE PROCEDURE dbo.pTyped @f dbo.Flag AS INSERT dbo.T (id, v) VALUES (3, @f)');
		await run('CREATE PROCEDURE dbo.pBoth AS BEGIN INSERT dbo.T (id, v) VALUES (2, 2); DELETE FROM dbo.T WHERE id = 2; END');
		conn.release();
		const databaseService = new DatabaseService(manager);
		indexService = new IndexService(manager, databaseService);
		indexDir = path.join(os.tmpdir(), `sqlwayfarer-live-fp-${Date.now()}`);
		indexService._indexDir = indexDir;
		await indexService.forceReindex(DB);
		footprint = new WriteFootprintService(manager, indexService, databaseService);
	});
	suiteTeardown(async () => {
		if (indexService) await indexService.dispose();
		if (indexDir) await fs.rm(indexDir, { recursive: true, force: true }).catch(() => {});
		if (!manager) return;
		try { await manager.executeQuery(`ALTER DATABASE ${DB} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${DB}`); } catch { /* ignore */ }
		await manager.dispose();
	});

	const touched = result => result.tables.map(t => `${t.qualifiedName}:${t.access}${t.viaTriggerOnly ? ':trigger' : ''}`);

	test('a procedure that only deletes does not reach what an AFTER INSERT trigger writes', async () => {
		const result = await footprint.analyze(DB, 'dbo.pDelete');
		assert.deepStrictEqual(result.triggersFired, []);
		assert.deepStrictEqual(touched(result), ['dbo.T:write']);
	});

	test('a procedure that inserts does, and the audit table is reached through the trigger', async () => {
		const result = await footprint.analyze(DB, 'dbo.pInsert');
		assert.deepStrictEqual(result.triggersFired, ['dbo.trgT']);
		assert.deepStrictEqual(touched(result), ['dbo.Audit:write:trigger', 'dbo.T:write']);
	});

	test('a procedure that does both fires it', async () => {
		assert.deepStrictEqual((await footprint.analyze(DB, 'dbo.pBoth')).triggersFired, ['dbo.trgT']);
	});

	test('the kinds of write are in the index', async () => {
		const index = await indexService.peekIndex(DB);
		assert.deepStrictEqual(index.objects['dbo.pDelete'].tableWriteOps, { 'dbo.t': ['delete'] });
		assert.deepStrictEqual(index.objects['dbo.pBoth'].tableWriteOps, { 'dbo.t': ['delete', 'insert'] });
	});

	test('a user-defined type a procedure uses is not reported as an unresolved reference', async () => {
		const result = await footprint.analyze(DB, 'dbo.pTyped');
		assert.deepStrictEqual(result.unresolved, []);
		assert.deepStrictEqual(touched(result), ['dbo.Audit:write:trigger', 'dbo.T:write']);
	});
});
