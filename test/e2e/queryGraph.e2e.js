const fs = require('fs');
const path = require('path');
const { loadPlaywright, openPage, checker } = require('./harness');

// The query graph of a real query (the answer of the real handler, captured
// from AdventureWorks - npm run e2e:fixtures): the condition written on a join
// has to be readable, not hidden behind the tables it joins.

const playwright = loadPlaywright();
const GRAPH = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'explorer.json'), 'utf8')).find(m => m.command === 'queryGraphResult');

suite('e2e: the query graph on AdventureWorks data', function () {
	this.timeout(120000);
	let browser;
	suiteSetup(async function () {
		if (!playwright) this.skip();
		browser = await playwright.chromium.launch();
	});
	suiteTeardown(async () => { if (browser) await browser.close(); });

	test('the condition of a join is not hidden behind the tables', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 760 });
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(300); };
		await post({ command: 'connectionStatus', success: true, message: 'ok' });
		await post({ command: 'databasesLoaded', databases: ['AdventureWorks'], currentDatabase: 'AdventureWorks' });
		await p.evaluate(() => window.footprintManager.openQueryGraph('select 1'));
		await post(GRAPH);

		const covered = await p.evaluate(() => {
			const cy = window.footprintManager._cy;
			const out = [];
			cy.edges().forEach(edge => {
				const label = edge.boundingBox({ includeNodes: false, includeEdges: false, includeLabels: true, includeMainLabels: true, includeOverlays: false });
				cy.nodes().forEach(node => {
					const box = node.boundingBox({ includeLabels: false, includeOverlays: false });
					const overlap = label.x1 < box.x2 && label.x2 > box.x1 && label.y1 < box.y2 && label.y2 > box.y1;
					if (overlap) out.push(`${edge.data('label')} / ${node.data('name')}`);
				});
			});
			return { out, edges: cy.edges().length };
		});
		check(covered.edges === 2, `the query has two joins (${covered.edges})`);
		check(covered.out.length === 0, `a condition is hidden behind a table: ${covered.out.join(' | ')}`);
		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		await p.close();
		check.done();
	});
});
