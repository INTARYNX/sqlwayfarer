const assert = require('assert');
const DataDictionaryService = require('../database/DataDictionaryService');

// Flat recordsets in the exact shape the collect() queries produce.
function makeFixture() {
	return {
		database: 'Shop',
		server: 'SRV01',
		objects: [
			{ schema_name: 'dbo', object_name: 'Customer', type_code: 'U', description: 'Customer master data' },
			{ schema_name: 'dbo', object_name: 'Order', type_code: 'U', description: null },
			{ schema_name: 'dbo', object_name: 'vCustomerOrders', type_code: 'V', description: 'Orders joined to customers' },
			{ schema_name: 'sales', object_name: 'uspPlaceOrder', type_code: 'P', description: 'Places an order' },
			{ schema_name: 'sales', object_name: 'fnOrderTotal', type_code: 'FN', description: null }
		],
		columns: [
			{ schema_name: 'dbo', object_name: 'Customer', column_name: 'CustomerID', data_type: 'int', max_length: 4, precision: 10, scale: 0, is_nullable: false, is_identity: true, is_computed: false, default_definition: null, description: 'Primary key' },
			{ schema_name: 'dbo', object_name: 'Customer', column_name: 'Name', data_type: 'nvarchar', max_length: 100, precision: 0, scale: 0, is_nullable: false, is_identity: false, is_computed: false, default_definition: null, description: null },
			{ schema_name: 'dbo', object_name: 'Order', column_name: 'OrderID', data_type: 'int', max_length: 4, precision: 10, scale: 0, is_nullable: false, is_identity: true, is_computed: false, default_definition: null, description: null },
			{ schema_name: 'dbo', object_name: 'Order', column_name: 'CustomerID', data_type: 'int', max_length: 4, precision: 10, scale: 0, is_nullable: false, is_identity: false, is_computed: false, default_definition: null, description: null },
			{ schema_name: 'dbo', object_name: 'Order', column_name: 'Total', data_type: 'decimal', max_length: 9, precision: 10, scale: 2, is_nullable: true, is_identity: false, is_computed: false, default_definition: '((0))', description: 'Order total | tax included' }
		],
		primaryKeys: [
			{ schema_name: 'dbo', object_name: 'Customer', column_name: 'CustomerID' },
			{ schema_name: 'dbo', object_name: 'Order', column_name: 'OrderID' }
		],
		foreignKeys: [
			{ schema_name: 'dbo', object_name: 'Order', fk_name: 'FK_Order_Customer', column_name: 'CustomerID', ref_schema: 'dbo', ref_table: 'Customer', ref_column: 'CustomerID' }
		],
		parameters: [
			{ schema_name: 'sales', object_name: 'uspPlaceOrder', param_name: '@CustomerID', data_type: 'int', max_length: 4, precision: 10, scale: 0, is_output: false },
			{ schema_name: 'sales', object_name: 'uspPlaceOrder', param_name: '@OrderID', data_type: 'int', max_length: 4, precision: 10, scale: 0, is_output: true }
		],
		index: {
			objects: {
				'sales.uspPlaceOrder': { qualifiedName: 'sales.uspPlaceOrder', dependencies: ['dbo.Order', 'dbo.Customer'] },
				'dbo.vCustomerOrders': { qualifiedName: 'dbo.vCustomerOrders', dependencies: ['dbo.Order', 'dbo.Customer'] }
			}
		}
	};
}

