const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const QueryFileHandlers = require('../panels/handlers/QueryFileHandlers');

// Minimal Memento stand-in for workspaceState.
function makeState() {
	const store = new Map();
	return {
		get: (k, d) => (store.has(k) ? store.get(k) : d),
		update: async (k, v) => { store.set(k, v); }
	};
}

// Only methods that stay off vscode.window's interactive dialogs (showSaveDialog /
// showWarningMessage) are covered here - those would block waiting for real UI
// input under the vscode-test host, same reasoning QueryHandlers' own tests
// follow by never exercising _confirmRisks.
suite('QueryFileHandlers', () => {
	let tmpDir;

	setup(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlwayfarer-qfh-'));
	});

	teardown(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test('lists only .sql files at the root, sorted by name', async () => {
		await fs.writeFile(path.join(tmpDir, 'b.sql'), 'SELECT 2;');
		await fs.writeFile(path.join(tmpDir, 'a.sql'), 'SELECT 1;');
		await fs.writeFile(path.join(tmpDir, 'notes.txt'), 'ignore me');

		const posts = [];
		const handlers = new QueryFileHandlers(m => posts.push(m), makeState());
		await handlers.handleListSqlFiles(tmpDir);

		const result = posts.find(p => p.command === 'sqlFilesListed');
		assert.ok(result);
		assert.deepStrictEqual(result.files.map(f => f.name), ['a.sql', 'b.sql']);
		assert.deepStrictEqual(result.files.map(f => f.relativeDir), ['', '']);
		assert.strictEqual(result.files[0].path, path.join(tmpDir, 'a.sql'));
	});

	test('recurses into subdirectories, reporting each file\'s relative directory', async () => {
		await fs.writeFile(path.join(tmpDir, 'root.sql'), 'SELECT 0;');
		await fs.mkdir(path.join(tmpDir, 'migrations'));
		await fs.writeFile(path.join(tmpDir, 'migrations', '001.sql'), 'SELECT 1;');
		await fs.mkdir(path.join(tmpDir, 'migrations', 'nested'));
		await fs.writeFile(path.join(tmpDir, 'migrations', 'nested', '002.sql'), 'SELECT 2;');

		const posts = [];
		const handlers = new QueryFileHandlers(m => posts.push(m), makeState());
		await handlers.handleListSqlFiles(tmpDir);

		const result = posts.find(p => p.command === 'sqlFilesListed');
		const byName = Object.fromEntries(result.files.map(f => [f.name, f.relativeDir]));
		assert.deepStrictEqual(byName, {
			'root.sql': '',
			'001.sql': 'migrations',
			'002.sql': 'migrations/nested'
		});
	});

	test('skips node_modules and dotfolders', async () => {
		await fs.mkdir(path.join(tmpDir, 'node_modules'));
		await fs.writeFile(path.join(tmpDir, 'node_modules', 'vendored.sql'), 'SELECT 1;');
		await fs.mkdir(path.join(tmpDir, '.git'));
		await fs.writeFile(path.join(tmpDir, '.git', 'hidden.sql'), 'SELECT 1;');
		await fs.writeFile(path.join(tmpDir, 'keep.sql'), 'SELECT 1;');

		const posts = [];
		const handlers = new QueryFileHandlers(m => posts.push(m), makeState());
		await handlers.handleListSqlFiles(tmpDir);

		const result = posts.find(p => p.command === 'sqlFilesListed');
		assert.deepStrictEqual(result.files.map(f => f.name), ['keep.sql']);
	});

	test('reports an empty list when no workspace root is available', async () => {
		const posts = [];
		const handlers = new QueryFileHandlers(m => posts.push(m), makeState());
		await handlers.handleListSqlFiles(null);

		const result = posts.find(p => p.command === 'sqlFilesListed');
		assert.deepStrictEqual(result.files, []);
	});

	test('opens a file and reports its content and name', async () => {
		const filePath = path.join(tmpDir, 'query.sql');
		await fs.writeFile(filePath, 'SELECT * FROM dbo.Foo;');

		const posts = [];
		const handlers = new QueryFileHandlers(m => posts.push(m), makeState());
		await handlers.handleOpenSqlFile(filePath);

		const result = posts.find(p => p.command === 'sqlFileOpened');
		assert.ok(result);
		assert.strictEqual(result.name, 'query.sql');
		assert.strictEqual(result.content, 'SELECT * FROM dbo.Foo;');
	});

	test('reports an error when opening a file that no longer exists', async () => {
		const posts = [];
		const handlers = new QueryFileHandlers(m => posts.push(m), makeState());
		await handlers.handleOpenSqlFile(path.join(tmpDir, 'missing.sql'));

		const result = posts.find(p => p.command === 'sqlFileError');
		assert.ok(result);
		assert.ok(result.message.includes('missing.sql'));
	});

	test('saves content back to an existing file-backed tab', async () => {
		const filePath = path.join(tmpDir, 'query.sql');
		await fs.writeFile(filePath, 'SELECT 1;');

		const posts = [];
		const handlers = new QueryFileHandlers(m => posts.push(m), makeState());
		await handlers.handleSaveSqlFile(filePath, 'SELECT 2;');

		const result = posts.find(p => p.command === 'sqlFileSaved');
		assert.deepStrictEqual(result, { command: 'sqlFileSaved', path: filePath, success: true });
		assert.strictEqual(await fs.readFile(filePath, 'utf8'), 'SELECT 2;');
	});

	test('round-trips the unsaved-drafts recovery snapshot through workspaceState', async () => {
		const posts = [];
		const state = makeState();
		const handlers = new QueryFileHandlers(m => posts.push(m), state);

		await handlers.handleGetDraftRecovery();
		assert.deepStrictEqual(posts.pop(), { command: 'draftRecoveryLoaded', drafts: [] });

		await handlers.handleSaveDraftRecovery(['SELECT 1;', 'SELECT 2;']);
		await handlers.handleGetDraftRecovery();
		assert.deepStrictEqual(posts.pop(), { command: 'draftRecoveryLoaded', drafts: ['SELECT 1;', 'SELECT 2;'] });
	});
});
