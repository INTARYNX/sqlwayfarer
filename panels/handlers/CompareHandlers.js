'use strict';

const { readSchemaModel } = require('../../database/schemaCatalog');
const { diffModels } = require('../../database/schemaDiff');
const { buildMigrationScript, supportsCreateOrAlter } = require('../../database/migrationScript');
const { classifyTarget, applyScript } = require('../../database/migrationApply');
const { buildExportFiles, zipFiles, fileName } = require('../../database/compareExport');
const { getSnapshotSupport, listSnapshots, listComparableDatabases, planSnapshot, createSnapshot, dropSnapshot } = require('../../database/dbSnapshots');

// The Compare tab: the database the queries run on against a reference (a
// snapshot of it, or another database of the instance), and the re-entrant
// script of the difference. Reads go through the tab's own connection, never a
// schema source; a snapshot is only taken or dropped after a yes.
//
// The script can also be applied, after a yes, to another database of the
// connection or of another saved connection: where the target stands against
// the changes is read first, and the result is checked after.
//
// confirm(message, detail, action) -> boolean is the panel's dialog, passed in so
// this stays testable. createManager() opens a connection of its own (another
// saved connection), connectionStorage lists them, getOwnName() names this tab's.
class CompareHandlers {
    constructor(post, { connectionManager, confirm, now = () => new Date(), connectionStorage = null, createManager = null, getOwnName = () => null, saveFile = async () => null, writeFile = (target, data) => require('fs').promises.writeFile(target, data) }) {
        this._post = post;
        this._saveFile = saveFile;
        this._writeFile = writeFile;
        this._connectionManager = connectionManager;
        this._confirm = confirm;
        this._now = now;
        this._connectionStorage = connectionStorage;
        this._createManager = createManager;
        this._getOwnName = getOwnName;
        this._targets = new Map();   // saved connection name -> its manager
        this._last = null;
        this._applying = false;
        this._stop = false;
    }

    // A new connection of the tab: the last comparison and the connections opened for targets are over.
    async reset() {
        this._last = null;
        const managers = [...this._targets.values()];
        this._targets.clear();
        for (const manager of managers) { try { await manager.dispose(); } catch { /* already closed */ } }
    }

    async dispose() {
        this._stop = true;
        await this.reset();
    }

    _fail(message) {
        // Azure SQL Database has no USE: two databases cannot be read from one connection.
        if (/USE statement is not supported/i.test(String(message))) message = 'Compare reads two databases of the same instance, which Azure SQL Database does not allow (it has no USE).';
        this._post({ command: 'compareFailed', message });
    }

    // The references that can be picked for a database, and whether it can have a snapshot.
    async handleGetSources(database) {
        if (!database) { this._post({ command: 'compareSources', database: null, snapshots: [], databases: [], support: { supported: false, reason: 'Select a database first.' } }); return; }
        try {
            const [snapshots, databases, support] = await Promise.all([
                listSnapshots(this._connectionManager, database),
                listComparableDatabases(this._connectionManager, database),
                getSnapshotSupport(this._connectionManager, database)
            ]);
            this._post({ command: 'compareSources', database, snapshots, databases, support });
        } catch (error) {
            this._fail(error.message);
        }
    }

    async handleCompare(database, reference) {
        if (!database || !reference) { this._fail('Pick a database and a reference.'); return; }
        if (reference.toLowerCase() === database.toLowerCase()) { this._fail('The reference is the database itself.'); return; }
        try {
            const startedAt = Date.now();
            const before = await readSchemaModel(this._connectionManager, reference);
            const after = await readSchemaModel(this._connectionManager, database);
            const diff = diffModels(before, after);
            const createOrAlter = supportsCreateOrAlter(after.serverVersion);
            this._last = { database, reference, diff, createOrAlter, referenceModel: before, currentModel: after };
            this._post({
                command: 'compareResult', database, reference, diff,
                serverVersion: after.serverVersion, createOrAlter, durationMs: Date.now() - startedAt
            });
        } catch (error) {
            this._last = null;
            this._fail(error.message);
        }
    }

    // The script of the changes that were picked, from the last comparison.
    handleBuildScript(ids, allowDestructive, legacy) {
        if (!this._last) { this._fail('Compare first.'); return; }
        const { database, reference, diff, createOrAlter } = this._last;
        const result = buildMigrationScript(diff, {
            selected: new Set(Array.isArray(ids) ? ids : []),
            allowDestructive: allowDestructive === true,
            createOrAlter: legacy === true ? false : createOrAlter,
            reference, current: database, now: this._now()
        });
        this._post({ command: 'compareScript', script: result.script, steps: result.steps, skipped: result.skipped, warnings: result.warnings });
    }

