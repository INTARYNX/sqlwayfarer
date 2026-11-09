const assert = require('assert');
const { readRecentChanges, readDefinition, buildItems, KINDS } = require('../database/recentChanges');

const row = (extra) => Object.assign({ schema_name: 'dbo', object_name: 'T', type_code: 'U ', created: '2026-11-03 09:00:00', modified: '2026-11-03 10:00:00', created_age: 7200, modified_age: 3600, is_altered: 1, created_in_period: 0, parent_schema: null, parent_name: null }, extra);

function manager(sets, log = []) {
	return {
		acquireConnection: async () => ({
			createRequest: () => ({ batch: async text => { log.push(text); if (text.startsWith('USE [master]')) return {}; if (sets instanceof Error) throw sets; return { recordsets: sets }; } }),
			release: () => log.push('release')
		})
	};
}

suite('recentChanges.buildItems', () => {
	test('each object is a kind, new or altered, with its dates and ages', () => {
		const items = buildItems([
			row({ is_altered: 0, created_in_period: 1, created_age: 600, modified_age: 600 }),
			row({ object_name: 'p', type_code: 'P ' }),
			row({ object_name: 'f', type_code: 'IF' }),
			row({ object_name: 'CK_T', type_code: 'C ', parent_schema: 'dbo', parent_name: 'T' })
		]);
		assert.deepStrictEqual(items.map(i => `${i.kind}:${i.name}:${i.status}`), ['table:T:new', 'procedure:p:altered', 'function:f:altered', 'constraint:CK_T:altered']);
		assert.deepStrictEqual([items[0].created, items[0].modified, items[0].createdAge, items[0].modifiedAge], ['2026-11-03 09:00:00', '2026-11-03 10:00:00', 600, 600]);
		assert.deepStrictEqual(items.map(i => i.createdInPeriod), [true, false, false, false]);
		assert.strictEqual(items[3].parent, 'dbo.T');
		assert.strictEqual(items[0].parent, null);
	});

	test('what is not one of the kinds is ignored', () => {
		assert.deepStrictEqual(buildItems([row({ type_code: 'S ' }), row({ type_code: 'IT' })]), []);
		assert.ok(['table', 'view', 'procedure', 'function', 'trigger', 'constraint', 'synonym', 'sequence'].every(k => Object.values(KINDS).includes(k)));
	});
});

suite('recentChanges.readRecentChanges', () => {
	test('one batch in the database, the period worked out by the server, the connection put back in master', async () => {
		const log = [];
		const result = await readRecentChanges(manager([[row()], [{ server_time: '2026-11-03 11:00:00' }]], log), 'My]Db', 180);
		assert.ok(log[0].startsWith('USE [My]]Db];'));
		assert.ok(log[0].includes('DATEADD(MINUTE, -180, GETDATE())'));
		assert.ok(log[0].includes('sys.objects') && !log[0].includes('sys.sql_modules'));
		assert.strictEqual(log[1], 'USE [master]');
		assert.strictEqual(log[2], 'release');
		assert.deepStrictEqual([result.database, result.minutes, result.serverTime, result.items.length, result.truncated], ['My]Db', 180, '2026-11-03 11:00:00', 1, false]);
	});

	test('since a snapshot: the start is the creation date of the snapshot of this database, read by the server', async () => {
		const log = [];
		const result = await readRecentChanges(manager([[row()], [{ server_time: '2026-11-03 11:00:00', since: '2026-11-03 08:00:00' }]], log), 'My]Db', undefined, "Snap'1");
		assert.ok(log[0].startsWith('USE [My]]Db];'));
		assert.ok(log[0].includes("FROM sys.databases WHERE name = N'Snap''1' AND source_database_id = DB_ID(N'My]Db')"), 'the name is a literal, quotes doubled');
		assert.ok(!log[0].includes('DATEADD'));
		assert.ok(log[0].includes('THROW 50000'), 'a snapshot that is gone is an error');
		assert.deepStrictEqual([result.snapshot, result.minutes, result.since, result.items.length], ["Snap'1", null, '2026-11-03 08:00:00', 1]);
		// The last minutes do not need one.
		assert.strictEqual((await readRecentChanges(manager([[], [{}]]), 'Db', 60)).snapshot, null);
	});

	test('a period that is not a whole positive number of minutes is refused, before anything is read', async () => {
		const log = [];
		for (const bad of [0, -5, 'x', NaN, null, 600000, '1; DROP TABLE t']) await assert.rejects(readRecentChanges(manager([[], []], log), 'Db', bad), /not valid/);
		assert.strictEqual(log.length, 0);
		await readRecentChanges(manager([[], [{}]], log), 'Db', '90');
		assert.ok(log[0].includes('-90,'));
	});

	test('more than the limit is cut and said', async () => {
		const rows = Array.from({ length: 5001 }, (_, i) => row({ object_name: `t${i}` }));
		const result = await readRecentChanges(manager([rows, [{ server_time: 'x' }]]), 'Db', 60);
		assert.strictEqual(result.items.length, 5000);
		assert.strictEqual(result.truncated, true);
	});

	test('a failure still puts the connection back', async () => {
		const log = [];
		await assert.rejects(readRecentChanges(manager(new Error('denied'), log), 'Db', 60), /denied/);
		assert.ok(log.includes('USE [master]') && log.includes('release'));
	});
});

suite('recentChanges.readDefinition', () => {
	test('the name is quoted into one literal, and the connection goes back to master', async () => {
		const log = [];
		const text = await readDefinition(manager([[{ definition: 'CREATE VIEW v AS SELECT 1' }]], log), 'Db', "s]'", "we]ird'name");
		assert.strictEqual(text, 'CREATE VIEW v AS SELECT 1');
		assert.ok(log[0].includes("OBJECT_ID(N'[s]]''].[we]]ird''name]')"));
		assert.deepStrictEqual(log.slice(1), ['USE [master]', 'release']);
	});

	test('nothing there is null', async () => {
		assert.strictEqual(await readDefinition(manager([[]]), 'Db', 'dbo', 'x'), null);
		assert.strictEqual(await readDefinition(manager([[{ definition: null }]]), 'Db', 'dbo', 'x'), null);
	});
});
