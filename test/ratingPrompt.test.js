const assert = require('assert');
const { RatingPrompt, shouldAsk, MIN_QUERIES, COOLDOWN_MS } = require('../panels/ratingPrompt');

// The rule that decides when the "leave a review" nudge is due.
suite('Rating prompt', () => {
	test('does not ask before the tool has proven itself', () => {
		assert.strictEqual(shouldAsk({ successfulQueries: 0, lastAskedAt: 0 }), false);
		assert.strictEqual(shouldAsk({ successfulQueries: MIN_QUERIES - 1, lastAskedAt: 0 }), false);
		assert.strictEqual(shouldAsk({ successfulQueries: MIN_QUERIES, lastAskedAt: 0 }), true);
	});

	// The threshold has to be low enough that a real user actually reaches
	// it, otherwise the prompt never fires and the page keeps showing zero.
	test('fires after five successful queries', () => {
		assert.strictEqual(shouldAsk({ successfulQueries: 5, lastAskedAt: 0 }), true);
		assert.strictEqual(shouldAsk({ successfulQueries: 4, lastAskedAt: 0 }), false);
	});

	test('does not ask twice within the cooldown', () => {
		const now = Date.now();
		assert.strictEqual(shouldAsk({ successfulQueries: 50, lastAskedAt: now - 1000, now }), false);
		assert.strictEqual(shouldAsk({ successfulQueries: 50, lastAskedAt: now - COOLDOWN_MS, now }), true);
		assert.strictEqual(shouldAsk({ successfulQueries: 50, lastAskedAt: now - COOLDOWN_MS - 1000, now }), true);
	});
});

// The counter and the prompt itself, with a fake globalState and a fake
// notification - no VS Code UI involved.
suite('Rating prompt - asking', () => {
	function makeContext() {
		const store = new Map();
		return {
			globalState: {
				get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
				update: async (key, value) => { store.set(key, value); }
			}
		};
	}

	test('asks once the threshold is reached, and not before', async () => {
		const context = makeContext();
		const asked = [];
		const prompt = new RatingPrompt(context, { showNotification: async () => { asked.push(1); return 'later'; } });

		for (let i = 0; i < MIN_QUERIES - 1; i++) {
			await prompt.onQuerySucceeded();
		}
		assert.strictEqual(asked.length, 0, 'should not ask before the threshold');

		await prompt.onQuerySucceeded();
		assert.strictEqual(asked.length, 1, 'should ask once the threshold is reached');
	});

	test('does not ask again right after having asked', async () => {
		const context = makeContext();
		const asked = [];
		const prompt = new RatingPrompt(context, { showNotification: async () => { asked.push(1); return 'later'; } });

		for (let i = 0; i < MIN_QUERIES + 10; i++) {
			await prompt.onQuerySucceeded();
		}
		assert.strictEqual(asked.length, 1, 'should not ask again within the cooldown');
	});

	test('counts the successful queries', async () => {
		const context = makeContext();
		const prompt = new RatingPrompt(context, { showNotification: async () => 'later' });

		await prompt.onQuerySucceeded();
		await prompt.onQuerySucceeded();

		const state = context.globalState.get('sqlwayfarer.ratingPrompt');
		assert.strictEqual(state.successfulQueries, 2);
	});
});
