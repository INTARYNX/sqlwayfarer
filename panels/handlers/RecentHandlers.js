'use strict';

const { readRecentChanges, readDefinition } = require('../../database/recentChanges');

// The "Modified since" view of the Compare tab: what was created or altered in a
// database lately, from the dates of the server, and the code of what is picked.
// Read through the tab's own connection, never a schema source.
class RecentHandlers {
    constructor(post, { connectionManager }) {
        this._post = post;
        this._connectionManager = connectionManager;
    }

    async handleGetRecent(database, minutes, snapshot) {
        if (!database) { this._post({ command: 'recentFailed', message: 'Select a database first.' }); return; }
        try {
            this._post({ command: 'recentChanges', ...(await readRecentChanges(this._connectionManager, database, minutes, snapshot)) });
        } catch (error) {
            this._post({ command: 'recentFailed', message: error.message });
        }
    }

    async handleGetDefinition(database, schema, name) {
        if (!database || !schema || !name) return;
        try {
            this._post({ command: 'recentDefinition', database, schema, name, definition: await readDefinition(this._connectionManager, database, schema, name) });
        } catch (error) {
            this._post({ command: 'recentDefinition', database, schema, name, definition: null, message: error.message });
        }
    }
}

module.exports = RecentHandlers;
