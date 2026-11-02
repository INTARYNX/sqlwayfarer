const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const ConnectionImportHandlers = require('../panels/handlers/ConnectionImportHandlers');

const fixture = path.join(__dirname, 'fixtures', 'registered-servers.regsrvr');

function setup({ saved = [], answers = {}, manager = null } = {}) {
	const posted = [];
	const messages = { info: [], error: [] };
	const saves = [];
	const storage = {
		getSavedConnections: () => saved,
		saveConnections: async configs => {
			for (const config of configs) saves.push(config);
			return { saved: configs.filter(c => c.name !== 'FAIL').map(c => c.name), failed: configs.filter(c => c.name === 'FAIL').map(c => c.name) };
		}
	};
	const offered = [];
	const ui = {
		pickSource: async () => answers.source,
		pickCmsConnection: async () => answers.cms,
		pickFile: async () => answers.file,
		pickEntries: async plan => { offered.push(plan); return answers.pick ? answers.pick(plan) : plan; },
		info: m => messages.info.push(m),
		error: m => messages.error.push(m)
	};
	let reloaded = 0;
	const handlers = new ConnectionImportHandlers(m => posted.push(m), storage, { createManager: () => manager, ui, onImported: async () => { reloaded++; } });
	return { handlers, posted, messages, saves, offered, reloaded: () => reloaded };
}

const fakeManager = (rows, { fail } = {}) => {
	const state = { connectedTo: null, disposed: false };
	return Object.assign(state, {
		connectWithSaved: async name => { if (fail) throw new Error(fail); state.connectedTo = name; },
		executeQuery: async sql => ({ recordset: /server_groups/.test(sql) ? rows.groups : rows.servers }),
		dispose: async () => { state.disposed = true; }
	});
};

suite('ConnectionImportHandlers: registered servers file', () => {
	test('the servers of the file are offered and the chosen ones saved with their group', async () => {
		const { handlers, posted, saves, offered, reloaded } = setup({ answers: { source: 'file', file: fixture } });
		await handlers.handleImportConnections();
		assert.strictEqual(offered[0].length, 5);
		assert.deepStrictEqual(saves.map(s => [s.name, s.group || '']), [['Local dev', ''], ['ERP', 'Production'], ['Paris', 'Production/Europe'], ['Azure', 'Production/Europe'], ['Sandbox', 'Production/R&D lab']]);
		assert.deepStrictEqual(posted, [{ command: 'connectionsImported', added: 5, overwritten: 0, failed: 0, skipped: 0 }]);
		assert.strictEqual(reloaded(), 1);
		assert.ok(saves.every(s => !('password' in s)));
	});

	test('only the checked servers are saved; a name already saved counts as overwritten', async () => {
		const { handlers, posted, saves } = setup({
			saved: [{ name: 'ERP', server: 'old' }],
			answers: { source: 'file', file: fixture, pick: plan => plan.filter(p => ['ERP', 'Paris'].includes(p.config.name)) }
		});
		await handlers.handleImportConnections();
		assert.deepStrictEqual(saves.map(s => s.name), ['ERP', 'Paris']);
		assert.deepStrictEqual(posted[0], { command: 'connectionsImported', added: 1, overwritten: 1, failed: 0, skipped: 0 });
	});

	test('a failed save is counted, the others go on', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlwf-regsrvr-'));
		const file = path.join(dir, 'x.regsrvr');
		await fs.writeFile(file, '<S><RegisteredServer><Name>FAIL</Name><ServerName>a</ServerName></RegisteredServer><RegisteredServer><Name>OK</Name><ServerName>b</ServerName></RegisteredServer></S>');
		try {
			const { handlers, posted } = setup({ answers: { source: 'file', file } });
			await handlers.handleImportConnections();
			assert.deepStrictEqual(posted[0], { command: 'connectionsImported', added: 1, overwritten: 0, failed: 1, skipped: 0 });
		} finally { await fs.rm(dir, { recursive: true, force: true }); }
	});

	test('an exception anywhere is told to the user, not lost', async () => {
		const { handlers, messages } = setup({ answers: { source: 'file', file: fixture, pick: () => { throw new Error('picker broke'); } } });
		await handlers.handleImportConnections();
		assert.ok(/Import failed: picker broke/.test(messages.error[0]));
	});

	test('a named pipe is counted as skipped, the others are offered', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlwf-regsrvr-'));
		const file = path.join(dir, 'x.regsrvr');
		await fs.writeFile(file, '<S><RegisteredServer><Name>Pipe</Name><ServerName>np:\\\\h\\pipe\\q</ServerName></RegisteredServer><RegisteredServer><Name>OK</Name><ServerName>b</ServerName></RegisteredServer></S>');
		try {
			const { handlers, posted } = setup({ answers: { source: 'file', file } });
			await handlers.handleImportConnections();
			assert.deepStrictEqual(posted[0], { command: 'connectionsImported', added: 1, overwritten: 0, failed: 0, skipped: 1 });
		} finally { await fs.rm(dir, { recursive: true, force: true }); }
	});

	test('cancelling at any step saves nothing', async () => {
		for (const answers of [{}, { source: 'file' }, { source: 'file', file: fixture, pick: () => undefined }, { source: 'file', file: fixture, pick: () => [] }]) {
			const { handlers, posted, saves } = setup({ answers });
			await handlers.handleImportConnections();
			assert.deepStrictEqual([posted, saves], [[], []]);
		}
	});

	test('a file that is not a registered servers export, or does not exist, is explained', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlwf-regsrvr-'));
		const file = path.join(dir, 'x.regsrvr');
		await fs.writeFile(file, 'hello');
		try {
			const bad = setup({ answers: { source: 'file', file } });
			await bad.handlers.handleImportConnections();
			assert.ok(/Not a registered servers file/.test(bad.messages.error[0]));
			const missing = setup({ answers: { source: 'file', file: path.join(dir, 'nope.regsrvr') } });
			await missing.handlers.handleImportConnections();
			assert.ok(/Cannot read the file/.test(missing.messages.error[0]));
			assert.deepStrictEqual([bad.saves, missing.saves], [[], []]);
		} finally { await fs.rm(dir, { recursive: true, force: true }); }
	});
});

