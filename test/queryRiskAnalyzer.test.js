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
});
