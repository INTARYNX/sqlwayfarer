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

    async saveConnection(connectionConfig) {
        try {
            const { name, password } = connectionConfig;
            if (!name) throw new Error('Connection name is required');

            if (password) {
                await this._context.secrets.store(`sqlwayfarer.password.${name}`, password);
            }

            this._savedConnections.set(name, { ...connectionConfig, password: undefined });
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
