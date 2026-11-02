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
		assert.deepStrictEqual(parseServerAddress('np:\\\\host\\pipe\\sql\\query'), { server: '', port: '' });
		assert.deepStrictEqual(parseServerAddress('\\\\host\\pipe\\sql\\query'), { server: '', port: '' });
	});
});

suite('parseConnectionString', () => {
	test('keys are lower-cased without their spaces, quoted values and ; inside quotes are kept', () => {
		assert.deepStrictEqual(parseConnectionString('Data Source=a;Initial Catalog="x;y";Trust Server Certificate=True;TrustServerCertificate=False;'), { datasource: 'a', initialcatalog: 'x;y', trustservercertificate: 'False' });
		assert.deepStrictEqual(parseConnectionString(''), {});
		assert.deepStrictEqual(parseConnectionString(undefined), {});
	});
});

// The fixture follows the structure of the exports found in public repositories
// (SML-IF: one document per group and per server, the group in a <Parent>
// reference with percent-encoded names), not an export made on this machine.
suite('parseRegisteredServersFile', () => {
	test('reads the groups, the addresses and the way to sign in of an SSMS export', () => {
		const { entries, errors } = parseRegisteredServersFile(fixture);
		assert.deepStrictEqual(errors, []);
		assert.deepStrictEqual(entries.map(e => e.name), ['Local dev', 'ERP', 'Paris', 'Azure', 'Sandbox']);
		const all = byName(entries);
		assert.strictEqual(all['Local dev'].group, '');
		assert.deepStrictEqual([all['Local dev'].authType, all['Local dev'].encrypt, all['Local dev'].trustServerCertificate], ['windows', false, true]);
		assert.strictEqual(all.ERP.group, 'Production');
		assert.deepStrictEqual([all.ERP.server, all.ERP.port, all.ERP.database], ['erp-sql\\PROD', '14330', 'Erp']);
		assert.deepStrictEqual([all.ERP.authType, all.ERP.username, all.ERP.encrypt, all.ERP.trustServerCertificate], ['sql', 'svc_read', true, false]);
		assert.strictEqual(all.ERP.description, 'The ERP & billing');
		assert.deepStrictEqual([all.Paris.group, all.Paris.authType, all.Paris.trustServerCertificate], ['Production/Europe', 'windows', true]);
		assert.strictEqual(all.Azure.authType, 'entra');
		assert.deepStrictEqual([all.Sandbox.group, all.Sandbox.server, all.Sandbox.database], ['Production/R&D lab', 'sandbox\\SQL2022', 'Lab']);
	});

	test('no password is ever carried over', () => {
		const { entries } = parseRegisteredServersFile(fixture);
		assert.ok(!JSON.stringify(entries).includes('AQAAANCMnd8BFdERjHoAwE'));
		assert.ok(entries.every(e => !('password' in e)));
	});

	test('servers of other kinds and the recent connections are left out', () => {
		const { entries } = parseRegisteredServersFile(fixture);
		assert.ok(!entries.some(e => ['Cube', 'recent'].includes(e.name)));
	});

	test('the group comes from the Parent reference, whatever the order of the documents', () => {
		const server = (name, group) => `<RegisteredServer><Parent><Reference><Uri>/RegisteredServersStore/ServerGroup/DatabaseEngineServerGroup${group}</Uri></Reference></Parent><Name>${name}</Name><ServerName>${name}</ServerName></RegisteredServer>`;
		const { entries } = parseRegisteredServersFile(`<model>${server('b', '/ServerGroup/A%2FB/ServerGroup/C')}${server('a', '')}</model>`);
		assert.deepStrictEqual(entries.map(e => [e.name, e.group]), [['b', 'A∕B/C'], ['a', '']]);
	});

	test('AuthenticationType decides when the connection string does not say', () => {
		const server = (type, conn) => `<RegisteredServer><Name>s</Name><ServerName>h</ServerName><ConnectionStringWithEncryptedPassword>${conn}</ConnectionStringWithEncryptedPassword><AuthenticationType>${type}</AuthenticationType></RegisteredServer>`;
		const auth = (type, conn) => parseRegisteredServersFile(server(type, conn)).entries[0].authType;
		assert.deepStrictEqual([auth(0, 'data source=h'), auth(3, 'data source=h'), auth(0, 'data source=h;user id=u'), auth(0, 'data source=h;integrated security=SSPI'), auth(1, 'data source=h')], ['windows', 'entra', 'sql', 'windows', 'sql']);
	});

	test('a file that nests the servers in their group is read as well', () => {
		const { entries } = parseRegisteredServersFile('<Store><ServerGroup><Name>G</Name><RegisteredServer><Name>S</Name><ServerName>host,1500</ServerName></RegisteredServer></ServerGroup></Store>');
		assert.deepStrictEqual(entries, [{ name: 'S', server: 'host', port: '1500', database: '', group: 'G', description: '', authType: 'windows' }]);
	});

	test('the address falls back on the connection string; a server without any is skipped', () => {
		const { entries } = parseRegisteredServersFile('<S><RegisteredServer><Name>A</Name><ConnectionStringWithEncryptedPassword>server=hostA;uid=bob</ConnectionStringWithEncryptedPassword></RegisteredServer><RegisteredServer><Name>B</Name></RegisteredServer></S>');
		assert.deepStrictEqual(entries.map(e => [e.name, e.server, e.authType, e.username]), [['A', 'hostA', 'sql', 'bob']]);
	});

	test('a named pipe is reported as skipped, with its name', () => {
		const { entries, skipped, errors } = parseRegisteredServersFile('<S><RegisteredServer><Name>Pipe</Name><ServerName>np:\\\\host\\pipe\\sql\\query</ServerName></RegisteredServer></S>');
		assert.deepStrictEqual([entries, errors], [[], []]);
		assert.deepStrictEqual(skipped.map(s => s.name), ['Pipe']);
	});

	test('a file that is not a registered servers export says so', () => {
		for (const text of ['', 'plain text', '<html><body>hi</body></html>']) {
			const { entries, errors } = parseRegisteredServersFile(text);
			assert.deepStrictEqual(entries, []);
			assert.strictEqual(errors.length, 1, JSON.stringify(text));
		}
	});
});
