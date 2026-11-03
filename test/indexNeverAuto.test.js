const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const DatabaseService = require('../database/DatabaseService');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const sourceFiles = dir => fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.js')).map(f => path.join(dir, f));

// IndexHandlers asks for `vscode` at load time: give it a stand-in.
function loadIndexHandlers(vscodeStub) {
	const original = Module._load;
	Module._load = function (request, ...rest) {
		return request === 'vscode' ? vscodeStub : original.call(this, request, ...rest);
	};
	try {
		delete require.cache[require.resolve('../panels/handlers/IndexHandlers')];
		return require('../panels/handlers/IndexHandlers');
	} finally {
		Module._load = original;
	}
}

// What, in the source, may build the index: a static guard, so that nobody
// re-introduces an automatic build by calling getIndex from a convenient place.
suite('the dependency index is only built on request (static guard)', () => {
	const callers = (pattern) => {
		const found = [];
		for (const file of ['extension.js', ...sourceFiles('panels'), ...sourceFiles('panels/handlers'), ...sourceFiles('database'), ...sourceFiles('storage')]) {
			if (!fs.existsSync(path.join(root, file))) continue;
			const lines = read(file).split('\n');
			lines.forEach((line, i) => {
				if (pattern.test(line) && !/^\s*(\/\/|\*)/.test(line)) found.push(`${file}:${i + 1}`);
			});
		}
		return found;
	};

	test('getIndex (build or update) is called from the explicit "build" handler only', () => {
		const found = callers(/\.getIndex\(/).map(f => f.replace(/:\d+$/, ''));
		assert.deepStrictEqual([...new Set(found)].sort(), ['panels/handlers/IndexHandlers.js']);
		assert.strictEqual(found.length, 1, 'one call site');
	});

	test('forceReindex is called from the confirmed force-reindex handler only', () => {
		const found = callers(/\.forceReindex\(/).map(f => f.replace(/:\d+$/, ''));
		assert.deepStrictEqual(found, ['panels/handlers/IndexHandlers.js']);
	});

	test('every other reader goes through peekIndex / requireIndex', () => {
		const readers = ['database/DependencyService.js', 'database/DataDictionaryService.js', 'database/WriteFootprintService.js', 'database/QueryGraphService.js'];
		for (const file of readers) {
			const source = read(file);
			assert.ok(/peekIndex|requireIndex/.test(source), `${file} reads the index`);
			assert.ok(!/\.getIndex\(/.test(source), `${file} must not build the index`);
		}
	});

	test('the webview asks for a build from one place only: ObjectsTabManager.buildIndex', () => {
		const calls = [];
		for (const file of fs.readdirSync(path.join(root, 'webview')).filter(f => f.endsWith('.js'))) {
			read(path.join('webview', file)).split('\n').forEach((line, i) => {
				if (/command:\s*'getIndex'/.test(line)) calls.push(`${file}:${i + 1}`);
			});
		}
		assert.strictEqual(calls.length, 1, calls.join(', '));
		const main = read('webview/main.js');
		const at = main.indexOf("command: 'getIndex'");
		const method = main.lastIndexOf('\n    buildIndex()', at);
		assert.ok(method > 0 && main.slice(method, at).indexOf('\n    }\n') === -1, 'the getIndex request is inside buildIndex()');
	});

	test('buildIndex is reached only from the notice buttons (data-index-action="build")', () => {
		const main = read('webview/main.js');
		const uses = [...main.matchAll(/\.buildIndex\(\)/g)];
		assert.strictEqual(uses.length, 1);
		assert.ok(/dataset\.indexAction === 'build'\) this\.buildIndex\(\)/.test(main));
	});
});

suite('IndexHandlers: status, load and build', () => {
	function setup(indexService) {
		const IndexHandlers = loadIndexHandlers({ window: { showWarningMessage: async () => undefined } });
		const posts = [];
		const handlers = new IndexHandlers(m => posts.push(m), indexService, {}, () => 'AppDb');
		return { handlers, posts };
	}

	test('the status is posted with its state, and nothing is built', async () => {
		let builds = 0;
		const { handlers, posts } = setup({
			getIndexStatus: async () => ({ state: 'stale', builtAt: '2026-10-01T00:00:00Z', totalObjects: 3 }),
			getIndex: async () => { builds++; }
		});
		await handlers.handleGetIndexStatus('AppDb');
		assert.deepStrictEqual(posts, [{ command: 'indexStatus', database: 'AppDb', state: 'stale', builtAt: '2026-10-01T00:00:00Z', totalObjects: 3 }]);
		assert.strictEqual(builds, 0);
	});

	test('a failing status becomes "unknown", never an error popup', async () => {
		const { handlers, posts } = setup({ getIndexStatus: async () => { throw new Error('boom'); } });
		await handlers.handleGetIndexStatus('AppDb');
		assert.deepStrictEqual(posts, [{ command: 'indexStatus', database: 'AppDb', state: 'unknown' }]);
	});

	test('no database: nothing is posted', async () => {
		const { handlers, posts } = setup({ getIndexStatus: async () => ({ state: 'none' }) });
		await handlers.handleGetIndexStatus('');
		await handlers.handleLoadIndex(null);
		assert.deepStrictEqual(posts, []);
	});

	test('loading hands over the cached index and never builds', async () => {
		let builds = 0;
		const index = { database: 'AppDb', objects: {} };
		const { handlers, posts } = setup({ peekIndex: async () => index, getIndex: async () => { builds++; } });
		await handlers.handleLoadIndex('AppDb');
		assert.deepStrictEqual(posts, [{ command: 'indexResult', indexData: index, database: 'AppDb' }]);
		assert.strictEqual(builds, 0);
	});

	test('loading failure gives an empty result', async () => {
		const { handlers, posts } = setup({ peekIndex: async () => { throw new Error('corrupt'); } });
		await handlers.handleLoadIndex('AppDb');
		assert.deepStrictEqual(posts, [{ command: 'indexResult', indexData: null, database: 'AppDb' }]);
	});

	test('the explicit build announces itself, reports progress and returns the index', async () => {
		const index = { database: 'AppDb', objects: {} };
		const { handlers, posts } = setup({
			getIndex: async (db, progress) => { progress({ progress: 50, current: 1, total: 2, message: 'half' }); return index; }
		});
		await handlers.handleGetIndex('AppDb');
		assert.deepStrictEqual(posts.map(p => p.command), ['indexingStarted', 'indexingProgress', 'indexResult']);
		assert.strictEqual(posts[0].forced, false);
		assert.strictEqual(posts[1].progress, 50);
		assert.strictEqual(posts[2].indexData, index);
	});

	test('a cancelled build answers with an empty result, quietly', async () => {
		const { handlers, posts } = setup({ getIndex: async () => { throw Object.assign(new Error('x'), { code: 'INDEXING_CANCELLED' }); } });
		await handlers.handleGetIndex('AppDb');
		assert.deepStrictEqual(posts.map(p => p.command), ['indexingStarted', 'indexResult']);
		assert.strictEqual(posts[1].indexData, null);
	});

	test('a build without a database is an error, and nothing starts', async () => {
		let builds = 0;
		const { handlers, posts } = setup({ getIndex: async () => { builds++; } });
		await handlers.handleGetIndex('');
		assert.strictEqual(builds, 0);
		assert.strictEqual(posts[0].command, 'error');
	});
});

suite('DatabaseService: columns and parameters for the autocompletion', () => {
	function service(rows) {
		const queries = [];
		const cm = {
			isConnected: () => true,
			executeQueryInDatabase: async (db, sql, params) => { queries.push({ db, sql, params }); return { recordset: rows }; }
		};
		return { svc: new DatabaseService(cm), queries };
	}

	test('columns come with the full type, nullability, key and identity', async () => {
		const { svc, queries } = service([
			{ column_name: 'ID', data_type: 'int', max_length: 4, precision: 10, scale: 0, is_nullable: 0, is_identity: 1, is_primary_key: 1 },
			{ column_name: 'Name', data_type: 'nvarchar', max_length: 100, precision: 0, scale: 0, is_nullable: 1, is_identity: 0, is_primary_key: 0 },
			{ column_name: 'Total', data_type: 'decimal', max_length: 9, precision: 18, scale: 2, is_nullable: 1, is_identity: 0, is_primary_key: 0 }
		]);
		const columns = await svc.getObjectColumns('AppDb', 'dbo.Employees');
		assert.deepStrictEqual(columns, [
			{ name: 'ID', type: 'int', nullable: false, isIdentity: true, isPrimaryKey: true },
			{ name: 'Name', type: 'nvarchar(50)', nullable: true, isIdentity: false, isPrimaryKey: false },
			{ name: 'Total', type: 'decimal(18,2)', nullable: true, isIdentity: false, isPrimaryKey: false }
		]);
		assert.deepStrictEqual(queries[0].params, { schema: 'dbo', objectName: 'Employees' });
		assert.ok(/ORDER BY c\.column_id/.test(queries[0].sql), 'columns keep the table order');
	});

	test('parameters come in declaration order with their direction', async () => {
		const { svc, queries } = service([
			{ parameter_name: '@Dept', data_type: 'int', max_length: 4, precision: 10, scale: 0, is_output: 0 },
			{ parameter_name: '@Total', data_type: 'money', max_length: 8, precision: 19, scale: 4, is_output: 1 }
		]);
		assert.deepStrictEqual(await svc.getObjectParameters('AppDb', 'dbo.usp'), [
			{ name: '@Dept', type: 'int', isOutput: false },
			{ name: '@Total', type: 'money', isOutput: true }
		]);
		assert.ok(/parameter_id > 0/.test(queries[0].sql), 'the return value (parameter 0) is not a parameter');
	});

	test('both refuse to run without a connection', async () => {
		const svc = new DatabaseService({ isConnected: () => false });
		await assert.rejects(() => svc.getObjectColumns('d', 'o'), /No active connection/);
		await assert.rejects(() => svc.getObjectParameters('d', 'o'), /No active connection/);
	});
});

suite('DatabaseHandlers: parameters for the autocompletion', () => {
	const DatabaseHandlers = require('../panels/handlers/DatabaseHandlers');

	test('the parameters are posted back with the object they belong to', async () => {
		const posts = [];
		const handlers = new DatabaseHandlers(m => posts.push(m), { getObjectParameters: async () => [{ name: '@a', type: 'int' }] }, {}, {}, () => 'd');
		await handlers.handleGetObjectParameters('d', 'dbo.p');
		assert.deepStrictEqual(posts, [{ command: 'objectParametersLoaded', database: 'd', objectName: 'dbo.p', parameters: [{ name: '@a', type: 'int' }] }]);
	});

	test('a failure answers with an empty list (the request must not stay pending), without a popup', async () => {
		const posts = [];
		const handlers = new DatabaseHandlers(m => posts.push(m), { getObjectParameters: async () => { throw new Error('denied'); } }, {}, {}, () => 'd');
		await handlers.handleGetObjectParameters('d', 'dbo.p');
		assert.deepStrictEqual(posts, [{ command: 'objectParametersLoaded', database: 'd', objectName: 'dbo.p', parameters: [] }]);
	});
});
