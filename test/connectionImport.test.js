const assert = require('assert');
const { planConnectionImport, toSavedConnection, mergeIntoExisting, groupPath, uniqueNames } = require('../database/connectionImport');

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

	test('a host that requires encryption starts encrypted with a valid certificate; any other starts as the form does', () => {
		const azure = toSavedConnection(entry('Az', { server: 'contoso.database.windows.net', authType: 'sql', username: 'u' }), 'Az');
		assert.deepStrictEqual([azure.encrypt, azure.trustServerCertificate], [true, false]);
		const local = toSavedConnection(entry('L'), 'L');
		assert.deepStrictEqual([local.encrypt, local.trustServerCertificate], [false, true]);
		const said = toSavedConnection(entry('S', { server: 'x.database.windows.net', encrypt: false, trustServerCertificate: true }), 'S');
		assert.deepStrictEqual([said.encrypt, said.trustServerCertificate], [false, true]);
	});

	test('over a connection of the same name, what the entry does not say stays as the user saved it', () => {
		const existing = { name: 'prod', server: 'old', port: '1433', database: 'Sales', authType: 'sql', username: 'bob', encrypt: true, trustServerCertificate: false, password: undefined, group: 'Old' };
		const merged = mergeIntoExisting(existing, entry('prod', { server: 'new-sql', port: '14330', group: 'Production' }));
		assert.deepStrictEqual(merged, { name: 'prod', server: 'new-sql', port: '14330', database: 'Sales', authType: 'sql', username: 'bob', encrypt: true, trustServerCertificate: false, group: 'Production' });
		const signedIn = mergeIntoExisting(existing, entry('prod', { authType: 'windows' }));
		assert.deepStrictEqual([signedIn.authType, signedIn.username, signedIn.database], ['windows', '', 'Sales']);
		const plan = planConnectionImport([existing], [entry('PROD', { server: 'new-sql' })]);
		assert.deepStrictEqual([plan[0].sameName, plan[0].config.username, plan[0].config.server], ['prod', 'bob', 'new-sql']);
	});

	test('a connection saved as a connection string keeps all of it but its group', () => {
		const existing = { name: 'cs', useConnectionString: true, server: 'Server=a;Database=b', authType: 'sql' };
		assert.deepStrictEqual(mergeIntoExisting(existing, entry('cs', { server: 'other', group: 'G' })), { name: 'cs', useConnectionString: true, server: 'Server=a;Database=b', authType: 'sql', group: 'G' });
	});

	test('a / in a group name is not a level', () => {
		assert.strictEqual(groupPath(['Sales/EU', 'Paris']), 'Sales∕EU/Paris');
		assert.strictEqual(groupPath([]), '');
	});
});
