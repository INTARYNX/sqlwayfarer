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
			{ name: 'Azure', server: 'x.database.windows.net', authType: 'entra', production: true },
			{ name: 'zeta', server: 'srv' }, { name: 'beta10', server: 'srv' }, { name: 'beta2', server: 'special-srv' }];
		await post(p, { command: 'savedConnectionsLoaded', connections: conns, lastConnection: 'Dev', openConnections: ['Dev'] });
		check(JSON.stringify(await names()) === JSON.stringify(['Azure', 'beta2', 'beta10', 'Dev', 'Prod <b>', 'zeta']), 'sorted naturally, case-insensitively: ' + (await names()).join(','));
		check(!(await p.locator('#connectionList').innerHTML()).includes('<b>'), 'names are escaped');
		check(await p.locator('.sb-open-dot').count() === 1 && await p.locator('.sb-last-used').count() === 1, 'one open dot, one last-used mark');
		check(await p.locator('[data-connection-name="Dev"] .codicon-account').count() === 1 && await p.locator('[data-connection-name="Azure"] .codicon-azure').count() === 1 && await p.locator('[data-connection-name="zeta"] .codicon-key').count() === 1, 'auth type icons');
		check(await p.locator('.sb-prod-badge').count() === 1 && await p.locator('[data-connection-name="Azure"] .sb-prod-badge').count() === 1, 'only the production connection carries the PROD badge');
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
		check(!(await p.locator('#productionCheckbox').isChecked()), 'a new connection is not production');
		await p.check('#productionCheckbox');
		await p.fill('#connectionNameInput', 'New'); await p.fill('#serverInput', 'localhost');
		await p.evaluate(() => { document.getElementById('usernameInput').value = 'stale'; });
		await clear();
		await p.locator('#saveConnectionBtn').click();
		const save = await last();
		check(save.command === 'saveConnection' && save.connectionConfig.authType === 'windows' && save.connectionConfig.username === '' && save.originalName === null, 'save sends a clean windows config');
		check(save.connectionConfig.production === true, 'the production mark is saved');
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

	test('sidebar: connection groups, folding and import', async () => {
		const check = checker();
		const p = await openPage(browser, 'sidebar.html', 'panels/SnippetSidebarProvider.js', 'dark', { width: 300, height: 700 });
		const last = () => sent(p).then(a => a[a.length - 1]);
		const clear = () => p.evaluate(() => { window.__sent.length = 0; });
		const rows = () => p.locator('#connectionList .sb-row-name').allTextContents();
		const headers = () => p.evaluate(() => [...document.querySelectorAll('#connectionList .sb-group-toggle')].map(h => `${[...h.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('')}|${h.querySelector('.sb-group-count').textContent}`));
		const conns = [
			{ name: 'Local', server: 'localhost', authType: 'windows' },
			{ name: 'ERP', server: 'erp-sql', authType: 'sql', group: 'Production' },
			{ name: 'Paris', server: 'paris-sql', authType: 'windows', group: 'Production/Europe' },
			{ name: 'Lyon', server: 'lyon-sql', authType: 'windows', group: 'Production/Europe' },
			{ name: 'Test <i>', server: 'test-sql', authType: 'windows', group: 'Staging <i>' }
		];
		await post(p, { command: 'savedConnectionsLoaded', connections: conns, lastConnection: null, openConnections: [] });
		check(JSON.stringify(await rows()) === JSON.stringify(['Local', 'ERP', 'Lyon', 'Paris', 'Test <i>']), 'ungrouped first, then by group: ' + (await rows()).join(','));
		check(JSON.stringify(await headers()) === JSON.stringify(['Production|3', 'Production / Europe|2', 'Staging <i>|1']), 'one header per group with its count: ' + (await headers()).join(' ; '));
		check(!(await p.locator('#connectionList').innerHTML()).includes('<i>Staging') && (await p.locator('#connectionList').innerHTML()).includes('Staging &lt;i&gt;'), 'group names are escaped');

		await p.locator('[data-group-toggle="Production/Europe"]').click();
		check(JSON.stringify(await rows()) === JSON.stringify(['Local', 'ERP', 'Test <i>']), 'a folded group hides its connections');
		check((await p.getAttribute('[data-group-toggle="Production/Europe"]', 'aria-expanded')) === 'false', 'the header says it is folded');
		check(JSON.stringify((await p.evaluate(() => window.__state)).collapsedGroups) === JSON.stringify(['Production/Europe']), 'the fold is remembered');
		await p.locator('[data-group-toggle="Production"]').click();
		check(JSON.stringify(await rows()) === JSON.stringify(['Local', 'Test <i>']) && (await headers()).length === 2, 'folding a group hides its subgroups too: ' + (await headers()).join(' ; '));
		await p.locator('[data-group-toggle="Production"]').click();
		check((await p.locator('[data-group-toggle="Production"] .sb-group-count').textContent()) === '3', 'the count of a group includes its subgroups');
		await p.fill('#connectionFilter', 'paris');
		check(await p.locator('[data-group-toggle="Production/Europe"]').isDisabled(), 'a header does nothing while a filter is typed');
		check(JSON.stringify(await rows()) === JSON.stringify(['Paris']), 'a filter shows its matches even in a folded group');
		await p.fill('#connectionFilter', 'europe');
		check((await rows()).length === 2, 'the filter searches the group too');
		await p.fill('#connectionFilter', '');
		await p.locator('[data-group-toggle="Production/Europe"]').click();
		check((await rows()).length === 5, 'unfolding shows them again');

		await clear();
		await p.click('#importConnectionsBtn');
		check((await last()).command === 'importConnections', 'the import button asks the extension (it owns the pickers)');
		await post(p, { command: 'connectionsImported', added: 3, overwritten: 1, failed: 0 });
		check((await p.locator('#connectionsStatus').textContent()) === 'Connections imported: 3 added, 1 overwritten.', 'the result is told');
		await post(p, { command: 'connectionsImported', added: 2, overwritten: 0, failed: 1 });
		check((await p.locator('#connectionsStatus').textContent()).includes('1 failed') && (await p.getAttribute('#connectionsStatus', 'class')).includes('error'), 'a failure stays visible as an error');

		await p.hover('[data-connection-name="ERP"]');
		await p.locator('[data-connection-name="ERP"] [data-connection-action=edit]').click();
		check((await p.inputValue('#groupInput')) === 'Production', 'the form shows the group');
		await p.fill('#groupInput', ' Production / Asia/ ');
		await clear();
		await p.locator('#saveConnectionBtn').click();
		check((await last()).connectionConfig.group === 'Production/Asia', 'the group is saved tidy: ' + (await last()).connectionConfig.group);
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

	test('sidebar snippets: import button, abbreviation, imported snippets keep their fields when edited', async () => {
		const check = checker();
		const p = await openPage(browser, 'sidebar.html', 'panels/SnippetSidebarProvider.js', 'dark', { width: 320, height: 700 });
		await p.click('[data-sb-tab=snippets]');
		await post(p, { command: 'snippetsLoaded', snippets: [
			{ name: 'Heading <1>', sql: '--$Section$\n$CURSOR$', createdAt: 1, abbreviation: 'LD_H1', description: 'A book heading', placeholders: [{ id: 'Section', default: 'Title' }], source: 'SQL Prompt' },
			{ name: 'plain', sql: 'SELECT 1', createdAt: 2 }] });
		const row = p.locator('[data-snippet-name="Heading <1>"]');
		check(await row.locator('.sb-badge').textContent() === 'LD_H1', 'the abbreviation is shown');
		check((await row.locator('.sb-row-sub').textContent()).includes('A book heading'), 'with the description under the name');
		check(!(await p.locator('#snippetManagerList').innerHTML()).includes('<1>'), 'names are escaped');
		check(await p.locator('[data-snippet-name="plain"] .sb-badge').count() === 0, 'a snippet without abbreviation has no badge');
		await post(p, { command: 'snippetsLoaded', snippets: [{ name: 'LD_CRLF', sql: 'CHAR(13)', createdAt: 1, abbreviation: 'LD_CRLF' }] });
		check(await p.locator('[data-snippet-name="LD_CRLF"] .sb-badge').count() === 0, 'an abbreviation equal to the name is not repeated');
		await post(p, { command: 'snippetsLoaded', snippets: [
			{ name: 'Heading <1>', sql: '--$Section$\n$CURSOR$', createdAt: 1, abbreviation: 'LD_H1', description: 'A book heading', placeholders: [{ id: 'Section', default: 'Title' }], source: 'SQL Prompt' },
			{ name: 'plain', sql: 'SELECT 1', createdAt: 2 }] });

		await p.fill('#snippetFilter', 'book');
		check(await p.locator('#snippetManagerList [data-snippet-name]:not([data-snippet-builtin=true])').count() === 1, 'the filter looks in the description');
		await p.fill('#snippetFilter', 'ld_h1');
		check(await p.locator('#snippetManagerList [data-snippet-name]:not([data-snippet-builtin=true])').count() === 1, 'and in the abbreviation');
		await p.fill('#snippetFilter', '');

		await p.evaluate(() => { window.__sent.length = 0; });
		await p.click('#importSnippetsBtn');
		check((await sent(p)).some(m => m.command === 'importSnippets'), 'the import button asks the extension');
		await post(p, { command: 'snippetsImported', added: 24, overwritten: 1, leftOut: 2, skippedFiles: 3 });
		const status = await p.locator('#snippetsStatus').textContent();
		check(/24 imported/.test(status) && /1 overwritten/.test(status) && /2 already existed/.test(status) && /3 files could not be read/.test(status), 'the result is told: ' + status);
		await post(p, { command: 'snippetsImported', added: 0, overwritten: 0, leftOut: 0, skippedFiles: 1 });
		check(await p.locator('#snippetsStatus.error').count() === 1, 'an import that brought nothing is an error');

		// Editing keeps going through update, with the abbreviation of the form.
		await row.locator('.sb-row-main').click();
		check(await p.inputValue('#snippetAbbrInput') === 'LD_H1', 'the form shows the abbreviation');
		await p.evaluate(() => { window.__sent.length = 0; });
		await p.fill('#snippetAbbrInput', 'hh');
		await p.click('#saveSnippetBtn');
		const update = (await sent(p)).find(m => m.command === 'updateSnippet');
		check(update && update.oldName === 'Heading <1>' && update.newName === 'Heading <1>' && update.abbreviation === 'hh', 'saving an edit updates it, abbreviation included: ' + JSON.stringify(update));

		await p.evaluate(() => { window.__sent.length = 0; });
		await p.click('#newSnippetBtn');
		await p.fill('#snippetNameInput', 'brand new');
		await p.fill('#snippetAbbrInput', 'bn');
		await p.fill('#snippetSqlInput', 'SELECT 2');
		await p.click('#saveSnippetBtn');
		const add = (await sent(p)).find(m => m.command === 'addSnippet');
		check(add && add.name === 'brand new' && add.abbreviation === 'bn', 'a new snippet carries its abbreviation: ' + JSON.stringify(add));
		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		check.done();
		await p.close();
	});
});
