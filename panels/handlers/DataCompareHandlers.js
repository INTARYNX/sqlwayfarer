'use strict';

const { readSchemaModel } = require('../../database/schemaCatalog');
const { planDataTables, supportsDataCompare, compareTableData, rowCountEstimates } = require('../../database/dataDiff');
const { buildDataScript } = require('../../database/dataScript');
const { buildDataExportFiles } = require('../../database/dataExport');
const { zipFiles, fileName } = require('../../database/compareExport');
const { applyScript } = require('../../database/migrationApply');

// The "Data" mode of the Compare tab: which tables of the database the
// queries run on can have their rows compared with a reference (a snapshot
// of it, or another database), the rows that differ, the re-entrant
// MERGE/DELETE script of the tables that were picked, exporting it as a
// zip, and applying it to another database - the data equivalent of
// CompareHandlers.js.
//
// Getting from table list to applied script is three steps, each needing
// the one before: handleGetDataTables (what can be compared) ->
// handleCompareData (what differs, for the tables picked) -> handleBuildScript
// / handleExportZip / handleApply (what to do with it).
//
// Applying reuses the target-connection machinery of the schema CompareHandlers
// (schemaCompare, passed in) rather than keeping its own pool of connections
// to other saved connections: listing/opening a target database does not
// depend on whether the script compares schema or data.
class DataCompareHandlers {
    constructor(post, { connectionManager, schemaCompare, confirm, now = () => new Date(), saveFile = async () => null, writeFile = (target, data) => require('fs').promises.writeFile(target, data) }) {
        this._post = post;
        this._connectionManager = connectionManager;
        this._schemaCompare = schemaCompare;
        this._confirm = confirm;
        this._now = now;
        this._saveFile = saveFile;
        this._writeFile = writeFile;
        this._last = null; // { database, reference, comparable, results }
        this._applying = false;
        this._stop = false;
    }

    reset() {
        this._last = null;
        this._stop = true;
        this._applying = false;
    }

    async dispose() {
        this._stop = true;
        this._last = null;
    }

    _fail(message) {
        if (/USE statement is not supported/i.test(String(message))) message = 'Data compare reads two databases of the same instance, which Azure SQL Database does not allow (it has no USE).';
        this._post({ command: 'dataCompareFailed', message });
    }

    // The tables that can have their data compared, with an estimated row
    // count on each side, and whether the server supports it at all (FOR JSON,
    // SQL Server 2016+).
    async handleGetDataTables(database, reference) {
        if (!database || !reference) { this._fail('Pick a database and a reference.'); return; }
        if (reference.toLowerCase() === database.toLowerCase()) { this._fail('The reference is the database itself.'); return; }
        try {
            const before = await readSchemaModel(this._connectionManager, reference);
            const after = await readSchemaModel(this._connectionManager, database);
            const plan = planDataTables(before, after);
            const [refCounts, curCounts] = await Promise.all([
                rowCountEstimates(this._connectionManager, reference),
                rowCountEstimates(this._connectionManager, database)
            ]);
            const comparable = plan.comparable.map(t => {
                const key = `${t.schema}.${t.name}`;
                return { ...t, rowCountReference: refCounts.has(key) ? refCounts.get(key) : null, rowCountCurrent: curCounts.has(key) ? curCounts.get(key) : null };
            });
            const supported = supportsDataCompare(before.serverVersion) && supportsDataCompare(after.serverVersion);
            this._last = { database, reference, comparable: plan.comparable, results: null };
            this._post({
                command: 'dataCompareTables', database, reference,
                comparable, notComparable: plan.notComparable, onlyInReference: plan.onlyInReference, onlyInCurrent: plan.onlyInCurrent,
                support: { supported, reason: supported ? '' : 'Data compare needs SQL Server 2016 or later, on both sides.' }
            });
        } catch (error) {
            this._last = null;
            this._fail(error.message);
        }
    }

