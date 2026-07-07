const assert = require('assert');
const ConnectionManager = require('../database/ConnectionManager');

function manager(storedPassword = null) {
	return new ConnectionManager({
		getConnectionPassword: async () => storedPassword,
		getConnection: () => null
	});
}

suite('ConnectionManager.buildConnectionConfig', () => {
	test('SQL login: user and password passed through', async () => {
		const config = await manager().buildConnectionConfig({
			server: 'srv', username: 'sa', password: 'pw'
		});
		assert.strictEqual(config.user, 'sa');
		assert.strictEqual(config.password, 'pw');
		assert.strictEqual(config.domain, undefined);
	});

	test('Windows login: DOMAIN\\user is split so tedious uses NTLM', async () => {
		const config = await manager().buildConnectionConfig({
			server: 'srv', username: 'CONTOSO\\nicolas', password: 'pw'
		});
		assert.strictEqual(config.domain, 'CONTOSO');
		assert.strictEqual(config.user, 'nicolas');
		assert.strictEqual(config.password, 'pw');
	});

	test('username without domain separator sets no domain', async () => {
		const config = await manager().buildConnectionConfig({
			server: 'srv', username: 'nicolas', password: 'pw'
		});
		assert.strictEqual(config.domain, undefined);
		assert.strictEqual(config.user, 'nicolas');
	});

	test('port is converted to a number', async () => {
		const config = await manager().buildConnectionConfig({
			server: 'srv', port: '1434'
		});
		assert.strictEqual(config.port, 1434);
	});

	test('requestTimeout overrides the 15s mssql default', async () => {
		const config = await manager().buildConnectionConfig({ server: 'srv' });
		assert.strictEqual(config.requestTimeout, 300000);
	});

	test('encrypt and trustServerCertificate land in options', async () => {
		const config = await manager().buildConnectionConfig({
			server: 'srv', encrypt: false, trustServerCertificate: true
		});
		assert.strictEqual(config.options.encrypt, false);
		assert.strictEqual(config.options.trustServerCertificate, true);
	});
});
