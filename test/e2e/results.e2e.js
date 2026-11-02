const { loadPlaywright, openPage, checker } = require('./harness');

const playwright = loadPlaywright();

suite('e2e: the result grid (progressive rows, JSON export, cell copy)', function () {
	this.timeout(120000);
	let browser;
	suiteSetup(async function () {
		if (!playwright) this.skip();
		browser = await playwright.chromium.launch();
	});
	suiteTeardown(async () => { if (browser) await browser.close(); });

	test('the grid shows more rows on request, exports JSON, copies a cell', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 760 });
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(150); };
		const rowCount = () => p.evaluate(() => document.querySelectorAll('.result-set-pane tbody tr').length);

		await post({ command: 'connectionStatus', success: true, message: 'ok' });
		await post({ command: 'databasesLoaded', databases: ['master'], currentDatabase: 'master' });
		const rows = Array.from({ length: 4500 }, (_, i) => ({ id: i + 1, name: `row ${i + 1}`, note: i % 3 === 0 ? null : 'x' }));
		await post({ command: 'queryResult', durationMs: 5, timeline: [], resultSets: [{ columns: ['id', 'name', 'note'], rows, totalRows: 4500 }] });

		check(await rowCount() === 2000, 'the first page is 2000 rows (' + await rowCount() + ')');
		await p.click('button[data-rs-action="more"]:not([data-rs-all])');
		check(await rowCount() === 4000, 'Show more draws the next page (' + await rowCount() + ')');
		await p.click('button[data-rs-action="more"]:not([data-rs-all])');
		check(await rowCount() === 4500 && !(await p.$('.truncation-note button[data-rs-action="more"]')), 'the last page ends the notice (' + await rowCount() + ')');

		await p.evaluate(() => { window.__sent.length = 0; });
		await p.click('button[data-rs-action="json"]');
		const sent = await p.evaluate(() => window.__sent);
		const exported = sent.find(m => m.command === 'exportJson');
		const parsed = exported ? JSON.parse(exported.json) : [];
		check(parsed.length === 4500 && parsed[0].id === 1 && parsed[0].note === null && parsed[1].note === 'x', 'the JSON export holds every row, NULL as null');
		check(exported && exported.defaultName === 'query-results.json', 'with a default file name');

		await p.evaluate(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async t => { window.__copied = t; } }, configurable: true }); });
		await p.dblclick('.result-set-pane tbody tr:nth-child(2) td:nth-child(2)');
		await p.waitForTimeout(100);
		check(await p.evaluate(() => window.__copied) === 'row 2', 'double-click copies the cell');

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		check.done();
		await p.close();
	});

	test('the editor formats the query, and opens find / replace', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 760 });
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(150); };
		await post({ command: 'connectionStatus', success: true, message: 'ok' });
		await post({ command: 'databasesLoaded', databases: ['master'], currentDatabase: 'master' });
		await p.click('[data-tab=query]');
		await p.evaluate(() => { document.getElementById('queryInput').value = 'select a,b from t where a=1'; });
		await p.click('#formatQueryBtn');
		const formatted = await p.evaluate(() => document.getElementById('queryInput').value);
		check(/^SELECT\n {4}a,\n {4}b\nFROM\n {4}t\nWHERE\n {4}a = 1$/.test(formatted), 'the button formats: ' + JSON.stringify(formatted));
		await p.evaluate(() => { document.getElementById('queryInput').value = 'select from where((('; });
		await p.click('#formatQueryBtn');
		check(await p.evaluate(() => document.getElementById('queryInput').value) === 'select from where(((', 'an unparseable text is left alone');
		await p.click('.cm-content');
		await p.keyboard.press('Control+h');
		check(await p.$('.cm-search') !== null, 'Ctrl+H opens find / replace');
		check(await p.$('.cm-search input[name=replace]') !== null, 'with a replace field');
		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		check.done();
		await p.close();
	});
});
