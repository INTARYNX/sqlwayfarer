const assert = require('assert');
// Shared globals of the webview's classic scripts.
global.SqlContext = require('../webview/sqlContext');
global.SqlMatcher = require('../webview/sqlMatcher');
const SqlAutocomplete = require('../webview/sqlAutocomplete');
const SqlContext = global.SqlContext;
const SqlMatcher = global.SqlMatcher;

const objects = [
	{ name: 'Employees', object_name: 'Employees', qualified_name: 'dbo.Employees', object_type: 'Table', schema_name: 'dbo' },
	{ name: 'HumanOrders', object_name: 'HumanOrders', qualified_name: 'dbo.HumanOrders', object_type: 'Table', schema_name: 'dbo' },
	{ name: 'Sales.Orders', object_name: 'Orders', qualified_name: 'Sales.Orders', object_type: 'Table', schema_name: 'Sales' },
	{ name: 'Sales.OrderLines', object_name: 'OrderLines', qualified_name: 'Sales.OrderLines', object_type: 'Table', schema_name: 'Sales' },
	{ name: 'Sales.vOrderTotals', object_name: 'vOrderTotals', qualified_name: 'Sales.vOrderTotals', object_type: 'View', schema_name: 'Sales' },
	{ name: 'uspGetEmployees', object_name: 'uspGetEmployees', qualified_name: 'dbo.uspGetEmployees', object_type: 'Procedure', schema_name: 'dbo' },
	{ name: 'fn_Tax', object_name: 'fn_Tax', qualified_name: 'dbo.fn_Tax', object_type: 'Function', schema_name: 'dbo' },
	{ name: 'sys.objects', object_name: 'objects', qualified_name: 'sys.objects', object_type: 'View', schema_name: 'sys' }
];
const columns = {
	'dbo.employees': [
		{ name: 'ID', type: 'int', nullable: false, isPrimaryKey: true },
		{ name: 'Name', type: 'nvarchar(50)', nullable: true },
		{ name: 'Order', type: 'int', nullable: true }
	],
	'sales.orders': [
		{ name: 'OrderID', type: 'int', nullable: false, isPrimaryKey: true },
		{ name: 'ID', type: 'int', nullable: false },
		{ name: 'Total', type: 'money', nullable: true }
	]
};
const foreignKeys = [
	{ fkName: 'FK_Orders_Employees', fromTable: 'Sales.Orders', toTable: 'dbo.Employees', fromColumn: 'ID', toColumn: 'ID' }
];
const procParams = { 'dbo.uspgetemployees': [{ name: '@Dept', type: 'int' }, { name: '@Active', type: 'bit' }] };

// "SELECT | FROM x": the | marks the caret.
function suggest(sql, settings = {}, extra = {}) {
	const caret = sql.indexOf('|');
	const text = sql.replace('|', '');
	return SqlAutocomplete.compute(text, caret, Object.assign({
		objects,
		databases: ['Sales', 'Other'],
		currentDatabase: 'Sales',
		foreignKeys,
		getColumns: (db, q) => columns[q.toLowerCase()],
		getParameters: (db, q) => procParams[q.toLowerCase()],
		settings,
		force: false
	}, extra));
}
const inserts = result => result.items.map(i => i.insert);

