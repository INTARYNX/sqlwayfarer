'use strict';

const { readSchemaModel } = require('../../database/schemaCatalog');
const { diffModels } = require('../../database/schemaDiff');
const { buildMigrationScript, supportsCreateOrAlter } = require('../../database/migrationScript');
const { getSnapshotSupport, listSnapshots, listComparableDatabases, planSnapshot, createSnapshot, dropSnapshot } = require('../../database/dbSnapshots');

// The Compare tab: the database the queries run on against a reference (a
// snapshot of it, or another database of the instance), and the re-entrant
// script of the difference. Reads go through the tab's own connection, never a
// schema source; a snapshot is only taken or dropped after a yes.
//
// confirm(message, detail, action) -> boolean is the panel's dialog, passed in so
// this stays testable.
class CompareHandlers {
    constructor(post, { connectionManager, confirm, now = () => new Date() }) {
        this._post = post;
        this._connectionManager = connectionManager;
        this._confirm = confirm;
        this._now = now;
        this._last = null;
    }

    _fail(message) {
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
            this._last = { database, reference, diff, createOrAlter };
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

module.exports = CompareHandlers;
