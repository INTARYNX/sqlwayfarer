const assert = require('assert');
const PanelRegistry = require('../panels/PanelRegistry');

suite('PanelRegistry', () => {
	test('findByConnectionIdentity finds another panel on the same connection, never itself', () => {
		const registry = new PanelRegistry();
		const panelA = { connectionIdentity: 'srv:1433:sa' };
		const panelB = { connectionIdentity: 'srv:1433:sa' };
		registry.register(panelA);
		registry.register(panelB);

		assert.strictEqual(registry.findByConnectionIdentity('srv:1433:sa', panelA), panelB);
		assert.strictEqual(registry.findByConnectionIdentity('srv:1433:sa', panelB), panelA);
	});

	test('no match when no other open panel shares the identity', () => {
		const registry = new PanelRegistry();
		registry.register({ connectionIdentity: 'srv1:1433:sa' });
		assert.strictEqual(registry.findByConnectionIdentity('srv2:1433:sa', null), null);
	});

	test('a null/undefined identity never matches - two not-yet-connected panels are not "the same connection"', () => {
		const registry = new PanelRegistry();
		registry.register({ connectionIdentity: null });
		registry.register({ connectionIdentity: null });
		assert.strictEqual(registry.findByConnectionIdentity(null, null), null);
	});

	test('findByConnectionName finds the tab opened for a saved connection', () => {
		const registry = new PanelRegistry();
		const prod = { connectionName: 'Prod' };
		registry.register(prod);
		registry.register({ connectionName: null });
		assert.strictEqual(registry.findByConnectionName('Prod'), prod);
		assert.strictEqual(registry.findByConnectionName('Dev'), null);
		assert.strictEqual(registry.findByConnectionName(null), null);
	});

	test('the sidebar is told which connections have a tab, the panels are not bothered', () => {
		const registry = new PanelRegistry();
		const told = [];
		registry.register({ onOpenConnectionsChanged: names => told.push(names) });
		registry.register({ connectionName: 'Prod' });
		registry.register({ connectionName: 'Dev' });
		registry.notifyOpenConnectionsChanged();
		assert.deepStrictEqual(told, [['Prod', 'Dev']]);
	});

	test('renameConnection makes the open tab follow its connection', () => {
		const registry = new PanelRegistry();
		const told = [];
		const renamed = [];
		const panel = { connectionName: 'Old', renameConnection(name) { this.connectionName = name; renamed.push(name); } };
		registry.register(panel);
		registry.register({ onOpenConnectionsChanged: names => told.push(names) });
		registry.renameConnection('Old', 'New');
		assert.deepStrictEqual(renamed, ['New']);
		assert.strictEqual(registry.findByConnectionName('New'), panel);
		assert.strictEqual(registry.findByConnectionName('Old'), null);
		assert.deepStrictEqual(told, [['New']]);
		registry.renameConnection('Nobody', 'Else');
		assert.strictEqual(told.length, 1, 'renaming a connection with no tab changes nothing');
	});

	test('unregister removes a panel from later lookups and broadcasts', () => {
		const registry = new PanelRegistry();
		const received = [];
		const panel = { connectionIdentity: 'srv:1433:sa', post: m => received.push(m) };
		registry.register(panel);
		registry.unregister(panel);

		assert.strictEqual(registry.findByConnectionIdentity('srv:1433:sa', null), null);
		registry.broadcast({ command: 'x' });
		assert.strictEqual(received.length, 0);
	});

	test('broadcast posts to every registered panel', () => {
		const registry = new PanelRegistry();
		const receivedA = [];
		const receivedB = [];
		registry.register({ post: m => receivedA.push(m) });
		registry.register({ post: m => receivedB.push(m) });

		registry.broadcast({ command: 'snippetsLoaded', snippets: [] });

		assert.strictEqual(receivedA.length, 1);
		assert.strictEqual(receivedB.length, 1);
	});

	// A stale/disposed webview target (e.g. the sidebar mid-teardown while
	// hidden) throwing from post() must not stop everyone registered after it
	// from getting the broadcast - this was exactly how snippets could go
	// missing in one tab/view while updated fine in another.
	test('one target throwing during broadcast does not stop the rest from receiving it', () => {
		const registry = new PanelRegistry();
		const received = [];
		registry.register({ post: () => { throw new Error('disposed webview'); } });
		registry.register({ post: m => received.push(m) });

		registry.broadcast({ command: 'snippetsLoaded', snippets: [] });

		assert.strictEqual(received.length, 1, 'the second, healthy target must still receive the broadcast');
	});
});
