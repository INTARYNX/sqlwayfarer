const assert = require('assert');
const SavedConnectionHandlers = require('../panels/handlers/SavedConnectionHandlers');

function fakeStorage(overrides = {}) {
	return {
		getSavedConnections: () => [{ name: 'Prod', server: 'srv' }],
		getLastConnectionName: () => 'Prod',
		saveConnection: async () => ({ success: true, message: 'saved' }),
		deleteConnection: async () => ({ success: true, message: 'deleted' }),
		...overrides
	};
}

suite('SavedConnectionHandlers', () => {
	test('the list is sent with the preferences and the connections that have a tab', async () => {
		const posts = [];
		const handlers = new SavedConnectionHandlers(m => posts.push(m), {}, fakeStorage(), { openConnectionNames: () => ['Prod'] });

		await handlers.handleLoadConnections();

		assert.deepStrictEqual(posts.pop(), {
			command: 'savedConnectionsLoaded',
			connections: [{ name: 'Prod', server: 'srv' }],
			lastConnection: 'Prod',
			openConnections: ['Prod']
		});
	});

	test('the list waits for the storage to be readable', async () => {
		const posts = [];
		let release;
		const whenReady = () => new Promise(resolve => { release = resolve; });
		const handlers = new SavedConnectionHandlers(m => posts.push(m), {}, fakeStorage(), { whenReady });

		const loading = handlers.handleLoadConnections();
		await Promise.resolve();
		assert.strictEqual(posts.length, 0, 'must not answer with an empty list before the storage is read');
		release();
		await loading;
		assert.strictEqual(posts.length, 1);
	});

	test('deleting asks first, and does nothing when the user declines', async () => {
		const asked = [];
		let deleted = false;
		const storage = fakeStorage({ deleteConnection: async () => { deleted = true; return { success: true, message: '' }; } });
		const handlers = new SavedConnectionHandlers(() => {}, {}, storage, {
			confirmDelete: async name => { asked.push(name); return false; }
		});

		const ok = await handlers.handleDeleteConnection('Prod');

		assert.strictEqual(ok, false);
		assert.deepStrictEqual(asked, ['Prod']);
		assert.strictEqual(deleted, false);
	});

	test('a confirmed delete is reported to the view', async () => {
		const posts = [];
		const handlers = new SavedConnectionHandlers(m => posts.push(m), {}, fakeStorage());

		const ok = await handlers.handleDeleteConnection('Prod');

		assert.strictEqual(ok, true);
		assert.deepStrictEqual(posts.pop(), { command: 'connectionDeleted', success: true, message: 'deleted' });
	});

	test('save passes the previous name along, so a rename cleans up the old entry', async () => {
		const calls = [];
		const storage = fakeStorage({ saveConnection: async (config, originalName) => { calls.push([config.name, originalName]); return { success: true, message: 'ok' }; } });
		const handlers = new SavedConnectionHandlers(() => {}, {}, storage);

		await handlers.handleSaveConnection({ name: 'New' }, 'Old');

		assert.deepStrictEqual(calls, [['New', 'Old']]);
	});

	test('a rename is passed on, a plain save is not', async () => {
		const renamed = [];
		const handlers = new SavedConnectionHandlers(() => {}, {}, fakeStorage(), { onRenamed: (a, b) => renamed.push([a, b]) });

		await handlers.handleSaveConnection({ name: 'New' }, 'Old');
		await handlers.handleSaveConnection({ name: 'Same' }, 'Same');
		await handlers.handleSaveConnection({ name: 'Fresh' }, null);

		assert.deepStrictEqual(renamed, [['Old', 'New']]);
	});

	test('a failed rename is not passed on', async () => {
		const renamed = [];
		const storage = fakeStorage({ saveConnection: async () => ({ success: false, message: 'no' }) });
		const handlers = new SavedConnectionHandlers(() => {}, {}, storage, { onRenamed: (a, b) => renamed.push([a, b]) });
		await handlers.handleSaveConnection({ name: 'New' }, 'Old');
		assert.deepStrictEqual(renamed, []);
	});

	test('save & open saves, refreshes the list, then opens the connection', async () => {
		const steps = [];
		const storage = fakeStorage({ saveConnection: async () => { steps.push('save'); return { success: true, message: 'ok' }; } });
		const handlers = new SavedConnectionHandlers(m => { if (m.command === 'savedConnectionsLoaded') steps.push('list'); }, {}, storage, {
			openConnection: async name => { steps.push(`open ${name}`); }
		});

		assert.strictEqual(await handlers.handleSaveAndOpenConnection({ name: 'Prod' }), true);

		assert.deepStrictEqual(steps, ['save', 'list', 'open Prod']);
	});

	test('save & open does not open a connection that could not be saved', async () => {
		const opened = [];
		const storage = fakeStorage({ saveConnection: async () => ({ success: false, message: 'no' }) });
		const handlers = new SavedConnectionHandlers(() => {}, {}, storage, { openConnection: async name => opened.push(name) });

		assert.strictEqual(await handlers.handleSaveAndOpenConnection({ name: 'Prod' }), false);
		assert.deepStrictEqual(opened, []);
	});

	test('a failing storage is reported as a failed save', async () => {
		const posts = [];
		const storage = fakeStorage({ saveConnection: async () => { throw new Error('boom'); } });
		const handlers = new SavedConnectionHandlers(m => posts.push(m), {}, storage);

		assert.strictEqual(await handlers.handleSaveConnection({ name: 'x' }), false);
		assert.strictEqual(posts.pop().success, false);
	});

	test('testing a connection reports success and failure', async () => {
		const posts = [];
		let fail = false;
		const manager = { testConnection: async () => { if (fail) throw new Error('nope'); } };
		const handlers = new SavedConnectionHandlers(m => posts.push(m), manager, fakeStorage());

		await handlers.handleTestConnection({});
		assert.strictEqual(posts.pop().success, true);

		fail = true;
		await handlers.handleTestConnection({});
		const result = posts.pop();
		assert.strictEqual(result.success, false);
		assert.ok(result.message.includes('nope'));
	});
});
