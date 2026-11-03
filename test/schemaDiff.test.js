const assert = require('assert');
const { diffModels, normalizeExpression, typeChangeRisk, RISK } = require('../database/schemaDiff');

const column = (name, extra) => Object.assign({ name, type: 'int', nullable: false, identity: null, computed: null, default: null, collation: null }, extra);
const table = (name, extra, schema = 'dbo') => Object.assign({ schema, name, columns: [column('id')], primaryKey: null, uniques: [], indexes: [], foreignKeys: [], checks: [] }, extra);
const mod = (type, name, definition, extra, schema = 'dbo') => Object.assign({ schema, name, type, definition, ansiNulls: true, quotedIdentifier: true }, extra);
const model = ({ schemas = [], tables = [], modules = [], notCompared = {} } = {}) => ({
	schemas,
	tables: Object.fromEntries(tables.map(t => [`${t.schema}.${t.name}`, t])),
	modules: Object.fromEntries(modules.map(m => [`${m.schema}.${m.name}`, m])),
	notCompared
});
const ix = (name, columns, extra) => Object.assign({ name, unique: false, clustered: false, columns: columns.map(c => ({ name: c, desc: false })), included: [], filter: null, disabled: false }, extra);
const pk = (name, columns, extra) => Object.assign({ name, systemNamed: false, clustered: true, columns: columns.map(c => ({ name: c, desc: false })) }, extra);
const fk = (name, columns, refTable, refColumns, extra) => Object.assign({ name, systemNamed: false, columns, refSchema: 'dbo', refTable, refColumns, onDelete: 'NO_ACTION', onUpdate: 'NO_ACTION', disabled: false }, extra);
const ops = (diff, name) => diff.changes.find(c => c.name === name).ops.map(o => `${o.op}:${o.risk}`);
const diffOf = (referenceTable, currentTable) => diffModels(model({ tables: [referenceTable] }), model({ tables: [currentTable] }));

suite('schemaDiff: whole objects', () => {
	test('the same model is identical', () => {
		const m = model({ schemas: ['Sales'], tables: [table('T')], modules: [mod('view', 'v', 'CREATE VIEW v AS SELECT 1')] });
		const diff = diffModels(m, JSON.parse(JSON.stringify(m)));
		assert.strictEqual(diff.identical, true);
		assert.deepStrictEqual(diff.changes, []);
	});

	test('what is only in the current model is added, what is only in the reference is removed', () => {
		const diff = diffModels(
			model({ schemas: ['Old'], tables: [table('Gone')], modules: [mod('procedure', 'p_gone', 'CREATE PROC p_gone AS SELECT 1')] }),
			model({ schemas: ['New'], tables: [table('Born')], modules: [mod('view', 'v_born', 'CREATE VIEW v_born AS SELECT 1')] })
		);
		assert.deepStrictEqual(diff.changes.map(c => `${c.kind}:${c.name}:${c.status}`), [
			'schema:New:added', 'schema:Old:removed', 'table:dbo.Born:added', 'table:dbo.Gone:removed', 'view:dbo.v_born:added', 'procedure:dbo.p_gone:removed'
		]);
		assert.strictEqual(diff.changes.find(c => c.name === 'dbo.Gone').ops[0].risk, RISK.DESTRUCTIVE);
		assert.strictEqual(diff.changes.find(c => c.name === 'dbo.p_gone').ops[0].risk, RISK.CAUTION);
		assert.deepStrictEqual([diff.summary.added, diff.summary.removed, diff.summary.modified], [3, 3, 0]);
	});

	test('names are matched whatever their case; the same name of another kind is one removed and one added', () => {
		const diff = diffModels(model({ tables: [table('Orders')] }), model({ tables: [table('ORDERS')] }));
		assert.strictEqual(diff.identical, true);
		const kinds = diffModels(model({ modules: [mod('view', 'x', 'CREATE VIEW x AS SELECT 1')] }), model({ modules: [mod('function', 'x', 'CREATE FUNCTION x() RETURNS int AS BEGIN RETURN 1 END')] }));
		assert.deepStrictEqual(kinds.changes.map(c => `${c.kind}:${c.status}`).sort(), ['function:added', 'view:removed']);
	});

	test('what is not compared is passed along, on both sides', () => {
		const diff = diffModels(model({ notCompared: { synonyms: 1 } }), model({ notCompared: { synonyms: 2, sequences: 1 } }));
		assert.deepStrictEqual(diff.notCompared, { reference: { synonyms: 1 }, current: { synonyms: 2, sequences: 1 } });
	});
});

