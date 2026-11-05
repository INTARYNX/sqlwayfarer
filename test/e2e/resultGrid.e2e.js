const fs = require('fs');
const path = require('path');
const { loadPlaywright, openPage, checker } = require('./harness');

// The result grid and the Top 10 shortcut, on real data: result sets captured
// from AdventureWorks (npm run e2e:fixtures), wide rows, long text, xml. The
// layout of a grid cannot be seen by a unit test; it is only wrong with data
// that is wider and taller than the pane.

const playwright = loadPlaywright();
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'adventureworks.json'), 'utf8'));

suite('e2e: the result grid and the Top 10 shortcut, on AdventureWorks data', function () {
	this.timeout(120000);
	let browser;
	suiteSetup(async function () {
		if (!playwright) this.skip();
		browser = await playwright.chromium.launch();
	});
	suiteTeardown(async () => { if (browser) await browser.close(); });

	async function openWithResult(theme, set) {
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', theme, { width: 1100, height: 760 });
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(150); };
		await post({ command: 'connectionStatus', success: true, message: 'ok' });
		await post({ command: 'databasesLoaded', databases: ['AdventureWorks'], currentDatabase: 'AdventureWorks' });
		await post({ command: 'queryResult', durationMs: 5, timeline: [], resultSets: [set] });
		return p;
	}

	for (const theme of ['dark', 'light']) {
		test(`${theme}: a grid wider than the pane scrolls inside it, it does not widen the page`, async () => {
			const check = checker();
			const p = await openWithResult(theme, DATA.products);
			const m = await p.evaluate(() => {
				const wrap = document.querySelector('.result-set-pane .result-set-table-wrap');
				const box = wrap.getBoundingClientRect();
				return {
					pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
					wrapRight: box.right, innerWidth: window.innerWidth,
					scrollsSideways: wrap.scrollWidth > wrap.clientWidth
				};
			});
			check(m.pageOverflow <= 0, `the page did not widen (${m.pageOverflow}px too wide)`);
			check(m.wrapRight <= m.innerWidth, `the grid ends inside the window (${m.wrapRight} > ${m.innerWidth})`);
			check(m.scrollsSideways, 'the 26 columns scroll sideways inside the grid');
			check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
			await p.close();
			check.done();
		});

		test(`${theme}: only the table scrolls, the actions bar and the header stay put`, async () => {
			const check = checker();
			const p = await openWithResult(theme, DATA.people);
			const top = () => p.evaluate(() => {
				const wrap = document.querySelector('.result-set-pane .result-set-table-wrap');
				return {
					actions: document.querySelector('.result-set-pane .result-set-actions').getBoundingClientRect().top,
					header: wrap.querySelector('thead th').getBoundingClientRect().top,
					wrap: wrap.getBoundingClientRect().top,
					scrollTop: wrap.scrollTop,
					pageScroll: document.documentElement.scrollTop
				};
			});
			const before = await top();
			await p.evaluate(() => { document.querySelector('.result-set-pane .result-set-table-wrap').scrollTop = 2000; });
			await p.waitForTimeout(100);
			const after = await top();
			check(after.scrollTop > 0, 'the grid itself scrolled (300 rows)');
			check(after.actions === before.actions, `the actions bar did not move (${before.actions} -> ${after.actions})`);
			check(Math.abs(after.header - after.wrap) < 2, `the header sticks to the top of the grid (${after.header} vs ${after.wrap})`);
			check(after.pageScroll === 0, 'the page did not scroll');
			await p.close();
			check.done();
		});
	}

	test('a cell stays on one line, a long value is cut with an ellipsis at 600 px', async () => {
		const check = checker();
		const p = await openWithResult('dark', DATA.products);
		const m = await p.evaluate(() => {
			const cells = [...document.querySelectorAll('.result-set-pane tbody td')];
			const style = getComputedStyle(cells[0]);
			const heights = new Set([...document.querySelectorAll('.result-set-pane tbody tr')].map(tr => tr.offsetHeight));
			return {
				whiteSpace: style.whiteSpace, overflow: style.overflow, ellipsis: style.textOverflow,
				heights: [...heights],
				widest: Math.max(...cells.map(td => td.offsetWidth)),
				cut: cells.filter(td => td.scrollWidth > td.clientWidth).length
			};
		});
		check(m.whiteSpace === 'nowrap' && m.ellipsis === 'ellipsis', `one line, cut with an ellipsis (${m.whiteSpace}, ${m.ellipsis})`);
		check(m.heights.length === 1, `every row has the same height (${m.heights.join(', ')})`);
		check(m.widest <= 640, `no cell wider than its cap (${m.widest}px)`);
		check(m.cut > 0, 'the long descriptions are cut');
		await p.close();
		check.done();
	});

	test('Top 10 keeps what the editor holds and runs in a new tab; an empty editor is reused', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1200, height: 800 });
		const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(80); };
		await post({ command: 'connectionStatus', success: true, message: 'ok' });
		await post({ command: 'databasesLoaded', databases: ['AdventureWorks'], currentDatabase: 'AdventureWorks' });
		const state = () => p.evaluate(() => ({
			tabs: window.queryFileManager.tabs.map(t => t.content),
			editor: window.queryManager.input.value,
			executed: window.__sent.filter(m => m.command === 'executeQuery').map(m => m.query)
		}));
		const top10 = 'SELECT TOP (10) * FROM [Production].[Product];';

		await p.evaluate(sql => window.queryManager.runQueryText(sql), top10);
		await p.waitForTimeout(150);
		let s = await state();
		check(s.tabs.length === 1 && s.editor === top10, `an empty editor is reused (${s.tabs.length} tab)`);
		check(s.executed.length === 1 && s.executed[0] === top10, 'and the query runs');

		// Text in the editor: it must survive.
		await p.evaluate(() => { window.queryManager.setRunning(false); window.queryManager.input.value = 'SELECT BusinessEntityID FROM Person.Person'; window.queryManager.input.dispatchEvent(new Event('input')); });
		await p.waitForTimeout(150);
		await p.evaluate(sql => window.queryManager.runQueryText(sql), 'SELECT TOP (10) * FROM [Person].[Person];');
		await p.waitForTimeout(200);
		s = await state();
		check(s.tabs.length === 2, `the query went to a new tab (${s.tabs.length} tabs)`);
		check(s.tabs.some(c => c === 'SELECT BusinessEntityID FROM Person.Person'), 'the text the user wrote is still there in its tab');
		check(s.editor === 'SELECT TOP (10) * FROM [Person].[Person];', 'the new tab holds the Top 10');
		check(s.executed[s.executed.length - 1] === 'SELECT TOP (10) * FROM [Person].[Person];', 'and that is what runs');
		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		await p.close();
		check.done();
	});
});
