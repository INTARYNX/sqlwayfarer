const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const list = dir => fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.js')).map(f => `${dir}/${f}`);

// The messages between the pages and the extension are plain strings on both
// sides: a typo, or a handler forgotten on one side, fails silently. These
// tests read the sources and check both directions.
const commandsPosted = (files, via) => {
	const out = new Map();
	for (const file of files) {
		for (const m of read(file).matchAll(new RegExp(`${via}\\(\\{\\s*command:\\s*'(\\w+)'`, 'g'))) {
			if (!out.has(m[1])) out.set(m[1], file);
		}
	}
	return out;
};
const casesOf = (file, from = 0, to = undefined) => {
	const source = read(file).slice(from, to);
	return new Set([...source.matchAll(/case '(\w+)'/g)].map(m => m[1]));
};

const panelWebviewFiles = list('webview').filter(f => !/sidebar|snippetManager/i.test(f));
const sidebarWebviewFiles = ['webview/sidebarConnections.js', 'webview/sidebarMain.js', 'webview/snippetManager.js'];

suite('messages from the panel page reach a handler', () => {
	const handled = casesOf('panels/SqlWayfarerPanel.js', read('panels/SqlWayfarerPanel.js').indexOf('async _handleMessage'));

	test('every command the panel page posts is handled by the panel', () => {
		const posted = commandsPosted(panelWebviewFiles, 'vscode\\.postMessage');
		assert.ok(posted.size > 40, 'the scan found the messages');
		const unhandled = [...posted].filter(([command]) => !handled.has(command)).map(([command, file]) => `${command} (${file})`);
		assert.deepStrictEqual(unhandled, []);
	});

	test('the autocompletion, index and parameter messages are among them', () => {
		for (const command of ['getAutocompleteSettings', 'getObjectParameters', 'getObjectColumns', 'getAutocompleteObjects', 'getIndexStatus', 'loadIndex', 'getIndex', 'forceReindex']) {
			assert.ok(handled.has(command), command);
		}
	});
});

