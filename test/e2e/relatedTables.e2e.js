const { loadPlaywright, openPage, post, checker } = require('./harness');

const playwright = loadPlaywright();

// A two-table query graph (Orders / Customers, joined on CustomerID) with a
// real relationship between the two already - the Schema tab's base case
// before anything is expanded.
const QUERY_GRAPH = {
	command: 'queryGraphResult', success: true,
	graph: {
		tables: [{ qualifiedName: 'dbo.Orders', access: 'direct' }, { qualifiedName: 'dbo.Customers', access: 'direct' }],
		joins: [{ from: 'dbo.Orders', to: 'dbo.Customers', condition: 'Orders.CustomerID = Customers.CustomerID', confident: true }],
		relationships: [{ fkName: 'FK_Orders_Customers', fromTable: 'dbo.Orders', toTable: 'dbo.Customers' }],
		unresolved: [], truncated: false
	}
};

const DOC_SEEDS = {
	command: 'footprintDocResult', success: true,
	doc: {
		tables: [
			{ qualifiedName: 'dbo.Orders', description: '', columns: [], primaryKey: ['OrderID'], foreignKeys: [{ column: 'CustomerID', refTable: 'dbo.Customers' }] },
			{ qualifiedName: 'dbo.Customers', description: '', columns: [], primaryKey: ['CustomerID'], foreignKeys: [] }
		]
	}
};

// One FK neighbor (OrderLines, a child of Orders) and one usage-only
// neighbor (Shipments, found in 7 other procedures alongside Orders).
const RELATED = {
	command: 'relatedTablesResult', success: true,
	related: [
		{ qualifiedName: 'dbo.OrderLines', via: 'fk', fkName: 'FK_OrderLines_Orders', direction: 'child', anchorTable: 'dbo.Orders' },
		{ qualifiedName: 'dbo.Shipments', via: 'usage', procCount: 7, procedures: ['dbo.P1', 'dbo.P2'], anchorTable: 'dbo.Orders' }
	]
};

const DOC_RELATED = {
	command: 'footprintDocResult', success: true,
	doc: {
		tables: [
			{ qualifiedName: 'dbo.OrderLines', description: '', columns: [], primaryKey: ['OrderLineID'], foreignKeys: [{ column: 'OrderID', refTable: 'dbo.Orders' }] },
			{ qualifiedName: 'dbo.Shipments', description: '', columns: [], primaryKey: ['ShipmentID'], foreignKeys: [] }
		]
	}
};

suite('e2e: the Schema tab\'s Expand related tables', function () {
	this.timeout(120000);
	let browser;
	suiteSetup(async function () {
		if (!playwright) this.skip();
		browser = await playwright.chromium.launch();
	});
	suiteTeardown(async () => { if (browser) await browser.close(); });

	test('finds FK and usage neighbors, renders them distinctly, and asks only once', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 760 });
		await post(p, { command: 'connectionStatus', success: true, message: 'ok' });
		await post(p, { command: 'databasesLoaded', databases: ['master'], currentDatabase: 'master' });
		await p.evaluate(() => window.footprintManager.openQueryGraph('select 1'));
		await post(p, QUERY_GRAPH);

		await p.click('.fp-tab[data-fptab="schema"]');
		await post(p, DOC_SEEDS);
		check(await p.evaluate(() => !!window.footprintManager._schemaCy), 'the schema graph rendered once the doc arrived');

		// Expand asks for related tables, for exactly the seed tables.
		await p.evaluate(() => { window.__sent.length = 0; });
		await p.click('#footprintExpandBtn');
		const sentDuringExpand = await p.evaluate(() => window.__sent);
		const request = sentDuringExpand.find(m => m.command === 'getRelatedTables');
		check(!!request, 'getRelatedTables was sent');
		check(request && JSON.stringify(request.tableNames.slice().sort()) === JSON.stringify(['dbo.Customers', 'dbo.Orders']),
			'asked for exactly the seed tables: ' + JSON.stringify(request && request.tableNames));
		check(await p.$eval('#footprintExpandBtn', b => b.disabled), 'the button is disabled while the request is in flight');

		await post(p, RELATED);
		await post(p, DOC_RELATED);

		const nodeKinds = () => p.evaluate(() => {
			const cy = window.footprintManager._schemaCy;
			return Object.fromEntries(cy.nodes().map(n => [n.id().replace(/^s::/, ''), n.data('kind')]));
		});
		const kinds = await nodeKinds();
		check(kinds['dbo.Orders'] === 'seed' && kinds['dbo.Customers'] === 'seed', 'the seed tables keep their kind: ' + JSON.stringify(kinds));
		check(kinds['dbo.OrderLines'] === 'fk', 'the FK neighbor is kind "fk": ' + kinds['dbo.OrderLines']);
		check(kinds['dbo.Shipments'] === 'usage', 'the usage neighbor is kind "usage": ' + kinds['dbo.Shipments']);

		const edgeKinds = await p.evaluate(() => {
			const cy = window.footprintManager._schemaCy;
			return cy.edges().map(e => ({ kind: e.data('kind'), label: e.data('label') }));
		});
		check(!edgeKinds.some(e => e.kind === 'usage'), 'a usage neighbor is a node only, never an edge: ' + JSON.stringify(edgeKinds));
		check(edgeKinds.filter(e => e.kind === 'fk').length === 2, 'two FK edges (the original one plus the new neighbor): ' + JSON.stringify(edgeKinds));

		// A PK/FK icon line shows for a table whose doc has since arrived.
		const orderLinesLabel = await p.evaluate(() => window.footprintManager._schemaCy.getElementById('s::dbo.OrderLines').data('label'));
		check(orderLinesLabel.includes('OrderLineID'), 'the neighbor\'s own PK shows once its doc arrives: ' + orderLinesLabel);

		check(await p.$eval('#footprintSchemaMeta', el => el.textContent.includes('2')), '2 related tables found is reported');
		check(await p.$eval('#footprintExpandBtn', b => !b.disabled), 'the button is usable again once the result is in');

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		check.done();
		await p.close();
	});
});