suite('schemaDiff: code objects', () => {
	const diff = (a, b) => diffModels(model({ modules: [a] }), model({ modules: [b] }));

	test('CREATE or ALTER, line ends and trailing blanks are not changes; the body is', () => {
		assert.strictEqual(diff(mod('procedure', 'p', 'CREATE PROC p AS\r\nSELECT 1  '), mod('procedure', 'p', 'ALTER PROC p AS\nSELECT 1')).identical, true);
		const changed = diff(mod('procedure', 'p', 'CREATE PROC p AS SELECT 1'), mod('procedure', 'p', 'CREATE PROC p AS SELECT 2'));
		assert.deepStrictEqual(ops(changed, 'dbo.p'), ['alter:safe']);
		assert.deepStrictEqual(changed.changes[0].ops[0].what, ['definition']);
	});

	test('the SET options a module was created with are a change', () => {
		const changed = diff(mod('view', 'v', 'CREATE VIEW v AS SELECT 1'), mod('view', 'v', 'CREATE VIEW v AS SELECT 1', { quotedIdentifier: false }));
		assert.deepStrictEqual(changed.changes[0].ops[0].what, ['options']);
	});

	test('a trigger: disabled is a change; another table is a recreation', () => {
		const t = (extra) => mod('trigger', 'trg', 'CREATE TRIGGER trg ON T AFTER INSERT AS SELECT 1', Object.assign({ parent: 'dbo.T', disabled: false }, extra));
		assert.deepStrictEqual(diff(t(), t({ disabled: true })).changes[0].ops[0].what, ['disabled']);
		const moved = diff(t(), t({ parent: 'dbo.U' }));
		assert.deepStrictEqual(moved.changes[0].ops.map(o => `${o.op}:${o.risk}`), ['recreate:caution']);
	});

	test('a definition that cannot be read is not compared, and is said so', () => {
		const result = diff(mod('procedure', 'p', null), mod('procedure', 'p', 'CREATE PROC p AS SELECT 1'));
		assert.strictEqual(result.identical, true);
		assert.deepStrictEqual(result.skipped.map(s => s.name), ['dbo.p']);
	});
});

