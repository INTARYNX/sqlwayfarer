const assert = require('assert');
const { snapshotName, sparsePath, buildCreateSnapshot, evaluateSupport, getSnapshotSupport, listSnapshots, planSnapshot, createSnapshot, dropSnapshot } = require('../database/dbSnapshots');

const NOW = new Date(2026, 10, 3, 9, 5, 7);
const OK_ROW = { engine: 3, version: '16.0.4305.5', database_id: 7, source_database_id: null, state_desc: 'ONLINE', filestream_files: 0 };

// A connection manager that answers by what the query is about.
function fakeManager(answers, log = []) {
	return {
		executeQueryInDatabase: async (database, sql, params) => {
			log.push({ database, sql, params });
			for (const [needle, answer] of Object.entries(answers)) {
				if (sql.includes(needle)) {
					if (answer instanceof Error) throw answer;
					return { recordset: typeof answer === 'function' ? answer(params) : answer };
				}
			}
			return { recordset: [] };
		}
	};
}

suite('dbSnapshots: names and paths', () => {
	test('the name is the database, _ref_, and the date and time', () => {
		assert.strictEqual(snapshotName('Sales', NOW), 'Sales_ref_20261103_090507');
	});

	test('a name already taken gets a number, whatever the case', () => {
		assert.strictEqual(snapshotName('Sales', NOW, new Set(['SALES_REF_20261103_090507'])), 'Sales_ref_20261103_090507_2');
		assert.strictEqual(snapshotName('Sales', NOW, new Set(['Sales_ref_20261103_090507', 'Sales_ref_20261103_090507_2'])), 'Sales_ref_20261103_090507_3');
	});

	test('a long database name is cut so that the whole stays within 128 characters', () => {
		const name = snapshotName('x'.repeat(200), NOW, new Set(['x']));
		assert.ok(name.length <= 128, String(name.length));
		assert.ok(name.endsWith('_ref_20261103_090507'));
	});

	test('the sparse file goes next to the data file, with the separator of its system', () => {
		assert.strictEqual(sparsePath('C:\\Data\\Sales.mdf', 'Sales_ref', 'Sales'), 'C:\\Data\\Sales_ref_Sales.ss');
		assert.strictEqual(sparsePath('/var/opt/mssql/data/Sales.mdf', 'Sales_ref', 'Sales'), '/var/opt/mssql/data/Sales_ref_Sales.ss');
		assert.strictEqual(sparsePath('/d/x.mdf', 'S', 'a:b*c'), '/d/S_a_b_c.ss');
	});

	test('the statement names every file and quotes what needs it', () => {
		const sql = buildCreateSnapshot('Sales_ref', "Sa]les", [{ logicalName: 'Sales', path: '/d/S.ss' }, { logicalName: "It's", path: "/d/I't.ss" }]);
		assert.strictEqual(sql, "CREATE DATABASE [Sales_ref] ON\n    (NAME = N'Sales', FILENAME = N'/d/S.ss'),\n    (NAME = N'It''s', FILENAME = N'/d/I''t.ss')\nAS SNAPSHOT OF [Sa]]les];");
	});
});

suite('dbSnapshots: can a snapshot be taken?', () => {
	test('a normal database of Enterprise-class or a recent Standard server, yes', () => {
		assert.deepStrictEqual(evaluateSupport(OK_ROW), { supported: true });
		assert.deepStrictEqual(evaluateSupport(Object.assign({}, OK_ROW, { engine: 2, version: '13.0.4001.0' })), { supported: true });
		assert.deepStrictEqual(evaluateSupport(Object.assign({}, OK_ROW, { engine: 3, version: '10.50.6000.34' })), { supported: true });
	});

	test('each reason is said in words', () => {
		const reason = extra => evaluateSupport(Object.assign({}, OK_ROW, extra)).reason;
		assert.ok(/Azure SQL Database/.test(reason({ engine: 5 })));
		assert.ok(/Managed Instance/.test(reason({ engine: 8 })));
		assert.ok(/system database/.test(reason({ database_id: 2 })));
		assert.ok(/snapshot already/.test(reason({ source_database_id: 9 })));
		assert.ok(/offline/.test(reason({ state_desc: 'OFFLINE' })));
		assert.ok(/FILESTREAM/.test(reason({ filestream_files: 1 })));
		assert.ok(/Enterprise/.test(reason({ engine: 2, version: '12.0.6024.0' })));
		assert.ok(/does not exist/.test(evaluateSupport(undefined).reason));
	});

	test('it asks the server about the database by name', async () => {
		const log = [];
		const support = await getSnapshotSupport(fakeManager({ 'FROM sys.databases d WHERE': [OK_ROW] }, log), 'Sales');
		assert.deepStrictEqual(support, { supported: true });
		assert.deepStrictEqual(log[0].params, { name: 'Sales' });
		assert.deepStrictEqual((await getSnapshotSupport(fakeManager({}), 'Nope')).supported, false);
	});
});

