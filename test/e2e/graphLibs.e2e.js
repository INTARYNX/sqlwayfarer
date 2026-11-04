const { loadPlaywright, openPage, checker } = require('./harness');

const playwright = loadPlaywright();

suite('e2e: the graph libraries', function () {
	this.timeout(120000);
	let browser;
	suiteSetup(async function () {
		if (!playwright) this.skip();
		browser = await playwright.chromium.launch();
	});
	suiteTeardown(async () => { if (browser) await browser.close(); });

	test('the footprint graph libraries come with the page, Viz.js only when a graph is drawn', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark');
		check(await p.evaluate(() => typeof window.cytoscape === 'function' && typeof window.cytoscapeDagre === 'function'), 'cytoscape and its dagre layout are there');
		check(await p.evaluate(() => typeof window.Viz === 'undefined'), 'Viz.js is not loaded with the page');
		check(await p.evaluate(() => !document.querySelector('script[src*="viz"]')), 'no Viz.js script tag at the start');

		const drawn = await p.evaluate(async () => {
			const visualizer = new DependencyVisualizer();
			await visualizer.initViz();
			await visualizer.initViz();
			const svg = await visualizer.viz.renderSVGElement('digraph { a -> b }');
			return { svg: svg.tagName.toLowerCase(), scripts: document.querySelectorAll('script[src*="viz"]').length };
		});
		check(drawn.svg === 'svg', 'a graph is drawn once loaded');
		check(drawn.scripts === 2, `loaded once, not once per call (${drawn.scripts} script tags)`);
		check(p.errors.length === 0, `no page error: ${p.errors.join(' | ')}`);
		await p.close();
		check.done();
	});
});
