const assert = require('assert');
const SqlAutocomplete = require('../webview/sqlAutocomplete');

// Minimal object index, same shape as DatabaseService.getObjects() output.
const objects = [
	{ name: 'Employee', object_name: 'Employee', qualified_name: 'dbo.Employee', object_type: 'Table', schema_name: 'dbo' },
	{ name: 'Sales.Orders', object_name: 'Orders', qualified_name: 'Sales.Orders', object_type: 'Table', schema_name: 'Sales' },
	{ name: 'Sales.vOrderTotals', object_name: 'vOrderTotals', qualified_name: 'Sales.vOrderTotals', object_type: 'View', schema_name: 'Sales' },
	{ name: 'uspGetEmployees', object_name: 'uspGetEmployees', qualified_name: 'dbo.uspGetEmployees', object_type: 'Procedure', schema_name: 'dbo' }
];

suite('SqlAutocomplete.extractContext', () => {
	test('splits base and partial around the last dot', () => {
		const text = 'SELECT e.Na';
		const ctx = SqlAutocomplete.extractContext(text, text.length);
		assert.strictEqual(ctx.base, 'e');
		assert.strictEqual(ctx.partial, 'Na');
		assert.strictEqual(ctx.partialStart, text.length - 2);
	});

	test('no dot means empty base', () => {
		const text = 'SELECT Emp';
		const ctx = SqlAutocomplete.extractContext(text, text.length);
		assert.strictEqual(ctx.base, '');
		assert.strictEqual(ctx.partial, 'Emp');
	});

	test('handles bracketed multi-part names', () => {
		const text = 'SELECT * FROM [Sales].[Ord';
		const ctx = SqlAutocomplete.extractContext(text, text.length);
		assert.strictEqual(ctx.base, '[Sales]');
		assert.strictEqual(ctx.partial, '[Ord');
	});

	test('caret in the middle of the text only looks backwards', () => {
		const text = 'SELECT Emp FROM x';
		const ctx = SqlAutocomplete.extractContext(text, 10); // right after "Emp"
		assert.strictEqual(ctx.partial, 'Emp');
	});

	test('captures the keyword right before the token', () => {
		assert.strictEqual(SqlAutocomplete.extractContext('SELECT us', 9).precedingKeyword, 'select');
		assert.strictEqual(SqlAutocomplete.extractContext('EXEC us', 7).precedingKeyword, 'exec');
		assert.strictEqual(SqlAutocomplete.extractContext('EXECUTE   us', 12).precedingKeyword, 'execute');
	});
});

suite('SqlAutocomplete.wordAt', () => {
	test('returns the full identifier around a middle position', () => {
		const text = 'SELECT * FROM dbo.Employee WHERE ID = 1';
		// position inside "Employee"
		assert.strictEqual(SqlAutocomplete.wordAt(text, text.indexOf('ployee')), 'dbo.Employee');
	});

	test('handles bracketed names', () => {
		const text = 'EXEC [Sales].[uspPlaceOrder]';
		assert.strictEqual(SqlAutocomplete.wordAt(text, text.indexOf('usp')), '[Sales].[uspPlaceOrder]');
	});

	test('returns null on whitespace', () => {
		assert.strictEqual(SqlAutocomplete.wordAt('SELECT  X', 7), null);
	});
});

suite('SqlAutocomplete.parseAliases', () => {
	test('maps FROM and JOIN aliases, with and without AS', () => {
		const aliases = SqlAutocomplete.parseAliases(
			'SELECT * FROM dbo.Employee e JOIN Sales.Orders AS o ON o.EmployeeID = e.ID'
		);
		assert.strictEqual(aliases.e, 'dbo.Employee');
		assert.strictEqual(aliases.o, 'Sales.Orders');
	});

	test('does not treat reserved words as aliases', () => {
		const aliases = SqlAutocomplete.parseAliases('SELECT * FROM Employee WHERE ID = 1');
		assert.deepStrictEqual(aliases, {});
	});

	test('strips brackets from source and alias', () => {
		const aliases = SqlAutocomplete.parseAliases('FROM [Sales].[Orders] [o]');
		assert.strictEqual(aliases.o, 'Sales.Orders');
	});
});

