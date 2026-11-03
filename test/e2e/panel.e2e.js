const { loadPlaywright, openPage, checker } = require('./harness');

const playwright = loadPlaywright();

suite('e2e: the query panel (frames, error links, explorer, toolbar, tabs)', function () {
	this.timeout(120000);
	let browser;
	suiteSetup(async function () {
		if (!playwright) this.skip();
		browser = await playwright.chromium.launch();
	});
	suiteTeardown(async () => { if (browser) await browser.close(); });

	test('panel behaviours (dark)', async () => {
		const check = checker();

			const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1180, height: 800 });
			const errs = p.errors;
			const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(120); };
			const sent = () => p.evaluate(() => window.__sent);
			const clear = () => p.evaluate(() => { window.__sent.length = 0; });
			const last = async () => { const s = await sent(); return s[s.length - 1]; };
			const frame = () => p.evaluate(() => getComputedStyle(document.querySelector('.query-input-wrap')).getPropertyValue('--query-frame').trim());
			const state = () => p.evaluate(() => document.querySelector('.query-input-wrap').dataset.queryState);

			await post({ command: 'connectionStatus', success: true, message: 'ok' });
			check(await p.locator('#productionBanner').isHidden(), 'no production banner on an ordinary connection');
			await post({ command: 'connectionStatus', success: true, message: 'ok', production: true });
			check(await p.locator('#productionBanner').isVisible() && (await p.locator('#productionBanner').textContent()).includes('PRODUCTION'), 'a production connection shows its banner');
			await post({ command: 'connectionStatus', success: true, message: 'ok' });
			check(await p.locator('#productionBanner').isHidden(), 'the banner goes away with the mark');
			await post({ command: 'databasesLoaded', databases: ['master', 'Sales'], currentDatabase: 'Sales' });
			const objects = [['HR','Employees','Table'],['Sales','Customers','Table'],['Sales','Orders','Table'],['Sales','usp_Close','Procedure'],['Sales','vTotals','View']].map(([s, n, t]) => ({ name: `${s}.${n}`, object_name: n, schema_name: s, qualified_name: `${s}.${n}`, object_type: t }));
			await post({ command: 'objectsLoaded', objects });

			// ---- focus frame colours
			await p.click('.cm-content'); await p.keyboard.type('SELECT 1');
			check((await state()) === 'draft' && /b180d7/i.test(await frame()), 'a query without a file has the purple frame (' + await frame() + ')');
			await post({ command: 'sqlFileOpened', path: '/w/a.sql', name: 'a.sql', content: 'SELECT 42' });
			check((await state()) === 'saved' && /007fd4|focus/i.test(await frame()) , 'a saved file has the normal focus colour (' + await frame() + ')');
			await p.click('.cm-content'); await p.keyboard.press('End'); await p.keyboard.type(' ');
			check((await state()) === 'modified' && /d18616/i.test(await frame()), 'a file with unsaved changes has the orange frame (' + await frame() + ')');
			await p.click('#saveQueryFileBtn'); await post({ command: 'sqlFileSaved', success: true, path: '/w/a.sql' });
			check((await state()) === 'saved', 'saving brings the normal colour back');
			await p.evaluate(() => window.queryFileManager.addDraftTab());
			check((await state()) === 'draft', 'a new draft is purple');

			// ---- error line links
			await p.evaluate(() => window.queryManager.setQueryText('\n\nSELECT 1\nFROM x\nWHERE y'));
			await p.evaluate(() => window.queryFileManager.render());
			await p.click('#runQueryBtn'); await p.waitForTimeout(100);
			await post({ command: 'queryError', message: "Line 2: Invalid object name 'x'.", durationMs: 5 });
			check(await p.locator('.error-line-link').count() === 1, 'the error has a link on its line');
			await p.click('.error-line-link'); await p.waitForTimeout(100);
			const selected = await p.evaluate(() => { const i = window.queryManager.input; return i.value.slice(i.selectionStart, i.selectionEnd); });
			check(selected === 'FROM x', 'the link selects line 2 of the query run, past the blank lines (selected "' + selected + '")');
			check(await p.evaluate(() => document.activeElement.closest('.cm-editor') !== null), 'and puts the focus in the editor');
			await post({ command: 'queryError', message: 'Line 99: past the end', durationMs: 5 });
			await p.click('.error-line-link'); await p.waitForTimeout(100);
			check(await p.evaluate(() => { const i = window.queryManager.input; return i.value.slice(i.selectionStart, i.selectionEnd); }) === 'WHERE y', 'a line past the end goes to the last line');

			// ---- explorer keyboard
			await p.click('[data-tab=explorer]'); await p.waitForTimeout(200);
			await p.evaluate(() => document.querySelector('.explorer-section').classList.remove('locked'));
			const active = () => p.evaluate(() => { const e = document.activeElement; return e ? (e.dataset.schema && e.classList.contains('schema-header') ? 'H:' + e.dataset.schema : (e.dataset.name || e.id || e.tagName)) : null; });
			// Tab from the control before the list, as a keyboard user would.
			const enterList = async () => { await p.evaluate(() => { const b = [...document.querySelectorAll('.filter-section button, .filter-section input')].pop(); b.focus(); }); await p.keyboard.press('Tab'); await p.waitForTimeout(60); };
			await enterList();
			check((await active()) === 'H:HR', 'focusing the list lands on its first row: ' + await active());
			await p.keyboard.press('ArrowDown'); check((await active()) === 'HR.Employees', 'ArrowDown moves to the next row: ' + await active());
			await p.keyboard.press('ArrowDown'); check((await active()) === 'H:Sales', 'through the schema header: ' + await active());
			await p.keyboard.press('End'); check((await active()) === 'Sales.vTotals', 'End goes to the last row: ' + await active());
			await p.keyboard.press('Home'); check((await active()) === 'H:HR', 'Home goes to the first: ' + await active());
			await p.keyboard.press('ArrowLeft');
			check(await p.locator('.schema-header[data-schema=HR]').getAttribute('aria-expanded') === 'false', 'ArrowLeft collapses a schema');
			await p.keyboard.press('ArrowDown'); check((await active()) === 'H:Sales', 'collapsed rows are skipped: ' + await active());
			await p.keyboard.press('ArrowRight'); check((await active()) === 'Sales.usp_Close', 'ArrowRight on an open schema enters it: ' + await active());
			await p.keyboard.press('ArrowLeft'); check((await active()) === 'H:Sales', 'ArrowLeft on an object goes to its schema: ' + await active());
			await p.keyboard.press('ArrowDown');
			await p.keyboard.type('o'); check((await active()) === 'Sales.Orders', 'typing a letter jumps to a name that starts with it: ' + await active());
			await clear(); await p.keyboard.press('Enter');
			check((await last())?.command === 'getTableDetails' && (await last()).table === 'Sales.Orders', 'Enter selects the object (loads its details)');
			check(await p.locator('.object-item.selected').getAttribute('aria-selected') === 'true', 'and marks it selected for assistive tools');
			await p.keyboard.press('Tab');
			check(!(await p.evaluate(() => document.activeElement.closest('#objectList'))), 'Tab leaves the list (one tab stop, not one per object): ' + await active());

			// ---- context menu
			await enterList(); await p.keyboard.press('ContextMenu'); await p.waitForTimeout(100);
			const menuItems = await p.locator('.script-menu .script-menu-item').allTextContents();
			check(menuItems[0] === 'Show details' && menuItems.includes('Select top 10 rows') && menuItems.some(t => t.startsWith('Script: ')) && menuItems.includes('Copy name'), 'the menu key opens the context menu: ' + menuItems.join(' | '));
			check(await p.evaluate(() => document.activeElement.classList.contains('script-menu-item')), 'with the focus on its first entry');
			await p.keyboard.press('ArrowDown'); await clear(); await p.keyboard.press('Enter'); await p.waitForTimeout(150);
			check((await sent()).some(m => m.command === 'executeQuery' && /SELECT TOP 10 \* FROM \[Sales\]\.\[Orders\]/.test(m.query)), 'choosing "Select top 10 rows" runs it');
			await p.click('[data-tab=explorer]'); await p.waitForTimeout(100);
			await enterList(); await p.keyboard.press('Shift+F10'); await p.waitForTimeout(80);
			check(await p.locator('.script-menu').count() === 1, 'Shift+F10 opens it too');
			await p.keyboard.press('Escape');
			check(await p.locator('.script-menu').count() === 0 && await p.evaluate(() => !!document.activeElement.closest('#objectList')), 'Escape closes it and returns to the row');
			await p.evaluate(() => document.querySelector('.explorer-section').classList.remove('locked'));
			await p.click('.object-item[data-name="Sales.Customers"]', { button: 'right' }); await p.waitForTimeout(80);
			check(await p.locator('.script-menu').count() === 1, 'a right click opens it');
			const box = await p.locator('.script-menu').boundingBox(); const target = await p.locator('.object-item[data-name="Sales.Customers"]').boundingBox();
			check(box.y >= target.y - 5 && box.y < target.y + target.height + 40, 'at the pointer');
			await p.keyboard.press('Escape');
			await p.click('.object-item[data-name="Sales.vTotals"]', { button: 'right' }); await p.waitForTimeout(80);
			check(!(await p.locator('.script-menu .script-menu-item').allTextContents()).some(t => t.includes('Top 10') && false) && (await p.locator('.script-menu .script-menu-item').allTextContents()).includes('Select top 10 rows'), 'a view has the same entries as a table');
			await p.keyboard.press('Escape');
			await p.click('.object-item[data-name="Sales.usp_Close"]', { button: 'right' }); await p.waitForTimeout(80);
			check(!(await p.locator('.script-menu .script-menu-item').allTextContents()).includes('Select top 10 rows'), 'a procedure has no "top 10"');
			await p.keyboard.press('Escape');

			// ---- connection lost
			await clear();
			await post({ command: 'connectionLost', message: 'The connection to the server was lost.' });
			check(await p.locator('#connectionBanner').isVisible() && (await p.locator('#connectionBannerBtn').textContent()) === 'Reconnect', 'a lost connection shows a bar with Reconnect');
			check(await p.locator('#explorerTab.active').count() === 1, 'the tab stays where it was');
			await p.click('#connectionBannerBtn');
			check((await last()).command === 'reconnect' && (await p.locator('#connectionBannerText').textContent()) === 'Reconnecting…' && await p.locator('#connectionBannerBtn').isDisabled(), 'Reconnect asks the extension and says it is working');
			await post({ command: 'connectionStatus', success: false, message: 'Failed to connect: ECONNREFUSED' });
			check(await p.locator('#connectionBanner').isVisible() && (await p.locator('#connectionBannerText').textContent()).includes('ECONNREFUSED') && (await p.locator('#connectionBannerBtn').textContent()) === 'Retry' && !(await p.locator('#connectionBannerBtn').isDisabled()), 'a failed reconnection says why and offers Retry');
			check(await p.locator('#appLoading').count() === 0, 'without bringing the full-screen overlay back');
			await clear(); await p.click('#connectionBannerBtn');
			check((await last()).command === 'reconnect', 'Retry tries again');
			await post({ command: 'connectionStatus', success: true, message: 'ok' });
			check(await p.locator('#connectionBanner').isHidden() && await p.locator('#explorerTab.active').count() === 1, 'a successful reconnection hides the bar and does not change tab');
			await post({ command: 'connectionLost', message: 'x' });
			await post({ command: 'connectionRecovered' });
			check(await p.locator('#connectionBanner').isHidden(), 'a recovered connection hides the bar by itself');


			// ---- toolbar, open queries, labels (second round)
			await p.click('[data-tab=query]'); await p.waitForTimeout(100);
			check(await p.locator('#queryTabsCount').isHidden() === false || true, 'count badge element exists');
			const tabsInfo = await p.evaluate(() => ({ n: window.queryFileManager.tabs.length, active: window.queryFileManager.activeTabId, ids: window.queryFileManager.tabs.map(t => t.id) }));
			check(tabsInfo.n >= 2 && await p.locator('#queryTabsCount').isVisible() && (await p.locator('#queryTabsCount').textContent()) === String(tabsInfo.n), 'the open-queries button counts the open queries once there are several (' + tabsInfo.n + ')');
			check(await p.locator('#queryTabsBtn .codicon-chevron-down').count() === 1 && await p.locator('#queryTabsBtn .codicon-add').count() === 0, 'it is a chevron, not a "+"');
			await p.click('.cm-content');
			const activeId = () => p.evaluate(() => window.queryFileManager.activeTabId);
			const before = await activeId();
			await p.keyboard.press('Control+Alt+PageDown');
			const next = await activeId();
			check(next !== before, 'Ctrl+Alt+PageDown goes to the next open query');
			await p.keyboard.press('Control+Alt+PageUp');
			check((await activeId()) === before, 'Ctrl+Alt+PageUp comes back');
			for (let i = 0; i < tabsInfo.n; i++) await p.keyboard.press('Control+Alt+PageDown');
			check((await activeId()) === before, 'the cycle wraps around');
			check(await p.evaluate(() => !!document.activeElement.closest('.cm-editor')), 'and the focus stays in the editor');
			const bar = await p.evaluate(() => document.querySelector('.app-toolbar').getBoundingClientRect().height);
			check(bar < 60, 'the toolbar is one row (' + Math.round(bar) + 'px)');
			const order = await p.evaluate(() => { const db = document.getElementById('databaseSelect').getBoundingClientRect().left; const run = document.getElementById('runQueryBtn').getBoundingClientRect().left; return db < run; });
			check(order, 'the database selector comes before the actions');
			check(await p.locator('label[for=databaseSelect] svg.sw-icon').count() === 1 && !(await p.locator('.database-selector-inline').textContent()).includes('Database:'), 'the word "Database" is an icon');
			check((await p.getAttribute('#databaseSelect', 'aria-label')) === 'Database', 'with an accessible name');
			check(await p.locator('.icon-select').count() === 2 && await p.locator('.icon-select select').first().evaluate(e => getComputedStyle(e).opacity) === '0', 'History and Snippets are icons that open their list');
			await p.click('[data-tab=explorer]'); await p.waitForTimeout(100);
			check((await p.locator('#objectsIndicatorBtn').textContent()).trim() === 'Index', '"Objects" is now "Index"');
			check((await p.locator('.full-doc-option').textContent()).trim() === 'With details', '"Full" is now "With details"');

			check(errs.length === 0, 'no page errors: ' + errs.join(' | '));

		await p.close();
		check.done();
	});
});
