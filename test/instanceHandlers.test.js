const assert = require('assert');
const InstanceHandlers = require('../panels/handlers/InstanceHandlers');

// What the handlers need, with the dialogs scripted.
function setup({ answer = 'NewName', dismissed = false, confirm = true, dependents = [], runError = null } = {}) {
	const posts = [];
	const ran = [];
	const asked = [];
	const confirmed = [];
	const handlers = new InstanceHandlers(m => posts.push(m), {
		databaseService: { getObjects: async db => [{ name: 'T', db }], getDatabases: async () => ['A', 'B'] },
		connectionManager: { executeQueryInDatabase: async () => ({ recordset: dependents.map(name => ({ name })) }) },
		query: { runStatement: async (db, sqlText) => { if (runError) throw new Error(runError); ran.push([db, sqlText]); } },
		ask: async (prompt, value, validate) => { asked.push({ prompt, value, problem: validate(answer) }); return dismissed ? undefined : answer; },
		confirm: async (message, detail, action) => { confirmed.push({ message, detail, action }); return confirm; }
	});
	return { handlers, posts, ran, asked, confirmed };
}

suite('InstanceHandlers', () => {
	test('lists the databases and the objects of one', async () => {
		const { handlers, posts } = setup();
		await handlers.handleGetInstanceDatabases();
		await handlers.handleGetInstanceObjects('A');
		assert.deepStrictEqual(posts.map(p => p.command), ['instanceDatabases', 'instanceObjects']);
		assert.deepStrictEqual(posts[0].databases, ['A', 'B']);
		assert.strictEqual(posts[1].database, 'A');
	});

	test('a failure to list is reported, not thrown', async () => {
		const { posts } = setup();
		const failing = new InstanceHandlers(m => posts.push(m), { databaseService: { getObjects: async () => { throw new Error('denied'); }, getDatabases: async () => { throw new Error('down'); } } });
		await failing.handleGetInstanceObjects('A');
		await failing.handleGetInstanceDatabases();
		assert.deepStrictEqual(posts.map(p => p.command), ['instanceObjectsError', 'instanceDatabases']);
		assert.strictEqual(posts[0].message, 'denied');
		assert.deepStrictEqual(posts[1].databases, []);
	});

	test('rename shows the exact SQL and what refers to the object, then runs it and reports the change', async () => {
		const { handlers, posts, ran, confirmed } = setup({ dependents: ['dbo.usp_A', 'dbo.vB'] });
		await handlers.handleRename('Db', 'dbo', 'Orders', 'Table');
		assert.strictEqual(confirmed.length, 1);
		assert.ok(confirmed[0].detail.includes("EXEC sp_rename N'[dbo].[Orders]', N'NewName', N'OBJECT';"));
		assert.ok(confirmed[0].detail.includes('2 object(s) refer to it'));
		assert.ok(confirmed[0].detail.includes('dbo.usp_A'));
		assert.deepStrictEqual(ran, [['Db', "EXEC sp_rename N'[dbo].[Orders]', N'NewName', N'OBJECT';"]]);
		assert.deepStrictEqual(posts, [{ command: 'instanceChanged', database: 'Db' }]);
	});

	test('nothing runs when the user says no, or gives no name', async () => {
		const no = setup({ confirm: false });
		await no.handlers.handleRename('Db', 'dbo', 'Orders', 'Table');
		await no.handlers.handleDrop('Db', 'dbo', 'Orders', 'Table');
		assert.deepStrictEqual(no.ran, []);
		assert.deepStrictEqual(no.posts, []);

		const none = setup({ dismissed: true });
		await none.handlers.handleRename('Db', 'dbo', 'Orders', 'Table');
		assert.strictEqual(none.confirmed.length, 0);
		assert.deepStrictEqual(none.ran, []);
	});

	test('a bad name is refused before anything is asked or run', async () => {
		const { handlers, ran, confirmed, posts } = setup({ answer: 'a.b' });
		await handlers.handleRename('Db', 'dbo', 'Orders', 'Table');
		assert.strictEqual(confirmed.length, 0);
		assert.deepStrictEqual(ran, []);
		assert.strictEqual(posts[0].command, 'error');
	});

	test('delete shows the DROP, lists at most a dozen dependents, then runs', async () => {
		const many = Array.from({ length: 20 }, (_, i) => `dbo.p${i}`);
		const { handlers, ran, confirmed } = setup({ dependents: many });
		await handlers.handleDrop('Db', 'Sales', 'vOrders', 'View');
		assert.ok(confirmed[0].detail.startsWith('DROP VIEW [Sales].[vOrders];'));
		assert.ok(confirmed[0].detail.includes('20 object(s) refer to it'));
		assert.ok(confirmed[0].detail.includes('and 8 more'));
		assert.strictEqual(confirmed[0].action, 'Delete');
		assert.deepStrictEqual(ran, [['Db', 'DROP VIEW [Sales].[vOrders];']]);
	});

	test('an object with no dependents says so', async () => {
		const { handlers, confirmed } = setup();
		await handlers.handleDrop('Db', 'dbo', 'T', 'Table');
		assert.ok(confirmed[0].detail.includes('Nothing in this database refers to it.'));
	});

	test('a server error is reported and nothing is announced as changed', async () => {
		const { handlers, posts } = setup({ runError: 'Cannot drop, it is referenced by a foreign key.' });
		await handlers.handleDrop('Db', 'dbo', 'T', 'Table');
		assert.deepStrictEqual(posts.map(p => p.command), ['error']);
		assert.ok(posts[0].message.includes('foreign key'));
	});

	test('a name with a dot is the object of that name, never another schema\'s', async () => {
		const { handlers, ran } = setup();
		await handlers.handleDrop('Db', 'dbo', 'a.b', 'Table');
		assert.deepStrictEqual(ran, [['Db', 'DROP TABLE [dbo].[a.b];']]);
	});

	test('what is not a table, view, procedure or function is ignored', async () => {
		const { handlers, ran, confirmed, posts } = setup();
		await handlers.handleDrop('Db', 'dbo', 'T', 'Trigger');
		await handlers.handleRename('Db', 'dbo', 'T', 'Database');
		await handlers.handleDrop('', 'dbo', 'T', 'Table');
		assert.deepStrictEqual([ran, confirmed, posts], [[], [], []]);
	});
});