suite('SqlAutocomplete.buildSuggestions', () => {
	const noColumns = () => undefined;

	test('top level suggests keywords and objects, inserting the display name', () => {
		const ctx = { base: '', partial: 'ord' };
		const { items } = SqlAutocomplete.buildSuggestions(ctx, objects, {}, noColumns);
		const labels = items.map(i => i.label);
		assert.ok(labels.includes('ORDER BY'), 'keyword expected');
		assert.ok(labels.includes('Sales.Orders'), 'schema-qualified object expected');
	});

	test('requires two characters at top level by default', () => {
		const ctx = { base: '', partial: 'o' };
		const { items } = SqlAutocomplete.buildSuggestions(ctx, objects, {}, noColumns);
		assert.strictEqual(items.length, 0);
	});

	test('schema prefix lists that schema\'s objects with bare names', () => {
		const ctx = { base: 'Sales', partial: '' };
		const { items } = SqlAutocomplete.buildSuggestions(ctx, objects, {}, noColumns);
		assert.deepStrictEqual(items.map(i => i.insert).sort(), ['Orders', 'vOrderTotals']);
	});

	test('alias prefix asks for columns when they are not cached yet', () => {
		const ctx = { base: 'e', partial: '' };
		const { items, needsColumns } = SqlAutocomplete.buildSuggestions(
			ctx, objects, { e: 'dbo.Employee' }, noColumns
		);
		assert.strictEqual(items.length, 0);
		assert.deepStrictEqual(needsColumns, { database: undefined, qualifiedName: 'dbo.Employee' });
	});

	test('alias prefix suggests cached columns filtered by partial', () => {
		const ctx = { base: 'e', partial: 'Hi' };
		const getColumns = (database, q) => q === 'dbo.Employee'
			? [{ name: 'HireDate', type: 'datetime' }, { name: 'ID', type: 'int' }]
			: undefined;
		const { items } = SqlAutocomplete.buildSuggestions(ctx, objects, { e: 'dbo.Employee' }, getColumns);
		assert.strictEqual(items.length, 1);
		assert.strictEqual(items[0].insert, 'HireDate');
		assert.strictEqual(items[0].detail, 'datetime');
	});

	test('table name used directly (no alias) also resolves to columns', () => {
		const ctx = { base: 'Employee', partial: '' };
		const { needsColumns } = SqlAutocomplete.buildSuggestions(ctx, objects, {}, noColumns);
		assert.deepStrictEqual(needsColumns, { database: undefined, qualifiedName: 'dbo.Employee' });
	});

	test('does not suggest stored procedures outside an EXEC context', () => {
		const ctx = { base: '', partial: 'usp', precedingKeyword: 'select' };
		const { items } = SqlAutocomplete.buildSuggestions(ctx, objects, {}, noColumns);
		assert.ok(!items.some(i => i.insert === 'uspGetEmployees'), 'procedure should not be offered after SELECT');
	});

	test('suggests stored procedures right after EXEC', () => {
		const ctx = { base: '', partial: 'usp', precedingKeyword: 'exec' };
		const { items } = SqlAutocomplete.buildSuggestions(ctx, objects, {}, noColumns);
		assert.ok(items.some(i => i.insert === 'uspGetEmployees'), 'procedure should be offered after EXEC');
	});

	test('suggests stored procedures right after EXECUTE', () => {
		const ctx = { base: '', partial: 'usp', precedingKeyword: 'execute' };
		const { items } = SqlAutocomplete.buildSuggestions(ctx, objects, {}, noColumns);
		assert.ok(items.some(i => i.insert === 'uspGetEmployees'), 'procedure should be offered after EXECUTE');
	});

	test('procedure prefix yields no column suggestions', () => {
		const ctx = { base: 'uspGetEmployees', partial: '' };
		const { items, needsColumns } = SqlAutocomplete.buildSuggestions(ctx, objects, {}, noColumns);
		assert.strictEqual(items.length, 0);
		assert.strictEqual(needsColumns, undefined);
	});

	test('top level also suggests known database names', () => {
		const ctx = { base: '', partial: 'rep' };
		const { items } = SqlAutocomplete.buildSuggestions(
			ctx, objects, {}, noColumns, { databases: ['ReportingDb', 'Sales'] }
		);
		assert.ok(items.some(i => i.insert === 'ReportingDb' && i.kind === 'Database'));
	});

	test('a known database name with nothing fetched yet asks for its objects', () => {
		const ctx = { base: 'ReportingDb', partial: '' };
		const { items, needsDatabaseObjects } = SqlAutocomplete.buildSuggestions(
			ctx, objects, {}, noColumns, { databases: ['ReportingDb'], currentDatabase: 'MainDb' }
		);
		assert.strictEqual(items.length, 0);
		assert.strictEqual(needsDatabaseObjects, 'ReportingDb');
	});

	test('"Database." lists that database\'s own objects once fetched', () => {
		const otherObjects = [
			{ name: 'Metric', object_name: 'Metric', qualified_name: 'dbo.Metric', object_type: 'Table', schema_name: 'dbo' }
		];
		const ctx = { base: 'ReportingDb', partial: '' };
		const { items } = SqlAutocomplete.buildSuggestions(
			ctx, objects, {}, noColumns,
			{ databases: ['ReportingDb'], currentDatabase: 'MainDb', getDatabaseObjects: () => otherObjects }
		);
		assert.deepStrictEqual(items.map(i => i.insert), ['Metric']);
	});

	test('"Database.Schema." lists that schema\'s objects in the other database', () => {
		const otherObjects = [
			{ name: 'Metric', object_name: 'Metric', qualified_name: 'rpt.Metric', object_type: 'Table', schema_name: 'rpt' }
		];
		const ctx = { base: 'ReportingDb.rpt', partial: '' };
		const { items } = SqlAutocomplete.buildSuggestions(
			ctx, objects, {}, noColumns,
			{ databases: ['ReportingDb'], currentDatabase: 'MainDb', getDatabaseObjects: () => otherObjects }
		);
		assert.deepStrictEqual(items.map(i => i.insert), ['Metric']);
	});

	test('"Database.Schema.Table." asks for columns, naming the other database', () => {
		const otherObjects = [
			{ name: 'Metric', object_name: 'Metric', qualified_name: 'rpt.Metric', object_type: 'Table', schema_name: 'rpt' }
		];
		const ctx = { base: 'ReportingDb.rpt.Metric', partial: '' };
		const { needsColumns } = SqlAutocomplete.buildSuggestions(
			ctx, objects, {}, noColumns,
			{ databases: ['ReportingDb'], currentDatabase: 'MainDb', getDatabaseObjects: () => otherObjects }
		);
		assert.deepStrictEqual(needsColumns, { database: 'ReportingDb', qualifiedName: 'rpt.Metric' });
	});

	test('a database segment matching the current database reuses the live objects, no fetch', () => {
		const ctx = { base: 'MainDb', partial: '' };
		const { items } = SqlAutocomplete.buildSuggestions(
			ctx, objects, {}, noColumns,
			{ databases: ['MainDb'], currentDatabase: 'MainDb', getDatabaseObjects: () => { throw new Error('should not fetch'); } }
		);
		assert.ok(items.some(i => i.insert === 'Sales.Orders'));
	});

	test('an alias pointing at a cross-database table resolves columns in that database', () => {
		const otherObjects = [
			{ name: 'Metric', object_name: 'Metric', qualified_name: 'dbo.Metric', object_type: 'Table', schema_name: 'dbo' }
		];
		const ctx = { base: 'm', partial: '' };
		const aliases = { m: 'ReportingDb.dbo.Metric' };
		const { needsColumns } = SqlAutocomplete.buildSuggestions(
			ctx, objects, aliases, noColumns,
			{ databases: ['ReportingDb'], currentDatabase: 'MainDb', getDatabaseObjects: () => otherObjects }
		);
		assert.deepStrictEqual(needsColumns, { database: 'ReportingDb', qualifiedName: 'dbo.Metric' });
	});
});

