const { loadPlaywright, openPage, post, checker } = require('./harness');

const playwright = loadPlaywright();

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
	doc: { tables: [
		{ qualifiedName: 'dbo.Orders', description: '', columns: [], primaryKey: ['OrderID'], foreignKeys: [{ column: 'CustomerID', refTable: 'dbo.Customers' }] },
		{ qualifiedName: 'dbo.Customers', description: '', columns: [], primaryKey: ['CustomerID'], foreignKeys: [] }
	] }
};
// A table and a non-table object, so Add table can prove it offers only tables.
const OBJECTS = {
	command: 'objectsLoaded', database: 'master',
	objects: [
		{ qualified_name: 'dbo.Orders', object_name: 'Orders', name: 'Orders', object_type: 'Table' },
		{ qualified_name: 'dbo.Customers', object_name: 'Customers', name: 'Customers', object_type: 'Table' },
		{ qualified_name: 'dbo.Suppliers', object_name: 'Suppliers', name: 'Suppliers', object_type: 'Table' },
		{ qualified_name: 'dbo.pGetOrders', object_name: 'pGetOrders', name: 'pGetOrders', object_type: 'Procedure' }
	]
};
const REL_AMONG = {
	command: 'relationshipsAmongResult', success: true,
	relationships: [
		{ fkName: 'FK_Orders_Customers', fromTable: 'dbo.Orders', toTable: 'dbo.Customers' },
		{ fkName: 'FK_Orders_Suppliers', fromTable: 'dbo.Orders', toTable: 'dbo.Suppliers' }
	]
};
const DOC_SUPPLIERS = {
	command: 'footprintDocResult', success: true,
	doc: { tables: [{ qualifiedName: 'dbo.Suppliers', description: '', columns: [], primaryKey: ['SupplierID'], foreignKeys: [] }] }
};

async function nodeScreenPos(p, id) {
	return p.evaluate((nodeId) => {
		const n = window.footprintManager._schemaCy.getElementById(nodeId);
		const rb = n.renderedBoundingBox();
		const r = document.getElementById('footprintSchemaGraph').getBoundingClientRect();
		return { x: r.left + (rb.x1 + rb.x2) / 2, y: r.top + (rb.y1 + rb.y2) / 2 };
	}, id);
}

// The tables of the Schema tab are placed by ELK, asynchronously: the graph
// has to be laid out before its zoom level and its node positions mean
// anything. The pane stays pending until the layout is applied.
const waitForLayout = (p) => p.waitForFunction(
	() => !document.getElementById('footprintSchemaGraph').classList.contains('fp-layout-pending'),
	null, { timeout: 60000 }
);

