const assert = require('assert');
const { readMigrating } = require('../storage/migrateState');

// A Memento made of a Map: update(key, undefined) removes the key, as in VS Code.
function memento(initial = {}) {
	const map = new Map(Object.entries(initial));
	return {
		map,
		get: key => map.get(key),
		update: async (key, value) => { if (value === undefined) map.delete(key); else map.set(key, value); }
	};
}

suite('readMigrating', () => {
	test('a value in the state is returned, the legacy one is left alone', () => {
		const state = memento({ k: 1 }), legacy = memento({ k: 2 });
		assert.strictEqual(readMigrating(state, legacy, 'k', 0), 1);
		assert.strictEqual(legacy.map.get('k'), 2);
	});

	test('nothing anywhere gives the fallback', () => {
		assert.strictEqual(readMigrating(memento(), memento(), 'k', 'none'), 'none');
		assert.strictEqual(readMigrating(memento(), null, 'k', 'none'), 'none');
	});

	test('the legacy value is returned, then moved to the state once', async () => {
		const state = memento(), legacy = memento({ k: ['a'] });
		assert.deepStrictEqual(readMigrating(state, legacy, 'k', []), ['a']);
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual(state.map.get('k'), ['a']);
		assert.strictEqual(legacy.map.has('k'), false);
		assert.deepStrictEqual(readMigrating(state, legacy, 'k', []), ['a']);
	});

	test('a failing write is swallowed and the legacy value stays', async () => {
		const state = { get: () => undefined, update: async () => { throw new Error('disk full'); } };
		const legacy = memento({ k: 5 });
		assert.strictEqual(readMigrating(state, legacy, 'k', 0), 5);
		await new Promise(resolve => setImmediate(resolve));
		assert.strictEqual(legacy.map.get('k'), 5);
	});
});
