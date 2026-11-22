const { loadPlaywright, openPage, post, sent, clearSent, checker } = require('./harness');

const playwright = loadPlaywright();

const TABLE = {
	schema: 'dbo', name: 'Customers', key: ['id'], columns: ['id', 'name', 'amount'],
	excludedColumns: [], rowCountReference: 100, rowCountCurrent: 103
};
const NOT_COMPARABLE = { schema: 'dbo', name: 'Log', reason: 'No primary key, and no unique key whose columns are all NOT NULL.' };

const RESULT_TABLE = {
	schema: 'dbo', name: 'Customers', key: ['id'], columns: ['id', 'name', 'amount'], identityColumn: null,
	counts: { added: 1, modified: 1, removed: 1, same: 1 }, truncated: false,
	added: [{ id: 4, name: 'Dana', amount: 40 }],
	removed: [{ id: 1, name: 'Alice', amount: 10 }],
	modified: [{ key: [2], before: { id: 2, name: 'Bob', amount: 20 }, after: { id: 2, name: 'Bobby', amount: 25 }, changedColumns: ['name', 'amount'] }]
};

suite('e2e: the Compare tab, Data mode', function () {
	this.timeout(120000);
	let browser;
	suiteSetup(async function () {
		if (!playwright) this.skip();
		browser = await playwright.chromium.launch();
	});
	suiteTeardown(async () => { if (browser) await browser.close(); });

	test('listing tables, comparing, the detail, selection, script and apply', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 760 });
		await post(p, { command: 'connectionStatus', success: true, message: 'ok' });
		await post(p, { command: 'databasesLoaded', databases: ['Sales'], currentDatabase: 'Sales' });

		await p.click('[data-tab=compare]');
		await p.click('#compareModeData');
		check(await p.isVisible('#compareDataView') && !(await p.isVisible('#compareRefView')) && !(await p.isVisible('#compareRecentView')), 'the Data view shows, the others hide');
		check(await p.isDisabled('#dataListTablesBtn'), 'List tables waits for a reference');

		await post(p, { command: 'compareSources', database: 'Sales', snapshots: [], databases: ['SalesCopy'], support: { supported: true } });
		const options = await p.$$eval('#dataCompareReference option', os => os.map(o => o.value));
		check(options.includes('SalesCopy'), `the other database is offered as a reference (${options})`);
		await p.selectOption('#dataCompareReference', 'SalesCopy');
		check(!(await p.isDisabled('#dataListTablesBtn')), 'List tables is available once a reference is picked');

		await clearSent(p);
		await p.click('#dataListTablesBtn');
		check((await sent(p)).some(m => m.command === 'getDataCompareTables' && m.database === 'Sales' && m.reference === 'SalesCopy'), 'the tables are asked for');

		await post(p, { command: 'dataCompareTables', database: 'Sales', reference: 'SalesCopy', comparable: [TABLE], notComparable: [NOT_COMPARABLE], onlyInReference: [], onlyInCurrent: [], support: { supported: true, reason: '' } });
		check(await p.isVisible('#dataTablePicker'), 'the table picker shows');
		const rows = await p.$$eval('#dataTableList .compare-row', rs => rs.map(r => r.dataset.id));
		check(JSON.stringify(rows) === JSON.stringify(['dbo.Customers', 'dbo.Log']), `both the comparable and not-comparable tables are listed (${rows})`);
		check(await p.isChecked('#dataTableList .compare-row[data-id="dbo.Customers"] input'), 'the comparable table is checked by default');
		check(await p.isDisabled('#dataTableList .compare-row[data-id="dbo.Log"] input'), 'the not-comparable table cannot be checked');
		check(!(await p.isDisabled('#dataRunCompareBtn')), 'Compare data is available');

		await clearSent(p);
		await p.click('#dataRunCompareBtn');
		const runMessage = (await sent(p)).find(m => m.command === 'runDataCompare');
		check(runMessage && JSON.stringify(runMessage.tables) === JSON.stringify(['dbo.Customers']), `the picked table is compared (${JSON.stringify(runMessage)})`);

		await post(p, { command: 'dataCompareResult', database: 'Sales', reference: 'SalesCopy', tables: [RESULT_TABLE], durationMs: 420 });
		check(await p.isVisible('#dataCompareResult') && !(await p.isVisible('#dataTablePicker')), 'the result shows, the picker hides');
		const resultRows = await p.$$eval('#dataResultList .compare-row', rs => rs.length);
		check(resultRows === 3, `the three differing rows are listed (${resultRows})`);
		const detailTitle = await p.textContent('.compare-detail-title');
		check(/dbo\.Customers/.test(detailTitle), `a row is shown by default (${detailTitle})`);

		// A removed row's detail: Differences by default, no "Current" tab.
		await p.click('.compare-row:has(i[title="Not in the current database"])');
		check(await p.isDisabled('[data-view="after"]'), 'a removed row has no "Current" side');
		await p.click('[data-view="before"]');
		const beforeText = await p.textContent('#dataResultDetail');
		check(beforeText.includes('Alice'), `the reference row is shown (${beforeText})`);

		// A modified row's Differences tab: only the changed columns, old -> new.
		await p.click('.compare-row:has(i[title="Different from the reference"])');
		const changesText = await p.textContent('#dataResultDetail');
		check(changesText.includes('Bob') && changesText.includes('Bobby'), `the column change is shown (${changesText})`);

		// Deselecting the only table disables the footer actions.
		await p.click('#dataResultList .compare-group input[type="checkbox"]');
		check(await p.isDisabled('#dataScriptBtn') && await p.isDisabled('#dataExportBtn') && await p.isDisabled('#dataApplyBtn'), 'nothing to script once the table is unchecked');
		await p.click('#dataResultList .compare-group input[type="checkbox"]');
		check(!(await p.isDisabled('#dataScriptBtn')), 'checking it back re-enables the actions');

		await clearSent(p);
		await p.click('#dataScriptBtn');
		const scriptMessage = (await sent(p)).find(m => m.command === 'buildDataScript');
		check(scriptMessage && JSON.stringify(scriptMessage.ids) === JSON.stringify(['dbo.Customers']), `the script is asked for the selected table (${JSON.stringify(scriptMessage)})`);

		await clearSent(p);
		await p.click('#dataApplyBtn');
		check(await p.evaluate(() => document.getElementById('dataApplyOverlay').classList.contains('visible')), 'the Apply dialog opens');
		check((await sent(p)).some(m => m.command === 'getCompareTargets'), 'the Apply dialog asks for the targets');

		check(p.errors.length === 0, `no console error (${p.errors.join(' | ')})`);
		check.done();
	});
});
