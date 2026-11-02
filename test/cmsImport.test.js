const assert = require('assert');
const { buildCmsEntries, readCmsServers, GROUPS_SQL, SERVERS_SQL } = require('../database/cmsImport');

const groups = [
	{ server_group_id: 1, parent_id: null, name: 'DatabaseEngineServerGroup', is_system_object: true },
	{ server_group_id: 10, parent_id: 1, name: 'Production', is_system_object: false },
	{ server_group_id: 11, parent_id: 10, name: 'Europe', is_system_object: false }
];

suite('buildCmsEntries', () => {
	test('the group path leaves the built-in root out', () => {
		const { entries } = buildCmsEntries(groups, [
			{ server_group_id: 1, name: 'Top', server_name: 'top-sql', description: null },
			{ server_group_id: 10, name: 'ERP', server_name: 'erp\\PROD', description: 'billing' },
			{ server_group_id: 11, name: 'Paris', server_name: 'paris,14330', description: '' }
		]);
		assert.deepStrictEqual(entries, [
			{ name: 'Top', server: 'top-sql', port: '', group: '', description: '' },
			{ name: 'ERP', server: 'erp\\PROD', port: '', group: 'Production', description: 'billing' },
			{ name: 'Paris', server: 'paris', port: '14330', group: 'Production/Europe', description: '' }
		]);
	});

	test('a missing display name falls back on the server; an empty address is skipped', () => {
		const { entries, skipped } = buildCmsEntries(groups, [
			{ server_group_id: 10, name: ' ', server_name: 'host', description: '' },
			{ server_group_id: 10, name: 'Nothing', server_name: '', description: '' }
		]);
		assert.deepStrictEqual(entries.map(e => e.name), ['host']);
		assert.deepStrictEqual(skipped, [{ name: 'Nothing', reason: "address '' cannot be used" }]);
	});

	test('a group name with a / is not taken for two levels; a named pipe is skipped with its reason', () => {
		const rows = [
			{ server_group_id: 1, parent_id: null, name: 'DatabaseEngineServerGroup', is_system_object: true },
			{ server_group_id: 2, parent_id: 1, name: 'Sales/EU', is_system_object: false }
		];
		const { entries, skipped } = buildCmsEntries(rows, [
			{ server_group_id: 2, name: 'A', server_name: 'a', description: '' },
			{ server_group_id: 2, name: 'Pipe', server_name: 'np:\\\\host\\pipe\\sql\\query', description: '' }
		]);
		assert.deepStrictEqual(entries.map(e => e.group), ['Sales∕EU']);
		assert.deepStrictEqual(skipped.map(s => s.name), ['Pipe']);
	});

	test('a cycle in the groups does not hang', () => {
		const loop = [
			{ server_group_id: 1, parent_id: 2, name: 'A', is_system_object: false },
			{ server_group_id: 2, parent_id: 1, name: 'B', is_system_object: false }
		];
		const { entries } = buildCmsEntries(loop, [{ server_group_id: 1, name: 'S', server_name: 'h', description: '' }]);
		assert.strictEqual(entries.length, 1);
	});
});

suite('readCmsServers', () => {
	test('runs the two read-only queries of msdb and builds the entries', async () => {
		const asked = [];
		const manager = {
			executeQuery: async sql => {
				asked.push(sql);
				return { recordset: sql === GROUPS_SQL ? groups : [{ server_group_id: 10, name: 'ERP', server_name: 'erp', description: '' }] };
			}
		};
		const { entries } = await readCmsServers(manager);
		assert.deepStrictEqual(asked, [GROUPS_SQL, SERVERS_SQL]);
		assert.deepStrictEqual(entries.map(e => [e.name, e.group]), [['ERP', 'Production']]);
		for (const sql of asked) assert.ok(/^SELECT /.test(sql) && !/\b(INSERT|UPDATE|DELETE|DROP|EXEC)\b/i.test(sql));
	});
});
