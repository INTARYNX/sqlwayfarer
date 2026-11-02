const assert = require('assert');
const ConnectionManager = require('../database/ConnectionManager');
const ConnectionImportHandlers = require('../panels/handlers/ConnectionImportHandlers');
const { readCmsServers } = require('../database/cmsImport');

// === Live: reading a Central Management Server ===
//
// Opt-in through SQLWAYFARER_TEST_SQL (see AGENTS.md). Any SQL Server is a CMS:
// the registered servers live in msdb. The suite adds a few groups and servers
// through the msdb procedures SSMS itself calls, reads them back, and removes
// them in its teardown.

const LIVE_CONFIG = process.env.SQLWAYFARER_TEST_SQL;
const ROOT_GROUP = 'sqlwf_cms_test';

suite('live SQL Server: Central Management Server import', function () {
	this.timeout(60000);
	let manager;
	let live;
	let rootId;

	const savedConnection = () => ({
		name: 'live-cms', server: live.server, authType: 'sql', username: live.user,
		database: 'master', encrypt: false, trustServerCertificate: true
	});
	const storage = () => ({
		getConnection: () => savedConnection(),
		getConnectionPassword: async () => live.password,
		getSavedConnections: () => [savedConnection()],
		saveConnection: async () => ({ success: true })
	});

	async function addGroup(name, parentId) {
		const r = await manager.executeQuery(`DECLARE @id int; EXEC msdb.dbo.sp_sysmanagement_add_shared_server_group @parent_id = ${parentId}, @name = N'${name}', @description = N'', @server_type = 0, @server_group_id = @id OUTPUT; SELECT @id AS id`);
		return r.recordset[0].id;
	}
	async function addServer(name, groupId, address) {
		await manager.executeQuery(`DECLARE @id int; EXEC msdb.dbo.sp_sysmanagement_add_shared_registered_server @name = N'${name}', @server_group_id = ${groupId}, @server_name = N'${address}', @description = N'about ${name}', @server_type = 0, @server_id = @id OUTPUT`);
	}

	suiteSetup(async function () {
		if (!LIVE_CONFIG) return this.skip();
		live = JSON.parse(LIVE_CONFIG);
		manager = new ConnectionManager(storage());
		await manager.connectWithSaved('live-cms');
		await cleanup();
		rootId = await addGroup(ROOT_GROUP, 1);
		const europe = await addGroup('Europe', rootId);
		await addServer('Paris', europe, 'paris-sql,14330');
		await addServer('Lyon', europe, 'lyon-sql\\INST1');
		await addServer('Top', rootId, 'top-sql');
	});

	// Servers first, then the groups, deepest first.
	async function cleanup() {
		await manager.executeQuery(`
			DECLARE @ids TABLE (id int);
			WITH g AS (SELECT server_group_id FROM msdb.dbo.sysmanagement_shared_server_groups WHERE name = N'${ROOT_GROUP}' AND parent_id = 1
				UNION ALL SELECT c.server_group_id FROM msdb.dbo.sysmanagement_shared_server_groups c JOIN g ON c.parent_id = g.server_group_id)
			INSERT @ids SELECT server_group_id FROM g;
			DECLARE @sid int;
			WHILE EXISTS (SELECT 1 FROM msdb.dbo.sysmanagement_shared_registered_servers WHERE server_group_id IN (SELECT id FROM @ids))
			BEGIN
				SELECT TOP 1 @sid = server_id FROM msdb.dbo.sysmanagement_shared_registered_servers WHERE server_group_id IN (SELECT id FROM @ids);
				EXEC msdb.dbo.sp_sysmanagement_delete_shared_registered_server @server_id = @sid;
			END
			DECLARE @gid int;
			WHILE EXISTS (SELECT 1 FROM @ids)
			BEGIN
				SELECT TOP 1 @gid = i.id FROM @ids i WHERE NOT EXISTS (SELECT 1 FROM msdb.dbo.sysmanagement_shared_server_groups c WHERE c.parent_id = i.id);
				EXEC msdb.dbo.sp_sysmanagement_delete_shared_server_group @server_group_id = @gid;
				DELETE @ids WHERE id = @gid;
			END`);
	}

	suiteTeardown(async () => {
		if (!manager || !manager.isConnected()) return;
		try { await cleanup(); } finally { await manager.dispose(); }
	});

	test('the registered servers and their groups are read back from msdb', async () => {
		const mine = (await readCmsServers(manager)).filter(e => e.group.startsWith(ROOT_GROUP));
		const byName = Object.fromEntries(mine.map(e => [e.name, e]));
		assert.deepStrictEqual(Object.keys(byName).sort(), ['Lyon', 'Paris', 'Top']);
		assert.deepStrictEqual([byName.Paris.server, byName.Paris.port, byName.Paris.group], ['paris-sql', '14330', `${ROOT_GROUP}/Europe`]);
		assert.deepStrictEqual([byName.Lyon.server, byName.Lyon.port], ['lyon-sql\\INST1', '']);
		assert.deepStrictEqual([byName.Top.group, byName.Top.description], [ROOT_GROUP, 'about Top']);
	});

	test('the whole import, through a real connection: read, offer, save', async () => {
		const saved = [];
		const handlers = new ConnectionImportHandlers(() => {}, Object.assign(storage(), { saveConnection: async config => { saved.push(config); return { success: true }; } }), {
			createManager: () => new ConnectionManager(storage()),
			ui: {
				pickSource: async () => 'cms',
				pickCmsConnection: async () => 'live-cms',
				pickEntries: async plan => plan.filter(p => p.entry.group.startsWith(ROOT_GROUP)),
				info() {}, error(message) { throw new Error(message); }
			}
		});
		await handlers.handleImportConnections();
		assert.deepStrictEqual(saved.map(s => s.name).sort(), ['Lyon', 'Paris', 'Top']);
		assert.ok(saved.every(s => s.authType === 'windows' && !('password' in s)));
	});

	test('a login without access to msdb gets an explanation, not a crash', async () => {
		const login = 'sqlwf_cms_nobody';
		await manager.executeQuery(`IF SUSER_ID('${login}') IS NOT NULL DROP LOGIN ${login}; CREATE LOGIN ${login} WITH PASSWORD = N'Wayfarer!Nobody2026x', CHECK_POLICY = OFF`);
		try {
			const messages = [];
			const handlers = new ConnectionImportHandlers(() => {}, Object.assign(storage(), {
				getConnection: () => Object.assign(savedConnection(), { username: login }),
				getConnectionPassword: async () => 'Wayfarer!Nobody2026x'
			}), {
				createManager: () => new ConnectionManager(Object.assign(storage(), { getConnection: () => Object.assign(savedConnection(), { username: login }), getConnectionPassword: async () => 'Wayfarer!Nobody2026x' })),
				ui: { pickSource: async () => 'cms', pickCmsConnection: async () => 'live-cms', pickEntries: async () => [], info() {}, error: m => messages.push(m) }
			});
			await handlers.handleImportConnections();
			assert.strictEqual(messages.length, 1);
			assert.ok(/Could not read the Central Management Server/.test(messages[0]), messages[0]);
		} finally {
			await manager.executeQuery(`DROP LOGIN ${login}`);
		}
	});
});
