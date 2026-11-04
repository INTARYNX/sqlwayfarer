const assert = require('assert');
const ConnectionStorage = require('../storage/ConnectionStorage');

const CONNECTIONS_KEY = 'sqlwayfarer.connections';

// A context whose secret storage can be watched, the way VS Code's does:
// another window changing the connections raises onDidChange.
function fakeContext() {
	const secrets = new Map();
	const state = new Map();
	const handlers = [];
	return {
		secrets: {
			get: async k => secrets.get(k),
			store: async (k, v) => { secrets.set(k, v); },
			delete: async k => { secrets.delete(k); },
			onDidChange: listener => {
				handlers.push(listener);
				return { dispose: () => { const i = handlers.indexOf(listener); if (i >= 0) handlers.splice(i, 1); } };
			}
		},
		globalState: { get: k => state.get(k), update: async (k, v) => { state.set(k, v); } },
		_fire: key => { for (const handler of handlers.slice()) handler({ key }); },
		_handlerCount: () => handlers.length
	};
}

suite('ConnectionStorage: the changes another window makes', () => {
	test('a change made while a save is in flight does not swallow that save', async () => {
		const context = fakeContext();
		const storage = new ConnectionStorage(context);
		await storage.initialize();

		const store = context.secrets.store;
		context.secrets.store = async (k, v) => {
			if (k === CONNECTIONS_KEY) {
				// The other window changes something exactly while our own
				// write is on its way: the event fires BEFORE our write lands,
				// so a reload that reads right now sees the old state.
				context._fire(CONNECTIONS_KEY);
				await new Promise(resolve => setTimeout(resolve, 10));
			}
			return store(k, v);
		};

		const result = await storage.saveConnection({ name: 'Mine', server: 'srv', username: 'u', password: 'p' });
		assert.strictEqual(result.success, true);

		// The connection the user just saved must still be there: the reload
		// of the other window must not replace the state under the save.
		assert.deepStrictEqual(storage.getSavedConnections().map(c => c.name), ['Mine']);

		// And it must survive a reload of the storage.
		const reloaded = new ConnectionStorage(context);
		await reloaded.initialize();
		assert.deepStrictEqual(reloaded.getSavedConnections().map(c => c.name), ['Mine']);
	});

	test('the reload of another window reaches the listeners', async () => {
		const context = fakeContext();
		const storage = new ConnectionStorage(context);
		await storage.initialize();

		let told = 0;
		storage.onDidChange(() => { told++; });

		context._fire(CONNECTIONS_KEY);
		await new Promise(resolve => setTimeout(resolve, 20));

		assert.strictEqual(told, 1);
	});

	test('the subscription is released when the storage is disposed', async () => {
		const context = fakeContext();
		const storage = new ConnectionStorage(context);
		await storage.initialize();
		assert.strictEqual(context._handlerCount(), 1);

		storage.dispose();

		assert.strictEqual(context._handlerCount(), 0);
	});
});
