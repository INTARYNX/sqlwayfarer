const assert = require('assert');
const DatabaseService = require('../database/DatabaseService');

// Type of the objects of a database. The Explorer index only covers the
// database being browsed, so a dependency pointing at ANOTHER database has no
// local type: it has to be asked for in the database that owns it.
//
// The unit tests use a fake connection manager. The live ones need a real SQL
// Server and are opt-in, see the SQLWAYFARER_TEST_SQL environment variable.

suite('DatabaseService.getObjectTypes', () => {
	function makeService(recordset, calls) {
		const connectionManager = {
			isConnected: () => true,
			executeQueryInDatabase: async (database, query, params) => {
				calls.push({ database, query, params });
				return { recordset };
			}
		};
		return new DatabaseService(connectionManager);
	}

	test('returns the type of each object, keyed by its lower-cased name', async () => {
		const calls = [];
		const service = makeService([
			{ qualified_name: 'dbo.Orders', object_type: 'Table' },
			{ qualified_name: 'Person.Person', object_type: 'Table' }
		], calls);

		const types = await service.getObjectTypes('OtherDb', ['dbo.Orders', 'person.person']);

		assert.deepStrictEqual(types, { 'dbo.orders': 'Table', 'person.person': 'Table' });
	});

	test('the query runs in the requested database', async () => {
		const calls = [];
		const service = makeService([], calls);

		await service.getObjectTypes('OtherDb', ['dbo.Orders']);

		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].database, 'OtherDb');
	});

	test('the names are passed as parameters, never in the SQL text', async () => {
		const calls = [];
		const service = makeService([], calls);

		await service.getObjectTypes('OtherDb', ["dbo.Orders'; DROP TABLE dbo.X --"]);

		assert.strictEqual(calls[0].query.includes('DROP TABLE'), false);
		assert.deepStrictEqual(calls[0].params, { n0: "dbo.Orders'; DROP TABLE dbo.X --" });
	});

	test('an object that does not exist there is simply absent', async () => {
		const calls = [];
		const service = makeService([{ qualified_name: 'dbo.Orders', object_type: 'Table' }], calls);

		const types = await service.getObjectTypes('OtherDb', ['dbo.Orders', 'dbo.Ghost']);

		assert.deepStrictEqual(types, { 'dbo.orders': 'Table' });
	});

	test('no name means no query at all', async () => {
		const calls = [];
		const service = makeService([], calls);

		const types = await service.getObjectTypes('OtherDb', []);

		assert.deepStrictEqual(types, {});
		assert.strictEqual(calls.length, 0);
	});

	test('without a connection it fails', async () => {
		const service = new DatabaseService({ isConnected: () => false });

		await assert.rejects(
			() => service.getObjectTypes('OtherDb', ['dbo.Orders']),
			/No active connection/
		);
	});
});

// === Live: against a real SQL Server ===
//
// Opt-in through the SQLWAYFARER_TEST_SQL environment variable, which holds
// the JSON connection of the server:
//   {"server":"localhost","user":"me","password":"...","database":"master",
//    "options":{"trustServerCertificate":true,"encrypt":false}}
// A SQL login is needed: the mssql driver cannot use the Windows token the
// way sqlcmd -E does.

const LIVE_CONFIG = process.env.SQLWAYFARER_TEST_SQL;
const SCRATCH_DB = 'sqlwf_test_object_types';

suite('DatabaseService.getObjectTypes (live SQL Server)', () => {
	let pool = null;

	// The scratch database holds one object of each type, so the mapping of
	// the type codes can be checked against the server itself.
	async function createScratchDatabase() {
		await pool.request().batch(`
			IF DB_ID('${SCRATCH_DB}') IS NOT NULL BEGIN
				ALTER DATABASE [${SCRATCH_DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
				DROP DATABASE [${SCRATCH_DB}];
			END
		`);
		await pool.request().batch(`CREATE DATABASE [${SCRATCH_DB}]`);

		const request = pool.request();
		request.database = SCRATCH_DB;
		await request.batch('CREATE TABLE dbo.LiveTable (Id int PRIMARY KEY)');
		await request.batch('CREATE VIEW dbo.LiveView AS SELECT Id FROM dbo.LiveTable');
		await request.batch('CREATE PROCEDURE dbo.LiveProc AS SELECT 1 AS Value');
	}

	// A connection manager on top of the real pool, with the same contract
	// as the one of the extension.
	function makeService() {
		const connectionManager = {
			isConnected: () => true,
			getServerName: () => pool.config.server,
			executeQuery: async (query, params = null) => {
				const request = pool.request();
				for (const [name, value] of Object.entries(params || {})) request.input(name, value);
				return await request.query(query);
			},
			executeQueryInDatabase: async (database, query, params = null) => {
				const request = pool.request();
				request.database = database;
				for (const [name, value] of Object.entries(params || {})) request.input(name, value);
				return await request.query(query);
			}
		};
		return new DatabaseService(connectionManager);
	}

	suiteSetup(async function () {
		if (!LIVE_CONFIG) this.skip();

		const sql = require('mssql');
		pool = await sql.connect(JSON.parse(LIVE_CONFIG));
		await createScratchDatabase();
	});

	suiteTeardown(async () => {
		if (!pool) return;
		await pool.request().batch(`
			IF DB_ID('${SCRATCH_DB}') IS NOT NULL BEGIN
				ALTER DATABASE [${SCRATCH_DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
				DROP DATABASE [${SCRATCH_DB}];
			END
		`).catch(() => { /* the scratch database stays behind: harmless */ });
		await pool.close();
		pool = null;
	});

	test('the type of a table, a view and a procedure is resolved', async () => {
		const service = makeService();

		const types = await service.getObjectTypes(
			SCRATCH_DB,
			['dbo.LiveTable', 'dbo.LiveView', 'dbo.LiveProc']
		);

		assert.deepStrictEqual(types, {
			'dbo.livetable': 'Table',
			'dbo.liveview': 'View',
			'dbo.liveproc': 'Procedure'
		});
	});

	test('an object missing from that database is absent', async () => {
		const service = makeService();

		const types = await service.getObjectTypes(SCRATCH_DB, ['dbo.LiveTable', 'dbo.Ghost']);

		assert.deepStrictEqual(types, { 'dbo.livetable': 'Table' });
	});
});
