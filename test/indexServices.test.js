const assert = require('assert');
const IndexService = require('../database/IndexServices');

// Mocked ConnectionManager for _analyzeDependencies: one dependency recordset
// per object (keyed by the bracketed qualified name), or an error to test tolerance.
function makeMockCm(depsByObject, options = {}) {
	let calls = 0;
	return {
		calls: () => calls,
		getServerName: () => 'testserver',
		executeQueryInDatabase: async (database, query, params) => {
			calls++;
			const objectName = params.objectName;
			if (options.failFor && objectName === options.failFor) {
				throw new Error('Could not resolve references');
			}
			return { recordset: depsByObject[objectName] || [] };
		}
	};
}

function makeObject(schema, name, type, modifyDate = '2026-01-01') {
	return {
		object_id: Math.abs(hash(`${schema}.${name}`)), name, schema_name: schema,
		qualified_name: `${schema}.${name}`, type, type_desc: type,
		create_date: '2020-01-01', modify_date: modifyDate, database_name: 'Db'
	};
}

// Small deterministic hash so each object gets a stable fake object_id
function hash(s) {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return h || 1;
}

suite('IndexService dependency analysis', () => {
	test('collects per-object dependencies and reports progress from 0 to 100', async () => {
		const service = new IndexService(makeMockCm(
			{ '[dbo].[P1]': [{ dependency: 'dbo.T1', dependency_database: 'Db' }] }
		), null);

		const reports = [];
		service._progressCallback = p => reports.push(p);

		const dependencies = await service._analyzeDependencies('Db', [
			makeObject('dbo', 'T1', 'U'), makeObject('dbo', 'P1', 'P')
		]);

		assert.deepStrictEqual(dependencies, [{
			object_name: '[dbo].[P1]', dependency: 'dbo.T1', type: 'P', dependency_database: 'Db'
		}]);

		assert.strictEqual(reports[0].progress, 0);
		assert.strictEqual(reports[reports.length - 1].progress, 100);
		assert.strictEqual(reports[reports.length - 1].current, 2);
		assert.ok(reports.some(r => r.message === 'dbo.P1'), 'progress message carries the object name');
	});

	test('throttles progress reports to whole-percent changes', async () => {
		const objects = [];
		for (let i = 0; i < 500; i++) objects.push(makeObject('dbo', `T${i}`, 'U'));
		const service = new IndexService(makeMockCm({}), null);

		const reports = [];
		service._progressCallback = p => reports.push(p);

		await service._analyzeDependencies('Db', objects);

		// 500 objects but at most ~101 distinct percentages should be posted
		assert.ok(reports.length <= 102, `expected throttled reports, got ${reports.length}`);
	});

	test('an object whose references cannot be resolved is skipped, not fatal', async () => {
		const service = new IndexService(makeMockCm(
			{ '[dbo].[P1]': [{ dependency: 'dbo.X', dependency_database: 'Db' }] },
			{ failFor: '[dbo].[Broken]' }
		), null);

		const dependencies = await service._analyzeDependencies('Db', [
			makeObject('dbo', 'Broken', 'V'), makeObject('dbo', 'P1', 'P')
		]);
		assert.strictEqual(dependencies.length, 1);
		assert.strictEqual(dependencies[0].object_name, '[dbo].[P1]');
	});

	test('requestCancel stops the loop with an INDEXING_CANCELLED error', async () => {
		const objects = [];
		for (let i = 0; i < 10; i++) objects.push(makeObject('dbo', `T${i}`, 'U'));
		const cm = makeMockCm({});
		const service = new IndexService(cm, null);

		// Cancel as soon as the first progress report arrives
		service._progressCallback = () => service.requestCancel();

		await assert.rejects(
			() => service._analyzeDependencies('Db', objects),
			err => err.code === 'INDEXING_CANCELLED'
		);
		assert.ok(cm.calls() < 10, 'loop must stop early instead of processing every object');
	});
});

suite('IndexService incremental indexing', () => {
	test('schema checksum is stable regardless of input ordering', () => {
		const service = new IndexService(makeMockCm({}), null);
		const a = makeObject('dbo', 'A', 'U');
		const b = makeObject('dbo', 'B', 'P');
		assert.strictEqual(
			service._checksumFromObjects([a, b]),
			service._checksumFromObjects([b, a])
		);
		assert.notStrictEqual(
			service._checksumFromObjects([a, b]),
			service._checksumFromObjects([a, { ...b, modify_date: '2026-02-02' }])
		);
	});

	test('only changed and new objects are re-analyzed; unchanged keep their dependencies', async () => {
		const service0 = new IndexService(makeMockCm({}), null);

		// Cached index: A (unchanged), B (will be modified), D (will be dropped)
		const objA = makeObject('dbo', 'A', 'U');
		const objB = makeObject('dbo', 'B', 'P', '2026-01-01');
		const objD = makeObject('dbo', 'D', 'V');
		const cachedIndex = {
			database: 'Db', lastFullIndex: '2026-07-01T00:00:00.000Z', schemaChecksum: 'old',
			objects: {
				'dbo.A': { ...service0._makeIndexEntry(objA), dependencies: ['dbo.SomethingOld'] },
				'dbo.B': { ...service0._makeIndexEntry(objB), dependencies: ['dbo.A'] },
				'dbo.D': service0._makeIndexEntry(objD)
			}
		};

		// Live state: A unchanged, B modified, C added, D gone
		const live = [
			objA,
			makeObject('dbo', 'B', 'P', '2026-07-05'),
			makeObject('dbo', 'C', 'P')
		];

		const cm = makeMockCm({
			'[dbo].[B]': [{ dependency: 'dbo.C', dependency_database: 'Db' }],
			'[dbo].[C]': [{ dependency: 'dbo.A', dependency_database: 'Db' }]
		});
		const service = new IndexService(cm, null);

		const index = await service._updateIndexIncrementally('Db', cachedIndex, live, 'newchecksum');

		assert.strictEqual(cm.calls(), 2, 'only B (modified) and C (new) hit the database');
		assert.deepStrictEqual(index.objects['dbo.A'].dependencies, ['dbo.SomethingOld'], 'unchanged entry reused as-is');
		assert.deepStrictEqual(index.objects['dbo.B'].dependencies, ['dbo.C'], 'modified entry re-analyzed');
		assert.deepStrictEqual(index.objects['dbo.C'].dependencies, ['dbo.A'], 'new entry analyzed');
		assert.strictEqual(index.objects['dbo.D'], undefined, 'dropped object removed from the index');

		assert.strictEqual(index.totalObjects, 3);
		assert.deepStrictEqual(index.objectsByType, { U: 1, P: 2 });
		assert.strictEqual(index.schemaChecksum, 'newchecksum');
		assert.strictEqual(index.lastFullIndex, '2026-07-01T00:00:00.000Z', 'full-index timestamp preserved');
		assert.ok(index.lastIncrementalUpdate, 'incremental timestamp recorded');
	});

	test('no changes means zero database calls for dependencies', async () => {
		const service0 = new IndexService(makeMockCm({}), null);
		const objA = makeObject('dbo', 'A', 'U');
		const cachedIndex = {
			database: 'Db', lastFullIndex: 'x', schemaChecksum: 'old',
			objects: { 'dbo.A': service0._makeIndexEntry(objA) }
		};

		const cm = makeMockCm({});
		const service = new IndexService(cm, null);
		const index = await service._updateIndexIncrementally('Db', cachedIndex, [objA], 'new');

		assert.strictEqual(cm.calls(), 0);
		assert.strictEqual(index.totalObjects, 1);
	});
});