suite('ConnectionImportHandlers: Central Management Server', () => {
	const rows = {
		groups: [{ server_group_id: 1, parent_id: null, name: 'DatabaseEngineServerGroup', is_system_object: true }, { server_group_id: 2, parent_id: 1, name: 'Prod', is_system_object: false }],
		servers: [{ server_group_id: 2, name: 'ERP', server_name: 'erp,1444', description: '' }, { server_group_id: 1, name: 'Dev', server_name: 'dev', description: '' }]
	};

	test('connects with the chosen saved connection, reads, closes, and saves what is checked', async () => {
		const manager = fakeManager(rows);
		const { handlers, posted, saves } = setup({ saved: [{ name: 'CMS', server: 'cms-host' }], answers: { source: 'cms', cms: 'CMS' }, manager });
		await handlers.handleImportConnections();
		assert.strictEqual(manager.connectedTo, 'CMS');
		assert.strictEqual(manager.disposed, true);
		assert.deepStrictEqual(saves.map(s => [s.name, s.server, s.port, s.group || '', s.authType]), [['ERP', 'erp', '1444', 'Prod', 'windows'], ['Dev', 'dev', '', '', 'windows']]);
		assert.deepStrictEqual(posted[0], { command: 'connectionsImported', added: 2, overwritten: 0, failed: 0, skipped: 0 });
	});

	test('without any saved connection, the user is told to save the CMS one first', async () => {
		const { handlers, messages, posted } = setup({ answers: { source: 'cms' } });
		await handlers.handleImportConnections();
		assert.ok(/Save the connection/.test(messages.info[0]));
		assert.deepStrictEqual(posted, []);
	});

	test('a CMS that cannot be reached is explained, and the connection is closed', async () => {
		const manager = fakeManager(rows, { fail: 'Login failed' });
		const { handlers, messages, saves } = setup({ saved: [{ name: 'CMS' }], answers: { source: 'cms', cms: 'CMS' }, manager });
		await handlers.handleImportConnections();
		assert.ok(/Could not read the Central Management Server of 'CMS': Login failed/.test(messages.error[0]));
		assert.strictEqual(manager.disposed, true);
		assert.deepStrictEqual(saves, []);
	});

	test('a permission error names the role to ask for', async () => {
		const manager = fakeManager(rows, { fail: "The SELECT permission was denied on the object 'sysmanagement_shared_registered_servers'" });
		const { handlers, messages } = setup({ saved: [{ name: 'CMS' }], answers: { source: 'cms', cms: 'CMS' }, manager });
		await handlers.handleImportConnections();
		assert.ok(/ServerGroupReaderRole/.test(messages.error[0]));
	});

	test('an empty CMS says so', async () => {
		const manager = fakeManager({ groups: [], servers: [] });
		const { handlers, messages, posted } = setup({ saved: [{ name: 'CMS' }], answers: { source: 'cms', cms: 'CMS' }, manager });
		await handlers.handleImportConnections();
		assert.ok(/No registered server/.test(messages.info[0]));
		assert.deepStrictEqual(posted, []);
	});
});
