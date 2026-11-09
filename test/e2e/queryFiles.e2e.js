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
});
