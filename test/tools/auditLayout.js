'use strict';

// Looks for layout faults on real data (the AdventureWorks fixtures of
// test/e2e/fixtures): for each view, theme and window width it reports what
// widens the page, what lies outside the window, and text that is cut with no
// ellipsis or spills out of its box. Screenshots of the 1100 px width go to
// the folder given as the argument (the temporary folder by default). Not a
// test: it lists what to look at. Run it with: npm run e2e:audit
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('../e2e/harness.js');
const { chromium } = require('playwright');
const AW = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'e2e', 'fixtures', 'adventureworks.json'), 'utf8'));
const EX = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'e2e', 'fixtures', 'explorer.json'), 'utf8'));
const out = process.argv[2] || os.tmpdir();

const DETECT = () => {
	const vw = window.innerWidth, issues = [];
	const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
	const path = el => { const parts = []; for (let e = el; e && e !== document.body && parts.length < 3; e = e.parentElement) parts.unshift(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '')); return parts.join(' > '); };
	if (document.documentElement.scrollWidth > vw + 1) issues.push(`PAGE scrolls sideways: ${document.documentElement.scrollWidth} > ${vw}`);
	const insideScroller = el => { for (let e = el.parentElement; e; e = e.parentElement) { const s = getComputedStyle(e); if (/(auto|scroll|hidden)/.test(s.overflowX) && e.scrollWidth > e.clientWidth) return true; } return false; };
	for (const el of document.querySelectorAll('body *')) {
		if (!visible(el) || /^(SCRIPT|STYLE|SVG|PATH|META|LINK|USE)$/i.test(el.tagName) || el.closest('svg')) continue;
		const r = el.getBoundingClientRect(), s = getComputedStyle(el);
		if ((r.right > vw + 2 || r.left < -2) && !insideScroller(el) && s.position !== 'fixed') issues.push(`OUT OF VIEW x ${Math.round(r.left)}..${Math.round(r.right)} (vw ${vw}): ${path(el)}`);
		if (el.children.length === 0 && el.textContent.trim() && el.scrollWidth > el.clientWidth + 2) {
			if (/(hidden|clip)/.test(s.overflowX) && s.textOverflow !== 'ellipsis') issues.push(`CLIPPED without ellipsis (${el.scrollWidth}>${el.clientWidth}): ${path(el)} "${el.textContent.trim().slice(0, 40)}"`);
			else if (s.overflowX === 'visible' && s.whiteSpace === 'nowrap') issues.push(`TEXT SPILLS (${el.scrollWidth}>${el.clientWidth}): ${path(el)} "${el.textContent.trim().slice(0, 40)}"`);
		}
	}
	return [...new Set(issues)].slice(0, 12);
};