suite('SqlAutocomplete.extractJoinOnContext', () => {
	test('matches a plain JOIN right before ON', () => {
		const text = 'SELECT * FROM dbo.Employee e JOIN Sales.Orders o ON';
		const ctx = SqlAutocomplete.extractJoinOnContext(text, text.length);
		assert.deepStrictEqual(ctx, { table: 'Sales.Orders', alias: 'o' });
	});

	test('matches with a join type keyword and no alias', () => {
		const text = 'FROM dbo.Employee e LEFT OUTER JOIN Sales.Orders ON';
		const ctx = SqlAutocomplete.extractJoinOnContext(text, text.length);
		assert.deepStrictEqual(ctx, { table: 'Sales.Orders', alias: null });
	});

	test('tolerates trailing whitespace after ON', () => {
		const text = 'FROM Employee e JOIN Orders o ON   ';
		const ctx = SqlAutocomplete.extractJoinOnContext(text, text.length);
		assert.strictEqual(ctx.table, 'Orders');
	});

	test('does not match once a condition follows ON', () => {
		const text = 'FROM Employee e JOIN Orders o ON o.EmployeeID = e.ID';
		assert.strictEqual(SqlAutocomplete.extractJoinOnContext(text, text.length), null);
	});

	test('does not match outside a JOIN clause', () => {
		assert.strictEqual(SqlAutocomplete.extractJoinOnContext('SELECT * FROM Employee WHERE 1=1 ON', 36), null);
	});
});

