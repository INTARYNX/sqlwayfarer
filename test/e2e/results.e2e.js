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

	test('the schema can be plugged on another connection: banner, Run on, queries stay on the run side', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 800 });
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(150); };
		const sent = () => p.evaluate(() => window.__sent);
		const visible = sel => p.evaluate(s => { const e = document.querySelector(s); return !!e && !e.hidden && getComputedStyle(e).display !== 'none'; }, sel);

		await post({ command: 'connectionStatus', success: true, message: 'ok' });
		check((await sent()).some(m => m.command === 'getSchemaSources'), 'a connection asks where the schema can come from');
		check(!(await visible('#schemaSourceWrap')), 'no other connection: no selector');
		await post({ command: 'schemaSources', ownName: 'PROD', activeName: null, sources: [{ name: 'PROD', server: 'prod-sql', database: 'AppDb', isOwn: true }, { name: 'DEV', server: 'localhost', database: 'AppDb', isOwn: false }] });
		check(await visible('#schemaSourceWrap'), 'another saved connection: the selector appears');
		check(!(await visible('#sourceBanner')), 'no banner while the schema comes from the run connection');
		check(!(await visible('#queryDatabaseWrap')), 'and no "Run on"');

		await p.evaluate(() => { window.__sent.length = 0; });
		await p.selectOption('#schemaSourceSelect', 'DEV');
		check((await sent()).some(m => m.command === 'selectSchemaSource' && m.name === 'DEV'), 'choosing DEV asks the extension to plug it');

		await post({ command: 'schemaSourceChanged', active: true, activeName: 'DEV', schema: { name: 'DEV', server: 'localhost' }, run: { name: 'PROD', server: 'prod-sql' } });
		check(await visible('#sourceBanner'), 'the banner appears');
		const banner = await p.evaluate(() => document.getElementById('sourceBanner').innerText);
		check(/Schema: DEV/.test(banner) && /localhost/.test(banner) && /Queries run on: PROD/.test(banner) && /prod-sql/.test(banner), 'it names both sides: ' + banner.replace(/\n/g, ' | '));
		const runColor = await p.evaluate(() => getComputedStyle(document.querySelector('.source-banner-run')).color);
		const schemaColor = await p.evaluate(() => getComputedStyle(document.querySelector('.source-banner-schema')).color);
		check(runColor !== schemaColor, 'the run side stands out (' + runColor + ' vs ' + schemaColor + ')');
		check(/Use PROD for the schema/.test(await p.evaluate(() => document.getElementById('sourceBannerReset').textContent)), 'with a way back');
		check(await visible('#queryDatabaseWrap'), '"Run on" appears');
		check((await sent()).some(m => m.command === 'getQueryDatabases'), 'the databases of the run side are requested');

		await post({ command: 'databasesLoaded', databases: ['AppDb', 'AppDb_Dev'] });
		await p.evaluate(() => { const s = document.getElementById('databaseSelect'); s.value = 'AppDb'; s.dispatchEvent(new Event('change')); });
		await post({ command: 'queryDatabases', databases: ['AppDb', 'Other'] });
		check(await p.evaluate(() => document.getElementById('queryDatabaseSelect').value) === 'AppDb', 'the same database name on the run side is taken');

		await p.click('[data-tab=query]');
		await p.evaluate(() => { document.getElementById('queryInput').value = 'SELECT 1'; window.__sent.length = 0; });
		await p.evaluate(() => window.queryManager.runQuery());
		let run = (await sent()).find(m => /query/i.test(m.command) && m.database !== undefined);
		check(run && run.database === 'AppDb', 'the query runs on the run side: ' + JSON.stringify(run && { c: run.command, d: run.database }));

		await p.selectOption('#queryDatabaseSelect', 'Other');
		await p.evaluate(() => { window.__sent.length = 0; window.queryManager.setRunning(false); window.queryManager.runQuery(); });
		run = (await sent()).find(m => /query/i.test(m.command) && m.database !== undefined);
		check(run && run.database === 'Other', 'and follows "Run on": ' + JSON.stringify(run && { c: run.command, d: run.database }));

		await p.evaluate(() => { window.__sent.length = 0; });
		await p.click('#sourceBannerReset');
		check((await sent()).some(m => m.command === 'selectSchemaSource' && m.name === ''), 'the banner button goes back to the run connection');
		await post({ command: 'schemaSourceChanged', active: false, activeName: null, schema: null, run: { name: 'PROD', server: 'prod-sql' } });
		check(!(await visible('#sourceBanner')) && !(await visible('#queryDatabaseWrap')), 'banner and "Run on" go away');
		check(await p.evaluate(() => document.getElementById('schemaSourceSelect').value) === '', 'the selector is back on this connection');

		await post({ command: 'schemaSourceChanged', active: false, activeName: null, error: "Could not connect to 'DEV': login failed" });
		check(/Could not connect to 'DEV'/.test(await p.evaluate(() => document.getElementById('queryStatus') ? document.getElementById('queryStatus').innerText : document.body.innerText)), 'a failed connection says so');
		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		check.done();
		await p.close();
	});
});
