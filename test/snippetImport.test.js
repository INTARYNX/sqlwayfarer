const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { collectSnippetFiles, toStoredSnippet, planImport, mergeSnippets } = require('../database/snippetImport');

const parsed = (name, extra = {}) => Object.assign({ name, abbreviation: '', description: '', sql: `SELECT '${name}'`, placeholders: [] }, extra);
const stored = (name, extra = {}) => Object.assign({ name, sql: `OLD ${name}`, createdAt: 1 }, extra);

suite('collectSnippetFiles', () => {
	let dir;
	setup(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlwf-snippets-'));
		await fs.mkdir(path.join(dir, 'sub', 'deeper'), { recursive: true });
		await fs.writeFile(path.join(dir, 'a.sqlpromptsnippet'), 'A');
		await fs.writeFile(path.join(dir, 'sub', 'b.SQLPROMPTSNIPPET'), 'B');
		await fs.writeFile(path.join(dir, 'sub', 'deeper', 'c.sqlpromptsnippet'), 'C');
		await fs.writeFile(path.join(dir, 'notes.txt'), 'not a snippet');
	});
	teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

	test('a folder gives every snippet file in it, subfolders included, and nothing else', async () => {
		const { files, skipped, truncated } = await collectSnippetFiles([dir]);
		assert.deepStrictEqual(files.map(f => f.text).sort(), ['A', 'B', 'C']);
		assert.deepStrictEqual(skipped, []);
		assert.strictEqual(truncated, false);
	});

	test('files picked one by one are read whatever their extension', async () => {
		const { files } = await collectSnippetFiles([path.join(dir, 'notes.txt'), path.join(dir, 'a.sqlpromptsnippet')]);
		assert.deepStrictEqual(files.map(f => f.text), ['not a snippet', 'A']);
	});

	test('a path that does not exist is reported, the others are still read', async () => {
		const { files, skipped } = await collectSnippetFiles([path.join(dir, 'missing.sqlpromptsnippet'), path.join(dir, 'a.sqlpromptsnippet')]);
		assert.strictEqual(files.length, 1);
		assert.strictEqual(skipped.length, 1);
		assert.ok(/Cannot be read/.test(skipped[0].reason));
	});

	test('a link inside a folder is never followed', async function () {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlwf-outside-'));
		try {
			await fs.writeFile(path.join(outside, 'secret.sqlpromptsnippet'), 'SECRET');
			try { await fs.symlink(outside, path.join(dir, 'link')); } catch { this.skip(); }
			const { files } = await collectSnippetFiles([dir]);
			assert.ok(!files.some(f => f.text === 'SECRET'));
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});
});

suite('snippet import: merge', () => {
	test('a parsed snippet is stored with what it has, marked as coming from SQL Prompt', () => {
		const snippet = toStoredSnippet(parsed('H1', { abbreviation: 'LD_H1', description: 'Heading', placeholders: [{ id: 'S', tooltip: '', default: '' }] }), 5);
		assert.deepStrictEqual(snippet, { name: 'H1', sql: "SELECT 'H1'", createdAt: 5, source: 'SQL Prompt', abbreviation: 'LD_H1', description: 'Heading', placeholders: [{ id: 'S', tooltip: '', default: '' }] });
		const bare = toStoredSnippet(parsed('B'), 5);
		assert.deepStrictEqual(Object.keys(bare), ['name', 'sql', 'createdAt', 'source']);
	});

	test('new snippets are added, existing names are told apart', () => {
		const plan = planImport([stored('keep'), stored('same')], [parsed('same'), parsed('new')]);
		assert.deepStrictEqual(plan.fresh.map(s => s.name), ['new']);
		assert.deepStrictEqual(plan.duplicates.map(s => s.name), ['same']);
	});

	test('without overwrite an existing snippet is left alone', () => {
		const result = mergeSnippets([stored('same')], [parsed('same'), parsed('new')], false);
		assert.deepStrictEqual(result.snippets.map(s => s.name), ['new', 'same']);
		assert.strictEqual(result.snippets.find(s => s.name === 'same').sql, 'OLD same');
		assert.deepStrictEqual([result.added, result.overwritten, result.leftOut], [1, 0, 1]);
	});

	test('with overwrite the imported snippet replaces it', () => {
		const result = mergeSnippets([stored('same')], [parsed('same')], true);
		assert.strictEqual(result.snippets.find(s => s.name === 'same').sql, "SELECT 'same'");
		assert.deepStrictEqual([result.added, result.overwritten, result.leftOut], [0, 1, 0]);
	});

	test('two imported snippets with one name do not erase each other', () => {
		const result = mergeSnippets([], [parsed('twin', { sql: 'ONE' }), parsed('twin', { sql: 'TWO' })], false);
		assert.deepStrictEqual(result.snippets.map(s => [s.name, s.sql]), [['twin', 'ONE'], ['twin (2)', 'TWO']]);
	});

	test('the result is sorted by name', () => {
		const result = mergeSnippets([stored('b')], [parsed('c'), parsed('a')], false);
		assert.deepStrictEqual(result.snippets.map(s => s.name), ['a', 'b', 'c']);
	});
});
