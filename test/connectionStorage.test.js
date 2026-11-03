const assert = require('assert');
const ConnectionStorage = require('../storage/ConnectionStorage');

function fakeContext() {
	const secrets = new Map();
	const state = new Map();
	return {
		secrets: { get: async k => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async k => { secrets.delete(k); } },
		globalState: { get: k => state.get(k), update: async (k, v) => { state.set(k, v); } },
		_secrets: secrets
	};
}

suite('ConnectionStorage.saveConnection', () => {
	let context;
	let storage;
	setup(async () => {
		context = fakeContext();
		storage = new ConnectionStorage(context);
		await storage.initialize();
		await storage.saveConnection({ name: 'Prod', server: 'prod-srv', password: 'prod-secret' });
		await storage.saveConnection({ name: 'Dev', server: 'dev-srv', password: 'dev-secret' });
	});

	test('a new connection with a name that is taken is refused, and the saved one is untouched', async () => {
		const result = await storage.saveConnection({ name: 'Prod', server: 'other', password: 'x' });

		assert.strictEqual(result.success, false);
		assert.ok(result.message.includes("'Prod' already exists"), result.message);
		assert.strictEqual(storage.getConnection('Prod').server, 'prod-srv');
		assert.strictEqual(await storage.getConnectionPassword('Prod'), 'prod-secret');
	});

	test('renaming a connection onto another one is refused, and both stay', async () => {
		const result = await storage.saveConnection({ name: 'Prod', server: 'dev-srv' }, 'Dev');

		assert.strictEqual(result.success, false);
		assert.strictEqual(storage.getConnection('Dev').server, 'dev-srv');
		assert.strictEqual(storage.getConnection('Prod').server, 'prod-srv');
		assert.strictEqual(await storage.getConnectionPassword('Dev'), 'dev-secret');
		assert.strictEqual(await storage.getConnectionPassword('Prod'), 'prod-secret');
	});

	test('editing a connection under its own name, and a plain rename, still work', async () => {
		assert.strictEqual((await storage.saveConnection({ name: 'Prod', server: 'new-srv' }, 'Prod')).success, true);
		assert.strictEqual(storage.getConnection('Prod').server, 'new-srv');
		assert.strictEqual(await storage.getConnectionPassword('Prod'), 'prod-secret', 'no new password: the saved one stays');

		assert.strictEqual((await storage.saveConnection({ name: 'Staging', server: 'new-srv' }, 'Prod')).success, true);
		assert.strictEqual(storage.hasConnection('Prod'), false);
		assert.strictEqual(await storage.getConnectionPassword('Staging'), 'prod-secret');
	});
});
