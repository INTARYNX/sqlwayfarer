const assert = require('assert');
const RecentHandlers = require('../panels/handlers/RecentHandlers');

function setup(sets) {
	const posts = [];
	const log = [];
	const manager = {
		acquireConnection: async () => ({
			createRequest: () => ({ batch: async text => { log.push(text); if (sets instanceof Error && !text.startsWith('USE [master]')) throw sets; return { recordsets: text.startsWith('USE [master]') ? [] : sets }; } }),
			release: () => {}
		})
	};
	return { handlers: new RecentHandlers(m => posts.push(m), { connectionManager: manager }), posts, log };
}
const row = { schema_name: 'dbo', object_name: 'p', type_code: 'P ', created: 'a', modified: 'b', created_age: 5, modified_age: 4, is_altered: 1, created_in_period: 0, parent_schema: null, parent_name: null };

suite('RecentHandlers', () => {
	test('the objects touched lately are posted with the period and the server time', async () => {
		const { handlers, posts } = setup([[row], [{ server_time: '2026-11-03 11:00:00' }]]);
		await handlers.handleGetRecent('Db', 60);
		assert.strictEqual(posts[0].command, 'recentChanges');
		assert.deepStrictEqual([posts[0].database, posts[0].minutes, posts[0].serverTime, posts[0].items.length], ['Db', 60, '2026-11-03 11:00:00', 1]);
	});

	test('with a snapshot, the answer says which and from when', async () => {
		const { handlers, posts, log } = setup([[row], [{ server_time: '2026-11-03 11:00:00', since: '2026-11-03 08:00:00' }]]);
		await handlers.handleGetRecent('Db', undefined, 'Snap1');
		assert.ok(log[0].includes("name = N'Snap1'"));
		assert.deepStrictEqual([posts[0].command, posts[0].snapshot, posts[0].since], ['recentChanges', 'Snap1', '2026-11-03 08:00:00']);
	});

	test('no database, a bad period or a failure to read is said, never thrown', async () => {
		const none = setup([[], []]);
		await none.handlers.handleGetRecent('', 60);
		await none.handlers.handleGetRecent('Db', 0);
		const failing = setup(new Error('denied'));
		await failing.handlers.handleGetRecent('Db', 60);
		assert.deepStrictEqual(none.posts.map(p => p.command), ['recentFailed', 'recentFailed']);
		assert.ok(none.posts[1].message.includes('not valid'));
		assert.deepStrictEqual([failing.posts[0].command, failing.posts[0].message], ['recentFailed', 'denied']);
	});

	test('the code of an object is posted with its name, null when there is none', async () => {
		const { handlers, posts } = setup([[{ definition: 'CREATE PROC p AS SELECT 1' }]]);
		await handlers.handleGetDefinition('Db', 'dbo', 'p');
		await handlers.handleGetDefinition('Db', '', 'p');
		assert.strictEqual(posts.length, 1);
		assert.deepStrictEqual([posts[0].command, posts[0].schema, posts[0].name, posts[0].definition], ['recentDefinition', 'dbo', 'p', 'CREATE PROC p AS SELECT 1']);
		const failing = setup(new Error('denied'));
		await failing.handlers.handleGetDefinition('Db', 'dbo', 'p');
		assert.deepStrictEqual([failing.posts[0].definition, failing.posts[0].message], [null, 'denied']);
	});
});
