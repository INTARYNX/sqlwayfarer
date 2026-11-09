const assert = require('assert');
const ObjectDrag = require('../webview/objectDrag');

suite('ObjectDrag', () => {
	test('the full name is database.schema.object, bracketed only where a name needs it', () => {
		assert.strictEqual(ObjectDrag.fullName('AppDb', 'dbo', 'Orders'), 'AppDb.dbo.Orders');
		assert.strictEqual(ObjectDrag.fullName('My Db', 'Sales', 'Order Items'), '[My Db].Sales.[Order Items]');
		assert.strictEqual(ObjectDrag.fullName('Db', 'dbo', 'a]b'), 'Db.dbo.[a]]b]');
		assert.strictEqual(ObjectDrag.fullName('Db', 'dbo', '2024'), 'Db.dbo.[2024]');
		assert.strictEqual(ObjectDrag.fullName(null, 'dbo', 'T'), 'dbo.T');
	});

	test('the database is left out when it is the one the query runs on', () => {
		const queries = { target: 'AppDb', other: false, targetDatabase() { return this.target; }, runsOnOtherConnection() { return this.other; } };
		global.window = { queryManager: queries };
		try {
			assert.strictEqual(ObjectDrag.forEditor('AppDb', 'dbo', 'Orders'), 'dbo.Orders');
			assert.strictEqual(ObjectDrag.forEditor('appdb', 'dbo', 'Orders'), 'dbo.Orders');
			assert.strictEqual(ObjectDrag.forEditor('Other', 'dbo', 'Orders'), 'Other.dbo.Orders');
			queries.other = true;
			assert.strictEqual(ObjectDrag.forEditor('AppDb', 'dbo', 'Orders'), 'AppDb.dbo.Orders');
			queries.other = false;
			queries.target = null;
			assert.strictEqual(ObjectDrag.forEditor('AppDb', 'dbo', 'Orders'), 'AppDb.dbo.Orders');
		} finally {
			delete global.window;
		}
		// No query editor yet: the full name.
		assert.strictEqual(ObjectDrag.forEditor('AppDb', 'dbo', 'Orders'), 'AppDb.dbo.Orders');
	});

	test('an element becomes draggable and carries the name as text', () => {
		const handlers = {};
		const element = { addEventListener: (type, fn) => { handlers[type] = fn; } };
		ObjectDrag.attach(element, () => 'Db.dbo.T');
		assert.strictEqual(element.draggable, true);
		const data = {};
		handlers.dragstart({ dataTransfer: { setData: (type, value) => { data[type] = value; } } });
		assert.deepStrictEqual(data, { 'text/plain': 'Db.dbo.T', 'application/x-sqlwayfarer-object': 'Db.dbo.T' });

		// Nothing to carry: no drag.
		let prevented = false;
		ObjectDrag.attach(element, () => '');
		handlers.dragstart({ preventDefault: () => { prevented = true; }, dataTransfer: {} });
		assert.ok(prevented);
	});
});
