const assert = require('assert');
const IndexHandlers = require('../panels/handlers/IndexHandlers');

suite('IndexHandlers', () => {
	test('cancelling an indexing run cancels it and keeps the index already on disk', async () => {
		const posts = [];
		const calls = [];
		const service = {
			requestCancel: database => calls.push(['cancel', database]),
			clearIndex: async database => { calls.push(['clear', database]); }
		};
		const handlers = new IndexHandlers(m => posts.push(m), service, {}, () => 'Current');

		await handlers.handleCancelIndexing('Db');
		await handlers.handleCancelIndexing();

		assert.deepStrictEqual(calls, [['cancel', 'Db'], ['cancel', 'Current']]);
		assert.deepStrictEqual(posts.map(p => [p.command, p.success, p.database]), [['indexingCancelled', true, 'Db'], ['indexingCancelled', true, 'Current']]);
	});

	test('the friendly message does not depend on the case of the driver text', () => {
		const handlers = new IndexHandlers(() => {}, {}, {}, () => null);
		const friendly = text => handlers._getUserFriendlyIndexingError(new Error(text));
		assert.ok(friendly('Timeout: request failed to complete in 15000ms').includes('timed out'));
		assert.ok(friendly('The SELECT permission was denied').includes('VIEW DEFINITION'));
		assert.ok(friendly('Connection is closed').includes('Connection lost'));
		assert.strictEqual(friendly('Something else'), 'Something else');
	});
});
