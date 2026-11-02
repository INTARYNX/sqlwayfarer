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

	test('a column is resized by dragging its header edge; sorting keeps the width, double-click resets', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 760 });
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(150); };
		await post({ command: 'connectionStatus', success: true, message: 'ok' });
		await post({ command: 'databasesLoaded', databases: ['master'], currentDatabase: 'master' });
		const rows = [{ id: 2, name: 'a long value that does not fit in a narrow column at all' }, { id: 1, name: 'b' }];
		await post({ command: 'queryResult', durationMs: 5, timeline: [], resultSets: [{ columns: ['id', 'name'], rows, totalRows: 2 }] });
		const width = col => p.evaluate(c => Math.round(document.querySelector(`.result-set-pane th[data-sort-col="${c}"]`).getBoundingClientRect().width), col);
		const before = await width('name');

		const box = await p.locator('th[data-sort-col="name"] .rs-resizer').boundingBox();
		await p.mouse.move(box.x + 3, box.y + 8);
		await p.mouse.down();
		await p.mouse.move(box.x - 77, box.y + 8, { steps: 5 });
		await p.mouse.up();
		const after = await width('name');
		check(after < before && after >= 40 && Math.abs(before - after - 80) <= 2, `dragging left narrows the column by the distance (${before} -> ${after})`);
		check(await p.evaluate(() => document.querySelector('.result-set-pane table').classList.contains('rs-fixed')), 'the table lays out by the widths');
		check(await p.evaluate(() => !document.querySelector('th.sorted')), 'the drag did not sort');
		check(await p.evaluate(() => { const t = document.querySelector('.result-set-pane table').getBoundingClientRect(); const w = document.querySelector('.result-set-pane .result-set-table-wrap').getBoundingClientRect(); return Math.abs(t.width - w.width) <= 1; }), 'the table still spans the whole grid (no blank on the right)');

		const idBefore = await width('id');
		await p.click('th[data-sort-col="id"]', { position: { x: 8, y: 8 } });
		check(await p.evaluate(() => !!document.querySelector('th.sorted')) && await width('name') === after && await width('id') === idBefore, 'sorting keeps the widths');

		const narrow = await p.locator('th[data-sort-col="name"] .rs-resizer').boundingBox();
		await p.mouse.move(narrow.x + 3, narrow.y + 8);
		await p.mouse.down();
		await p.mouse.move(narrow.x - after - 100, narrow.y + 8, { steps: 5 });
		await p.mouse.up();
		check(await width('name') === 40, 'a column never gets narrower than 40px (' + await width('name') + ')');
		check(await p.evaluate(() => { const td = document.querySelector('.result-set-pane tbody tr:last-child td:nth-child(2)'); return td.scrollWidth > td.clientWidth; }), 'a long value is cut in a narrow column');

		await p.dblclick('th[data-sort-col="name"] .rs-resizer');
		check(await p.evaluate(() => !document.querySelector('.result-set-pane table').classList.contains('rs-fixed')) && await width('name') > after, 'double-click gives the automatic widths back');
		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		check.done();
		await p.close();
	});

	test('a result set is scripted as a temp table in a new tab', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 760 });
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(150); };
		await post({ command: 'connectionStatus', success: true, message: 'ok' });
		await post({ command: 'databasesLoaded', databases: ['master'], currentDatabase: 'master' });
		const types = [{ sql: 'int', kind: 'number', nullable: false }, { sql: 'nvarchar(50)', kind: 'string', nullable: true }, { sql: 'datetime', kind: 'datetime', nullable: true }];
		const first = { columns: ['id', 'name', 'at'], types, rows: [{ id: 1, name: "O'Brien", at: '2026-11-02T20:00:15.540Z' }, { id: 2, name: null, at: null }], totalRows: 2 };
		const second = { columns: ['x'], rows: [{ x: 1.5 }], totalRows: 1 };
		await post({ command: 'queryResult', durationMs: 5, timeline: [], resultSets: [first, second] });
		const tabsBefore = await p.evaluate(() => document.getElementById('queryTabsCount') ? document.getElementById('queryTabsCount').textContent : '');
		check(await p.locator('.result-set-pane[data-rs-pane="0"] button[data-rs-action="temp"]').isVisible(), 'every result set has a #Temp button');

		await p.click('.result-set-pane[data-rs-pane="0"] button[data-rs-action="temp"]');
		const text = await p.evaluate(() => document.getElementById('queryInput') ? document.getElementById('queryInput').value : '');
		check(/CREATE TABLE #Results \(\n {4}\[id\] int NOT NULL,\n {4}\[name\] nvarchar\(50\) NULL,\n {4}\[at\] datetime NULL\n\);\nGO/.test(text), 'the new tab holds the CREATE TABLE with the real types: ' + JSON.stringify(text.slice(0, 200)));
		check(/\(1, N'O''Brien', '2026-11-02T20:00:15.540'\),\n\(2, NULL, NULL\);/.test(text), 'and the rows as INSERT values');
		check((await p.locator('#queryStatus').textContent()).includes('2 row(s) scripted as #Results in a new tab'), 'the status says what was done');
		const tabsAfter = await p.evaluate(() => document.getElementById('queryTabsCount') ? document.getElementById('queryTabsCount').textContent : '');
		check(tabsAfter !== tabsBefore, `a new tab was opened (${tabsBefore} -> ${tabsAfter})`);
		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		check.done();
		await p.close();
	});

	test('the column names pop-up: one per line, brackets, copy all or a selection', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 760 });
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(150); };
		await post({ command: 'connectionStatus', success: true, message: 'ok' });
		await post({ command: 'databasesLoaded', databases: ['master'], currentDatabase: 'master' });
		await post({ command: 'queryResult', durationMs: 5, timeline: [], resultSets: [{ columns: ['BusinessEntityID', 'FirstName', 'LastName'], rows: [{ BusinessEntityID: 1, FirstName: 'a', LastName: 'b' }], totalRows: 1 }] });
		await p.evaluate(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async t => { window.__copied = t; } }, configurable: true }); });
		const text = () => p.inputValue('#resultColumnsText');

		check(!(await p.locator('#resultColumnsModalOverlay').isVisible()), 'the pop-up is closed at first');
		await p.click('button[data-rs-action="columns"]');
		check(await p.locator('#resultColumnsModalOverlay').isVisible() && (await p.textContent('#resultColumnsModalTitle')) === 'Columns (3)', 'the icon opens it, with the count');
		check((await text()) === 'BusinessEntityID,\nFirstName,\nLastName', 'the names are one under the other, separated by commas: ' + JSON.stringify(await text()));
		await p.click('#resultColumnsCopyBtn');
		check(await p.evaluate(() => window.__copied) === 'BusinessEntityID,\nFirstName,\nLastName', 'Copy takes everything when nothing is selected');

		await p.evaluate(() => { const t = document.getElementById('resultColumnsText'); const s = t.value.indexOf('FirstName'); t.focus(); t.setSelectionRange(s, s + 'FirstName,'.length); });
		await p.click('#resultColumnsCopyBtn');
		check(await p.evaluate(() => window.__copied) === 'FirstName,', 'Copy takes the selected part when there is one');

		await p.check('#resultColumnsBrackets');
		check((await text()) === '[BusinessEntityID],\n[FirstName],\n[LastName]', 'the brackets option wraps the names');

		await p.keyboard.press('Escape');
		check(!(await p.locator('#resultColumnsModalOverlay').isVisible()), 'Escape closes it');
		await p.click('button[data-rs-action="columns"]');
		await p.mouse.click(5, 5);
		check(!(await p.locator('#resultColumnsModalOverlay').isVisible()), 'a click outside closes it');

		// A SELECT * on a wide table: the list scrolls inside the pop-up, from its first name.
		const wide = Array.from({ length: 200 }, (_, i) => `Column_${i + 1}`);
		await post({ command: 'queryResult', durationMs: 5, timeline: [], resultSets: [{ columns: wide, rows: [Object.fromEntries(wide.map((c, i) => [c, i]))], totalRows: 1 }] });
		await p.click('button[data-rs-action="columns"]');
		const box = await p.evaluate(() => { const t = document.getElementById('resultColumnsText'); const d = document.querySelector('.modal-dialog-result-columns').getBoundingClientRect(); return { scrolls: t.scrollHeight > t.clientHeight && getComputedStyle(t).overflowY === 'auto', top: t.scrollTop, fits: d.height <= innerHeight }; });
		check(box.scrolls && box.fits, 'a long list scrolls inside a pop-up that fits the window');
		check(box.top === 0, 'and opens on the first name');
		await p.keyboard.press('Escape');
		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		check.done();
		await p.close();
	});

	test('syntax errors are underlined on the line the server reported, only when the setting is on', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 760 });
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(150); };
		const checks = () => p.evaluate(() => window.__sent.filter(m => m.command === 'checkSyntax'));
		await post({ command: 'connectionStatus', success: true, message: 'ok' });
		await post({ command: 'databasesLoaded', databases: ['master'], currentDatabase: 'master' });
		await p.click('[data-tab=query]');
		await p.click('.cm-content');
		await p.keyboard.type('SELECT a,\nFROM t\nWHERE x = 1');
		await p.waitForTimeout(1000);
		check((await checks()).length === 0, 'with the setting off, the text is not sent anywhere');

		await post({ command: 'diagnosticsSettings', syntax: true });
		await p.waitForTimeout(1000);
		const sent = await checks();
		check(sent.length === 1 && sent[0].text === 'SELECT a,\nFROM t\nWHERE x = 1', 'switched on, the text is sent after the pause');

		await post({ command: 'syntaxResult', requestId: sent[0].requestId + 99, diagnostics: [{ line: 1, message: 'for another text', near: '' }] });
		check(await p.locator('.cm-lintRange-error').count() === 0, 'the answer to another request is ignored');
		await post({ command: 'syntaxResult', requestId: sent[0].requestId, diagnostics: [{ line: 2, message: "Incorrect syntax near the keyword 'FROM'.", near: 'FROM' }] });
		check(await p.locator('.cm-lintRange-error').count() === 1 && (await p.locator('.cm-lintRange-error').textContent()) === 'FROM', 'the word the server pointed at is underlined: ' + await p.locator('.cm-lintRange-error').allTextContents());
		await p.locator('.cm-lintRange-error').hover();
		await p.waitForTimeout(700);
		check((await p.locator('.cm-tooltip-lint').textContent()).includes("Incorrect syntax near the keyword 'FROM'."), 'hovering shows the server message');

		await post({ command: 'syntaxResult', requestId: sent[0].requestId, unavailable: true, diagnostics: [] });
		check(await p.locator('.cm-lintRange-error').count() === 1, 'a check that could not run leaves what is shown');
		await post({ command: 'syntaxResult', requestId: sent[0].requestId, diagnostics: [{ line: 3, message: 'second', near: '' }] });
		check(await p.locator('.cm-lintRange-error').count() === 1 && (await p.locator('.cm-lintRange-error').textContent()).includes('WHERE'), 'without a known word, the line is underlined');

		await p.evaluate(() => { window.__sent.length = 0; });
		await p.keyboard.press('Control+End');
		await p.keyboard.type(' AND y = 2');
		await p.waitForTimeout(1000);
		check((await checks()).length === 1, 'an edit sends the new text again');
		await post({ command: 'diagnosticsSettings', syntax: false });
		check(await p.locator('.cm-lintRange-error').count() === 0, 'switching the setting off clears the underlines');
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

	test('snippets with placeholders: fields to Tab through, the selection, the dropdown and the abbreviation', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 800 });
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(150); };
		const text = () => p.evaluate(() => document.getElementById('queryInput').value);
		await post({ command: 'connectionStatus', success: true, message: 'ok' });
		await post({ command: 'databasesLoaded', databases: ['master'], currentDatabase: 'master' });
		await p.click('[data-tab=query]');

		// Fields: the default of the first is selected, a linked one is typed once, $CURSOR$ is the last stop.
		await p.evaluate(() => {
			const ta = document.getElementById('queryInput');
			ta.value = '';
			ta.insertSnippet("DECLARE @d int = $Weeks$, @t varchar(10) = '$Day$'; -- $Day$\n$CURSOR$-- end", [{ id: 'Weeks', default: '0' }, { id: 'Day', default: '' }]);
		});
		check(await text() === "DECLARE @d int = 0, @t varchar(10) = ''; -- \n-- end", 'the defaults are in: ' + JSON.stringify(await text()));
		const sel = await p.evaluate(() => { const ta = document.getElementById('queryInput'); return [ta.selectionStart, ta.selectionEnd]; });
		check(sel[1] - sel[0] === 1, 'the first field is selected (' + sel + ')');
		await p.keyboard.type('5');
		await p.keyboard.press('Tab');
		await p.keyboard.type('Mon');
		check(await text() === "DECLARE @d int = 5, @t varchar(10) = 'Mon'; -- Mon\n-- end", 'Tab moves to the next field, a linked field is typed once: ' + JSON.stringify(await text()));
		await p.keyboard.press('Tab');
		await p.keyboard.type('X');
		check((await text()).endsWith("-- Mon\nX-- end"), 'the last Tab lands on $CURSOR$: ' + JSON.stringify(await text()));

		// The selection goes where $SELECTEDTEXT$ is.
		await p.evaluate(() => {
			const ta = document.getElementById('queryInput');
			ta.value = 'SELECT 1';
			ta.setSelectionRange(0, 8);
			ta.insertSnippet('SET SHOWPLAN_TEXT ON;\nGO\n$SELECTEDTEXT$\nGO\nSET SHOWPLAN_TEXT OFF;', []);
		});
		check(await text() === 'SET SHOWPLAN_TEXT ON;\nGO\nSELECT 1\nGO\nSET SHOWPLAN_TEXT OFF;', 'the selected text is wrapped: ' + JSON.stringify(await text()));

		// A snippet with braces and no marker is inserted as it is.
		await p.evaluate(() => { const ta = document.getElementById('queryInput'); ta.value = ''; ta.insertSnippet("SELECT '{a}', '${x}'", []); });
		check(await text() === "SELECT '{a}', '${x}'", 'braces are literal: ' + JSON.stringify(await text()));

		// The dropdown of the Query tab.
		await post({ command: 'snippetsLoaded', snippets: [{ name: 'Heading 1', abbreviation: 'LD_H1', description: 'A book heading', sql: '--$Section$\n$CURSOR$', placeholders: [{ id: 'Section', default: 'Title' }] }] });
		await p.evaluate(() => { document.getElementById('queryInput').value = ''; });
		await p.selectOption('#querySnippetsSelect', 'custom:Heading 1');
		check(await text() === '--Title\n', 'the dropdown expands it: ' + JSON.stringify(await text()));
		await p.keyboard.type('Intro');
		check(await text() === '--Intro\n', 'the field is replaced by what is typed: ' + JSON.stringify(await text()));

		// Typing the abbreviation offers it.
		await p.evaluate(() => { document.getElementById('queryInput').value = ''; });
		await p.click('.cm-content');
		await p.keyboard.type('LD_H');
		await p.keyboard.press('Control+Space');
		await p.waitForTimeout(250);
		const offered = await p.evaluate(() => [...document.querySelectorAll('.sql-autocomplete li')].map(li => li.textContent));
		check(offered.some(t => t.includes('LD_H1')), 'the abbreviation is offered: ' + offered.join(' | '));
		await p.keyboard.press('Enter');
		await p.waitForTimeout(150);
		check(await text() === '--Title\n', 'and expands with its fields: ' + JSON.stringify(await text()));

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		check.done();
		await p.close();
	});
});
