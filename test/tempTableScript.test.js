const assert = require('assert');
const TempTableScript = require('../webview/tempTableScript');

const t = (sql, kind, nullable = true) => ({ sql, kind, nullable });

suite('TempTableScript.literal', () => {
	const lit = TempTableScript.literal;
	test('NULL, numbers, bit', () => {
		assert.strictEqual(lit(null, 'number'), 'NULL');
		assert.strictEqual(lit(undefined, 'string'), 'NULL');
		assert.strictEqual(lit(12.5, 'number'), '12.5');
		assert.strictEqual(lit(1e-7, 'number'), '1e-7');
		assert.strictEqual(lit('9007199254740993', 'number'), '9007199254740993');
		assert.strictEqual(lit(NaN, 'number'), 'NULL');
		assert.deepStrictEqual([lit(true, 'bit'), lit(false, 'bit'), lit(1, 'bit'), lit(0, 'bit')], ['1', '0', '1', '0']);
	});

	test('text is a unicode literal with its quotes doubled; a guid is plain', () => {
		assert.strictEqual(lit("O'Brien", 'string'), "N'O''Brien'");
		assert.strictEqual(lit('é\n--; DROP TABLE x', 'string'), "N'é\n--; DROP TABLE x'");
		assert.strictEqual(lit('9AF9A679-6E71-431F-ADA1-00AE21907605', 'guid'), "'9AF9A679-6E71-431F-ADA1-00AE21907605'");
	});

	test('dates come back as the stored value: no Z, offset +00:00 for datetimeoffset', () => {
		const iso = '2026-11-02T20:00:15.540Z';
		assert.strictEqual(lit(iso, 'datetime'), "'2026-11-02T20:00:15.540'");
		assert.strictEqual(lit(iso, 'date'), "'2026-11-02'");
		assert.strictEqual(lit('1970-01-01T20:00:15.540Z', 'time'), "'20:00:15.540'");
		assert.strictEqual(lit(iso, 'datetimeoffset'), "'2026-11-02T20:00:15.540+00:00'");
	});

	test('binary is hexadecimal, empty included', () => {
		assert.strictEqual(lit({ type: 'Buffer', data: [1, 2, 255] }, 'binary'), '0x0102ff');
		assert.strictEqual(lit({ type: 'Buffer', data: [] }, 'binary'), '0x');
	});

	test('unsupported types are NULL, and a value that does not fit its kind is written as text', () => {
		assert.strictEqual(lit({ srid: 4326 }, 'unsupported'), 'NULL');
		assert.strictEqual(lit('not a date', 'date'), "N'not a date'");
		assert.strictEqual(lit({ a: 1 }, 'string'), "N'{\"a\":1}'");
	});
});

suite('TempTableScript.build', () => {
	const set = {
		columns: ['id', 'na]me', ''],
		types: [t('int', 'number', false), t('nvarchar(50)', 'string'), t('datetime', 'datetime')],
		rows: [{ id: 1, 'na]me': "it's", '': '2026-01-02T03:04:05.000Z' }, { id: 2, 'na]me': null, '': null }],
		totalRows: 2
	};

	test('creates the table with the real types and inserts the rows', () => {
		assert.strictEqual(TempTableScript.build(set), [
			'-- Result set scripted as a temp table (2 row(s)).',
			"IF OBJECT_ID('tempdb..#Results') IS NOT NULL DROP TABLE #Results;",
			'CREATE TABLE #Results (',
			'    [id] int NOT NULL,',
			'    [na]]me] nvarchar(50) NULL,',
			'    [Column3] datetime NULL',
			');',
			'GO',
			'',
			'INSERT INTO #Results ([id], [na]]me], [Column3]) VALUES',
			"(1, N'it''s', '2026-01-02T03:04:05.000'),",
			'(2, NULL, NULL);',
			'',
			'GO',
			'SELECT * FROM #Results;',
			''
		].join('\n'));
	});

	test('rows go by 1000 per INSERT', () => {
		const rows = Array.from({ length: 2500 }, (_, i) => ({ id: i }));
		const script = TempTableScript.build({ columns: ['id'], types: [t('int', 'number')], rows, totalRows: 2500 });
		assert.strictEqual((script.match(/^INSERT INTO/gm) || []).length, 3);
		assert.strictEqual((script.match(/^\(\d+\)[,;]$/gm) || []).length, 2500);
		assert.strictEqual((script.match(/;$/gm) || []).length, 3 + 3, 'DROP, CREATE end, 3 INSERTs, SELECT');
		assert.strictEqual((script.match(/^GO$/gm) || []).length, 2, 'the table is created, filled and read in three batches');
	});

	test('an empty result is only the table; fetched rows fewer than the total, and unsupported columns, are said', () => {
		const empty = TempTableScript.build({ columns: ['a'], types: [t('int', 'number')], rows: [], totalRows: 0 });
		assert.ok(!/INSERT/.test(empty) && /CREATE TABLE #Results/.test(empty));
		const partial = TempTableScript.build({ columns: ['a', 'geo'], types: [t('int', 'number'), t('nvarchar(max)', 'unsupported')], rows: [{ a: 1, geo: { x: 1 } }], totalRows: 5000 });
		assert.ok(/Only the first 1 of 5000 rows/.test(partial));
		assert.ok(/Not scripted, NULL instead: \[geo\]/.test(partial));
		assert.ok(/\(1, NULL\);/.test(partial));
	});

	test('without column types, they are inferred from the values', () => {
		const script = TempTableScript.build({ columns: ['n', 'f', 'b', 's'], rows: [{ n: 1, f: 1.5, b: true, s: 'x' }], totalRows: 1 });
		assert.ok(/\[n\] bigint NULL,\n    \[f\] float NULL,\n    \[b\] bit NULL,\n    \[s\] nvarchar\(max\) NULL/.test(script));
	});

	test('the temp table of the n-th result set', () => {
		assert.deepStrictEqual([TempTableScript.tableName(0), TempTableScript.tableName(1)], ['#Results', '#Results2']);
		assert.ok(/CREATE TABLE #Results2/.test(TempTableScript.build(set, '#Results2')));
	});
});
