const assert = require('assert');
const { isActionableType, buildDrop, buildRename, validateNewName } = require('../database/instanceActions');

suite('instanceActions', () => {
	test('DROP names the kind of the object and brackets both parts', () => {
		assert.strictEqual(buildDrop('Table', 'dbo', 'Orders'), 'DROP TABLE [dbo].[Orders];');
		assert.strictEqual(buildDrop('View', 'Sales', 'vOrders'), 'DROP VIEW [Sales].[vOrders];');
		assert.strictEqual(buildDrop('Procedure', 'dbo', 'usp_Load'), 'DROP PROCEDURE [dbo].[usp_Load];');
		assert.strictEqual(buildDrop('Function', 'dbo', 'fnTotal'), 'DROP FUNCTION [dbo].[fnTotal];');
	});

	test('a "]" in a name cannot close the bracket early', () => {
		assert.strictEqual(buildDrop('Table', 'dbo', 'a]; DROP DATABASE x; --'), 'DROP TABLE [dbo].[a]]; DROP DATABASE x; --];');
	});

	test('RENAME gives the old name qualified and the new one bare, quotes doubled', () => {
		assert.strictEqual(buildRename('Table', 'dbo', 'Orders', 'OrdersOld'), "EXEC sp_rename N'[dbo].[Orders]', N'OrdersOld', N'OBJECT';");
		assert.strictEqual(buildRename('View', 'dbo', "it's", "O'Brien"), "EXEC sp_rename N'[dbo].[it''s]', N'O''Brien', N'OBJECT';");
	});

	test('only tables, views, procedures and functions are acted on', () => {
		assert.ok(['Table', 'View', 'Procedure', 'Function'].every(isActionableType));
		for (const type of ['Trigger', 'Database', 'SQL_TRIGGER', '', undefined, 'toString']) {
			assert.strictEqual(isActionableType(type), false, String(type));
			assert.throws(() => buildDrop(type, 'dbo', 'x'));
			assert.throws(() => buildRename(type, 'dbo', 'x', 'y'));
		}
	});

	test('a new name must be a plain, different, non-empty name', () => {
		assert.strictEqual(validateNewName('Orders2', 'Orders'), null);
		assert.strictEqual(validateNewName('My Table', 'Orders'), null);
		assert.ok(validateNewName('', 'Orders'));
		assert.ok(validateNewName('   ', 'Orders'));
		assert.ok(validateNewName(' Orders2', 'Orders'));
		assert.ok(validateNewName('Orders2 ', 'Orders'));
		assert.ok(validateNewName('Sales.Orders', 'Orders'));
		assert.ok(validateNewName('Orders', 'Orders'));
		assert.ok(validateNewName('x'.repeat(129), 'Orders'));
		assert.strictEqual(validateNewName('x'.repeat(128), 'Orders'), null);
		assert.ok(validateNewName(undefined, 'Orders'));
	});
});
