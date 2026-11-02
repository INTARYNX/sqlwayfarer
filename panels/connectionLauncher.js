'use strict';

const { connectionIdentity } = require('../database/connectionIdentity');

// Opens a saved connection in a tab: reveals the tab that already has it, or
// creates one. Kept apart from extension.js so the rules can be tested without
// VS Code - everything that touches it comes in through `ui` and `createPanel`.
class ConnectionLauncher {
    // ready: resolves once the connection storage is readable.
    // createPanel(name): opens a new tab connected to that saved connection.
    // ui: { pick(items, placeHolder), info(message), error(message), focusSidebar() }
    // openLastConnection(): the user's setting - the command opens the last
    // connection straight away instead of asking which one.
    constructor({ storage, registry, ready = Promise.resolve(), createPanel, ui, openLastConnection = () => true }) {
        this._storage = storage;
        this._registry = registry;
        this._ready = ready;
        this._createPanel = createPanel;
        this._ui = ui;
        this._openLastConnection = openLastConnection;
    }

    async open(name) {
        await this._ready;
        const saved = this._storage.getConnection(name);
        if (!saved) {
            this._ui.error(`Connection '${name}' was not found.`);
            return null;
        }
        // One tab per server + login: a connection already open, under this
        // name or another one, is shown instead of opened twice.
        const existing = this._registry.findByConnectionName(name)
            || this._registry.findByConnectionIdentity(connectionIdentity(saved), null);
        if (existing) {
            existing.reveal();
            // Another saved connection of the same server + login (typically
            // another database): the tab serves both, say so and move it to
            // the database that was asked for.
            if (existing.connectionName !== name) {
                if (saved.database && typeof existing.selectDatabase === 'function') existing.selectDatabase(saved.database);
                this._ui.info(`'${name}' has the same server and login as '${existing.connectionName}', which is already open: showing that tab${saved.database ? ` on ${saved.database}` : ''}.`);
            }
            return existing;
        }
        return this._createPanel(name);
    }

    // The command palette / title bar entry. Opens the last connection
    // straight away when the user asked for that, otherwise lets them pick.
    async openDefault() {
        await this._ready;
        const last = this._storage.getLastConnectionName();
        if (this._openLastConnection() && last && this._storage.hasConnection(last)) {
            return this.open(last);
        }

        const connections = this._storage.getSavedConnections();
        if (connections.length === 0) {
            this._ui.info('Create a connection in the SQL Wayfarer sidebar first.');
            this._ui.focusSidebar();
            return null;
        }

        const open = new Set(this._registry.openConnectionNames());
        const items = connections
            .map(c => ({
                label: c.name,
                description: c.server + (c.port ? `:${c.port}` : ''),
                detail: open.has(c.name) ? 'Already open - switches to its tab' : undefined
            }))
            // The last used one first.
            .sort((a, b) => (b.label === last) - (a.label === last));
        const picked = await this._ui.pick(items, 'Open which connection?');
        return picked ? this.open(picked.label) : null;
    }
}

module.exports = ConnectionLauncher;
