const { loadPlaywright, openPage, checker } = require('./harness');

const playwright = loadPlaywright();

suite('e2e: double-click an object name in the query editor', function () {
	this.timeout(120000);
	let browser;
	suiteSetup(async function () {
		if (!playwright) this.skip();
		browser = await playwright.chromium.launch();
	});
	suiteTeardown(async () => { if (browser) await browser.close(); });

	test('opens a menu: Find in Instance, View definition in Explorer, Close', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 700 });
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(80); };
		const sent = () => p.evaluate(() => window.__sent.slice());

		await post({ command: 'connectionStatus', success: true, message: 'ok' });
		await post({ command: 'databasesLoaded', databases: ['AppDb'], currentDatabase: 'AppDb' });
		await p.evaluate(() => { appState.currentDatabase = 'AppDb'; });
		await post({ command: 'objectsLoaded', objects: [{ name: 'Employees', object_name: 'Employees', schema_name: 'dbo', qualified_name: 'dbo.Employees', object_type: 'Table' }] });

		await p.evaluate(() => { window.queryManager.input.value = 'SELECT * FROM Employees'; });
		await p.waitForTimeout(80);

		// Double-clicks the word by its on-screen position (coordsAtPos), the
		// same trusted mouse event CodeMirror's own word selection relies on.
		const dblclickWord = async word => {
			const pos = await p.evaluate(w => window.queryManager.input.value.indexOf(w) + 1, word);
			const box = await p.evaluate(at => document.getElementById('queryInput').cmView.coordsAtPos(at), pos);
			await p.mouse.dblclick((box.left + box.right) / 2, (box.top + box.bottom) / 2);
		};
		const menuItems = () => p.evaluate(() => [...document.querySelectorAll('.script-menu .script-menu-item')].map(i => i.textContent));
		const menuOpen = () => p.evaluate(() => !!document.querySelector('.script-menu'));

		await dblclickWord('Employees');
		check(JSON.stringify(await menuItems()) === JSON.stringify(['Find in Instance', 'View definition in Explorer', 'Close']),
			'the three actions are offered (' + (await menuItems()) + ')');

		// Closed by an outside click, like every other popup menu here.
		await p.mouse.click(5, 5);
		check(!(await menuOpen()), 'an outside click closes the menu');

		// Its own "Close" item just dismisses it, nothing else happens.
		await dblclickWord('Employees');
		await p.evaluate(() => { window.__sent.length = 0; });
		await p.click('.script-menu-item:has-text("Close")');
		check(!(await menuOpen()), '"Close" dismisses the menu too');
		check((await sent()).length === 0, 'and sends nothing');

		// "View definition in Explorer": same jump Ctrl+click already does.
		await dblclickWord('Employees');
		await p.click('.script-menu-item:has-text("View definition in Explorer")');
		check(await p.evaluate(() => appState.activeTab) === 'explorer', 'it switches to the Explorer');

		// "Find in Instance": opens the Query tab's side panel on its Instance
		// view and searches the whole connection for the object's bare name.
		await p.click('.tab-button[data-tab="query"]');
		await dblclickWord('Employees');
		await p.evaluate(() => { window.__sent.length = 0; });
		await p.click('.script-menu-item:has-text("Find in Instance")');
		check(await p.evaluate(() => document.getElementById('sqlFilesPanel').classList.contains('visible')), 'the side panel opens');
		check(await p.evaluate(() => document.getElementById('panelTabInstance').classList.contains('active')), 'switched to its Instance view');
		check((await p.inputValue('#instanceFilterInput')) === 'Employees', 'the filter is pre-filled with the object name');
		await p.waitForTimeout(400); // the search is debounced
		const search = (await sent()).find(m => m.command === 'searchInstanceObjects');
		check(search && search.query === 'Employees', 'and the whole instance is searched for it (' + JSON.stringify(search) + ')');

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		check.done();
		await p.close();
	});
});
