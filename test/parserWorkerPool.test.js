const assert = require('assert');
const ParserWorkerPool = require('../database/ParserWorkerPool');
const IndexService = require('../database/IndexServices');

const UPDATE_WIDGET = 'UPDATE dbo.Widget SET Flag = 1 WHERE Id = 5';
const DELETE_WIDGET = 'DELETE FROM dbo.Widget WHERE Id = 5';

suite('ParserWorkerPool', () => {
	let pool;

	teardown(async () => {
		if (pool) await pool.dispose();
	});

	test('analyzeDefinition via a real worker thread matches BabelfishSqlParser directly', async function () {
		this.timeout(15000); // first worker spawn can be slow in CI
		pool = new ParserWorkerPool();

		const analysis = await pool.analyzeDefinition(UPDATE_WIDGET);

		assert.ok(analysis, 'expected an analysis for a simple UPDATE');
		assert.strictEqual(analysis.columns['dbo.widget'].flag.write, true);
		assert.strictEqual(analysis.columns['dbo.widget'].id.write, false);
		assert.deepStrictEqual(analysis.writes, ['dbo.widget']);
	});

	test('the worker returns the table-level writes of a DELETE', async function () {
		this.timeout(15000);
		pool = new ParserWorkerPool();

		const analysis = await pool.analyzeDefinition(DELETE_WIDGET);

		assert.ok(analysis, 'expected an analysis for a DELETE');
		assert.deepStrictEqual(analysis.writes, ['dbo.widget'], 'a DELETE writes the table');
		assert.strictEqual(
			analysis.columns['dbo.widget'].id.write, false,
			'a DELETE writes no column value'
		);
	});

	test('falls back to in-process parsing when the pool cannot be created', async () => {
		pool = new ParserWorkerPool();
		// Simulate workers failing to spawn (e.g. a sandboxed environment).
		pool._ensurePool = () => null;

		const analysis = await pool.analyzeDefinition(UPDATE_WIDGET);

		assert.ok(analysis, 'in-process fallback must still return a real parse result');
		assert.strictEqual(analysis.columns['dbo.widget'].flag.write, true);
		assert.deepStrictEqual(analysis.writes, ['dbo.widget']);
	});

	test('disables the pool after repeated failures instead of retrying forever', async function () {
		this.timeout(15000);
		pool = new ParserWorkerPool();

		// Spawn the real pool, then make every run() call fail from here on -
		// simulates a worker that keeps crashing rather than one that never spawned.
		pool._ensurePool();
		pool._piscina.run = async () => { throw new Error('simulated worker crash'); };

		const threshold = ParserWorkerPool.MAX_CONSECUTIVE_FAILURES;
		for (let i = 0; i < threshold - 1; i++) {
			const analysis = await pool.analyzeDefinition(UPDATE_WIDGET);
			assert.ok(analysis, `call ${i} must still fall back to in-process parsing`);
		}
		assert.ok(pool._piscina, 'pool should still be alive before the failure threshold is hit');

		// The Nth consecutive failure trips the circuit breaker.
		const analysis = await pool.analyzeDefinition(UPDATE_WIDGET);
		assert.ok(analysis, 'the call that trips the breaker must still return a fallback result');
		assert.strictEqual(pool._piscina, null, 'the pool should be torn down once the failure threshold is reached');

		// Further calls must not try to recreate the pool.
		const analysisAfter = await pool.analyzeDefinition(UPDATE_WIDGET);
		assert.ok(analysisAfter);
		assert.strictEqual(pool._piscina, null, '_ensurePool must keep returning null once the breaker has tripped');
	});

	test('a single concurrent batch worth of failures does not trip the breaker', async function () {
		this.timeout(15000);
		pool = new ParserWorkerPool();
		pool._ensurePool();
		pool._piscina.run = async () => { throw new Error('simulated worker crash'); };

		// IndexService fires CONCURRENT_BATCH_SIZE analyses in parallel per batch -
		// a single bad batch (even if every call in it fails) must not be enough
		// to disable the pool for the rest of the session on its own.
		await Promise.all(
			Array.from({ length: IndexService.CONCURRENT_BATCH_SIZE }, () => pool.analyzeDefinition(UPDATE_WIDGET))
		);

		assert.ok(pool._piscina, 'one failed batch alone must not trip the breaker');
		assert.ok(
			ParserWorkerPool.MAX_CONSECUTIVE_FAILURES > IndexService.CONCURRENT_BATCH_SIZE,
			'the threshold must stay above a single batch size for this guarantee to hold'
		);
	});
});
