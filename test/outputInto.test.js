const assert = require('assert');
const BabelfishSqlParser = require('../database/BabelfishSqlParser');

// === OUTPUT ... INTO: the clause writes its target table ===

suite('BabelfishSqlParser OUTPUT INTO', () => {
	const parser = new BabelfishSqlParser();
	parser.setEnabled(true);
	const writes = sql => parser.analyzeDefinition(sql).writes;

	test('MERGE ... OUTPUT INTO writes the audit table as well as the target', () => {
		const sql = `CREATE PROCEDURE dbo.p AS
			MERGE dbo.Products AS t USING dbo.Staging AS s ON t.ProductID = s.Id
			WHEN MATCHED THEN UPDATE SET t.Name = s.Val
			OUTPUT $action, inserted.ProductID INTO dbo.AuditLog (Action, Payload);`;
		assert.deepStrictEqual(writes(sql), ['dbo.auditlog', 'dbo.products']);
	});

	test('INSERT ... OUTPUT INTO a temp table', () => {
		const sql = 'INSERT dbo.Orders (Total) OUTPUT inserted.OrderID INTO #ids (OrderID) VALUES (1)';
		assert.ok(writes(sql).includes('dbo.orders'));
		assert.ok(writes(sql).includes('#ids'));
	});

	test('OUTPUT without INTO writes nothing more', () => {
		assert.deepStrictEqual(writes('DELETE FROM dbo.Orders OUTPUT deleted.OrderID WHERE Status = 9'), ['dbo.orders']);
	});

	test('the listed columns of the OUTPUT target are recorded as written', () => {
		const sql = 'UPDATE dbo.Orders SET Total = 1 OUTPUT deleted.Total INTO dbo.AuditLog (Payload)';
		const columns = parser.analyzeDefinition(sql).columns;
		assert.strictEqual(columns['dbo.auditlog'].payload.write, true);
	});

	test('SELECT ... INTO writes the new table, a temp table included', () => {
		assert.deepStrictEqual(writes('SELECT ID, Name INTO #x FROM dbo.Employees WHERE ID > 1'), ['#x']);
		assert.deepStrictEqual(writes('SELECT * INTO dbo.Copy FROM dbo.Employees'), ['dbo.copy']);
		assert.deepStrictEqual(writes('SELECT ID FROM dbo.Employees'), []);
	});
});
