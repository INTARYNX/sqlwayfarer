const assert = require('assert');
const CodeViewManager = require('../webview/codeViewManager');

suite('CodeViewManager.estimateComplexity', () => {
	const rate = CodeViewManager.estimateComplexity;

	test('plain code is low', () => {
		assert.strictEqual(rate(''), 'Low');
		assert.strictEqual(rate(null), 'Low');
		assert.strictEqual(rate('SELECT a, b FROM dbo.T WHERE a = 1'), 'Low');
	});

	test('a table hint is not a CTE', () => {
		assert.strictEqual(rate('SELECT * FROM dbo.T WITH (NOLOCK) WHERE id = 1'), 'Low');
		assert.strictEqual(rate('SELECT * FROM dbo.T t WITH (NOLOCK, INDEX(ix)) JOIN dbo.U u WITH (NOLOCK) ON u.id = t.id'), 'Medium');
	});

	test('a CTE, with or without a column list, counts', () => {
		assert.strictEqual(rate('WITH c AS (SELECT 1 AS x) SELECT * FROM c'), 'Medium');
		assert.strictEqual(rate('WITH c (x) AS (SELECT 1) SELECT * FROM c'), 'Medium');
	});

	test('words in a comment or a string do not count', () => {
		assert.strictEqual(rate("-- JOIN JOIN JOIN JOIN\nSELECT 'CASE WHEN EXISTS' AS s /* UNION UNION */"), 'Low');
	});

	test('joins, subqueries, CASE and loops add up', () => {
		const code = 'SELECT CASE WHEN EXISTS (SELECT 1 FROM a) THEN 1 END FROM t JOIN u ON 1 = 1 UNION SELECT 2';
		assert.strictEqual(rate(code), 'High');
		assert.strictEqual(rate('WHILE 1 = 1 BEGIN DECLARE c CURSOR FOR SELECT 1 END'), 'Medium');
	});

	test('the words that are not T-SQL do not count', () => {
		assert.strictEqual(rate('SELECT subquery, cte, recursive FROM dbo.T'), 'Low');
	});
});
