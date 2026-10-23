const assert = require('assert');
const ParserWorkerPool = require('../database/ParserWorkerPool');

const UPDATE_WIDGET = 'UPDATE dbo.Widget SET Flag = 1 WHERE Id = 5';

suite('ParserWorkerPool', () => {
	let pool;

	teardown(async () => {
		if (pool) await pool.dispose();
	});

	test('analyzeColumns via a real worker thread matches BabelfishSqlParser directly', async function () {
		this.timeout(15000); // first worker spawn can be slow in CI
		pool = new ParserWorkerPool();

		const refs = await pool.analyzeColumns(UPDATE_WIDGET);

		assert.ok(refs, 'expected column refs for a simple UPDATE');
		assert.strictEqual(refs['dbo.widget'].flag.write, true);
		assert.strictEqual(refs['dbo.widget'].id.write, false);
	});

	test('falls back to in-process parsing when the pool cannot be created', async () => {
		pool = new ParserWorkerPool();
		// Simulate workers failing to spawn (e.g. a sandboxed environment).
		pool._ensurePool = () => null;

		const refs = await pool.analyzeColumns(UPDATE_WIDGET);

		assert.ok(refs, 'in-process fallback must still return a real parse result');
		assert.strictEqual(refs['dbo.widget'].flag.write, true);
	});

	test('disables the pool after repeated failures instead of retrying forever', async function () {
		this.timeout(15000);
		pool = new ParserWorkerPool();

		// Spawn the real pool, then make every run() call fail from here on -
		// simulates a worker that keeps crashing rather than one that never spawned.
		pool._ensurePool();
		pool._piscina.run = async () => { throw new Error('simulated worker crash'); };

		for (let i = 0; i < 2; i++) {
			const refs = await pool.analyzeColumns(UPDATE_WIDGET);
			assert.ok(refs, `call ${i} must still fall back to in-process parsing`);
		}
		assert.ok(pool._piscina, 'pool should still be alive before the failure threshold is hit');

		// The 3rd consecutive failure trips the circuit breaker.
		const refs = await pool.analyzeColumns(UPDATE_WIDGET);
		assert.ok(refs, 'the call that trips the breaker must still return a fallback result');
		assert.strictEqual(pool._piscina, null, 'the pool should be torn down once the failure threshold is reached');

		// Further calls must not try to recreate the pool.
		const refsAfter = await pool.analyzeColumns(UPDATE_WIDGET);
		assert.ok(refsAfter);
		assert.strictEqual(pool._piscina, null, '_ensurePool must keep returning null once the breaker has tripped');
	});
});
