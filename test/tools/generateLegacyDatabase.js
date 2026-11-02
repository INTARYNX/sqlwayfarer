// Generates a synthetic "legacy" database on a scratch SQL Server: 700 tables, 200 views,
// 180 functions, ~1600 procedures (CRUD, reports with CTEs and temp tables, dynamic SQL,
// cursors, MERGE, orchestrators with TRY/CATCH) and 150 triggers. Deterministic.
//
//   SQLWAYFARER_TEST_SQL='{"server":"localhost","user":"me","password":"...","options":{"trustServerCertificate":true,"encrypt":false}}' \
//       node test/tools/generateLegacyDatabase.js        # (re)creates WayfarerLegacy, drops it first if it exists
//
// measureLegacyDatabase.js then times the index, the Explorer and the autocompletion on it.
const sql = require('mssql');
const CONFIG = JSON.parse(process.env.SQLWAYFARER_TEST_SQL || 'null');
if (!CONFIG) { console.error('Set SQLWAYFARER_TEST_SQL to the JSON connection of a scratch SQL Server (see AGENTS.md, "Live tests").'); process.exit(1); }
const DB = process.env.SQLWAYFARER_LEGACY_DB || 'WayfarerLegacy';
const connection = database => ({ server: CONFIG.server, user: CONFIG.user, password: CONFIG.password, options: CONFIG.options, requestTimeout: 300000, database });
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

const SCHEMAS = ['dbo', 'sales', 'hr', 'inv', 'fin', 'audit'];
const WORDS = ['Customer', 'Order', 'Invoice', 'Payment', 'Product', 'Stock', 'Supplier', 'Employee', 'Contract', 'Ledger', 'Account', 'Shipment', 'Return', 'Price', 'Tax', 'Region', 'Contact', 'Ticket', 'Batch', 'Journal', 'Budget', 'Asset', 'Lot', 'Rate', 'Plan', 'Quote', 'Claim', 'Policy', 'Vendor', 'Item'];
const SUFFIX = ['', 'Line', 'Header', 'History', 'Detail', 'Ref', 'Type', 'Status', 'Link', 'Archive', 'Staging', 'Log'];
const COLTYPES = ['int', 'bigint', 'nvarchar(50)', 'nvarchar(200)', 'varchar(20)', 'decimal(18,2)', 'datetime', 'datetime2(3)', 'bit', 'uniqueidentifier', 'money', 'nvarchar(max)', 'date', 'smallint', 'char(3)'];

const tables = [];   // { schema, name, cols:[{name,type}], pk }
const used = new Set();
while (tables.length < 700) {
	const schema = pick(SCHEMAS);
	const name = pick(WORDS) + pick(SUFFIX) + (rnd() < 0.5 ? int(1, 99) : '');
	const key = `${schema}.${name}`;
	if (used.has(key)) continue;
	used.add(key);
	const cols = [{ name: `${name}ID`, type: 'int' }];
	const n = int(8, 40);
	for (let i = 0; i < n; i++) cols.push({ name: pick(['Code', 'Name', 'Label', 'Amount', 'Qty', 'Price', 'Date', 'Created', 'Updated', 'Flag', 'Status', 'Notes', 'Ref', 'Total', 'Rate', 'Seq', 'Owner', 'Source', 'Kind', 'Value']) + int(1, 60), type: pick(COLTYPES) });
	const seen = new Set(); const uniq = cols.filter(c => !seen.has(c.name) && seen.add(c.name));
	tables.push({ schema, name, cols: uniq });
}
const full = t => `[${t.schema}].[${t.name}]`;