suite('SqlMatcher', () => {
	test('exact, prefix, initials, contains and fuzzy matches are ordered by quality', () => {
		const rank = SqlMatcher.rank(
			['xxhoxx', 'HumanOrders', 'ho', 'hxoxrxs', 'house'].map(label => ({ label })), 'ho', 'fuzzy', null
		).map(i => i.label);
		assert.deepStrictEqual(rank.slice(0, 3), ['ho', 'house', 'HumanOrders']);
		assert.ok(rank.includes('xxhoxx'));
	});

	test('prefix mode only keeps names that start with the query', () => {
		assert.ok(SqlMatcher.match('Employees', 'emp', 'prefix'));
		assert.strictEqual(SqlMatcher.match('HumanEmployees', 'emp', 'prefix'), null);
		assert.ok(SqlMatcher.match('HumanEmployees', 'emp', 'contains'));
	});

	test('initials match camelCase and underscores', () => {
		assert.strictEqual(SqlMatcher.match('HumanOrders', 'ho', 'fuzzy').tier, 4);
		assert.strictEqual(SqlMatcher.match('order_lines', 'ol', 'fuzzy').tier, 4);
	});

	test('a substring on a word boundary beats one in the middle of a word', () => {
		const onBoundary = SqlMatcher.match('Sales_Orders', 'ord', 'fuzzy');
		const inside = SqlMatcher.match('Recordings', 'ord', 'fuzzy');
		assert.ok(SqlMatcher.compareMatch(onBoundary, inside) < 0);
	});

	test('scattered letters need at least three characters', () => {
		assert.strictEqual(SqlMatcher.match('Customers', 'cr', 'fuzzy'), null);
		assert.ok(SqlMatcher.match('Customers', 'cst', 'fuzzy'));
	});

	test('brackets typed by the user are ignored', () => {
		assert.strictEqual(SqlMatcher.match('Order Details', '[Order D', 'fuzzy').tier, 5);
	});

	test('pinned items (negative priority) stay first, whatever was used before', () => {
		const items = [{ label: 'Orders', usageKey: 'a' }, { label: 'Orders o ON ...', priority: -1 }];
		assert.strictEqual(SqlMatcher.rank(items, '', 'fuzzy', new Map([['a', 5]]))[0].label, 'Orders o ON ...');
	});

	test('usage breaks ties inside a tier only', () => {
		const items = [{ label: 'Orders', usageKey: 'a' }, { label: 'OrderLines', usageKey: 'b' }];
		const usage = new Map([['b', 3]]);
		assert.strictEqual(SqlMatcher.rank(items, 'order', 'fuzzy', usage)[0].label, 'OrderLines');
		assert.strictEqual(SqlMatcher.rank(items, 'orders', 'fuzzy', usage)[0].label, 'Orders');
	});
});

suite('SqlContext.tokenize', () => {
	test('strings, comments and bracketed names are not words', () => {
		const { tokens } = SqlContext.tokenize("SELECT 'a FROM b', [x y] -- FROM z\n/* WHERE */ c");
		assert.deepStrictEqual(tokens.map(t => t.v), ['SELECT', "'a FROM b'", ',', 'x y', 'c']);
	});

	test('the caret inside a string or a comment is detected', () => {
		assert.strictEqual(SqlContext.analyze("SELECT 'ab", 10, 8).inLiteral, true);
		assert.strictEqual(SqlContext.analyze('SELECT 1 -- ab', 14, 12).inLiteral, true);
		assert.strictEqual(SqlContext.analyze("SELECT 'ab' ", 12, 12).inLiteral, false);
	});

	test('an escaped quote does not end the string', () => {
		assert.strictEqual(SqlContext.analyze("SELECT 'it''s ", 14, 14).inLiteral, true);
	});
});

