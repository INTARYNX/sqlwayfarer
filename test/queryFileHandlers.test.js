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

	test('opens UTF-16 (both byte orders) and UTF-8 with a mark as plain text', async () => {
		const text = 'SELECT 1 AS é;';
		const le = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);
		const be = Buffer.concat([Buffer.from([0xFE, 0xFF]), Buffer.from(text, 'utf16le').swap16()]);
		const bom8 = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')]);
		assert.strictEqual(QueryFileHandlers.decode(le), text);
		assert.strictEqual(QueryFileHandlers.decode(be), text);
		assert.strictEqual(QueryFileHandlers.decode(bom8), text);
		assert.strictEqual(QueryFileHandlers.decode(Buffer.from(text, 'utf8')), text);
	});

	test('opening reports the encoding, and saving writes the one it is given', async () => {
		for (const encoding of ['utf8', 'utf8bom', 'utf16le', 'utf16be']) {
			const filePath = path.join(tmpDir, `enc-${encoding}.sql`);
			await fs.writeFile(filePath, QueryFileHandlers.encode('SELECT 1;', encoding));

			const posts = [];
			const handlers = new QueryFileHandlers(m => posts.push(m), makeState());
			handlers._isInsideWorkspace = () => true;
			await handlers.handleOpenSqlFile(filePath);
			assert.strictEqual(posts.find(p => p.command === 'sqlFileOpened').encoding, encoding, `${encoding}: detected`);

			// Saved in the same encoding, then converted to another one.
			for (const target of [encoding, 'utf16le', 'utf8']) {
				await handlers.handleSaveSqlFile(filePath, 'SELECT 2 AS é;', target);
				const saved = await fs.readFile(filePath);
				assert.strictEqual(QueryFileHandlers.detectEncoding(saved), target, `${encoding} -> ${target}`);
				assert.strictEqual(QueryFileHandlers.decode(saved), 'SELECT 2 AS é;');
			}
		}
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

	test('a file the list showed opens even when it lives outside the workspace (another drive); another path still cannot', async () => {
		const listed = path.join(tmpDir, 'listed.sql');
		const other = path.join(tmpDir, 'other-unlisted.sql');
		await fs.writeFile(listed, 'SELECT 1;');
		await fs.writeFile(other, 'SELECT 2;');

		const posts = [];
		const handlers = new QueryFileHandlers(m => posts.push(m), makeState());
		handlers._isInsideWorkspace = QueryFileHandlers.prototype._isInsideWorkspace;
		// What the list shows: a file the workspace root does not contain.
		handlers._listed.add(path.resolve(listed));

		await handlers.handleOpenSqlFile(listed);
		assert.ok(posts.some(p => p.command === 'sqlFileOpened' && p.path === listed), 'the listed file opens');

		await handlers.handleOpenSqlFile(other);
		assert.ok(posts.some(p => p.command === 'sqlFileError'), 'an unlisted file outside the workspace is still refused');
	});

	test('a file chosen in Save As can be saved again, even outside the workspace; another path still cannot', async () => {
		const chosen = path.join(tmpDir, 'chosen.sql');
		const other = path.join(tmpDir, 'other.sql');
		const posts = [];
		const handlers = new QueryFileHandlers(m => posts.push(m), makeState());
		handlers._pickSaveFile = async () => ({ fsPath: chosen });

		await handlers.handleSaveSqlFileAs('SELECT 1;', 'chosen.sql');
		assert.strictEqual(posts.pop().success, true);

		await handlers.handleSaveSqlFile(chosen, 'SELECT 2;');
		assert.strictEqual(posts.pop().success, true, 'Save after Save As');
		assert.strictEqual(await fs.readFile(chosen, 'utf8'), 'SELECT 2;');

		await handlers.handleSaveSqlFile(other, 'SELECT 3;');
		assert.strictEqual(posts.pop().success, false, 'a path the user never chose stays refused');
		await assert.rejects(fs.readFile(other, 'utf8'));
	});

	test('a cancelled Save As allows nothing', async () => {
		const posts = [];
		const handlers = new QueryFileHandlers(m => posts.push(m), makeState());
		handlers._pickSaveFile = async () => undefined;
		await handlers.handleSaveSqlFileAs('SELECT 1;', 'x.sql');
		assert.strictEqual(posts.pop().cancelled, true);
		assert.strictEqual(handlers._savedAs.size, 0);
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
	test('searches the contents of the files: plain text, regex, UTF-16, first line, and a stale request stops', async () => {
		await fs.mkdir(path.join(tmpDir, 'sub'));
		await fs.writeFile(path.join(tmpDir, 'a.sql'), 'SELECT 1;\nselect * from Orders;\nSELECT * FROM orders;\n');
		await fs.writeFile(path.join(tmpDir, 'sub', 'b.sql'), QueryFileHandlers.encode('-- x\nDROP TABLE (orders)', 'utf16le'));
		await fs.writeFile(path.join(tmpDir, 'c.sql'), 'nothing here');

		const search = async (query, regex, id = 1) => {
			const posts = [];
			const handlers = new QueryFileHandlers(m => posts.push(m), makeState());
			await handlers.handleSearchSqlFiles(query, regex, id, tmpDir);
			return posts.find(p => p.command === 'sqlFilesSearched');
		};
		const names = r => r.results.map(x => path.basename(x.path)).sort();

		const plain = await search('orders', false, 7);
		assert.strictEqual(plain.id, 7);
		assert.deepStrictEqual(names(plain), ['a.sql', 'b.sql']);
		const a = plain.results.find(x => x.path.endsWith('a.sql'));
		assert.deepStrictEqual([a.count, a.line], [2, 2], 'two matches, the first on line 2 (any case)');
		assert.strictEqual(plain.results.find(x => x.path.endsWith('b.sql')).line, 2, 'found in a UTF-16 file');

		// The parenthesis is text when it is not a regular expression.
		assert.deepStrictEqual(names(await search('(orders)', false)), ['b.sql']);
		assert.deepStrictEqual(names(await search('^orders', true)), []);
		assert.deepStrictEqual(names(await search('^DROP', true)), ['b.sql'], '^ is the start of a line');
		assert.deepStrictEqual(names(await search('SELECT \\d', true)), ['a.sql']);

		const bad = await search('(', true);
		assert.ok(/Invalid regular expression/.test(bad.error));
		assert.deepStrictEqual((await search('', false)).results, []);

		// A newer search replaces this one: no answer for the old id.
		const posts = [];
		const handlers = new QueryFileHandlers(m => posts.push(m), makeState());
		const first = handlers.handleSearchSqlFiles('orders', false, 1, tmpDir);
		const second = handlers.handleSearchSqlFiles('nothing', false, 2, tmpDir);
		await Promise.all([first, second]);
		assert.deepStrictEqual(posts.map(p => p.id), [2]);
	});

	test('line ends: a CRLF file is reported as such and written back with CRLF; an LF file stays LF', async () => {
		assert.strictEqual(QueryFileHandlers.detectEol('a\r\nb'), 'crlf');
		assert.strictEqual(QueryFileHandlers.detectEol('a\nb'), 'lf');
		assert.strictEqual(QueryFileHandlers.applyEol('a\nb\r\nc', 'crlf'), 'a\r\nb\r\nc');
		assert.strictEqual(QueryFileHandlers.applyEol('a\nb', 'lf'), 'a\nb');

		for (const [name, text, eol] of [['crlf', 'SELECT 1\r\nFROM a', 'crlf'], ['lf', 'SELECT 1\nFROM a', 'lf']]) {
			const filePath = path.join(tmpDir, `eol-${name}.sql`);
			await fs.writeFile(filePath, text);
			const posts = [];
			const handlers = new QueryFileHandlers(m => posts.push(m), makeState());
			handlers._isInsideWorkspace = () => true;
			await handlers.handleOpenSqlFile(filePath);
			assert.strictEqual(posts.find(p => p.command === 'sqlFileOpened').eol, eol);

			// The editor sends the text with "\n" only.
			await handlers.handleSaveSqlFile(filePath, 'SELECT 2\nFROM b', 'utf8', eol);
			assert.strictEqual(await fs.readFile(filePath, 'utf8'), eol === 'crlf' ? 'SELECT 2\r\nFROM b' : 'SELECT 2\nFROM b');
		}
	});

	test('opening a file found by a search carries the line to go to', async () => {
		const filePath = path.join(tmpDir, 'q.sql');
		await fs.writeFile(filePath, 'a\nb\nc');
		const posts = [];
		const handlers = new QueryFileHandlers(m => posts.push(m), makeState());
		handlers._isInsideWorkspace = () => true;
		await handlers.handleOpenSqlFile(filePath, 3);
		assert.strictEqual(posts.find(p => p.command === 'sqlFileOpened').line, 3);
	});

	test('drafts kept per folder before are moved to the global state, once', async () => {
		const state = makeState();
		const legacy = makeState();
		const key = 'sqlwayfarer.queryDrafts::(disconnected)';
		await legacy.update(key, [{ content: 'SELECT 1' }]);

		const posts = [];
		const handlers = new QueryFileHandlers(m => posts.push(m), state, () => null, legacy);
		await handlers.handleGetDraftRecovery();
		assert.deepStrictEqual(posts[0].drafts, [{ content: 'SELECT 1' }]);
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual(state.get(key), [{ content: 'SELECT 1' }], 'copied to the global state');
		assert.strictEqual(legacy.get(key), undefined, 'removed from the old one');

		// What the global state holds wins over the old one.
		await legacy.update(key, [{ content: 'OLD' }]);
		await handlers.handleGetDraftRecovery();
		assert.deepStrictEqual(posts[1].drafts, [{ content: 'SELECT 1' }]);
	});

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