suite('messages from the extension reach the page', () => {
	test('every command the panel and its handlers post is handled by the page', () => {
		// SavedConnectionHandlers and ConnectionImportHandlers talk to the sidebar (tested below).
		const files = ['panels/SqlWayfarerPanel.js', ...list('panels/handlers').filter(f => !/SavedConnectionHandlers|ConnectionImportHandlers/.test(f))];
		const posted = new Map();
		for (const file of files) {
			// post({ command: 'x' ... }) / this._post({ ... }) / webview.postMessage({ ... })
			for (const m of read(file).matchAll(/(?:post|_post|postMessage)\(\{\s*command:\s*'(\w+)'/g)) {
				if (!posted.has(m[1])) posted.set(m[1], file);
			}
		}
		const main = read('webview/main.js');
		const handled = casesOf('webview/main.js', main.indexOf('switch (message.command)'));
		// Handled by something other than main.js's switch.
		const elsewhere = new Set();
		for (const file of list('webview')) {
			for (const m of read(file).matchAll(/message\.command === '(\w+)'|command === '(\w+)'/g)) elsewhere.add(m[1] || m[2]);
		}
		const unhandled = [...posted].filter(([command]) => !handled.has(command) && !elsewhere.has(command) && !(command in ANSWERS_NOBODY_ASKS_FOR));
		assert.deepStrictEqual(unhandled.map(([command, file]) => `${command} (${file})`), []);
	});

	// Answers of handlers for requests the page does not send (any more): fine
	// as long as that stays true - the day a page asks for one, it needs a case.
	const ANSWERS_NOBODY_ASKS_FOR = {
		searchObjectsResult: 'searchObjects',
		tableRowCountResult: 'getTableRowCount',
		tableSampleDataResult: 'getTableSampleData',
		impactAnalysisResult: 'getImpactAnalysis',
		indexStatsResult: 'getIndexStats'
	};

	test('the allowed unanswered results really have no request in the page', () => {
		const posted = commandsPosted(panelWebviewFiles, 'vscode\\.postMessage');
		for (const [result, request] of Object.entries(ANSWERS_NOBODY_ASKS_FOR)) {
			assert.ok(!posted.has(request), `the page now sends ${request}: handle ${result}`);
		}
	});

	test('the allowed unanswered results really have no case in the page either', () => {
		// The list above is a list of answers that go nowhere. It is only
		// honest as long as the page indeed ignores them: the day one of them
		// is handled, it is not an "answer nobody asks for" any more.
		const main = read('webview/main.js');
		const handled = casesOf('webview/main.js', main.indexOf('switch (message.command)'));
		const elsewhere = new Set();
		for (const file of list('webview')) {
			for (const m of read(file).matchAll(/message\.command === '(\w+)'|command === '(\w+)'/g)) elsewhere.add(m[1] || m[2]);
		}
		for (const result of Object.keys(ANSWERS_NOBODY_ASKS_FOR)) {
			assert.ok(!handled.has(result) && !elsewhere.has(result), `the page now handles ${result}: it is not a reserved answer any more`);
		}
	});

	test('the new autocompletion and index answers are handled', () => {
		const handled = casesOf('webview/main.js');
		for (const command of ['autocompleteSettings', 'objectParametersLoaded', 'objectColumnsLoaded', 'autocompleteObjectsLoaded', 'indexStatus', 'indexResult', 'indexingStarted', 'indexingCompleted']) {
			assert.ok(handled.has(command), command);
		}
	});
});

suite('messages of the sidebar', () => {
	test('every command the sidebar posts is handled by its provider', () => {
		const handled = casesOf('panels/SnippetSidebarProvider.js');
		const posted = commandsPosted(sidebarWebviewFiles, 'vscode\\.postMessage');
		assert.ok(posted.size > 5);
		const unhandled = [...posted].filter(([command]) => !handled.has(command)).map(([command, file]) => `${command} (${file})`);
		assert.deepStrictEqual(unhandled, []);
	});

	test('every command the provider posts is handled by the sidebar page', () => {
		const posted = new Set([...read('panels/SnippetSidebarProvider.js').matchAll(/(?:post|postMessage)\(\{\s*command:\s*'(\w+)'/g)].map(m => m[1]));
		const handled = new Set();
		for (const file of sidebarWebviewFiles) for (const c of casesOf(file)) handled.add(c);
		const unhandled = [...posted].filter(c => !handled.has(c));
		assert.deepStrictEqual(unhandled, []);
	});
});

suite('every page placeholder is filled in by its provider', () => {
	const pages = [
		{ html: 'webview/index.html', provider: 'panels/SqlWayfarerPanel.js' },
		{ html: 'webview/sidebar.html', provider: 'panels/SnippetSidebarProvider.js' }
	];

	for (const { html, provider } of pages) {
		test(`${html}`, () => {
			const wanted = new Set(read(html).match(/\{\{\w+\}\}/g));
			const source = read(provider);
			const filled = new Set([...source.matchAll(/'\{\{(\w+)\}\}'/g), ...source.matchAll(/\/\\\{\\\{(\w+)\\\}\\\}\//g)].map(m => `{{${m[1]}}}`));
			const missing = [...wanted].filter(p => !filled.has(p));
			assert.deepStrictEqual(missing, []);
			const unused = [...filled].filter(p => !wanted.has(p));
			assert.deepStrictEqual(unused, [], 'placeholders replaced but not present in the page');
		});

		test(`${html}: every file it points at exists (the editor bundle is built by webpack)`, () => {
			const files = [...read(provider).matchAll(/replace\('\{\{\w+\}\}',\s*u\(([^)]*)\)\)/g)]
				.map(m => m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')));
			assert.ok(files.length > 3);
			for (const parts of files) {
				if (parts[0] === 'dist') continue;
				assert.ok(fs.existsSync(path.join(root, ...parts)), parts.join('/'));
			}
		});
	}

	test('the scripts of index.html load in an order where every class used at load time exists', () => {
		const html = read('webview/index.html');
		const order = [...html.matchAll(/<script src="\{\{(\w+)\}\}"/g)].map(m => m[1]);
		const before = (a, b) => order.indexOf(a) !== -1 && order.indexOf(a) < order.indexOf(b);
		assert.ok(before('SQL_MATCHER_URI', 'SQL_AUTOCOMPLETE_URI'));
		assert.ok(before('SQL_CONTEXT_URI', 'SQL_AUTOCOMPLETE_URI'));
		assert.ok(before('SQL_AUTOCOMPLETE_URI', 'QUERY_MANAGER_URI'));
		assert.ok(before('BUILTIN_SNIPPETS_URI', 'QUERY_MANAGER_URI'));
		assert.ok(before('SQL_EDITOR_URI', 'QUERY_MANAGER_URI'));
		assert.ok(before('ICONS_URI', 'QUERY_MANAGER_URI'));
		assert.ok(order[order.length - 1] === 'MAIN_SCRIPT_URI', 'main.js loads last');
	});
});
