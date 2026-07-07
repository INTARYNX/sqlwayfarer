'use strict';

// Passwords are stored in VS Code secrets API; only non-sensitive config goes in the connections map
class ConnectionStorage {
    constructor(context) {
        this._context = context;
        this._savedConnections = new Map();
    }

    async initialize() {
        await this._loadSavedConnections();
    }

    async saveConnection(connectionConfig, originalName = null) {
        try {
            const { name, password } = connectionConfig;
            if (!name) throw new Error('Connection name is required');

            const isRename = !!originalName && originalName !== name;

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

    async deleteConnection(connectionName) {
        try {
            if (!connectionName) throw new Error('Connection name is required');
            await this._context.secrets.delete(`sqlwayfarer.password.${connectionName}`);
            if (!this._savedConnections.delete(connectionName)) {
                throw new Error(`Connection '${connectionName}' not found`);
            }
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

    // Whether to auto-connect to the last connection on startup. Defaults to
    // enabled (the feature the user asked for); the checkbox can turn it off.
    getAutoConnectEnabled() {
        const value = this._context.globalState.get('sqlwayfarer.autoConnect');
        return value === undefined ? true : !!value;
    }

    async setAutoConnectEnabled(enabled) {
        await this._context.globalState.update('sqlwayfarer.autoConnect', !!enabled);
    }

    async _loadSavedConnections() {
        try {
            const json = await this._context.secrets.get('sqlwayfarer.connections');
            if (json) this._savedConnections = new Map(Object.entries(JSON.parse(json)));
        } catch (error) {
            console.error('Error loading saved connections:', error);
            throw new Error(`Failed to load saved connections: ${error.message}`);
        }
    }

    async _persistConnections() {
        await this._context.secrets.store('sqlwayfarer.connections', JSON.stringify(Object.fromEntries(this._savedConnections)));
    }
}

module.exports = ConnectionStorage;
