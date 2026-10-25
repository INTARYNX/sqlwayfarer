const assert = require('assert');
const { connectionIdentity } = require('../database/connectionIdentity');

suite('connectionIdentity', () => {
	test('same server+port+login is the same identity regardless of casing', () => {
		const a = connectionIdentity({ server: 'MyServer', port: '1433', username: 'SA' });
		const b = connectionIdentity({ server: 'myserver', port: '1433', username: 'sa' });
		assert.strictEqual(a, b);
	});

	test('a different starting database does not change identity - switching database does not open a new connection', () => {
		const a = connectionIdentity({ server: 'srv', port: '1433', username: 'sa', database: 'Db1' });
		const b = connectionIdentity({ server: 'srv', port: '1433', username: 'sa', database: 'Db2' });
		assert.strictEqual(a, b);
	});

	test('a different server, port or login is a different identity', () => {
		const base = connectionIdentity({ server: 'srv', port: '1433', username: 'sa' });
		assert.notStrictEqual(connectionIdentity({ server: 'other', port: '1433', username: 'sa' }), base);
		assert.notStrictEqual(connectionIdentity({ server: 'srv', port: '1434', username: 'sa' }), base);
		assert.notStrictEqual(connectionIdentity({ server: 'srv', port: '1433', username: 'nicolas' }), base);
	});

	test('Windows auth (no username) still produces a stable identity, distinct from a SQL login on the same server', () => {
		const windowsAuth = connectionIdentity({ server: 'srv', port: '1433' });
		const sqlLogin = connectionIdentity({ server: 'srv', port: '1433', username: 'sa' });
		assert.ok(windowsAuth);
		assert.notStrictEqual(windowsAuth, sqlLogin);
	});

	test('no server means no identity', () => {
		assert.strictEqual(connectionIdentity({ username: 'sa' }), null);
		assert.strictEqual(connectionIdentity(null), null);
	});
});
