/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Renders the real webview pages (webview/index.html, sidebar.html) in
// headless Chromium, with a stub for acquireVsCodeApi(): what the page posts is
// recorded, and what the extension would send is posted back by the test.
// Needs the `playwright` dev dependency and `npm run build` (the editor
// bundle in dist/webview/); the e2e suites skip themselves without Playwright.
const fs = require('fs');
const os = require('os');
const path = require('path');
const themes = require('./themes');

const root = path.join(__dirname, '..', '..');

function loadPlaywright() {
	try { return require('playwright'); } catch { return null; }
}

// Placeholder -> file, learned from the provider that fills it in the
// extension itself (html.replace('{{X}}', u('webview', 'x.js'))): the page is
// then built exactly like the extension builds it, and a placeholder the
// provider forgot is an error here too.
function placeholderFiles(providerFile) {
	const source = fs.readFileSync(path.join(root, providerFile), 'utf8');
	const files = {};
	const re = /replace\('\{\{(\w+)\}\}',\s*u\(([^)]*)\)\)/g;
	let match;
	while ((match = re.exec(source))) {
		files[match[1]] = match[2].split(',').map(part => part.trim().replace(/^'|'$/g, ''));
	}
	return files;
}

// The VS Code webview defaults (body colours, font) the real host injects.
const WEBVIEW_DEFAULTS = `html{background:var(--vscode-editor-background);scrollbar-color:var(--vscode-scrollbarSlider-background) var(--vscode-editor-background)}
body{background-color:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);margin:0;padding:0 20px}`;

let tmpDir;
function buildPage(htmlName, providerFile, theme) {
	const files = placeholderFiles(providerFile);
	let html = fs.readFileSync(path.join(root, 'webview', htmlName), 'utf8');
	html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace(/\{\{CSP_SOURCE\}\}/g, '');
	html = html.replace('{{BUILD_TIME}}', 'test').replace('{{ICON_SPRITE}}', fs.readFileSync(path.join(root, 'webview', 'icons.svg'), 'utf8'));
	for (const [name, parts] of Object.entries(files)) {
		html = html.replace(`{{${name}}}`, 'file://' + path.join(root, ...parts));
	}
	const left = html.match(/\{\{\w+\}\}/g);
	if (left) throw new Error(`${htmlName}: placeholders nobody fills in: ${[...new Set(left)].join(', ')}`);
	html = html.replace('</head>', `<style>:root{${themes[theme]}}\n${WEBVIEW_DEFAULTS}</style></head>`)
		.replace('<body>', `<body class="vscode-${theme}">`);
	if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlwayfarer-e2e-'));
	const out = path.join(tmpDir, `${theme}-${htmlName}`);
	fs.writeFileSync(out, html);
	return 'file://' + out;
}

// A file in the temporary directory of the run. The screenshots of a test
// have to land somewhere that exists on every machine - the path they were
// written to before was the one of the machine that wrote them.
function tmpPath(name) {
	if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlwayfarer-e2e-'));
	return path.join(tmpDir, name);
}

// A page with the stubbed API; errors of the page are collected in page.errors.
async function openPage(browser, htmlName, providerFile, theme, viewport = { width: 1100, height: 760 }) {
	const page = await browser.newPage({ viewport });
	page.errors = [];
	page.on('pageerror', e => page.errors.push(e.message));
	page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
	await page.addInitScript(() => {
		window.__sent = [];
		window.__state = null;
		window.acquireVsCodeApi = () => ({
			postMessage: m => window.__sent.push(m),
			getState: () => window.__state,
			setState: s => { window.__state = s; }
		});
	});
	await page.goto(buildPage(htmlName, providerFile, theme));
	return page;
}

const post = async (page, message, wait = 80) => {
	await page.evaluate(m => window.postMessage(m, '*'), message);
	await page.waitForTimeout(wait);
};
const sent = page => page.evaluate(() => window.__sent);
const clearSent = page => page.evaluate(() => { window.__sent.length = 0; });
const commands = async page => (await sent(page)).map(m => m.command);

// A named check that does not stop the test: every failure is reported at the end.
function checker() {
	const failures = [];
	const check = (condition, label) => { if (!condition) failures.push(label); };
	check.failures = failures;
	check.done = () => {
		if (failures.length) throw new Error(`${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
	};
	return check;
}

module.exports = { themes, loadPlaywright, buildPage, openPage, post, sent, clearSent, commands, checker, root, placeholderFiles, tmpPath };