suite('SqlContext.analyze', () => {
	const at = sql => {
		const caret = sql.indexOf('|');
		return SqlContext.analyze(sql.replace('|', ''), caret, caret);
	};

	test('finds the clause of the caret', () => {
		assert.strictEqual(at('SELECT | FROM t').clause, 'select');
		assert.strictEqual(at('SELECT * FROM t WHERE |').clause, 'where');
		assert.strictEqual(at('SELECT * FROM t GROUP BY |').clause, 'groupby');
		assert.strictEqual(at('SELECT * FROM t ORDER BY |').clause, 'orderby');
		assert.strictEqual(at('SELECT * FROM t JOIN u ON |').clause, 'on');
		assert.strictEqual(at('UPDATE t SET |').clause, 'set');
	});

	test('sources come from the whole statement, including a FROM after the caret', () => {
		const a = at('SELECT | FROM dbo.Employees e JOIN Sales.Orders AS o ON o.ID = e.ID');
		assert.deepStrictEqual(a.sources.map(s => [s.parts.join('.'), s.alias]), [['dbo.Employees', 'e'], ['Sales.Orders', 'o']]);
	});

	test('another statement is not in scope (semicolon or new SELECT)', () => {
		assert.strictEqual(at('SELECT * FROM A a; SELECT | FROM B b').sources[0].alias, 'b');
		assert.strictEqual(at('SELECT * FROM A a\nSELECT | FROM B b').sources.length, 1);
		assert.strictEqual(at('SELECT * FROM A a\nGO\nSELECT | FROM B b').sources.length, 1);
	});

	test('IF ... SELECT ... ELSE SELECT are separate statements', () => {
		const a = at('IF 1 = 1 SELECT * FROM A a ELSE SELECT | FROM B b');
		assert.deepStrictEqual(a.sources.map(s => s.alias), ['b']);
	});

	test('a trigger header does not make a source out of AS', () => {
		const a = at('CREATE TRIGGER t ON A AFTER UPDATE AS SELECT | FROM inserted i');
		assert.deepStrictEqual(a.sources.map(s => s.alias), ['i']);
	});

	test('UNION SELECT stays one statement but has its own sources', () => {
		const a = at('SELECT 1 FROM A a UNION SELECT | FROM B b');
		assert.deepStrictEqual(a.sources.map(s => s.alias), ['b']);
	});

	test('a subquery sees its own sources first, then the outer ones', () => {
		const a = at('SELECT * FROM Orders o WHERE EXISTS (SELECT | FROM Lines l WHERE l.OrderID = o.ID)');
		assert.deepStrictEqual(a.sources.map(s => [s.alias, s.level]), [['l', 0], ['o', 1]]);
	});

	test('a derived table is a source without outer visibility', () => {
		const a = at('SELECT | FROM (SELECT a, b FROM T) d');
		assert.strictEqual(a.sources[0].kind, 'derived');
		assert.strictEqual(a.sources[0].alias, 'd');
	});

	test('CTEs are known by name, also from the statement that follows them', () => {
		const a = at('WITH c AS (SELECT Id FROM T) SELECT | FROM c');
		assert.deepStrictEqual(a.ctes.map(c => c.name), ['c']);
		assert.strictEqual(a.sources[0].kind, 'cte');
	});

	test('temp tables and table variables expose the columns they were created with', () => {
		const a = at('CREATE TABLE #t (id int, name varchar(10), CONSTRAINT pk PRIMARY KEY (id))\nSELECT | FROM #t');
		assert.deepStrictEqual(a.sources[0].def.columns, [{ name: 'id', type: 'int' }, { name: 'name', type: 'varchar(10)' }]);
		const b = at('DECLARE @t TABLE (a int)\nSELECT | FROM @t');
		assert.deepStrictEqual(b.sources[0].def.columns, [{ name: 'a', type: 'int' }]);
	});

	test('a temp table outlives a GO, a table variable does not', () => {
		assert.ok(at('CREATE TABLE #t (a int)\nGO\nSELECT | FROM #t').sources[0].def);
		assert.strictEqual(at('DECLARE @t TABLE (a int)\nGO\nSELECT | FROM @t').sources[0].def, undefined);
	});

	test('after a GO the previous batch\'s variables and table variables are gone', () => {
		assert.deepStrictEqual(at('DECLARE @x INT\nGO\n|').variables, []);
		assert.deepStrictEqual(at('DECLARE @x INT\nSELECT |').variables, [{ name: '@x', type: 'INT' }]);
	});

	test('variables of the batch are listed with their type', () => {
		const a = at('DECLARE @x INT, @y VARCHAR(10)\nSELECT |');
		assert.deepStrictEqual(a.variables, [{ name: '@x', type: 'INT' }, { name: '@y', type: 'VARCHAR(10)' }]);
	});

	test('INSERT column list and VALUES are recognized', () => {
		assert.strictEqual(at('INSERT INTO T (|').group.kind, 'insertcols');
		assert.strictEqual(at('INSERT INTO T (a) VALUES (|').group.kind, 'values');
		assert.deepStrictEqual(at('INSERT INTO T (|').insertTarget.parts, ['T']);
	});

	test('half-typed SQL does not throw', () => {
		for (const sql of ['SELECT (|', 'SELECT * FROM (SELECT |', 'WITH |', 'WITH c AS (|', 'SELECT * FROM t JOIN |', ')))|', '[|', "N'|"]) {
			assert.doesNotThrow(() => at(sql), sql);
		}
	});

	test('selectItems names the columns of a select list', () => {
		const a = at('WITH c AS (SELECT Id, e.Name, COUNT(*) cnt, x AS y, Z.* FROM T e) SELECT | FROM c');
		const child = a.ctes[0].child;
		assert.deepStrictEqual(SqlContext.selectItems(child, child.blocks[0]), { names: ['Id', 'Name', 'cnt', 'y'], stars: [{ alias: 'Z' }] });
	});
});

