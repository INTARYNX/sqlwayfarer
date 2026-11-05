const fs = require('fs');
const path = require('path');
const { loadPlaywright, openPage, checker } = require('./harness');

// The Explorer on real data: the answers of the real handlers, captured from
// AdventureWorks (npm run e2e:fixtures). The structure of a table is wider
// than the panel that shows it - the panel has to scroll, not widen the page.

const playwright = loadPlaywright();
const EXPLORER = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'explorer.json'), 'utf8'));

suite('e2e: the Explorer on AdventureWorks data', function () {
	this.timeout(120000);
	let browser;
	suiteSetup(async function () {
		if (!playwright) this.skip();
		browser = await playwright.chromium.launch();
	});
	suiteTeardown(async () => { if (browser) await browser.close(); });

	for (const theme of ['dark', 'light']) {
		test(`${theme}: the structure of a wide table scrolls in its panel, it does not widen the page`, async () => {
			const check = checker();
			const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', theme, { width: 1100, height: 760 });
			const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(200); };
			await post({ command: 'connectionStatus', success: true, message: 'ok' });
			await post({ command: 'databasesLoaded', databases: ['AdventureWorks'], currentDatabase: 'AdventureWorks' });
			await p.click('.tab-button[data-tab=explorer]');
			await post(EXPLORER.find(m => m.command === 'objectsLoaded'));

			for (const details of EXPLORER.filter(m => m.command === 'tableDetailsLoaded')) {
				await p.evaluate(name => { appState.selectedObject = appState.allObjects.find(o => o.qualified_name === name) || appState.selectedObject; }, details.tableName);
				await post(details);
				const m = await p.evaluate(() => {
					const panel = document.querySelector('.details-panel').getBoundingClientRect();
					const list = document.querySelector('.selector-panel').getBoundingClientRect();
					return { overflow: document.documentElement.scrollWidth - window.innerWidth, panelRight: panel.right, listWidth: list.width, width: window.innerWidth };
				});
				check(m.overflow <= 0, `${details.tableName}: the page did not widen (${m.overflow}px too wide)`);
				check(m.panelRight <= m.width, `${details.tableName}: the details end inside the window (${m.panelRight} > ${m.width})`);
				check(m.listWidth >= 300, `${details.tableName}: the object list keeps its width (${Math.round(m.listWidth)}px)`);
			}
			check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
			await p.close();
			check.done();
		});
	}
});
