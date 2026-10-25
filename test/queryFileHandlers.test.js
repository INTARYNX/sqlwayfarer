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
		// tmpDir stands in for the workspace root here (the real vscode.workspace.
		// workspaceFolders in the test host points elsewhere) - same stubbing
		// idiom ParserWorkerPool's tests use for _ensurePool.
		handlers._isInsideWorkspace = () => true;
		await handlers.handleOpenSqlFile(filePath);

		const result = posts.find(p => p.command === 'sqlFileOpened');
		assert.ok(result);
		assert.strictEqual(result.name, 'query.sql');
		assert.strictEqual(result.content, 'SELECT * FROM dbo.Foo;');
	});

	test('reports an error when opening a file that no longer exists', async () => {
		const posts = [];
		const handlers = new QueryFileHandlers(m => posts.push(m), makeState());
		handlers._isInsideWorkspace = () => true;
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
		handlers._isInsideWorkspace = () => true;
		await handlers.handleSaveSqlFile(filePath, 'SELECT 2;');

		const result = posts.find(p => p.command === 'sqlFileSaved');
		assert.deepStrictEqual(result, { command: 'sqlFileSaved', path: filePath, success: true });
		assert.strictEqual(await fs.readFile(filePath, 'utf8'), 'SELECT 2;');
	});

	test('refuses to open or save a path outside the workspace', async () => {
		const outsidePath = path.join(os.tmpdir(), 'not-the-workspace.sql');
		await fs.writeFile(outsidePath, 'SELECT 1;');
		try {
			const posts = [];
			const handlers = new QueryFileHandlers(m => posts.push(m), makeState());
			// No _isInsideWorkspace stub here - exercises the real check against
			// whatever vscode.workspace.workspaceFolders actually is, which never
			// includes an arbitrary OS temp path.

			await handlers.handleOpenSqlFile(outsidePath);
			const openResult = posts.find(p => p.command === 'sqlFileError');
			assert.ok(openResult, 'open must be refused outside the workspace');

			await handlers.handleSaveSqlFile(outsidePath, 'SELECT 2;');
			const saveResult = posts.find(p => p.command === 'sqlFileSaved');
			assert.strictEqual(saveResult.success, false, 'save must be refused outside the workspace');
			assert.strictEqual(await fs.readFile(outsidePath, 'utf8'), 'SELECT 1;', 'file content must be untouched');
		} finally {
			await fs.rm(outsidePath, { force: true });
		}
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

	// Drafts are scoped per connection (server+login) so two tabs on
	// different servers never clobber each other's autosave - see
	// database/connectionIdentity.js.
	test('drafts are scoped per connection identity, not shared across connections', async () => {
		const posts = [];
		const state = makeState();
		let identity = null;
		const handlers = new QueryFileHandlers(m => posts.push(m), state, () => identity);

		await handlers.handleSaveDraftRecovery(['before any connection']);
		identity = 'server1:1433:sa';
		await handlers.handleSaveDraftRecovery(['server1 draft']);

		identity = null;
		await handlers.handleGetDraftRecovery();
		assert.deepStrictEqual(posts.pop().drafts, ['before any connection'], 'the pre-connect bucket must be untouched by server1\'s save');

		identity = 'server1:1433:sa';
		await handlers.handleGetDraftRecovery();
		assert.deepStrictEqual(posts.pop().drafts, ['server1 draft']);
	});

	// handleGetDraftRecovery fires at webview load, before this panel has a
	// connection - maybeOfferRecoveryForCurrentIdentity is the re-check fired
	// after a successful connect, so a crashed session's drafts on that same
	// server are still found once the identity is actually known.
	test('maybeOfferRecoveryForCurrentIdentity re-offers drafts once the connection identity is known', async () => {
		const posts = [];
		const state = makeState();
		let identity = null;
		const handlers = new QueryFileHandlers(m => posts.push(m), state, () => identity);

		// A previous session on server1 crashed with this draft saved.
		identity = 'server1:1433:sa';
		await handlers.handleSaveDraftRecovery(['recovered from server1']);

		// Fresh panel: no connection yet, nothing to recover under the shared bucket.
		identity = null;
		await handlers.handleGetDraftRecovery();
		assert.deepStrictEqual(posts.pop().drafts, []);

		// Connects to server1 - the real bucket is resolvable now.
		identity = 'server1:1433:sa';
		await handlers.maybeOfferRecoveryForCurrentIdentity();
		assert.deepStrictEqual(posts.pop(), { command: 'draftRecoveryLoaded', drafts: ['recovered from server1'] });
	});

	test('maybeOfferRecoveryForCurrentIdentity stays silent when there is nothing saved for this connection', async () => {
		const posts = [];
		const handlers = new QueryFileHandlers(m => posts.push(m), makeState(), () => 'server1:1433:sa');

		await handlers.maybeOfferRecoveryForCurrentIdentity();
		assert.strictEqual(posts.length, 0);
	});
});