suite('SqlAutocomplete.extractContext (brackets)', () => {
	test('a bracketed name with spaces is one token', () => {
		const text = 'SELECT * FROM [Order D';
		const ctx = SqlAutocomplete.extractContext(text, text.length);
		assert.strictEqual(ctx.partial, '[Order D');
		assert.strictEqual(ctx.tokenStart, text.indexOf('[Order'));
	});

	test('a dot inside brackets is not a separator', () => {
		const text = 'SELECT [a.b].Na';
		const ctx = SqlAutocomplete.extractContext(text, text.length);
		assert.strictEqual(ctx.base, '[a.b]');
		assert.strictEqual(ctx.partial, 'Na');
	});
});

suite('SqlAutocomplete.compute - settings', () => {
	test('normalizeSettings completes and clamps', () => {
		const s = SqlAutocomplete.normalizeSettings({ minChars: 99, matching: 'nope', maxItems: 'x', enabled: false });
		assert.strictEqual(s.minChars, 5);
		assert.strictEqual(s.matching, 'fuzzy');
		assert.strictEqual(s.maxItems, 20);
		assert.strictEqual(s.enabled, false);
		assert.strictEqual(s.keywordCase, 'upper');
	});

	test('disabled yields nothing', () => {
		assert.strictEqual(suggest('SELECT * FROM Emp|', { enabled: false }).items.length, 0);
	});

	test('minChars gates the automatic popup but not Ctrl+Space', () => {
		assert.strictEqual(suggest('SELECT * FROM E|').items.length, 0);
		assert.ok(suggest('SELECT * FROM E|', {}, { force: true }).items.length > 0);
		assert.ok(suggest('SELECT * FROM E|', { minChars: 1 }).items.length > 0);
	});

	test('maxItems caps the list', () => {
		assert.strictEqual(suggest('SELECT * FROM |', { maxItems: 5 }).items.length, 5);
	});

	test('matching: prefix does not offer initials', () => {
		assert.deepStrictEqual(inserts(suggest('SELECT * FROM ho|', { matching: 'prefix' })), []);
		assert.ok(inserts(suggest('SELECT * FROM ho|', { matching: 'fuzzy' })).includes('dbo.HumanOrders'));
	});

	test('keywordCase: upper, lower and match', () => {
		assert.ok(inserts(suggest('sel|', { keywordCase: 'upper' })).includes('SELECT'));
		assert.ok(inserts(suggest('sel|', { keywordCase: 'lower' })).includes('select'));
		assert.ok(inserts(suggest('sel|', { keywordCase: 'match' })).includes('select'));
		assert.ok(inserts(suggest('SEL|', { keywordCase: 'match' })).includes('SELECT'));
	});

	test('system schemas are hidden unless asked for', () => {
		assert.ok(!inserts(suggest('SELECT * FROM obj|', { matching: 'prefix' })).includes('sys.objects'));
		assert.ok(inserts(suggest('SELECT * FROM obj|', { includeSystemObjects: true })).includes('sys.objects'));
	});

	test('addAlias appends an alias after FROM and JOIN only', () => {
		assert.ok(inserts(suggest('SELECT * FROM hum|', { addAlias: true })).includes('dbo.HumanOrders ho'));
		assert.ok(inserts(suggest('SELECT * FROM Employees e JOIN hum|', { addAlias: true })).includes('dbo.HumanOrders ho'));
		const columns = suggest('SELECT na| FROM Employees e', { addAlias: true }).items.filter(i => i.kind === 'column');
		assert.ok(columns.length > 0 && columns.every(i => !i.insert.includes(' ')));
	});

	test('bracketNames: whenNeeded brackets reserved words, always brackets everything, never nothing', () => {
		const text = 'SELECT e.| FROM Employees e';
		assert.ok(inserts(suggest(text, { bracketNames: 'whenNeeded' })).includes('[Order]'));
		assert.ok(inserts(suggest(text, { bracketNames: 'always' })).includes('[Name]'));
		assert.ok(inserts(suggest(text, { bracketNames: 'never' })).includes('Order'));
	});

	test('a bracket opened by the user is kept', () => {
		assert.ok(inserts(suggest('SELECT * FROM [Emp|', { minChars: 1 })).includes('dbo.[Employees]'));
	});

	test('showTypes hides the data type', () => {
		const withTypes = suggest('SELECT e.| FROM Employees e').items.find(i => i.label === 'Name');
		const without = suggest('SELECT e.| FROM Employees e', { showTypes: false }).items.find(i => i.label === 'Name');
		assert.strictEqual(withTypes.detail, 'nvarchar(50)');
		assert.strictEqual(without.detail, '');
	});
});

