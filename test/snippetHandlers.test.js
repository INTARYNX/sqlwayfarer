const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const SnippetHandlers = require('../panels/handlers/SnippetHandlers');

const KEY = 'sqlwayfarer.customSnippets';
const makeState = (initial = []) => {
	const store = new Map([[KEY, initial]]);
	return { get: (k, d) => (store.has(k) ? store.get(k) : d), update: async (k, v) => { store.set(k, v); } };
};

const snippetFile = (title, shortcut, code, declarations = '<Declarations />') => `﻿<?xml version="1.0" encoding="utf-8"?>
<CodeSnippets><CodeSnippet Format="1.0.0"><Header><Title>${title}</Title><Shortcut>${shortcut}</Shortcut><Description>about ${title}</Description><Author /><SnippetTypes><SnippetType>Expansion</SnippetType></SnippetTypes></Header>
<Snippet>${declarations}<Code Language="sql"><![CDATA[${code}]]></Code></Snippet></CodeSnippet></CodeSnippets>`;

function setup(initial, answers) {
	const posted = [];
	const broadcast = [];
	const infos = [];
	const asked = [];
	const state = makeState(initial);
	const ui = {
		pickSource: async () => answers.source,
		pickPaths: async () => answers.paths,
		confirmImport: async info => { asked.push(info); return answers.choice; },
		info: message => infos.push(message)
	};
	const handlers = new SnippetHandlers(m => posted.push(m), state, m => broadcast.push(m), ui);
	return { handlers, state, posted, broadcast, infos, asked };
}

suite('SnippetHandlers: import and edit', () => {
	let dir;
	suiteSetup(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlwf-import-'));
		await fs.mkdir(path.join(dir, 'sub'));
		await fs.writeFile(path.join(dir, 'h1.sqlpromptsnippet'), snippetFile('H1', 'LD_H1', '--$Section$\n$CURSOR$', '<Declarations><Literal><ID>Section</ID><ToolTip /><Default>Title</Default></Literal></Declarations>'));
		await fs.writeFile(path.join(dir, 'sub', 'max.sqlpromptsnippet'), snippetFile('MaxInt', 'LD_MaxInt', '2147483647'));
		await fs.writeFile(path.join(dir, 'broken.sqlpromptsnippet'), '<html>not a snippet</html>');
	});
	suiteTeardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

	test('a folder is imported with its abbreviations, descriptions and placeholders', async () => {
		const { handlers, state, posted, broadcast, asked } = setup([], { source: 'folder', paths: [dir], choice: 'import' });
		await handlers.handleImportSnippets();
		const saved = state.get(KEY);
		assert.deepStrictEqual(saved.map(s => s.name), ['H1', 'MaxInt']);
		const h1 = saved.find(s => s.name === 'H1');
		assert.strictEqual(h1.abbreviation, 'LD_H1');
		assert.strictEqual(h1.description, 'about H1');
		assert.deepStrictEqual(h1.placeholders, [{ id: 'Section', tooltip: '', default: 'Title' }]);
		assert.strictEqual(h1.source, 'SQL Prompt');
		assert.strictEqual(asked[0].found, 2);
		assert.strictEqual(asked[0].skipped.length, 1, 'the broken file is reported');
		assert.deepStrictEqual(posted[0], { command: 'snippetsImported', added: 2, overwritten: 0, leftOut: 0, skippedFiles: 1 });
		assert.strictEqual(broadcast[0].command, 'snippetsLoaded', 'every open tab gets the new snippets');
	});

	test('cancelling at any step changes nothing', async () => {
		for (const answers of [{ source: undefined }, { source: 'folder', paths: undefined }, { source: 'folder', paths: [dir], choice: undefined }]) {
			const { handlers, state, posted } = setup([], answers);
			await handlers.handleImportSnippets();
			assert.deepStrictEqual(state.get(KEY), []);
			assert.deepStrictEqual(posted, []);
		}
	});

	test('a snippet that already exists is kept, or overwritten when the user says so', async () => {
		const existing = [{ name: 'H1', sql: 'MINE', createdAt: 1 }];
		const keep = setup(existing, { source: 'folder', paths: [dir], choice: 'import' });
		await keep.handlers.handleImportSnippets();
		assert.strictEqual(keep.state.get(KEY).find(s => s.name === 'H1').sql, 'MINE');
		assert.deepStrictEqual(keep.asked[0].duplicates, ['H1']);
		assert.strictEqual(keep.posted[0].leftOut, 1);

		const overwrite = setup(existing, { source: 'folder', paths: [dir], choice: 'overwrite' });
		await overwrite.handlers.handleImportSnippets();
		assert.ok(overwrite.state.get(KEY).find(s => s.name === 'H1').sql.includes('$Section$'));
		assert.strictEqual(overwrite.posted[0].overwritten, 1);
	});

	test('nothing readable: the user is told, nothing is saved', async () => {
		const { handlers, state, posted, infos } = setup([], { source: 'files', paths: [path.join(dir, 'broken.sqlpromptsnippet')], choice: 'import' });
		await handlers.handleImportSnippets();
		assert.deepStrictEqual(state.get(KEY), []);
		assert.strictEqual(posted[0].added, 0);
		assert.ok(/No snippet could be read/.test(infos[0]));
	});

	test('editing an imported snippet keeps its placeholders, description and source', async () => {
		const imported = { name: 'H1', sql: '--$Section$', createdAt: 1, abbreviation: 'LD_H1', description: 'about', placeholders: [{ id: 'Section', default: 'T' }], source: 'SQL Prompt' };
		const { handlers, state } = setup([imported], {});
		await handlers.handleUpdateSnippet('H1', 'Heading', '--$Section$\n$CURSOR$');
		const [saved] = state.get(KEY);
		assert.strictEqual(saved.name, 'Heading');
		assert.strictEqual(saved.abbreviation, 'LD_H1', 'the abbreviation is kept when the form does not send one');
		assert.deepStrictEqual(saved.placeholders, imported.placeholders);
		assert.strictEqual(saved.description, 'about');
		assert.strictEqual(saved.source, 'SQL Prompt');
	});

	test('an abbreviation can be set, changed and removed', async () => {
		const { handlers, state } = setup([], {});
		await handlers.handleAddSnippet('mine', 'SELECT 1', ' mm ');
		assert.strictEqual(state.get(KEY)[0].abbreviation, 'mm');
		await handlers.handleUpdateSnippet('mine', 'mine', 'SELECT 1', 'm2');
		assert.strictEqual(state.get(KEY)[0].abbreviation, 'm2');
		await handlers.handleUpdateSnippet('mine', 'mine', 'SELECT 1', '');
		assert.strictEqual('abbreviation' in state.get(KEY)[0], false);
	});
});