suite('schemaDiff: columns', () => {
	test('a new column: safe when it can fill itself, a caution when it is NOT NULL with nothing to fill it', () => {
		const base = table('T');
		const add = c => ops(diffOf(base, table('T', { columns: [column('id'), c] })), 'dbo.T');
		assert.deepStrictEqual(add(column('a', { nullable: true })), ['addColumn:safe']);
		assert.deepStrictEqual(add(column('a', { default: { name: 'DF', definition: '((0))', systemNamed: false } })), ['addColumn:safe']);
		assert.deepStrictEqual(add(column('a', { identity: { seed: '1', increment: '1' } })), ['addColumn:safe']);
		assert.deepStrictEqual(add(column('a', { computed: { definition: '([id])', persisted: false } })), ['addColumn:safe']);
		const bare = diffOf(base, table('T', { columns: [column('id'), column('a')] }));
		assert.deepStrictEqual(ops(bare, 'dbo.T'), ['addColumn:caution']);
		assert.strictEqual(bare.changes[0].ops[0].needsDefault, true);
	});

	test('a column that is gone is destructive', () => {
		assert.deepStrictEqual(ops(diffOf(table('T', { columns: [column('id'), column('a')] }), table('T')), 'dbo.T'), ['dropColumn:destructive']);
	});

	test('the order of the columns is not a change', () => {
		const a = table('T', { columns: [column('a'), column('b')] });
		const b = table('T', { columns: [column('b'), column('a')] });
		assert.strictEqual(diffOf(a, b).identical, true);
	});

	test('a type: wider is safe, narrower destroys, another family is a caution', () => {
		const change = (from, to) => diffOf(table('T', { columns: [column('c', { type: from })] }), table('T', { columns: [column('c', { type: to })] })).changes[0].ops[0];
		assert.strictEqual(change('varchar(50)', 'varchar(100)').risk, RISK.SAFE);
		assert.strictEqual(change('varchar(50)', 'varchar(max)').risk, RISK.SAFE);
		assert.strictEqual(change('varchar(max)', 'varchar(50)').risk, RISK.DESTRUCTIVE);
		assert.strictEqual(change('nvarchar(100)', 'nvarchar(10)').risk, RISK.DESTRUCTIVE);
		assert.strictEqual(change('int', 'bigint').risk, RISK.SAFE);
		assert.strictEqual(change('bigint', 'int').risk, RISK.DESTRUCTIVE);
		assert.strictEqual(change('decimal(10,2)', 'decimal(12,2)').risk, RISK.SAFE);
		assert.strictEqual(change('decimal(10,2)', 'decimal(10,4)').risk, RISK.DESTRUCTIVE);
		assert.strictEqual(change('decimal(10,2)', 'decimal(8,2)').risk, RISK.DESTRUCTIVE);
		assert.strictEqual(change('datetime2(3)', 'datetime2(7)').risk, RISK.SAFE);
		assert.strictEqual(change('datetime2(7)', 'datetime2(0)').risk, RISK.DESTRUCTIVE);
		assert.strictEqual(change('int', 'varchar(20)').risk, RISK.CAUTION);
		assert.deepStrictEqual(change('int', 'bigint').changes, ['type']);
		assert.strictEqual(typeChangeRisk('float', 'float(24)'), RISK.DESTRUCTIVE);
		assert.strictEqual(typeChangeRisk('float(24)', 'float'), RISK.SAFE);
	});

	test('NULL to NOT NULL can fail on the data; NOT NULL to NULL cannot', () => {
		const withNull = table('T', { columns: [column('c', { nullable: true })] });
		const notNull = table('T', { columns: [column('c')] });
		assert.deepStrictEqual(ops(diffOf(withNull, notNull), 'dbo.T'), ['alterColumn:caution']);
		assert.deepStrictEqual(ops(diffOf(notNull, withNull), 'dbo.T'), ['alterColumn:safe']);
	});

	test('identity cannot be changed in place; collation is a caution', () => {
		const plain = table('T', { columns: [column('c')] });
		const identity = table('T', { columns: [column('c', { identity: { seed: '1', increment: '1' } })] });
		assert.deepStrictEqual(ops(diffOf(plain, identity), 'dbo.T'), ['alterColumn:manual']);
		const seed = table('T', { columns: [column('c', { identity: { seed: '100', increment: '1' } })] });
		assert.deepStrictEqual(ops(diffOf(identity, seed), 'dbo.T'), ['alterColumn:manual']);
		const collated = table('T', { columns: [column('c', { type: 'varchar(5)', collation: 'Latin1_General_CS_AS' })] });
		assert.deepStrictEqual(ops(diffOf(table('T', { columns: [column('c', { type: 'varchar(5)' })] }), collated), 'dbo.T'), ['alterColumn:caution']);
	});

	test('computed: the expression is compared without blanks or case; becoming computed loses what the column held', () => {
		const computed = d => table('T', { columns: [column('c', { computed: { definition: d, persisted: true } })] });
		assert.strictEqual(diffOf(computed('(upper([name]))'), computed('( UPPER( [name] ) )')).identical, true);
		assert.deepStrictEqual(ops(diffOf(computed('([a]+(1))'), computed('([a]+(2))')), 'dbo.T'), ['alterColumn:caution']);
		assert.deepStrictEqual(ops(diffOf(table('T', { columns: [column('c')] }), computed('([a])')), 'dbo.T'), ['alterColumn:destructive']);
		assert.deepStrictEqual(ops(diffOf(computed('([a])'), table('T', { columns: [column('c')] })), 'dbo.T'), ['alterColumn:caution']);
	});

	test('defaults: added, dropped, changed; a name the server made up is not a difference', () => {
		const withDefault = (name, definition, systemNamed) => table('T', { columns: [column('c', { default: { name, definition, systemNamed } })] });
		const none = table('T', { columns: [column('c')] });
		assert.deepStrictEqual(ops(diffOf(none, withDefault('DF_c', '((0))', false)), 'dbo.T'), ['addDefault:safe']);
		assert.deepStrictEqual(ops(diffOf(withDefault('DF_c', '((0))', false), none), 'dbo.T'), ['dropDefault:safe']);
		assert.deepStrictEqual(ops(diffOf(withDefault('DF_c', '((0))', false), withDefault('DF_c', '((1))', false)), 'dbo.T'), ['alterDefault:safe']);
		assert.deepStrictEqual(ops(diffOf(withDefault('DF_c', '((0))', false), withDefault('DF_other', '((0))', false)), 'dbo.T'), ['alterDefault:safe']);
		assert.strictEqual(diffOf(withDefault('DF__T__c__1A2B3C4D', '((0))', true), withDefault('DF__T__c__99887766', '(( 0 ))', true)).identical, true);
	});
});

