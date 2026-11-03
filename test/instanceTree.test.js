const assert = require('assert');
const { InstanceTree } = require('../webview/instanceTree');

const obj = (type, schema, name) => ({ object_type: type, schema_name: schema, object_name: name, name: schema === 'dbo' ? name : `${schema}.${name}`, qualified_name: `${schema}.${name}` });
const OBJECTS = [obj('Table', 'dbo', 'Orders'), obj('Table', 'dbo', 'Customers'), obj('View', 'Sales', 'vOrders'), obj('Procedure', 'dbo', 'usp_Load')];
const rows = (state) => InstanceTree.rows(Object.assign({ databases: ['A', 'B'], objects: new Map(), expanded: new Set(), filter: '' }, state));
const shape = list => list.map(r => `${r.kind}:${r.key}`);

suite('InstanceTree.rows', () => {
	test('closed, only the databases show', () => {
		assert.deepStrictEqual(shape(rows()), ['db:db:A', 'db:db:B']);
	});

	test('an open database whose objects are not there yet says it is loading', () => {
		const list = rows({ expanded: new Set(['db:A']) });
		assert.deepStrictEqual(list.map(r => r.kind), ['db', 'note', 'db']);
		assert.strictEqual(list[1].text, 'Loading…');
	});

	test('a database that could not be read shows why', () => {
		const list = rows({ expanded: new Set(['db:A']), objects: new Map([['A', { error: 'denied' }]]) });
		assert.strictEqual(list[1].text, 'denied');
		assert.strictEqual(list[1].error, true);
	});

	test('an open database lists its groups, with counts, in a fixed order; groups start closed', () => {
		const list = rows({ expanded: new Set(['db:A']), objects: new Map([['A', OBJECTS]]) });
		assert.deepStrictEqual(list.map(r => r.kind === 'group' ? `${r.label}(${r.count})` : r.kind), ['db', 'Tables(2)', 'Views(1)', 'Procedures(1)', 'db']);
	});

	test('an open group lists its objects, one level deeper', () => {
		const list = rows({ expanded: new Set(['db:A', 'grp:A:Table']), objects: new Map([['A', OBJECTS]]) });
		const objects = list.filter(r => r.kind === 'object');
		assert.deepStrictEqual(objects.map(r => r.object.name), ['Orders', 'Customers']);
		assert.ok(objects.every(r => r.depth === 2));
	});

	test('an empty database says so', () => {
		const list = rows({ expanded: new Set(['db:A']), objects: new Map([['A', []]]) });
		assert.strictEqual(list[1].kind, 'note');
	});

	test('the filter opens what holds a match and hides the rest', () => {
		const list = rows({ filter: 'order', objects: new Map([['A', OBJECTS], ['B', [obj('Table', 'dbo', 'Other')]]]) });
		assert.deepStrictEqual(list.filter(r => r.kind === 'db').map(r => r.database), ['A']);
		assert.deepStrictEqual(list.filter(r => r.kind === 'object').map(r => r.object.name), ['Orders', 'Sales.vOrders']);
	});

	test('a database that matches by name keeps all its objects, and stays as the user left it', () => {
		const list = rows({ filter: 'a', databases: ['A', 'Z'], expanded: new Set(['db:A']), objects: new Map([['A', OBJECTS]]) });
		assert.deepStrictEqual(list.filter(r => r.kind === 'db').map(r => r.database), ['A']);
		assert.deepStrictEqual(list.filter(r => r.kind === 'group').map(r => r.count), [2, 1, 1]);
		assert.ok(list.filter(r => r.kind === 'group').every(r => !r.open));
	});

	test('a database never read can only match by its name', () => {
		assert.deepStrictEqual(rows({ filter: 'order' }), []);
		assert.strictEqual(rows({ filter: 'b' }).length, 1);
	});

	test('keys are unique even for the same name in two databases', () => {
		const list = rows({ expanded: new Set(['db:A', 'db:B', 'grp:A:Table', 'grp:B:Table']), objects: new Map([['A', OBJECTS], ['B', OBJECTS]]) });
		const keys = list.map(r => r.key);
		assert.strictEqual(new Set(keys).size, keys.length);
	});
});
