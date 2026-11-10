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

	test('status chips narrow the list, and Before / After show the whole code', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 720 });
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(100); };
		const names = () => p.$$eval('.compare-row .compare-name', els => els.map(e => e.textContent).join());
		await post({ command: 'connectionStatus', success: true, message: 'ok' });
		await post({ command: 'databasesLoaded', databases: ['Sales'], currentDatabase: 'Sales' });
		await p.click('[data-tab=compare]');
		await post({ command: 'compareResult', database: 'Sales', reference: 'R', diff: DIFF, createOrAlter: true, durationMs: 100 });
		check((await p.$$eval('.compare-chip', els => els.map(e => e.textContent))).join() === 'Added 1,Modified 2,Removed 1,Tables 3,Procedures 1', 'a tag per status and per kind, with its count');
		await p.click('.compare-chip.added');
		check(await names() === 'dbo.Invoices', 'Added keeps the added ones');
		await p.click('.compare-chip.removed');
		check(await names() === 'dbo.Invoices,dbo.Log', 'Removed adds to it: the tags add up');
		await p.click('.compare-chip.added');
		check(await names() === 'dbo.Log', 'a click on a tag that is on turns it off');
		await p.click('.compare-chip.removed');
		check((await names()).split(',').length === 4, 'no tag on lists everything');
		await p.click('.compare-chip.modified');
		check(await names() === 'dbo.Customers,dbo.usp_Load', 'Modified keeps the modified ones');
		await p.click('.compare-chip.kind[data-kind=procedure]');
		check(await names() === 'dbo.usp_Load', 'a kind tag narrows it more: modified procedures');
		await p.click('.compare-chip.kind[data-kind=procedure]');

		await p.click('.compare-row[data-id="procedure:dbo.usp_Load"]');
		check(await p.isDisabled('.compare-view-tab[data-view=changes]') === false, 'the Changes tab is on');
		await p.click('.compare-view-tab[data-view=before]');
		let code = await p.$$eval('.compare-line-text', els => els.map(e => e.textContent));
		check(code.length === 6 && code[0] === 'CREATE PROC dbo.usp_Load AS' && code.includes('    SELECT 3'), `Before shows the whole reference code (${code.length} lines)`);
		await p.click('.compare-view-tab[data-view=after]');
		code = await p.$$eval('.compare-line-text', els => els.map(e => e.textContent));
		check(code.length === 6 && code.includes('    SELECT 33') && !code.includes('    SELECT 3'), 'After shows the whole current code');

		await p.click('.compare-chip.modified');
		await p.click('.compare-row[data-id="table:dbo.Invoices"]');
		check(await p.isDisabled('.compare-view-tab[data-view=before]') && !(await p.isDisabled('.compare-view-tab[data-view=after]')), 'an added table has no Before');
		check((await p.$$eval('.compare-line-text', els => els.map(e => e.textContent))).join() === 'column id int NOT NULL,column total decimal(10,2) NOT NULL', 'its After lists the whole table');
		await p.click('.compare-row[data-id="table:dbo.Log"]');
		check(await p.isDisabled('.compare-view-tab[data-view=after]') && (await p.$$eval('.compare-op', els => els.length)) === 1, 'a removed table has no After, and falls back to its changes');
		// The zip of what is picked, and shown.
		const exported = async () => {
			await p.evaluate(() => { window.__sent.length = 0; });
			await p.click('#compareExportBtn');
			return (await p.evaluate(() => window.__sent.slice())).find(m => m.command === 'exportCompareZip');
		};
		check(!(await p.isDisabled('#compareExportBtn')), 'Export zip is on while something is picked');
		check((await exported()).ids.length === 4, 'with nothing filtered it sends everything that is picked');
		await p.click('.compare-chip.added');
		await p.click('.compare-chip.removed');
		check((await exported()).ids.join() === 'table:dbo.Invoices,table:dbo.Log', 'with tags on it sends only the changes shown (the tags add up)');
		check((await p.textContent('#compareSelected')).includes('the changes shown only'), 'and the footer says so');
		await p.fill('#compareFilter', 'log');
		check((await exported()).ids.join() === 'table:dbo.Log', 'the filter by name narrows it too');
		await p.fill('#compareFilter', '');
		await p.uncheck('#compareShownOnly');
		check((await exported()).ids.length === 4, 'without "only the changes shown" every change that is picked goes');
		await p.check('#compareShownOnly');
		// The box of a group.
		await p.uncheck('.compare-group input');
		check(await p.isDisabled('#compareExportBtn') && (await p.$$eval('.compare-row input', els => els.every(e => !e.checked))), 'the box of a group drops all its changes');
		await p.check('.compare-group input');
		check((await exported()).ids.join() === 'table:dbo.Invoices,table:dbo.Log', 'and picks them again');
		await p.click('.compare-row[data-id="table:dbo.Log"] input');
		check(await p.$eval('.compare-group input', e => e.indeterminate), 'the box of a group is half on when some are picked');
		await p.click('.compare-row[data-id="table:dbo.Log"] input');
		await p.click('.compare-chip.added');
		await p.click('.compare-chip.removed');
		await post({ command: 'compareExported', path: 'C:/out/x.zip', count: 4, files: 9 });
		check((await p.textContent('#compareNote')).includes('Exported 4 changes (9 files) to C:/out/x.zip'), 'and says where the zip is');
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
	test('applying: pick the target, see where it stands, confirm on the extension side, follow it, read the result', async () => {
		const check = checker();
		for (const theme of ['dark', 'light']) {
			const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', theme, { width: 1100, height: 760 });
			const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(100); };
			const sent = () => p.evaluate(() => window.__sent.slice());
			const clear = () => p.evaluate(() => { window.__sent.length = 0; });
			await post({ command: 'connectionStatus', success: true, message: 'ok' });
			await post({ command: 'databasesLoaded', databases: ['Sales'], currentDatabase: 'Sales' });
			await p.click('[data-tab=compare]');
			check(await p.isDisabled('#compareApplyBtn'), `${theme}: Apply waits for a comparison`);
			await post({ command: 'compareResult', database: 'Sales', reference: 'R', diff: DIFF, createOrAlter: true, durationMs: 100 });
			check(!(await p.isDisabled('#compareApplyBtn')), `${theme}: and is there once there is one`);

			await clear();
			await p.click('#compareApplyBtn');
			check(await p.isVisible('#compareApplyOverlay'), `${theme}: the dialog opens`);
			const asked = await sent();
			check(asked.some(m => m.command === 'getCompareTargets') && asked.some(m => m.command === 'getCompareTargetDatabases' && m.connection === null), `${theme}: the connections and the databases are asked for`);
			check(await p.isDisabled('#compareApplyRunBtn'), `${theme}: nothing can be applied before a database is picked`);

			await post({ command: 'compareTargets', own: { name: 'Me', server: 'dev-sql' }, connections: [{ name: 'Prod', server: 'prod-sql' }] });
			check((await p.$$eval('#compareApplyConnection option', os => os.map(o => o.textContent))).join('|') === 'This connection (dev-sql)|Prod (prod-sql)', `${theme}: this connection first, then the saved ones`);
			await post({ command: 'compareTargetDatabases', connection: null, databases: ['SalesCopy', 'Staging'] });
			check((await p.$$eval('#compareApplyDatabase option', os => os.map(o => o.value))).join() === ',SalesCopy,Staging', `${theme}: the databases of this connection`);

			await clear();
			await p.selectOption('#compareApplyDatabase', 'Staging');
			const status = (await sent()).find(m => m.command === 'getCompareTargetStatus');
			check(status && status.database === 'Staging' && status.connection === null && status.ids.length === 4 && status.allowDestructive === false, `${theme}: picking a database asks where it stands (${JSON.stringify(status && { c: status.connection, d: status.database })})`);
			await post({ command: 'compareTargetStatus', connection: null, database: 'Staging', serverVersion: '15.0.4000', createOrAlter: true, counts: { done: 1, pending: 2, differs: 1 }, differs: ['table:dbo.Customers'], steps: 7, skipped: 2, skippedReason: 'It loses data, and destructive changes were not asked for.', warnings: ['dbo.Customers.tier: NOT NULL without a default fails when the table has rows.'] });
			const text = await p.textContent('#compareApplyStatus');
			check(text.includes('2 to do · 1 already as in the current database · 1 partly done') && text.includes('table:dbo.Customers') && text.includes('7 step(s) for SQL Server 15.0.4000') && text.includes('2 step(s) left out') && text.includes('NOT NULL without a default'), `${theme}: where the target stands, in words (${text.slice(0, 80)}…)`);
			check(!(await p.isDisabled('#compareApplyRunBtn')), `${theme}: Apply is available`);

			// Another connection: its databases replace the list, an answer for the previous one is ignored.
			await clear();
			await p.selectOption('#compareApplyConnection', 'Prod');
			check((await sent()).some(m => m.command === 'getCompareTargetDatabases' && m.connection === 'Prod'), `${theme}: another connection asks for its databases`);
			check(await p.isDisabled('#compareApplyRunBtn'), `${theme}: and Apply waits again`);
			await post({ command: 'compareTargetDatabases', connection: null, databases: ['Stale'] });
			await post({ command: 'compareTargetDatabases', connection: 'Prod', databases: ['Live'] });
			check((await p.$$eval('#compareApplyDatabase option', os => os.map(o => o.value))).join() === ',Live', `${theme}: the answer of another connection is ignored`);
			await p.selectOption('#compareApplyDatabase', 'Live');
			await post({ command: 'compareTargetStatus', connection: 'Staging', database: 'Live', counts: { done: 0, pending: 0, differs: 0 }, differs: [], steps: 1, skipped: 0, warnings: [], serverVersion: '16' });
			check(await p.isDisabled('#compareApplyRunBtn'), `${theme}: a status for something else is ignored`);
			await post({ command: 'compareTargetStatus', connection: 'Prod', database: 'Live', serverVersion: '12.0.6024', createOrAlter: false, counts: { done: 0, pending: 4, differs: 0 }, differs: [], steps: 5, skipped: 0, skippedReason: '', warnings: [] });
			check((await p.textContent('#compareApplyStatus')).includes('before 2016 SP1'), `${theme}: an old server is told it gets no CREATE OR ALTER`);

			// Apply: declined, then confirmed.
			await clear();
			await p.click('#compareApplyRunBtn');
			const apply = (await sent()).find(m => m.command === 'applyCompare');
			check(apply && apply.connection === 'Prod' && apply.database === 'Live' && apply.ids.length === 4, `${theme}: Apply sends the target and the changes`);
			check(await p.isDisabled('#compareApplyDatabase') && await p.isVisible('#compareApplyProgress') && await p.isVisible('#compareApplyStopBtn'), `${theme}: the dialog is locked while it waits`);
			await p.keyboard.press('Escape');
			check(await p.isVisible('#compareApplyOverlay'), `${theme}: it cannot be closed while applying`);
			await post({ command: 'compareApplyDeclined' });
			check(!(await p.isDisabled('#compareApplyDatabase')) && !(await p.isVisible('#compareApplyProgress')), `${theme}: declined, the dialog is free again`);

			await p.click('#compareApplyRunBtn');
			await post({ command: 'compareApplyProgress', done: 3, total: 12 });
			check((await p.textContent('#compareApplyProgressText')) === '3 of 12 batches' && await p.$eval('#compareApplyBar', e => e.max === 12 && e.value === 3), `${theme}: the progress follows`);
			await clear();
			await p.click('#compareApplyStopBtn');
			check((await sent()).some(m => m.command === 'cancelApplyCompare'), `${theme}: Stop is sent`);

			await post({ command: 'compareApplied', connection: 'Prod', database: 'Live', steps: 5, ran: 6, batches: 12, errors: [{ batch: 6, line: 40, message: 'ALTER TABLE only allows columns to be added that can contain nulls' }], stopped: false, durationMs: 2300, remaining: ['table:dbo.Customers'], remainingCount: 1, leftOut: 0 });
			const failed = await p.textContent('#compareApplyResult');
			check(failed.includes('stopped on an error (6 of 12 batches ran)') && failed.includes('Batch 6, line 40') && !failed.includes('Still different'), `${theme}: an error is shown with its batch and line (${failed.slice(0, 60)}…)`);
			check(!(await p.isDisabled('#compareApplyDatabase')) && await p.isDisabled('#compareApplyRunBtn'), `${theme}: and the dialog is free; Apply waits for a new look at the target`);

			await post({ command: 'compareApplied', connection: 'Prod', database: 'Live', steps: 5, ran: 12, batches: 12, errors: [], stopped: false, durationMs: 2300, remaining: [], remainingCount: 0, leftOut: 0 });
			check((await p.textContent('#compareApplyResult')).includes('Applied 5 step(s) in 2.3 s.') && (await p.textContent('#compareApplyResult')).includes('now is as the current one'), `${theme}: a clean run says so, and that the target now matches`);
			await post({ command: 'compareApplied', connection: 'Prod', database: 'Live', steps: 5, ran: 12, batches: 12, errors: [], stopped: false, durationMs: 1000, remaining: ['table:dbo.Log'], remainingCount: 1, leftOut: 2 });
			check((await p.textContent('#compareApplyResult')).includes('Still different on the database: table:dbo.Log') && (await p.textContent('#compareApplyResult')).includes('left out'), `${theme}: what still differs is listed`);
			await post({ command: 'compareApplied', connection: 'Prod', database: 'Live', steps: 5, ran: 4, batches: 12, errors: [], stopped: true, durationMs: 1000, remaining: [], remainingCount: 3, leftOut: 0 });
			check((await p.textContent('#compareApplyResult')).includes('Stopped after 4 of 12 batches'), `${theme}: a stopped run says where`);

			await post({ command: 'compareFailed', message: 'Could not connect to Prod: login failed' });
			check((await p.textContent('#compareApplyStatus')).includes('login failed'), `${theme}: a failure is shown in the dialog`);
			await p.keyboard.press('Escape');
			check(!(await p.isVisible('#compareApplyOverlay')), `${theme}: Escape closes it`);
			check(p.errors.length === 0, `${theme}: no page error: ` + p.errors.join(' | '));
			await p.close();
		}
		check.done();
	});
	test('modified since: the objects touched lately, newest first, with their code, no snapshot needed', async () => {
		const check = checker();
		for (const theme of ['dark', 'light']) {
			const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', theme, { width: 1100, height: 720 });
			const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(100); };
			const sent = () => p.evaluate(() => window.__sent.slice());
			const clear = () => p.evaluate(() => { window.__sent.length = 0; });
			await post({ command: 'connectionStatus', success: true, message: 'ok' });
			await post({ command: 'databasesLoaded', databases: ['Sales'], currentDatabase: 'Sales' });
			await p.click('[data-tab=compare]');
			check(await p.isVisible('#compareRefView') && !(await p.isVisible('#compareRecentView')), `${theme}: the tab opens on the comparison with a reference`);

			await clear();
			await p.click('#compareModeRecent');
			check(await p.isVisible('#compareRecentView') && !(await p.isVisible('#compareRefView')), `${theme}: the other view shows`);
			const asked = (await sent()).find(m => m.command === 'getRecentChanges');
			check(asked && asked.database === 'Sales' && asked.minutes === 180, `${theme}: it reads the last 3 hours straight away (${JSON.stringify(asked)})`);
			check((await p.textContent('#recentEmpty')).includes('does not see what was dropped'), `${theme}: and says what it cannot see`);

			const items = [
				{ kind: 'procedure', schema: 'dbo', name: 'usp_Load', status: 'altered', created: '2026-11-01 09:00:00', modified: '2026-11-03 10:55:00', createdAge: 180000, modifiedAge: 300, createdInPeriod: false, parent: null },
				{ kind: 'table', schema: 'Sales', name: 'Order', status: 'altered', created: '2026-11-03 09:00:00', modified: '2026-11-03 10:10:00', createdAge: 7200, modifiedAge: 2700, createdInPeriod: true, parent: null },
				{ kind: 'constraint', schema: 'Sales', name: 'CK_Order_total', status: 'new', created: '2026-11-03 10:10:00', modified: '2026-11-03 10:10:00', createdAge: 2700, modifiedAge: 2700, createdInPeriod: true, parent: 'Sales.Order' },
				{ kind: 'view', schema: 'dbo', name: 'vNew', status: 'new', created: '2026-11-03 09:30:00', modified: '2026-11-03 09:30:00', createdAge: 5400, modifiedAge: 5400, createdInPeriod: true, parent: null }
			];
			await post({ command: 'recentChanges', database: 'Sales', minutes: 180, serverTime: '2026-11-03 11:00:00', items, truncated: false });
			const rows = await p.$$eval('.recent-row', els => els.map(e => e.querySelector('.compare-name').textContent.replace(/\s+/g, ' ')));
			check(rows.join('|') === 'dbo.usp_Load|Sales.Order|CK_Order_total · Sales.Order|dbo.vNew', `${theme}: the objects, newest first (${rows.join('|')})`);
			check((await p.$$eval('.recent-badge', els => els.map(e => e.textContent))).join() === 'altered,altered,new,new', `${theme}: new or altered`);
			check((await p.$$eval('.recent-age', els => els.map(e => e.textContent))).join() === '5 min ago,45 min ago,45 min ago,1 h ago', `${theme}: with how long ago`);
			check((await p.textContent('#recentSummary')).includes('4 object(s) in the last 3 hours') && (await p.textContent('#recentSummary')).includes('1 table · 1 view · 1 procedure · 1 constraint'), `${theme}: the summary`);
			check((await p.textContent('#recentNote')).includes('Server time 2026-11-03 11:00:00'), `${theme}: the server time is shown`);

			// The first is a procedure: its code is asked for, and shown.
			check((await sent()).some(m => m.command === 'getRecentDefinition' && m.schema === 'dbo' && m.name === 'usp_Load'), `${theme}: the code of the selected procedure is asked for`);
			check((await p.textContent('#recentDetail')).includes('Loading the code'), `${theme}: and said to be loading`);
			await post({ command: 'recentDefinition', database: 'Sales', schema: 'dbo', name: 'usp_Load', definition: 'CREATE PROC dbo.usp_Load AS\n    SELECT 1' });
			const code = await p.$$eval('.compare-line-text', els => els.map(e => e.textContent));
			check(code.join('|') === 'CREATE PROC dbo.usp_Load AS|    SELECT 1', `${theme}: the code is shown (${code.join('|')})`);
			check((await p.textContent('#recentDetail')).includes('Created') && (await p.textContent('#recentDetail')).includes('2026-11-03 10:55:00'), `${theme}: with its dates`);

			// A table that was created and altered in the period, and a constraint.
			await clear();
			await p.click('.recent-row[data-key="table:Sales.Order"]');
			check((await p.textContent('#recentDetail')).includes('Created and altered in this period'), `${theme}: a table created and altered in the period says so`);
			check(!(await sent()).some(m => m.command === 'getRecentDefinition'), `${theme}: no code is asked for a table`);
			await p.click('.recent-row[data-key="constraint:Sales.CK_Order_total"]');
			check((await p.textContent('#recentDetail')).includes('Sales.Order') && (await p.textContent('.recent-reveal')).includes('its table'), `${theme}: a constraint points to its table`);
			await clear();
			await p.click('.recent-reveal');
			check((await sent()).some(m => m.command === 'getObjectDetailsAuto' && m.objectName === 'Sales.Order'), `${theme}: and opens it in the Explorer`);
			await p.click('[data-tab=compare]');

			// Filter, period, refresh.
			await p.fill('#recentFilter', 'new');
			check((await p.$$eval('.recent-row', els => els.length)) === 2, `${theme}: the filter keeps what is new`);
			await p.fill('#recentFilter', '');
			await clear();
			await p.selectOption('#recentPeriod', '1440');
			check((await sent()).some(m => m.command === 'getRecentChanges' && m.minutes === 1440), `${theme}: another period reads again`);
			await clear();
			await p.click('#recentRefreshBtn');
			check((await sent()).some(m => m.command === 'getRecentChanges'), `${theme}: Refresh reads again`);

			await post({ command: 'recentChanges', database: 'Sales', minutes: 15, serverTime: 'x', items: [], truncated: false });
			check((await p.textContent('#recentEmpty')).includes('Nothing was created or altered in this period') && !(await p.isVisible('#recentResult')), `${theme}: an empty period says so`);
			await post({ command: 'recentFailed', message: 'The period is not valid.' });
			check((await p.getAttribute('#recentNote', 'class')).includes('error'), `${theme}: a failure is shown`);

			// The snapshots of the database are periods too: since the moment one was taken.
			const SNAPSHOT = 'Sales_ref_20261103_090507';
			await post({ command: 'compareSources', database: 'Sales', snapshots: [{ name: SNAPSHOT, source: 'Sales', createDate: '2026-11-03T09:05:07Z', state: 'ONLINE' }], databases: [], support: { supported: true } });
			check((await p.$$eval('#recentPeriod optgroup option', os => os.map(o => o.value))).join() === `snapshot:${SNAPSHOT}`, `${theme}: the snapshot is offered as a period`);
			await clear();
			await p.selectOption('#recentPeriod', `snapshot:${SNAPSHOT}`);
			const sinceAsked = (await sent()).find(m => m.command === 'getRecentChanges');
			check(sinceAsked && sinceAsked.snapshot === SNAPSHOT && sinceAsked.minutes === undefined, `${theme}: choosing it reads what came after it (${JSON.stringify(sinceAsked)})`);
			await post({ command: 'recentChanges', database: 'Sales', minutes: null, snapshot: SNAPSHOT, since: '2026-11-03 09:05:07', serverTime: '2026-11-03 11:00:00', items: [items[0]], truncated: false });
			check((await p.textContent('#recentSummary')).includes(`1 object(s) since the snapshot ${SNAPSHOT} (taken 2026-11-03 09:05:07)`), `${theme}: the summary says since when`);

			// The snapshot is dropped: it is no longer a period, and the view goes back to the last hours.
			await clear();
			await post({ command: 'compareSources', database: 'Sales', snapshots: [], databases: [], support: { supported: true } });
			check((await p.$$eval('#recentPeriod optgroup', os => os.length)) === 0, `${theme}: no snapshot, no group`);
			check((await p.inputValue('#recentPeriod')) === '180', `${theme}: back to 3 hours`);
			check((await sent()).some(m => m.command === 'getRecentChanges' && m.minutes === 180 && !m.snapshot), `${theme}: and it reads them again`);

			// Back to the comparison: nothing of it was lost.
			await p.click('#compareModeRef');
			check(await p.isVisible('#compareRefView') && !(await p.isVisible('#compareRecentView')), `${theme}: back to the comparison`);
			check(p.errors.length === 0, `${theme}: no page error: ` + p.errors.join(' | '));
			await p.close();
		}
		check.done();
	});

	test('a snapshot that was just taken is the reference, and its name stays in the field', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 600 });
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(100); };
		await post({ command: 'connectionStatus', success: true, message: 'ok' });
		await post({ command: 'databasesLoaded', databases: ['Sales'], currentDatabase: 'Sales' });
		await p.click('[data-tab=compare]');
		const OLD = { name: 'Sales_ref_20261101_080000', source: 'Sales', createDate: '2026-11-01T08:00:00Z', state: 'ONLINE' };
		const NEW = { name: 'Sales_ref_20261103_090507', source: 'Sales', createDate: '2026-11-03T09:05:07Z', state: 'ONLINE' };
		await post({ command: 'compareSources', database: 'Sales', snapshots: [OLD], databases: ['SalesCopy'], support: { supported: true } });
		await p.selectOption('#compareReference', 'SalesCopy');

		// The extension answers a snapshot: the note, then the list with the new one.
		await post({ command: 'compareSnapshotDone', name: NEW.name, action: 'taken' });
		await post({ command: 'compareSources', database: 'Sales', snapshots: [NEW, OLD], databases: ['SalesCopy'], support: { supported: true } });
		check((await p.inputValue('#compareReference')) === NEW.name, 'the new snapshot is the reference (' + (await p.inputValue('#compareReference')) + ')');
		check((await p.getAttribute('#compareReference', 'title')).startsWith(NEW.name), 'the field names it in full when it is hovered');

		// A snapshot dropped is not picked again by the next list.
		await post({ command: 'compareSnapshotDone', name: OLD.name, action: 'dropped' });
		await post({ command: 'compareSources', database: 'Sales', snapshots: [NEW], databases: ['SalesCopy'], support: { supported: true } });
		check((await p.inputValue('#compareReference')) === NEW.name, 'the reference is still the one that is there');

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		await p.close();
		check.done();
	});
});
