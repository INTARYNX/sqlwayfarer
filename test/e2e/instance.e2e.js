const { loadPlaywright, openPage, checker } = require('./harness');

const playwright = loadPlaywright();

const obj = (type, schema, name) => ({ object_type: type, schema_name: schema, object_name: name, name: schema === 'dbo' ? name : `${schema}.${name}`, qualified_name: `${schema}.${name}` });
const OBJECTS = [obj('Table', 'dbo', 'Orders'), obj('Table', 'dbo', 'Customers'), obj('View', 'Sales', 'vOrders'), obj('Procedure', 'dbo', 'usp_Load'), obj('Function', 'dbo', 'fnTotal')];

suite('e2e: the instance tree', function () {
	this.timeout(120000);
	let browser;
	suiteSetup(async function () {
		if (!playwright) this.skip();
		browser = await playwright.chromium.launch();
	});
	suiteTeardown(async () => { if (browser) await browser.close(); });

	for (const theme of ['dark', 'light']) {
		test(`${theme}: tabs, chevrons, lazy loading, filter, context menu, refresh`, async () => {
			const check = checker();
			const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', theme, { width: 1100, height: 700 });
			const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(100); };
			const sent = () => p.evaluate(() => window.__sent.slice());
			const rows = () => p.$$eval('#instanceTree .instance-row', els => els.map(e => `${e.dataset.kind}:${e.querySelector('.instance-name').textContent}`));
			await post({ command: 'connectionStatus', success: true, message: 'ok' });
			await post({ command: 'databasesLoaded', databases: ['AppDb'], currentDatabase: 'AppDb' });

			const chevron = () => p.$eval('#queryFilesBtn .codicon', e => e.className.replace('codicon ', ''));
			check(await chevron() === 'codicon-layout-sidebar-left-off', `${theme}: closed, the button is the outlined side bar icon`);
			await p.click('#queryFilesBtn');
			check(await chevron() === 'codicon-layout-sidebar-left' && await p.getAttribute('#queryFilesBtn', 'aria-expanded') === 'true', `${theme}: open, the icon fills in`);
			check(await p.isVisible('#sqlFilesView') && !(await p.isVisible('#instanceView')), `${theme}: the panel opens on Files`);
			await p.evaluate(() => { window.__sent.length = 0; });
			await p.click('#panelTabInstance');
			check(await p.isVisible('#instanceView') && !(await p.isVisible('#sqlFilesView')), `${theme}: the Instance tab shows the tree`);
			check((await sent()).some(m => m.command === 'getInstanceDatabases'), `${theme}: the databases are asked on first show`);

			await post({ command: 'instanceDatabases', databases: ['AppDb', 'Archive'] });
			check(JSON.stringify(await rows()) === '["db:AppDb","db:Archive"]', `${theme}: databases listed, closed`);
			check(await p.$eval('.instance-row .instance-chevron', e => e.classList.contains('codicon-chevron-right')), `${theme}: closed chevron`);

			await p.evaluate(() => { window.__sent.length = 0; });
			await p.click('.instance-row[data-key="db:AppDb"]');
			check((await sent()).some(m => m.command === 'getInstanceObjects' && m.database === 'AppDb'), `${theme}: opening a database reads its objects`);
			check((await p.textContent('#instanceTree')).includes('Loading'), `${theme}: says it is loading`);
			check((await p.locator('#instanceTree .instance-spinner').count()) > 0, `${theme}: a spinner turns while it loads`);
			await post({ command: 'instanceObjects', database: 'AppDb', objects: OBJECTS });
			check(JSON.stringify(await rows()) === '["db:AppDb","group:Tables","group:Views","group:Procedures","group:Functions","db:Archive"]', `${theme}: groups under the database (${JSON.stringify(await rows())})`);
			check(await p.$eval('.instance-row[data-key="db:AppDb"] .instance-chevron', e => e.classList.contains('codicon-chevron-down')), `${theme}: open chevron`);

			await p.click('.instance-row[data-key="grp:AppDb:Table"]');
			check((await rows()).filter(r => r.startsWith('object')).join() === 'object:Orders,object:Customers', `${theme}: the group opens on its objects`);

			// Context menu of an object.
			await p.click('.instance-row[data-name="dbo.Orders"]', { button: 'right' });
			const menu = await p.$$eval('.script-menu .script-menu-item', els => els.map(e => e.textContent));
			check(menu.includes('Rename…') && menu.includes('Delete…') && menu.includes('Show details') && menu.some(l => l.startsWith('Script as')), `${theme}: the menu has Script, Rename, Delete (${menu.join(' | ')})`);
			await p.evaluate(() => { window.__sent.length = 0; });
			await p.click('.script-menu-item:has-text("Delete…")');
			const del = (await sent()).find(m => m.command === 'dropInstanceObject');
			check(del && del.database === 'AppDb' && del.schema === 'dbo' && del.name === 'Orders' && del.objectType === 'Table', `${theme}: Delete asks the extension, which confirms`);

			await p.click('.instance-row[data-name="dbo.Orders"]', { button: 'right' });
			await p.evaluate(() => { window.__sent.length = 0; });
			await p.click('.script-menu-item:has-text("SELECT")');
			const script = (await sent()).find(m => m.command === 'generateInstanceScript');
			check(script && script.scriptType === 'select' && script.database === 'AppDb', `${theme}: a script is asked for the object's own database`);

			// A script of another database brings its USE.
			await post({ command: 'scriptGenerated', objectName: 'dbo.X', scriptType: 'select', script: 'SELECT 1', database: 'Archive' });
			const text = await p.evaluate(() => window.queryManager.input.value);
			check(text === 'USE [Archive]\nGO\n\nSELECT 1', `${theme}: the script of another database starts with its USE (${JSON.stringify(text)})`);
			await post({ command: 'scriptGenerated', objectName: 'dbo.X', scriptType: 'select', script: 'SELECT 2', database: 'AppDb' });
			check(await p.evaluate(() => window.queryManager.input.value) === 'SELECT 2', `${theme}: none for the database the editor runs on`);

			// Filter.
			await p.fill('#instanceFilterInput', 'vord');
			check(JSON.stringify(await rows()) === '["db:AppDb","group:Views","object:Sales.vOrders"]', `${theme}: the filter keeps the matches, opened (${JSON.stringify(await rows())})`);
			await p.fill('#instanceFilterInput', 'zzz');
			check((await p.textContent('#instanceTree')).includes('Nothing matches'), `${theme}: says nothing matches`);
			await p.fill('#instanceFilterInput', '');

			// Refresh and the change reported by the extension.
			await p.evaluate(() => { window.__sent.length = 0; });
			await post({ command: 'instanceChanged', database: 'AppDb' });
			const after = await sent();
			check(after.some(m => m.command === 'getInstanceObjects' && m.database === 'AppDb') && after.some(m => m.command === 'getObjects' && m.database === 'AppDb'), `${theme}: a change refreshes the tree and the Explorer`);
			await p.evaluate(() => { window.__sent.length = 0; });
			await p.click('#sqlFilesRefreshBtn');
			check((await sent()).some(m => m.command === 'getInstanceDatabases'), `${theme}: the header refresh reloads the instance`);

			await p.click('#sqlFilesHideBtn');
			check(await chevron() === 'codicon-layout-sidebar-left-off' && !(await p.isVisible('#sqlFilesPanel')), `${theme}: hiding the panel flips it back`);
			await p.click('#queryFilesBtn');
			// Back to Files.
			await p.click('#panelTabFiles');
			check(await p.isVisible('#sqlFilesView') && !(await p.isVisible('#instanceView')), `${theme}: back to Files`);
			check(p.errors.length === 0, `${theme}: no page error: ` + p.errors.join(' | '));
			await p.close();
		});
	}

	test('keyboard: arrows move and open, F2 renames, Delete deletes', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 700 });
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(100); };
		await post({ command: 'connectionStatus', success: true, message: 'ok' });
		await post({ command: 'databasesLoaded', databases: ['AppDb'], currentDatabase: 'AppDb' });
		await p.click('#queryFilesBtn');
		await p.click('#panelTabInstance');
		await post({ command: 'instanceDatabases', databases: ['AppDb'] });
		await p.focus('#instanceTree');
		await p.keyboard.press('ArrowDown');
		await p.keyboard.press('ArrowRight');
		await post({ command: 'instanceObjects', database: 'AppDb', objects: OBJECTS });
		await p.keyboard.press('ArrowDown');
		await p.keyboard.press('ArrowRight');
		const focused = () => p.evaluate(() => document.activeElement.dataset.key || '');
		check((await focused()) === 'grp:AppDb:Table', 'the group is focused and open: ' + await focused());
		await p.keyboard.press('ArrowDown');
		check((await focused()) === 'obj:AppDb:dbo.Orders', 'ArrowDown goes to the object: ' + await focused());
		await p.evaluate(() => { window.__sent.length = 0; });
		await p.keyboard.press('F2');
		await p.keyboard.press('Delete');
		const sent = (await p.evaluate(() => window.__sent)).map(m => m.command);
		check(sent.join() === 'renameInstanceObject,dropInstanceObject', 'F2 and Delete: ' + sent.join());
		await p.keyboard.press('ArrowLeft');
		check((await focused()) === 'grp:AppDb:Table', 'ArrowLeft goes back to the group: ' + await focused());
		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		check.done();
		await p.close();
	});
});
