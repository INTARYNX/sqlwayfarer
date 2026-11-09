const assert = require('assert');
const { classifyTarget, applyScript, idOf } = require('../database/migrationApply');

const diffOf = (...ids) => ({ changes: ids.map(id => { const [kind, name] = id.split(/:(.*)/s); return { kind, name }; }) });

suite('migrationApply.classifyTarget', () => {
	test('done where the target is as the current state, pending where it is as the reference, differs for the rest', () => {
		const ids = ['table:dbo.A', 'table:dbo.B', 'table:dbo.C', 'view:dbo.v'];
		// The target still needs B and C and v to be as the current state; it differs from the reference on C.
		const result = classifyTarget(ids, diffOf('table:dbo.C'), diffOf('table:dbo.B', 'table:dbo.C', 'view:dbo.v'));
		assert.deepStrictEqual(result, { done: ['table:dbo.A'], pending: ['table:dbo.B', 'view:dbo.v'], differs: ['table:dbo.C'] });
	});

	test('only the changes that are picked count', () => {
		const result = classifyTarget(['table:dbo.A'], diffOf('table:dbo.Z'), diffOf('table:dbo.Z', 'table:dbo.A'));
		assert.deepStrictEqual(result, { done: [], pending: ['table:dbo.A'], differs: [] });
	});

	test('nothing picked, nothing said', () => {
		assert.deepStrictEqual(classifyTarget([], diffOf(), diffOf()), { done: [], pending: [], differs: [] });
		assert.strictEqual(idOf({ kind: 'table', name: 'dbo.T' }), 'table:dbo.T');
	});
});

suite('migrationApply.applyScript', () => {
	function manager(log, failing = []) {
		return {
			acquireConnection: async () => ({
				createRequest: () => ({ batch: async sql => { log.push(sql); if (failing.some(f => sql.includes(f))) throw new Error(`failed: ${sql.slice(0, 20)}`); return { recordsets: [] }; } }),
				release: () => log.push('release')
			})
		};
	}
	const SCRIPT = 'SELECT 1;\nGO\nSELECT 2;\nGO\nSELECT 3;';

	test('every batch runs, in order, in the database, and the connection goes back to master', async () => {
		const log = [];
		const progress = [];
		const result = await applyScript(manager(log), 'My]Db', SCRIPT, { onProgress: (done, total) => progress.push(`${done}/${total}`) });
		assert.deepStrictEqual(log.slice(0, 4), ['USE [My]]Db]', 'SELECT 1;\n', 'SELECT 2;\n', 'SELECT 3;']);
		// What the script may have left in the pooled connection is cleared, and it goes back to master.
		assert.ok(log[4].includes('SET ANSI_NULLS ON') && log[4].includes('SET QUOTED_IDENTIFIER ON') && log[4].includes('USE [master]'));
		assert.strictEqual(log[5], 'release');
		assert.deepStrictEqual(progress, ['1/3', '2/3', '3/3']);
		assert.deepStrictEqual([result.batches, result.ran, result.errors, result.stopped], [3, 3, [], false]);
	});

	test('a batch that fails is reported with its number and line, and the next ones do not run', async () => {
		const log = [];
		const result = await applyScript(manager(log, ['SELECT 2']), 'Db', SCRIPT);
		assert.deepStrictEqual(result.errors.map(e => [e.batch, e.line]), [[2, 3]]);
		assert.ok(!log.includes('SELECT 3;'));
		assert.strictEqual(result.ran, 2);
	});

	test('it can be stopped between batches, and still puts the connection back', async () => {
		const log = [];
		let asked = 0;
		const result = await applyScript(manager(log), 'Db', SCRIPT, { shouldStop: () => asked++ >= 1 });
		assert.deepStrictEqual([result.ran, result.stopped], [1, true]);
		assert.ok(log.some(l => l.includes('USE [master]')) && log.includes('release'));
	});

	test('a connection that is gone does not hide the result', async () => {
		const log = [];
		const result = await applyScript({ acquireConnection: async () => ({ createRequest: () => ({ batch: async sql => { if (sql.startsWith('SET ANSI_NULLS')) throw new Error('gone'); return {}; } }), release: () => log.push('release') }) }, 'Db', SCRIPT);
		assert.strictEqual(result.ran, 3);
		assert.deepStrictEqual(log, ['release']);
	});
});
