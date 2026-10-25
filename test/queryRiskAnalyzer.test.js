const assert = require('assert');
const BabelfishSqlParser = require('../database/BabelfishSqlParser');
const QueryRiskAnalyzer = require('../database/QueryRiskAnalyzer');

suite('QueryRiskAnalyzer with the T-SQL parser', () => {
	const parser = new BabelfishSqlParser();
	parser.setEnabled(true);
	const analyzer = new QueryRiskAnalyzer(parser);

	test('flags UPDATE without WHERE, naming the target table', () => {
		const risks = analyzer.analyze('UPDATE dbo.Customer SET Active = 0');
		assert.strictEqual(risks.length, 1);
		assert.ok(risks[0].includes('UPDATE without WHERE'), risks[0]);
		assert.ok(risks[0].includes('dbo.Customer'), risks[0]);
	});

	test('UPDATE with WHERE is not flagged', () => {
		assert.deepStrictEqual(analyzer.analyze('UPDATE dbo.Customer SET Active = 0 WHERE ID = 3'), []);
	});

	test('flags DELETE without WHERE', () => {
		const risks = analyzer.analyze('DELETE FROM dbo.AuditLog');
		assert.strictEqual(risks.length, 1);
		assert.ok(risks[0].includes('DELETE without WHERE'), risks[0]);
	});

	test('SELECT and INSERT are not flagged', () => {
		assert.deepStrictEqual(
			analyzer.analyze('SELECT * FROM T; INSERT INTO T (a) VALUES (1);'),
			[]
		);
	});

	test('only the unsafe statement of a batch is flagged', () => {
		const risks = analyzer.analyze('UPDATE A SET x = 1 WHERE id = 2; DELETE FROM B;');
		assert.strictEqual(risks.length, 1);
		assert.ok(risks[0].startsWith('DELETE'), risks[0]);
	});

	test('flags TRUNCATE TABLE and DROP', () => {
		const risks = analyzer.analyze('TRUNCATE TABLE dbo.Staging; DROP TABLE dbo.Old;');
		assert.strictEqual(risks.length, 2);
		assert.ok(risks.some(r => /truncate table dbo.Staging/i.test(r)), risks.join());
		assert.ok(risks.some(r => /drop table dbo.Old/i.test(r)), risks.join());
	});
});

suite('QueryRiskAnalyzer regex fallback (no parser)', () => {
	const analyzer = new QueryRiskAnalyzer(null);

	test('still flags UPDATE without WHERE', () => {
		const risks = analyzer.analyze('UPDATE Customer SET Active = 0');
		assert.strictEqual(risks.length, 1);
		assert.ok(risks[0].includes('UPDATE without WHERE'));
	});

	test('does not flag UPDATE with WHERE', () => {
		assert.deepStrictEqual(analyzer.analyze('UPDATE Customer SET Active = 0 WHERE ID = 1'), []);
	});

	// F24: the fallback's statement regex only matched a bare leading UPDATE/
	// DELETE, missing the common "WITH cte AS (...) UPDATE ..." shape.
	test('flags UPDATE without WHERE behind a leading WITH-CTE', () => {
		const risks = analyzer.analyze('WITH cte AS (SELECT 1 AS x) UPDATE dbo.T SET y = 1');
		assert.strictEqual(risks.length, 1);
		assert.ok(risks[0].includes('UPDATE without WHERE'), risks[0]);
	});

	test('flags DELETE without WHERE behind a leading WITH-CTE', () => {
		const risks = analyzer.analyze('WITH cte AS (SELECT 1 AS x) DELETE FROM dbo.T');
		assert.strictEqual(risks.length, 1);
		assert.ok(risks[0].includes('DELETE without WHERE'), risks[0]);
	});

	// F24: "where" appearing anywhere in the statement text - including inside
	// a string literal - used to suppress the warning entirely.
	test('a "where" inside a string literal does not suppress the warning', () => {
		const risks = analyzer.analyze("UPDATE dbo.T SET note = 'no where clause'");
		assert.strictEqual(risks.length, 1);
		assert.ok(risks[0].includes('UPDATE without WHERE'), risks[0]);
	});
});

// F23: the TRUNCATE/DROP regex scan runs unconditionally (parser-path or
// fallback) over the raw SQL text - it must not match text that isn't
// actually executable: a comment, or a string literal.
suite('QueryRiskAnalyzer TRUNCATE/DROP scan ignores comments and string literals', () => {
	const analyzer = new QueryRiskAnalyzer(null);

	test('a DROP/TRUNCATE keyword inside a string literal is not flagged', () => {
		assert.deepStrictEqual(analyzer.analyze("SELECT * FROM dbo.Log WHERE msg = 'drop table x'"), []);
		assert.deepStrictEqual(analyzer.analyze("SELECT * FROM dbo.Log WHERE msg = 'TRUNCATE TABLE dbo.T'"), []);
	});

	test('a DROP/TRUNCATE keyword inside a line or block comment is not flagged', () => {
		assert.deepStrictEqual(analyzer.analyze('-- TRUNCATE TABLE dbo.T\nSELECT 1'), []);
		assert.deepStrictEqual(analyzer.analyze('/* DROP TABLE dbo.T */ SELECT 1'), []);
	});

	test('a real TRUNCATE/DROP statement is still flagged alongside an unrelated comment', () => {
		const risks = analyzer.analyze('-- cleanup\nTRUNCATE TABLE dbo.Staging;');
		assert.strictEqual(risks.length, 1);
		assert.ok(/truncate table dbo.Staging/i.test(risks[0]), risks[0]);
	});
});