suite('SqlAutocomplete.compute - context', () => {
	test('inside a string or a comment nothing is offered', () => {
		assert.strictEqual(suggest("SELECT 'Emp|", {}, { force: true }).items.length, 0);
		assert.strictEqual(suggest('SELECT 1 -- Emp|', {}, { force: true }).items.length, 0);
	});

	test('SELECT offers the columns of the FROM sources, without a prefix', () => {
		const items = suggest('SELECT na| FROM Employees e').items;
		assert.strictEqual(items[0].insert, 'Name');
		assert.strictEqual(items[0].kind, 'column');
	});

	test('a column present in several sources is qualified with its alias', () => {
		const list = inserts(suggest('SELECT I| FROM Employees e JOIN Sales.Orders o ON 1=1', {}, { force: true }));
		assert.ok(list.includes('e.ID') && list.includes('o.ID'));
		assert.ok(!list.includes('ID'));
	});

	test('columnQualification always / never', () => {
		assert.ok(inserts(suggest('SELECT na| FROM Employees e', { columnQualification: 'always' })).includes('e.Name'));
		assert.ok(inserts(suggest('SELECT I| FROM Employees e JOIN Sales.Orders o ON 1=1', { columnQualification: 'never' }, { force: true })).filter(i => i === 'ID').length === 2);
	});

	test('columns are requested when not cached yet', () => {
		const result = suggest('SELECT na| FROM Employees e', {}, { getColumns: () => undefined });
		assert.deepStrictEqual(result.needs.columns, [{ database: 'Sales', qualifiedName: 'dbo.Employees' }]);
	});

	test('after FROM only tables, views, schemas and databases come up', () => {
		const items = suggest('SELECT * FROM |').items;
		const kinds = new Set(items.map(i => i.kind));
		assert.ok(kinds.has('Table') && kinds.has('View') && kinds.has('schema') && kinds.has('Database'));
		assert.ok(!kinds.has('keyword') && !kinds.has('Procedure') && !kinds.has('Function'));
	});

	test('FROM opens by itself, WHERE does not (nothing typed)', () => {
		assert.ok(suggest('SELECT * FROM |').items.length > 0);
		assert.strictEqual(suggest('SELECT * FROM Employees WHERE |').items.length, 0);
		assert.strictEqual(suggest('SELECT * FROM |', { triggerAfterKeywords: false }).items.length, 0);
	});

	test('the word typed after a table name is an alias: no popup', () => {
		assert.strictEqual(suggest('SELECT * FROM Employees ord|').items.length, 0);
		assert.ok(suggest('SELECT * FROM Employees e ord|').items.length > 0);
	});

	test('a schema lists its objects with bare names, not bracketed qualified ones', () => {
		assert.deepStrictEqual(inserts(suggest('SELECT * FROM Sales.|', {}, { databases: ['AppDb'], currentDatabase: 'AppDb' })), ['Orders', 'OrderLines', 'vOrderTotals']);
		assert.deepStrictEqual(inserts(suggest('SELECT * FROM AppDb.|', {}, { databases: ['AppDb'], currentDatabase: 'AppDb' })).slice(0, 3), ['dbo.Employees', 'dbo.HumanOrders', 'Sales.Orders']);
	});

	test('a schema suggestion keeps going with a dot', () => {
		const schema = suggest('SELECT * FROM Sal|').items.find(i => i.kind === 'schema');
		assert.strictEqual(schema.insert, 'Sales.');
		assert.strictEqual(schema.retrigger, true);
	});

	test('EXEC offers procedures only', () => {
		const items = suggest('EXEC |').items;
		assert.deepStrictEqual(items.map(i => i.kind), ['Procedure']);
	});

	test('EXEC proc offers its parameters, minus those already given', () => {
		const all = suggest('EXEC dbo.uspGetEmployees |').items;
		assert.deepStrictEqual(all.map(i => i.label), ['All parameters', '@Dept', '@Active']);
		const rest = suggest('EXEC dbo.uspGetEmployees @Dept = 1, |').items;
		assert.deepStrictEqual(rest.map(i => i.label), ['@Active']);
		assert.strictEqual(rest[0].insert, '@Active = ');
	});

	test('parameters are requested when unknown', () => {
		const result = suggest('EXEC dbo.uspGetEmployees |', {}, { getParameters: () => undefined });
		assert.deepStrictEqual(result.needs.parameters, [{ database: 'Sales', qualifiedName: 'dbo.uspGetEmployees' }]);
	});

	test('USE offers databases', () => {
		assert.deepStrictEqual(suggest('USE |').items.map(i => i.insert), ['Other', 'Sales']);
	});

	test('a statement start offers statement keywords and snippets', () => {
		assert.ok(inserts(suggest('sel|')).includes('SELECT'));
		assert.ok(suggest('ssf|').items[0].kind === 'snippet');
		assert.strictEqual(suggest('ssf|').items[0].insert, 'SELECT * FROM ');
		assert.strictEqual(suggest('ssf|').items[0].caretBack, 0);
	});

	test('snippets place the caret at $0 and can be turned off', () => {
		const sw = suggest('sw|').items.find(i => i.label === 'sw');
		assert.strictEqual(sw.insert, 'SELECT * FROM \nWHERE ');
		assert.strictEqual(sw.insert.length - sw.caretBack, 'SELECT * FROM '.length);
		assert.ok(!suggest('ssf|', { snippets: false }).items.some(i => i.kind === 'snippet'));
	});

	test('the user\'s own snippets are offered by name', () => {
		const items = suggest('mysn|', {}, { snippets: [{ name: 'mysnip', sql: 'SELECT 42' }] }).items;
		assert.strictEqual(items[0].insert, 'SELECT 42');
	});

	test('a new SELECT typed on a new line is offered after a complete query', () => {
		assert.ok(inserts(suggest('SELECT * FROM Employees e\nsel|')).includes('SELECT'));
	});

	test('INSERT column list offers the target columns only', () => {
		const items = suggest('INSERT INTO Employees (|', {}, { force: true }).items;
		assert.deepStrictEqual(items.map(i => i.insert), ['ID', 'Name', '[Order]']);
	});

	test('functions get parentheses and the caret between them', () => {
		const item = suggest('SELECT cou| FROM Employees').items.find(i => i.label === 'COUNT()');
		assert.strictEqual(item.insert, 'COUNT()');
		assert.strictEqual(item.caretBack, 1);
	});

	test('variables are offered in expressions', () => {
		const items = suggest('DECLARE @limit INT\nSELECT * FROM Employees WHERE ID < @li|').items;
		assert.strictEqual(items[0].insert, '@limit');
	});

	test('CAST ( x AS | offers data types', () => {
		const items = suggest('SELECT CAST(ID AS |', {}, { force: true }).items;
		assert.ok(items.some(i => i.insert === 'VARCHAR'));
	});
});

