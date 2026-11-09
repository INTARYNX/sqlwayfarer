const assert = require('assert'); // eslint-disable-line no-unused-vars
const { loadPlaywright, openPage, checker, themes, tmpPath } = require('./harness');

const playwright = loadPlaywright();

const objs = [['dbo','Employees','Table'],['dbo','HumanOrders','Table'],['Sales','Orders','Table'],['Sales','OrderLines','Table'],['Sales','vOrderTotals','View'],['dbo','uspGetEmployees','Procedure'],['dbo','fn_Tax','Function']].map(([s, n, t]) => ({ name: s === 'dbo' ? n : `${s}.${n}`, object_name: n, schema_name: s, qualified_name: `${s}.${n}`, object_type: t }));
const cols = { 'dbo.Employees': [['ID','int',0,1],['Name','nvarchar(50)',1,0],['Order','int',1,0]], 'Sales.Orders': [['OrderID','int',0,1],['ID','int',0,0],['Total','money',1,0]] };

suite('e2e: SQL autocompletion in the real query editor', function () {
	this.timeout(120000);
	let browser;
	suiteSetup(async function () {
		if (!playwright) this.skip();
		browser = await playwright.chromium.launch();
	});
	suiteTeardown(async () => { if (browser) await browser.close(); });

	for (const theme of Object.keys(themes)) {
		test(`dropdown, keys, joins, expansion, snippets and settings (${theme})`, async () => {
			const check = checker();

			const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', theme, { width: 1000, height: 620 });
			const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(80); };
			const items = () => p.evaluate(() => [...document.querySelectorAll('.sql-autocomplete li.ac-item')].map(li => li.textContent));
			const info = () => p.evaluate(() => { const i = document.querySelector('.sql-autocomplete li.ac-info'); return i && i.style.display !== 'none' ? i.textContent : null; });
			const open = () => p.evaluate(() => getComputedStyle(document.querySelector('.sql-autocomplete')).display !== 'none');
			const sent = () => p.evaluate(() => window.__sent);
			const reply = async () => { // answer column / parameter requests like the host would
				for (const m of await sent()) {
					if (m.command === 'getObjectColumns') await post({ command: 'objectColumnsLoaded', database: m.database, objectName: m.objectName, columns: (cols[m.objectName] || []).map(([name, type, nullable, isPrimaryKey]) => ({ name, type, nullable: !!nullable, isPrimaryKey: !!isPrimaryKey })) });
					if (m.command === 'getObjectParameters') await post({ command: 'objectParametersLoaded', database: m.database, objectName: m.objectName, parameters: [{ name: '@Dept', type: 'int' }, { name: '@Active', type: 'bit' }] });
				}
				await p.evaluate(() => { window.__sent.length = 0; });
			};
			const type = async t => { await p.keyboard.type(t, { delay: 15 }); await p.waitForTimeout(120); await reply(); await p.waitForTimeout(120); };
			const fresh = async () => { await p.click('.cm-content'); await p.keyboard.press('Control+A'); await p.keyboard.press('Delete'); await p.waitForTimeout(50); };

			await post({ command: 'connectionStatus', success: true, message: 'ok' });
			await post({ command: 'databasesLoaded', databases: ['master', 'AppDb'], currentDatabase: 'AppDb' });
			await p.evaluate(() => { appState.currentDatabase = 'AppDb'; });
			await post({ command: 'objectsLoaded', objects: objs });
			await post({ command: 'foreignKeysLoaded', database: 'AppDb', foreignKeys: [{ fkName: 'FK_O_E', fromTable: 'Sales.Orders', toTable: 'dbo.Employees', fromColumn: 'ID', toColumn: 'ID' }] });
			check((await sent()).some(m => m.command === 'getAutocompleteSettings'), theme + ': the editor asks for its settings');
			await post({ command: 'autocompleteSettings', settings: {} });

			await fresh(); await type('SELECT * FROM ho');
			check(await open() && (await items())[0].includes('HumanOrders'), theme + ': initials "ho" -> HumanOrders (' + (await items()).slice(0, 3) + ')');
			await p.keyboard.press('Tab');
			check((await p.evaluate(() => window.queryManager.input.value)) === 'SELECT * FROM dbo.HumanOrders', theme + ': Tab accepts (the schema is written)');

			await fresh(); await type('SELECT * FROM Employees e JOIN ');
			if (0) console.log('DBG', await open(), (await items()).slice(0,3), await p.evaluate(() => [appState.foreignKeys.length, appState.currentDatabase, window.queryManager.input.value, window.queryManager.autocomplete.isOpen()]));
			check(await open() && (await items())[0].includes('ON o.ID = e.ID') || (await items())[0].includes('ON '), theme + ': JOIN offers the FK join first (' + (await items())[0] + ')');
			await p.screenshot({ path: tmpPath(`ac_${theme}_join.png`), clip: { x: 0, y: 0, width: 1000, height: 620 } });
			await p.keyboard.press('Enter');
			check((await p.evaluate(() => window.queryManager.input.value)) === 'SELECT * FROM Employees e JOIN Sales.Orders o ON o.ID = e.ID', theme + ': the join item inserts table, alias and condition');

			await fresh(); await type('SELECT na FROM Employees e');
			await p.keyboard.press('Home'); for (let i = 0; i < 9; i++) await p.keyboard.press('ArrowRight');
			await p.keyboard.press('Control+Space'); await p.waitForTimeout(150); await reply();
			const colsOnly = await items();
			check(colsOnly.length > 0 && colsOnly[0].startsWith('Name'), theme + ': a column without prefix, from the FROM after the caret (' + colsOnly.slice(0, 2) + ')');
			check((await info() || '').includes('Employees.Name') && (await info()).includes('nvarchar(50)'), theme + ': the details line describes it (' + await info() + ')');
			await p.screenshot({ path: tmpPath(`ac_${theme}_columns.png`), clip: { x: 0, y: 0, width: 1000, height: 620 } });
			await p.keyboard.press('Escape');

			await fresh(); await type('SELECT Employees.');
			check(await open(), theme + ': a dot lists columns');
			await p.keyboard.press('Escape');

			await fresh(); await type('WITH c AS (SELECT ID AS EmpId, Name FROM Employees) SELECT  FROM c');
			for (let i = 0; i < 7; i++) await p.keyboard.press('ArrowLeft');
			await type('c.');
			check(await open() && JSON.stringify((await items()).map(t => t.split(/\s/)[0])) === '["EmpId","Name"]', theme + ': CTE columns (' + (await items()) + ')');
			await p.keyboard.press('Escape');

			await fresh(); await type('SELECT *');
			await p.keyboard.press('Control+Space'); await p.waitForTimeout(100);
			check(!(await items()).some(t => t.startsWith('Expand')), theme + ': no list to expand before FROM exists');
			await p.keyboard.type(' FROM Employees', { delay: 10 }); await p.keyboard.press('Escape'); await reply();
			for (let i = 0; i < 15; i++) await p.keyboard.press('ArrowLeft');
			await p.keyboard.press('Control+Space'); await p.waitForTimeout(150); await reply();
			check((await items())[0] && (await items())[0].startsWith('Expand *'), theme + ': Ctrl+Space after * proposes the expansion (' + (await items())[0] + ')');
			await p.keyboard.press('Tab');
			check((await p.evaluate(() => window.queryManager.input.value)) === 'SELECT ID, Name, [Order] FROM Employees', theme + ': it replaces the star (' + await p.evaluate(() => window.queryManager.input.value) + ')');

			await fresh(); await type('EXEC uspGetEmployees ');
			await p.waitForTimeout(150); await reply();
			check((await items()).join('|').startsWith('All parameters'), theme + ': EXEC proc lists the parameters (' + (await items()).map(t => t.split(/\s/)[0]) + ')');
			await p.screenshot({ path: tmpPath(`ac_${theme}_exec.png`), clip: { x: 0, y: 0, width: 1000, height: 620 } });
			await p.keyboard.press('Escape');

			await fresh(); await type('ssf');
			check((await items())[0] && (await items())[0].startsWith('ssf'), theme + ': snippet abbreviation offered');
			await p.keyboard.press('Tab');
			check((await p.evaluate(() => window.queryManager.input.value)) === 'SELECT * FROM ', theme + ': and expanded');

			await fresh(); await type('SELECT * FROM Sal');
			check((await items())[0].startsWith('Sales'), theme + ': schema offered');
			const at = (await items()).findIndex(t => t.startsWith('Sales') && t.endsWith('Schema'));
			for (let i = 0; i < at; i++) await p.keyboard.press('ArrowDown');
			await p.keyboard.press('Tab'); await p.waitForTimeout(200);
			check(at >= 0 && await open() && (await items()).some(t => t.startsWith('Orders')), theme + ': accepting a schema re-opens the list on its objects (' + (await items()).slice(0, 3) + ')');
			await p.keyboard.press('Escape');

			await post({ command: 'autocompleteSettings', settings: { acceptKeys: 'tab' } });
			await fresh(); await type('SELECT * FROM Emp');
			await p.keyboard.press('Enter');
			check((await p.evaluate(() => window.queryManager.input.value)).includes('\n') && !(await open()), theme + ': acceptKeys=tab leaves Enter to the editor');
			await post({ command: 'autocompleteSettings', settings: { autoTrigger: false } });
			await fresh(); await type('SELECT * FROM Emp');
			check(!(await open()), theme + ': autoTrigger=false keeps the list closed');
			await p.keyboard.press('Control+Space'); await p.waitForTimeout(120);
			check(await open(), theme + ': but Ctrl+Space opens it');
			await post({ command: 'autocompleteSettings', settings: { enabled: false } });
			await p.keyboard.press('Escape'); await fresh(); await p.keyboard.press('Control+Space'); await p.waitForTimeout(100);
			check(!(await open()), theme + ': enabled=false turns it all off');
			check(p.errors.length === 0, theme + ': no page errors ' + p.errors.join('|'));
			await p.close();
	
			check.done();
		});
	}
});