suite('DataDictionaryService.assemble', () => {
	test('groups objects by schema and category', () => {
		const data = DataDictionaryService.assemble(makeFixture());
		assert.deepStrictEqual(Object.keys(data.schemas).sort(), ['dbo', 'sales']);
		assert.strictEqual(data.schemas.dbo.tables.length, 2);
		assert.strictEqual(data.schemas.dbo.views.length, 1);
		assert.strictEqual(data.schemas.sales.procedures.length, 1);
		assert.strictEqual(data.schemas.sales.functions.length, 1);
	});

	test('attaches columns, primary keys, foreign keys and parameters', () => {
		const data = DataDictionaryService.assemble(makeFixture());
		const order = data.schemas.dbo.tables.find(t => t.name === 'Order');
		assert.strictEqual(order.columns.length, 3);
		assert.deepStrictEqual(order.primaryKey, ['OrderID']);
		assert.strictEqual(order.foreignKeys[0].fk_name, 'FK_Order_Customer');

		const proc = data.schemas.sales.procedures[0];
		assert.strictEqual(proc.parameters.length, 2);
	});

	test('computes dependsOn and inverted referencedBy from the index', () => {
		const data = DataDictionaryService.assemble(makeFixture());
		const proc = data.schemas.sales.procedures[0];
		assert.deepStrictEqual(proc.dependsOn, ['dbo.Customer', 'dbo.Order'], 'lists are sorted for deterministic output');

		const customer = data.schemas.dbo.tables.find(t => t.name === 'Customer');
		assert.deepStrictEqual(customer.referencedBy, ['dbo.vCustomerOrders', 'sales.uspPlaceOrder']);
	});

	test('works without an index (no dependencies)', () => {
		const data = DataDictionaryService.assemble({ ...makeFixture(), index: null });
		const proc = data.schemas.sales.procedures[0];
		assert.deepStrictEqual(proc.dependsOn, []);
	});
});

suite('DataDictionaryService.render', () => {
	const markdown = DataDictionaryService.render(DataDictionaryService.assemble(makeFixture()));

	test('contains title, contents and coverage summary', () => {
		assert.ok(markdown.includes('# Data Dictionary — Shop'));
		assert.ok(markdown.includes('**Contents:** 2 tables · 1 views · 1 procedures · 1 functions'));
		// 1 of 2 tables and 2 of 5 columns documented
		assert.ok(markdown.includes('50% of tables and 40% of columns'), markdown.match(/coverage.*$/m));
	});

	test('renders table sections with PK marker, types and cleaned defaults', () => {
		assert.ok(markdown.includes('#### dbo.Customer'));
		assert.ok(markdown.includes('> Customer master data'));
		assert.ok(markdown.includes('🔑 **CustomerID** | int · identity'));
		assert.ok(markdown.includes('nvarchar(50)'), 'nvarchar byte length should be halved');
		assert.ok(markdown.includes('decimal(10,2)'));
		assert.ok(markdown.includes('| 0 |'), 'default ((0)) should be cleaned to 0');
	});

	test('escapes pipes in descriptions', () => {
		assert.ok(markdown.includes('Order total \\| tax included'));
	});

	test('renders foreign keys with a link to the referenced table', () => {
		assert.ok(markdown.includes('`FK_Order_Customer`: CustomerID → [dbo.Customer](#dbocustomer) (CustomerID)'));
	});

	test('renders cross-linked dependencies', () => {
		assert.ok(markdown.includes('**Referenced by:** [dbo.vCustomerOrders](#dbovcustomerorders), [sales.uspPlaceOrder](#salesuspplaceorder)'));
	});

	test('renders procedure parameters with direction', () => {
		assert.ok(markdown.includes('| @OrderID | int | out |'));
	});
});

