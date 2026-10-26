const assert = require('assert');
const BabelfishSqlParser = require('../database/BabelfishSqlParser');
const QueryGraphService = require('../database/QueryGraphService');
const QueryGraphHandlers = require('../panels/handlers/QueryGraphHandlers');
const QueryManager = require('../webview/queryManager');

// Join graph of a query: which tables it reads, how they are joined, and the
// tables reached through the procedures and functions it calls.

function parseJoins(sql) {
	const parser = new BabelfishSqlParser();
	parser.setEnabled(true);
	return parser.analyzeJoins(sql);
}

suite('BabelfishSqlParser.analyzeJoins', () => {
	test('a disabled parser returns null', () => {
		const parser = new BabelfishSqlParser();
		assert.strictEqual(parser.analyzeJoins('SELECT * FROM dbo.A'), null);
	});

	test('lists the tables of the query', () => {
		const result = parseJoins('SELECT * FROM dbo.Orders o JOIN dbo.Customers c ON o.CustomerId = c.Id');
		assert.deepStrictEqual(result.tables.sort(), ['dbo.customers', 'dbo.orders']);
	});

	test('extracts the join condition and its columns', () => {
		const result = parseJoins('SELECT * FROM dbo.Orders o JOIN dbo.Customers c ON o.CustomerId = c.Id');
		assert.strictEqual(result.joins.length, 1);

		const join = result.joins[0];
		assert.strictEqual(join.from, 'dbo.orders');
		assert.strictEqual(join.to, 'dbo.customers');
		assert.strictEqual(join.condition, 'o.CustomerId = c.Id');
		assert.strictEqual(join.confident, true);
		assert.deepStrictEqual(join.columns['dbo.orders'], ['customerid']);
		assert.deepStrictEqual(join.columns['dbo.customers'], ['id']);
	});

	test('extracts every join of a multi-join query', () => {
		const result = parseJoins(`
			SELECT o.Id
			FROM dbo.Orders o
			JOIN dbo.OrderLines ol ON ol.OrderId = o.Id
			JOIN dbo.Products p ON p.Id = ol.ProductId`);
		assert.strictEqual(result.joins.length, 2);
		const pairs = result.joins.map(j => `${j.from}->${j.to}`).sort();
		assert.deepStrictEqual(pairs, ['dbo.orderlines->dbo.products', 'dbo.orders->dbo.orderlines']);
	});

	test('tells the kind of join apart', () => {
		assert.strictEqual(parseJoins('SELECT * FROM dbo.A a LEFT JOIN dbo.B b ON a.Id = b.AId').joins[0].kind, 'left');
		assert.strictEqual(parseJoins('SELECT * FROM dbo.A a INNER JOIN dbo.B b ON a.Id = b.AId').joins[0].kind, 'inner');
		assert.strictEqual(parseJoins('SELECT * FROM dbo.A a CROSS JOIN dbo.B b').joins[0].kind, 'cross');
	});

	test('a join whose condition does not qualify its columns is not confident', () => {
		const result = parseJoins('SELECT * FROM dbo.A a JOIN dbo.B b ON a.Id = b.Id AND a.X = b.Y');
		assert.strictEqual(result.joins[0].confident, true);
		assert.deepStrictEqual(result.joins[0].columns['dbo.a'], ['id', 'x']);
	});

	test('resolves a CTE to the tables it selects from', () => {
		const result = parseJoins('WITH c AS (SELECT Id FROM dbo.T) SELECT * FROM c JOIN dbo.U u ON u.Id = c.Id');
		assert.deepStrictEqual(result.tables.sort(), ['dbo.t', 'dbo.u']);
		assert.strictEqual(result.joins[0].from, 'dbo.t');
		assert.strictEqual(result.joins[0].to, 'dbo.u');
	});

	test('resolves a derived table to the tables it selects from', () => {
		const result = parseJoins('SELECT * FROM dbo.OuterTbl o JOIN (SELECT Id FROM dbo.InnerTbl i) s ON s.Id = o.Id');
		assert.deepStrictEqual(result.tables.sort(), ['dbo.innertbl', 'dbo.outertbl']);
		assert.strictEqual(result.joins.length, 1);
	});

	test('collects the schema-qualified functions the query calls', () => {
		const result = parseJoins('SELECT dbo.fnTotal(o.Id) FROM dbo.Orders o JOIN dbo.Customers c ON c.Id = o.CustomerId');
		assert.deepStrictEqual(result.functions, ['dbo.fntotal']);
		// A built-in is not an object of the database.
		assert.deepStrictEqual(parseJoins('SELECT LEN(o.Name) FROM dbo.Orders o').functions, []);
	});

	test('a query without a FROM has no table', () => {
		const result = parseJoins('SELECT 1');
		assert.deepStrictEqual(result.tables, []);
		assert.deepStrictEqual(result.joins, []);
	});

	test('each statement of a batch is analyzed on its own', () => {
		const result = parseJoins('SELECT * FROM dbo.A a JOIN dbo.B b ON a.Id = b.Id; SELECT * FROM dbo.C c JOIN dbo.D d ON c.Id = d.Id');
		assert.strictEqual(result.joins.length, 2);
	});
});

