const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { SspiPool } = require('../database/SspiPool');

const FAKE_HELPER = path.join(__dirname, 'fixtures', 'fakeSspiHelper.js');
const fakeSpawn = (_helperPath, _args, options) => spawn(process.execPath, [FAKE_HELPER], options);

async function connectedPool(config = { server: 'srv', requestTimeout: 300000 }) {
	return new SspiPool(config, 'unused', fakeSpawn, 'win32').connect();
}

suite('SspiPool', () => {
	let pool;
	teardown(async () => {
		if (pool) await pool.close();
		pool = null;
	});

	test('refuses to run outside Windows', async () => {
		await assert.rejects(
			new SspiPool({ server: 'srv' }, 'unused', fakeSpawn, 'linux').connect(),
			/only available on Windows/);
	});

	test('a missing helper is reported as such', async () => {
		await assert.rejects(
			new SspiPool({ server: 'srv' }, path.join(__dirname, 'nope.exe'), spawn, 'win32').connect(),
			/helper was not found/);
	});

	test('a refused login rejects connect() with the server message', async () => {
		await assert.rejects(
			new SspiPool({ server: 'badlogin' }, 'unused', fakeSpawn, 'win32').connect(),
			error => error.code === 'ELOGIN' && /Login failed/.test(error.message) && error.number === 18456);
	});

	test('query() returns recordsets with dates and binaries decoded', async () => {
		pool = await connectedPool();
		const result = await pool.request().query('SELECT');
		assert.strictEqual(result.recordset.length, 2);
		assert.deepStrictEqual(Object.keys(result.recordset.columns), ['a', 'd', 'b']);
		assert.strictEqual(result.recordset[0].a, 1);
		assert.ok(result.recordset[0].d instanceof Date);
		assert.strictEqual(result.recordset[0].d.toISOString(), '2020-01-02T03:04:05.000Z');
		assert.deepStrictEqual([...result.recordset[0].b], [1, 2]);
		assert.strictEqual(result.recordset[1].d, null);
		assert.deepStrictEqual(result.rowsAffected, [2]);
	});

	test('stream mode emits recordset, row, info and rowsaffected', async () => {
		pool = await connectedPool();
		const request = pool.request();
		request.stream = true;
		const seen = [];
		request.on('recordset', columns => seen.push(['recordset', Object.keys(columns)]));
		request.on('row', row => seen.push(['row', row.a]));
		request.on('info', info => seen.push(['info', info.message]));
		request.on('rowsaffected', count => seen.push(['rowsaffected', count]));
		await request.query('SELECT');
		assert.deepStrictEqual(seen, [
			['recordset', ['a', 'd', 'b']], ['row', 1], ['row', 2], ['rowsaffected', 2], ['info', 'hello']
		]);
	});

	test('stream mode by position gives one column entry per column, and the values in order, decoded', async () => {
		pool = await connectedPool();
		const request = pool.request();
		request.stream = true;
		request.arrayRowMode = true;
		const seen = [];
		request.on('recordset', columns => seen.push(['recordset', columns.map(c => c.name), columns.map(c => c.index)]));
		request.on('row', row => seen.push(['row', Array.isArray(row), row[0], row[1] instanceof Date || row[1]]));
		await request.query('SELECT');
		assert.deepStrictEqual(seen.slice(0, 3), [
			['recordset', ['a', 'd', 'b'], [0, 1, 2]], ['row', true, 1, true], ['row', true, 2, null]
		]);
	});

	test('a SQL error rejects with its number and line', async () => {
		pool = await connectedPool();
		await assert.rejects(pool.request().query('ERROR'),
			error => error.number === 208 && error.lineNumber === 3 && error.message === 'Invalid object name');
	});

	test('stream mode reports a SQL error as an event and a rejection', async () => {
		pool = await connectedPool();
		const request = pool.request();
		request.stream = true;
		const events = [];
		request.on('error', error => events.push(error.message));
		await assert.rejects(request.query('ERROR'));
		assert.deepStrictEqual(events, ['Invalid object name']);
	});

	test('cancel() ends a running query', async () => {
		pool = await connectedPool();
		const request = pool.request();
		const running = request.query('SLOW');
		setTimeout(() => request.cancel(), 50);
		await assert.rejects(running, /cancelled/);
	});

	test('input() values keep their types on the wire', async () => {
		pool = await connectedPool();
		const request = pool.request();
		request.input('s', 'x').input('i', 5).input('f', 1.5).input('b', true).input('n', null);
		const result = await request.query('PARAMS');
		assert.deepStrictEqual(JSON.parse(result.recordset[0].p).map(p => [p.name, p.type]),
			[['s', 'nvarchar'], ['i', 'int'], ['f', 'float'], ['b', 'bit'], ['n', 'nvarchar']]);
	});

	test('acquireSession() pins every request to the same session', async () => {
		pool = await connectedPool();
		const pinned = await pool.acquireSession();
		const first = await pinned.createRequest().query('SESSION');
		const second = await pinned.createRequest().query('SESSION');
		assert.strictEqual(first.recordset[0].s, second.recordset[0].s);

		// While it is held, an ordinary request gets another session.
		const other = await pool.request().query('SESSION');
		assert.notStrictEqual(other.recordset[0].s, first.recordset[0].s);
		pinned.release();
	});

	test('a crashed helper fails the running query, then is replaced', async () => {
		pool = await connectedPool();
		await assert.rejects(pool.request().query('DIE'), /stopped unexpectedly/);
		const result = await pool.request().query('SELECT');
		assert.strictEqual(result.recordset.length, 2);
	});

	test('a crash releases the requests waiting for a session', async () => {
		pool = await connectedPool();
		const held = [];
		for (let i = 0; i < 8; i++) held.push(await pool.acquireSession());
		const waiting = pool.request().query('SELECT');
		const dying = held[0].createRequest().query('DIE');
		await assert.rejects(dying, /stopped unexpectedly/);
		await assert.rejects(waiting, /stopped unexpectedly/);
		held.forEach(session => session.release());
		const result = await pool.request().query('SELECT');
		assert.strictEqual(result.recordset.length, 2);
	});

	test('close() stops the helper', async () => {
		pool = await connectedPool();
		await pool.close();
		assert.strictEqual(pool.connected, false);
		await assert.rejects(pool.request().query('SELECT'), /closed/);
	});
});
