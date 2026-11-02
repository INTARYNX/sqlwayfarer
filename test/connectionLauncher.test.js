const assert = require('assert');
const ConnectionLauncher = require('../panels/connectionLauncher');
const PanelRegistry = require('../panels/PanelRegistry');

function setup({ connections = [], last = null, openLast = true, panels = [], picked = null } = {}) {
	const registry = new PanelRegistry();
	panels.forEach(p => registry.register(p));
	const created = [];
	const shown = { info: [], error: [], focused: 0, picks: [] };
	const storage = {
		getConnection: name => connections.find(c => c.name === name) || null,
		getSavedConnections: () => connections,
		getLastConnectionName: () => last,
		hasConnection: name => connections.some(c => c.name === name)
	};
	const launcher = new ConnectionLauncher({
		storage,
		registry,
		openLastConnection: () => openLast,
		createPanel: name => { const panel = { connectionName: name, reveal() {} }; created.push(name); return panel; },
		ui: {
			pick: async items => { shown.picks.push(items); return picked ? items.find(i => i.label === picked) : undefined; },
			info: message => shown.info.push(message),
			error: message => shown.error.push(message),
			focusSidebar: () => { shown.focused++; }
		}
	});
	return { launcher, created, shown };
}

const PROD = { name: 'Prod', server: 'srv', port: 1433, username: 'sa' };
const DEV = { name: 'Dev', server: 'dev', authType: 'windows' };

suite('ConnectionLauncher.open', () => {
	test('opens a tab for a connection that has none', async () => {
		const { launcher, created } = setup({ connections: [PROD] });
		await launcher.open('Prod');
		assert.deepStrictEqual(created, ['Prod']);
	});

	test('shows the tab that already has the connection instead of opening a second one', async () => {
		const revealed = [];
		const panel = { connectionName: 'Prod', reveal: () => revealed.push('Prod') };
		const { launcher, created } = setup({ connections: [PROD], panels: [panel] });
		await launcher.open('Prod');
		assert.deepStrictEqual(created, []);
		assert.deepStrictEqual(revealed, ['Prod']);
	});

	test('same server and login under another name counts as open', async () => {
		const revealed = [];
		const panel = { connectionName: 'Prod copy', connectionIdentity: 'srv:1433:sa', reveal: () => revealed.push('copy') };
		const { launcher, created } = setup({ connections: [PROD], panels: [panel] });
		await launcher.open('Prod');
		assert.deepStrictEqual(created, []);
		assert.deepStrictEqual(revealed, ['copy']);
	});

	test('another connection of the same server and login shows that tab, on the asked database', async () => {
		const databases = [];
		const panel = {
			connectionName: 'Prod sales', connectionIdentity: 'srv:1433:sa',
			reveal() {}, selectDatabase: db => databases.push(db)
		};
		const hr = { name: 'Prod HR', server: 'srv', port: 1433, username: 'sa', database: 'HR' };
		const { launcher, created, shown } = setup({ connections: [PROD, hr], panels: [panel] });

		await launcher.open('Prod HR');

		assert.deepStrictEqual(created, []);
		assert.deepStrictEqual(databases, ['HR']);
		assert.ok(shown.info[0].includes('Prod sales') && shown.info[0].includes('HR'), 'the user is told why that tab is shown');
	});

	test('reopening the same connection says nothing', async () => {
		const panel = { connectionName: 'Prod', reveal() {}, selectDatabase: () => { throw new Error('must not move the tab'); } };
		const { launcher, shown } = setup({ connections: [{ ...PROD, database: 'X' }], panels: [panel] });
		await launcher.open('Prod');
		assert.deepStrictEqual(shown.info, []);
	});

	test('an unknown connection is reported', async () => {
		const { launcher, created, shown } = setup();
		await launcher.open('Ghost');
		assert.deepStrictEqual(created, []);
		assert.ok(shown.error[0].includes('Ghost'));
	});
});

suite('ConnectionLauncher.openDefault', () => {
	test('any argument is tolerated - a command can be run with null or something else', async () => {
		for (const argument of [null, undefined, 'x', 42, {}]) {
			const { launcher, created } = setup({ connections: [PROD], last: 'Prod' });
			await launcher.openDefault(argument);
			assert.deepStrictEqual(created, ['Prod']);
		}
	});

	test('opens the last connection straight away when asked to', async () => {
		const { launcher, created, shown } = setup({ connections: [PROD, DEV], last: 'Dev' });
		await launcher.openDefault();
		assert.deepStrictEqual(created, ['Dev']);
		assert.strictEqual(shown.picks.length, 0);
	});

	test('shows the list when that shortcut is off, last used first', async () => {
		const { launcher, created, shown } = setup({ connections: [PROD, DEV], last: 'Dev', openLast: false, picked: 'Prod' });
		await launcher.openDefault();
		assert.deepStrictEqual(shown.picks[0].map(i => i.label), ['Dev', 'Prod']);
		assert.deepStrictEqual(created, ['Prod']);
	});

	test('a connection that was deleted is not opened as the last one', async () => {
		const { launcher, shown } = setup({ connections: [PROD], last: 'Gone', picked: null });
		await launcher.openDefault();
		assert.strictEqual(shown.picks.length, 1);
	});

	test('cancelling the list opens nothing', async () => {
		const { launcher, created } = setup({ connections: [PROD], openLast: false, picked: null });
		await launcher.openDefault();
		assert.deepStrictEqual(created, []);
	});

	test('without any connection, points to the sidebar', async () => {
		const { launcher, created, shown } = setup();
		await launcher.openDefault();
		assert.deepStrictEqual(created, []);
		assert.strictEqual(shown.info.length, 1);
		assert.strictEqual(shown.focused, 1);
	});

	test('flags the connections that are already open', async () => {
		const panel = { connectionName: 'Prod', reveal() {} };
		const { launcher, shown } = setup({ connections: [PROD, DEV], openLast: false, panels: [panel] });
		await launcher.openDefault();
		const items = shown.picks[0];
		assert.ok(items.find(i => i.label === 'Prod').detail);
		assert.strictEqual(items.find(i => i.label === 'Dev').detail, undefined);
	});
});
