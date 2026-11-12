const { loadPlaywright, openPage: openWebview, checker } = require('./harness');

// The open queries of the Query tab: the sub-tabs, the drafts that survive a
// crash, and the files of the workspace. Nothing of this had a test until now:
// the file that owns it is the largest of the webview, and none of its
// behaviours was exercised.

const playwright = loadPlaywright();

suite('e2e: the open queries (tabs), the drafts and the files', function () {
	this.timeout(120000);
	let browser;
	suiteSetup(async function () {
		if (!playwright) this.skip();
		browser = await playwright.chromium.launch();
	});
	suiteTeardown(async () => { if (browser) await browser.close(); });

	// A page with a connection and a database selected.
	async function openPage() {
		const p = await openWebview(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1200, height: 800 });
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(80); };
		await post({ command: 'connectionStatus', success: true, message: 'ok' });
		await post({ command: 'databasesLoaded', databases: ['master', 'AppDb'], currentDatabase: 'AppDb' });
		return p;
	}

	const sent = p => p.evaluate(() => window.__sent);
	const editorText = p => p.evaluate(() => window.queryManager.input.value);
	const tabs = p => p.evaluate(() => window.queryFileManager.tabs.map(t => ({
		id: t.id, fileName: t.fileName || null, content: t.content, database: t.database
	})));
	const activeId = p => p.evaluate(() => window.queryFileManager.activeTabId);

	// Types in the editor and lets the page catch up.
	async function type(p, text) {
		await p.click('.cm-content');
		await p.keyboard.type(text, { delay: 10 });
		await p.waitForTimeout(120);
	}

	test('each tab keeps its own text', async () => {
		const check = checker();
		const p = await openPage();

		await type(p, 'SELECT 1');
		// The "+" of the Query tab opens a new draft.
		await p.click('#queryTabsBtn');
		await p.click('[data-qtab-add]');
		await p.waitForTimeout(120);
		check((await tabs(p)).length === 2, 'a second tab is open');
		check((await editorText(p)) === '', 'the new tab is empty');

		await type(p, 'SELECT 2');
		// Back to the first tab: its text must still be there.
		await p.evaluate(() => window.queryFileManager.switchTab(window.queryFileManager.tabs[0].id));
		await p.waitForTimeout(120);
		check((await editorText(p)) === 'SELECT 1', 'the first tab kept its text (' + (await editorText(p)) + ')');

		// And forward again.
		await p.evaluate(() => window.queryFileManager.switchTab(window.queryFileManager.tabs[1].id));
		await p.waitForTimeout(120);
		check((await editorText(p)) === 'SELECT 2', 'the second tab kept its text (' + (await editorText(p)) + ')');

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		await p.close();
		check.done();
	});

	test('the Save button follows what is in the editor, and an empty draft has nothing to save', async () => {
		const check = checker();
		const p = await openPage();

		const saveEnabled = () => p.evaluate(() => !document.getElementById('saveQueryFileBtn').disabled);
		check(!(await saveEnabled()), 'an empty draft has nothing to save');

		await type(p, 'SELECT 1');
		check(await saveEnabled(), 'a draft with text can be saved');

		// Ctrl+S on a draft asks for a name.
		await p.keyboard.press('Control+s');
		await p.waitForTimeout(150);
		const messages = await sent(p);
		check(messages.some(m => m.command === 'saveSqlFileAs'), 'Ctrl+S asks where to save the draft');

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		await p.close();
		check.done();
	});

	test('a draft that was saved is a file: Save is off until a change, then writes to that file', async () => {
		const check = checker();
		const p = await openPage();
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(100); };
		const saveEnabled = () => p.evaluate(() => !document.getElementById('saveQueryFileBtn').disabled);

		await type(p, 'SELECT 1');
		await p.keyboard.press('Control+s');
		await p.waitForTimeout(100);
		await post({ command: 'sqlFileSavedAs', success: true, path: '/w/draft-1.sql', name: 'draft-1.sql' });
		check((await sent(p)).some(m => m.command === 'listSqlFiles'), 'the Files list is read again, the new file shows in it');
		check(!(await saveEnabled()), 'saved: nothing left to save');
		check((await p.evaluate(() => document.getElementById('queryStateDot').dataset.queryState)) === 'saved', 'the dot says saved');

		await type(p, ' + 1');
		check(await saveEnabled(), 'a change enables Save');
		await p.click('#saveQueryFileBtn');
		await p.waitForTimeout(100);
		const save = (await sent(p)).filter(m => m.command === 'saveSqlFile').pop();
		check(save && save.path === '/w/draft-1.sql', 'Save writes to the file, no dialog (' + JSON.stringify(save) + ')');

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		await p.close();
		check.done();
	});

	test('each tab keeps its own results, and the answer of a run goes to the tab that ran it', async () => {
		const check = checker();
		const p = await openPage();
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(100); };
		const set = value => ({ columns: ['v'], rows: [{ v: value }], totalRows: 1 });
		const grid = () => p.evaluate(() => document.getElementById('queryResultsContainer').textContent);
		const status = () => p.evaluate(() => document.getElementById('queryStatus').textContent);

		await type(p, "select 'A'");
		await p.click('#runQueryBtn');
		await post({ command: 'queryResult', durationMs: 5, timeline: [], resultSets: [set('result-A')] });
		check((await grid()).includes('result-A'), 'the first tab shows its result');
		const statusA = await status();

		await p.evaluate(() => window.queryFileManager.addDraftTab());
		await p.waitForTimeout(100);
		check(!(await grid()).includes('result-A') && (await grid()).includes('Run a query'), 'a new tab starts with an empty pane');

		// A run started here, left for another tab, answers into its own tab.
		await type(p, "select 'B'");
		await p.click('#runQueryBtn');
		await p.evaluate(() => window.queryFileManager.switchTab(window.queryFileManager.tabs[0].id));
		await p.waitForTimeout(100);
		check((await grid()).includes('result-A') && (await status()) === statusA, 'back on the first tab: its result and its status');
		await post({ command: 'queryResult', durationMs: 5, timeline: [], resultSets: [set('result-B')] });
		check((await grid()).includes('result-A') && !(await grid()).includes('result-B'), 'the late answer did not land on the tab on screen');
		await p.evaluate(() => window.queryFileManager.switchTab(window.queryFileManager.tabs[1].id));
		await p.waitForTimeout(100);
		check((await grid()).includes('result-B'), 'it is in the tab that ran it');

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		await p.close();
		check.done();
	});

	test('the list of the other queries starts with the one used last', async () => {
		const check = checker();
		const p = await openPage();
		const names = () => p.evaluate(() => [...document.querySelectorAll('.query-tabs-dropdown-item .qtab-name')].map(n => n.textContent));
		await type(p, 'select 1');
		await p.evaluate(() => { window.queryFileManager.addDraftTab(); });
		await type(p, 'select 2');
		await p.evaluate(() => { window.queryFileManager.addDraftTab(); });
		await type(p, 'select 3');
		// Use the first, then the third: the list, from the second one's point of view, is 3 / 1.
		await p.evaluate(() => window.queryFileManager.switchTab(window.queryFileManager.tabs[0].id));
		await p.evaluate(() => window.queryFileManager.switchTab(window.queryFileManager.tabs[2].id));
		await p.evaluate(() => window.queryFileManager.switchTab(window.queryFileManager.tabs[1].id));
		await p.evaluate(() => window.queryFileManager.openTabsDropdown());
		const list = await names();
		check(JSON.stringify(list) === JSON.stringify(['select 3', 'select 1']), 'most recently used first (' + list + ')');
		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		await p.close();
		check.done();
	});

	test('the list of the queries and the list of the objects are never open together', async () => {
		const check = checker();
		const p = await openPage();
		const open = () => p.evaluate(() => ({
			query: document.getElementById('queryTabsDropdown').classList.contains('visible'),
			explorer: document.getElementById('explorerTabsDropdown').classList.contains('visible')
		}));
		await p.click('#queryTabsBtn');
		check(JSON.stringify(await open()) === '{"query":true,"explorer":false}', 'the Query list opens');
		await p.click('#explorerTabsBtn');
		check(JSON.stringify(await open()) === '{"query":false,"explorer":true}', 'the Explorer list replaces it');
		await p.click('#queryTabsBtn');
		check(JSON.stringify(await open()) === '{"query":true,"explorer":false}', 'and the other way round');
		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		await p.close();
		check.done();
	});

	test('the list of the queries shows the state of each one with the same dot', async () => {
		const check = checker();
		const p = await openPage();
		await type(p, 'select 1');
		await p.evaluate(() => { window.queryFileManager.addDraftTab(); });
		await p.waitForTimeout(100);
		await p.click('#queryTabsBtn');
		const states = await p.evaluate(() => [...document.querySelectorAll('.query-tabs-dropdown-item .query-state-dot')].map(d => d.dataset.queryState));
		check(JSON.stringify(states) === '["draft"]', 'a draft has its dot in the list (' + states + ')');
		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		await p.close();
		check.done();
	});

	test('the side panel closes when its bar is dragged well under the minimum width, and keeps its width', async () => {
		const check = checker();
		const p = await openPage();
		const visible = () => p.evaluate(() => document.getElementById('sqlFilesPanel').classList.contains('visible'));
		const width = () => p.evaluate(() => Math.round(document.getElementById('sqlFilesPanel').getBoundingClientRect().width));
		await p.click('#queryFilesBtn');
		check(await visible(), 'the panel is open');
		const before = await width();
		const box = await p.locator('#sqlFilesSplitter').boundingBox();
		const y = box.y + box.height / 2;

		await p.mouse.move(box.x + 2, y);
		await p.mouse.down();
		await p.mouse.move(box.x - (before - 140), y, { steps: 4 });
		check(await visible() && Math.abs((await width()) - 150) <= 1, 'down to the minimum it only narrows (' + await width() + ')');
		await p.mouse.move(box.x - before, y, { steps: 4 });
		check(!(await visible()), 'well under it, the panel closes');
		await p.mouse.move(box.x - (before - 200), y, { steps: 4 });
		check(await visible(), 'the bar coming back opens it again');
		await p.mouse.move(box.x - before, y, { steps: 4 });
		await p.mouse.up();
		check(!(await visible()), 'released under the limit: closed');

		await p.click('#queryFilesBtn');
		check(await visible() && Math.abs((await width()) - 150) <= 1, 'opened again, at the width it had (' + await width() + ')');
		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		await p.close();
		check.done();
	});

	test('right click on the Save button offers Save As, for a draft with text and for a clean file', async () => {
		const check = checker();
		const p = await openPage();
		const menu = () => p.evaluate(() => [...document.querySelectorAll('.script-menu-item')].map(i => i.textContent));

		await p.click('#saveQueryFileWrap', { button: 'right' });
		check((await menu()).length === 0, 'an empty draft has no menu');

		await type(p, 'SELECT 1');
		await p.click('#saveQueryFileWrap', { button: 'right' });
		check(JSON.stringify(await menu()) === JSON.stringify(['Save', 'Save As…']), 'a draft: Save and Save As (' + (await menu()) + ')');
		await p.click('.script-menu-item:has-text("Save As")');
		await p.waitForTimeout(150);
		check((await sent(p)).some(m => m.command === 'saveSqlFileAs' && m.content === 'SELECT 1'), 'Save As asks where to save');

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		await p.close();
		check.done();
	});

	test('closing a tab that has text asks before dropping it', async () => {
		const check = checker();
		const p = await openPage();

		await type(p, 'SELECT 1');
		await p.evaluate(() => window.queryFileManager.closeTab(window.queryFileManager.activeTabId));
		await p.waitForTimeout(120);

		const messages = await sent(p);
		check(messages.some(m => m.command === 'confirmDiscardChanges'), 'the page asks before dropping the text');
		check((await tabs(p)).length === 1, 'the tab is still there while the question is open');

		// The user says no: the tab stays.
		await p.evaluate(() => window.postMessage({ command: 'discardConfirmed', discard: false }, '*'));
		await p.waitForTimeout(120);
		check((await tabs(p)).length === 1, 'the tab is still there');

		// The user says yes: it goes.
		await p.evaluate(() => window.queryFileManager.closeTab(window.queryFileManager.activeTabId));
		await p.waitForTimeout(120);
		await p.evaluate(() => window.postMessage({ command: 'discardConfirmed', discard: true }, '*'));
		await p.waitForTimeout(120);
		check((await tabs(p)).length === 1, 'a new empty draft replaces the closed one');

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		await p.close();
		check.done();
	});

	test('the drafts of a crash are offered, and they are kept until the user writes', async () => {
		const check = checker();
		const p = await openPage();

		// The extension answers the recovery request.
		await p.evaluate(() => window.postMessage({
			command: 'draftRecoveryLoaded',
			drafts: [{ content: 'SELECT 42', database: 'AppDb' }]
		}, '*'));
		await p.waitForTimeout(150);
		check((await editorText(p)) === 'SELECT 42', 'the recovered draft is in the editor (' + (await editorText(p)) + ')');
		check((await tabs(p))[0].database === 'AppDb', 'the recovered draft keeps its database');

		// A script the page loads on its own is a change of the editor, but
		// not something the user wrote: it must not snap the drafts, or the
		// draft being recovered would be written over.
		const before = (await sent(p)).filter(m => m.command === 'saveDraftRecovery').length;
		await p.evaluate(() => window.queryManager.loadEditorContent('SELECT 99'));
		await p.waitForTimeout(2000);
		const after = (await sent(p)).filter(m => m.command === 'saveDraftRecovery').length;
		check(after === before, 'the load of a script did not snap the drafts (' + before + ' -> ' + after + ')');
		check((await editorText(p)) === 'SELECT 99', 'the script is in the editor');

		// What the user writes does snap them.
		await type(p, 'X');
		await p.waitForTimeout(2000);
		const messages = await sent(p);
		const snapshot = messages.filter(m => m.command === 'saveDraftRecovery').pop();
		check(!!snapshot, 'typing snapped the drafts');
		check(snapshot && snapshot.drafts[0].content === 'SELECT 99X',
			'the snapshot holds what is in the editor (' + (snapshot ? snapshot.drafts[0].content : 'no snapshot') + ')');

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		await p.close();
		check.done();
	});

	test('a recovery never overwrites what the user has already typed', async () => {
		const check = checker();
		const p = await openPage();

		await type(p, 'SELECT 1');
		await p.evaluate(() => window.postMessage({
			command: 'draftRecoveryLoaded',
			drafts: [{ content: 'SELECT 42' }]
		}, '*'));
		await p.waitForTimeout(150);

		check((await editorText(p)) === 'SELECT 1', 'the typed text is still there (' + (await editorText(p)) + ')');

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		await p.close();
		check.done();
	});

	test('a file of the workspace opens in its own tab, and stays there', async () => {
		const check = checker();
		const p = await openPage();

		await p.evaluate(() => window.postMessage({
			command: 'sqlFileOpened',
			path: '/w/app.sql',
			name: 'app.sql',
			content: 'SELECT * FROM app'
		}, '*'));
		await p.waitForTimeout(150);
		check((await editorText(p)) === 'SELECT * FROM app', 'the file is in the editor');
		check((await tabs(p)).some(t => t.fileName === 'app.sql'), 'the file has its own tab');

		// Opening it again switches to the tab that is already there.
		await p.evaluate(() => window.postMessage({
			command: 'sqlFileOpened',
			path: '/w/app.sql',
			name: 'app.sql',
			content: 'SELECT * FROM app'
		}, '*'));
		await p.waitForTimeout(150);
		check((await tabs(p)).filter(t => t.fileName === 'app.sql').length === 1, 'the file has only one tab');
		check((await activeId(p)) === (await tabs(p)).find(t => t.fileName === 'app.sql').id, 'the tab of the file is the active one');

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		await p.close();
		check.done();
	});

	test('the encoding of a file is shown, can be changed, and is sent when the file is saved', async () => {
		const check = checker();
		const p = await openPage();
		const encoding = () => p.evaluate(() => document.getElementById('queryEncodingSelect').value);
		const saveEnabled = () => p.evaluate(() => !document.getElementById('saveQueryFileBtn').disabled);

		check((await encoding()) === 'utf8', 'a draft is UTF-8');

		await p.evaluate(() => window.postMessage({
			command: 'sqlFileOpened', path: '/w/app.sql', name: 'app.sql', content: 'SELECT 1', encoding: 'utf16le'
		}, '*'));
		await p.waitForTimeout(150);
		check((await encoding()) === 'utf16le', 'the file shows the encoding it was opened with (' + (await encoding()) + ')');
		check(!(await saveEnabled()), 'an unchanged file has nothing to save');

		// Another encoding is a change of the file: it can be saved.
		await p.selectOption('#queryEncodingSelect', 'utf8bom');
		await p.waitForTimeout(100);
		check(await saveEnabled(), 'changing the encoding makes the file saveable');
		await p.click('#saveQueryFileBtn');
		await p.waitForTimeout(100);
		const save = (await sent(p)).filter(m => m.command === 'saveSqlFile').pop();
		check(save && save.encoding === 'utf8bom', 'the save carries the chosen encoding');

		await p.evaluate(() => window.postMessage({ command: 'sqlFileSaved', path: '/w/app.sql', success: true }, '*'));
		await p.waitForTimeout(100);
		check(!(await saveEnabled()), 'saved: nothing left to save');

		// Each tab has its own encoding.
		await p.click('#queryTabsBtn');
		await p.click('[data-qtab-add]');
		await p.waitForTimeout(100);
		check((await encoding()) === 'utf8', 'a new tab is UTF-8');
		await p.evaluate(() => window.queryFileManager.switchTab(window.queryFileManager.tabs.find(t => t.fileName).id));
		await p.waitForTimeout(100);
		check((await encoding()) === 'utf8bom', 'back on the file: its encoding is back');

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		await p.close();
		check.done();
	});

	test('the files can be searched by their contents: the matching files, their counts, and the line to open on', async () => {
		const check = checker();
		const p = await openPage();
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(80); };
		const rows = () => p.$$eval('.sql-file-item', els => els.map(e => e.dataset.filePath));

		await p.click('#queryFilesBtn');
		await post({ command: 'sqlFilesListed', files: [
			{ name: 'a.sql', path: '/w/a.sql', relativeDir: '' },
			{ name: 'b.sql', path: '/w/sub/b.sql', relativeDir: 'sub' },
			{ name: 'orders.sql', path: '/w/orders.sql', relativeDir: '' }
		] });
		check((await p.locator('#sqlFilesRegexBtn').isDisabled()), 'the regex toggle waits for the search in the contents');

		// Names first: the filter works as before.
		await p.fill('#sqlFilesFilterInput', 'orders');
		check(JSON.stringify(await rows()) === '["/w/orders.sql"]', 'the filter is on the names');

		await p.click('#sqlFilesContentBtn');
		await p.waitForTimeout(500);
		const search = (await sent(p)).filter(m => m.command === 'searchSqlFiles').pop();
		check(search && search.query === 'orders' && search.regex === false, 'the contents are searched (' + JSON.stringify(search) + ')');
		check((await p.textContent('#sqlFilesTree')).includes('Searching'), 'it says it is searching');
		check((await p.locator('#sqlFilesTree .panel-spinner').count()) === 1, 'with a spinner');

		// A stale answer is ignored.
		await post({ command: 'sqlFilesSearched', id: search.id - 1, results: [{ path: '/w/a.sql', count: 9, line: 1 }] });
		check((await p.textContent('#sqlFilesTree')).includes('Searching'), 'a stale answer changes nothing');

		await post({ command: 'sqlFilesSearched', id: search.id, results: [{ path: '/w/sub/b.sql', count: 3, line: 7 }] });
		check(JSON.stringify(await rows()) === '["/w/sub/b.sql"]', 'only the files that contain it');
		check((await p.textContent('.sql-file-item .sql-file-count')) === '3', 'with their number of matches');

		await p.click('.sql-file-item');
		const open = (await sent(p)).filter(m => m.command === 'openSqlFile').pop();
		check(open && open.path === '/w/sub/b.sql' && open.line === 7, 'it opens on the first match (' + JSON.stringify(open) + ')');

		// The regular expression is the extension's to read; its error is shown.
		await p.click('#sqlFilesRegexBtn');
		await p.fill('#sqlFilesFilterInput', '(');
		await p.waitForTimeout(500);
		const bad = (await sent(p)).filter(m => m.command === 'searchSqlFiles').pop();
		check(bad.regex === true && bad.query === '(', 'the search is a regular expression');
		await post({ command: 'sqlFilesSearched', id: bad.id, results: [], error: 'Invalid regular expression: x' });
		check((await p.textContent('#sqlFilesTree')).includes('Invalid regular expression'), 'the error is shown');

		// Nothing found.
		await p.fill('#sqlFilesFilterInput', 'zzz');
		await p.waitForTimeout(500);
		const none = (await sent(p)).filter(m => m.command === 'searchSqlFiles').pop();
		await post({ command: 'sqlFilesSearched', id: none.id, results: [] });
		check((await p.textContent('#sqlFilesTree')).includes('No file contains this text'), 'says so when nothing contains it');

		// Switching it off brings the names back.
		await p.click('#sqlFilesContentBtn');
		await p.fill('#sqlFilesFilterInput', '');
		check((await rows()).length === 3, 'all the files are back');

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		await p.close();
		check.done();
	});

	test('a file with Windows line ends (CRLF) opens, shows its lines, and is saved with the line ends it had', async () => {
		const check = checker();
		const p = await openPage();
		await p.evaluate(() => window.postMessage({
			command: 'sqlFileOpened', path: '/w/win.sql', name: 'win.sql', content: 'SELECT 1\r\nFROM a\r\nWHERE x = 1', encoding: 'utf8', eol: 'crlf'
		}, '*'));
		await p.waitForTimeout(150);
		check((await editorText(p)) === 'SELECT 1\nFROM a\nWHERE x = 1', 'the text is in the editor (' + JSON.stringify(await editorText(p)) + ')');
		check((await p.locator('.cm-line').count()) === 3, 'on three lines');

		await type(p, ' AND y = 2');
		await p.click('#saveQueryFileBtn');
		await p.waitForTimeout(100);
		const save = (await sent(p)).filter(m => m.command === 'saveSqlFile').pop();
		check(save && save.eol === 'crlf', 'the save carries the line ends of the file');

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		await p.close();
		check.done();
	});

	test('a script made from a definition with Windows line ends (Script as CREATE) reaches the editor', async () => {
		const check = checker();
		const p = await openPage();
		const crlf = 'CREATE PROCEDURE dbo.p\r\nAS\r\nBEGIN\r\n  SELECT 1\r\nEND';
		await p.evaluate(m => window.postMessage(m, '*'), { command: 'scriptGenerated', objectName: 'dbo.p', scriptType: 'create', script: crlf, preview: false });
		await p.waitForTimeout(150);
		check((await editorText(p)) === 'CREATE PROCEDURE dbo.p\nAS\nBEGIN\n  SELECT 1\nEND', 'the script is in the editor (' + JSON.stringify(await editorText(p)) + ')');
		check((await p.locator('.cm-line').count()) === 5, 'on five lines');

		// From the instance tree, on another database: the USE line comes first.
		await p.evaluate(m => window.postMessage(m, '*'), { command: 'scriptGenerated', objectName: 'dbo.p', scriptType: 'create', script: crlf, preview: false, database: 'master' });
		await p.waitForTimeout(150);
		check((await editorText(p)).startsWith('USE [master]\nGO\n\nCREATE PROCEDURE dbo.p\nAS'), 'with its USE line');

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		await p.close();
		check.done();
	});
});
