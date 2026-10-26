const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const IndexService = require('../database/IndexServices');

// _analyzeDependencies reports progress/checks cancellation through a build
// entry in service._builds (see IndexServices.js) - tests that call it
// directly (bypassing getIndex/forceReindex) need to register one first.
function registerBuild(service, database, progressCallback) {
	const build = {
		forced: false, cancelRequested: false,
		subscribers: new Set(progressCallback ? [progressCallback] : []),
		lastReportedPct: -1, server: 'testserver'
	};
	service._builds.set(database, build);
	return build;
}

// Mocked ConnectionManager for _analyzeDependencies: one dependency recordset
// per object (keyed by the bracketed qualified name), or an error to test tolerance.
// options.definitions gives the SQL definition of an object, as the second
// resultset of the same batch (the one the DMV query returns).
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
			const deps = depsByObject[objectName] || [];
			const definition = options.definitions && options.definitions[objectName];
			return {
				recordset: deps,
				recordsets: [deps, definition ? [{ definition }] : []]
			};
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
		registerBuild(service, 'Db', p => reports.push(p));

		const { dependencies, failedKeys } = await service._analyzeDependencies('Db', [
			makeObject('dbo', 'T1', 'U'), makeObject('dbo', 'P1', 'P')
		]);

		assert.deepStrictEqual(dependencies, [{
			object_name: '[dbo].[P1]', dependency: 'dbo.T1', type: 'P', dependency_database: 'Db'
		}]);
		assert.strictEqual(failedKeys.size, 0, 'nothing failed, so nothing should be flagged incomplete');

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
		registerBuild(service, 'Db', p => reports.push(p));

		await service._analyzeDependencies('Db', objects);

		// 500 objects but at most ~101 distinct percentages should be posted
		assert.ok(reports.length <= 102, `expected throttled reports, got ${reports.length}`);
	});

	test('an object whose references cannot be resolved is skipped, not fatal', async () => {
		const service = new IndexService(makeMockCm(
			{ '[dbo].[P1]': [{ dependency: 'dbo.X', dependency_database: 'Db' }] },
			{ failFor: '[dbo].[Broken]' }
		), null);

		const { dependencies, failedKeys } = await service._analyzeDependencies('Db', [
			makeObject('dbo', 'Broken', 'V'), makeObject('dbo', 'P1', 'P')
		]);
		assert.strictEqual(dependencies.length, 1);
		assert.strictEqual(dependencies[0].object_name, '[dbo].[P1]');
		// The failed object is flagged so a later incremental update retries it
		// instead of trusting its empty dependency list forever (see IndexServices
		// ._updateIndexIncrementally and the "dependenciesIncomplete" tests below).
		assert.ok(failedKeys.has('dbo.Broken'), 'the object whose DMV call failed must be flagged for retry');
		assert.strictEqual(failedKeys.size, 1);
	});

	test('the table-level writes of a definition are collected', async () => {
		const service = new IndexService(makeMockCm(
			{ '[dbo].[P1]': [{ dependency: 'dbo.T1', dependency_database: 'Db' }] },
			{ definitions: { '[dbo].[P1]': 'DELETE FROM dbo.T1 WHERE Id = 1' } }
		), null);
		registerBuild(service, 'Db');

		const columnRefs = {};
		const tableWrites = {};
		await service._analyzeDependencies('Db', [makeObject('dbo', 'P1', 'P')], columnRefs, null, null, tableWrites);

		assert.deepStrictEqual(tableWrites['dbo.P1'], ['dbo.t1'], 'the deleted table is written');
		assert.strictEqual(
			columnRefs['dbo.P1']['dbo.t1'].id.write, false,
			'a DELETE writes the table but no column value'
		);
	});

	test('a definition that names no column still records its written table', async () => {
		const service = new IndexService(makeMockCm(
			{ '[dbo].[P1]': [{ dependency: 'dbo.T1', dependency_database: 'Db' }] },
			{ definitions: { '[dbo].[P1]': 'DELETE FROM dbo.T1' } }
		), null);
		registerBuild(service, 'Db');

		const columnRefs = {};
		const tableWrites = {};
		await service._analyzeDependencies('Db', [makeObject('dbo', 'P1', 'P')], columnRefs, null, null, tableWrites);

		assert.deepStrictEqual(tableWrites['dbo.P1'], ['dbo.t1']);
		assert.strictEqual(columnRefs['dbo.P1'], undefined, 'no column is named at all');
	});

	test('processes CONCURRENT_BATCH_SIZE objects at once instead of one at a time', async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const objects = [];
		for (let i = 0; i < 20; i++) objects.push(makeObject('dbo', `T${i}`, 'U'));

		const cm = {
			getServerName: () => 'testserver',
			executeQueryInDatabase: async () => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise(resolve => setTimeout(resolve, 5));
				inFlight--;
				return { recordset: [] };
			}
		};
		const service = new IndexService(cm, null);

		await service._analyzeDependencies('Db', objects);

		assert.strictEqual(maxInFlight, IndexService.CONCURRENT_BATCH_SIZE, 'batches should overlap in flight, not run one by one');
	});

	test('requestCancel stops the loop with an INDEXING_CANCELLED error', async () => {
		const objects = [];
		for (let i = 0; i < 10; i++) objects.push(makeObject('dbo', `T${i}`, 'U'));
		const cm = makeMockCm({});
		const service = new IndexService(cm, null);

		// Cancel as soon as the first progress report arrives
		registerBuild(service, 'Db', () => service.requestCancel('Db'));

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

	test('an entry flagged dependenciesIncomplete is re-analyzed even with an unchanged checksum', async () => {
		const service0 = new IndexService(makeMockCm({}), null);
		const objP1 = makeObject('dbo', 'P1', 'P');

		// Simulates a previous run where P1's dm_sql_referenced_entities call
		// failed (e.g. it references a table that didn't exist yet) - cached
		// with an empty dependency list and the incomplete flag set.
		const cachedIndex = {
			database: 'Db', lastFullIndex: 'x', schemaChecksum: 'old',
			objects: {
				'dbo.P1': { ...service0._makeIndexEntry(objP1), dependencies: [], dependenciesIncomplete: true }
			}
		};

		// Live state: P1 unchanged (same modify_date/checksum) - the table it
		// references now exists, so this run's DMV call succeeds.
		const cm = makeMockCm({ '[dbo].[P1]': [{ dependency: 'dbo.T1', dependency_database: 'Db' }] });
		const service = new IndexService(cm, null);

		const index = await service._updateIndexIncrementally('Db', cachedIndex, [objP1], 'new');

		assert.strictEqual(cm.calls(), 1, 'the flagged entry must be re-analyzed despite its checksum matching');
		assert.deepStrictEqual(index.objects['dbo.P1'].dependencies, ['dbo.T1']);
		assert.ok(!index.objects['dbo.P1'].dependenciesIncomplete, 'a successful re-analysis clears the flag');
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

// Mock ConnectionManager for the full getIndex/forceReindex path (unlike
// makeMockCm, also answers _getLiveObjects' paramless query). Each database's
// live-objects query blocks until release(database) is called, so two builds
// can be driven into a deterministic "both in flight" state without relying
// on timing.
function makeGatedCm(liveObjectsByDb) {
	const gates = new Map();
	const gateFor = (database) => {
		if (!gates.has(database)) {
			let resolve;
			const promise = new Promise(r => { resolve = r; });
			gates.set(database, { promise, resolve });
		}
		return gates.get(database);
	};
	return {
		getServerName: () => 'testserver',
		executeQueryInDatabase: async (database, query, params) => {
			if (!params) {
				await gateFor(database).promise;
				return { recordset: liveObjectsByDb[database] || [] };
			}
			return { recordset: [] };
		},
		release: (database) => gateFor(database).resolve()
	};
}

// The index files used to be named "<server>_<database>.json" in the index
// folder; they now live in a "<server>/<database>.json" subfolder. Without a
// migration every index written before the change became invisible at the
// update, and the extension silently rebuilt all of them.
suite('IndexService cache path migration', () => {
	let tempDir;

	async function exists(file) {
		try {
			await fs.access(file);
			return true;
		} catch {
			return false;
		}
	}

	setup(async () => {
		tempDir = path.join(os.tmpdir(), `sqlwayfarer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await fs.mkdir(tempDir, { recursive: true });
	});

	teardown(async () => {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	});

	function makeService() {
		const service = new IndexService(makeMockCm({}), null);
		service._indexDir = tempDir;
		return service;
	}

	test('an index cached under the old file name is moved to its new place', async () => {
		const service = makeService();

		const legacyFile = path.join(tempDir, 'testserver_Db.json');
		await fs.writeFile(legacyFile, JSON.stringify({ formatVersion: 3, database: 'Db' }), 'utf8');

		const indexFile = await service._migrateLegacyIndexFile('Db', 'testserver');

		assert.strictEqual(indexFile, path.join(tempDir, 'testserver', 'Db.json'));
		assert.ok(await exists(indexFile), 'the index should be at its new place');
		assert.ok(!await exists(legacyFile), 'the old file should be gone');
	});

	test('an index already at its new place is left alone', async () => {
		const service = makeService();

		const indexFile = path.join(tempDir, 'testserver', 'Db.json');
		await fs.mkdir(path.join(tempDir, 'testserver'), { recursive: true });
		await fs.writeFile(indexFile, JSON.stringify({ formatVersion: 3, database: 'Db' }), 'utf8');

		const result = await service._migrateLegacyIndexFile('Db', 'testserver');

		assert.strictEqual(result, indexFile);
		assert.ok(await exists(indexFile));
	});

	test('nothing to migrate is not an error', async () => {
		const service = makeService();

		const indexFile = await service._migrateLegacyIndexFile('Db', 'testserver');

		assert.strictEqual(indexFile, path.join(tempDir, 'testserver', 'Db.json'));
		assert.ok(!await exists(indexFile));
	});

	test('clearing the index removes the old file too', async () => {
		const service = makeService();

		const legacyFile = path.join(tempDir, 'testserver_Db.json');
		await fs.writeFile(legacyFile, JSON.stringify({ formatVersion: 3, database: 'Db' }), 'utf8');

		await service.clearIndex('Db');

		assert.ok(!await exists(legacyFile), 'the old file should be gone, not migrated back later');
	});
});

suite('IndexService concurrency', () => {
	let tempDir;

	setup(() => {
		tempDir = path.join(os.tmpdir(), `sqlwayfarer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	});

	teardown(async () => {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	});

	test('concurrent getIndex builds for different databases do not cross-contaminate progress', async () => {
		const objectsA = [makeObject('dbo', 'T1', 'U'), makeObject('dbo', 'T2', 'U'), makeObject('dbo', 'T3', 'U')];
		const objectsB = [makeObject('dbo', 'X1', 'U')];
		const cm = makeGatedCm({ A: objectsA, B: objectsB });
		const service = new IndexService(cm, null);
		service._indexDir = tempDir;

		const reportsA = [];
		const reportsB = [];
		const promiseA = service.getIndex('A', p => reportsA.push(p));
		const promiseB = service.getIndex('B', p => reportsB.push(p));

		cm.release('B');
		cm.release('A');
		await Promise.all([promiseA, promiseB]);

		assert.ok(reportsA.length > 0, 'A should have received progress reports');
		assert.ok(reportsB.length > 0, 'B should have received progress reports');
		assert.ok(reportsA.every(r => r.total === objectsA.length), "A's reports must only ever show A's own object count");
		assert.ok(reportsB.every(r => r.total === objectsB.length), "B's reports must only ever show B's own object count");
	});

	test('forceReindex joins an in-flight forced build instead of restarting it', async () => {
		const objectsA = [makeObject('dbo', 'T1', 'U')];
		const cm = makeGatedCm({ A: objectsA });
		let liveObjectsCalls = 0;
		const baseExec = cm.executeQueryInDatabase;
		cm.executeQueryInDatabase = async (database, query, params) => {
			if (!params) liveObjectsCalls++;
			return baseExec(database, query, params);
		};
		const service = new IndexService(cm, null);
		service._indexDir = tempDir;

		const promise1 = service.forceReindex('A', () => {});
		const promise2 = service.forceReindex('A', () => {});

		cm.release('A');
		await Promise.all([promise1, promise2]);

		assert.strictEqual(liveObjectsCalls, 1, 'a second forceReindex for the same in-flight database must join it, not start a duplicate rebuild');
	});

	test('getIndex joining an in-flight forceReindex reports progress to both subscribers', async () => {
		const objectsA = [makeObject('dbo', 'T1', 'U'), makeObject('dbo', 'T2', 'U')];
		const cm = makeGatedCm({ A: objectsA });
		const service = new IndexService(cm, null);
		service._indexDir = tempDir;

		const reportsForce = [];
		const reportsJoin = [];
		const forcePromise = service.forceReindex('A', p => reportsForce.push(p));
		const joinPromise = service.getIndex('A', p => reportsJoin.push(p));

		cm.release('A');
		await Promise.all([forcePromise, joinPromise]);

		assert.ok(reportsForce.length > 0, 'the original forceReindex caller must still see progress');
		assert.ok(reportsJoin.length > 0, "a joiner's callback must not be silently dropped");
		assert.deepStrictEqual(reportsJoin, reportsForce, 'both subscribers see the same progress stream');
	});

	test('requestCancel only affects the targeted database', async () => {
		const objectsA = [makeObject('dbo', 'T1', 'U'), makeObject('dbo', 'T2', 'U')];
		const objectsB = [makeObject('dbo', 'X1', 'U'), makeObject('dbo', 'X2', 'U')];
		const cm = makeGatedCm({ A: objectsA, B: objectsB });
		const service = new IndexService(cm, null);
		service._indexDir = tempDir;

		const promiseA = service.getIndex('A', () => {});
		const promiseB = service.getIndex('B', () => {});

		service.requestCancel('A');
		cm.release('A');
		cm.release('B');

		await assert.rejects(() => promiseA, err => err.code === 'INDEXING_CANCELLED');
		await assert.doesNotReject(() => promiseB);
	});
});