suite('SqlAutocomplete.compute - sources beyond real tables', () => {
	test('CTE columns come from its select list', () => {
		const items = suggest('WITH c AS (SELECT ID AS EmpId, Name FROM Employees) SELECT | FROM c', {}, { force: true }).items;
		const cols = items.filter(i => i.kind === 'column').map(i => i.insert);
		assert.deepStrictEqual(cols, ['EmpId', 'Name']);
	});

	test('CTE columns with an explicit list win', () => {
		const items = suggest('WITH c (a, b) AS (SELECT 1, 2) SELECT c.| FROM c').items;
		assert.deepStrictEqual(items.map(i => i.insert), ['a', 'b']);
	});

	test('a star in a CTE expands to the columns of its table', () => {
		const items = suggest('WITH c AS (SELECT * FROM Employees) SELECT c.| FROM c').items;
		assert.deepStrictEqual(items.map(i => i.insert), ['ID', 'Name', '[Order]']);
	});

	test('a CTE is offered after FROM', () => {
		const items = suggest('WITH recent AS (SELECT 1 AS a) SELECT * FROM rec|').items;
		assert.strictEqual(items[0].kind, 'cte');
	});

	test('derived table columns', () => {
		const items = suggest('SELECT d.| FROM (SELECT ID, Name AS Who FROM Employees) d').items;
		assert.deepStrictEqual(items.map(i => i.insert), ['ID', 'Who']);
	});

	test('temp table columns and names', () => {
		const sql = 'CREATE TABLE #t (id int, label varchar(5))\nSELECT t.| FROM #t t';
		assert.deepStrictEqual(suggest(sql).items.map(i => i.insert), ['id', 'label']);
		assert.strictEqual(suggest('CREATE TABLE #t (id int)\nSELECT * FROM #|', { minChars: 1 }).items[0].kind, 'temp');
	});

	test('SELECT INTO creates a temp table with the select list columns', () => {
		const sql = 'SELECT ID, Name INTO #x FROM Employees\nGO\nSELECT | FROM #x';
		const cols = suggest(sql, {}, { force: true }).items.filter(i => i.kind === 'column').map(i => i.insert);
		assert.deepStrictEqual(cols, ['ID', 'Name']);
	});

	test('aliases of another statement do not leak', () => {
		const items = suggest('SELECT * FROM Sales.Orders e;\nSELECT e.| FROM Employees e').items;
		assert.deepStrictEqual(items.map(i => i.insert), ['ID', 'Name', '[Order]']);
	});

	test('system objects can still be named and queried when they are not offered', () => {
		const sysCols = { 'sys.objects': [{ name: 'object_id', type: 'int' }] };
		const env = { getColumns: (db, q) => sysCols[q.toLowerCase()] };
		assert.deepStrictEqual(inserts(suggest('SELECT o.| FROM sys.objects o', {}, env)), ['object_id']);
		assert.ok(inserts(suggest('SELECT * FROM sys.|', {}, env)).includes('objects'));
	});

	test('an alias of another statement is not resolved', () => {
		assert.strictEqual(suggest('SELECT * FROM Employees x;\nSELECT x.| FROM Sales.Orders o').items.length, 0);
	});

	test('a custom snippet containing $0 is inserted as written', () => {
		const items = suggest('cost|', {}, { snippets: [{ name: 'costly', sql: 'SELECT \'$0\'' }] }).items;
		assert.strictEqual(items[0].insert, "SELECT '$0'");
		assert.strictEqual(items[0].caretBack, 0);
	});

	test('a scoped alias is offered with its dot', () => {
		const alias = suggest('SELECT e| FROM Employees e', { minChars: 1 }).items.find(i => i.kind === 'alias');
		assert.strictEqual(alias.insert, 'e.');
		assert.strictEqual(alias.retrigger, true);
	});

	test('a cross-database source asks for the other database objects', () => {
		const result = suggest('SELECT na| FROM Other.dbo.Employees e');
		assert.deepStrictEqual(result.needs.databaseObjects, ['Other']);
	});
});

