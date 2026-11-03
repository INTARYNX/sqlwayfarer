const assert = require('assert');
const ConnectionManager = require('../database/ConnectionManager');
const QueryHandlers = require('../panels/handlers/QueryHandlers');

// === Live: the editor's queries against a real SQL Server ===
//
// Opt-in through SQLWAYFARER_TEST_SQL (see AGENTS.md). It creates its own
// scratch database and drops it at the end.

const LIVE_CONFIG = process.env.SQLWAYFARER_TEST_SQL;
const DB = 'SqlWayfarerLiveQuery';

suite('live SQL Server: running a query from the editor', function () {
	this.timeout(60000);
	let manager;
	let handlers;
	let posts;

	const memento = { get: (k, d) => d, update: async () => {} };
	const run = async (sqlText, actualPlan = false) => {
		posts.length = 0;
		await handlers.handleExecuteQuery(DB, sqlText, 1000, actualPlan);
		return posts.find(p => p.command === 'queryResult' || p.command === 'queryError');
	};

	suiteSetup(async function () {
		if (!LIVE_CONFIG) return this.skip();
		const live = JSON.parse(LIVE_CONFIG);
		manager = new ConnectionManager({
			getConnection: () => ({ name: 'live', server: live.server, authType: 'sql', username: live.user, database: 'master', encrypt: false, trustServerCertificate: true }),
			getConnectionPassword: async () => live.password
		});
		await manager.connectWithSaved('live');
		await manager.executeQuery(`IF DB_ID('${DB}') IS NOT NULL BEGIN ALTER DATABASE ${DB} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${DB}; END; CREATE DATABASE ${DB}`);
	});
	setup(() => {
		if (!manager) return;
		posts = [];
		handlers = new QueryHandlers(m => posts.push(m), manager, memento);
	});
	teardown(async () => { if (handlers) await handlers.resetSession(); });
	suiteTeardown(async () => {
		if (!manager) return;
		try { await manager.executeQuery(`ALTER DATABASE ${DB} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${DB}`); } catch { /* ignore */ }
		await manager.dispose();
	});

	test('a CREATE PROCEDURE, VIEW, FUNCTION or TRIGGER runs as the first statement of its batch', async () => {
		await run('CREATE TABLE dbo.T (id int)');
		for (const create of [
			'CREATE PROCEDURE dbo.p AS SELECT 1 AS one',
			'CREATE VIEW dbo.v AS SELECT id FROM dbo.T',
			'CREATE FUNCTION dbo.f() RETURNS int AS BEGIN RETURN 1 END',
			'CREATE TRIGGER dbo.tr ON dbo.T AFTER INSERT AS SELECT 1'
		]) {
			const result = await run(create);
			assert.strictEqual(result.command, 'queryResult', `${create} -> ${result.message}`);
		}
		const objects = await run("SELECT name FROM sys.objects WHERE name IN ('p', 'v', 'f', 'tr')");
		assert.strictEqual(objects.resultSets[0].totalRows, 4);
	});

	test('the same, with the actual plan', async () => {
		const result = await run('CREATE OR ALTER PROCEDURE dbo.p AS SELECT 2 AS two', true);
		assert.strictEqual(result.command, 'queryResult', result.message);
		assert.strictEqual((await run('SELECT OBJECT_ID(\'dbo.p\') AS id')).resultSets[0].totalRows, 1);
	});

	test('a result set with no column name, or a name twice, keeps every value', async () => {
		const result = await run('SELECT COUNT(*), MAX(5), 1 AS id, 2 AS id FROM (VALUES (1), (2)) AS v(x)');
		assert.strictEqual(result.command, 'queryResult', result.message);
		const set = result.resultSets[0];
		assert.deepStrictEqual(set.columns, ['(No column name)', '(No column name) (2)', 'id', 'id (2)']);
		assert.deepStrictEqual(set.rows[0], { '(No column name)': 2, '(No column name) (2)': 5, id: 1, 'id (2)': 2 });
	});

	test('the types and the values of an ordinary result set are unchanged', async () => {
		const result = await run("SELECT CAST(1 AS int) AS n, N'x' AS s, CAST('2020-01-02' AS datetime) AS d, NULL AS z");
		const set = result.resultSets[0];
		assert.deepStrictEqual(set.columns, ['n', 's', 'd', 'z']);
		assert.deepStrictEqual(set.types.slice(0, 2).map(t => t.sql), ['int', 'nvarchar(1)']);
		assert.strictEqual(set.rows[0].n, 1);
		assert.strictEqual(set.rows[0].z, null);
	});

	test('the actual plan still comes back beside the results', async () => {
		const result = await run('SELECT name FROM sys.objects WHERE object_id = 3', true);
		assert.strictEqual(result.command, 'queryResult', result.message);
		assert.strictEqual(result.resultSets.length, 1);
		assert.strictEqual(result.planXmls.length, 1);
		assert.ok(result.planXmls[0].includes('ShowPlanXML'));
	});

	test('an error inside a procedure says which, an error of the script says its line', async () => {
		await run('CREATE OR ALTER PROCEDURE dbo.boom AS\nBEGIN\n SELECT 1;\n SELECT 1/0;\nEND');
		assert.strictEqual((await run('EXEC dbo.boom')).message, 'In dbo.boom, line 4: Divide by zero error encountered.');
		assert.strictEqual((await run('SELECT 1\n\nSELECT 1/0')).message, 'Line 3: Divide by zero error encountered.');
	});

	test('the query runs in the database chosen, and a missing one is an error without a line', async () => {
		assert.strictEqual((await run('SELECT DB_NAME() AS db')).resultSets[0].rows[0].db, DB);
		posts.length = 0;
		await handlers.handleExecuteQuery('NoSuchDatabase', 'SELECT 1', 1000);
		const error = posts.find(p => p.command === 'queryError');
		assert.ok(error && !/^Line \d+:/.test(error.message), error && error.message);
	});
});