suite('SqlAutocomplete.buildJoinConditionSuggestions', () => {
	const fks = [
		{ fkName: 'FK_Orders_Employee', fromTable: 'Sales.Orders', fromColumn: 'EmployeeID', toTable: 'dbo.Employee', toColumn: 'ID' }
	];
	const compositeFks = [
		{ fkName: 'FK_OrderLine_Orders', fromTable: 'Sales.OrderLine', fromColumn: 'OrderID', toTable: 'Sales.Orders', toColumn: 'ID' },
		{ fkName: 'FK_OrderLine_Orders', fromTable: 'Sales.OrderLine', fromColumn: 'OrderYear', toTable: 'Sales.Orders', toColumn: 'Year' }
	];

	test('suggests the FK condition with aliases on the right sides', () => {
		const joinCtx = { table: 'Sales.Orders', alias: 'o' };
		const before = 'SELECT * FROM dbo.Employee e JOIN Sales.Orders o ON';
		const items = SqlAutocomplete.buildJoinConditionSuggestions(joinCtx, objects, before, fks);
		assert.strictEqual(items.length, 1);
		assert.strictEqual(items[0].insert, 'o.EmployeeID = e.ID');
		assert.strictEqual(items[0].kind, 'joinCondition');
		assert.ok(items[0].detail.includes('FK_Orders_Employee'));
	});

	test('works when the newly joined table is the FK referenced side', () => {
		// Employee is the FK target (referenced) side; Orders (already in scope) is the FK owner.
		const joinCtx = { table: 'dbo.Employee', alias: 'e' };
		const before = 'SELECT * FROM Sales.Orders o JOIN dbo.Employee e ON';
		const items = SqlAutocomplete.buildJoinConditionSuggestions(joinCtx, objects, before, fks);
		assert.strictEqual(items.length, 1);
		assert.strictEqual(items[0].insert, 'o.EmployeeID = e.ID');
	});

	test('falls back to the bare table name as alias when none was typed', () => {
		const joinCtx = { table: 'Sales.Orders', alias: null };
		const before = 'SELECT * FROM dbo.Employee e JOIN Sales.Orders ON';
		const items = SqlAutocomplete.buildJoinConditionSuggestions(joinCtx, objects, before, fks);
		assert.strictEqual(items[0].insert, 'Orders.EmployeeID = e.ID');
	});

	test('combines multi-column FKs with AND', () => {
		const lineObjects = [
			...objects,
			{ name: 'Sales.OrderLine', object_name: 'OrderLine', qualified_name: 'Sales.OrderLine', object_type: 'Table', schema_name: 'Sales' }
		];
		const joinCtx = { table: 'Sales.OrderLine', alias: 'ol' };
		const before = 'SELECT * FROM Sales.Orders o JOIN Sales.OrderLine ol ON';
		const items = SqlAutocomplete.buildJoinConditionSuggestions(joinCtx, lineObjects, before, compositeFks);
		assert.strictEqual(items.length, 1);
		assert.strictEqual(items[0].insert, 'ol.OrderID = o.ID AND ol.OrderYear = o.Year');
	});

	test('no relationship between the two tables yields no suggestion', () => {
		const joinCtx = { table: 'Sales.vOrderTotals', alias: 'v' };
		const before = 'SELECT * FROM dbo.Employee e JOIN Sales.vOrderTotals v ON';
		const items = SqlAutocomplete.buildJoinConditionSuggestions(joinCtx, objects, before, fks);
		assert.strictEqual(items.length, 0);
	});

	test('an unknown table (not in the object index) yields no suggestion', () => {
		const joinCtx = { table: 'Nope', alias: 'n' };
		const items = SqlAutocomplete.buildJoinConditionSuggestions(joinCtx, objects, 'FROM Employee e JOIN Nope n ON', fks);
		assert.strictEqual(items.length, 0);
	});
});

