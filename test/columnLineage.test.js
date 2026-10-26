const assert = require('assert');
const BabelfishSqlParser = require('../database/BabelfishSqlParser');
const IndexService = require('../database/IndexServices');

function makeParser() {
	const parser = new BabelfishSqlParser();
	parser.setEnabled(true);
	return parser;
}

suite('BabelfishSqlParser.analyzeColumns', () => {
	test('qualified refs resolve through aliases', function () {
		this.timeout(10000);
		const refs = makeParser().analyzeColumns(
			'SELECT e.name, d.label FROM dbo.Employee e JOIN dbo.Dept d ON d.id = e.dept_id'
		);
		assert.deepStrictEqual(Object.keys(refs).sort(), ['dbo.dept', 'dbo.employee']);
		assert.strictEqual(refs['dbo.employee'].name.confident, true);
		assert.strictEqual(refs['dbo.employee'].dept_id.confident, true);
		assert.strictEqual(refs['dbo.dept'].label.write, false);
	});

	test('unqualified column with a single table in scope is confident', function () {
		this.timeout(10000);
		const refs = makeParser().analyzeColumns('SELECT name FROM dbo.Employee WHERE active = 1');
		assert.strictEqual(refs['dbo.employee'].name.confident, true);
		assert.strictEqual(refs['dbo.employee'].active.confident, true);
	});

	test('unqualified column with several tables is attributed to all, low confidence', function () {
		this.timeout(10000);
		const refs = makeParser().analyzeColumns('SELECT name FROM dbo.A a JOIN dbo.B b ON a.id = b.a_id');
		assert.strictEqual(refs['dbo.a'].name.confident, false);
		assert.strictEqual(refs['dbo.b'].name.confident, false);
		assert.strictEqual(refs['dbo.a'].id.confident, true, 'qualified ref stays confident');
	});

	test('UPDATE through an alias marks the real table as written', function () {
		this.timeout(10000);
		const refs = makeParser().analyzeColumns(
			'UPDATE t SET t.status = 1, priority = 2 FROM dbo.Task t WHERE t.id = 5'
		);
		assert.strictEqual(refs['dbo.task'].status.write, true);
		assert.strictEqual(refs['dbo.task'].priority.write, true, 'unqualified SET column goes to the update target');
		assert.strictEqual(refs['dbo.task'].id.write, false);
		assert.strictEqual(refs.t, undefined, 'alias never appears as a table');
	});

	test('FROM-less UPDATE attributes unqualified WHERE columns to the target', function () {
		this.timeout(10000);
		const refs = makeParser().analyzeColumns('UPDATE dbo.Employee SET status = 1 WHERE id = 5');
		assert.strictEqual(refs['dbo.employee'].status.write, true);
		assert.strictEqual(refs['dbo.employee'].id.confident, true, 'WHERE column attributed to the update target');
	});

	test('plain DELETE attributes unqualified WHERE columns to the target', function () {
		this.timeout(10000);
		const refs = makeParser().analyzeColumns('DELETE FROM dbo.Task WHERE done = 1');
		assert.strictEqual(refs['dbo.task'].done.confident, true);
	});

	test('CTE names are dropped, their bodies are attributed to real tables', function () {
		this.timeout(10000);
		const refs = makeParser().analyzeColumns(
			'WITH recent AS (SELECT r.id FROM dbo.Employee r) SELECT x.id FROM recent x'
		);
		assert.strictEqual(refs.recent, undefined);
		assert.strictEqual(refs['dbo.employee'].id.confident, true);
	});

	test('INSERT column list is recorded as writes on the target', function () {
		this.timeout(10000);
		const refs = makeParser().analyzeColumns(
			"INSERT INTO dbo.Task (name, status) SELECT t.label, 1 FROM dbo.Template t"
		);
		assert.strictEqual(refs['dbo.task'].name.write, true);
		assert.strictEqual(refs['dbo.task'].status.write, true);
		assert.strictEqual(refs['dbo.template'].label.write, false);
	});

	test('MERGE resolves the target alias, SET writes and INSERT list', function () {
		this.timeout(10000);
		const refs = makeParser().analyzeColumns(
			'MERGE dbo.Target AS tgt USING dbo.Source AS src ON tgt.id = src.id ' +
			'WHEN MATCHED THEN UPDATE SET tgt.name = src.name ' +
			'WHEN NOT MATCHED THEN INSERT (id, name) VALUES (src.id, src.name);'
		);
		assert.strictEqual(refs['dbo.target'].name.write, true);
		assert.strictEqual(refs['dbo.target'].id.write, true);
		assert.strictEqual(refs['dbo.source'].name.write, false);
		assert.strictEqual(refs.tgt, undefined);
	});

	test('trigger inserted/deleted pseudo-tables map to the ON table', function () {
		this.timeout(10000);
		const refs = makeParser().analyzeColumns(
			'CREATE TRIGGER trg ON dbo.Task AFTER UPDATE AS BEGIN ' +
			'INSERT INTO dbo.Audit (task_id) SELECT i.id FROM inserted i JOIN deleted d ON d.id = i.id END'
		);
		assert.strictEqual(refs.inserted, undefined);
		assert.strictEqual(refs.deleted, undefined);
		assert.strictEqual(refs['dbo.task'].id.confident, true);
		assert.strictEqual(refs['dbo.audit'].task_id.write, true);
	});

	test('disabled parser returns null', () => {
		const parser = new BabelfishSqlParser();
		assert.strictEqual(parser.analyzeColumns('SELECT 1'), null);
	});
});

