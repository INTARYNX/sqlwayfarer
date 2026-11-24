const { loadPlaywright, openPage, post, checker } = require('./harness');

const playwright = loadPlaywright();

// Two tables and the foreign key between them: the child (OrderLines)
// references the parent (Orders).
const QUERY_GRAPH = {
	command: 'queryGraphResult', success: true,
	graph: {
		tables: [{ qualifiedName: 'dbo.Orders', access: 'direct' }, { qualifiedName: 'dbo.OrderLines', access: 'direct' }],
		joins: [],
		relationships: [{ fkName: 'FK_OrderLines_Orders', fromTable: 'dbo.OrderLines', toTable: 'dbo.Orders' }],
		unresolved: [], truncated: false
	}
};

const DOC = {
	command: 'footprintDocResult', success: true,
	doc: {
		tables: [
			{ qualifiedName: 'dbo.Orders', description: '', columns: [], primaryKey: ['OrderID'], foreignKeys: [] },
			{ qualifiedName: 'dbo.OrderLines', description: '', columns: [], primaryKey: ['OrderLineID'], foreignKeys: [{ column: 'OrderID', refTable: 'dbo.Orders' }] }
		]
	}
};

suite('e2e: the Schema tab lays its tables out with ELK', function () {
	this.timeout(120000);
	let browser;
	suiteSetup(async function () {
		if (!playwright) this.skip();
		browser = await playwright.chromium.launch();
	});
	suiteTeardown(async () => { if (browser) await browser.close(); });

	test('places the tables in layers, without piling them up', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 760 });
		await post(p, { command: 'connectionStatus', success: true, message: 'ok' });
		await post(p, { command: 'databasesLoaded', databases: ['master'], currentDatabase: 'master' });

		// The ELK engine is 1.6 MB: it is not loaded with the page, only when a
		// schema has to be laid out.
		check(await p.evaluate(() => typeof window.ELK === 'undefined'), 'ELK is not loaded with the page');
		check(await p.evaluate(() => document.querySelectorAll('script[src*="elk"]').length === 0), 'no ELK script tag at the start');

		await p.evaluate(() => window.footprintManager.openQueryGraph('select 1'));
		await post(p, QUERY_GRAPH);

		await p.click('.fp-tab[data-fptab="schema"]');
		await post(p, DOC);

		// The pane stays pending until ELK has placed the tables.
		await p.waitForFunction(
			() => !document.getElementById('footprintSchemaGraph').classList.contains('fp-layout-pending'),
			null, { timeout: 60000 }
		);
		check(await p.evaluate(() => document.querySelectorAll('script[src*="elk"]').length === 1), 'the ELK engine is loaded once, when the schema is drawn');

		const engine = await p.evaluate(() => window.footprintManager._schemaLayoutEngine);
		check(engine === 'elk', 'the tables were placed by ELK, not by the dagre fallback: ' + engine);

		const nodes = await p.evaluate(() => window.footprintManager._schemaCy.nodes().map(n => ({
			id: n.id(), x: n.position('x'), y: n.position('y'), w: n.outerWidth(), h: n.outerHeight()
		})));
		check(nodes.length === 2, 'the two tables are on screen: ' + JSON.stringify(nodes));

		const orders = nodes.find(n => n.id === 's::dbo.Orders');
		const lines = nodes.find(n => n.id === 's::dbo.OrderLines');
		check(!!orders && !!lines, 'both tables are there: ' + JSON.stringify(nodes));
		if (orders && lines) {
			// The direction of the layout is right: the table that holds the
			// foreign key comes before the one it references.
			check(lines.x < orders.x, 'the child table is on the left of its parent: ' + JSON.stringify(nodes));
			const overlap = lines.x < orders.x + orders.w && lines.x + lines.w > orders.x
				&& lines.y < orders.y + orders.h && lines.y + lines.h > orders.y;
			check(!overlap, 'the two tables do not overlap: ' + JSON.stringify(nodes));
		}

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		check.done();
		await p.close();
	});
});
