const { loadPlaywright, openPage, checker } = require('./harness');

const playwright = loadPlaywright();

suite('e2e: the open transaction bar', function () {
	this.timeout(120000);
	let browser;
	suiteSetup(async function () {
		if (!playwright) this.skip();
		browser = await playwright.chromium.launch();
	});
	suiteTeardown(async () => { if (browser) await browser.close(); });

	test('hidden by default, shown while a transaction is open, Commit and Roll back are sent', async () => {
		const check = checker();
		for (const theme of ['dark', 'light']) {
			const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', theme, { width: 900, height: 600 });
			const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(100); };
			const visible = () => p.evaluate(() => { const e = document.getElementById('queryTransaction'); return !e.hidden && e.getBoundingClientRect().width > 0; });
			await post({ command: 'connectionStatus', success: true, message: 'ok' });
			await post({ command: 'databasesLoaded', databases: ['master'], currentDatabase: 'master' });

			check(!(await visible()), `${theme}: nothing is shown without a transaction`);
			await post({ command: 'queryResult', durationMs: 5, timeline: [], resultSets: [] });
			await post({ command: 'transactionState', count: 1 });
			check(await visible(), `${theme}: the bar shows while a transaction is open`);
			check((await p.textContent('#queryTransactionText')) === 'Transaction open', `${theme}: one level reads "Transaction open"`);
			await post({ command: 'transactionState', count: 2 });
			check((await p.textContent('#queryTransactionText')) === 'Transaction open (2 levels)', `${theme}: nested levels are counted`);

			// The status text keeps its room, the bar is not cut by the footer.
			const fits = await p.evaluate(() => {
				const footer = document.querySelector('.query-result-footer').getBoundingClientRect();
				const bar = document.getElementById('queryTransaction').getBoundingClientRect();
				return bar.right <= footer.right + 1 && bar.left >= footer.left;
			});
			check(fits, `${theme}: the bar fits in the footer`);

			await p.evaluate(() => { window.__sent.length = 0; });
			await p.click('#queryCommitBtn');
			await p.click('#queryRollbackBtn');
			const sent = (await p.evaluate(() => window.__sent)).filter(m => m.command === 'endTransaction').map(m => m.action);
			check(sent.join() === 'commit,rollback', `${theme}: Commit and Roll back are sent (${sent})`);

			await post({ command: 'transactionState', count: 0 });
			check(!(await visible()), `${theme}: the bar goes away once it is ended`);
			check(p.errors.length === 0, `${theme}: no page error: ` + p.errors.join(' | '));
			await p.close();
		}
		check.done();
	});
});
