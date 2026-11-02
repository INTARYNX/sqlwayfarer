'use strict';

// === The schema source of a tab ===
//
// A tab runs its queries on its own connection (the "run" target, say
// production). Here the Explorer, the index and the autocompletion can be
// pointed at ANOTHER saved connection (say a development copy): see
// database/ConnectionRouter.js. The target of the queries never changes.
class SchemaSourceHandlers {
    // deps: { router, createManager(), connectionStorage, targetDatabaseService,
    //         getOwnName(), onChanged(name|null) }
    constructor(postMessage, deps) {
        this._post = postMessage;
        this._router = deps.router;
        this._createManager = deps.createManager;
        this._connectionStorage = deps.connectionStorage;
        this._targetDatabaseService = deps.targetDatabaseService;
        this._getOwnName = deps.getOwnName;
        this._onChanged = deps.onChanged;
        this._manager = null;
        this._name = null; // saved connection the schema is read from; null: the run connection
    }

    get activeName() { return this._name; }

    // The connections the schema can come from: every saved connection.
    handleGetSchemaSources() {
        const own = this._getOwnName();
        const sources = this._connectionStorage.getSavedConnections().map(c => ({
            name: c.name, server: c.server, database: c.database || null, isOwn: c.name === own
        }));
        this._post({ command: 'schemaSources', ownName: own, activeName: this._name, sources });
    }

    // The databases of the connection the queries run on (the schema selector
    // lists those of the schema source instead).
    async handleGetQueryDatabases() {
        try {
            const databases = await this._targetDatabaseService.getDatabases();
            this._post({ command: 'queryDatabases', databases });
        } catch (error) {
            this._post({ command: 'queryDatabases', databases: [], message: error.message });
        }
    }

    // name: a saved connection, or empty / the tab's own to go back to the run connection.
    async handleSelectSchemaSource(name, restoring = false) {
        const own = this._getOwnName();
        if (!name || name === own) {
            await this._clear();
            this._post(this._changedMessage(null, restoring));
            this._onChanged(null, restoring);
            return true;
        }
        const manager = this._createManager();
        try {
            await manager.connectWithSaved(name);
        } catch (error) {
            try { await manager.dispose(); } catch { /* nothing was open */ }
            this._post({ command: 'schemaSourceChanged', active: false, activeName: this._name, error: `Could not connect to '${name}': ${error.message}` });
            return false;
        }
        const previous = this._manager;
        this._manager = manager;
        this._name = name;
        this._router.use(manager);
        if (previous) { try { await previous.dispose(); } catch { /* already closed */ } }
        this._post(this._changedMessage(name, restoring));
        this._onChanged(name, restoring);
        return true;
    }

    // The Reconnect action: the schema source is dropped and connected again by restore().
    async reset() {
        await this._clear();
    }

    // After the tab reconnected: the schema source it had is connected again.
    async restore(name) {
        if (!name || name === this._getOwnName()) return;
        if (this._manager && this._manager.isConnected() && this._name === name) return;
        await this.handleSelectSchemaSource(name, true);
    }

    _changedMessage(name) {
        const sources = this._connectionStorage.getSavedConnections();
        const find = n => sources.find(c => c.name === n);
        const own = find(this._getOwnName());
        const schema = name ? find(name) : null;
        return {
            command: 'schemaSourceChanged',
            active: !!name,
            activeName: name,
            schema: schema ? { name: schema.name, server: schema.server } : null,
            run: own ? { name: own.name, server: own.server } : { name: this._getOwnName(), server: null },
            restoring
        };
    }

    async _clear() {
        this._router.use(null);
        const manager = this._manager;
        this._manager = null;
        this._name = null;
        if (manager) { try { await manager.dispose(); } catch { /* already closed */ } }
    }

    async dispose() {
        await this._clear();
    }
}

module.exports = SchemaSourceHandlers;