(async () => {
	const b = await chromium.launch();
	const all = {};
	for (const theme of ['dark', 'light']) for (const [w, hgt] of [[760, 600], [900, 700], [1000, 700], [1100, 760], [1280, 800], [1600, 900]]) {
		const p = await h.openPage(b, 'index.html', 'panels/SqlWayfarerPanel.js', theme, { width: w, height: hgt });
		const post = async (m, ms = 150) => { await p.evaluate(x => window.postMessage(x, '*'), m); await p.waitForTimeout(ms); };
		const tag = `${theme}-${w}`;
		const check = async (state, shot) => {
			const issues = await p.evaluate(DETECT);
			if (issues.length) { all[`${tag} / ${state}`] = issues; }
			if (shot) await p.screenshot({ path: `${out}/${tag}-${state.replace(/\W+/g, '_')}.png` });
		};
		await post({ command: 'connectionStatus', success: true, message: 'ok' });
		await post({ command: 'databasesLoaded', databases: ['AdventureWorks', 'master'], currentDatabase: 'AdventureWorks' });
		await check('query-empty', w === 1100);
		await post({ command: 'queryResult', durationMs: 120, timeline: [], resultSets: [AW.products] }, 300);
		await check('query-products', w === 1100);
		await post({ command: 'queryResult', durationMs: 120, timeline: [], resultSets: [AW.people, AW.products] }, 300);
		await check('query-two-sets', w === 1100);
		const long = 'Msg 8152, Level 16, State 30, Line 1: String or binary data would be truncated in table AdventureWorks.Production.ProductDescription, column Description. Truncated value: ' + 'x'.repeat(300);
		await post({ command: 'queryError', message: long, durationMs: 5 });
		await check('query-long-error', w === 1100);
		await post({ command: 'queryResult', durationMs: 5, timeline: [{ type: 'message', text: long.replace(/ /g, '_') }, { type: 'resultSet', index: 0 }, { type: 'message', text: '(300 rows affected)' }], resultSets: [AW.people] }, 300);
		await check('query-long-message', w === 1100);
		await post({ command: 'queryResult', durationMs: 5, timeline: [0, 1, 2, 3, 4, 5, 6, 7].map(index => ({ type: 'resultSet', index })), resultSets: [0, 1, 2, 3, 4, 5, 6, 7].map(i => i % 2 ? AW.people : AW.products) }, 400);
		await check('query-eight-sets', w === 1100);
		await p.click('.tab-button[data-tab=explorer]');
		const objects = EX.find(m => m.command === 'objectsLoaded');
		await post(objects, 400);
		await check('explorer-list', w === 1100);
		for (const t of EX.filter(m => m.command === 'tableDetailsLoaded')) {
			await p.evaluate(n => { appState.selectedObject = appState.allObjects.find(o => o.qualified_name === n) || appState.selectedObject; }, t.tableName);
			await post(t, 300);
			await check('table-' + t.tableName, w === 1100);
		}
		for (const o of EX.filter(m => m.command === 'objectDetailsLoaded')) {
			await p.evaluate(n => { appState.selectedObject = appState.allObjects.find(x => x.qualified_name === n) || appState.selectedObject; }, o.objectName);
			await post(o, 300);
			await check('object-' + o.objectName, w === 1100);
			for (const tab of ['code', 'tree']) {
				await p.click(`.details-tab-button[data-details-tab=${tab}]`);
				await post({ ...EX.find(m => m.command === 'dependencyTreeResult'), objectName: o.objectName, dependencyTree: { name: o.objectName, external: null, dependencies: [...o.dependencies.dependsOn, ...o.dependencies.referencedBy].map(d => ({ name: d.dependency || d.name || JSON.stringify(d), external: null, dependencies: [] })) } }, 300);
				await check(`object-${o.objectName}-${tab}`, w === 1100);
			}
			await p.click('.details-tab-button[data-details-tab=structure]');
		}
		// Comments (AdventureWorks describes every column), Graph, footprint and query graph.
		await p.evaluate(() => { appState.selectedObject = appState.allObjects.find(o => o.qualified_name === 'Production.Product') || appState.selectedObject; });
		await post(EX.filter(m => m.command === 'tableDetailsLoaded')[2], 300);
		await p.click('.details-tab-button[data-details-tab=comments]');
		for (const m of EX.filter(x => x.command === 'tableExtendedPropertiesResult')) await post(m, 300);
		await check('comments-table', w === 1100);
		await p.click('.details-tab-button[data-details-tab=graph]');
		const viewDetails = EX.filter(m => m.command === 'objectDetailsLoaded')[1];
		await p.evaluate(n => { appState.selectedObject = appState.allObjects.find(o => o.qualified_name === n) || appState.selectedObject; }, viewDetails.objectName);
		await post(viewDetails, 1500);
		await check('graph-view', w === 1100);
		for (const [name, i] of [['footprint-proc', 0], ['footprint-table', 1]]) {
			await p.evaluate(n => window.footprintManager.open(n), 'X');
			await post(EX.filter(m => m.command === 'writeFootprintResult')[i], 800);
			await check(name, w === 1100);
			for (const tab of ['schema', 'tables']) {
				await p.evaluate(t => window.footprintManager.switchTab(t), tab);
				await post({ command: 'footprintDocResult', success: true, doc: null }, 200);
				await check(`${name}-${tab}`, false);
			}
			await p.evaluate(() => window.footprintManager.close());
		}
		await p.evaluate(() => window.footprintManager.openQueryGraph('select 1'));
		await post(EX.find(m => m.command === 'queryGraphResult'), 800);
		await check('query-graph', w === 1100);
		await p.close();
	}
	await b.close();
	for (const [k, v] of Object.entries(all)) { console.log('\n## ' + k); v.slice(0, 3).forEach(i => console.log('  - ' + i)); }
	console.log('\nstates with issues:', Object.keys(all).length);
})();