suite('e2e: Schema tab graph controls (zoom, context menu, add table, fullscreen)', function () {
	this.timeout(120000);
	let browser;
	suiteSetup(async function () {
		if (!playwright) this.skip();
		browser = await playwright.chromium.launch();
	});
	suiteTeardown(async () => { if (browser) await browser.close(); });

	test('zoom in/out/fit, a node\'s context menu, Add table (with FK discovery), Remove from view, and Maximize', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 760 });
		await post(p, { command: 'connectionStatus', success: true, message: 'ok' });
		await post(p, { command: 'databasesLoaded', databases: ['master'], currentDatabase: 'master' });
		await post(p, OBJECTS);
		await p.evaluate(() => window.footprintManager.openQueryGraph('select 1'));
		await post(p, QUERY_GRAPH);
		await p.click('.fp-tab[data-fptab="schema"]');
		await post(p, DOC_SEEDS);
		await waitForLayout(p);

		// --- Zoom in / out / fit ---
		const zoomOf = () => p.evaluate(() => window.footprintManager._schemaCy.zoom());
		const z0 = await zoomOf();
		await p.click('.graph-zoom-controls[data-for="schema"] [data-zoom-action="in"]');
		const z1 = await zoomOf();
		check(z1 > z0, `zoom in increases the zoom level (${z0} -> ${z1})`);
		await p.click('.graph-zoom-controls[data-for="schema"] [data-zoom-action="out"]');
		const z2 = await zoomOf();
		check(z2 < z1, `zoom out decreases it again (${z1} -> ${z2})`);
		await p.click('.graph-zoom-controls[data-for="schema"] [data-zoom-action="fit"]');
		const z3 = await zoomOf();
		check(Math.abs(z3 - z0) < 0.01, `fit (nothing selected) restores the fitted zoom (${z0} vs ${z3})`);

		// --- Context menu: a seed table cannot be removed ---
		const ordersPos = await nodeScreenPos(p, 's::dbo.Orders');
		await p.mouse.click(ordersPos.x, ordersPos.y, { button: 'right' });
		const seedMenu = await p.$$eval('.script-menu-item', els => els.map(e => e.textContent));
		check(JSON.stringify(seedMenu) === JSON.stringify(['Zoom to this table', 'Reveal in Explorer']),
			'a seed table\'s context menu has no Remove from view: ' + JSON.stringify(seedMenu));
		// Dismiss by clicking empty graph space.
		await p.mouse.click(ordersPos.x + 150, ordersPos.y + 150);

		// --- Add table: only tables, and only ones not already shown ---
		await p.click('#footprintAddTableBtn');
		const candidates = await p.$$eval('.script-menu-item', els => els.map(e => e.textContent));
		check(JSON.stringify(candidates) === JSON.stringify(['dbo.Suppliers']),
			'Add table offers only tables not already on screen: ' + JSON.stringify(candidates));
		await p.click('.script-menu-item:has-text("Suppliers")');

		const sent = await p.evaluate(() => window.__sent);
		const relReq = sent.find(m => m.command === 'getRelationshipsAmong');
		check(!!relReq && JSON.stringify(relReq.tableNames.slice().sort()) === JSON.stringify(['dbo.Customers', 'dbo.Orders', 'dbo.Suppliers']),
			'getRelationshipsAmong is asked for the whole set now shown: ' + JSON.stringify(relReq && relReq.tableNames));
		await post(p, REL_AMONG);
		await post(p, DOC_SUPPLIERS);
		await waitForLayout(p);

		const kinds = await p.evaluate(() => {
			const cy = window.footprintManager._schemaCy;
			return Object.fromEntries(cy.nodes().map(n => [n.id().replace(/^s::/, ''), n.data('kind')]));
		});
		check(kinds['dbo.Suppliers'] === 'added', 'the added table is kind "added": ' + JSON.stringify(kinds));
		const edgeLabels = await p.evaluate(() => window.footprintManager._schemaCy.edges().map(e => e.data('label')));
		check(edgeLabels.includes('FK_Orders_Suppliers'), 'the new FK to the added table is drawn: ' + JSON.stringify(edgeLabels));
		check(edgeLabels.includes('FK_Orders_Customers'), 'the original FK is still drawn too (relationshipsAmong supersedes it): ' + JSON.stringify(edgeLabels));

		// --- Context menu: an added table CAN be removed ---
		const supPos = await nodeScreenPos(p, 's::dbo.Suppliers');
		await p.mouse.click(supPos.x, supPos.y, { button: 'right' });
		const addedMenu = await p.$$eval('.script-menu-item', els => els.map(e => e.textContent));
		check(JSON.stringify(addedMenu) === JSON.stringify(['Zoom to this table', 'Reveal in Explorer', 'Remove from view']),
			'an added table\'s context menu offers Remove from view: ' + JSON.stringify(addedMenu));
		await p.click('.script-menu-item:has-text("Remove from view")');
		const stillThere = await p.evaluate(() => !!window.footprintManager._schemaCy.getElementById('s::dbo.Suppliers').length);
		check(!stillThere, 'the removed table is gone from the graph');

		// --- Maximize: full window by default, the button restores/re-maximizes ---
		check(await p.evaluate(() => document.querySelector('.modal-dialog-footprint').classList.contains('fp-maximized')),
			'maximized by default on open');
		await p.click('#footprintMaximizeBtn');
		check(await p.evaluate(() => !document.querySelector('.modal-dialog-footprint').classList.contains('fp-maximized')),
			'clicking Maximize restores the normal size');
		await p.click('#footprintMaximizeBtn');
		check(await p.evaluate(() => document.querySelector('.modal-dialog-footprint').classList.contains('fp-maximized')),
			'clicking it again re-maximizes');

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		check.done();
		await p.close();
	});
});
