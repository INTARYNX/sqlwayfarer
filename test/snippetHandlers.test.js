const assert = require('assert');
const SnippetHandlers = require('../panels/handlers/SnippetHandlers');

// Minimal Memento stand-in for globalState.
function makeState(initial = []) {
	const store = new Map([['sqlwayfarer.customSnippets', initial]]);
	return {
		get: (k, d) => (store.has(k) ? store.get(k) : d),
		update: async (k, v) => { store.set(k, v); }
	};
}

suite('SnippetHandlers', () => {
	test('adding a snippet with an existing name overwrites it', async () => {
		const state = makeState([{ name: 'A', sql: 'SELECT 1;', createdAt: 1 }]);
		const posts = [];
		const handlers = new SnippetHandlers(m => posts.push(m), state);

		await handlers.handleAddSnippet('A', 'SELECT 2;');

		const snippets = posts.pop().snippets;
		assert.strictEqual(snippets.length, 1);
		assert.strictEqual(snippets[0].sql, 'SELECT 2;');
	});

	test('renaming a snippet to a free name works', async () => {
		const state = makeState([{ name: 'A', sql: 'SELECT 1;', createdAt: 1 }]);
		const posts = [];
		const handlers = new SnippetHandlers(m => posts.push(m), state);

		await handlers.handleUpdateSnippet('A', 'B', 'SELECT 1;');

		const snippets = posts.pop().snippets;
		assert.deepStrictEqual(snippets.map(s => s.name), ['B']);
	});

	// F6: renaming a snippet to a name already used by a DIFFERENT snippet used
	// to filter out both names before re-adding under the new one, silently
	// destroying whichever snippet already had that name.
	test('renaming a snippet to a name already used by a different snippet is refused, not destroyed', async () => {
		const state = makeState([
			{ name: 'A', sql: 'SELECT 1;', createdAt: 1 },
			{ name: 'B', sql: 'SELECT 2;', createdAt: 2 }
		]);
		const posts = [];
		const handlers = new SnippetHandlers(m => posts.push(m), state);

		await handlers.handleUpdateSnippet('A', 'B', 'SELECT 99;');

		const snippets = posts.pop().snippets;
		assert.strictEqual(snippets.length, 2, 'both snippets must still exist - nothing silently destroyed');
		const b = snippets.find(s => s.name === 'B');
		assert.strictEqual(b.sql, 'SELECT 2;', 'the existing "B" must be untouched, not overwritten by the rename');
		assert.ok(snippets.find(s => s.name === 'A'), '"A" must still exist since its rename was refused');
	});

	test('renaming a snippet to its own current name (content-only edit) still works', async () => {
		const state = makeState([{ name: 'A', sql: 'SELECT 1;', createdAt: 1 }]);
		const posts = [];
		const handlers = new SnippetHandlers(m => posts.push(m), state);

		await handlers.handleUpdateSnippet('A', 'A', 'SELECT 2;');

		const snippets = posts.pop().snippets;
		assert.strictEqual(snippets.length, 1);
		assert.strictEqual(snippets[0].sql, 'SELECT 2;');
	});

	test('deleting a snippet removes only that one', async () => {
		const state = makeState([
			{ name: 'A', sql: 'SELECT 1;', createdAt: 1 },
			{ name: 'B', sql: 'SELECT 2;', createdAt: 2 }
		]);
		const posts = [];
		const handlers = new SnippetHandlers(m => posts.push(m), state);

		await handlers.handleDeleteSnippet('A');

		const snippets = posts.pop().snippets;
		assert.deepStrictEqual(snippets.map(s => s.name), ['B']);
	});

	// Snippets live in shared globalState, but each open tab also keeps its
	// own in-memory copy - a mutation has to reach every tab, not just post
	// back to whichever one made it.
	test('adding/updating/deleting a snippet broadcasts to every open tab, not just the requester', async () => {
		const state = makeState();
		const posts = [];
		const broadcasts = [];
		const handlers = new SnippetHandlers(m => posts.push(m), state, m => broadcasts.push(m));

		await handlers.handleAddSnippet('A', 'SELECT 1;');
		assert.strictEqual(posts.length, 0, 'a successful mutation is broadcast, not posted back to just the requester');
		assert.strictEqual(broadcasts.pop().snippets.length, 1);

		await handlers.handleUpdateSnippet('A', 'B', 'SELECT 2;');
		assert.deepStrictEqual(broadcasts.pop().snippets.map(s => s.name), ['B']);

		await handlers.handleDeleteSnippet('B');
		assert.deepStrictEqual(broadcasts.pop().snippets, []);
	});

	test('a refused rename (name collision) only replies to the requester, not a broadcast', async () => {
		const state = makeState([
			{ name: 'A', sql: 'SELECT 1;', createdAt: 1 },
			{ name: 'B', sql: 'SELECT 2;', createdAt: 2 }
		]);
		const posts = [];
		const broadcasts = [];
		const handlers = new SnippetHandlers(m => posts.push(m), state, m => broadcasts.push(m));

		await handlers.handleUpdateSnippet('A', 'B', 'SELECT 99;');

		assert.strictEqual(broadcasts.length, 0, 'nothing actually changed, so nothing should be broadcast');
		assert.strictEqual(posts.length, 1, 'the requester still gets told their rename was refused');
	});
});