// === The graph built over the cached index ===

function makeIndex(objects) {
	const map = {};
	for (const o of objects) {
		map[o.qualifiedName.toLowerCase()] = {
			name: o.name,
			schema: o.schema,
			qualifiedName: o.qualifiedName,
			type: o.type,
			dependencies: o.dependencies || [],
			columnRefs: o.columnRefs || {}
		};
	}
	return { objects: map };
}

const INDEX = makeIndex([
	{ name: 'Orders', schema: 'dbo', qualifiedName: 'dbo.Orders', type: 'U' },
	{ name: 'Customers', schema: 'dbo', qualifiedName: 'dbo.Customers', type: 'U' },
	{ name: 'OrderLines', schema: 'dbo', qualifiedName: 'dbo.OrderLines', type: 'U' },
	{ name: 'uspGetOrders', schema: 'dbo', qualifiedName: 'dbo.uspGetOrders', type: 'P', dependencies: ['dbo.Orders', 'dbo.Customers'] },
	{ name: 'fnTotal', schema: 'dbo', qualifiedName: 'dbo.fnTotal', type: 'FN', dependencies: ['dbo.OrderLines'] }
]);

suite('QueryGraphService.buildGraph', () => {
	test('the tables read by the query are direct nodes', () => {
		const parsed = parseJoins('SELECT * FROM dbo.Orders o JOIN dbo.Customers c ON o.CustomerId = c.Id');
		const graph = QueryGraphService.buildGraph({ index: INDEX, parsed });

		const names = graph.tables.map(t => t.qualifiedName).sort();
		assert.deepStrictEqual(names, ['dbo.Customers', 'dbo.Orders']);
		assert.ok(graph.tables.every(t => t.access === 'direct'));
	});

	test('the join edges link the resolved tables', () => {
		const parsed = parseJoins('SELECT * FROM dbo.Orders o JOIN dbo.Customers c ON o.CustomerId = c.Id');
		const graph = QueryGraphService.buildGraph({ index: INDEX, parsed });

		assert.strictEqual(graph.joins.length, 1);
		assert.strictEqual(graph.joins[0].from, 'dbo.Orders');
		assert.strictEqual(graph.joins[0].to, 'dbo.Customers');
		assert.strictEqual(graph.joins[0].condition, 'o.CustomerId = c.Id');
		assert.strictEqual(graph.joins[0].confident, true);
	});

	test('the tables of a called procedure are reached, with their provenance', () => {
		const parsed = parseJoins('SELECT * FROM dbo.uspGetOrders()');
		const graph = QueryGraphService.buildGraph({ index: INDEX, parsed });

		const viaProc = graph.tables.filter(t => t.access === 'via-code').map(t => t.qualifiedName).sort();
		assert.deepStrictEqual(viaProc, ['dbo.Customers', 'dbo.Orders']);
		const orders = graph.tables.find(t => t.qualifiedName === 'dbo.Orders');
		assert.deepStrictEqual(orders.via, ['dbo.uspGetOrders']);
	});

	test('the tables of a called function are reached too', () => {
		const parsed = parseJoins('SELECT dbo.fnTotal(o.Id) FROM dbo.Orders o');
		const graph = QueryGraphService.buildGraph({ index: INDEX, parsed });

		const lines = graph.tables.find(t => t.qualifiedName === 'dbo.OrderLines');
		assert.ok(lines, 'the table of the function is part of the graph');
		assert.strictEqual(lines.access, 'via-code');
		assert.deepStrictEqual(lines.via, ['dbo.fnTotal']);
	});

	test('the tables of a view joined by the query are reached through it', () => {
		const index = makeIndex([
			{ name: 'Orders', schema: 'dbo', qualifiedName: 'dbo.Orders', type: 'U' },
			{ name: 'Customers', schema: 'dbo', qualifiedName: 'dbo.Customers', type: 'U' },
			{ name: 'vwOrderSummary', schema: 'dbo', qualifiedName: 'dbo.vwOrderSummary', type: 'V', dependencies: ['dbo.Orders', 'dbo.Customers'] }
		]);
		const parsed = parseJoins('SELECT * FROM dbo.vwOrderSummary v JOIN dbo.Orders o ON o.Id = v.Id');
		const graph = QueryGraphService.buildGraph({ index, parsed });

		const view = graph.tables.find(t => t.qualifiedName === 'dbo.vwOrderSummary');
		assert.ok(view, 'the view is part of the graph');
		assert.strictEqual(view.access, 'direct', 'the query reads the view itself');

		const customers = graph.tables.find(t => t.qualifiedName === 'dbo.Customers');
		assert.ok(customers, 'the table behind the view is part of the graph');
		assert.strictEqual(customers.access, 'via-code');
		assert.deepStrictEqual(customers.via, ['dbo.vwOrderSummary']);
	});

	test('a table the index does not know is reported as unresolved', () => {
		const parsed = parseJoins('SELECT * FROM dbo.Ghost g');
		const graph = QueryGraphService.buildGraph({ index: INDEX, parsed });

		assert.deepStrictEqual(graph.tables, []);
		assert.deepStrictEqual(graph.unresolved, ['dbo.ghost']);
	});

	test('an empty query gives an empty graph', () => {
		const graph = QueryGraphService.buildGraph({ index: INDEX, parsed: { tables: [], functions: [], joins: [] } });
		assert.deepStrictEqual(graph.tables, []);
		assert.deepStrictEqual(graph.joins, []);
	});
});