// The object list is indexed once and cached by the list's identity: the
// explorer replaces the list as a whole, so a new list must be indexed
// again - a stale index would suggest objects that are no longer there.
suite('SqlAutocomplete object index', () => {
	function makeObjects() {
		return [
			{ name: 'Employee', object_name: 'Employee', qualified_name: 'dbo.Employee', object_type: 'Table', schema_name: 'dbo' },
			{ name: 'Sales.Orders', object_name: 'Orders', qualified_name: 'Sales.Orders', object_type: 'Table', schema_name: 'Sales' }
		];
	}

	test('resolves a reference by qualified name, object name or bare name', () => {
		const list = makeObjects();

		assert.strictEqual(SqlAutocomplete._resolveObjectRef('dbo.Employee', list).qualified_name, 'dbo.Employee');
		assert.strictEqual(SqlAutocomplete._resolveObjectRef('Orders', list).qualified_name, 'Sales.Orders');
		assert.strictEqual(SqlAutocomplete._resolveObjectRef('employee', list).qualified_name, 'dbo.Employee');
		assert.strictEqual(SqlAutocomplete._resolveObjectRef('[Sales].[Orders]', list).qualified_name, 'Sales.Orders');
		assert.strictEqual(SqlAutocomplete._resolveObjectRef('Nope', list), undefined);
	});

	test('a replaced object list is indexed again, not served from the old index', () => {
		const before = makeObjects();
		assert.ok(SqlAutocomplete._resolveObjectRef('Sales.Orders', before));

		const after = [
			{ name: 'Employee', object_name: 'Employee', qualified_name: 'dbo.Employee', object_type: 'Table', schema_name: 'dbo' }
		];
		assert.strictEqual(SqlAutocomplete._resolveObjectRef('Sales.Orders', after), undefined);
		assert.ok(SqlAutocomplete._resolveObjectRef('dbo.Employee', after));
	});

	test('the schema index lists the objects of that schema', () => {
		const list = makeObjects();
		const index = SqlAutocomplete._objectIndex(list);

		assert.deepStrictEqual(index.bySchema.get('sales').map(o => o.qualified_name), ['Sales.Orders']);
		assert.strictEqual(index.bySchema.get('dbo').length, 1);
	});

	test('the suggestions are the same with and without the index', () => {
		const list = makeObjects();
		const ctx = { base: '', partial: 'emp', partialStart: 0, precedingKeyword: 'select' };
		const { items } = SqlAutocomplete.buildSuggestions(ctx, list, {}, () => undefined, { minLength: 2 });

		assert.ok(items.some(i => i.label === 'Employee'));
	});
});
