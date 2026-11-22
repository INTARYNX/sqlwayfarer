const assert = require('assert');
const DataCompareHandlers = require('../panels/handlers/DataCompareHandlers');
const CompareHandlers = require('../panels/handlers/CompareHandlers');

const NOW = new Date(2026, 10, 3, 9, 5, 7);

// A COLUMNS_QUERY row for a plain int/nvarchar/decimal column of table T.
function columnRow(name, type_name, column_id, extra = {}) {
	const sized = { nvarchar: { max_length: 100 }, decimal: { precision: 10, scale: 2 } }[type_name] || {};
	return Object.assign({
		schema_name: 'dbo', table_name: 'T', column_id, column_name: name, type_name, is_user_defined: 0, type_schema: 'sys',
		max_length: 4, precision: 10, scale: 0, is_nullable: 1,
		is_identity: 0, seed: null, increment: null, is_computed: 0, computed_definition: null, is_persisted: null, collation_name: null,
		default_name: null, default_definition: null, default_system_named: null
	}, sized, extra);
}

const COLUMNS = [columnRow('id', 'int', 1, { is_nullable: 0 }), columnRow('name', 'nvarchar', 2), columnRow('amount', 'decimal', 3)];
const INDEXES = [{
	schema_name: 'dbo', table_name: 'T', index_id: 1, index_name: 'PK', type_desc: 'CLUSTERED',
	is_unique: 1, is_primary_key: 1, is_unique_constraint: 0, has_filter: 0, filter_definition: null, is_disabled: 0,
	constraint_system_named: 0, key_ordinal: 1, is_descending_key: 0, is_included_column: 0, column_name: 'id'
}];

// A server with one table dbo.T(id PK, name, amount) in every database named
// in `rows`, each with its own data. `rowCounts` feeds the best-effort row
// count query; a database left out of it behaves as if VIEW DATABASE STATE
// were missing (no count).
function fakeManager({ rows = {}, version = '16.0.1000.6', rowCounts = {} } = {}) {
	return {
		getServerName: () => 'srv',
		connectWithSaved: async () => {},
		dispose: async () => {},
		acquireConnection: async () => {
			let db = null;
			return {
				createRequest: () => ({
					batch: async text => {
						const use = /^USE \[(.*?)\]/.exec(text);
						if (use) db = use[1];
						if (/HASHBYTES/.test(text)) {
							return { recordsets: [(rows[db] || []).map(r => ({ id: r.id, __hash: Buffer.from(JSON.stringify([r.name, r.amount])) }))] };
						}
						if (/WHERE \[id\]/.test(text)) return { recordsets: [rows[db] || []] };
						if (!use || !/SELECT/.test(text)) return { recordsets: [[]] };
						return { recordsets: [[{ version, collation: 'C' }], [], COLUMNS, INDEXES, [], [], [], []] };
					}
				}),
				release: () => {}
			};
		},
		executeQueryInDatabase: async (database, sql) => {
			if (/dm_db_partition_stats/.test(sql) && rowCounts[database] !== undefined) {
				return { recordset: [{ schema_name: 'dbo', object_name: 'T', row_count: rowCounts[database] }] };
			}
			return { recordset: [] };
		}
	};
}

function setup(options = {}, answers = {}) {
	const posts = [];
	const confirmed = [];
	const manager = fakeManager(options);
	const schemaCompare = new CompareHandlers(() => {}, {
		connectionManager: manager, confirm: async () => true, now: () => NOW,
		connectionStorage: { getSavedConnections: () => [] }, getOwnName: () => 'Me'
	});
	const handlers = new DataCompareHandlers(m => posts.push(m), {
		connectionManager: manager, schemaCompare,
		confirm: async (message, detail, action) => { confirmed.push({ message, detail, action }); return answers.confirm !== false; },
		now: () => NOW, saveFile: options.saveFile, writeFile: options.writeFile
	});
	return { handlers, posts, confirmed };
}

