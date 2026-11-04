'use strict';

const CONNECTIONS_KEY = 'sqlwayfarer.connections';

// Passwords are stored in VS Code secrets API; only non-sensitive config goes in the connections map.
// The secret storage is shared by every window of VS Code: a change is read from it before it is
// made (not from what this window loaded long ago), and a change made by another window is picked up.
class ConnectionStorage {
    constructor(context) {
        this._context = context;
        this._savedConnections = new Map();
        this._listeners = new Set();
        // Writes go one after the other, each from what the previous one left.
        this._queue = Promise.resolve();
    }

    async initialize() {
        await this._loadSavedConnections();
        const onDidChange = this._context.secrets.onDidChange;
        if (typeof onDidChange === 'function') {
            onDidChange.call(this._context.secrets, async event => {
                if (event.key !== CONNECTIONS_KEY) return;
                try {
                    await this._loadSavedConnections();
                    for (const listener of this._listeners) listener();
                } catch (error) {
                    console.warn('Could not read the connections changed by another window:', error.message);
                }
            });
        }
    }

    // listener() is called when the saved connections changed, whoever made it.
    // Returns the function that stops listening.
    onDidChange(listener) {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    _exclusively(task) {
        const run = this._queue.then(async () => {
            await this._loadSavedConnections();
            return task();
        });
        this._queue = run.catch(() => {});
        return run;
    }

    async saveConnection(connectionConfig, originalName = null) {
        try {
            return await this._exclusively(() => this._saveConnection(connectionConfig, originalName));
        } catch (error) {
            return { success: false, message: `Failed to save connection: ${error.message}` };
        }
    }

    async _saveConnection(connectionConfig, originalName) {
        try {
            const { name, password } = connectionConfig;
            if (!name) throw new Error('Connection name is required');

            const isRename = !!originalName && originalName !== name;

            // A name that is taken is not overwritten (with its password): neither by
            // a new connection, nor by renaming another one onto it.
            if (name !== originalName && this._savedConnections.has(name)) {
                return { success: false, message: `A connection named '${name}' already exists.` };
            }

            // On a rename without a newly typed password, carry over the existing secret
            // instead of leaving the new entry without one and the old secret orphaned.
            let secretToStore = password;
            if (!secretToStore && isRename) {
                secretToStore = await this.getConnectionPassword(originalName);
            }
            if (secretToStore) {
                await this._context.secrets.store(`sqlwayfarer.password.${name}`, secretToStore);
            }

            this._savedConnections.set(name, { ...connectionConfig, password: undefined });

            if (isRename) {
                await this._context.secrets.delete(`sqlwayfarer.password.${originalName}`);
                this._savedConnections.delete(originalName);
                // Keep the auto-connect pointer valid across a rename.
                if (this.getLastConnectionName() === originalName) {
                    await this.setLastConnectionName(name);
                }
            }

            await this._persistConnections();
            return { success: true, message: `Connection '${name}' saved successfully!` };
        } catch (error) {
            return { success: false, message: `Failed to save connection: ${error.message}` };
        }
    }

    // Several connections at once (an import), written to the secret storage
    // once instead of once each. No password is touched: an entry over a
    // connection of the same name was merged before it got here (see
    // mergeIntoExisting), so the password the user saved stays with it.
    // Returns the names that were saved and the ones refused (no name).
    async saveConnections(configs) {
        return this._exclusively(() => this._saveConnections(configs));
    }

    async _saveConnections(configs) {
        const before = new Map(this._savedConnections);
        const saved = [];
        const failed = [];
        for (const config of configs) {
            if (!config || !config.name) { failed.push((config && config.name) || ''); continue; }
            this._savedConnections.set(config.name, { ...config, password: undefined });
            saved.push(config.name);
        }
        try {
            await this._persistConnections();
        } catch (error) {
            this._savedConnections = before;
            throw error;
        }
        return { saved, failed };
    }

    async deleteConnection(connectionName) {
        try {
            return await this._exclusively(() => this._deleteConnection(connectionName));
        } catch (error) {
            return { success: false, message: `Failed to delete connection: ${error.message}` };
        }
    }

    async _deleteConnection(connectionName) {
        try {
            if (!connectionName) throw new Error('Connection name is required');
            // The secret is only dropped once the connection is known to be
            // there: deleting a name that does not exist must not erase the
            // password of another connection that happens to share it.
            if (!this._savedConnections.has(connectionName)) {
                throw new Error(`Connection '${connectionName}' not found`);
            }
            await this._context.secrets.delete(`sqlwayfarer.password.${connectionName}`);
            this._savedConnections.delete(connectionName);
            // Drop the auto-connect pointer if it referenced the deleted connection.
            if (this.getLastConnectionName() === connectionName) {
                await this.setLastConnectionName(null);
            }
            await this._persistConnections();
            return { success: true, message: `Connection '${connectionName}' deleted successfully!` };
        } catch (error) {
            return { success: false, message: `Failed to delete connection: ${error.message}` };
        }
    }

    getSavedConnections() {
        return Array.from(this._savedConnections.entries()).map(([name, config]) => ({ name, ...config }));
    }

    getConnection(connectionName) {
        const config = this._savedConnections.get(connectionName);
        return config ? { name: connectionName, ...config } : null;
    }

    async getConnectionPassword(connectionName) {
        try {
            return await this._context.secrets.get(`sqlwayfarer.password.${connectionName}`);
        } catch (error) {
            console.error(`Error retrieving password for connection '${connectionName}':`, error);
            return null;
        }
    }

    hasConnection(connectionName) {
        return this._savedConnections.has(connectionName);
    }

    // Name of the last saved connection the user connected to, used to
    // pre-select and auto-connect on startup. Non-sensitive, so plain
    // globalState (shared across windows like the connections themselves).
    getLastConnectionName() {
        return this._context.globalState.get('sqlwayfarer.lastConnection') || null;
    }

    async setLastConnectionName(name) {
        await this._context.globalState.update('sqlwayfarer.lastConnection', name || undefined);
    }

    async _loadSavedConnections() {
        try {
            const json = await this._context.secrets.get(CONNECTIONS_KEY);
            this._savedConnections = json ? new Map(Object.entries(JSON.parse(json))) : new Map();
        } catch (error) {
            console.error('Error loading saved connections:', error);
            throw new Error(`Failed to load saved connections: ${error.message}`);
        }
    }

    async _persistConnections() {
        await this._context.secrets.store(CONNECTIONS_KEY, JSON.stringify(Object.fromEntries(this._savedConnections)));
    }
}

module.exports = ConnectionStorage;