    // Reads the rows of the tables picked, on both sides, and says what differs.
    async handleCompareData(database, reference, tableIds) {
        if (!this._last || this._last.database !== database || this._last.reference !== reference) { this._fail('List the tables first.'); return; }
        const wanted = new Set(Array.isArray(tableIds) ? tableIds : []);
        // this._last.comparable is already in foreign-key order; filtering keeps it.
        const tables = this._last.comparable.filter(t => wanted.has(`${t.schema}.${t.name}`));
        if (tables.length === 0) { this._fail('Pick at least one table.'); return; }
        try {
            const startedAt = Date.now();
            const results = [];
            for (let i = 0; i < tables.length; i++) {
                const table = tables[i];
                this._post({ command: 'dataCompareProgress', done: i, total: tables.length, table: `${table.schema}.${table.name}` });
                const data = await compareTableData(this._connectionManager, { reference, database, table });
                results.push({ ...table, ...data });
            }
            this._post({ command: 'dataCompareProgress', done: tables.length, total: tables.length, table: null });
            this._last.results = results;
            this._post({ command: 'dataCompareResult', database, reference, tables: results, durationMs: Date.now() - startedAt });
        } catch (error) {
            this._last.results = null;
            this._fail(error.message);
        }
    }

    // The script of the rows that were picked, from the last comparison.
    handleBuildScript(ids, includeDeletes) {
        if (!this._last || !this._last.results) { this._fail('Compare the data first.'); return; }
        const { database, reference, results } = this._last;
        const result = buildDataScript(results, { selected: new Set(Array.isArray(ids) ? ids : []), includeDeletes: includeDeletes === true, reference, current: database, now: this._now() });
        this._post({ command: 'dataScript', script: result.script, steps: result.steps, skipped: result.skipped, warnings: result.warnings });
    }

    // The picked tables as a zip: the counts, and the script.
    async handleExportZip(ids, includeDeletes) {
        if (!this._last || !this._last.results) { this._fail('Compare the data first.'); return; }
        const { database, reference, results } = this._last;
        const exported = buildDataExportFiles(results, { ids, includeDeletes: includeDeletes === true, reference, current: database, now: this._now() });
        if (exported.count === 0) { this._fail('Nothing is selected to export.'); return; }
        try {
            const stamp = this._now().toISOString().slice(0, 10);
            const target = await this._saveFile(`data_${fileName(reference)}_to_${fileName(database)}_${stamp}.zip`);
            if (!target) { this._post({ command: 'dataExported', cancelled: true }); return; }
            await this._writeFile(target, await zipFiles(exported.files, this._now()));
            this._post({ command: 'dataExported', path: target, count: exported.count, files: exported.files.length });
        } catch (error) {
            this._fail(`The zip could not be written: ${error.message}`);
        }
    }

    async handleApply(ids, includeDeletes, connection, database) {
        if (!this._last || !this._last.results) { this._fail('Compare the data first.'); return; }
        if (this._applying) { this._fail('A script is being applied.'); return; }
        if (!database) { this._fail('Pick the database to apply the script on.'); return; }
        if (this._schemaCompare._isOwn(connection) && database.toLowerCase() === this._last.database.toLowerCase()) { this._fail('That is the database the rows come from.'); return; }
        this._applying = true;
        this._stop = false;
        try {
            const { reference, database: source, results } = this._last;
            const built = buildDataScript(results, { selected: new Set(Array.isArray(ids) ? ids : []), includeDeletes: includeDeletes === true, reference, current: source, now: this._now() });
            if (built.steps === 0) { this._fail('Nothing to apply for these changes.'); return; }

            const manager = await this._schemaCompare._managerFor(connection);
            const label = this._schemaCompare._label(connection, manager);
            const lines = [`Target: ${database} on ${label}`, ...built.warnings, '', 'The script is re-entrant: a second run changes nothing it already did.'];
            if (!(await this._confirm(`Apply ${built.steps} step(s) to ${database} on ${label}?`, lines.join('\n'), 'Apply'))) {
                this._post({ command: 'dataApplyDeclined' });
                return;
            }

            this._post({ command: 'dataApplyProgress', done: 0, total: 0 });
            const run = await applyScript(manager, database, built.script, {
                onProgress: (done, total) => this._post({ command: 'dataApplyProgress', done, total }),
                shouldStop: () => this._stop
            });
            this._post({
                command: 'dataApplied', connection: connection || null, database, steps: built.steps,
                ran: run.ran, batches: run.batches, errors: run.errors.slice(0, 5), stopped: run.stopped, durationMs: run.durationMs
            });
        } catch (error) {
            this._fail(error.message);
        } finally {
            this._applying = false;
        }
    }

    handleCancelApply() {
        if (this._applying) this._stop = true;
    }
}

module.exports = DataCompareHandlers;
