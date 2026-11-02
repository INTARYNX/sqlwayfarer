const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseRegisteredServersFile, parseConnectionString } = require('../database/regsrvrImport');
const { parseServerAddress } = require('../database/serverAddress');

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'registered-servers.regsrvr'), 'utf8');
const byName = entries => Object.fromEntries(entries.map(e => [e.name, e]));

suite('parseServerAddress', () => {
	test('host, instance, port and protocol prefix', () => {
		assert.deepStrictEqual(parseServerAddress('localhost'), { server: 'localhost', port: '' });
		assert.deepStrictEqual(parseServerAddress('host\\SQL2019'), { server: 'host\\SQL2019', port: '' });
		assert.deepStrictEqual(parseServerAddress('host,1444'), { server: 'host', port: '1444' });
		assert.deepStrictEqual(parseServerAddress(' tcp:host\\INST,14330 '), { server: 'host\\INST', port: '14330' });
		assert.deepStrictEqual(parseServerAddress('host,notaport'), { server: 'host,notaport', port: '' });
		assert.deepStrictEqual(parseServerAddress(undefined), { server: '', port: '' });
	});
});

suite('parseConnectionString', () => {
	test('keys are lower-cased, quoted values and ; inside quotes are kept', () => {
		assert.deepStrictEqual(parseConnectionString('Data Source=a;Initial Catalog="x;y";Encrypt=True;'), { 'data source': 'a', 'initial catalog': 'x;y', encrypt: 'True' });
		assert.deepStrictEqual(parseConnectionString(''), {});
		assert.deepStrictEqual(parseConnectionString(undefined), {});
	});
});

suite('parseRegisteredServersFile', () => {
	test('reads the groups, the addresses and the way to sign in of an SSMS export', () => {
		const { entries, errors } = parseRegisteredServersFile(fixture);
		assert.deepStrictEqual(errors, []);
		assert.deepStrictEqual(entries.map(e => e.name), ['Local dev', 'ERP', 'Paris', 'Azure']);
		const all = byName(entries);
		assert.strictEqual(all['Local dev'].group, '');
		assert.strictEqual(all['Local dev'].authType, 'windows');
		assert.strictEqual(all['Local dev'].encrypt, false);
		assert.strictEqual(all['Local dev'].trustServerCertificate, true);
		assert.strictEqual(all.ERP.group, 'Production');
		assert.deepStrictEqual([all.ERP.server, all.ERP.port, all.ERP.database], ['erp-sql\\PROD', '14330', 'Erp']);
		assert.deepStrictEqual([all.ERP.authType, all.ERP.username, all.ERP.encrypt, all.ERP.trustServerCertificate], ['sql', 'svc_read', true, false]);
		assert.strictEqual(all.ERP.description, 'The ERP & billing');
		assert.strictEqual(all.Paris.group, 'Production/Europe');
		assert.strictEqual(all.Azure.authType, 'entra');
	});

	test('no password is ever carried over', () => {
		const { entries } = parseRegisteredServersFile(fixture);
		assert.ok(!JSON.stringify(entries).includes('AQAAANCMnd8BFdERjHoAwE'));
		assert.ok(entries.every(e => !('password' in e)));
	});

	test('servers of other kinds (Analysis Services...) are left out', () => {
		const { entries } = parseRegisteredServersFile(fixture);
		assert.ok(!entries.some(e => e.name === 'Cube'));
	});

	test('a file with the plain minimum is read', () => {
		const { entries } = parseRegisteredServersFile('<Store><ServerGroup><Name>G</Name><RegisteredServer><Name>S</Name><ServerName>host,1500</ServerName></RegisteredServer></ServerGroup></Store>');
		assert.deepStrictEqual(entries, [{ name: 'S', server: 'host', port: '1500', database: '', group: 'G', description: '', authType: 'windows' }]);
	});

	test('the address falls back on the connection string; a server without any is skipped', () => {
		const { entries } = parseRegisteredServersFile('<S><RegisteredServer><Name>A</Name><ConnectionStringWithEncryptedPassword>server=hostA;uid=bob</ConnectionStringWithEncryptedPassword></RegisteredServer><RegisteredServer><Name>B</Name></RegisteredServer></S>');
		assert.deepStrictEqual(entries.map(e => [e.name, e.server, e.authType, e.username]), [['A', 'hostA', 'sql', 'bob']]);
	});

	test('a file that is not a registered servers export says so', () => {
		for (const text of ['', 'plain text', '<html><body>hi</body></html>']) {
			const { entries, errors } = parseRegisteredServersFile(text);
			assert.deepStrictEqual(entries, []);
			assert.strictEqual(errors.length, 1, JSON.stringify(text));
		}
	});
});
