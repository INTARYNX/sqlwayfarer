const { loadPlaywright, openPage, checker } = require('./harness');

const playwright = loadPlaywright();

suite('e2e: the editor takes two thirds of the Query tab', function () {
	this.timeout(120000);
	let browser;
	suiteSetup(async function () {
		if (!playwright) this.skip();
		browser = await playwright.chromium.launch();
	});
	suiteTeardown(async () => { if (browser) await browser.close(); });

	test('by default, at every window height; the splitter still resizes, double-click resets', async () => {
		const check = checker();
		for (const height of [500, 700, 900, 1200]) {
			const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height });
			const post = async m => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(100); };
			await post({ command: 'connectionStatus', success: true, message: 'ok' });
			await post({ command: 'databasesLoaded', databases: ['master'], currentDatabase: 'master' });
			const sizes = () => p.evaluate(() => {
				const editor = document.querySelector('.query-input-wrap').getBoundingClientRect().height;
				const results = document.querySelector('.query-results-wrap').getBoundingClientRect().height;
				return { editor, results, ratio: editor / (editor + results) };
			});
			let size = await sizes();
			check(Math.abs(size.ratio - 2 / 3) < 0.02, `${height}px: the editor is ${(size.ratio * 100).toFixed(1)}% of the area`);
			check(size.results >= 100, `${height}px: the results keep their room (${Math.round(size.results)}px)`);

			const box = await p.locator('#querySplitter').boundingBox();
			await p.mouse.move(box.x + box.width / 2, box.y + 3);
			await p.mouse.down();
			await p.mouse.move(box.x + box.width / 2, box.y - 60, { steps: 4 });
			await p.mouse.up();
			const dragged = await sizes();
			check(dragged.editor < size.editor - 40, `${height}px: dragging the splitter resizes`);
			await p.dblclick('#querySplitter');
			const reset = await sizes();
			check(Math.abs(reset.ratio - 2 / 3) < 0.02, `${height}px: double-click goes back to two thirds`);
			check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
			await p.close();
		}
		check.done();
	});
});