suite('BabelfishSqlParser.analyzeDefinition table-level writes', () => {
	test('a DELETE writes its target table', function () {
		this.timeout(10000);
		const analysis = makeParser().analyzeDefinition('DELETE FROM dbo.Task WHERE done = 1');
		assert.deepStrictEqual(analysis.writes, ['dbo.task']);
		assert.strictEqual(analysis.columns['dbo.task'].done.write, false, 'a DELETE writes no column value');
	});

	test('a DELETE without a WHERE clause still writes its target', function () {
		this.timeout(10000);
		const analysis = makeParser().analyzeDefinition('DELETE FROM dbo.Task');
		assert.deepStrictEqual(analysis.writes, ['dbo.task']);
		assert.deepStrictEqual(analysis.columns, {}, 'no column is named at all');
	});

	test('an aliased DELETE writes the real table, not the alias', function () {
		this.timeout(10000);
		const analysis = makeParser().analyzeDefinition('DELETE t FROM dbo.Task t WHERE t.done = 1');
		assert.deepStrictEqual(analysis.writes, ['dbo.task']);
		assert.strictEqual(analysis.columns.t, undefined);
	});

	test('an INSERT without a column list writes the target', function () {
		this.timeout(10000);
		const analysis = makeParser().analyzeDefinition('INSERT INTO dbo.Task SELECT id FROM dbo.Template');
		assert.deepStrictEqual(analysis.writes, ['dbo.task'], 'the written columns are unknown, the write is not');
	});

	test('an INSERT with a column list writes the target too', function () {
		this.timeout(10000);
		const analysis = makeParser().analyzeDefinition('INSERT INTO dbo.Task (name) VALUES (\'x\')');
		assert.deepStrictEqual(analysis.writes, ['dbo.task']);
		assert.strictEqual(analysis.columns['dbo.task'].name.write, true);
	});

	test('an UPDATE writes its target', function () {
		this.timeout(10000);
		const analysis = makeParser().analyzeDefinition('UPDATE dbo.Task SET status = 1 WHERE id = 5');
		assert.deepStrictEqual(analysis.writes, ['dbo.task']);
	});

	test('a MERGE writes its target, even when the WHEN clause names no column', function () {
		this.timeout(10000);
		const analysis = makeParser().analyzeDefinition(
			'MERGE dbo.Task AS tgt USING dbo.Template AS src ON tgt.id = src.id ' +
			'WHEN MATCHED THEN DELETE'
		);
		assert.deepStrictEqual(analysis.writes, ['dbo.task']);
	});

	test('a DELETE inside a trigger body writes the deleted table', function () {
		this.timeout(10000);
		const analysis = makeParser().analyzeDefinition(
			'CREATE TRIGGER trg ON dbo.Audit AFTER INSERT AS BEGIN DELETE FROM dbo.OldRows WHERE id < 100; END'
		);
		assert.deepStrictEqual(analysis.writes, ['dbo.oldrows']);
	});

	test('a plain SELECT writes nothing', function () {
		this.timeout(10000);
		const analysis = makeParser().analyzeDefinition('SELECT id FROM dbo.Task');
		assert.deepStrictEqual(analysis.writes, []);
	});

	test('a CTE name is never a written table', function () {
		this.timeout(10000);
		const analysis = makeParser().analyzeDefinition(
			'WITH recent AS (SELECT id FROM dbo.Task) DELETE FROM dbo.Task WHERE id IN (SELECT id FROM recent)'
		);
		assert.deepStrictEqual(analysis.writes, ['dbo.task']);
	});

	test('the disabled parser returns null', () => {
		const parser = new BabelfishSqlParser();
		assert.strictEqual(parser.analyzeDefinition('SELECT 1'), null);
	});
});

