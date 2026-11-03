const assert = require('assert');
const ConnectionManager = require('../database/ConnectionManager');
const { QuerySession } = require('../database/QuerySession');

// === Live: a transaction a script leaves open stays on the session of its panel ===
//
// Opt-in through SQLWAYFARER_TEST_SQL (see AGENTS.md). The scratch table is
// in tempdb and dropped at the end.

const LIVE_CONFIG = process.env.SQLWAYFARER_TEST_SQL;
const TABLE = 'tempdb.dbo.sqlwf_tx_probe';

suite('live SQL Server: open transactions', function () {
	this.timeout(60000);
	let live;
	let manager; // the panel: its session and the pool of the Explorer
	let session;

	const storage = () => ({
		getConnection: () => ({ name: 'live', server: live.server, authType: 'sql', username: live.user, database: 'master', encrypt: false, trustServerCertificate: true }),
		getConnectionPassword: async () => live.password
	});
	// What the editor sends: one batch, on the session.
	const run = async sqlText => (await session.get()).createRequest().batch(sqlText);
	// What the Explorer sees: the pool, never the session.
	const outside = async () => (await manager.executeQuery(`SELECT COUNT(*) AS n FROM ${TABLE} WITH (NOLOCK)`)).recordset[0].n;

	suiteSetup(async function () {
		if (!LIVE_CONFIG) return this.skip();
		live = JSON.parse(LIVE_CONFIG);
		manager = new ConnectionManager(storage());
		await manager.connectWithSaved('live');
		await manager.executeQuery(`IF OBJECT_ID('${TABLE}') IS NOT NULL DROP TABLE ${TABLE}; CREATE TABLE ${TABLE} (id int)`);
	});
	setup(async () => { if (manager) session = new QuerySession(manager); });
	teardown(async () => { if (session) await session.dispose(); });
	suiteTeardown(async () => {
		if (!manager) return;
		try { await manager.executeQuery(`IF OBJECT_ID('${TABLE}') IS NOT NULL DROP TABLE ${TABLE}`); } catch { /* ignore */ }
		await manager.dispose();
	});

	test('BEGIN TRAN without COMMIT is not an error, and is counted', async () => {
		await run(`BEGIN TRAN; INSERT ${TABLE} VALUES (1)`);
		assert.strictEqual(await session.transactionCount(), 1);
	});

	test('the transaction stays on the session: the next run is in it, the pool is not', async () => {
		await run(`BEGIN TRAN; INSERT ${TABLE} VALUES (1)`);
		assert.strictEqual((await run('SELECT @@TRANCOUNT AS n')).recordset[0].n, 1);
		// The Explorer's connections are other ones: they do not run inside the transaction.
		const other = await manager.executeQuery('SELECT @@TRANCOUNT AS n');
		assert.strictEqual(other.recordset[0].n, 0);
	});

	test('rollback undoes the work, commit keeps it', async () => {
		await run(`DELETE ${TABLE}; BEGIN TRAN; INSERT ${TABLE} VALUES (1)`);
		assert.strictEqual(await session.end('rollback'), 0);
		assert.strictEqual(await outside(), 0);

		await run(`BEGIN TRAN; INSERT ${TABLE} VALUES (2)`);
		assert.strictEqual(await session.end('commit'), 0);
		assert.strictEqual(await outside(), 1);
	});

	test('nested levels are counted and all ended', async () => {
		await run(`DELETE ${TABLE}; BEGIN TRAN; BEGIN TRAN; INSERT ${TABLE} VALUES (3)`);
		assert.strictEqual(await session.transactionCount(), 2);
		assert.strictEqual(await session.end('commit'), 0);
		assert.strictEqual(await outside(), 1);
	});

	test('closing the session rolls back what is open, and releases its locks', async () => {
		await run(`DELETE ${TABLE}; BEGIN TRAN; INSERT ${TABLE} VALUES (4)`);
		await session.dispose();
		assert.strictEqual(await outside(), 0);
	});

	test('a script with no transaction reports none, and a temp table survives between runs', async () => {
		await run('CREATE TABLE #kept (id int); INSERT #kept VALUES (1)');
		assert.strictEqual((await run('SELECT COUNT(*) AS n FROM #kept')).recordset[0].n, 1);
		assert.strictEqual(await session.transactionCount(), 0);
	});
});
