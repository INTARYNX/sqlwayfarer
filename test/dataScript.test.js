const assert = require('assert');
const { buildDataScript } = require('../database/dataScript');
const { splitBatches } = require('../database/sqlBatches');

const baseTable = extra => Object.assign({
	schema: 'dbo', name: 'T', key: ['id'], columns: ['id', 'name'],
	columnTypes: { id: 'int', name: 'nvarchar(50)' }, identityColumn: null,
	added: [], removed: [], modified: []
}, extra);

// The real SQL statements of a script: the batches split on GO, minus the
// ones that are only a comment (the labels this module writes between steps).
const statementsOf = script => splitBatches(script).map(b => b.sql.trim()).filter(sql => sql && !/^(--.*\r?\n?)+$/.test(sql));

suite('dataScript: buildDataScript', () => {
	test('an added and a modified row of the same table share one MERGE', () => {
		const table = baseTable({ added: [{ id: 3, name: 'Carl' }], modified: [{ key: [2], before: { id: 2, name: 'Bob' }, after: { id: 2, name: 'Bobby' } }] });
		const result = buildDataScript([table], {});
		assert.strictEqual(result.steps, 1);
		const statements = statementsOf(result.script);
		assert.strictEqual(statements.length, 1);
		assert.match(statements[0], /^MERGE INTO \[dbo\]\.\[T\] AS tgt/);
		assert.match(statements[0], /USING \(VALUES \(3, N'Carl'\), \(2, N'Bobby'\)\) AS src \(\[id\], \[name\]\)/);
		assert.match(statements[0], /ON tgt\.\[id\] = src\.\[id\]/);
		assert.match(statements[0], /WHEN MATCHED THEN UPDATE SET tgt\.\[name\] = src\.\[name\]/);
		assert.match(statements[0], /WHEN NOT MATCHED BY TARGET THEN INSERT \(\[id\], \[name\]\) VALUES \(src\.\[id\], src\.\[name\]\);$/);
	});

	test('an identity column is written under IDENTITY_INSERT', () => {
		const table = baseTable({ identityColumn: 'id', added: [{ id: 9, name: 'Z' }] });
		const script = buildDataScript([table], {}).script;
		assert.match(script, /SET IDENTITY_INSERT \[dbo\]\.\[T\] ON;\nGO\nMERGE INTO/);
		assert.match(script, /;\nGO\nSET IDENTITY_INSERT \[dbo\]\.\[T\] OFF;/);
	});

	test('more rows than one MERGE chunk holds: several MERGE statements', () => {
		const added = Array.from({ length: 201 }, (_, i) => ({ id: i, name: `n${i}` }));
		const result = buildDataScript([baseTable({ added })], {});
		assert.strictEqual(result.steps, 2);
		assert.strictEqual(statementsOf(result.script).length, 2);
	});

	test('a removed row is left out of the script by default, and said in a warning', () => {
		const table = baseTable({ removed: [{ id: 1, name: 'Gone' }] });
		const result = buildDataScript([table], {});
		assert.strictEqual(result.steps, 0);
		assert.strictEqual(statementsOf(result.script).length, 0);
		assert.strictEqual(result.warnings.length, 1);
		assert.match(result.warnings[0], /1 removed row\(s\) left out/);
	});

	test('includeDeletes writes a DELETE by key', () => {
		const table = baseTable({ removed: [{ id: 1, name: 'Gone' }] });
		const result = buildDataScript([table], { includeDeletes: true });
		assert.strictEqual(result.steps, 1);
		assert.strictEqual(result.warnings.length, 0);
		assert.strictEqual(statementsOf(result.script)[0], "DELETE FROM [dbo].[T] WHERE [id] IN (1);");
	});

	test('deletes run in the reverse of the tables\' own (foreign-key) order', () => {
		const parent = baseTable({ name: 'Parent', removed: [{ id: 1, name: 'P' }] });
		const child = baseTable({ name: 'Child', removed: [{ id: 1, name: 'C' }] });
		// Given parent-then-child (as planDataTables orders them for inserts)...
		const result = buildDataScript([parent, child], { includeDeletes: true });
		const statements = statementsOf(result.script);
		// ...the deletes come out child-then-parent.
		assert.deepStrictEqual(statements, ["DELETE FROM [dbo].[Child] WHERE [id] IN (1);", "DELETE FROM [dbo].[Parent] WHERE [id] IN (1);"]);
	});

	test('only the selected tables are scripted', () => {
		const a = baseTable({ name: 'A', added: [{ id: 1, name: 'x' }] });
		const b = baseTable({ name: 'B', added: [{ id: 1, name: 'y' }] });
		const result = buildDataScript([a, b], { selected: new Set(['dbo.A']) });
		assert.strictEqual(result.steps, 1);
		assert.match(statementsOf(result.script)[0], /\[A\]/);
	});

	test('a table with nothing added, removed or modified produces no step', () => {
		const result = buildDataScript([baseTable()], {});
		assert.strictEqual(result.steps, 0);
		assert.strictEqual(statementsOf(result.script).length, 0);
	});
});