const batches = [];
batches.push(...SCHEMAS.filter(s => s !== 'dbo').map(s => `CREATE SCHEMA ${s}`));
tables.forEach((t, i) => {
	const defs = t.cols.map((c, k) => `    [${c.name}] ${c.type} ${k === 0 ? 'IDENTITY(1,1) NOT NULL' : 'NULL'}`);
	defs.push(`    CONSTRAINT PK_${t.schema}_${t.name} PRIMARY KEY ([${t.cols[0].name}])`);
	if (i > 5) for (let f = 0, nfk = rnd() < 0.7 ? int(1, 3) : 0; f < nfk; f++) {
		const ref = tables[int(0, i - 1)];
		const col = t.cols.find(c => c.type === 'int' && c !== t.cols[0] && !c.fk);
		if (!col) break;
		col.fk = true;
		defs.push(`    CONSTRAINT FK_${t.schema}_${t.name}_${f}_${ref.schema}_${ref.name} FOREIGN KEY ([${col.name}]) REFERENCES ${full(ref)}([${ref.cols[0].name}])`);
	}
	batches.push(`CREATE TABLE ${full(t)} (\n${defs.join(',\n')}\n)`);
});

const memo = new Map();
// One stable non-key column per table: every statement that uses "the" column of a table agrees on its type.
const colOf = t => { if (!memo.has(t)) memo.set(t, pick(t.cols.slice(1))); return memo.get(t); };
const names = [];
const reg = (kind, n) => names.push({ kind, name: n });

// Views
for (let i = 0; i < 200; i++) {
	const a = pick(tables), b = pick(tables), c = pick(tables);
	const n = `${pick(SCHEMAS)}.v${pick(WORDS)}${i}`;
	batches.push(`CREATE VIEW ${n} AS\nSELECT a.[${a.cols[0].name}], a.[${colOf(a).name}] AS A1, b.[${colOf(b).name}] AS B1, c.[${colOf(c).name}] AS C1\nFROM ${full(a)} a\nJOIN ${full(b)} b ON b.[${b.cols[0].name}] = a.[${a.cols[0].name}]\nLEFT JOIN ${full(c)} c ON c.[${c.cols[0].name}] = b.[${b.cols[0].name}]\nWHERE a.[${colOf(a).name}] IS NOT NULL`);
	reg('V', n);
}
// Functions
for (let i = 0; i < 100; i++) { const n = `dbo.fn${pick(WORDS)}Calc${i}`; batches.push(`CREATE FUNCTION ${n} (@x decimal(18,2), @rate decimal(9,4))\nRETURNS decimal(18,2)\nAS\nBEGIN\n    DECLARE @r decimal(18,2) = @x * (1 + @rate / 100.0);\n    IF @r < 0 SET @r = 0;\n    RETURN ROUND(@r, 2);\nEND`); reg('FN', n); }
for (let i = 0; i < 60; i++) { const t = pick(tables); const n = `dbo.tvf${pick(WORDS)}Lookup${i}`; batches.push(`CREATE FUNCTION ${n} (@id int)\nRETURNS TABLE\nAS\nRETURN (SELECT t.[${t.cols[0].name}], t.[${colOf(t).name}] AS V FROM ${full(t)} t WHERE t.[${t.cols[0].name}] = @id)`); reg('TF', n); }
for (let i = 0; i < 20; i++) { const t = pick(tables); const n = `dbo.mtvf${pick(WORDS)}List${i}`; batches.push(`CREATE FUNCTION ${n} (@from int, @to int)\nRETURNS @r TABLE (Id int, V nvarchar(200))\nAS\nBEGIN\n    INSERT @r SELECT t.[${t.cols[0].name}], CAST(t.[${colOf(t).name}] AS nvarchar(200)) FROM ${full(t)} t WHERE t.[${t.cols[0].name}] BETWEEN @from AND @to;\n    RETURN;\nEND`); reg('TF', n); }