suite('SqlAutocomplete.compute - joins and star expansion', () => {
	test('after JOIN the related table comes first, with its condition', () => {
		const items = suggest('SELECT * FROM Employees e JOIN |').items;
		assert.strictEqual(items[0].kind, 'joinCondition');
		assert.strictEqual(items[0].insert, 'Sales.Orders o ON o.ID = e.ID');
		assert.strictEqual(items[1].insert, 'Sales.Orders');
	});

	test('the alias of a suggested join avoids names already used', () => {
		const items = suggest('SELECT * FROM Employees e JOIN Sales.Orders o ON o.ID = e.ID JOIN |').items;
		assert.ok(items.filter(i => i.kind === 'joinCondition').every(i => !/ o ON /.test(i.insert)));
	});

	test('ON offers the foreign key condition first', () => {
		const items = suggest('SELECT * FROM Employees e JOIN Sales.Orders o ON |').items;
		assert.strictEqual(items[0].insert, 'o.ID = e.ID');
		assert.ok(items.some(i => i.kind === 'column'));
	});

	test('the FK condition ignores tables of other statements', () => {
		const items = suggest('SELECT * FROM Employees e;\nSELECT * FROM Sales.Orders o JOIN HumanOrders h ON |').items;
		assert.ok(!items.some(i => i.kind === 'joinCondition'));
	});

	test('Ctrl+Space after * proposes the column list', () => {
		const item = suggest('SELECT *| FROM Employees', {}, { force: true }).items[0];
		assert.strictEqual(item.kind, 'columns');
		assert.strictEqual(item.insert, 'ID, Name, [Order]');
		assert.strictEqual(item.replaceStart, 'SELECT '.length);
	});

	test('alias.* expands that table only, qualified', () => {
		const sql = 'SELECT e.*| FROM Employees e JOIN Sales.Orders o ON 1=1';
		const item = suggest(sql, {}, { force: true }).items[0];
		assert.strictEqual(item.insert, 'e.ID, e.Name, e.[Order]');
		assert.strictEqual(item.replaceStart, 'SELECT '.length);
	});

	test('a multiplication is not a star to expand', () => {
		const items = suggest('SELECT a *| FROM Employees', {}, { force: true }).items;
		assert.ok(!items.some(i => i.kind === 'columns'));
	});

	test('the star waits for its columns instead of showing a partial list', () => {
		const result = suggest('SELECT *| FROM Employees', {}, { force: true, getColumns: () => undefined });
		assert.ok(!result.items.some(i => i.kind === 'columns'));
		assert.strictEqual(result.needs.columns.length, 1);
	});
});

suite('SqlAutocomplete.aliasFor', () => {
	test('uses the initials of the words', () => {
		assert.strictEqual(SqlAutocomplete.aliasFor('Employees', []), 'e');
		assert.strictEqual(SqlAutocomplete.aliasFor('HumanOrders', []), 'ho');
		assert.strictEqual(SqlAutocomplete.aliasFor('order_lines', []), 'ol');
	});

	test('avoids taken names and reserved words', () => {
		assert.strictEqual(SqlAutocomplete.aliasFor('Employees', ['e']), 'e2');
		assert.strictEqual(SqlAutocomplete.aliasFor('Orders', []), 'o');
		assert.strictEqual(SqlAutocomplete.aliasFor('Index', []), 'i');
		assert.strictEqual(SqlAutocomplete.aliasFor('OrderBy', []), 'ob');
	});
});