suite('dbSnapshots: plan, create, list, drop', () => {
	const answers = {
		'FROM sys.databases d WHERE': [OK_ROW],
		'SELECT name FROM sys.databases': [{ name: 'Sales' }],
		'FROM sys.master_files f': [{ name: 'Sales', physical_name: 'C:\\Data\\Sales.mdf' }, { name: 'Sales_2', physical_name: 'D:\\More\\Sales_2.ndf' }]
	};

	test('the plan names the snapshot, its files and the statement, and runs nothing', async () => {
		const log = [];
		const plan = await planSnapshot(fakeManager(answers, log), 'Sales', NOW);
		assert.strictEqual(plan.name, 'Sales_ref_20261103_090507');
		assert.deepStrictEqual(plan.files.map(f => f.path), ['C:\\Data\\Sales_ref_20261103_090507_Sales.ss', 'D:\\More\\Sales_ref_20261103_090507_Sales_2.ss']);
		assert.ok(plan.sql.startsWith('CREATE DATABASE [Sales_ref_20261103_090507] ON'));
		assert.ok(!log.some(l => /^CREATE DATABASE/.test(l.sql.trim())));
	});

	test('no plan when the snapshot cannot be taken, and the reason is the error', async () => {
		await assert.rejects(planSnapshot(fakeManager(Object.assign({}, answers, { 'FROM sys.databases d WHERE': [Object.assign({}, OK_ROW, { database_id: 1 })] })), 'master', NOW), /system database/);
	});

	test('creating runs the planned statement in master and gives the name back', async () => {
		const log = [];
		const plan = await planSnapshot(fakeManager(answers), 'Sales', NOW);
		assert.strictEqual(await createSnapshot(fakeManager({}, log), plan), plan.name);
		assert.deepStrictEqual([log[0].database, log[0].sql], ['master', plan.sql]);
	});

	test('the list, newest first, for one database or all', async () => {
		const log = [];
		const date = new Date();
		const list = await listSnapshots(fakeManager({ 'source_database_id IS NOT NULL': [{ name: 'S_ref', source: 'S', create_date: date, state_desc: 'ONLINE' }] }, log), 'S');
		assert.deepStrictEqual(list, [{ name: 'S_ref', source: 'S', createDate: date, state: 'ONLINE' }]);
		assert.deepStrictEqual(log[0].params, { source: 'S' });
		await listSnapshots(fakeManager({}, log));
		assert.deepStrictEqual(log[1].params, { source: null });
	});

	test('dropping a snapshot drops it, and only a snapshot', async () => {
		const log = [];
		const manager = fakeManager({ 'source_database_id IS NOT NULL': [{ name: 'S_ref', source: 'S', create_date: new Date(), state_desc: 'ONLINE' }] }, log);
		await dropSnapshot(manager, 's_REF');
		assert.strictEqual(log[log.length - 1].sql, 'DROP DATABASE [S_ref]');
		await assert.rejects(dropSnapshot(manager, 'Sales'), /not a database snapshot/);
		assert.ok(!log.some(l => l.sql === 'DROP DATABASE [Sales]'));
	});

	test('a session of our own pool in the snapshot is moved to master, and the drop tried again', async () => {
		const busy = Object.assign(new Error('in use'), { number: 3702 });
		const log = [];
		let attempts = 0;
		const manager = fakeManager({ 'source_database_id IS NOT NULL': [{ name: 'S_ref', source: 'S', create_date: new Date(), state_desc: 'ONLINE' }] }, log);
		const original = manager.executeQueryInDatabase;
		manager.executeQueryInDatabase = async (db, sql, params) => {
			if (sql.startsWith('DROP DATABASE') && attempts++ === 0) throw busy;
			return original(db, sql, params);
		};
		manager.resetPoolContext = async () => { log.push({ sql: 'reset' }); };
		await dropSnapshot(manager, 'S_ref');
		assert.strictEqual(attempts, 2);
		assert.ok(log.some(l => l.sql === 'reset'));
	});

	test('a snapshot that a session is in says so', async () => {
		const busy = Object.assign(new Error('in use'), { number: 3702 });
		const manager = fakeManager({ 'source_database_id IS NOT NULL': [{ name: 'S_ref', source: 'S', create_date: new Date(), state_desc: 'ONLINE' }], 'DROP DATABASE': busy });
		await assert.rejects(dropSnapshot(manager, 'S_ref'), /in use by a connection/);
	});
});
