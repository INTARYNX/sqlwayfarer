const assert = require('assert');
const { CompareManager } = require('../webview/compareManager');
global.LineDiff = require('../webview/lineDiff'); // a global of the page

const column = (name, extra) => Object.assign({ name, type: 'int', nullable: false, identity: null, computed: null, default: null, collation: null }, extra);

suite('CompareManager (what it shows)', () => {
	test('the changes are grouped by kind, in a fixed order, and filtered by name', () => {
		const changes = [
			{ kind: 'procedure', name: 'dbo.p' }, { kind: 'table', name: 'dbo.Orders' }, { kind: 'table', name: 'dbo.Customers' }, { kind: 'view', name: 'dbo.vOrders' }
		];
		assert.deepStrictEqual(CompareManager.group(changes, '').map(g => `${g.label}:${g.changes.length}`), ['Tables:2', 'Views:1', 'Procedures:1']);
		assert.deepStrictEqual(CompareManager.group(changes, 'order').map(g => `${g.label}:${g.changes.map(c => c.name)}`), ['Tables:dbo.Orders', 'Views:dbo.vOrders']);
		assert.deepStrictEqual(CompareManager.group(changes, 'zzz'), []);
	});

	test('the changes can be narrowed to one status', () => {
		const changes = [
			{ kind: 'table', name: 'dbo.A', status: 'added' }, { kind: 'table', name: 'dbo.B', status: 'removed' },
			{ kind: 'view', name: 'dbo.vA', status: 'added' }, { kind: 'procedure', name: 'dbo.p', status: 'modified' }
		];
		assert.deepStrictEqual(CompareManager.group(changes, '', 'added').map(g => `${g.label}:${g.changes.map(c => c.name)}`), ['Tables:dbo.A', 'Views:dbo.vA']);
		assert.deepStrictEqual(CompareManager.group(changes, 'p', 'modified').map(g => g.label), ['Procedures']);
		assert.deepStrictEqual(CompareManager.group(changes, '', 'removed').map(g => g.changes.length), [1]);
		// Several at once: the statuses add up, and the kinds narrow what is left.
		const listed = groups => groups.map(g => `${g.label}:${g.changes.map(c => c.name)}`);
		assert.deepStrictEqual(listed(CompareManager.group(changes, '', new Set(['added', 'removed']))), ['Tables:dbo.A,dbo.B', 'Views:dbo.vA']);
		assert.deepStrictEqual(listed(CompareManager.group(changes, '', ['added', 'modified'], new Set(['view', 'procedure']))), ['Views:dbo.vA', 'Procedures:dbo.p']);
		assert.deepStrictEqual(CompareManager.group(changes, '', new Set(), new Set(['table'])).map(g => g.label), ['Tables']);
	});

	test('the whole text of a side is the code, or the lines of the table; a missing side is empty', () => {
		const module = { kind: 'view', status: 'modified', reference: { definition: 'a\r\nb' }, current: { definition: 'a\nc' } };
		assert.strictEqual(CompareManager.fullText(module, 'before'), 'a\nb');
		assert.strictEqual(CompareManager.fullText(module, 'after'), 'a\nc');
		assert.strictEqual(CompareManager.fullText({ kind: 'view', status: 'added', current: { definition: 'x' } }, 'before'), '');
		assert.strictEqual(CompareManager.fullText({ kind: 'view', status: 'modified', reference: { definition: null }, current: { definition: 'x' } }, 'before'), null);
	});

	test('a change is as risky as its worst operation', () => {
		assert.strictEqual(CompareManager.worstRisk([{ risk: 'safe' }, { risk: 'caution' }, { risk: 'safe' }]), 'caution');
		assert.strictEqual(CompareManager.worstRisk([{ risk: 'caution' }, { risk: 'destructive' }, { risk: 'manual' }]), 'manual');
		assert.strictEqual(CompareManager.worstRisk([]), 'safe');
		assert.strictEqual(CompareManager.idOf({ kind: 'table', name: 'dbo.T' }), 'table:dbo.T');
	});

	test('a column is described the way it is written', () => {
		assert.strictEqual(CompareManager.describeColumn(column('a', { type: 'varchar(30)', nullable: true })), 'a varchar(30) NULL');
		assert.strictEqual(CompareManager.describeColumn(column('id', { identity: { seed: '1', increment: '1' } })), 'id int IDENTITY(1,1) NOT NULL');
		assert.strictEqual(CompareManager.describeColumn(column('n', { collation: 'Latin1_General_CS_AS', type: 'varchar(5)' })), 'n varchar(5) COLLATE Latin1_General_CS_AS NOT NULL');
		assert.strictEqual(CompareManager.describeColumn(column('t', { default: { name: 'DF', definition: '((1))', systemNamed: false } })), 't int NOT NULL DEFAULT ((1))');
		assert.strictEqual(CompareManager.describeColumn(column('u', { computed: { definition: '(upper([n]))', persisted: true } })), 'u AS (upper([n])) PERSISTED');
	});

	test('each operation is a line with a sign: + added, − removed, ~ changed', () => {
		const d = CompareManager.describeOp;
		assert.deepStrictEqual(d({ op: 'addColumn', column: column('a', { nullable: true }) }), { sign: '+', text: 'column a int NULL', note: '' });
		assert.strictEqual(d({ op: 'addColumn', column: column('a'), needsDefault: true }).note.includes('fails'), true);
		assert.deepStrictEqual(d({ op: 'dropColumn', column: column('a') }), { sign: '−', text: 'column a', note: '' });
		assert.strictEqual(d({ op: 'alterColumn', name: 'c', changes: ['type', 'nullable'], from: column('c', { type: 'int' }), to: column('c', { type: 'bigint', nullable: true }) }).text, 'column c: int → bigint, NOT NULL → NULL');
		assert.strictEqual(d({ op: 'alterColumn', name: 'c', changes: ['identity'], from: column('c'), to: column('c', { identity: { seed: '1', increment: '2' } }) }).text, 'column c: identity none → (1,2)');
		assert.strictEqual(d({ op: 'dropIndex', index: { name: 'IX', unique: false, columns: [{ name: 'a', desc: true }], included: [], filter: null, disabled: false } }).text, 'index IX (a DESC)');
		assert.strictEqual(d({ op: 'addIndex', index: { name: 'IX', unique: true, columns: [{ name: 'a', desc: false }], included: ['b'], filter: '([a]>(0))', disabled: false } }).text, 'index unique IX (a) INCLUDE (b) WHERE ([a]>(0))');
		assert.strictEqual(d({ op: 'addForeignKey', foreignKey: { name: 'FK', systemNamed: false, columns: ['p'], refSchema: 'dbo', refTable: 'P', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'NO_ACTION' } }).text, 'foreign key FK (p) → dbo.P (id) ON DELETE CASCADE');
		assert.strictEqual(d({ op: 'dropForeignKey', foreignKey: { name: 'FK__T__1', systemNamed: true, columns: ['p'], refSchema: 'dbo', refTable: 'P', refColumns: ['id'], onDelete: 'NO_ACTION', onUpdate: 'NO_ACTION' } }).text, 'foreign key (p) → dbo.P (id)');
		assert.strictEqual(d({ op: 'addCheck', check: { name: 'CK', systemNamed: false, definition: '([a]>(0))' } }).text, 'check CK ([a]>(0))');
		assert.strictEqual(d({ op: 'addPrimaryKey', primaryKey: { clustered: true, columns: [{ name: 'id', desc: false }] } }).text, 'primary key (id) clustered');
		assert.strictEqual(d({ op: 'alter', what: ['definition', 'options'] }).text, 'definition, SET options');
		assert.strictEqual(d({ op: 'alter', what: ['disabled'] }).text, 'enabled or disabled');
		assert.strictEqual(d({ op: 'somethingNew' }).sign, '~');
	});

	test('a whole table is listed: columns, keys, indexes, foreign keys, checks', () => {
		const lines = CompareManager.describeTable({
			columns: [column('id'), column('a', { nullable: true })],
			primaryKey: { name: 'PK', systemNamed: false, clustered: true, columns: [{ name: 'id', desc: false }] },
			uniques: [{ name: 'UQ', systemNamed: false, clustered: false, columns: [{ name: 'a', desc: false }] }],
			indexes: [{ name: 'IX', unique: false, columns: [{ name: 'a', desc: false }], included: [], filter: null, disabled: false }],
			foreignKeys: [], checks: [{ name: 'CK', systemNamed: false, definition: '([id]>(0))' }]
		});
		assert.deepStrictEqual(lines, ['column id int NOT NULL', 'column a int NULL', 'primary key (id) clustered', 'unique UQ (a)', 'index IX (a)', 'check CK ([id]>(0))']);
	});

	test('what is not compared is said in words', () => {
		assert.strictEqual(CompareManager.notComparedText({ synonyms: 1, userTypes: 3 }), '1 synonym, 3 user types');
		assert.strictEqual(CompareManager.notComparedText({}), '');
		assert.strictEqual(CompareManager.notComparedText(undefined), '');
	});
});
