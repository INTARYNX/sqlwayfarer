const { loadPlaywright, openPage, checker } = require('./harness');

const playwright = loadPlaywright();

suite('e2e: the dependency index is never built on its own', function () {
	this.timeout(120000);
	let browser;
	suiteSetup(async function () {
		if (!playwright) this.skip();
		browser = await playwright.chromium.launch();
	});
	suiteTeardown(async () => { if (browser) await browser.close(); });

	for (const theme of ['dark', 'light']) {
		test(`status only, notice, explicit build, stale update (${theme})`, async () => {
			const check = checker();

			const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', theme, { width: 1100, height: 760 });
			const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(100); };
			const sent = () => p.evaluate(() => window.__sent);
			const cmds = async () => (await sent()).map(m => m.command);
			const clear = () => p.evaluate(() => { window.__sent.length = 0; });
			const noticeVisible = () => p.evaluate(() => { const n = document.getElementById('indexNotice'); return !n.hidden && getComputedStyle(n).display !== 'none'; });
			const dot = () => p.evaluate(() => document.getElementById('objectsIndicatorDot').className);
			const locked = () => p.evaluate(() => document.querySelector('.explorer-section').classList.contains('locked'));

			await post({ command: 'connectionStatus', success: true, message: 'ok' });
			await post({ command: 'databasesLoaded', databases: ['AppDb'], currentDatabase: 'AppDb' });
			await p.evaluate(() => { const s = document.getElementById('databaseSelect'); s.value = 'AppDb'; s.dispatchEvent(new Event('change')); });
			await p.waitForTimeout(150);
			check(!(await cmds()).includes('getIndex'), theme + ': choosing a database does not index');
			await post({ command: 'objectsLoaded', objects: [{ name: 'T', object_name: 'T', schema_name: 'dbo', qualified_name: 'dbo.T', object_type: 'Table' }] });
			check(!(await locked()), theme + ': the explorer is usable without an index');

			await clear();
			await p.click('[data-tab=explorer]'); await p.waitForTimeout(200);
			const c1 = await cmds();
			check(c1.includes('getIndexStatus') && !c1.includes('getIndex') && !c1.includes('loadIndex'), theme + ': opening Explorer only asks for the status (' + c1 + ')');

			await post({ command: 'indexStatus', database: 'AppDb', state: 'none' });
			check(await noticeVisible(), theme + ': a notice explains and offers the choice');
			const text = await p.evaluate(() => document.getElementById('indexNotice').innerText);
			check(/not built/i.test(text) && /only runs when you ask/i.test(text) && /Build index/.test(text) && /Not now/.test(text), theme + ': it says what the index is, what it costs, and offers both buttons');
			check((await dot()).includes('dot-none'), theme + ': the dot is neutral');

			await p.click('[data-index-action=dismiss]');
			check(!(await noticeVisible()), theme + ': "Not now" hides it');
			check(!(await cmds()).includes('getIndex'), theme + ': and still nothing is built');

			await clear(); await p.click('[data-tab=query]'); await p.click('[data-tab=explorer]'); await p.waitForTimeout(200);
			await post({ command: 'indexStatus', database: 'AppDb', state: 'none' });
			check(!(await noticeVisible()), theme + ': it stays away for this database');

			await p.evaluate(() => window.objectsTabManager._dismissed.clear());
			await post({ command: 'indexStatus', database: 'AppDb', state: 'none' });
			await clear();
			await p.click('[data-index-action=build]'); await p.waitForTimeout(150);
			const c2 = await sent();
			check(c2.filter(m => m.command === 'getIndex').length === 1 && c2.find(m => m.command === 'getIndex').database === 'AppDb', theme + ': "Build index" asks for exactly one build');
			check(!(await noticeVisible()) && (await dot()).includes('dot-indexing') && await locked(), theme + ': and shows it is working');
			await post({ command: 'indexingStarted', database: 'AppDb', forced: false });
			check(await p.evaluate(() => document.getElementById('indexingModalOverlay').classList.contains('visible')), theme + ': the progress window opens at once');
			await post({ command: 'indexResult', indexData: { database: 'AppDb', totalObjects: 1, objects: {} }, database: 'AppDb' });
			check(!(await noticeVisible()) && (await dot()).includes('dot-ready') && !(await locked()), theme + ': done: ready, unlocked');
			check(!(await p.evaluate(() => document.getElementById('indexingModalOverlay').classList.contains('visible'))), theme + ': progress window closed');

			await clear();
			await p.click('[data-tab=query]'); await p.click('[data-tab=explorer]'); await p.waitForTimeout(200);
			await post({ command: 'indexStatus', database: 'AppDb', state: 'stale', builtAt: '2026-10-01T10:00:00Z', totalObjects: 1 });
			check(await noticeVisible() && /out of date/.test(await p.evaluate(() => document.getElementById('indexNotice').innerText)) && /Update index/.test(await p.evaluate(() => document.getElementById('indexNotice').innerText)), theme + ': a stale index offers an update, nothing automatic');
			check((await dot()).includes('dot-stale'), theme + ': amber dot');
			check(!(await cmds()).includes('getIndex'), theme + ': a stale index is not updated by itself');
			await post({ command: 'indexStatus', database: 'AppDb', state: 'stale', builtAt: '2026-10-01T10:00:00Z', totalObjects: 3, changes: { modified: ['dbo.vOrders', 'dbo.<b>x</b>'], added: ['dbo.vNew'], removed: ['dbo.vGone'] } });
			const changesText = await p.evaluate(() => (document.querySelector('#indexNotice .index-changes') || { innerText: '' }).textContent);
			check(/4 objects to re-analyze/.test(changesText) && /dbo\.vOrders/.test(changesText) && /dbo\.vNew/.test(changesText) && /dbo\.vGone/.test(changesText), theme + ': the stale notice lists the objects to re-analyze');
			check(await p.evaluate(() => !document.querySelector('#indexNotice .index-changes b')), theme + ': object names are escaped');

			await post({ command: 'indexStatus', database: 'AppDb', state: 'ready', builtAt: '2026-11-01T10:00:00Z', totalObjects: 1 });
			check(!(await noticeVisible()), theme + ': an up to date index shows no notice');

			await post({ command: 'indexStatus', database: 'AppDb', state: 'none' });
			await p.evaluate(() => { window.objectsTabManager._dismissed.clear(); });
			check(await p.evaluate(() => window.explorerManager.indexMissingHtml()).then(h => /Build index/.test(h)), theme + ': empty dependency results say the index is missing');
			await post({ command: 'indexStatus', database: 'AppDb', state: 'ready', totalObjects: 1 });
			check((await p.evaluate(() => window.explorerManager.indexMissingHtml())) === '', theme + ': ...but not when it is built');

			await clear();
			await post({ command: 'indexingCompleted', database: 'AppDb', success: true, forced: true, message: 'ok' });
			const c3 = await cmds();
			check(c3.includes('loadIndex') && !c3.includes('getIndex'), theme + ': after a force reindex the result is read, not rebuilt (' + c3 + ')');
			check(p.errors.length === 0, theme + ': no page errors ' + p.errors.join('|'));
			await p.close();
	
			check.done();
		});
	}
});
