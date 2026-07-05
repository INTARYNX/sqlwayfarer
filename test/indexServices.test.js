const assert = require('assert');
const IndexService = require('../database/IndexServices');

// Mocked ConnectionManager: first call returns the object list, then one
// dependency recordset per object (or an error to test tolerance).
function makeMockCm(objectRows, depsByObject, options = {}) {
	let calls = 0;
	return {
		calls: () => calls,
		getServerName: () => 'testserver',
		executeQueryInDatabase: async (database, query, params) => {
			calls++;
			if (calls === 1) return { recordset: objectRows };
			const objectName = params.objectName;
			if (options.failFor && objectName === options.failFor) {
				throw new Error('Could not resolve references');
			}
			return { recordset: depsByObject[objectName] || [] };
		}
	};
}

function makeObjectRow(schema, name, type) {
	return {
		object_id: 1, name, schema_name: schema, qualified_name: `${schema}.${name}`,
		type, type_desc: type, create_date: null, modify_date: null, database_name: 'Db'
	};
}

suite('IndexService dependency indexing', () => {
	test('collects per-object dependencies and reports progress from 0 to 100', async () => {
		const service = new IndexService(makeMockCm(
			[makeObjectRow('dbo', 'T1', 'U'), makeObjectRow('dbo', 'P1', 'P')],
			{ '[dbo].[P1]': [{ dependency: 'dbo.T1', dependency_database: 'Db' }] }
		), null);

		const reports = [];
		service._progressCallback = p => reports.push(p);

		const result = await service._getObjectsAndDependencies('Db');

		assert.strictEqual(result.objects.length, 2);
		assert.deepStrictEqual(result.dependencies, [{
			object_name: '[dbo].[P1]', dependency: 'dbo.T1', type: 'P', dependency_database: 'Db'
		}]);

		assert.strictEqual(reports[0].progress, 0);
		assert.strictEqual(reports[reports.length - 1].progress, 100);
		assert.strictEqual(reports[reports.length - 1].current, 2);
		assert.ok(reports.some(r => r.message === 'dbo.P1'), 'progress message carries the object name');
	});

	test('throttles progress reports to whole-percent changes', async () => {
		const objectRows = [];
		for (let i = 0; i < 500; i++) objectRows.push(makeObjectRow('dbo', `T${i}`, 'U'));
		const service = new IndexService(makeMockCm(objectRows, {}), null);

		const reports = [];
		service._progressCallback = p => reports.push(p);

		await service._getObjectsAndDependencies('Db');

		// 500 objects but at most ~101 distinct percentages should be posted
		assert.ok(reports.length <= 102, `expected throttled reports, got ${reports.length}`);
	});

	test('an object whose references cannot be resolved is skipped, not fatal', async () => {
		const service = new IndexService(makeMockCm(
			[makeObjectRow('dbo', 'Broken', 'V'), makeObjectRow('dbo', 'P1', 'P')],
			{ '[dbo].[P1]': [{ dependency: 'dbo.X', dependency_database: 'Db' }] },
			{ failFor: '[dbo].[Broken]' }
		), null);

		const result = await service._getObjectsAndDependencies('Db');
		assert.strictEqual(result.dependencies.length, 1);
		assert.strictEqual(result.dependencies[0].object_name, '[dbo].[P1]');
	});

	test('requestCancel stops the loop with an INDEXING_CANCELLED error', async () => {
		const objectRows = [];
		for (let i = 0; i < 10; i++) objectRows.push(makeObjectRow('dbo', `T${i}`, 'U'));
		const cm = makeMockCm(objectRows, {});
		const service = new IndexService(cm, null);

		// Cancel as soon as the first progress report arrives
		service._progressCallback = () => service.requestCancel();

		await assert.rejects(
			() => service._getObjectsAndDependencies('Db'),
			err => err.code === 'INDEXING_CANCELLED'
		);
		assert.ok(cm.calls() < 11, 'loop must stop early instead of processing every object');
	});
});
