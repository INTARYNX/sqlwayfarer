/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

/**
 * Connection Handlers - save, load, delete, test connections
 */
class ConnectionHandlers {
    constructor(postMessage, connectionManager, connectionStorage) {
        this._post = postMessage;
        this._connectionManager = connectionManager;
        this._connectionStorage = connectionStorage;
    }

    async handleConnect(connectionConfig) {
        try {
            const result = await this._connectionManager.connect(connectionConfig);
            this._post({ command: 'connectionStatus', success: result.success, message: result.message });
            return result.success;
        } catch (error) {
            this._post({ command: 'connectionStatus', success: false, message: `Connection failed: ${error.message}` });
            return false;
        }
    }

    async handleLoadConnectionForDisplay(connectionName) {
        try {
            const connection = await this._connectionManager.getConnectionForDisplay(connectionName);
            this._post({ command: 'connectionLoadedForDisplay', connection });
        } catch (error) {
            this._post({ command: 'error', message: `Failed to load connection: ${error.message}` });
        }
    }

    async handleConnectWithSaved(connectionName) {
        try {
            const result = await this._connectionManager.connectWithSaved(connectionName);
            this._post({ command: 'connectionStatus', success: result.success, message: result.message });
            return result.success;
        } catch (error) {
            this._post({ command: 'error', message: `Failed to connect with saved connection: ${error.message}` });
            return false;
        }
    }

    async handleSaveConnection(connectionConfig) {
        try {
            const result = await this._connectionStorage.saveConnection(connectionConfig);
            this._post({ command: 'connectionSaved', success: result.success, message: result.message });
            return result.success;
        } catch (error) {
            this._post({ command: 'connectionSaved', success: false, message: `Failed to save connection: ${error.message}` });
            return false;
        }
    }

    async handleDeleteConnection(connectionName) {
        try {
            const result = await this._connectionStorage.deleteConnection(connectionName);
            this._post({ command: 'connectionDeleted', success: result.success, message: result.message });
            return result.success;
        } catch (error) {
            this._post({ command: 'connectionDeleted', success: false, message: `Failed to delete connection: ${error.message}` });
            return false;
        }
    }

    async handleLoadConnections() {
        try {
            const connections = this._connectionStorage.getSavedConnections();
            this._post({ command: 'savedConnectionsLoaded', connections });
        } catch (error) {
            console.error('Error loading saved connections:', error);
            this._post({ command: 'error', message: 'Failed to load saved connections' });
        }
    }

    async handleTestConnection(connectionConfig) {
        try {
            const result = await this._connectionManager.testConnection(connectionConfig);
            this._post({ command: 'testConnectionResult', success: result.success, message: result.message });
        } catch (error) {
            this._post({ command: 'testConnectionResult', success: false, message: `Connection test failed: ${error.message}` });
        }
    }
}

module.exports = ConnectionHandlers;
