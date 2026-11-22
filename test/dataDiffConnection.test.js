const assert = require('assert');
const { compareTableData } = require('../database/dataDiff');

// A table with a single-column key, two plain compared columns.
const TABLE = { schema: 'dbo', name: 'T', key: ['id'], columns: ['id', 'name', 'amount'], columnTypes: { id: 'int', name: 'nvarchar(50)', amount: 'decimal(10,2)' } };

// Fakes the two kinds of batch this module sends: the hash pass (one row per
// key, with a stand-in "hash" good enough to tell rows apart - this test does
// not exercise HASHBYTES itself, only how compareTableData uses what comes
// back) and the full-row fetch (every row of the database: compareTableData
// only ever looks up the keys it asked for, so filtering by WHERE is not
// needed to make the fake honest).
function fakeManager(data) {
	let db = null;
	return {
		acquireConnection: async () => ({
			createRequest: () => ({
				batch: async sql => {
					const use = /^USE \[(.*?)\];/.exec(sql);
					if (use) db = use[1];
					const rows = data[db] || [];
					if (!/SELECT/.test(sql)) return { recordsets: [[]] };
					if (/HASHBYTES/.test(sql)) {
						return { recordsets: [rows.map(r => ({ id: r.id, __hash: Buffer.from(JSON.stringify([r.name, r.amount])) }))] };
					}
					return { recordsets: [rows] };
				}
			}),
			release: () => {}
		})
	};
}

suite('dataDiff: compareTableData', () => {
	test('added, removed and modified rows are told apart by their hash', async () => {
		const manager = fakeManager({
			ref: [{ id: 1, name: 'Alice', amount: 10 }, { id: 2, name: 'Bob', amount: 20 }],
			cur: [{ id: 1, name: 'Alice', amount: 10 }, { id: 2, name: 'Bobby', amount: 20 }, { id: 3, name: 'Carl', amount: 30 }]
		});
		const result = await compareTableData(manager, { reference: 'ref', database: 'cur', table: TABLE });
		assert.deepStrictEqual(result.counts, { added: 1, modified: 1, removed: 0, same: 1 });
		assert.deepStrictEqual(result.added.map(r => r.id), [3]);
		assert.deepStrictEqual(result.removed, []);
		assert.strictEqual(result.modified.length, 1);
		assert.deepStrictEqual(result.modified[0].key, [2]);
		assert.deepStrictEqual(result.modified[0].changedColumns, ['name']);
		assert.strictEqual(result.modified[0].before.name, 'Bob');
		assert.strictEqual(result.modified[0].after.name, 'Bobby');
	});

	test('a row only in the reference is removed', async () => {
		const manager = fakeManager({
			ref: [{ id: 1, name: 'Alice', amount: 10 }],
			cur: []
		});
		const result = await compareTableData(manager, { reference: 'ref', database: 'cur', table: TABLE });
		assert.deepStrictEqual(result.counts, { added: 0, modified: 0, removed: 1, same: 0 });
		assert.deepStrictEqual(result.removed.map(r => r.id), [1]);
	});

	test('identical rows on both sides: nothing added, removed or modified', async () => {
		const rows = [{ id: 1, name: 'Alice', amount: 10 }];
		const manager = fakeManager({ ref: rows, cur: rows });
		const result = await compareTableData(manager, { reference: 'ref', database: 'cur', table: TABLE });
		assert.deepStrictEqual(result.counts, { added: 0, modified: 0, removed: 0, same: 1 });
		assert.strictEqual(result.truncated, false);
	});
});