// === The scope of the graph: the selected query, or the whole buffer ===

suite('QueryManager query graph scope', () => {
	const TWO_QUERIES = 'SELECT * FROM dbo.A;\nSELECT * FROM dbo.B;';

	function makeManager(text, start, end) {
		const manager = Object.create(QueryManager.prototype);
		manager.input = { value: text, selectionStart: start, selectionEnd: end };
		manager.status = null;
		manager.setStatus = (message) => { manager.status = message; };
		manager.opened = null;
		global.window = {
			footprintManager: {
				openQueryGraph: (sql, options) => { manager.opened = { sql, options }; }
			}
		};
		return manager;
	}

	test('with a selection, the graph covers the selected query only', () => {
		const start = TWO_QUERIES.indexOf('SELECT * FROM dbo.B');
		const manager = makeManager(TWO_QUERIES, start, TWO_QUERIES.length);
		manager.showQueryGraph();

		assert.ok(manager.opened, 'the graph is opened');
		assert.strictEqual(manager.opened.sql.trim(), 'SELECT * FROM dbo.B;');
		assert.strictEqual(manager.opened.options.scope, 'selection');
	});

	test('without a selection, the graph covers the whole query', () => {
		const manager = makeManager(TWO_QUERIES, 0, 0);
		manager.showQueryGraph();

		assert.ok(manager.opened, 'the graph is opened');
		assert.strictEqual(manager.opened.sql, TWO_QUERIES);
		assert.strictEqual(manager.opened.options.scope, 'buffer');
	});

	test('a whitespace-only selection counts as no selection', () => {
		const manager = makeManager('SELECT 1;   ', 10, 13);
		assert.strictEqual(manager.getSelectedText(), null);
	});

	test('an empty editor reports an error instead of opening an empty graph', () => {
		const manager = makeManager('   \n  ', 0, 0);
		manager.showQueryGraph();

		assert.strictEqual(manager.opened, null);
		assert.ok(manager.status, 'the user is told there is nothing to graph');
	});
});

// === The live analysis: the service that reads the index and the database ===

