const { loadPlaywright, openPage, post, sent, checker } = require('./harness');

const playwright = loadPlaywright();

suite('e2e: sidebar (connections, snippets) and panel basics', function () {
	this.timeout(120000);
	let browser;
	suiteSetup(async function () {
		if (!playwright) this.skip();
		browser = await playwright.chromium.launch();
	});
	suiteTeardown(async () => { if (browser) await browser.close(); });

	test('sidebar: connections list, forms, snippets tab', async () => {
		const check = checker();

		const p = await openPage(browser, 'sidebar.html', 'panels/SnippetSidebarProvider.js', 'dark', { width: 300, height: 700 });
		const errors = p.errors;
		const last = () => sent(p).then(a => a[a.length - 1]);
		const clear = () => p.evaluate(() => { window.__sent.length = 0; });
		const names = () => p.locator('#connectionList .sb-row-name').allTextContents();
		check((await sent(p)).some(m => m.command === 'loadConnections') && (await sent(p)).some(m => m.command === 'getSnippets'), 'sidebar asks for connections and snippets');
		check(await p.locator('#connectionsView').isVisible() && !(await p.locator('#snippetsView').isVisible()), 'Connections tab is shown first');

		// -- connections list
		const conns = [
			{ name: 'Prod <b>', server: 'srv', port: 1433, database: 'db', authType: 'sql', username: 'sa' },
			{ name: 'Dev', server: 'dev', authType: 'windows' },
			{ name: 'Azure', server: 'x.database.windows.net', authType: 'entra' },
			{ name: 'zeta', server: 'srv' }, { name: 'beta10', server: 'srv' }, { name: 'beta2', server: 'special-srv' }];
		await post(p, { command: 'savedConnectionsLoaded', connections: conns, lastConnection: 'Dev', openConnections: ['Dev'] });
		check(JSON.stringify(await names()) === JSON.stringify(['Azure', 'beta2', 'beta10', 'Dev', 'Prod <b>', 'zeta']), 'sorted naturally, case-insensitively: ' + (await names()).join(','));
		check(!(await p.locator('#connectionList').innerHTML()).includes('<b>'), 'names are escaped');
		check(await p.locator('.sb-open-dot').count() === 1 && await p.locator('.sb-last-used').count() === 1, 'one open dot, one last-used mark');
		check(await p.locator('[data-connection-name="Dev"] .codicon-account').count() === 1 && await p.locator('[data-connection-name="Azure"] .codicon-azure').count() === 1 && await p.locator('[data-connection-name="zeta"] .codicon-key').count() === 1, 'auth type icons');
		await post(p, { command: 'openConnectionsChanged', names: [] });
		check(await p.locator('.sb-open-dot').count() === 0, 'open dot cleared');

		await clear();
		await p.locator('[data-connection-name="Dev"] .sb-row-main').click();
		check((await last()).command === 'connectToSaved' && (await last()).connectionName === 'Dev', 'clicking a row opens it');
		await clear();
		await p.locator('[data-connection-name="Dev"]').focus();
		await p.keyboard.press('Enter');
		check((await last()).command === 'connectToSaved', 'Enter on a focused row opens it');
		await p.keyboard.press('Tab');
		check(await p.locator('[data-connection-name="Dev"] [data-connection-action=connect]').isVisible(), 'row actions appear with the keyboard focus');
		await clear();
		await p.locator('[data-connection-name="Dev"] [data-connection-action=delete]').click();
		check((await last()).command === 'deleteConnection' && (await last()).connectionName === 'Dev', 'delete asks the extension');

		await p.fill('#connectionFilter', 'SPECIAL');
		check(JSON.stringify(await names()) === JSON.stringify(['beta2']), 'filter matches the server, any case');
		await clear();
		await p.press('#connectionFilter', 'Enter');
		check((await last()).connectionName === 'beta2', 'Enter in the filter opens the first match');
		await p.fill('#connectionFilter', 'nomatch');
		check((await p.locator('#connectionList').textContent()).includes('No connection matches'), 'empty filter result is explained');
		await post(p, { command: 'savedConnectionsLoaded', connections: conns, lastConnection: null, openConnections: [] });
		check((await p.inputValue('#connectionFilter')) === 'nomatch', 'a reload keeps what was typed');
		await p.press('#connectionFilter', 'Escape');
		check((await names()).length === 6, 'Escape clears the filter');

		// -- connection form (inline, with a back arrow)
		await p.click('#newConnectionBtn');
		check(await p.locator('#connectionFormView').isVisible() && !(await p.locator('#connectionListView').isVisible()), 'form replaces the list');
		check(!(await p.locator('.sb-tabs').isHidden()), 'tabs stay in view');
		await p.selectOption('#authTypeSelect', 'windows');
		check(!(await p.locator('#sqlAuthFields').isVisible()) && await p.locator('#windowsAuthHint').isVisible(), 'windows hides the login fields');
		await p.locator('#saveConnectionBtn').click();
		check((await p.locator('#connectionFormStatus').textContent()).includes('name'), 'a name is required');
		await p.fill('#connectionNameInput', 'New'); await p.fill('#serverInput', 'localhost');
		await p.evaluate(() => { document.getElementById('usernameInput').value = 'stale'; });
		await clear();
		await p.locator('#saveConnectionBtn').click();
		const save = await last();
		check(save.command === 'saveConnection' && save.connectionConfig.authType === 'windows' && save.connectionConfig.username === '' && save.originalName === null, 'save sends a clean windows config');
		await post(p, { command: 'connectionSaved', success: true, message: 'saved ok' });
		check(await p.locator('#connectionListView').isVisible() && (await p.locator('#connectionsStatus').textContent()) === 'saved ok', 'back on the list with a confirmation above it');
		check((await p.locator('#connectionsStatus').boundingBox()).y < (await p.locator('#connectionList').boundingBox()).y, 'the confirmation sits above the list');

		await p.click('#newConnectionBtn');
		await p.fill('#connectionNameInput', 'Quick'); await p.fill('#serverInput', 'quick');
		await clear();
		await p.locator('#saveAndOpenConnectionBtn').click();
		check((await last()).command === 'saveAndOpenConnection' && (await last()).connectionConfig.name === 'Quick', 'Save & Open has its own command');
		await post(p, { command: 'connectionSaved', success: false, message: 'duplicate name' });
		check(await p.locator('#connectionFormView').isVisible() && (await p.locator('#connectionFormStatus').textContent()) === 'duplicate name', 'a failed save stays in the form and says why');
		await p.click('#connectionFormBackBtn');
		check(await p.locator('#connectionListView').isVisible(), 'back arrow returns to the list');

		await p.locator('[data-connection-name="Prod <b>"]').hover();
		await p.locator('[data-connection-name="Prod <b>"] [data-connection-action=edit]').click();
		check((await p.inputValue('#connectionNameInput')) === 'Prod <b>' && (await p.inputValue('#serverInput')) === 'srv' && (await p.inputValue('#portInput')) === '1433', 'edit fills the form from the list');
		check((await p.getAttribute('#passwordInput', 'placeholder')).includes('saved'), 'edit keeps the saved password');
		await p.fill('#connectionNameInput', 'Prod2');
		await clear();
		await p.locator('#saveConnectionBtn').click();
		check((await last()).originalName === 'Prod <b>', 'a rename sends the previous name');
		await post(p, { command: 'connectionSaved', success: true, message: 'ok' });
		await p.locator('[data-connection-name="Prod <b>"]').hover();
		await p.locator('[data-connection-name="Prod <b>"] [data-connection-action=edit]').click();
		await clear();
		await p.locator('#testConnectionBtn').click();
		const test = await last();
		check(test.command === 'testConnection' && test.connectionConfig.isLoadedConnection === true && test.connectionConfig.name === 'Prod <b>', 'testing an edit without a password uses the saved one');
		check((await p.locator('#testConnectionBtn').textContent()) === 'Testing…' && await p.locator('#testConnectionBtn').isDisabled(), 'test button shows it is working');
		await post(p, { command: 'testConnectionResult', success: false, message: 'Login failed' });
		check((await p.locator('#testConnectionBtn').textContent()) === 'Test' && (await p.locator('#connectionFormStatus').textContent()) === 'Login failed', 'test result is shown in the form');
		check((await p.locator('#connectionFormStatus').boundingBox()).y < (await p.locator('#testConnectionBtn').boundingBox()).y, 'the result sits above the buttons');
		await p.keyboard.press('Escape');
		check(await p.locator('#connectionListView').isVisible(), 'Escape closes the form');

		// -- empty state
		await post(p, { command: 'savedConnectionsLoaded', connections: [], lastConnection: null, openConnections: [] });
		await p.locator('#connectionList .sb-btn').click();
		check(await p.locator('#connectionFormView').isVisible(), 'the empty state has a New connection button');
		await p.click('#connectionFormBackBtn');

		// -- snippets tab
		await p.click('[data-sb-tab=snippets]');
		check(await p.locator('#snippetsView').isVisible() && !(await p.locator('#connectionsView').isVisible()), 'Snippets tab opens');
		check((await p.evaluate(() => window.__state)).tab === 'snippets', 'the open tab is remembered');
		await post(p, { command: 'snippetsLoaded', snippets: [{ name: 'Mine <i>', sql: 'SELECT 1' }, { name: 'Zed', sql: 'SELECT 2 -- orders' }] });
		const groups = await p.locator('#snippetManagerList .sb-group-label').allTextContents();
		check(JSON.stringify(groups) === JSON.stringify(['Custom', 'Built-in']), 'custom snippets first, then built-in');
		check(!(await p.locator('#snippetManagerList').innerHTML()).includes('<i>'), 'snippet names are escaped');
		await p.fill('#snippetFilter', 'orders');
		check((await p.locator('#snippetManagerList .sb-row-name').allTextContents()).includes('Zed'), 'snippet filter searches the SQL too');
		await p.fill('#snippetFilter', 'zzzz');
		check((await p.locator('#snippetManagerList').textContent()).includes('No snippet matches'), 'empty snippet filter is explained');
		await p.press('#snippetFilter', 'Escape');
		await clear();
		await p.locator('#snippetManagerList [data-snippet-name="Zed"] .sb-row-main').click();
		check(await p.locator('#snippetFormView').isVisible() && (await p.inputValue('#snippetNameInput')) === 'Zed', 'clicking a custom snippet edits it');
		await p.fill('#snippetNameInput', 'Zed2');
		await p.click('#saveSnippetBtn');
		check((await last()).command === 'updateSnippet' && (await last()).oldName === 'Zed' && (await last()).newName === 'Zed2', 'a rename updates the snippet');
		check(await p.locator('#snippetListView').isVisible(), 'saving returns to the list');
		await p.locator('#snippetManagerList [data-snippet-name="Zed"]').hover();
		await clear();
		await p.locator('#snippetManagerList [data-snippet-name="Zed"] [data-snippet-action=delete]').click();
		check((await last()).command === 'confirmDeleteSnippet' && (await last()).name === 'Zed', 'deleting asks the extension');
		await clear();
		await p.locator('#snippetManagerList [data-snippet-builtin="true"] .sb-row-main').first().click();
		check(await p.locator('#snippetListView').isVisible() && (await sent(p)).length === 0, 'a built-in snippet has no default action');
		await p.locator('#snippetManagerList [data-snippet-builtin="true"]').first().hover();
		await p.locator('#snippetManagerList [data-snippet-builtin="true"] [data-snippet-action=duplicate]').first().click();
		check((await p.inputValue('#snippetNameInput')).endsWith('(copy)') && (await p.inputValue('#snippetSqlInput')).length > 0, 'duplicating a built-in prefills the form');
		await p.fill('#snippetNameInput', 'Zed');
		await p.click('#saveSnippetBtn');
		check((await p.locator('#snippetFormStatus').textContent()).includes('already exists'), 'a name clash is refused');
		await p.keyboard.press('Escape');
		check(await p.locator('#snippetListView').isVisible(), 'Escape closes the snippet form');
		check(errors.length === 0, 'no page errors: ' + errors.join(' | '));

		// -- the open tab survives a rebuild of the view
		const state = await p.evaluate(() => window.__state);
		const q = await browser.newPage({ viewport: { width: 300, height: 700 } });
		await q.addInitScript(st => { window.__sent = []; window.acquireVsCodeApi = () => ({ postMessage: m => window.__sent.push(m), getState: () => st, setState: () => {} }); }, state);
		await q.goto(p.url());
		check(await q.locator('#snippetsView').isVisible(), 'the Snippets tab comes back after a rebuild');
		await q.close();
		await p.close();
		check.done();
	});

	test('panel: connect overlay, database selector, tabs', async () => {
		const check = checker();

		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 760 });
		const errors = p.errors;
		check((await sent(p)).some(m => m.command === 'panelReady'), 'panel announces it is ready');
		check((await p.locator('#appLoadingTitle').textContent()) === 'Connecting…', 'overlay says connecting');
		check(await p.locator('[data-tab=configuration]').count() === 0, 'no Configuration tab');
		await post(p, { command: 'connectionStatus', success: false, message: 'Failed to connect: Login failed' });
		check((await p.locator('#appLoadingDetail').textContent()).includes('Login failed') && await p.locator('#appLoadingRetryBtn').isVisible(), 'failure is explained with a Retry');
		await p.locator('#appLoadingRetryBtn').click();
		check((await sent(p)).some(m => m.command === 'retryConnection'), 'Retry asks the extension');
		check(!(await p.locator('#appLoadingRetryBtn').isVisible()), 'Retry hides while retrying');
		await post(p, { command: 'connectionStatus', success: true, message: 'ok' });
		check(await p.locator('#appLoading').count() === 0, 'overlay goes away once connected');
		await post(p, { command: 'databasesLoaded', databases: ['master', 'Sales', 'HR'], currentDatabase: 'sales' });
		check((await p.inputValue('#databaseSelect')) === 'Sales', 'restored database is selected');
		await p.evaluate(() => { window.__sent.length = 0; });
		await post(p, { command: 'selectDatabase', database: 'hr' });
		check((await p.inputValue('#databaseSelect')) === 'HR', 'selectDatabase moves the tab to another database');
		check((await sent(p)).some(m => m.command === 'setCurrentDatabase' && m.database === 'HR'), 'the extension is told about it');
		await post(p, { command: 'selectDatabase', database: 'dropped' });
		check((await p.inputValue('#databaseSelect')) === 'HR', 'an unknown database leaves the selection alone');
		check(await p.locator('#queryTab.active').count() === 1, 'Query tab is the one shown');
		check(errors.length === 0, 'no page errors: ' + errors.join(' | '));
		await p.close();
		check.done();
	});
});