suite('BabelfishSqlParser.analyzeOperations alias resolution', () => {
	test('aliased UPDATE target resolves to the real table', function () {
		this.timeout(10000);
		const refs = makeParser().analyzeOperations(
			'UPDATE t SET t.status = 1 FROM dbo.Task t JOIN dbo.Emp e ON e.id = t.emp_id'
		);
		assert.ok(refs['dbo.task'].includes('UPDATE'), 'operation recorded under the real table, not the alias');
		assert.strictEqual(refs.t, undefined);
	});

	test('aliased DELETE target resolves to the real table', function () {
		this.timeout(10000);
		const refs = makeParser().analyzeOperations(
			'DELETE t FROM dbo.Task t WHERE t.done = 1'
		);
		assert.ok(refs['dbo.task'].includes('DELETE'));
		assert.strictEqual(refs.t, undefined);
	});
});

suite('IndexService.getColumnUsage', () => {
	function makeServiceWithIndex(objects) {
		const service = new IndexService({ getServerName: () => 's' }, null);
		// Bypass getIndex's disk/database round-trip: usage lookup is pure
		service.getIndex = async () => ({ objects });
		return service;
	}

	test('collects referencing objects per column, exact and bare-name matches', async () => {
		const service = makeServiceWithIndex({
			'dbo.vwEmp': {
				qualifiedName: 'dbo.vwEmp', type: 'V',
				columnRefs: { 'dbo.employee': { name: { write: false, confident: true } } }
			},
			'dbo.uspFire': {
				qualifiedName: 'dbo.uspFire', type: 'P',
				columnRefs: { employee: { name: { write: true, confident: true }, status: { write: true, confident: true } } }
			},
			'sales.uspOther': {
				qualifiedName: 'sales.uspOther', type: 'P',
				columnRefs: { 'sales.employee': { name: { write: false, confident: true } } }
			}
		});

		const usage = await service.getColumnUsage('Db', 'dbo.Employee');
		assert.strictEqual(usage.name.length, 2, 'qualified other-schema ref excluded');
		assert.deepStrictEqual(usage.name.map(u => u.object).sort(), ['dbo.uspFire', 'dbo.vwEmp']);
		assert.strictEqual(usage.status[0].write, true);
	});

	test('objects without columnRefs (old entries, tables) are skipped', async () => {
		const service = makeServiceWithIndex({
			'dbo.T': { qualifiedName: 'dbo.T', type: 'U' }
		});
		assert.deepStrictEqual(await service.getColumnUsage('Db', 'dbo.T'), {});
	});
});
