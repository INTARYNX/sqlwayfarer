// Times, on the database made by generateLegacyDatabase.js: the full index build, the Explorer
// queries, the autocompletion per keystroke, the dependency / impact / footprint views and the
// update of the index after one procedure changed (that procedure is altered: a comment is added).
//
//   SQLWAYFARER_TEST_SQL='{...}' node test/tools/measureLegacyDatabase.js
const os = require('os'), path = require('path'), fs = require('fs').promises;
const sql = require('mssql');
global.SqlContext = require('../../webview/sqlContext');
global.SqlMatcher = require('../../webview/sqlMatcher');
const SqlAutocomplete = require('../../webview/sqlAutocomplete');
const DatabaseService = require('../../database/DatabaseService');
const DependencyService = require('../../database/DependencyService');
const WriteFootprintService = require('../../database/WriteFootprintService');
const IndexService = require('../../database/IndexServices');
const CONFIG = JSON.parse(process.env.SQLWAYFARER_TEST_SQL || 'null');
if (!CONFIG) { console.error('Set SQLWAYFARER_TEST_SQL to the JSON connection of a scratch SQL Server (see AGENTS.md, "Live tests").'); process.exit(1); }
const DB = process.env.SQLWAYFARER_LEGACY_DB || 'WayfarerLegacy';
const connection = database => ({ server: CONFIG.server, user: CONFIG.user, password: CONFIG.password, options: CONFIG.options, requestTimeout: 300000, database });
const ms = t => `${(Number(process.hrtime.bigint() - t) / 1e6).toFixed(1)} ms`;
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
(async () => {
	const pool = await new sql.ConnectionPool(connection('master')).connect();
	const manager = {
		isConnected: () => true, getServerName: () => CONFIG.server,
		executeQuery: async (q, params) => { const r = pool.request(); for (const [k, v] of Object.entries(params || {})) r.input(k, v); return r.query(q); },
		executeQueryInDatabase: async (db, q, params) => { const r = pool.request(); for (const [k, v] of Object.entries(params || {})) r.input(k, v); return r.query(`USE [${db}];\n${q}`); }
	};
	const dbs = new DatabaseService(manager);
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlwf-legacy-'));
	const service = new IndexService(manager, dbs); service._indexDir = dir;
	const deps = new DependencyService(manager, dbs); deps.setIndexService(service);
	const footprint = new WriteFootprintService(manager, service, dbs);

	let t = process.hrtime.bigint(); const objects = await dbs.getObjects(DB);
	console.log(`EXPLORER  getObjects: ${objects.length} objects in ${ms(t)}`);
	t = process.hrtime.bigint(); const fks = await dbs.getForeignKeys(DB); console.log(`EXPLORER  getForeignKeys: ${fks.length} in ${ms(t)}`);

	t = process.hrtime.bigint(); await service.getIndex(DB); console.log(`INDEX     full build: ${ms(t)}`);
	t = process.hrtime.bigint(); const status = await service.getIndexStatus(DB); console.log(`INDEX     status (stale check): ${ms(t)} ${JSON.stringify(status).slice(0, 120)}`);

	// Columns the editor fetches on demand: all of them here, to have the whole cache.
	const columns = {}; const parameters = {};
	t = process.hrtime.bigint();
	for (const o of objects) { const key = `${DB}::${o.qualified_name.toLowerCase()}`; if (o.object_type === 'Procedure') parameters[key] = await dbs.getObjectParameters(DB, o.qualified_name); else columns[key] = await dbs.getObjectColumns(DB, o.qualified_name); }
	console.log(`EDITOR    fetching every column list (${Object.keys(columns).length} objects), one query each: ${ms(t)} (the editor does it one object at a time, on demand)`);
	const env = { objects, foreignKeys: fks, databases: ['master', DB], currentDatabase: DB, getColumns: (db, q) => columns[`${db || DB}::${q.toLowerCase()}`], getParameters: (db, q) => parameters[`${db || DB}::${q.toLowerCase()}`], getDatabaseObjects: () => objects, settings: {}, usage: new Map(), force: true };
	const tables = objects.filter(o => o.object_type === 'Table'); const a = tables[10].qualified_name, b = tables[200].qualified_name, c = tables[400].qualified_name;
	const cases = {
		'FROM <empty> (all 2806 objects)': 'SELECT * FROM |',
		'FROM s<prefix>': 'SELECT * FROM sal|',
		'SELECT <empty> FROM t (columns of one table)': `SELECT | FROM ${a} x`,
		'alias.<empty> (columns of a table)': `SELECT x.| FROM ${a} x`,
		'JOIN ON (join suggestions, FK-aware)': `SELECT * FROM ${a} x JOIN ${b} y ON |`,
		'3 tables, WHERE <empty>': `SELECT * FROM ${a} x JOIN ${b} y ON y.${tables[200].qualified_name.length ? 'x' : 'x'}=x.x JOIN ${c} z ON z.x=y.x WHERE |`,
		'EXEC <empty> (1576 procedures)': 'EXEC |',
		'CTE + temp table reference': `WITH c AS (SELECT * FROM ${a}) SELECT c.| FROM c`
	};
	console.log('AUTOCOMPLETE compute (in the webview, per keystroke), 100 runs each:');
	for (const [name, text0] of Object.entries(cases)) {
		const caret = text0.indexOf('|'); const text = text0.replace('|', '');
		SqlAutocomplete.compute(text, caret, env); // warm
		const times = []; let n = 0;
		for (let i = 0; i < 100; i++) { const s = process.hrtime.bigint(); n = SqlAutocomplete.compute(text, caret, env).items.length; times.push(Number(process.hrtime.bigint() - s) / 1e6); }
		console.log(`   ${name.padEnd(46)} ${String(n).padStart(5)} items  median ${pct(times, 0.5).toFixed(1)} ms  p95 ${pct(times, 0.95).toFixed(1)} ms`);
	}

	// The heaviest orchestrator
	const index = await service.peekIndex(DB);
	const entries = Object.entries(index.objects);
	const [heavyName, heavy] = entries.filter(([, o]) => o.type === 'P').sort((x, y) => (y[1].dependencies || []).length - (x[1].dependencies || []).length)[0];
	t = process.hrtime.bigint(); await deps.getDependencyTree(DB, heavyName, 3); console.log(`EXPLORER  dependency tree (depth 3) of ${heavyName} (${(heavy.dependencies || []).length} direct): ${ms(t)}`);
	t = process.hrtime.bigint(); await deps.getImpactAnalysis(DB, tables[10].qualified_name); console.log(`EXPLORER  impact analysis of ${tables[10].qualified_name}: ${ms(t)}`);
	t = process.hrtime.bigint(); const fp = await footprint.analyze(DB, heavyName); console.log(`FOOTPRINT ${heavyName}: ${fp.tables ? fp.tables.length : 0} tables written, in ${ms(t)}`);
	t = process.hrtime.bigint(); const usage = await service.getColumnUsage(DB, tables[10].qualified_name); console.log(`EXPLORER  column usage of ${tables[10].qualified_name}: ${usage ? Object.keys(usage).length : 0} columns used, ${ms(t)}`);

	// One procedure changed: what the index says, and what it costs to bring it up to date
	const [victimKey] = entries.find(([k, o]) => o.type === 'P' && /usp(Load|Get)/.test(k)) || entries.find(([, o]) => o.type === 'P');
	const vq = victimKey.split('.').map(x => `[${x}]`).join('.');
	await pool.request().batch(`USE [${DB}]; DECLARE @d nvarchar(max) = OBJECT_DEFINITION(OBJECT_ID('${vq}')); SET @d = REPLACE(@d, 'CREATE PROCEDURE', 'ALTER PROCEDURE') + CHAR(13) + CHAR(10) + '-- touched'; EXEC (@d)`);
	t = process.hrtime.bigint(); const status2 = await service.getIndexStatus(DB); console.log(`REINDEX   after altering ${vq}: status in ${ms(t)} -> ${JSON.stringify(status2).slice(0, 220)}`);
	t = process.hrtime.bigint(); await service.getIndex(DB); console.log(`REINDEX   incremental update: ${ms(t)}`);
	const stats = (await service.getBuildStats(DB)).runs[0]; console.log(`          last run: mode ${stats.mode}, analyzed ${stats.analyzedObjects}, reused ${stats.reusedObjects}, ${Math.round(stats.durationMs)} ms`);
	console.log(`rss ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
	await service.dispose(); await pool.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.stack); process.exit(1); });
