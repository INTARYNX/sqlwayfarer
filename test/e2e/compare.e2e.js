const { loadPlaywright, openPage, checker } = require('./harness');

const playwright = loadPlaywright();

const column = (name, extra) => Object.assign({ name, type: 'int', nullable: false, identity: null, computed: null, default: null, collation: null }, extra);
const table = (name, extra) => Object.assign({ schema: 'dbo', name, columns: [column('id')], primaryKey: null, uniques: [], indexes: [], foreignKeys: [], checks: [] }, extra);
const proc = (name, definition) => ({ schema: 'dbo', name, type: 'procedure', definition, ansiNulls: true, quotedIdentifier: true });

const DIFF = {
	identical: false,
	summary: { added: 1, removed: 1, modified: 2, risks: { safe: 3, caution: 1, destructive: 2, manual: 0 } },
	skipped: [],
	notCompared: { reference: {}, current: { synonyms: 2 } },
	changes: [
		{ kind: 'table', name: 'dbo.Customers', status: 'modified', reference: table('Customers'), current: table('Customers'), ops: [
			{ op: 'addColumn', risk: 'safe', column: column('phone', { type: 'varchar(30)', nullable: true }) },
			{ op: 'addColumn', risk: 'caution', needsDefault: true, column: column('tier') },
			{ op: 'dropColumn', risk: 'destructive', column: column('email', { type: 'varchar(200)' }) }
		] },
		{ kind: 'table', name: 'dbo.Invoices', status: 'added', current: table('Invoices', { columns: [column('id'), column('total', { type: 'decimal(10,2)' })] }), ops: [{ op: 'createTable', risk: 'safe' }] },
		{ kind: 'table', name: 'dbo.Log', status: 'removed', reference: table('Log'), ops: [{ op: 'dropTable', risk: 'destructive' }] },
		{ kind: 'procedure', name: 'dbo.usp_Load', status: 'modified', reference: proc('usp_Load', 'CREATE PROC dbo.usp_Load AS\n    SELECT 1\n    SELECT 2\n    SELECT 3\n    SELECT 4\n    SELECT 5'), current: proc('usp_Load', 'ALTER PROC dbo.usp_Load AS\n    SELECT 1\n    SELECT 2\n    SELECT 33\n    SELECT 4\n    SELECT 5'), ops: [{ op: 'alter', risk: 'safe', what: ['definition'] }] }
	]
};