    // The picked changes as a zip: the list, the script, and the whole code of each object before and after.
    // saveFile(defaultName) -> path or null (the panel's save dialog), writeFile(path, buffer) the disk.
    async handleExportZip(ids, allowDestructive, legacy) {
        if (!this._last) { this._fail('Compare first.'); return; }
        const { database, reference } = this._last;
        const exported = buildExportFiles(this._last, { ids, allowDestructive, legacy, now: this._now() });
        if (exported.count === 0) { this._fail('Nothing is selected to export.'); return; }
        try {
            const stamp = this._now().toISOString().slice(0, 10);
            const target = await this._saveFile(`compare_${fileName(reference)}_to_${fileName(database)}_${stamp}.zip`);
            if (!target) { this._post({ command: 'compareExported', cancelled: true }); return; }
            await this._writeFile(target, await zipFiles(exported.files, this._now()));
            this._post({ command: 'compareExported', path: target, count: exported.count, files: exported.files.length });
        } catch (error) {
            this._fail(`The zip could not be written: ${error.message}`);
        }
    }

    async handleTakeSnapshot(database) {
        try {
            const plan = await planSnapshot(this._connectionManager, database, this._now());
            const detail = `${plan.sql}\n\nThe snapshot is read-only and grows as ${database} changes (copy on write); `
                + `${database} cannot be dropped or restored while it exists. Drop it when it is no longer needed.`;
            if (!(await this._confirm(`Take a snapshot of ${database}?`, detail, 'Take snapshot'))) return;
            const name = await createSnapshot(this._connectionManager, plan);
            this._post({ command: 'compareSnapshotDone', name, action: 'taken' });
        } catch (error) {
            this._fail(error.message);
        }
        await this.handleGetSources(database);
    }

    async handleDropSnapshot(database, name) {
        try {
            const snapshot = (await listSnapshots(this._connectionManager, database)).find(s => s.name === name);
            if (!snapshot) { this._fail(`${name} is not a snapshot of ${database}.`); return; }
            if (!(await this._confirm(`Drop the snapshot ${name}?`, `DROP DATABASE [${name}]\n\nThe snapshot is gone; ${database} is not touched.`, 'Drop snapshot'))) return;
            await dropSnapshot(this._connectionManager, name);
            this._post({ command: 'compareSnapshotDone', name, action: 'dropped' });
        } catch (error) {
            this._fail(error.message);
        }
        await this.handleGetSources(database);
    }
}

// === Applying ===

const MAX_LISTED = 8;

