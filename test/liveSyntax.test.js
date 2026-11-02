const assert = require('assert');
const ConnectionManager = require('../database/ConnectionManager');
const { SyntaxChecker } = require('../database/SyntaxChecker');

// === Live: the syntax check by SQL Server itself ===
//
// Opt-in through SQLWAYFARER_TEST_SQL (see AGENTS.md). The point of the suite
// is as much what must NOT happen: nothing the checked text says is ever run.

const LIVE_CONFIG = process.env.SQLWAYFARER_TEST_SQL;
const PROBE = 'tempdb.dbo.sqlwf_syntax_probe';

suite('live SQL Server: syntax check', function () {
	this.timeout(60000);
	let live;
	let checker;
	let other; // the connection the user's queries run on

	const storage = () => ({
		getConnection: () => ({ name: 'live', server: live.server, authType: 'sql', username: live.user, database: 'master', encrypt: false, trustServerCertificate: true }),
		getConnectionPassword: async () => live.password
	});
	const exists = async () => (await other.executeQuery(`SELECT OBJECT_ID('${PROBE}') AS id`)).recordset[0].id !== null;

	suiteSetup(async function () {
		if (!LIVE_CONFIG) return this.skip();
		live = JSON.parse(LIVE_CONFIG);
		other = new ConnectionManager(storage());
		await other.connectWithSaved('live');
		await other.executeQuery(`IF OBJECT_ID('${PROBE}') IS NOT NULL DROP TABLE ${PROBE}`);
		checker = new SyntaxChecker({ createManager: () => new ConnectionManager(storage()), getConnectionName: () => 'live' });
	});
	suiteTeardown(async () => {
		if (checker) await checker.dispose();
		if (other && other.isConnected()) {
			try { await other.executeQuery(`IF OBJECT_ID('${PROBE}') IS NOT NULL DROP TABLE ${PROBE}`); } catch { /* its session may have been killed by the last test */ }
			await other.dispose();
		}
	});

	test('valid T-SQL gives nothing, even for objects that do not exist', async () => {
		assert.deepStrictEqual(await checker.check('SELECT a, b FROM dbo.NoSuchTable WHERE c = 1;\nGO\nEXEC dbo.NoSuchProc @x = 1'), []);
		assert.deepStrictEqual(await checker.check('WITH c AS (SELECT 1 AS n) SELECT n FROM c;\nDECLARE @t TABLE (a int); INSERT @t VALUES (1);'), []);
	});

	test('an error comes with its line, on the lines of the whole script', async () => {
		const diagnostics = await checker.check('SELECT 1\nGO\nSELECT a,\nFROM t\nGO\nSELECT 2 FROM');
		assert.deepStrictEqual(diagnostics.map(d => [d.line, d.near]), [[4, 'FROM'], [6, 'FROM']]);
		assert.ok(/Incorrect syntax near the keyword 'FROM'/.test(diagnostics[0].message));
	});

	test('several errors, and an unclosed quote', async () => {
		const diagnostics = await checker.check("SELECT 1 FROM\nSELECT 2 FROM\nWHERE (\nGO\nSELECT 'abc");
		assert.deepStrictEqual(diagnostics.map(d => d.line), [2, 3, 5]);
		assert.ok(diagnostics.some(d => /Unclosed quotation mark/.test(d.message)));
	});

	test('nothing the text says is run: a valid CREATE TABLE leaves no table', async () => {
		assert.deepStrictEqual(await checker.check(`CREATE TABLE ${PROBE} (a int);\nINSERT ${PROBE} VALUES (1);`), []);
		assert.strictEqual(await exists(), false);
	});

	test('a text that tries to switch the check off is not sent, and runs nothing', async () => {
		assert.deepStrictEqual(await checker.check(`SET PARSEONLY OFF;\nCREATE TABLE ${PROBE} (a int);`), []);
		assert.strictEqual(await exists(), false, 'the table must not exist');
		// and the check still works after it
		assert.strictEqual((await checker.check('SELECT FROM')).length, 1);
		assert.strictEqual(await exists(), false);
	});

	test('the connection the queries run on is not touched', async () => {
		await checker.check('SELECT 1');
		const real = await other.executeQuery('SELECT 42 AS answer');
		assert.strictEqual(real.recordset[0].answer, 42, 'a query on the other connection still runs');
	});

	test('a session the server dropped is replaced by the check itself', async () => {
		await checker.check('SELECT 1');
		// The server drops the session under the checker.
		// (Only this process's other sessions: the checker's own.)
		await other.executeQuery(`DECLARE @s nvarchar(max) = N''; SELECT @s += N'KILL ' + CAST(session_id AS nvarchar(10)) + N';' FROM sys.dm_exec_sessions WHERE is_user_process = 1 AND session_id <> @@SPID AND host_process_id = ${process.pid}; EXEC (@s)`);
		assert.deepStrictEqual(await checker.check('SELECT 1'), [], 'the check goes on, on a new session');
		assert.deepStrictEqual(await checker.check('SELECT FROM').then(d => d.length), 1);
	});
});
