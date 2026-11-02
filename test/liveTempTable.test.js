const assert = require('assert');
const TempTableScript = require('../webview/tempTableScript');
const { describeColumn } = require('../database/columnTypes');

// === Live: a result set scripted as a temp table gives the same rows back ===
//
// Opt-in through SQLWAYFARER_TEST_SQL (see AGENTS.md). Everything happens in
// temp tables of one session, nothing is left on the server.

const LIVE_CONFIG = process.env.SQLWAYFARER_TEST_SQL;

suite('live SQL Server: result set as a temp table', function () {
	this.timeout(60000);
	let pool;

	suiteSetup(async function () {
		if (!LIVE_CONFIG) return this.skip();
		const sql = require('mssql');
		// One connection: the temp tables live in its session.
		pool = await new sql.ConnectionPool(Object.assign({}, JSON.parse(LIVE_CONFIG), { database: 'master', pool: { max: 1, min: 1 } })).connect();
	});
	suiteTeardown(async () => { if (pool) await pool.close(); });

	// What the editor does with GO: one batch after the other, on the same session.
	async function run(script) {
		for (const batch of script.split(/^GO$/m)) if (batch.trim()) await pool.request().batch(batch);
	}

	// Like the grid gets it: described columns, rows through JSON.
	async function fetchSet(query) {
		const request = pool.request();
		request.stream = true;
		const set = { columns: [], types: [], rows: [], totalRows: 0 };
		request.on('recordset', columns => {
			set.columns = Object.keys(columns);
			set.types = set.columns.map(key => describeColumn(columns[key]));
		});
		request.on('row', row => { set.totalRows++; set.rows.push(JSON.parse(JSON.stringify(row))); });
		await new Promise((resolve, reject) => { request.on('done', resolve); request.on('error', reject); request.query(query); });
		return set;
	}

	// (The driver hands decimals over as JS numbers: past 15 significant digits, a result set itself is rounded.)
	test('every kind of column comes back identical, NULLs, quotes and unicode included', async () => {
		await pool.request().batch(`
			IF OBJECT_ID('tempdb..#Source') IS NOT NULL DROP TABLE #Source;
			SELECT * INTO #Source FROM (VALUES
				(CAST(1 AS int), CAST(9223372036854775807 AS bigint), CAST(-12345.67 AS decimal(10,2)), CAST(1.1 AS float), CAST(1 AS bit),
				 CAST('plain' AS varchar(50)), CAST(N'héllo wörld ✓' AS nvarchar(50)), CAST(REPLICATE(N'x', 5000) AS nvarchar(max)), CAST('ab' AS char(4)),
				 CAST('2026-11-02T20:00:15.540' AS datetime), CAST('2026-11-02T20:00:15.123' AS datetime2(3)), CAST('2026-11-02' AS date), CAST('20:00:15.123' AS time(3)),
				 CAST('2026-11-02T20:00:15.123+00:00' AS datetimeoffset(3)), CAST('9AF9A679-6E71-431F-ADA1-00AE21907605' AS uniqueidentifier),
				 CAST(0x0102FF AS varbinary(10)), CAST(0x01 AS binary(2)), CAST(12.5 AS money), CAST('<a x="1"/>' AS xml), CAST(255 AS tinyint), CAST(-5 AS smallint), CAST(1.5 AS real)),
				(2, -1, 0, -0.5, 0, '', N'', N'', '', '1753-01-01T00:00:00', '0001-01-01T00:00:00', '0001-01-01', '00:00:00', '0001-01-01T00:00:00+00:00', NEWID(), 0x, 0x00, 0, '<b/>', 0, 0, 0),
				(3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
				(4, 0, 99999999.99, 1e300, 1, 'O''Brien -- ; DROP TABLE x', N'line1' + CHAR(13) + CHAR(10) + N'line2 ''q''', N'[brackets] "double"', 'ü', '9999-12-31T23:59:59.997', '9999-12-31T23:59:59.999', '9999-12-31', '23:59:59.999', '9999-12-31T23:59:59.999+00:00', NEWID(), 0xDEADBEEF, 0xFF, -12345678.9012, '<c>text &amp; more</c>', 1, 32767, 3.4E38)
			) AS v(id, bi, d, f, b, v, nv, nvm, c, dt, dt2, dd, t, dto, g, vb, bn, m, x, ti, si, rl);`);
		const set = await fetchSet('SELECT * FROM #Source ORDER BY id');
		assert.strictEqual(set.rows.length, 4);

		const script = TempTableScript.build(set);
		await run(script);

		// Same rows, both ways (xml is compared as text).
		const columns = set.columns.map(c => (c === 'x' ? 'CAST(x AS nvarchar(max)) AS x' : `[${c}]`)).join(', ');
		const diff = await pool.request().batch(`
			SELECT (SELECT COUNT(*) FROM (SELECT ${columns} FROM #Source EXCEPT SELECT ${columns} FROM #Results) a) AS missing,
			       (SELECT COUNT(*) FROM (SELECT ${columns} FROM #Results EXCEPT SELECT ${columns} FROM #Source) b) AS extra,
			       (SELECT COUNT(*) FROM #Results) AS n`);
		assert.deepStrictEqual(diff.recordset[0], { missing: 0, extra: 0, n: 4 });

		// The columns got the same types.
		const types = await pool.request().batch(`
			SELECT c.name, TYPE_NAME(c.user_type_id) AS t, c.max_length, c.precision, c.scale
			FROM tempdb.sys.columns c WHERE c.object_id = OBJECT_ID('tempdb..#Results')
			EXCEPT
			SELECT c.name, TYPE_NAME(c.user_type_id), c.max_length, c.precision, c.scale
			FROM tempdb.sys.columns c WHERE c.object_id = OBJECT_ID('tempdb..#Source')`);
		assert.deepStrictEqual(types.recordset, [], 'same types, lengths, precisions and scales');
	});

	test('more than 1000 rows, and a script run twice', async () => {
		const set = await fetchSet('SELECT TOP (2500) CAST(ROW_NUMBER() OVER (ORDER BY (SELECT 1)) AS int) AS n, CAST(NEWID() AS varchar(36)) AS g FROM sys.all_objects a CROSS JOIN sys.all_objects b');
		assert.strictEqual(set.rows.length, 2500);
		const script = TempTableScript.build(set);
		await run(script);
		await run(script);
		const count = await pool.request().batch('SELECT COUNT(*) AS n, COUNT(DISTINCT n) AS d FROM #Results');
		assert.deepStrictEqual(count.recordset[0], { n: 2500, d: 2500 });
	});

	test('a geography column is NULL and said so, the rest is kept', async () => {
		const set = await fetchSet("SELECT CAST(1 AS int) AS id, geography::Point(1, 1, 4326) AS geo, hierarchyid::GetRoot() AS h");
		const script = TempTableScript.build(set);
		assert.ok(/Not scripted, NULL instead: \[geo\], \[h\]/.test(script));
		await run(script);
		const row = await pool.request().batch('SELECT id, geo, h FROM #Results');
		assert.deepStrictEqual([row.recordset[0].id, row.recordset[0].geo, row.recordset[0].h], [1, null, null]);
	});
});
