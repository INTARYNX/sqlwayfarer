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

// Two windows of VS Code share one secret storage but each holds its own copy.
suite('ConnectionStorage with two windows', () => {
	function sharedContexts() {
		const secrets = new Map();
		const state = new Map();
		const handlers = [];
		const make = () => ({
			secrets: {
				get: async k => secrets.get(k),
				store: async (k, v) => { secrets.set(k, v); for (const h of handlers) await h({ key: k }); },
				delete: async k => { secrets.delete(k); },
				onDidChange: h => { handlers.push(h); }
			},
			globalState: { get: k => state.get(k), update: async (k, v) => { state.set(k, v); } }
		});
		return [make(), make()];
	}

	test('a connection saved in one window is not lost when the other saves its own', async () => {
		const [ctxA, ctxB] = sharedContexts();
		const a = new ConnectionStorage(ctxA);
		const b = new ConnectionStorage(ctxB);
		await a.initialize();
		await b.initialize();

		await a.saveConnection({ name: 'FromA', server: 'a' });
		await b.saveConnection({ name: 'FromB', server: 'b' });

		const fresh = new ConnectionStorage(ctxA);
		await fresh.initialize();
		assert.deepStrictEqual(fresh.getSavedConnections().map(c => c.name).sort(), ['FromA', 'FromB']);
	});

	test('the other window is told, and shows the connection', async () => {
		const [ctxA, ctxB] = sharedContexts();
		const a = new ConnectionStorage(ctxA);
		const b = new ConnectionStorage(ctxB);
		await a.initialize();
		await b.initialize();
		let told = 0;
		const stop = b.onDidChange(() => { told++; });

		await a.saveConnection({ name: 'FromA', server: 'a' });
		assert.ok(told >= 1);
		assert.strictEqual(b.hasConnection('FromA'), true);

		stop();
		const before = told;
		await a.saveConnection({ name: 'More', server: 'a' });
		assert.strictEqual(told, before, 'a listener that stopped is not called');
	});

	test('a name taken by the other window is not overwritten either', async () => {
		const [ctxA, ctxB] = sharedContexts();
		const a = new ConnectionStorage(ctxA);
		const b = new ConnectionStorage(ctxB);
		await a.initialize();
		await b.initialize();
		await a.saveConnection({ name: 'Same', server: 'a' });
		const result = await b.saveConnection({ name: 'Same', server: 'b' });
		assert.strictEqual(result.success, false);
		assert.strictEqual(b.getConnection('Same').server, 'a');
	});

	test('two saves at once both stay', async () => {
		const [ctxA] = sharedContexts();
		const a = new ConnectionStorage(ctxA);
		await a.initialize();
		await Promise.all([a.saveConnection({ name: 'One', server: '1' }), a.saveConnection({ name: 'Two', server: '2' })]);
		assert.deepStrictEqual(a.getSavedConnections().map(c => c.name).sort(), ['One', 'Two']);
	});

	test('a storage that cannot be read refuses the save, with a message', async () => {
		const [ctxA] = sharedContexts();
		const a = new ConnectionStorage(ctxA);
		await a.initialize();
		ctxA.secrets.get = async () => { throw new Error('locked'); };
		const result = await a.saveConnection({ name: 'X', server: 'x' });
		assert.strictEqual(result.success, false);
		assert.ok(result.message.includes('locked'), result.message);
	});
});