suite('DataCompareHandlers', () => {
	test('a database and a different reference are required', async () => {
		const { handlers, posts } = setup();
		await handlers.handleGetDataTables(null, 'Ref');
		assert.strictEqual(posts[0].command, 'dataCompareFailed');
		posts.length = 0;
		await handlers.handleGetDataTables('Db', 'Db');
		assert.strictEqual(posts[0].command, 'dataCompareFailed');
	});

	test('lists the comparable table with its key and an estimated row count on each side', async () => {
		const { handlers, posts } = setup({ rowCounts: { Ref: 2, Db: 3 } });
		await handlers.handleGetDataTables('Db', 'Ref');
		const message = posts[0];
		assert.strictEqual(message.command, 'dataCompareTables');
		assert.strictEqual(message.comparable.length, 1);
		const t = message.comparable[0];
		assert.deepStrictEqual(t.key, ['id']);
		assert.deepStrictEqual([t.rowCountReference, t.rowCountCurrent], [2, 3]);
		assert.deepStrictEqual(message.support, { supported: true, reason: '' });
	});

	test('a server before 2016 is said to not support data compare, but the tables are still listed', async () => {
		const { handlers, posts } = setup({ version: '12.0.6024.0' });
		await handlers.handleGetDataTables('Db', 'Ref');
		assert.strictEqual(posts[0].support.supported, false);
		assert.strictEqual(posts[0].comparable.length, 1);
	});

	test('comparing data needs the table list first', async () => {
		const { handlers, posts } = setup();
		await handlers.handleCompareData('Db', 'Ref', ['dbo.T']);
		assert.strictEqual(posts[0].command, 'dataCompareFailed');
	});

	test('compares the picked table and keeps the result for the script/export/apply steps', async () => {
		const { handlers, posts } = setup({
			rows: { Ref: [{ id: 1, name: 'Alice', amount: 10 }], Db: [{ id: 1, name: 'Alice', amount: 10 }, { id: 2, name: 'Bob', amount: 5 }] }
		});
		await handlers.handleGetDataTables('Db', 'Ref');
		posts.length = 0;
		await handlers.handleCompareData('Db', 'Ref', ['dbo.T']);
		const progress = posts.filter(p => p.command === 'dataCompareProgress');
		assert.ok(progress.length >= 1);
		const result = posts.find(p => p.command === 'dataCompareResult');
		assert.ok(result);
		assert.strictEqual(result.tables.length, 1);
		assert.strictEqual(result.tables[0].counts.added, 1);
	});

	test('the script of the picked table needs the data compared first', () => {
		const { handlers, posts } = setup();
		handlers.handleBuildScript(['dbo.T'], false);
		assert.strictEqual(posts[0].command, 'dataCompareFailed');
	});

	test('builds the MERGE script of the rows that were picked', async () => {
		const { handlers, posts } = setup({
			rows: { Ref: [], Db: [{ id: 1, name: 'New', amount: 1 }] }
		});
		await handlers.handleGetDataTables('Db', 'Ref');
		await handlers.handleCompareData('Db', 'Ref', ['dbo.T']);
		posts.length = 0;
		handlers.handleBuildScript(['dbo.T'], false);
		const script = posts.find(p => p.command === 'dataScript');
		assert.ok(script);
		assert.strictEqual(script.steps, 1);
		assert.match(script.script, /MERGE INTO \[dbo\]\.\[T\]/);
	});

	test('exports the picked table as a zip', async () => {
		const saved = [];
		let written = null;
		const { handlers, posts } = setup({
			rows: { Ref: [], Db: [{ id: 1, name: 'New', amount: 1 }] },
			saveFile: async name => { saved.push(name); return 'C:/out/x.zip'; },
			writeFile: async (target, data) => { written = { target, data }; }
		});
		await handlers.handleGetDataTables('Db', 'Ref');
		await handlers.handleCompareData('Db', 'Ref', ['dbo.T']);
		posts.length = 0;
		await handlers.handleExportZip(['dbo.T'], false);
		assert.deepStrictEqual(saved, ['data_Ref_to_Db_2026-11-03.zip']);
		assert.strictEqual(written.target, 'C:/out/x.zip');
		assert.strictEqual(written.data.subarray(0, 2).toString(), 'PK');
		assert.deepStrictEqual(posts[0], { command: 'dataExported', path: 'C:/out/x.zip', count: 1, files: 3 });
	});

	test('a cancelled save dialog writes nothing', async () => {
		let written = false;
		const { handlers, posts } = setup({
			rows: { Ref: [], Db: [{ id: 1, name: 'New', amount: 1 }] },
			saveFile: async () => null, writeFile: async () => { written = true; }
		});
		await handlers.handleGetDataTables('Db', 'Ref');
		await handlers.handleCompareData('Db', 'Ref', ['dbo.T']);
		posts.length = 0;
		await handlers.handleExportZip(['dbo.T'], false);
		assert.deepStrictEqual(posts, [{ command: 'dataExported', cancelled: true }]);
		assert.strictEqual(written, false);
	});

	test('applying onto the database the rows came from is refused', async () => {
		const { handlers, posts } = setup({ rows: { Ref: [], Db: [{ id: 1, name: 'New', amount: 1 }] } });
		await handlers.handleGetDataTables('Db', 'Ref');
		await handlers.handleCompareData('Db', 'Ref', ['dbo.T']);
		posts.length = 0;
		await handlers.handleApply(['dbo.T'], false, null, 'Db');
		assert.strictEqual(posts[0].command, 'dataCompareFailed');
	});

	test('applies the script to another database, after confirmation', async () => {
		const { handlers, posts, confirmed } = setup({ rows: { Ref: [], Db: [{ id: 1, name: 'New', amount: 1 }], Other: [] } });
		await handlers.handleGetDataTables('Db', 'Ref');
		await handlers.handleCompareData('Db', 'Ref', ['dbo.T']);
		posts.length = 0;
		await handlers.handleApply(['dbo.T'], false, null, 'Other');
		assert.strictEqual(confirmed.length, 1);
		const applied = posts.find(p => p.command === 'dataApplied');
		assert.ok(applied);
		assert.strictEqual(applied.database, 'Other');
		assert.strictEqual(applied.steps, 1);
		assert.strictEqual(applied.errors.length, 0);
	});

	test('a declined confirmation applies nothing', async () => {
		const { handlers, posts } = setup({ rows: { Ref: [], Db: [{ id: 1, name: 'New', amount: 1 }], Other: [] } }, { confirm: false });
		await handlers.handleGetDataTables('Db', 'Ref');
		await handlers.handleCompareData('Db', 'Ref', ['dbo.T']);
		posts.length = 0;
		await handlers.handleApply(['dbo.T'], false, null, 'Other');
		assert.deepStrictEqual(posts, [{ command: 'dataApplyDeclined' }]);
	});
});