suite('InstanceHandlers.handleSearchInstanceObjects', () => {
	function setupSearch(searchInstanceObjects) {
		const posts = [];
		const handlers = new InstanceHandlers(m => posts.push(m), { databaseService: { searchInstanceObjects } });
		return { handlers, posts };
	}

	test('an empty query answers with no results and does not call the service', async () => {
		let called = false;
		const { handlers, posts } = setupSearch(async () => { called = true; return { results: [], truncated: false }; });
		await handlers.handleSearchInstanceObjects('', false, false, 1);
		assert.strictEqual(called, false);
		assert.deepStrictEqual(posts, [{ command: 'instanceSearched', id: 1, results: [] }]);
	});

	test('the results and the truncated flag of the service are forwarded', async () => {
		const hit = { database: 'A', object: { qualified_name: 'dbo.Orders' } };
		const { handlers, posts } = setupSearch(async () => ({ results: [hit], truncated: true }));
		await handlers.handleSearchInstanceObjects('order', false, false, 7);
		assert.deepStrictEqual(posts, [{ command: 'instanceSearched', id: 7, results: [hit], truncated: true }]);
	});

	test('an invalid regular expression is reported, not thrown', async () => {
		const { handlers, posts } = setupSearch(async () => ({ results: [], truncated: false }));
		await handlers.handleSearchInstanceObjects('(', true, false, 1);
		assert.strictEqual(posts.length, 1);
		assert.strictEqual(posts[0].command, 'instanceSearched');
		assert.ok(posts[0].error.includes('Invalid regular expression'));
	});

	test('a failure of the search service is reported, not thrown', async () => {
		const { handlers, posts } = setupSearch(async () => { throw new Error('down'); });
		await handlers.handleSearchInstanceObjects('order', false, false, 1);
		assert.deepStrictEqual(posts, [{ command: 'instanceSearched', id: 1, results: [], error: 'down' }]);
	});

	test('a reply to a superseded search (an older id) is dropped', async () => {
		const posts = [];
		let resolveFirst;
		const pendingFirst = new Promise(resolve => { resolveFirst = resolve; });
		let calls = 0;
		const handlers = new InstanceHandlers(m => posts.push(m), {
			databaseService: {
				searchInstanceObjects: async () => {
					calls++;
					return calls === 1 ? pendingFirst : { results: [{ database: 'B', object: {} }], truncated: false };
				}
			}
		});

		const first = handlers.handleSearchInstanceObjects('order', false, false, 1);
		await handlers.handleSearchInstanceObjects('orders', false, false, 2);
		resolveFirst({ results: [{ database: 'A', object: {} }], truncated: false });
		await first;

		assert.deepStrictEqual(posts.map(p => p.id), [2]);
	});
});
