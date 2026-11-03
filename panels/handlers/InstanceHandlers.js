'use strict';

const { isActionableType, buildDrop, buildRename, validateNewName, getDependents } = require('../../database/instanceActions');

const MAX_LISTED = 12;

// The "Instance" tree of the Query tab: the objects of the databases of the
// connection the queries run on, and the actions on them. Rename and Delete
// show the exact SQL and what depends on the object, wait for a yes, and run
// on the panel's own session (so an open transaction applies to them too).
//
// ask(prompt, value, validate) -> string | undefined and confirm(message,
// detail) -> boolean are the panel's dialogs, passed in so this stays testable.
class InstanceHandlers {
    constructor(post, { databaseService, connectionManager, query, ask, confirm }) {
        this._post = post;
        this._databaseService = databaseService;
        this._connectionManager = connectionManager;
        this._query = query;
        this._ask = ask;
        this._confirm = confirm;
    }

    async handleGetInstanceDatabases() {
        try {
            this._post({ command: 'instanceDatabases', databases: await this._databaseService.getDatabases() });
        } catch (error) {
            this._post({ command: 'instanceDatabases', databases: [], message: error.message });
        }
    }

    async handleGetInstanceObjects(database) {
        try {
            const objects = await this._databaseService.getObjects(database);
            this._post({ command: 'instanceObjects', database, objects });
        } catch (error) {
            this._post({ command: 'instanceObjectsError', database, message: error.message });
        }
    }

    // The schema and the name come separately, as the server reports them: a
    // name that contains a dot must not be read as another schema's object.
    _target(database, schema, name, objectType) {
        if (!database || !schema || !name || !isActionableType(objectType)) return null;
        return { schema, name };
    }

    async _impact(database, target) {
        try {
            const dependents = await getDependents(this._connectionManager, database, target.schema, target.name);
            if (dependents.length === 0) return 'Nothing in this database refers to it.';
            const shown = dependents.slice(0, MAX_LISTED).join('\n  ');
            const more = dependents.length > MAX_LISTED ? `\n  … and ${dependents.length - MAX_LISTED} more` : '';
            return `${dependents.length} object(s) refer to it and would break:\n  ${shown}${more}`;
        } catch {
            return 'The objects that refer to it could not be listed.';
        }
    }

    async handleRename(database, schema, name, objectType) {
        const target = this._target(database, schema, name, objectType);
        if (!target) return;
        const newName = await this._ask(`New name of ${target.schema}.${target.name}`, target.name, value => validateNewName(value, target.name));
        if (newName === undefined) return;
        const problem = validateNewName(newName, target.name);
        if (problem) { this._post({ command: 'error', message: problem }); return; }

        const sqlText = buildRename(objectType, target.schema, target.name, newName);
        const detail = `${sqlText}\n\n${await this._impact(database, target)}\nThe objects that refer to it keep the old name until they are changed.`;
        if (!(await this._confirm(`Rename ${target.schema}.${target.name} to ${newName} in ${database}?`, detail, 'Rename'))) return;
        await this._run(database, sqlText);
    }

    async handleDrop(database, schema, name, objectType) {
        const target = this._target(database, schema, name, objectType);
        if (!target) return;
        const sqlText = buildDrop(objectType, target.schema, target.name);
        const detail = `${sqlText}\n\n${await this._impact(database, target)}`;
        if (!(await this._confirm(`Delete ${target.schema}.${target.name} from ${database}?`, detail, 'Delete'))) return;
        await this._run(database, sqlText);
    }

    async _run(database, sqlText) {
        try {
            await this._query.runStatement(database, sqlText);
            this._post({ command: 'instanceChanged', database });
        } catch (error) {
            this._post({ command: 'error', message: error.message });
        }
    }
}

module.exports = InstanceHandlers;