suite('DataDictionaryService.renderPages (multi-file full export)', () => {
	const data = DataDictionaryService.assemble(makeFixture());
	const result = DataDictionaryService.renderPages(data, { full: true, maxTablesPerFile: 1 });
	const byName = Object.fromEntries(result.files.map(f => [f.name, f.content]));

	test('emits a README index plus one file per page', () => {
		assert.strictEqual(result.indexName, 'README.md');
		assert.ok(byName['README.md'], 'has README');
		// dbo: 2 tables (cap 1 → 2 files), 1 view; sales: 1 proc, 1 function.
		assert.ok(byName['dbo-tables-01.md'], 'dbo tables page 1');
		assert.ok(byName['dbo-tables-02.md'], 'dbo tables page 2');
		assert.ok(byName['dbo-views.md'], 'dbo views (single page, no suffix)');
		assert.ok(byName['sales-procedures.md']);
		assert.ok(byName['sales-functions.md']);
	});

	test('caps tables per page so no file carries more than maxTablesPerFile', () => {
		for (const f of result.files) {
			const tables = (f.content.match(/^#### /gm) || []).length;
			if (f.name.includes('-tables-')) assert.ok(tables <= 1, `${f.name} has ${tables} tables`);
		}
	});

	test('README lists schemas with links to the page files', () => {
		const readme = byName['README.md'];
		assert.ok(readme.includes('# Data Dictionary — Shop'));
		assert.ok(readme.includes('### Schema: dbo'));
		assert.ok(readme.includes('(dbo-tables-01.md)'), readme);
		assert.ok(readme.includes('(sales-procedures.md)'));
	});

	test('foreign-key links resolve to the file the referenced table lives on', () => {
		// dbo.Order references dbo.Customer; each is on its own page (cap 1).
		const orderPage = result.files.find(f => f.content.includes('#### dbo.Order')).content;
		const customerFile = result.files.find(f => f.content.includes('#### dbo.Customer')).name;
		assert.ok(
			orderPage.includes(`→ [dbo.Customer](${customerFile}#dbocustomer)`),
			orderPage.match(/Foreign keys[\s\S]*?→.*$/m)
		);
	});

	test('page files carry a Mermaid ER neighborhood and a back-link to the index', () => {
		const orderPage = result.files.find(f => f.content.includes('#### dbo.Order')).content;
		assert.ok(orderPage.includes('[← Index](README.md)'));
		assert.ok(orderPage.includes('```mermaid'), 'ER diagram present in full mode');
	});
});

suite('DataDictionaryService pagination helpers', () => {
	const mk = name => ({ name });

	test('objectPrefix groups by underscore segment then leading word', () => {
		assert.strictEqual(DataDictionaryService.objectPrefix('Invoice_Header'), 'Invoice');
		assert.strictEqual(DataDictionaryService.objectPrefix('InvoiceLine'), 'Invoice');
		assert.strictEqual(DataDictionaryService.objectPrefix('Customer'), 'Customer');
	});

	test('packByPrefix keeps same-prefix objects together and respects the cap', () => {
		const entries = [
			mk('Invoice_A'), mk('Invoice_B'), mk('Invoice_C'),
			mk('Order_A'), mk('Order_B')
		];
		const bins = DataDictionaryService.packByPrefix(entries, 3);
		// Invoice group (3) fills a bin; Order group (2) lands in the next.
		assert.strictEqual(bins.length, 2);
		assert.deepStrictEqual(bins[0].map(e => e.name), ['Invoice_A', 'Invoice_B', 'Invoice_C']);
		assert.deepStrictEqual(bins[1].map(e => e.name), ['Order_A', 'Order_B']);
	});

	test('packByPrefix chunks a single prefix group larger than the cap', () => {
		const entries = [mk('T_1'), mk('T_2'), mk('T_3'), mk('T_4'), mk('T_5')];
		const bins = DataDictionaryService.packByPrefix(entries, 2);
		assert.deepStrictEqual(bins.map(b => b.length), [2, 2, 1]);
	});

	test('packByPrefix merges small consecutive groups up to the cap', () => {
		const entries = [mk('Aaa'), mk('Bbb'), mk('Ccc'), mk('Ddd')];
		const bins = DataDictionaryService.packByPrefix(entries, 3);
		assert.deepStrictEqual(bins.map(b => b.length), [3, 1]);
	});
});

suite('DataDictionaryService helpers', () => {
	test('formatDataType covers length, unicode, precision and MAX cases', () => {
		assert.strictEqual(DataDictionaryService.formatDataType('varchar', 50), 'varchar(50)');
		assert.strictEqual(DataDictionaryService.formatDataType('varchar', -1), 'varchar(MAX)');
		assert.strictEqual(DataDictionaryService.formatDataType('nvarchar', 100), 'nvarchar(50)');
		assert.strictEqual(DataDictionaryService.formatDataType('decimal', 9, 18, 4), 'decimal(18,4)');
		assert.strictEqual(DataDictionaryService.formatDataType('datetime2', 8, 27, 7), 'datetime2(7)');
		assert.strictEqual(DataDictionaryService.formatDataType('int', 4), 'int');
	});

	test('anchor matches GitHub heading slugs', () => {
		assert.strictEqual(DataDictionaryService.anchor('dbo.Customer'), 'dbocustomer');
		assert.strictEqual(DataDictionaryService.anchor('Schema: sales'), 'schema-sales');
	});
});
