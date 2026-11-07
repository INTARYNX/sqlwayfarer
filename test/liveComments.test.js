const assert = require('assert');
const ConnectionManager = require('../database/ConnectionManager');
const CommentsService = require('../database/CommentsService');

// === Live: the descriptions of a table are the ones of its columns, not of its indexes ===
//
// Opt-in through SQLWAYFARER_TEST_SQL (see AGENTS.md). It creates its own
// scratch database and drops it at the end. An index can carry a description
// like a column does (AdventureWorks describes its indexes): index 1 must not
// be read as column 1.

const LIVE_CONFIG = process.env.SQLWAYFARER_TEST_SQL;
const DB = 'SqlWayfarerLiveComments';

suite('live SQL Server: descriptions of columns and of indexes', function () {
	this.timeout(60000);
	let manager;
	let service;

	suiteSetup(async function () {
		if (!LIVE_CONFIG) return this.skip();
		const live = JSON.parse(LIVE_CONFIG);
		manager = new ConnectionManager({
			getConnection: () => ({ name: 'live', server: live.server, authType: 'sql', username: live.user, database: 'master', encrypt: false, trustServerCertificate: true }),
			getConnectionPassword: async () => live.password
		});
		await manager.connectWithSaved('live');
		await manager.executeQuery(`IF DB_ID('${DB}') IS NOT NULL BEGIN ALTER DATABASE ${DB} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${DB}; END; CREATE DATABASE ${DB}`);
		await manager.executeQuery(`USE ${DB}; EXEC('CREATE TABLE dbo.T (id int CONSTRAINT PK_T PRIMARY KEY, name nvarchar(20), other int)')`);
		await manager.executeQuery(`USE ${DB}; EXEC('CREATE INDEX IX_T_name ON dbo.T (name)')`);
		await manager.executeQuery(`USE ${DB};
			EXEC sp_addextendedproperty N'MS_Description', N'the key', N'SCHEMA', N'dbo', N'TABLE', N'T', N'COLUMN', N'id';
			EXEC sp_addextendedproperty N'MS_Description', N'clustered index of the key', N'SCHEMA', N'dbo', N'TABLE', N'T', N'INDEX', N'PK_T';
			EXEC sp_addextendedproperty N'MS_Description', N'index on the name', N'SCHEMA', N'dbo', N'TABLE', N'T', N'INDEX', N'IX_T_name'`);
		service = new CommentsService(manager);
	});
	suiteTeardown(async () => {
		if (!manager) return;
		try { await manager.executeQuery(`USE master; ALTER DATABASE ${DB} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${DB}`); } catch { /* ignore */ }
		await manager.dispose();
	});

	test('a column is listed once, with its own description', async () => {
		const result = await service.getTableExtendedProperties(DB, 'dbo.T');
		assert.deepStrictEqual(result.allColumns.map(c => c.columnName), ['id', 'name', 'other']);
		assert.deepStrictEqual(result.columnDescriptions.map(c => [c.columnName, c.description]), [['id', 'the key']]);
	});

	test('a column that only has an index of the same number is not described', async () => {
		const result = await service.getTableExtendedProperties(DB, 'dbo.T');
		const name = result.allColumns.find(c => c.columnName === 'name');
		assert.strictEqual(name.hasDescription, false, 'index 2 has a description, column "name" (2) has none');
	});

	test('describing a column that only an index of the same number has adds it instead of failing', async () => {
		const result = await service.updateColumnDescription(DB, 'dbo.T', 'name', 'the name');
		assert.strictEqual(result.success, true, result.message);
		const after = await service.getTableExtendedProperties(DB, 'dbo.T');
		assert.deepStrictEqual(after.columnDescriptions.map(c => [c.columnName, c.description]), [['id', 'the key'], ['name', 'the name']]);
	});
});