// Procedures
const procs = [];
const idCol = t => t.cols[0].name;
function crud(t, n) {
	const c1 = colOf(t);
	const kind = int(0, 3);
	if (kind === 0) return `CREATE PROCEDURE ${n} @Id int AS\nBEGIN\n    SET NOCOUNT ON;\n    SELECT * FROM ${full(t)} WHERE [${idCol(t)}] = @Id;\nEND`;
	if (kind === 1) return `CREATE PROCEDURE ${n} @Id int, @V ${c1.type} AS\nBEGIN\n    SET NOCOUNT ON;\n    UPDATE ${full(t)} SET [${c1.name}] = @V WHERE [${idCol(t)}] = @Id;\nEND`;
	if (kind === 2) return `CREATE PROCEDURE ${n} @V ${c1.type} AS\nBEGIN\n    SET NOCOUNT ON;\n    INSERT INTO ${full(t)} ([${c1.name}]) VALUES (@V);\n    SELECT SCOPE_IDENTITY() AS NewId;\nEND`;
	return `CREATE PROCEDURE ${n} @Id int AS\nBEGIN\n    SET NOCOUNT ON;\n    DELETE FROM ${full(t)} WHERE [${idCol(t)}] = @Id;\nEND`;
}
function report(n) {
	const a = pick(tables), b = pick(tables), c = pick(tables), d = pick(tables);
	const lines = [`CREATE PROCEDURE ${n} @From datetime = NULL, @To datetime = NULL AS`, 'BEGIN', '    SET NOCOUNT ON;',
		`    IF OBJECT_ID('tempdb..#work') IS NOT NULL DROP TABLE #work;`,
		`    WITH base AS (\n        SELECT a.[${idCol(a)}] AS Id, a.[${colOf(a).name}] AS V\n        FROM ${full(a)} a\n        WHERE a.[${colOf(a).name}] IS NOT NULL\n    ), agg AS (\n        SELECT b.[${idCol(b)}] AS Id, COUNT(*) AS N, COUNT(b.[${colOf(b).name}]) AS M FROM ${full(b)} b GROUP BY b.[${idCol(b)}]\n    )`,
		`    SELECT base.Id, base.V, agg.N, agg.M INTO #work FROM base LEFT JOIN agg ON agg.Id = base.Id;`,
		`    CREATE TABLE #tmp (Id int, Total int);`,
		`    INSERT #tmp SELECT c.[${idCol(c)}], COUNT(c.[${colOf(c).name}]) FROM ${full(c)} c GROUP BY c.[${idCol(c)}];`,
		`    UPDATE ${full(d)} SET [${colOf(d).name}] = [${colOf(d).name}] WHERE [${idCol(d)}] IN (SELECT Id FROM #tmp WHERE Total > 100);`,
		`    SELECT w.*, t.Total, f.[${idCol(a)}] AS FId FROM #work w JOIN #tmp t ON t.Id = w.Id OUTER APPLY (SELECT TOP 1 x.[${idCol(a)}] FROM ${full(a)} x WHERE x.[${idCol(a)}] = w.Id) f ORDER BY w.Id;`,
		`    DROP TABLE #work; DROP TABLE #tmp;`, 'END'];
	return lines.join('\n');
}
function dynamic(n) {
	const a = pick(tables), b = pick(tables);
	return `CREATE PROCEDURE ${n} @Table sysname, @Where nvarchar(400) = NULL AS\nBEGIN\n    SET NOCOUNT ON;\n    DECLARE @sql nvarchar(max);\n    SET @sql = N'SELECT TOP 100 * FROM ' + QUOTENAME(@Table) + ISNULL(N' WHERE ' + @Where, N'');\n    EXEC sp_executesql @sql;\n    EXEC ('UPDATE ${full(a)} SET [${colOf(a).name}] = [${colOf(a).name}] WHERE [${idCol(a)}] = 0');\n    INSERT ${full(b)} ([${colOf(b).name}]) SELECT TOP 1 [${colOf(b).name}] FROM ${full(b)};\nEND`;
}
function cursorProc(n) {
	const a = pick(tables), b = pick(tables);
	return `CREATE PROCEDURE ${n} AS\nBEGIN\n    SET NOCOUNT ON;\n    DECLARE @id int, @v nvarchar(200);\n    DECLARE cur CURSOR FAST_FORWARD FOR SELECT [${idCol(a)}], CAST([${colOf(a).name}] AS nvarchar(200)) FROM ${full(a)};\n    OPEN cur;\n    FETCH NEXT FROM cur INTO @id, @v;\n    WHILE @@FETCH_STATUS = 0\n    BEGIN\n        UPDATE ${full(b)} SET [${colOf(b).name}] = [${colOf(b).name}] WHERE [${idCol(b)}] = @id;\n        FETCH NEXT FROM cur INTO @id, @v;\n    END\n    CLOSE cur; DEALLOCATE cur;\nEND`;
}
function mergeProc(n) {
	const a = pick(tables), b = a;
	return `CREATE PROCEDURE ${n} AS\nBEGIN\n    SET NOCOUNT ON;\n    DECLARE @out TABLE (Id int, Act nvarchar(10));\n    MERGE ${full(a)} AS tgt\n    USING (SELECT [${idCol(b)}] AS Id, [${a.cols[1].name}] AS V FROM ${full(b)}) AS src ON tgt.[${idCol(a)}] = src.Id\n    WHEN MATCHED THEN UPDATE SET [${a.cols[1].name}] = src.V\n    WHEN NOT MATCHED THEN INSERT ([${a.cols[1].name}]) VALUES (src.V)\n    OUTPUT inserted.[${idCol(a)}], $action INTO @out;\n    SELECT * FROM @out;\nEND`;
}
function orchestrator(n, earlier) {
	const calls = Array.from({ length: int(2, 6) }, () => `        EXEC ${pick(earlier)}${rnd() < 0.5 ? ' @Id = 1' : ''};`).join('\n');
	const t = pick(tables);
	return `CREATE PROCEDURE ${n} AS\nBEGIN\n    SET NOCOUNT ON;\n    BEGIN TRY\n        BEGIN TRAN;\n${calls}\n        INSERT INTO ${full(t)} ([${colOf(t).name}]) SELECT TOP 1 [${colOf(t).name}] FROM ${full(t)};\n        COMMIT;\n    END TRY\n    BEGIN CATCH\n        IF @@TRANCOUNT > 0 ROLLBACK;\n        THROW;\n    END CATCH\nEND`;
}
for (let i = 0; i < 1600; i++) {
	const r = rnd();
	const n = `${pick(SCHEMAS)}.usp${pick(WORDS)}${pick(['Get', 'Set', 'Load', 'Sync', 'Calc', 'Close', 'Open', 'Check', 'Build', 'Purge'])}${i}`;
	let body;
	if (r < 0.40) body = crud(pick(tables), n);
	else if (r < 0.65) body = report(n);
	else if (r < 0.75) body = dynamic(n);
	else if (r < 0.90 && procs.length > 20) body = orchestrator(n, procs.slice(Math.max(0, procs.length - 200)));
	else if (r < 0.95) body = cursorProc(n);
	else body = mergeProc(n);
	procs.push(n);
	batches.push(body);
	reg('P', n);
}
// Triggers
const auditInts = tables.filter(x => x.cols.some((c, k) => k > 0 && c.type === 'int'));
for (let i = 0; i < 150; i++) {
	const t = pick(tables), a = pick(auditInts), ac = a.cols.find((c, k) => k > 0 && c.type === 'int');
	const n = `[${t.schema}].[trg_${t.name}_${i}]`;
	batches.push(`CREATE TRIGGER ${n} ON ${full(t)} AFTER INSERT, UPDATE, DELETE AS\nBEGIN\n    SET NOCOUNT ON;\n    INSERT INTO ${full(a)} ([${ac.name}]) SELECT COUNT(*) FROM inserted;\n    IF EXISTS (SELECT 1 FROM deleted) UPDATE ${full(a)} SET [${ac.name}] = [${ac.name}] WHERE 1 = 0;\nEND`);
}

(async () => {
	const master = await new sql.ConnectionPool(connection('master')).connect();
	await master.request().batch(`IF DB_ID('${DB}') IS NOT NULL BEGIN ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DB}]; END`);
	await master.request().batch(`CREATE DATABASE [${DB}]`);
	await master.close();
	const pool = await new sql.ConnectionPool(connection(DB)).connect();
	let failed = 0;
	const t0 = Date.now();
	for (const b of batches) { try { await pool.request().batch(b); } catch (e) { failed++; if (failed < 6) console.log('FAIL', e.message.slice(0, 120), '|', b.split('\n')[0]); } }
	console.log(`created ${batches.length - failed}/${batches.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
	const c = await pool.request().query("SELECT type_desc, COUNT(*) n FROM sys.objects WHERE is_ms_shipped = 0 GROUP BY type_desc ORDER BY 2 DESC");
	console.log(c.recordset.map(r => `${r.type_desc}:${r.n}`).join('  '));
	await pool.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
