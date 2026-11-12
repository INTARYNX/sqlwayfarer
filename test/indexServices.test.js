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

		assert.deepStrictEqual(tableWrites['dbo.P1'].tables, ['dbo.t1'], 'the deleted table is written');
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

		assert.deepStrictEqual(tableWrites['dbo.P1'].tables, ['dbo.t1']);
		assert.strictEqual(columnRefs['dbo.P1'], undefined, 'no column is named at all');
	});

	test('the syntax errors of a definition are collected', async () => {
		const service = new IndexService(makeMockCm(
			{ '[dbo].[P1]': [{ dependency: 'dbo.T1', dependency_database: 'Db' }] },
			{ definitions: { '[dbo].[P1]': 'DELETE FROM dbo.T1 WHERE' } }
		), null);
		registerBuild(service, 'Db');

		const parseErrors = {};
		await service._analyzeDependencies('Db', [makeObject('dbo', 'P1', 'P')], {}, null, null, null, parseErrors);

		assert.ok(parseErrors['dbo.P1'] && parseErrors['dbo.P1'].length > 0, 'the syntax error is recorded');
	});

	test('a definition that parses cleanly records no error', async () => {
		const service = new IndexService(makeMockCm(
			{ '[dbo].[P1]': [{ dependency: 'dbo.T1', dependency_database: 'Db' }] },
			{ definitions: { '[dbo].[P1]': 'DELETE FROM dbo.T1 WHERE Id = 1' } }
		), null);
		registerBuild(service, 'Db');

		const parseErrors = {};
		await service._analyzeDependencies('Db', [makeObject('dbo', 'P1', 'P')], {}, null, null, null, parseErrors);

		assert.deepStrictEqual(parseErrors['dbo.P1'], undefined, 'no error is recorded');
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

// The index is built when the user asks for it, never as a side effect of
// reading something that could use it.
suite('IndexService never builds on its own', () => {
	const DependencyService = require('../database/DependencyService');
	let tempDir;
	let queries;

	setup(async () => {
		tempDir = path.join(os.tmpdir(), `sqlwayfarer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await fs.mkdir(tempDir, { recursive: true });
		queries = 0;
	});

	teardown(async () => {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	});

	// A connection manager that counts every query, listing `objects` for the schema query.
	function makeService(objects) {
		const cm = {
			getServerName: () => 'testserver',
			executeQueryInDatabase: async () => {
				queries++;
				return { recordset: objects, recordsets: [objects, []] };
			}
		};
		const service = new IndexService(cm, null);
		service._indexDir = tempDir;
		return service;
	}

	const objectsV1 = [makeObject('dbo', 'T1', 'U'), makeObject('dbo', 'V1', 'V')];

	test('peekIndex finds nothing and runs no query when no index was built', async () => {
		const service = makeService(objectsV1);
		assert.strictEqual(await service.peekIndex('Db'), null);
		assert.strictEqual(queries, 0);
		assert.strictEqual(service.isBuildInProgress('Db'), false);
	});

	test('the features that read the index leave it unbuilt and run no query', async () => {
		const service = makeService(objectsV1);
		const dependencies = new DependencyService({ executeQueryInDatabase: async () => { queries++; return { recordset: [] }; } }, null);
		dependencies.setIndexService(service);
		assert.deepStrictEqual(await dependencies.getDependencies('Db', 'dbo.V1'), { dependsOn: [], referencedBy: [] });
		assert.deepStrictEqual(await dependencies.getDependencyTree('Db', 'dbo.V1'), { name: 'dbo.V1', dependencies: [] });
		assert.strictEqual(await service.getColumnUsage('Db', 'dbo.T1'), null);
		assert.deepStrictEqual(await service.getObjectDependencies('Db', 'dbo.V1'), []);
		assert.deepStrictEqual(await service.findDependents('Db', 'dbo.T1'), []);
		await assert.rejects(() => service.requireIndex('Db'), error => error.code === 'INDEX_NOT_BUILT' && /Build index/.test(error.message));
		assert.strictEqual(queries, 0);
		assert.strictEqual(service.isBuildInProgress('Db'), false);
	});

	test('the status says none, then ready once the user built it, then stale after a schema change', async () => {
		let objects = objectsV1;
		const service = makeService(objects);
		service._connectionManager.executeQueryInDatabase = async () => ({ recordset: objects, recordsets: [[], []] });
		assert.deepStrictEqual(await service.getIndexStatus('Db'), { state: 'none' });

		await service.getIndex('Db'); // the user's "Build index"
		const ready = await service.getIndexStatus('Db');
		assert.strictEqual(ready.state, 'ready');
		assert.strictEqual(ready.totalObjects, 2);
		assert.ok(ready.builtAt);
		assert.ok(await service.peekIndex('Db'));

		objects = [...objectsV1, makeObject('dbo', 'T2', 'U')];
		assert.strictEqual((await service.getIndexStatus('Db')).state, 'stale');
		// ...and looking at it did not update it.
		assert.strictEqual((await service.peekIndex('Db')).totalObjects, 2);
	});

	test('the status is "building" while the user\'s build runs, and peek waits for it', async () => {
		let release;
		const gate = new Promise(resolve => { release = resolve; });
		const service = makeService(objectsV1);
		service._connectionManager.executeQueryInDatabase = async () => { await gate; return { recordset: objectsV1, recordsets: [[], []] }; };
		const build = service.getIndex('Db');
		assert.deepStrictEqual(await service.getIndexStatus('Db'), { state: 'building' });
		const peeked = service.peekIndex('Db');
		release();
		await build;
		assert.strictEqual((await peeked).totalObjects, 2);
	});

	test('a cancelled build leaves nothing behind for peek', async () => {
		const service = makeService(objectsV1);
		service._connectionManager.executeQueryInDatabase = async () => { throw Object.assign(new Error('cancelled'), { code: 'INDEXING_CANCELLED' }); };
		await assert.rejects(() => service.getIndex('Db'));
		assert.strictEqual(await service.peekIndex('Db'), null);
	});

	test('an index in an older format counts as not built', async () => {
		const service = makeService(objectsV1);
		const file = service._getIndexFilePath('Db', 'testserver');
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, JSON.stringify({ database: 'Db', formatVersion: 1, objects: {} }));
		assert.strictEqual(await service.peekIndex('Db'), null);
		assert.deepStrictEqual(await service.getIndexStatus('Db'), { state: 'none' });
	});

	test('a force reindex that fails leaves the index that was there', async () => {
		const service = makeService(objectsV1);
		service._connectionManager.executeQueryInDatabase = async () => ({ recordset: objectsV1, recordsets: [[], []] });
		await service.getIndex('Db');
		const file = service._getIndexFilePath('Db', 'testserver');
		const before = await fs.readFile(file, 'utf8');
		service._connectionManager.executeQueryInDatabase = async () => { throw new Error('server gone'); };

		await assert.rejects(service.forceReindex('Db'), /server gone/);

		assert.strictEqual(await fs.readFile(file, 'utf8'), before);
		assert.strictEqual((await service.peekIndex('Db')).totalObjects, 2);
	});

	test('a force reindex cancelled on the way leaves the index that was there', async () => {
		let release;
		const gate = new Promise(resolve => { release = resolve; });
		const service = makeService(objectsV1);
		service._connectionManager.executeQueryInDatabase = async () => ({ recordset: objectsV1, recordsets: [[], []] });
		await service.getIndex('Db');
		const file = service._getIndexFilePath('Db', 'testserver');
		const before = await fs.readFile(file, 'utf8');
		service._connectionManager.executeQueryInDatabase = async () => { await gate; return { recordset: objectsV1, recordsets: [[], []] }; };

		const rebuild = service.forceReindex('Db');
		service.requestCancel('Db');
		release();

		await assert.rejects(rebuild, error => error.code === 'INDEXING_CANCELLED');
		assert.strictEqual(await fs.readFile(file, 'utf8'), before);
	});

	test('force reindex clears what peek had remembered', async () => {
		const service = makeService(objectsV1);
		service._connectionManager.executeQueryInDatabase = async () => ({ recordset: objectsV1, recordsets: [[], []] });
		await service.getIndex('Db');
		const first = await service.peekIndex('Db');
		await service.forceReindex('Db');
		assert.notStrictEqual(await service.peekIndex('Db'), first);
	});
});

suite('IndexService.diffAgainstSchema', () => {
	const service = new IndexService({ getServerName: () => 'testserver' }, {});
	const live = (name, modifyDate, type = 'V') => ({ qualified_name: name, type, modify_date: modifyDate });
	const cachedFor = (obj, extra = {}) => Object.assign({ checksum: service._entryChecksum(obj) }, extra);

	test('lists the modified, new and removed objects', () => {
		const a = live('dbo.A', '1'); const b = live('dbo.B', '1'); const c = live('dbo.C', '1');
		const cached = { 'dbo.A': cachedFor(a), 'dbo.B': cachedFor(live('dbo.B', '0')), 'dbo.Gone': cachedFor(live('dbo.Gone', '1')) };
		assert.deepStrictEqual(service.diffAgainstSchema(cached, [a, b, c]), { modified: ['dbo.B'], added: ['dbo.C'], removed: ['dbo.Gone'] });
	});

	test('nothing to re-analyze when the schema matches', () => {
		const a = live('dbo.A', '1');
		assert.deepStrictEqual(service.diffAgainstSchema({ 'dbo.A': cachedFor(a) }, [a]), { modified: [], added: [], removed: [] });
	});

	test('an entry whose last analysis was incomplete counts as modified', () => {
		const a = live('dbo.A', '1');
		assert.deepStrictEqual(service.diffAgainstSchema({ 'dbo.A': cachedFor(a, { dependenciesIncomplete: true }) }, [a]).modified, ['dbo.A']);
	});

	test('brackets in the live names are ignored', () => {
		const a = live('[dbo].[A]', '1');
		assert.deepStrictEqual(service.diffAgainstSchema({ 'dbo.A': cachedFor(a) }, [a]), { modified: [], added: [], removed: [] });
	});
});

suite('IndexService checksums do not depend on the time zone', () => {
	const service = new IndexService({ getServerName: () => 'testserver' }, {});
	const object = modifyDate => ({ object_id: 1, qualified_name: 'dbo.T', type: 'U', modify_date: modifyDate });
	// On Windows, deleting TZ leaves the process in UTC instead of the system
	// zone, which shifts the dates of the suites that run after this one. The
	// zone is put back by name, not by deleting the variable.
	const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const inZone = (zone, fn) => {
		const before = process.env.TZ;
		process.env.TZ = zone;
		try { return fn(); } finally { process.env.TZ = before === undefined ? systemZone : before; }
	};

	test('the same date gives the same checksums in Paris and in UTC', () => {
		const date = new Date('2026-11-03T10:20:30.123Z');
		const paris = inZone('Europe/Paris', () => [service._checksumFromObjects([object(date)]), service._entryChecksum(object(date))]);
		const utc = inZone('UTC', () => [service._checksumFromObjects([object(date)]), service._entryChecksum(object(date))]);
		assert.deepStrictEqual(paris, utc);
	});

	test('two modifications within one second are told apart', () => {
		const a = service._entryChecksum(object(new Date('2026-11-03T10:20:30.100Z')));
		const b = service._entryChecksum(object(new Date('2026-11-03T10:20:30.900Z')));
		assert.notStrictEqual(a, b);
	});

	test('a date given as text is used as it is', () => {
		assert.strictEqual(service._entryChecksum(object('1')), service._entryChecksum(object('1')));
		assert.notStrictEqual(service._entryChecksum(object('1')), service._entryChecksum(object('2')));
	});
});

suite('IndexService: a table is not stale because of its maintenance', () => {
	const service = new IndexService({ getServerName: () => 'testserver' }, {});
	// A rebuilt index or a new foreign key moves the modify_date of a table, not its signature.
	const table = (modifyDate, signature) => ({ object_id: 1, qualified_name: 'dbo.T', type: 'U', modify_date: modifyDate, table_signature: signature });

	test('a new modify_date with the same signature is not a change', () => {
		assert.strictEqual(service._entryChecksum(table('2026-01-01', 7)), service._entryChecksum(table('2026-02-02', 7)));
		assert.strictEqual(service._checksumFromObjects([table('2026-01-01', 7)]), service._checksumFromObjects([table('2026-02-02', 7)]));
	});

	test('a new signature is a change', () => {
		assert.notStrictEqual(service._entryChecksum(table('2026-01-01', 7)), service._entryChecksum(table('2026-01-01', 8)));
		assert.notStrictEqual(service._checksumFromObjects([table('2026-01-01', 0)]), service._checksumFromObjects([table('2026-01-01', 8)]));
	});

	test('a view or a procedure still goes by its modify_date', () => {
		const view = modifyDate => ({ object_id: 2, qualified_name: 'dbo.V', type: 'V', modify_date: modifyDate, table_signature: null });
		assert.notStrictEqual(service._entryChecksum(view('2026-01-01')), service._entryChecksum(view('2026-02-02')));
	});

	test('a table without a signature goes by its modify_date', () => {
		assert.notStrictEqual(service._entryChecksum(table('2026-01-01', undefined)), service._entryChecksum(table('2026-02-02', undefined)));
	});
});

// A date that moves with no change of the text is not a change: the text of the
// module is the second control, read only for the modules whose date moved.
suite('IndexService: a modified date is confirmed by the text of the module', () => {
	let tempDir;
	let analyses;
	let textReads;

	setup(async () => {
		tempDir = path.join(os.tmpdir(), `sqlwayfarer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await fs.mkdir(tempDir, { recursive: true });
		analyses = 0;
		textReads = 0;
	});

	teardown(async () => {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	});

	// The server as the service sees it: `state.objects` is the schema, `state.text` the text of each module.
	function makeService(state) {
		const cm = {
			getServerName: () => 'testserver',
			executeQueryInDatabase: async (database, query, params) => {
				if (params) {
					analyses++;
					const text = state.text[params.objectName.replace(/[[\]]/g, '')];
					return { recordset: [], recordsets: [[], text ? [{ definition: text }] : []] };
				}
				if (query.includes('sys.sql_modules')) {
					textReads++;
					return { recordset: state.objects.filter(o => state.text[o.qualified_name] !== undefined).map(o => ({ object_id: o.object_id, definition: state.text[o.qualified_name] })) };
				}
				return { recordset: state.objects };
			}
		};
		const service = new IndexService(cm, { analyzeDefinition: async () => ({ columns: {}, writes: [], errors: [] }) });
		service._indexDir = tempDir;
		return service;
	}

	const touch = (state, name, date) => { state.objects = state.objects.map(o => o.qualified_name === name ? { ...o, modify_date: date } : o); };

	test('a date that moved alone leaves the index ready, and an update analyzes nothing', async () => {
		const state = { objects: [makeObject('dbo', 'T', 'U'), makeObject('dbo', 'P', 'P')], text: { 'dbo.P': 'SELECT 1' } };
		const service = makeService(state);
		await service.getIndex('Db');
		assert.strictEqual((await service.getIndexStatus('Db')).state, 'ready');
		assert.strictEqual(textReads, 0, 'nothing is read while the dates are the same');

		touch(state, 'dbo.P', '2026-09-09');
		const status = await service.getIndexStatus('Db');
		assert.strictEqual(status.state, 'ready');
		assert.strictEqual(textReads, 1);

		analyses = 0;
		await service.getIndex('Db'); // the user's "Update index"
		assert.strictEqual(analyses, 0, 'the procedure is not analyzed again');
		const entry = (await service.peekIndex('Db')).objects['dbo.P'];
		assert.strictEqual(entry.modifyDate, '2026-09-09');
		textReads = 0;
		assert.strictEqual((await service.getIndexStatus('Db')).state, 'ready');
		assert.strictEqual(textReads, 0, 'the index caught up with the date: no text to read any more');
	});

	test('a change of the text is stale, and the update analyzes that module only', async () => {
		const state = { objects: [makeObject('dbo', 'P', 'P'), makeObject('dbo', 'Q', 'P')], text: { 'dbo.P': 'SELECT 1', 'dbo.Q': 'SELECT 2' } };
		const service = makeService(state);
		await service.getIndex('Db');

		touch(state, 'dbo.P', '2026-09-09');
		touch(state, 'dbo.Q', '2026-09-09');
		state.text['dbo.P'] = 'SELECT 3';
		const status = await service.getIndexStatus('Db');
		assert.strictEqual(status.state, 'stale');
		assert.deepStrictEqual(status.changes.modified, ['dbo.P']);

		analyses = 0;
		await service.getIndex('Db');
		assert.strictEqual(analyses, 1);
		assert.strictEqual((await service.getIndexStatus('Db')).state, 'ready');
	});

	test('a new or dropped module is a change whatever the text', async () => {
		const state = { objects: [makeObject('dbo', 'P', 'P')], text: { 'dbo.P': 'SELECT 1' } };
		const service = makeService(state);
		await service.getIndex('Db');
		state.objects = [...state.objects, makeObject('dbo', 'Q', 'P')];
		state.text['dbo.Q'] = 'SELECT 2';
		assert.strictEqual((await service.getIndexStatus('Db')).state, 'stale');
		state.objects = [];
		assert.strictEqual((await service.getIndexStatus('Db')).state, 'stale');
	});

	test('an index with no hash of the text (an older one) counts the moved date as a change', async () => {
		const state = { objects: [makeObject('dbo', 'P', 'P')], text: { 'dbo.P': 'SELECT 1' } };
		const service = makeService(state);
		await service.getIndex('Db');
		const index = await service.peekIndex('Db');
		delete index.objects['dbo.P'].definitionHash;
		touch(state, 'dbo.P', '2026-09-09');
		assert.strictEqual((await service.getIndexStatus('Db')).state, 'stale');
	});

	test('a failed read of the text keeps the module as modified', async () => {
		const state = { objects: [makeObject('dbo', 'P', 'P')], text: { 'dbo.P': 'SELECT 1' } };
		const service = makeService(state);
		await service.getIndex('Db');
		touch(state, 'dbo.P', '2026-09-09');
		const execute = service._connectionManager.executeQueryInDatabase;
		service._connectionManager.executeQueryInDatabase = async (db, query, params) => {
			if (!params && query.includes('sys.sql_modules')) throw new Error('permission denied');
			return execute(db, query, params);
		};
		assert.strictEqual((await service.getIndexStatus('Db')).state, 'stale');
	});
});

suite('IndexService: the index file stays where it belongs', () => {
	let tempDir;

	setup(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlwayfarer-index-'));
	});

	teardown(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	function makeService() {
		const service = new IndexService(makeMockCm({}), null);
		service._indexDir = tempDir;
		return service;
	}

	test('a server named ".." cannot write the index outside the cache folder', () => {
		const service = makeService();
		const file = service._getIndexFilePath('Db', '..');
		assert.strictEqual(path.dirname(path.dirname(file)), tempDir, 'the index must stay in the cache folder');
		assert.ok(path.resolve(file).startsWith(path.resolve(tempDir) + path.sep), 'the index must not climb out of the cache folder');
	});

	test('a database named ".." cannot either', () => {
		const service = makeService();
		const file = service._getIndexFilePath('..', 'testserver');
		assert.strictEqual(path.dirname(file), path.join(tempDir, 'testserver'));
		assert.strictEqual(path.basename(file), '_.json');
	});

	test('the index is written atomically: no half-written file is left behind', async () => {
		const service = makeService();
		const file = service._getIndexFilePath('Db', 'testserver');
		await fs.mkdir(path.dirname(file), { recursive: true });

		await service._saveIndex(file, { database: 'Db', formatVersion: 8, objects: { a: {} } });

		assert.deepStrictEqual(JSON.parse(await fs.readFile(file, 'utf8')).objects, { a: {} });
		const leftovers = (await fs.readdir(path.dirname(file))).filter(name => name.includes('.tmp'));
		assert.deepStrictEqual(leftovers, [], 'no temporary file must survive the write');
	});

	// Two writes of the same file at the same time must not write the same
	// temporary file: the second one would overwrite the first one's, and one
	// of the renames would fail - or the file would keep the wrong content.
	test('two writes of the same index at the same time do not step on each other', async () => {
		const service = makeService();
		const file = service._getIndexFilePath('Db', 'testserver');
		await fs.mkdir(path.dirname(file), { recursive: true });

		// The rename of a write waits for the temporary files of both writes
		// to be there: that is the moment the two writes collide.
		const realWrite = fs.writeFile;
		const realRename = fs.rename;
		let written = 0;
		let release;
		const bothWritten = new Promise(resolve => { release = resolve; });
		fs.writeFile = async (target, ...rest) => {
			const done = realWrite(target, ...rest);
			written += 1;
			if (written === 2) release();
			return done;
		};
		fs.rename = async (from, to) => {
			await bothWritten;
			return realRename(from, to);
		};
		try {
			await Promise.all([
				service._saveIndex(file, { database: 'Db', formatVersion: 8, objects: { a: {} } }),
				service._saveIndex(file, { database: 'Db', formatVersion: 8, objects: { b: {} } })
			]);
		} finally {
			fs.writeFile = realWrite;
			fs.rename = realRename;
		}

		const saved = JSON.parse(await fs.readFile(file, 'utf8'));
		assert.ok(saved.objects.a || saved.objects.b, 'one of the two writes is the file that is kept');
		const leftovers = (await fs.readdir(path.dirname(file))).filter(name => name.includes('.tmp'));
		assert.deepStrictEqual(leftovers, [], 'no temporary file must survive the writes');
	});
});

// The scan of the text for names that may be dynamic SQL: what is in a comment is
// not code, what is in a string may be.
suite('IndexService._scanPossibleRefs', () => {
	const names = new Map([['dbo.auditlog', 'dbo.AuditLog'], ['dbo.stock', 'dbo.Stock']]);
	const scan = text => IndexService.prototype._scanPossibleRefs(text, names, 'dbo.self', new Set());

	test('finds a name written in a string, the place dynamic SQL lives', () => {
		assert.deepStrictEqual(scan("EXEC sp_executesql N'DELETE FROM dbo.AuditLog'"), ['dbo.AuditLog']);
	});

	test('ignores a name in a line comment or a block comment', () => {
		assert.deepStrictEqual(scan('SELECT 1; -- DELETE FROM dbo.AuditLog'), []);
		assert.deepStrictEqual(scan('SELECT 1; /* UPDATE dbo.Stock SET OnHand = 0 */'), []);
	});

	test('a double dash inside a string is not a comment', () => {
		assert.deepStrictEqual(scan("EXEC('DELETE FROM dbo.AuditLog -- older than 30 days')"), ['dbo.AuditLog']);
		assert.deepStrictEqual(scan("SELECT '--'; EXEC('UPDATE dbo.Stock SET OnHand = 0')"), ['dbo.Stock']);
	});
});
