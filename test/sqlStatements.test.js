const assert = require('assert');
global.SqlContext = require('../webview/sqlContext');
global.SqlMatcher = require('../webview/sqlMatcher');
const SqlContext = global.SqlContext;
const SqlMatcher = global.SqlMatcher;

// The first word of every statement, and the batch it belongs to: "SELECT@0".
function split(sql) {
	const { tokens, statements } = SqlContext._lex(sql);
	return statements.map(st => `${tokens[st.from].v.toUpperCase()}@${st.batch}`);
}
// "|" marks the caret; the word being typed (if any) starts the token, like in the editor.
const at = sql => {
	const caret = sql.indexOf('|');
	const text = sql.replace('|', '');
	const typing = /[\w#@$]*$/.exec(text.slice(0, caret))[0].length;
	return SqlContext.analyze(text, caret, caret - typing);
};

suite('statement boundaries (table-driven)', () => {
	const cases = [
		// [name, sql, expected first words]
		['semicolon', 'SELECT 1; SELECT 2', ['SELECT@0', 'SELECT@0']],
		['no semicolon: a new SELECT starts a statement', 'SELECT * FROM a\nSELECT * FROM b', ['SELECT@0', 'SELECT@0']],
		['UNION continues', 'SELECT 1 UNION SELECT 2', ['SELECT@0']],
		['UNION ALL / INTERSECT / EXCEPT continue', 'SELECT 1 UNION ALL SELECT 2 INTERSECT SELECT 3 EXCEPT SELECT 4', ['SELECT@0']],
		['CREATE VIEW AS SELECT', 'CREATE VIEW v AS SELECT 1', ['CREATE@0']],
		['INSERT ... SELECT: the select is its own statement', 'INSERT INTO t (a) SELECT a FROM u', ['INSERT@0', 'SELECT@0']],
		['MERGE with THEN UPDATE / INSERT / DELETE stays one', 'MERGE t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = 1 WHEN NOT MATCHED THEN INSERT (id) VALUES (1) WHEN NOT MATCHED BY SOURCE THEN DELETE', ['MERGE@0']],
		['trigger header: AFTER INSERT, UPDATE, DELETE', 'CREATE TRIGGER t ON x AFTER INSERT, UPDATE, DELETE AS SELECT 1', ['CREATE@0', 'SELECT@0'].slice(0, 1)],
		['FOR UPDATE / FOR INSERT', 'CREATE TRIGGER t ON x FOR INSERT AS SELECT 1', ['CREATE@0']],
		['INSTEAD OF DELETE', 'CREATE TRIGGER t ON x INSTEAD OF DELETE AS SELECT 1', ['CREATE@0']],
		['FK actions: ON DELETE / ON UPDATE', 'ALTER TABLE a ADD CONSTRAINT fk FOREIGN KEY (x) REFERENCES b(y) ON DELETE CASCADE ON UPDATE SET NULL', ['ALTER@0']],
		['subquery SELECT does not split', 'SELECT * FROM a WHERE x IN (SELECT y FROM b)', ['SELECT@0']],
		['EXISTS subquery', 'IF EXISTS (SELECT 1 FROM a) DELETE FROM b', ['IF@0', 'DELETE@0']],
		['IF ... SELECT ... ELSE SELECT', 'IF 1 = 1 SELECT 1 ELSE SELECT 2', ['IF@0', 'SELECT@0', 'SELECT@0']],
		['GO starts a new batch', 'SELECT 1\nGO\nSELECT 2', ['SELECT@0', 'SELECT@1']],
		['GO with a count', 'SELECT 1\nGO 5\nSELECT 2', ['SELECT@0', 'SELECT@1']],
		['GO is case-insensitive', 'SELECT 1\ngo\nSELECT 2', ['SELECT@0', 'SELECT@1']],
		['"go" inside a line is a word, not a batch', 'SELECT go FROM t', ['SELECT@0']],
		['a GO column alias on its own line is still GO (T-SQL does the same)', 'SELECT 1\nGO\nGO\nSELECT 2', ['SELECT@0', 'SELECT@2']],
		['CTE then main statement', 'WITH c AS (SELECT 1 AS a) SELECT * FROM c', ['WITH@0']],
		['two CTEs', 'WITH a AS (SELECT 1 AS x), b AS (SELECT 2 AS y) SELECT * FROM a, b', ['WITH@0']],
		['CTE then INSERT / UPDATE / DELETE', 'WITH c AS (SELECT 1 AS a) DELETE FROM t WHERE id IN (SELECT a FROM c)', ['WITH@0']],
		['a CTE after a statement without semicolon', 'SELECT 1\nWITH c AS (SELECT 2 AS a) SELECT * FROM c', ['SELECT@0', 'WITH@0']],
		['WITH (NOLOCK) is not a CTE', 'SELECT * FROM t WITH (NOLOCK)', ['SELECT@0']],
		['WITH ROLLUP / TIES are not CTEs', 'SELECT TOP 5 WITH TIES a FROM t ORDER BY a', ['SELECT@0']],
		['DECLARE then SELECT', 'DECLARE @x INT\nSELECT @x', ['DECLARE@0', 'SELECT@0']],
		['EXEC then SELECT', 'EXEC p\nSELECT 1', ['EXEC@0', 'SELECT@0']],
		['semicolon inside nothing special at the end', 'SELECT 1;', ['SELECT@0']],
		['empty', '', []],
		['only whitespace and comments', '  -- nothing\n /* here */ ', []],
		['strings and comments hide keywords', "SELECT 'a; SELECT 2' -- ; SELECT 3\n/* ; SELECT 4 */", ['SELECT@0']],
		['semicolon inside parentheses does not end', 'SELECT (1;2)', ['SELECT@0']],
		['unbalanced parentheses', 'SELECT ((1 SELECT 2', ['SELECT@0']]
	];
	for (const [name, sql, expected] of cases) {
		test(name, () => assert.deepStrictEqual(split(sql), expected));
	}
});

suite('clause detection (table-driven)', () => {
	const cases = [
		['SELECT |', 'select'], ['SELECT a, | FROM t', 'select'], ['SELECT DISTINCT |', 'select'], ['SELECT TOP 5 |', 'select'],
		['SELECT * FROM |', 'from'], ['SELECT * FROM a, |', 'from'], ['SELECT * FROM a JOIN |', 'join'],
		['SELECT * FROM a CROSS APPLY |', 'join'], ['SELECT * FROM a JOIN b ON |', 'on'],
		['SELECT * FROM a WHERE |', 'where'], ['SELECT * FROM a WHERE x = 1 AND |', 'where'],
		['SELECT a FROM t GROUP BY |', 'groupby'], ['SELECT a FROM t GROUP BY a HAVING |', 'having'], ['SELECT a FROM t ORDER BY |', 'orderby'],
		['UPDATE t SET |', 'set'], ['UPDATE t SET a = 1 WHERE |', 'where'], ['DELETE FROM t WHERE |', 'where'],
		['INSERT INTO t |', 'into'], ['INSERT INTO t (a) VALUES |', 'values'], ['EXEC |', 'exec'], ['USE |', 'use'],
		['DECLARE @x |', 'declare'], ['SELECT 1 UNION SELECT |', 'select'], ['SELECT a INTO #t |', 'into'],
		['MERGE t USING |', 'using'], ['SELECT 1 OPTION (|', 'option'], ['SELECT a FROM t OUTER APPLY |', 'join']
	];
	for (const [sql, clause] of cases) {
		test(`${sql}  ->  ${clause}`, () => assert.strictEqual(at(sql).clause, clause));
	}

	test('the clause of an earlier statement does not leak into the next', () => {
		assert.strictEqual(at('SELECT * FROM a WHERE x = 1; |').clause, 'start');
		assert.strictEqual(at('SELECT * FROM a WHERE x = 1;\nSELECT |').clause, 'select');
	});

	test('the word being typed does not change the clause', () => {
		assert.strictEqual(at('SELECT * FROM a WHE|').clause, 'from');
		assert.strictEqual(at('SELECT * FROM a WHERE|').clause, 'from');
		assert.strictEqual(at('SELECT * FROM a WHERE |').clause, 'where');
		assert.strictEqual(at('SELECT * FROM a WHERE x = 1 AND na|').clause, 'where');
	});
});

suite('sources (table-driven)', () => {
	const describe = sql => at(sql).sources.map(s => `${s.kind}:${s.parts.filter(Boolean).join('.')}${s.alias ? ' ' + s.alias : ''}@${s.level}`);
	const cases = [
		['plain table', 'SELECT | FROM Employees', ['table:Employees@0']],
		['schema, alias', 'SELECT | FROM dbo.Employees e', ['table:dbo.Employees e@0']],
		['AS alias', 'SELECT | FROM dbo.Employees AS e', ['table:dbo.Employees e@0']],
		['bracketed', 'SELECT | FROM [dbo].[Order Details] [od]', ['table:dbo.Order Details od@0']],
		['three-part', 'SELECT | FROM Other.dbo.Employees e', ['table:Other.dbo.Employees e@0']],
		['comma list', 'SELECT | FROM a x, b y, c', ['table:a x@0', 'table:b y@0', 'table:c@0']],
		['joins of all kinds', 'SELECT | FROM a INNER JOIN b ON 1=1 LEFT OUTER JOIN c ON 1=1 FULL JOIN d ON 1=1', ['table:a@0', 'table:b@0', 'table:c@0', 'table:d@0']],
		['hints are not aliases', 'SELECT | FROM a WITH (NOLOCK) JOIN b (NOLOCK) ON 1=1', ['table:a@0', 'table:b@0']],
		['table function', 'SELECT | FROM dbo.fn(1) f', ['function:dbo.fn f@0']],
		['derived table', 'SELECT | FROM (SELECT 1 AS a) d', ['derived: d@0']],
		['temp table', 'SELECT | FROM #t t', ['temp:#t t@0']],
		['table variable', 'SELECT | FROM @tv', ['variable:@tv@0']],
		['UPDATE target and FROM alias are one source', 'UPDATE e SET | FROM Employees e', ['table:Employees e@0']],
		['UPDATE target alone', 'UPDATE Employees SET |', ['table:Employees@0']],
		['DELETE FROM', 'DELETE FROM Employees WHERE |', ['table:Employees@0']],
		['correlated subquery sees the outer sources after its own', 'SELECT * FROM a x WHERE EXISTS (SELECT | FROM b y WHERE y.id = x.id)', ['table:b y@0', 'table:a x@1']],
		['a derived table does not see the outer sources', 'SELECT * FROM a x JOIN (SELECT | FROM b y) d ON 1=1', ['table:b y@0']],
		['CROSS APPLY subquery sees the outer sources', 'SELECT * FROM a x CROSS APPLY (SELECT | FROM b y WHERE y.id = x.id) z', ['table:b y@0', 'table:a x@1']],
		['the select-list itself is not a source', 'SELECT a, b, | FROM t', ['table:t@0']],
		['nothing after FROM yet', 'SELECT * FROM |', []]
	];
	for (const [name, sql, expected] of cases) {
		test(name, () => assert.deepStrictEqual(describe(sql), expected));
	}
});

suite('select lists (table-driven)', () => {
	const items = list => {
		const a = at(`WITH c AS (SELECT ${list} FROM T) SELECT | FROM c`);
		const child = a.ctes[0].child;
		const r = SqlContext.selectItems(child, child.blocks[0]);
		return JSON.stringify([r.names, r.stars.map(s => s.alias)]);
	};
	const cases = [
		['bare columns', 'a, b, c', '[["a","b","c"],[]]'],
		['qualified', 't.a, t.b', '[["a","b"],[]]'],
		['AS alias', 'a AS x, b AS y', '[["x","y"],[]]'],
		['implicit alias', 'a x, COUNT(*) n', '[["x","n"],[]]'],
		['T-SQL alias = expr', 'total = a + b', '[["total"],[]]'],
		['star', '*', '[[],[null]]'],
		['alias star', 't.*, u.*', '[[],["t","u"]]'],
		['DISTINCT / TOP', 'DISTINCT TOP 5 a', '[["a"],[]]'],
		['TOP (n) PERCENT WITH TIES', 'TOP (5) PERCENT WITH TIES a', '[["a"],[]]'],
		['expressions without a name are skipped', 'a + 1, 5, \'x\'', '[[],[]]'],
		['function call alias', 'UPPER(a) AS up, ISNULL(b, 0) zero', '[["up","zero"],[]]'],
		['CASE with alias', 'CASE WHEN a = 1 THEN 2 ELSE 3 END AS kind', '[["kind"],[]]'],
		['commas inside calls do not split', 'ISNULL(a, b) AS x, c', '[["x","c"],[]]'],
		['bracketed names', '[Order Id], [Total] AS [T]', '[["Order Id","T"],[]]']
	];
	for (const [name, list, expected] of cases) {
		test(name, () => assert.strictEqual(items(list), expected));
	}
});

suite('SqlMatcher (table-driven)', () => {
	const tier = (candidate, query, mode) => { const m = SqlMatcher.match(candidate, query, mode); return m ? m.tier : null; };
	const cases = [
		['Employees', 'employees', 6], ['Employees', 'emp', 5], ['Employees', 'EMP', 5],
		['HumanOrders', 'ho', 4], ['HumanOrders', 'hor', 1], ['order_lines', 'ol', 4], ['HTTPServer', 'hs', 4],
		['Sales_Orders', 'ord', 3], ['Sales_Orders', 'sord', 1], ['Recordings', 'ord', 2],
		['Customers', 'cst', 1], ['Customers', 'zzz', null], ['Customers', 'x', null], ['Customers', 'cx', null],
		['Order Details', '[Order D', 5], ['Order Details', '"order', 5], ['', 'a', null], ['abc', '', 5]
	];
	for (const [candidate, query, expected] of cases) {
		test(`"${query}" in "${candidate}" -> tier ${expected}`, () => assert.strictEqual(tier(candidate, query, 'fuzzy'), expected));
	}

	test('prefix and contains modes cut the tiers they do not include', () => {
		assert.strictEqual(tier('HumanOrders', 'ho', 'prefix'), null);
		assert.strictEqual(tier('Recordings', 'ord', 'prefix'), null);
		assert.strictEqual(tier('Recordings', 'ord', 'contains'), 2);
		assert.strictEqual(tier('Customers', 'cst', 'contains'), null);
		assert.strictEqual(tier('Employees', 'emp', 'prefix'), 5);
	});

	test('ranking is a total order: sorting any permutation gives the same result', () => {
		const items = ['Orders', 'OrderLines', 'HumanOrders', 'Recordings', 'Sales_Orders', 'vOrderTotals', 'orders2', 'ORD'].map((label, i) => ({ label, order: i, usageKey: label }));
		const reference = SqlMatcher.rank(items, 'ord', 'fuzzy', new Map([['Orders', 2]])).map(i => i.label);
		for (let n = 0; n < 20; n++) {
			const shuffled = [...items].sort(() => Math.random() - 0.5);
			assert.deepStrictEqual(SqlMatcher.rank(shuffled, 'ord', 'fuzzy', new Map([['Orders', 2]])).map(i => i.label), reference);
		}
	});
});