suite('QueryGraphService.analyze', () => {
	function makeService({ index = INDEX, foreignKeys = [], connectionManager = {} } = {}) {
		return new QueryGraphService(
			connectionManager,
			{ getIndex: async () => index },
			{ getForeignKeys: async () => foreignKeys }
		);
	}

	test('an empty text gives an empty graph', async () => {
		const graph = await makeService().analyze('MyDb', '   ');

		assert.deepStrictEqual(graph.tables, []);
		assert.deepStrictEqual(graph.joins, []);
		assert.deepStrictEqual(graph.relationships, []);
	});

	test('the tables and the joins of the query are analyzed', async () => {
		const graph = await makeService().analyze(
			'MyDb',
			'SELECT * FROM dbo.Orders o JOIN dbo.Customers c ON o.CustomerId = c.Id'
		);

		assert.deepStrictEqual(graph.tables.map(t => t.qualifiedName).sort(), ['dbo.Customers', 'dbo.Orders']);
		assert.strictEqual(graph.joins.length, 1);
		assert.strictEqual(graph.joins[0].from, 'dbo.Orders');
		assert.strictEqual(graph.joins[0].to, 'dbo.Customers');
	});

	test('the tables of a called procedure are reached, with their provenance', async () => {
		const graph = await makeService().analyze('MyDb', 'SELECT * FROM dbo.uspGetOrders()');

		const orders = graph.tables.find(t => t.qualifiedName === 'dbo.Orders');
		assert.ok(orders, 'the table of the procedure is part of the graph');
		assert.strictEqual(orders.access, 'via-code');
		assert.deepStrictEqual(orders.via, ['dbo.uspGetOrders']);
	});

	test('the foreign keys between the tables of the graph are added', async () => {
		const foreignKeys = [
			{ fkName: 'FK_Orders_Customers', fromTable: 'dbo.Orders', fromColumn: 'CustomerId', toTable: 'dbo.Customers', toColumn: 'Id' },
			{ fkName: 'FK_Orders_Elsewhere', fromTable: 'dbo.Orders', fromColumn: 'X', toTable: 'dbo.SomewhereElse', toColumn: 'Id' }
		];
		const graph = await makeService({ foreignKeys }).analyze(
			'MyDb',
			'SELECT * FROM dbo.Orders o JOIN dbo.Customers c ON o.CustomerId = c.Id'
		);

		assert.strictEqual(graph.relationships.length, 1);
		assert.strictEqual(graph.relationships[0].fkName, 'FK_Orders_Customers');
		assert.strictEqual(graph.relationships[0].fromTable, 'dbo.Orders');
		assert.strictEqual(graph.relationships[0].toTable, 'dbo.Customers');
	});

	test('a table unknown to the index is reported as unresolved', async () => {
		const graph = await makeService().analyze('MyDb', 'SELECT * FROM dbo.Ghost g');

		assert.deepStrictEqual(graph.tables, []);
		assert.deepStrictEqual(graph.unresolved, ['dbo.ghost']);
	});

	test('without a connection the text cannot be parsed', async () => {
		// The parser is only enabled when a connection manager is given.
		const service = makeService({ connectionManager: null });
		const graph = await service.analyze('MyDb', 'SELECT * FROM dbo.Orders');

		assert.strictEqual(graph.parseFailed, true);
		assert.deepStrictEqual(graph.tables, []);
	});
});

// === The bridge between the webview and the service ===

suite('QueryGraphHandlers.handleGetQueryGraph', () => {
	function makeHandler({ analyze, currentDatabase = 'CurrentDb' } = {}) {
		const posts = [];
		const service = { analyze: analyze || (async () => ({ tables: [], joins: [], relationships: [], unresolved: [], truncated: false })) };
		const handlers = new QueryGraphHandlers(m => posts.push(m), service, () => currentDatabase);
		return { handlers, posts, service };
	}

	test('the graph of the text is posted back', async () => {
		const graph = { tables: [{ qualifiedName: 'dbo.Orders' }], joins: [], relationships: [], unresolved: [], truncated: false };
		const { handlers, posts } = makeHandler({ analyze: async () => graph });

		await handlers.handleGetQueryGraph('MyDb', 'SELECT * FROM dbo.Orders');

		assert.strictEqual(posts.length, 1);
		assert.strictEqual(posts[0].command, 'queryGraphResult');
		assert.strictEqual(posts[0].success, true);
		assert.strictEqual(posts[0].graph, graph);
	});

	test('the current database is used when the caller gives none', async () => {
		const asked = [];
		const { handlers } = makeHandler({
			analyze: async (database) => { asked.push(database); return {}; }
		});

		await handlers.handleGetQueryGraph(null, 'SELECT 1');

		assert.deepStrictEqual(asked, ['CurrentDb']);
	});

	test('no database at all is reported as an error', async () => {
		const { handlers, posts } = makeHandler({ currentDatabase: null });

		await handlers.handleGetQueryGraph(null, 'SELECT 1');

		assert.strictEqual(posts.length, 1);
		assert.strictEqual(posts[0].command, 'queryGraphResult');
		assert.strictEqual(posts[0].success, false);
		assert.strictEqual(posts[0].message, 'No database selected.');
	});

	test('an empty editor is reported as an error', async () => {
		const { handlers, posts } = makeHandler();

		await handlers.handleGetQueryGraph('MyDb', '   ');

		assert.strictEqual(posts.length, 1);
		assert.strictEqual(posts[0].success, false);
		assert.strictEqual(posts[0].message, 'Nothing to analyze in the editor.');
	});

	test('a failure of the service is reported instead of thrown', async () => {
		const { handlers, posts } = makeHandler({
			analyze: async () => { throw new Error('index unavailable'); }
		});

		await handlers.handleGetQueryGraph('MyDb', 'SELECT 1');

		assert.strictEqual(posts.length, 1);
		assert.strictEqual(posts[0].command, 'queryGraphResult');
		assert.strictEqual(posts[0].success, false);
		assert.strictEqual(posts[0].message, 'index unavailable');
	});
});