Object.assign(CompareHandlers.prototype, {
    _isOwn(connection) {
        return !connection || connection === this._getOwnName();
    },

    // The manager of a target: this tab's connection, or another saved connection opened on demand.
    async _managerFor(connection) {
        if (this._isOwn(connection)) return this._connectionManager;
        if (this._targets.has(connection)) return this._targets.get(connection);
        if (!this._createManager) throw new Error('Other connections are not available here.');
        const manager = this._createManager();
        try {
            await manager.connectWithSaved(connection);
        } catch (error) {
            try { await manager.dispose(); } catch { /* nothing was open */ }
            throw new Error(`Could not connect to '${connection}': ${error.message}`);
        }
        this._targets.set(connection, manager);
        return manager;
    },

    _label(connection, manager) {
        return this._isOwn(connection) ? `${manager.getServerName()} (this connection)` : `${manager.getServerName()} (${connection})`;
    },

    // The connections a script can be applied on: this tab's, and the saved ones.
    handleGetTargets() {
        const own = this._getOwnName();
        const saved = this._connectionStorage ? this._connectionStorage.getSavedConnections() : [];
        this._post({
            command: 'compareTargets',
            own: { name: own, server: this._connectionManager.getServerName() },
            connections: saved.filter(c => c.name !== own).map(c => ({ name: c.name, server: c.server }))
        });
    },

    async handleGetTargetDatabases(connection) {
        try {
            const manager = await this._managerFor(connection);
            // On this connection the database that is compared is not a target of its own script.
            const exclude = this._isOwn(connection) && this._last ? this._last.database : null;
            this._post({ command: 'compareTargetDatabases', connection: connection || null, databases: await listComparableDatabases(manager, exclude) });
        } catch (error) {
            this._post({ command: 'compareTargetDatabases', connection: connection || null, databases: [], message: error.message });
        }
    },

    // Reads the target and says where it stands, and what the script would be for it.
    async _plan(ids, allowDestructive, legacy, connection, database) {
        const last = this._last;
        const manager = await this._managerFor(connection);
        // Only what the dialog offers: never a system database, a snapshot, or what is not online.
        const allowed = await listComparableDatabases(manager, null);
        if (!allowed.some(name => name.toLowerCase() === String(database).toLowerCase())) {
            throw new Error(`${database} is not a database a script can be applied on (a system database, a snapshot, or not online).`);
        }
        const target = await readSchemaModel(manager, database);
        const picked = Array.isArray(ids) ? ids : [];
        const standing = classifyTarget(picked, diffModels(last.referenceModel, target), diffModels(target, last.currentModel));
        const createOrAlter = legacy === true ? false : supportsCreateOrAlter(target.serverVersion);
        const built = buildMigrationScript(last.diff, {
            selected: new Set(picked), allowDestructive: allowDestructive === true, createOrAlter,
            reference: last.reference, current: last.database, now: this._now()
        });
        return { manager, target, standing, built, createOrAlter };
    },

    _sameAsSource(connection, database) {
        return this._isOwn(connection) && this._last && database.toLowerCase() === this._last.database.toLowerCase();
    },

    async handleTargetStatus(ids, allowDestructive, legacy, connection, database) {
        if (!this._last) { this._fail('Compare first.'); return; }
        if (!database) { this._fail('Pick the database to apply the script on.'); return; }
        if (this._sameAsSource(connection, database)) { this._fail('That is the database the changes come from.'); return; }
        try {
            const { target, standing, built, createOrAlter } = await this._plan(ids, allowDestructive, legacy, connection, database);
            this._post({
                command: 'compareTargetStatus', connection: connection || null, database,
                serverVersion: target.serverVersion, createOrAlter,
                counts: { done: standing.done.length, pending: standing.pending.length, differs: standing.differs.length },
                differs: standing.differs.slice(0, MAX_LISTED),
                steps: built.steps, skipped: built.skipped.length, skippedReason: built.skipped.length > 0 ? built.skipped[0].reason : '', warnings: built.warnings
            });
        } catch (error) {
            this._fail(error.message);
        }
    },

    async handleApply(ids, allowDestructive, legacy, connection, database) {
        if (!this._last) { this._fail('Compare first.'); return; }
        if (this._applying) { this._fail('A script is being applied.'); return; }
        if (!database) { this._fail('Pick the database to apply the script on.'); return; }
        if (this._sameAsSource(connection, database)) { this._fail('That is the database the changes come from.'); return; }
        this._applying = true;
        this._stop = false;
        try {
            const plan = await this._plan(ids, allowDestructive, legacy, connection, database);
            const { manager, standing, built } = plan;
            if (built.steps === 0) { this._fail('Nothing to apply for these changes.'); return; }

            const label = this._label(connection, manager);
            const lines = [
                `Target: ${database} on ${label}`,
                `${standing.done.length} change(s) already as in ${this._last.database} · ${standing.pending.length} to do · ${standing.differs.length} partly done or different from ${this._last.reference}`
            ];
            if (standing.differs.length > 0) lines.push(`Partly done or different (the script finishes what is half done, and overwrites what is different): ${standing.differs.slice(0, MAX_LISTED).join(', ')}${standing.differs.length > MAX_LISTED ? ', …' : ''}`);
            if (built.skipped.length > 0) lines.push(`${built.skipped.length} step(s) left out: ${built.skipped[0].reason}`);
            if (built.warnings.length > 0) lines.push(...built.warnings);
            lines.push('', 'The script is re-entrant and stops at the first error: fix it and apply it again.');
            if (!(await this._confirm(`Apply ${built.steps} step(s) to ${database} on ${label}?`, lines.join('\n'), 'Apply'))) {
                this._post({ command: 'compareApplyDeclined' });
                return;
            }

            this._post({ command: 'compareApplyProgress', done: 0, total: 0 });
            const run = await applyScript(manager, database, built.script, {
                onProgress: (done, total) => this._post({ command: 'compareApplyProgress', done, total }),
                shouldStop: () => this._stop
            });

            // What is left, once it ran: the picked changes the target still differs on.
            const picked = new Set(ids);
            let remaining = [];
            try {
                const after = await readSchemaModel(manager, database);
                remaining = diffModels(after, this._last.currentModel).changes.map(c => `${c.kind}:${c.name}`).filter(id => picked.has(id));
            } catch { /* the target cannot be read again: the errors say what happened */ }
            this._post({
                command: 'compareApplied', connection: connection || null, database, steps: built.steps, ran: run.ran, batches: run.batches,
                errors: run.errors.slice(0, 5), stopped: run.stopped, durationMs: run.durationMs,
                remaining: remaining.slice(0, MAX_LISTED * 2), remainingCount: remaining.length, leftOut: built.skipped.length
            });
        } catch (error) {
            this._fail(error.message);
        } finally {
            this._applying = false;
        }
    },

    handleCancelApply() {
        if (this._applying) this._stop = true;
    }
});

module.exports = CompareHandlers;
