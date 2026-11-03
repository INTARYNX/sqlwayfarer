const assert = require('assert');
const { parseServerAddress, serverForDriver } = require('../database/serverAddress');

suite('serverAddress', () => {
	test('the forms SSMS writes are split into server and port', () => {
		assert.deepStrictEqual(parseServerAddress('host'), { server: 'host', port: '' });
		assert.deepStrictEqual(parseServerAddress('host\\inst'), { server: 'host\\inst', port: '' });
		assert.deepStrictEqual(parseServerAddress('tcp:host,1433'), { server: 'host', port: '1433' });
		assert.deepStrictEqual(parseServerAddress('host, 1433'), { server: 'host', port: '1433' });
		assert.deepStrictEqual(parseServerAddress('np:\\\\host\\pipe\\sql\\query'), { server: '', port: '' });
	});

	test('serverForDriver: the local machine and a bracketed IPv6', () => {
		assert.strictEqual(serverForDriver('.'), 'localhost');
		assert.strictEqual(serverForDriver('(LOCAL)'), 'localhost');
		assert.strictEqual(serverForDriver('(local)\\INST'), 'localhost\\INST');
		assert.strictEqual(serverForDriver('[fe80::1]'), 'fe80::1');
		assert.strictEqual(serverForDriver(' host '), 'host');
		assert.strictEqual(serverForDriver('host.example.com'), 'host.example.com');
		assert.strictEqual(serverForDriver('.hidden-host'), '.hidden-host', 'only the bare dot is the local machine');
		assert.strictEqual(serverForDriver(undefined), '');
	});
});
