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

	test('the Index window has a Stats tab with the cost of the builds', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 800 });
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(150); };
		await post({ command: 'connectionStatus', success: true, message: 'ok' });
		await post({ command: 'databasesLoaded', databases: ['AppDb'], currentDatabase: 'AppDb' });
		await p.evaluate(() => { const s = document.getElementById('databaseSelect'); s.value = 'AppDb'; s.dispatchEvent(new Event('change')); });
		await p.waitForTimeout(200);
		await p.click('[data-tab=explorer]');
		await p.evaluate(() => { window.__sent.length = 0; });
		await p.evaluate(() => document.getElementById('objectsIndicatorBtn').removeAttribute('disabled'));
		await p.click('#objectsIndicatorBtn');
		check(await p.evaluate(() => document.getElementById('objectsModalOverlay').classList.contains('visible')), 'the Index window opens');
		check(await p.evaluate(() => document.getElementById('indexStatsContent').hidden), 'on the raw index first');
		await p.click('[data-index-view=stats]');
		const asked = await p.evaluate(() => window.__sent.map(m => m.command));
		check(asked.includes('getBuildStats'), 'the Stats tab asks for the statistics (' + asked + ')');

		await post({ command: 'buildStats', database: 'AppDb', markdown: '### report', runs: [] });
		check(/No build recorded yet/.test(await p.evaluate(() => document.getElementById('indexStatsContent').innerText)), 'no build: it says so');

		const run = { at: '2026-11-02T10:00:00.000Z', mode: 'full', durationMs: 15800, totalObjects: 122, analyzedObjects: 122, reusedObjects: 0, objectsPerSecond: 7.7, concurrency: 8,
			phases: { listObjectsMs: 40, analysisMs: 15600, saveMs: 90 }, cumulative: { queryMs: 60000, parseMs: 50000, scanMs: 1200, definitionChars: 400000 },
			perObjectMs: { p50: 300, p95: 1200, max: 2400 }, byType: [{ type: 'P', count: 10, totalMs: 9000, avgMs: 900, maxMs: 2400, definitionChars: 300000 }],
			slowest: [{ name: 'dbo.<b>uspHuge</b>', type: 'P', totalMs: 2400, queryMs: 400, parseMs: 1900, scanMs: 100, definitionChars: 80000, parseErrors: 0, depsFailed: false }],
			problems: { dependencyQueryFailed: 0, objectsWithParseErrors: 0 } };
		await post({ command: 'buildStats', database: 'AppDb', markdown: '### report', runs: [run, Object.assign({}, run, { mode: 'incremental' })] });
		const text = await p.evaluate(() => document.getElementById('indexStatsContent').innerText);
		check(/16 s/.test(text) && /122 \/ 122/.test(text) && /Where the time went/.test(text) && /T-SQL parser/.test(text) && /Slowest objects/.test(text) && /uspHuge/.test(text) && /Previous builds/.test(text), 'the figures are shown: ' + text.slice(0, 200));
		check(await p.evaluate(() => !document.querySelector('#indexStatsContent b')), 'object names are escaped');
		check(await p.evaluate(() => document.getElementById('objectsJsonContent').hidden), 'the raw index is hidden meanwhile');

		await p.evaluate(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async t => { window.__copied = t; } }, configurable: true }); });
		await p.click('[data-index-stats-action=copy]');
		check(await p.evaluate(() => window.__copied) === '### report', 'Copy report puts the Markdown on the clipboard');

		await p.click('[data-index-view=json]');
		check(await p.evaluate(() => document.getElementById('indexStatsContent').hidden), 'back to the raw index');
		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		check.done();
		await p.close();
	});
});
