const { loadPlaywright, openPage, checker } = require('./harness');

const playwright = loadPlaywright();

suite('e2e: the top bar stays on one line', function () {
	this.timeout(120000);
	let browser;
	suiteSetup(async function () {
		if (!playwright) this.skip();
		browser = await playwright.chromium.launch();
	});
	suiteTeardown(async () => { if (browser) await browser.close(); });

	const WIDTHS = [800, 900, 1000, 1100, 1280, 1440, 1920];
	// From this width on the bar is one line; under it, the actions may go to a second line, whole.
	const SINGLE_LINE_FROM = { 'Query tab': 800, 'Query tab, schema from another connection': 1000, 'Explorer tab': 800 };

	// What the bar holds, per situation: the Query tab, the Query tab with the schema read from
	// another connection (two more selects), and the Explorer tab.
	const SITUATIONS = {
		'Query tab': async () => {},
		'Query tab, schema from another connection': async post => {
			await post({ command: 'schemaSources', ownName: 'PROD', activeName: 'DEV', sources: [{ name: 'PROD', server: 'prod-sql', database: 'AppDb', isOwn: true }, { name: 'DEV', server: 'localhost', database: 'AppDb_Dev', isOwn: false }] });
			await post({ command: 'schemaSourceChanged', active: true, activeName: 'DEV', schema: { name: 'DEV', server: 'localhost' }, run: { name: 'PROD', server: 'prod-sql' } });
			await post({ command: 'queryDatabases', databases: ['AdventureWorks'] });
		},
		'Explorer tab': async (post, p) => { await p.click('[data-tab=explorer]'); }
	};

	for (const [name, setup] of Object.entries(SITUATIONS)) {
		test(`${name}: one line from ${SINGLE_LINE_FROM[name]}px, never overlapping or cut`, async () => {
			const check = checker();
			for (const width of WIDTHS) {
				const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width, height: 420 });
				const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(60); };
				await post({ command: 'connectionStatus', success: true, message: 'ok' });
				await post({ command: 'databasesLoaded', databases: ['AdventureWorks'], currentDatabase: 'AdventureWorks' });
				await setup(post, p);
				await p.waitForTimeout(150);
				const bar = await p.evaluate(() => {
					const toolbar = document.querySelector('.app-toolbar');
					const box = toolbar.getBoundingClientRect();
					const items = [...toolbar.querySelectorAll('button, select, label, .tab-nav > *')]
						.filter(e => e.offsetParent && e.getBoundingClientRect().width > 0 && !e.closest('.query-tabs-dropdown'))
						.map(e => { const r = e.getBoundingClientRect(); return { id: e.id || e.className, left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
					const cut = items.filter(i => i.right > box.right + 1).map(i => i.id);
					// Two items side by side on one line must not cover each other.
					const overlapping = [];
					for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
						const x = items[a], y = items[b];
						const sameLine = Math.abs((x.top + x.bottom) / 2 - (y.top + y.bottom) / 2) < 10;
						const nested = (x.left <= y.left && x.right >= y.right) || (y.left <= x.left && y.right >= x.right);
						if (sameLine && !nested && Math.min(x.right, y.right) - Math.max(x.left, y.left) > 2) overlapping.push(`${x.id} / ${y.id}`);
					}
					return { height: Math.round(box.height), cut, overlapping };
				});
				if (width >= SINGLE_LINE_FROM[name]) check(bar.height <= 45, `${width}px: one line (height ${bar.height})`);
				check(bar.cut.length === 0, `${width}px: nothing cut off on the right: ${bar.cut.join(', ')}`);
				check(bar.overlapping.length === 0, `${width}px: nothing overlaps: ${bar.overlapping.join(' | ')}`);
				await p.close();
			}
			check.done();
		});
	}
});