suite('e2e: the Compare tab', function () {
	this.timeout(120000);
	let browser;
	suiteSetup(async function () {
		if (!playwright) this.skip();
		browser = await playwright.chromium.launch();
	});
	suiteTeardown(async () => { if (browser) await browser.close(); });

	for (const theme of ['dark', 'light']) {
		test(`${theme}: sources, comparison, detail, selection, script`, async () => {
			const check = checker();
			const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', theme, { width: 1100, height: 720 });
			const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(100); };
			const sent = () => p.evaluate(() => window.__sent.slice());
			await post({ command: 'connectionStatus', success: true, message: 'ok' });
			await post({ command: 'databasesLoaded', databases: ['Sales'], currentDatabase: 'Sales' });

			await p.evaluate(() => { window.__sent.length = 0; });
			await p.click('[data-tab=compare]');
			check(await p.isVisible('#compareTab') && !(await p.isVisible('#queryTab')), `${theme}: the Compare tab opens`);
			check((await sent()).some(m => m.command === 'getCompareSources' && m.database === 'Sales'), `${theme}: the sources are asked for the database`);
			check(await p.isVisible('#compareEmpty') && await p.isDisabled('#compareRunBtn'), `${theme}: it explains itself, and Compare waits for a reference`);

			await post({ command: 'compareSources', database: 'Sales', snapshots: [{ name: 'Sales_ref_20261103_090507', source: 'Sales', createDate: '2026-11-03T09:05:07Z', state: 'ONLINE' }], databases: ['SalesCopy'], support: { supported: true } });
			const options = await p.$$eval('#compareReference option', os => os.map(o => o.value));
			check(options.join() === 'Sales_ref_20261103_090507,SalesCopy', `${theme}: snapshots first, then the other databases (${options})`);
			check(await p.inputValue('#compareReference') === 'Sales_ref_20261103_090507', `${theme}: the latest snapshot is picked`);
			check(!(await p.isDisabled('#compareRunBtn')) && !(await p.isDisabled('#compareSnapshotBtn')), `${theme}: Compare and Take snapshot are available`);
			check(await p.isVisible('#compareDropSnapshotBtn'), `${theme}: a snapshot can be dropped`);
			await p.selectOption('#compareReference', 'SalesCopy');
			check(!(await p.isVisible('#compareDropSnapshotBtn')), `${theme}: another database cannot`);
			await p.selectOption('#compareReference', 'Sales_ref_20261103_090507');

			await p.evaluate(() => { window.__sent.length = 0; });
			await p.click('#compareRunBtn');
			const run = (await sent()).find(m => m.command === 'runCompare');
			check(run && run.database === 'Sales' && run.reference === 'Sales_ref_20261103_090507', `${theme}: Compare sends both names`);
			check((await p.textContent('#compareNote')).includes('Reading'), `${theme}: says it is reading`);

			await post({ command: 'compareResult', database: 'Sales', reference: 'Sales_ref_20261103_090507', diff: DIFF, serverVersion: '16.0.4305.5', createOrAlter: true, durationMs: 1800 });
			const rows = await p.$$eval('.compare-row .compare-name', els => els.map(e => e.textContent));
			check(rows.join() === 'dbo.Customers,dbo.Invoices,dbo.Log,dbo.usp_Load', `${theme}: the changes are listed by kind (${rows})`);
			check((await p.$$eval('.compare-group', els => els.map(e => e.textContent))).join() === 'Tables (3),Procedures (1)', `${theme}: with their counts`);
			check((await p.textContent('#compareSummary')).includes('1 added · 2 modified · 1 removed') && (await p.textContent('#compareSummary')).includes('2 synonyms'), `${theme}: the summary counts, and says what is not compared`);
			check(await p.$$eval('.compare-row .compare-risk', els => els.map(e => e.textContent)).then(x => x.join()) === 'destructive,destructive', `${theme}: risky changes are marked`);
			check((await p.textContent('#compareSelected')).startsWith('4 of 4 selected') && (await p.textContent('#compareSelected')).includes('2 destructive step(s) left out'), `${theme}: all picked, the destructive ones said to be left out (${await p.textContent('#compareSelected')})`);
			check(await p.inputValue('#compareTarget') === 'modern', `${theme}: the target follows the server`);

			// The detail of a table: one line per operation, with its sign and risk.
			const lines = await p.$$eval('.compare-op', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
			check(lines[0].startsWith('+ column phone varchar(30) NULL') && lines[1].includes('caution') && lines[2].startsWith('− column email') && lines[2].includes('destructive'), `${theme}: the table detail (${lines.join(' | ')})`);

			// A procedure: the lines that changed, with context.
			await p.click('.compare-row[data-id="procedure:dbo.usp_Load"]');
			const diffLines = await p.$$eval('.compare-line', els => els.map(e => `${e.className.replace('compare-line ', '')}:${e.querySelector('.compare-line-text').textContent}`));
			check(diffLines.includes('del:    SELECT 3') && diffLines.includes('add:    SELECT 33'), `${theme}: the definition diff shows the changed line (${diffLines.length} lines)`);
			check(!diffLines.some(l => l.startsWith('del:CREATE') || l.startsWith('add:CREATE')), `${theme}: CREATE or ALTER is not a difference`);

			// Added and removed tables.
			await p.click('.compare-row[data-id="table:dbo.Invoices"]');
			check((await p.$$eval('.compare-op.add', els => els.length)) === 2, `${theme}: an added table lists its columns as added`);
			await p.click('.compare-row[data-id="table:dbo.Log"]');
			check((await p.$$eval('.compare-op.del', els => els.length)) === 1, `${theme}: a removed table lists what it had as removed`);

			// Filter and selection.
			await p.fill('#compareFilter', 'invoice');
			check((await p.$$eval('.compare-row .compare-name', els => els.map(e => e.textContent))).join() === 'dbo.Invoices', `${theme}: the filter narrows the list`);
			await p.fill('#compareFilter', '');
			await p.uncheck('.compare-row[data-id="table:dbo.Log"] input');
			check((await p.textContent('#compareSelected')).startsWith('3 of 4 selected'), `${theme}: unchecking a change leaves it out`);
			await p.check('#compareDestructive');
			check(!(await p.textContent('#compareSelected')).includes('left out'), `${theme}: with destructive changes asked for, none is left out`);

			// The script.
			await p.evaluate(() => { window.__sent.length = 0; });
			await p.click('#compareScriptBtn');
			const build = (await sent()).find(m => m.command === 'buildCompareScript');
			check(build && build.ids.join() === 'table:dbo.Customers,table:dbo.Invoices,procedure:dbo.usp_Load' && build.allowDestructive === true && build.legacy === false, `${theme}: the script is asked for the picked changes (${JSON.stringify(build)})`);
			await post({ command: 'compareScript', script: '-- the script\nSELECT 1', steps: 3, skipped: [], warnings: [] });
			check(await p.isVisible('#queryTab'), `${theme}: the script opens in the Query tab`);
			check((await p.evaluate(() => window.queryManager.input.value)).includes('-- the script'), `${theme}: with its text`);

			// Failure and nothing to script.
			await p.click('[data-tab=compare]');
			await post({ command: 'compareFailed', message: 'cannot read Sales_ref' });
			check((await p.getAttribute('#compareNote', 'class')).includes('error') && (await p.textContent('#compareNote')).includes('cannot read'), `${theme}: a failure is shown in the note`);
			check(p.errors.length === 0, `${theme}: no page error: ` + p.errors.join(' | '));
			await p.close();
		});
	}

	test('keyboard: arrows move through the changes and show them, space picks', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 720 });
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(100); };
		await post({ command: 'connectionStatus', success: true, message: 'ok' });
		await post({ command: 'databasesLoaded', databases: ['Sales'], currentDatabase: 'Sales' });
		await p.click('[data-tab=compare]');
		await post({ command: 'compareResult', database: 'Sales', reference: 'R', diff: DIFF, createOrAlter: false, durationMs: 100 });
		check(await p.inputValue('#compareTarget') === 'legacy', 'an old server is offered the older script');
		await p.focus('.compare-row[data-id="table:dbo.Customers"]');
		await p.keyboard.press('ArrowDown');
		check(await p.evaluate(() => document.activeElement.dataset.id) === 'table:dbo.Invoices', 'ArrowDown moves to the next change');
		check((await p.textContent('.compare-detail-title')).includes('dbo.Invoices'), 'and shows it');
		await p.keyboard.press('Space');
		check((await p.textContent('#compareSelected')).startsWith('3 of 4'), 'Space unpicks it');
		await p.keyboard.press('End');
		check(await p.evaluate(() => document.activeElement.dataset.id) === 'procedure:dbo.usp_Load', 'End goes to the last');
		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		check.done();
		await p.close();
	});

	test('an identical comparison says so, and offers no script', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 720 });
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(100); };
		await post({ command: 'connectionStatus', success: true, message: 'ok' });
		await post({ command: 'databasesLoaded', databases: ['Sales'], currentDatabase: 'Sales' });
		await p.click('[data-tab=compare]');
		await post({ command: 'compareResult', database: 'Sales', reference: 'R', diff: { identical: true, changes: [], summary: { added: 0, removed: 0, modified: 0, risks: {} }, skipped: [], notCompared: { reference: {}, current: {} } }, createOrAlter: true, durationMs: 100 });
		check((await p.textContent('#compareSummary')).includes('Identical.') && (await p.textContent('#compareList')).includes('Nothing differs.'), 'identical is said');
		check(!(await p.isVisible('#compareFooter')), 'and there is no script to make');
		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		check.done();
		await p.close();
	});

	test('a snapshot that cannot be taken says why, in the button', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 720 });
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(100); };
		await post({ command: 'connectionStatus', success: true, message: 'ok' });
		await post({ command: 'databasesLoaded', databases: ['Sales'], currentDatabase: 'Sales' });
		await p.click('[data-tab=compare]');
		await post({ command: 'compareSources', database: 'Sales', snapshots: [], databases: ['Other'], support: { supported: false, reason: 'Azure SQL Database does not have database snapshots.' } });
		check(await p.isDisabled('#compareSnapshotBtn') && (await p.getAttribute('#compareSnapshotBtn', 'title')).includes('Azure SQL Database'), 'the button is off and says why');
		check(!(await p.isDisabled('#compareRunBtn')), 'another database can still be compared with');
		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		check.done();
		await p.close();
	});
});
