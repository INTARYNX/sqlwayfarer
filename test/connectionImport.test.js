const assert = require('assert');
const { planConnectionImport, toSavedConnection, uniqueNames } = require('../database/connectionImport');

const entry = (name, extra = {}) => Object.assign({ name, server: `${name.toLowerCase()}-sql`, port: '', group: '' }, extra);

suite('connection import', () => {
	test('an entry becomes a saved connection: Windows by default, no password, the group kept', () => {
		const config = toSavedConnection(entry('ERP', { group: 'Production', port: '14330' }), 'ERP');
		assert.deepStrictEqual(config, {
			name: 'ERP', useConnectionString: false, authType: 'windows', server: 'erp-sql', port: '14330', database: '',
			username: '', encrypt: false, trustServerCertificate: true, group: 'Production'
		});
		assert.ok(!('password' in config));
	});

	test('what the entry says about signing in and encryption is kept', () => {
		const sql = toSavedConnection(entry('A', { authType: 'sql', username: 'bob', encrypt: true, trustServerCertificate: false }), 'A');
		assert.deepStrictEqual([sql.authType, sql.username, sql.encrypt, sql.trustServerCertificate], ['sql', 'bob', true, false]);
		const entra = toSavedConnection(entry('B', { authType: 'entra', username: 'ignored' }), 'B');
		assert.deepStrictEqual([entra.authType, entra.username, entra.encrypt], ['entra', '', true]);
		assert.ok(!('group' in entra));
	});

	test('the same name in two groups is told apart by the group, then by a number', () => {
		assert.deepStrictEqual(uniqueNames([entry('DB', { group: 'Prod' }), entry('DB', { group: 'Dev' }), entry('x'), entry('X')]), ['DB (Prod)', 'DB (Dev)', 'x', 'X (2)']);
		assert.deepStrictEqual(uniqueNames([entry('DB'), entry('DB')]), ['DB', 'DB (2)']);
	});

	test('the plan says what is saved already: by name (overwrite) or by target (twin)', () => {
		const existing = [
			{ name: 'erp', server: 'other', authType: 'sql' },
			{ name: 'Mine', server: 'paris-sql', port: '', database: '', authType: 'windows' }
		];
		const plan = planConnectionImport(existing, [entry('ERP'), entry('Paris'), entry('Fresh')]);
		assert.deepStrictEqual(plan.map(p => [p.config.name, p.sameName, p.sameTarget]), [
			['erp', 'erp', null],
			['Paris', null, 'Mine'],
			['Fresh', null, null]
		]);
	});

	test('an empty list gives an empty plan', () => {
		assert.deepStrictEqual(planConnectionImport([], []), []);
	});
});
