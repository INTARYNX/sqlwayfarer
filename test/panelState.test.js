const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const SqlWayfarerPanel = require('../panels/SqlWayfarerPanel');
const PanelRegistry = require('../panels/PanelRegistry');
const { PanelStateStore } = require('../panels/panelState');

// Minimal Memento stand-in for workspaceState / globalState.
function makeMemento() {
	const store = new Map();
	return {
		get: (k, d) => (store.has(k) ? store.get(k) : d),
		update: async (k, v) => { store.set(k, v); }
	};
}

// Minimal ExtensionContext: only what the panel touches at construction.
function makeContext(workspaceState) {
	return {
		subscriptions: [],
		workspaceState,
		globalState: makeMemento(),
		secrets: {
			get: async () => undefined,
			store: async () => {},
			delete: async () => {}
		}
	};
}

// Minimal WebviewPanel: records what the panel posts to the webview.
function makePanel() {
	const posted = [];
	return {
		posted,
		title: '',
		webview: {
			html: '',
			cspSource: 'vscode-webview://test',
			asWebviewUri: uri => uri,
			postMessage: message => { posted.push(message); return Promise.resolve(true); },
			onDidReceiveMessage: () => ({ dispose: () => {} })
		},
		onDidDispose: () => ({ dispose: () => {} }),
		reveal: () => {}
	};
}

function makePanelInstance(workspaceState) {
	const panel = makePanel();
	const instance = new SqlWayfarerPanel(
		panel,
		vscode.Uri.file(path.resolve(__dirname, '..')),
		makeContext(workspaceState),
		new PanelRegistry()
	);
	return { instance, panel };
}

// The state is written asynchronously (workspaceState.update is a promise).
function flush() {
	return new Promise(resolve => setTimeout(resolve, 0));
}

suite('Panel state - a rebuilt tab comes back where it was', () => {
	test('PanelStateStore keeps one entry per connection', async () => {
		const store = new PanelStateStore(makeMemento());

		await store.set('srv1:1433:sa', { database: 'Db1', tab: 'explorer' });
		await store.set('srv2:1433:sa', { database: 'Db2' });

		assert.deepStrictEqual(store.get('srv1:1433:sa'), { database: 'Db1', tab: 'explorer' });
		assert.deepStrictEqual(store.get('srv2:1433:sa'), { database: 'Db2' });
		assert.strictEqual(store.get('srv3:1433:sa'), null);
		assert.strictEqual(store.get(null), null);
	});

	test('PanelStateStore merges partial updates instead of replacing them', async () => {
		const store = new PanelStateStore(makeMemento());

		await store.set('srv:1433:sa', { database: 'Db1', tab: 'explorer' });
		await store.set('srv:1433:sa', { database: 'Db2' });

		assert.deepStrictEqual(store.get('srv:1433:sa'), { database: 'Db2', tab: 'explorer' });
	});

	test('the selected database and the open tab survive a rebuilt tab', async () => {
		const workspaceState = makeMemento();

		// First tab: the user works on Db1 with the Explorer open.
		const first = makePanelInstance(workspaceState);
		first.instance._onConnectionChanged('srv:1433:sa', 'srv');
		await first.instance._handleMessage({ command: 'setCurrentDatabase', database: 'Db1' });
		await first.instance._handleMessage({ command: 'setActiveTab', tab: 'explorer' });
		await flush();

		// The tab is rebuilt (page reloaded, window reloaded): a brand new
		// panel, same workspace state.
		const second = makePanelInstance(workspaceState);
		await second.instance._handleMessage({ command: 'panelReady' });
		second.instance._onConnectionChanged('srv:1433:sa', 'srv');

		assert.strictEqual(second.instance._currentSelectedDatabase, 'Db1');
		assert.strictEqual(second.instance._activeTab, 'explorer');

		// The database list carries the state, so the webview can put the
		// selection back (it rebuilds the selector from scratch).
		second.instance.post({ command: 'databasesLoaded', databases: ['Db1', 'Db2'] });
		const list = second.panel.posted.find(m => m.command === 'databasesLoaded');
		assert.strictEqual(list.currentDatabase, 'Db1');
		assert.strictEqual(list.activeTab, 'explorer');
	});

	test('a sync reply with no database does not wipe the restored one', async () => {
		const workspaceState = makeMemento();

		const first = makePanelInstance(workspaceState);
		first.instance._onConnectionChanged('srv:1433:sa', 'srv');
		await first.instance._handleMessage({ command: 'setCurrentDatabase', database: 'Db1' });
		await flush();

		const second = makePanelInstance(workspaceState);
		await second.instance._handleMessage({ command: 'panelReady' });
		second.instance._onConnectionChanged('srv:1433:sa', 'srv');

		// The webview asks which database is selected and answers with what
		// it has - a page that was just rebuilt has none.
		await second.instance._handleMessage({ command: 'setCurrentDatabase', database: '', sync: true });

		assert.strictEqual(second.instance._currentSelectedDatabase, 'Db1');
	});

	test('an explicit change from the webview does replace the database', async () => {
		const workspaceState = makeMemento();

		const first = makePanelInstance(workspaceState);
		first.instance._onConnectionChanged('srv:1433:sa', 'srv');
		await first.instance._handleMessage({ command: 'setCurrentDatabase', database: 'Db1' });
		await flush();

		const second = makePanelInstance(workspaceState);
		await second.instance._handleMessage({ command: 'panelReady' });
		second.instance._onConnectionChanged('srv:1433:sa', 'srv');
		await second.instance._handleMessage({ command: 'setCurrentDatabase', database: 'Db2' });

		assert.strictEqual(second.instance._currentSelectedDatabase, 'Db2');
	});

	test('connecting to another server starts from a clean slate', async () => {
		const workspaceState = makeMemento();

		const first = makePanelInstance(workspaceState);
		first.instance._onConnectionChanged('srv1:1433:sa', 'srv1');
		await first.instance._handleMessage({ command: 'setCurrentDatabase', database: 'Db1' });
		await flush();

		const second = makePanelInstance(workspaceState);
		await second.instance._handleMessage({ command: 'panelReady' });
		// Same tab, now connected to a different server.
		second.instance._onConnectionChanged('srv2:1433:sa', 'srv2');

		assert.strictEqual(second.instance._currentSelectedDatabase, null);
	});
});