suite('schemaDiff: keys, indexes, constraints', () => {
	test('primary key: added and dropped are cautions; a renamed system-named one is not a change', () => {
		const plain = table('T');
		assert.deepStrictEqual(ops(diffOf(plain, table('T', { primaryKey: pk('PK_T', ['id']) })), 'dbo.T'), ['addPrimaryKey:caution']);
		assert.deepStrictEqual(ops(diffOf(table('T', { primaryKey: pk('PK_T', ['id']) }), plain), 'dbo.T'), ['dropPrimaryKey:caution']);
		assert.strictEqual(diffOf(table('T', { primaryKey: pk('PK__T__1', ['id'], { systemNamed: true }) }), table('T', { primaryKey: pk('PK__T__2', ['id'], { systemNamed: true }) })).identical, true);
		assert.deepStrictEqual(ops(diffOf(table('T', { primaryKey: pk('PK_T', ['id']) }), table('T', { primaryKey: pk('PK_T', ['id', 'b']) })), 'dbo.T'), ['alterPrimaryKey:caution']);
		assert.deepStrictEqual(ops(diffOf(table('T', { primaryKey: pk('PK_T', ['id']) }), table('T', { primaryKey: pk('PK_T', ['id'], { clustered: false }) })), 'dbo.T'), ['alterPrimaryKey:caution']);
	});

	test('unique constraints follow the same rules', () => {
		const u = (name, columns, systemNamed = false) => ({ name, systemNamed, clustered: false, columns: columns.map(c => ({ name: c, desc: false })) });
		assert.deepStrictEqual(ops(diffOf(table('T'), table('T', { uniques: [u('UQ', ['a'])] })), 'dbo.T'), ['addUnique:caution']);
		assert.deepStrictEqual(ops(diffOf(table('T', { uniques: [u('UQ', ['a'])] }), table('T')), 'dbo.T'), ['dropUnique:safe']);
		assert.deepStrictEqual(ops(diffOf(table('T', { uniques: [u('UQ', ['a'])] }), table('T', { uniques: [u('UQ', ['b'])] })), 'dbo.T'), ['alterUnique:caution']);
		assert.strictEqual(diffOf(table('T', { uniques: [u('UQ__T__1', ['a'], true)] }), table('T', { uniques: [u('UQ__T__2', ['a'], true)] })).identical, true);
	});

	test('indexes: by name; key order, INCLUDE (as a set), filter and direction count', () => {
		const alter = (a, b) => ops(diffOf(table('T', { indexes: [a] }), table('T', { indexes: [b] })), 'dbo.T');
		assert.deepStrictEqual(ops(diffOf(table('T'), table('T', { indexes: [ix('IX', ['a'])] })), 'dbo.T'), ['addIndex:safe']);
		assert.deepStrictEqual(ops(diffOf(table('T'), table('T', { indexes: [ix('IX', ['a'], { unique: true })] })), 'dbo.T'), ['addIndex:caution']);
		assert.deepStrictEqual(ops(diffOf(table('T', { indexes: [ix('IX', ['a'])] }), table('T')), 'dbo.T'), ['dropIndex:safe']);
		assert.deepStrictEqual(alter(ix('IX', ['a', 'b']), ix('IX', ['b', 'a'])), ['alterIndex:safe']);
		assert.deepStrictEqual(alter(ix('IX', ['a']), ix('IX', ['a'], { included: ['c'] })), ['alterIndex:safe']);
		assert.deepStrictEqual(alter(ix('IX', ['a']), ix('IX', ['a'], { filter: '([a]>(0))' })), ['alterIndex:safe']);
		assert.deepStrictEqual(alter(ix('IX', ['a']), ix('IX', ['a'], { unique: true })), ['alterIndex:caution']);
		assert.deepStrictEqual(alter(ix('IX', ['a']), ix('IX', ['a'], { disabled: true })), ['alterIndex:safe']);
		assert.strictEqual(diffOf(table('T', { indexes: [ix('IX', ['a'], { included: ['c', 'b'] })] }), table('T', { indexes: [ix('ix', ['A'], { included: ['B', 'C'] })] })).identical, true);
		const desc = ix('IX', ['a']);
		desc.columns[0].desc = true;
		assert.deepStrictEqual(alter(ix('IX', ['a']), desc), ['alterIndex:safe']);
	});

	test('foreign keys: added is a caution (the data may not fit), dropped is safe, a changed action is a caution', () => {
		const parent = fk('FK', ['p'], 'P', ['id']);
		assert.deepStrictEqual(ops(diffOf(table('T'), table('T', { foreignKeys: [parent] })), 'dbo.T'), ['addForeignKey:caution']);
		assert.deepStrictEqual(ops(diffOf(table('T', { foreignKeys: [parent] }), table('T')), 'dbo.T'), ['dropForeignKey:safe']);
		assert.deepStrictEqual(ops(diffOf(table('T', { foreignKeys: [parent] }), table('T', { foreignKeys: [fk('FK', ['p'], 'P', ['id'], { onDelete: 'CASCADE' })] })), 'dbo.T'), ['alterForeignKey:caution']);
		assert.deepStrictEqual(ops(diffOf(table('T', { foreignKeys: [parent] }), table('T', { foreignKeys: [fk('FK', ['p'], 'Q', ['id'])] })), 'dbo.T'), ['alterForeignKey:caution']);
		assert.deepStrictEqual(ops(diffOf(table('T', { foreignKeys: [parent] }), table('T', { foreignKeys: [fk('FK', ['p'], 'P', ['id'], { disabled: true })] })), 'dbo.T'), ['alterForeignKey:caution']);
		assert.strictEqual(diffOf(table('T', { foreignKeys: [fk('FK__T__1', ['p'], 'P', ['id'], { systemNamed: true })] }), table('T', { foreignKeys: [fk('FK__T__2', ['p'], 'P', ['id'], { systemNamed: true })] })).identical, true);
	});

	test('check constraints: by name, or by expression when the server named them', () => {
		const ck = (name, definition, systemNamed = false) => ({ name, systemNamed, definition, disabled: false });
		assert.deepStrictEqual(ops(diffOf(table('T'), table('T', { checks: [ck('CK', '([a]>(0))')] })), 'dbo.T'), ['addCheck:caution']);
		assert.deepStrictEqual(ops(diffOf(table('T', { checks: [ck('CK', '([a]>(0))')] }), table('T')), 'dbo.T'), ['dropCheck:safe']);
		assert.deepStrictEqual(ops(diffOf(table('T', { checks: [ck('CK', '([a]>(0))')] }), table('T', { checks: [ck('CK', '([a]>(1))')] })), 'dbo.T'), ['alterCheck:caution']);
		assert.strictEqual(diffOf(table('T', { checks: [ck('CK__T__1', '([a]>(0))', true)] }), table('T', { checks: [ck('CK__T__2', '( [a] > (0) )', true)] })).identical, true);
	});

	test('several changes of one table come out together, in one change', () => {
		const diff = diffOf(table('T', { columns: [column('id'), column('old')] }), table('T', { columns: [column('id'), column('new', { nullable: true })], indexes: [ix('IX', ['id'])] }));
		assert.strictEqual(diff.changes.length, 1);
		assert.deepStrictEqual(ops(diff, 'dbo.T'), ['dropColumn:destructive', 'addColumn:safe', 'addIndex:safe']);
		assert.deepStrictEqual(diff.summary.risks, { safe: 2, caution: 0, destructive: 1, manual: 0 });
	});
});

suite('schemaDiff.normalizeExpression', () => {
	test('blanks and case are ignored outside string literals, kept inside', () => {
		assert.strictEqual(normalizeExpression('( UPPER( [Name] ) )'), '(upper([name]))');
		assert.strictEqual(normalizeExpression("([a]='Hello  World')"), "([a]='Hello  World')");
		assert.strictEqual(normalizeExpression("([a] = 'It''s  Ok')"), "([a]='It''s  Ok')");
		assert.notStrictEqual(normalizeExpression("([a]='X')"), normalizeExpression("([a]='x')"));
		assert.strictEqual(normalizeExpression(null), null);
	});
});
