const assert = require('assert');
const { planDataTables, supportsDataCompare } = require('../database/dataDiff');

const column = (name, extra) => Object.assign({ name, type: 'int', nullable: false, identity: null, computed: null, default: null, collation: null }, extra);
const table = (name, extra, schema = 'dbo') => Object.assign({ schema, name, columns: [column('id')], primaryKey: null, uniques: [], foreignKeys: [] }, extra);
const model = tables => ({ tables: Object.fromEntries(tables.map(t => [`${t.schema}.${t.name}`, t])) });
const keyColumns = names => names.map(name => ({ name, desc: false }));
const pk = (names = ['id']) => ({ name: 'PK', systemNamed: false, clustered: true, columns: keyColumns(names) });
const unique = names => ({ name: 'U', systemNamed: false, clustered: false, columns: keyColumns(names) });
const fk = (refTable, refSchema = 'dbo') => ({ name: 'FK', systemNamed: false, columns: ['id'], refSchema, refTable, refColumns: ['id'], onDelete: 'NO_ACTION', onUpdate: 'NO_ACTION', disabled: false });
const planOf = (refTables, curTables) => planDataTables(model(refTables), model(curTables));
const only = (plan, name) => plan.comparable.find(t => `${t.schema}.${t.name}` === name);

suite('dataDiff: planDataTables', () => {
	test('a table with a primary key on both sides is comparable, key and columns included', () => {
		const t = table('T', { primaryKey: pk(), columns: [column('id'), column('name', { type: 'nvarchar(50)' })] });
		const plan = planOf([t], [t]);
		assert.strictEqual(plan.notComparable.length, 0);
		const comparable = only(plan, 'dbo.T');
		assert.deepStrictEqual(comparable.key, ['id']);
		assert.deepStrictEqual(comparable.columns, ['id', 'name']);
		assert.deepStrictEqual(comparable.excludedColumns, []);
	});

	test('no primary key and no NOT NULL unique: not comparable, and said why', () => {
		const t = table('T', { uniques: [unique(['name'])], columns: [column('id'), column('name', { nullable: true })] });
		const plan = planOf([t], [t]);
		assert.strictEqual(plan.comparable.length, 0);
		assert.deepStrictEqual(plan.notComparable, [{ schema: 'dbo', name: 'T', reason: 'No primary key, and no unique key whose columns are all NOT NULL.' }]);
	});

	test('a NOT NULL unique stands in for a missing primary key', () => {
		const t = table('T', { uniques: [unique(['code'])], columns: [column('id'), column('code', { nullable: false })] });
		const plan = planOf([t], [t]);
		assert.deepStrictEqual(only(plan, 'dbo.T').key, ['code']);
	});

	test('a column on one side only is excluded, the rest still compared', () => {
		const ref = table('T', { primaryKey: pk(), columns: [column('id'), column('shared'), column('old')] });
		const cur = table('T', { primaryKey: pk(), columns: [column('id'), column('shared'), column('new')] });
		const comparable = only(planOf([ref], [cur]), 'dbo.T');
		assert.deepStrictEqual(comparable.columns, ['id', 'shared']);
		assert.deepStrictEqual(comparable.excludedColumns, [{ name: 'new', reason: 'Not on both sides of the comparison.' }, { name: 'old', reason: 'Not on both sides of the comparison.' }]);
	});

	test('a computed column, and a type that cannot be compared, are excluded and said why', () => {
		const t = table('T', { primaryKey: pk(), columns: [column('id'), column('name'), column('calc', { computed: { definition: '(1)', persisted: false } }), column('doc', { type: 'xml' })] });
		const plan = planOf([t], [t]);
		const comparable = only(plan, 'dbo.T');
		assert.deepStrictEqual(comparable.columns, ['id', 'name']);
		assert.deepStrictEqual(comparable.excludedColumns, [
			{ name: 'calc', reason: 'Computed column: a view of other columns, not data of its own.' },
			{ name: 'doc', reason: 'Type xml is not compared.' }
		]);
	});

	test('an identity column outside the key is excluded; one that is the key is kept', () => {
		const outside = table('T1', { primaryKey: pk(['code']), columns: [column('code'), column('name'), column('id', { identity: { seed: '1', increment: '1' } })] });
		const inside = table('T2', { primaryKey: pk(), columns: [column('id', { identity: { seed: '1', increment: '1' } }), column('name')] });
		const plan = planOf([outside, inside], [outside, inside]);
		const t1 = only(plan, 'dbo.T1');
		assert.deepStrictEqual(t1.excludedColumns, [{ name: 'id', reason: 'Identity column outside the key: a new value is assigned by the server.' }]);
		assert.strictEqual(t1.identityColumn, null);
		const t2 = only(plan, 'dbo.T2');
		assert.strictEqual(t2.identityColumn, 'id');
	});

	test('nothing but the key survives: not comparable', () => {
		const t = table('T', { primaryKey: pk(), columns: [column('id'), column('doc', { type: 'xml' })] });
		const plan = planOf([t], [t]);
		assert.strictEqual(plan.comparable.length, 0);
		assert.strictEqual(plan.notComparable[0].reason, 'No column besides the key can be compared.');
	});

	test('a table on one side only is neither comparable nor not-comparable: it is said apart', () => {
		const plan = planOf([table('Gone', { primaryKey: pk() })], [table('Born', { primaryKey: pk() })]);
		assert.deepStrictEqual(plan.onlyInReference, ['dbo.Gone']);
		assert.deepStrictEqual(plan.onlyInCurrent, ['dbo.Born']);
		assert.strictEqual(plan.comparable.length, 0);
	});

	test('tables are ordered so the one a foreign key points to comes first', () => {
		const parent = table('Parent', { primaryKey: pk(), columns: [column('id'), column('name')] });
		const child = table('Child', { primaryKey: pk(), columns: [column('id'), column('parentId')], foreignKeys: [fk('Parent')] });
		// Declared child-first: the plan still puts Parent before Child.
		const plan = planOf([child, parent], [child, parent]);
		assert.deepStrictEqual(plan.comparable.map(t => t.name), ['Parent', 'Child']);
	});
});

suite('dataDiff: supportsDataCompare', () => {
	test('FOR JSON needs SQL Server 2016 RTM (13.0.1601) or later', () => {
		assert.strictEqual(supportsDataCompare('12.0.5000.0'), false);
		assert.strictEqual(supportsDataCompare('13.0.1600.0'), false);
		assert.strictEqual(supportsDataCompare('13.0.1601.5'), true);
		assert.strictEqual(supportsDataCompare('13.0.4001.0'), true);
		assert.strictEqual(supportsDataCompare('16.0.1000.6'), true);
	});
});
