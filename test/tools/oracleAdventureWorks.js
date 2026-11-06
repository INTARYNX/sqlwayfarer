// The write footprint against what the server really does, on AdventureWorks and
// its ten triggers. For each probe (an UPDATE, a DELETE or an INSERT of one real row, in
// a procedure made for it) the tool
//   - runs it in a transaction and rolls back, and reads which tables the server
//     says were modified (sys.dm_db_index_usage_stats: the server's own count,
//     which depends on neither the parser nor the index);
//   - asks the write footprint for the same procedure;
//   - lists what the footprint missed (should be nothing) and what it reports
//     that did not happen (a CATCH branch, an IF UPDATE(column) a probe did not
//     reach: the analysis is static, so those are expected).
// The probe procedures are created in dbo and dropped at the end. Not a test:
// it needs AdventureWorks. SQLWAYFARER_TEST_SQL='{...}' node test/tools/oracleAdventureWorks.js
const os = require('os'), path = require('path'), fs = require('fs').promises;
const ConnectionManager = require('../../database/ConnectionManager');
const DatabaseService = require('../../database/DatabaseService');
const IndexService = require('../../database/IndexServices');
const WriteFootprintService = require('../../database/WriteFootprintService');
if (!process.env.SQLWAYFARER_TEST_SQL) { console.error('Set SQLWAYFARER_TEST_SQL to the JSON connection of a scratch SQL Server that has AdventureWorks (see AGENTS.md, "Live tests").'); process.exit(1); }
const live = JSON.parse(process.env.SQLWAYFARER_TEST_SQL);
const DB = 'AdventureWorks';
const PROBES = {
	'update Person.Person': 'UPDATE TOP (1) Person.Person SET MiddleName = MiddleName',
	'update Production.WorkOrder': 'UPDATE TOP (1) Production.WorkOrder SET OrderQty = OrderQty',
	'update Purchasing.PurchaseOrderDetail': 'UPDATE TOP (1) Purchasing.PurchaseOrderDetail SET OrderQty = OrderQty',
	'update Purchasing.PurchaseOrderHeader': 'UPDATE TOP (1) Purchasing.PurchaseOrderHeader SET Status = Status',
	'update Sales.SalesOrderDetail': 'UPDATE TOP (1) Sales.SalesOrderDetail SET OrderQty = OrderQty',
	'update Sales.SalesOrderHeader': 'UPDATE TOP (1) Sales.SalesOrderHeader SET Status = Status',
	'delete HumanResources.Employee': 'DELETE TOP (1) HumanResources.Employee',
	'delete Purchasing.Vendor': 'DELETE TOP (1) Purchasing.Vendor',
	'delete Sales.SalesOrderDetail': 'DELETE TOP (1) Sales.SalesOrderDetail',
	'update Sales.Customer (no trigger)': 'UPDATE TOP (1) Sales.Customer SET TerritoryID = TerritoryID',
	// An INSERT needs a row that the constraints accept: a copy of a real one.
	'insert Production.WorkOrder': 'INSERT Production.WorkOrder (ProductID, OrderQty, ScrappedQty, StartDate, DueDate) SELECT TOP (1) ProductID, OrderQty, ScrappedQty, StartDate, DueDate FROM Production.WorkOrder',
	'insert Purchasing.PurchaseOrderDetail': 'INSERT Purchasing.PurchaseOrderDetail (PurchaseOrderID, DueDate, OrderQty, ProductID, UnitPrice, ReceivedQty, RejectedQty) SELECT TOP (1) PurchaseOrderID, DueDate, OrderQty, ProductID, UnitPrice, ReceivedQty, RejectedQty FROM Purchasing.PurchaseOrderDetail',
	'insert Sales.SalesOrderDetail': 'INSERT Sales.SalesOrderDetail (SalesOrderID, CarrierTrackingNumber, OrderQty, ProductID, SpecialOfferID, UnitPrice, UnitPriceDiscount) SELECT TOP (1) SalesOrderID, CarrierTrackingNumber, OrderQty, ProductID, SpecialOfferID, UnitPrice, UnitPriceDiscount FROM Sales.SalesOrderDetail',
	'insert Person.Person (a BusinessEntity first)': "INSERT Person.BusinessEntity DEFAULT VALUES; INSERT Person.Person (BusinessEntityID, PersonType, NameStyle, FirstName, LastName) VALUES (SCOPE_IDENTITY(), N'EM', 0, N'A', N'B')",
	'insert Sales.Customer (no trigger)': 'INSERT Sales.Customer (PersonID, StoreID, TerritoryID) VALUES (NULL, NULL, NULL)'
};
(async () => {
	const manager = new ConnectionManager({ getConnection: () => ({ name: 'l', server: live.server, authType: 'sql', username: live.user, database: 'master', encrypt: false, trustServerCertificate: true }), getConnectionPassword: async () => live.password });
	await manager.connectWithSaved('l');
	const conn = await manager.acquireConnection();
	const run = async sql => { const r = conn.createRequest(); const res = await r.batch(sql); return res; };
	await run(`USE ${DB}`);
	const names = Object.keys(PROBES);
	for (let i = 0; i < names.length; i++) { await run(`IF OBJECT_ID('dbo.zzProbe${i}') IS NOT NULL DROP PROCEDURE dbo.zzProbe${i}`); await run(`CREATE PROCEDURE dbo.zzProbe${i} AS ${PROBES[names[i]]}`); }
	conn.release();
	const dbs = new DatabaseService(manager);
	const idx = new IndexService(manager, dbs); idx._indexDir = await fs.mkdtemp(path.join(os.tmpdir(), 'awo-'));
	await idx.forceReindex(DB);
	const fp = new WriteFootprintService(manager, idx, dbs);
	const c2 = await manager.acquireConnection();
	const q = async sql => (await c2.createRequest().batch(sql)).recordset;
	await c2.createRequest().batch(`USE ${DB}`);
	const usage = `SELECT SCHEMA_NAME(o.schema_id)+'.'+o.name AS t, SUM(s.user_updates) u FROM sys.dm_db_index_usage_stats s JOIN sys.objects o ON o.object_id=s.object_id WHERE s.database_id=DB_ID() AND o.type='U' GROUP BY o.schema_id,o.name`;
	let bad = 0;
	for (let i = 0; i < names.length; i++) {
		const before = Object.fromEntries((await q(usage)).map(r => [r.t, Number(r.u)]));
		let note = '';
		try { await c2.createRequest().batch(`BEGIN TRAN; EXEC dbo.zzProbe${i}; ROLLBACK`); } catch (e) { note = ' (the statement ended with: ' + e.message.slice(0, 70) + ')'; }
		await c2.createRequest().batch('IF @@TRANCOUNT > 0 ROLLBACK');
		const after = Object.fromEntries((await q(usage)).map(r => [r.t, Number(r.u)]));
		const observed = Object.keys(after).filter(t => (after[t] || 0) > (before[t] || 0)).sort();
		const res = await fp.analyze(DB, `dbo.zzProbe${i}`);
		const ours = res.tables.filter(t => t.access === 'write').map(t => t.qualifiedName).sort();
		const missing = observed.filter(t => !ours.includes(t)), extra = ours.filter(t => !observed.includes(t));
		const ok = !missing.length && !extra.length; if (!ok) bad++;
		console.log(`${ok ? 'MATCH' : 'DIFF '} ${names[i]}${note}\n      observed ${JSON.stringify(observed)}\n      footprint ${JSON.stringify(ours)}  triggers ${JSON.stringify(res.triggersFired)}${missing.length ? '\n      MISSED by the footprint: ' + missing : ''}${extra.length ? '\n      NOT observed: ' + extra : ''}`);
	}
	console.log(`\n${names.length - bad} match, ${bad} differ`);
	c2.release();
	const c3 = await manager.acquireConnection(); await c3.createRequest().batch(`USE ${DB}`);
	for (let i = 0; i < names.length; i++) await c3.createRequest().batch(`DROP PROCEDURE dbo.zzProbe${i}`);
	c3.release(); await idx.dispose(); await manager.dispose();
})().catch(e => { console.error(e); process.exit(1); });
