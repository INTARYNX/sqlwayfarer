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
		assert.strictEqual(needsColumns, 'dbo.Employee');
	});

	test('alias prefix suggests cached columns filtered by partial', () => {
		const ctx = { base: 'e', partial: 'Hi' };
		const getColumns = q => q === 'dbo.Employee'
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
		assert.strictEqual(needsColumns, 'dbo.Employee');
	});

	test('procedure prefix yields no column suggestions', () => {
		const ctx = { base: 'uspGetEmployees', partial: '' };
		const { items, needsColumns } = SqlAutocomplete.buildSuggestions(ctx, objects, {}, noColumns);
		assert.strictEqual(items.length, 0);
		assert.strictEqual(needsColumns, undefined);
	});
});
