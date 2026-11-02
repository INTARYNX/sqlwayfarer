'use strict';

// The saved connections, managed from the sidebar: list, create, edit,
// delete, test. Opening one in a tab is not done here (see
// panels/connectionLauncher.js).
class SavedConnectionHandlers {
    // openConnectionNames: names of the connections that have a tab open.
    // confirmDelete(name): asks the user, resolves to true to go ahead - done
    // by the extension, a webview cannot show a dialog of its own.
    // whenReady: resolves once the connection storage is readable.
    // onRenamed(oldName, newName): a saved connection changed name.
    // openConnection(name): opens it in a tab.
    constructor(postMessage, connectionManager, connectionStorage, {
        openConnectionNames = () => [],
        confirmDelete = async () => true,
        whenReady = () => Promise.resolve(),
        onRenamed = () => {},
        openConnection = async () => {}
    } = {}) {
        this._post = postMessage;
        this._connectionManager = connectionManager;
        this._connectionStorage = connectionStorage;
        this._openConnectionNames = openConnectionNames;
        this._confirmDelete = confirmDelete;
        this._whenReady = whenReady;
        this._onRenamed = onRenamed;
        this._openConnection = openConnection;
    }

    async handleLoadConnections() {
        try {
            // The storage may not be readable yet (the view loads before it
            // is) - wait for it rather than answering with an empty list.
            await this._whenReady();
            this._post({
                command: 'savedConnectionsLoaded',
                connections: this._connectionStorage.getSavedConnections(),
                lastConnection: this._connectionStorage.getLastConnectionName(),
                openConnections: this._openConnectionNames()
            });
        } catch (error) {
            console.error('Error loading saved connections:', error);
            this._post({ command: 'connectionsError', message: 'Failed to load saved connections' });
        }
    }

    async handleSaveConnection(connectionConfig, originalName = null) {
        try {
            const result = await this._connectionStorage.saveConnection(connectionConfig, originalName);
            this._post({ command: 'connectionSaved', success: result.success, message: result.message });
            if (result.success && originalName && originalName !== connectionConfig.name) {
                this._onRenamed(originalName, connectionConfig.name);
            }
            return result.success;
        } catch (error) {
            this._post({ command: 'connectionSaved', success: false, message: `Failed to save connection: ${error.message}` });
            return false;
        }
    }

    // Saves, refreshes the list, and opens the connection in a tab.
    async handleSaveAndOpenConnection(connectionConfig, originalName = null) {
        const ok = await this.handleSaveConnection(connectionConfig, originalName);
        if (!ok) return false;
        await this.handleLoadConnections();
        await this._openConnection(connectionConfig.name);
        return true;
    }

    async handleDeleteConnection(connectionName) {
        try {
            if (!(await this._confirmDelete(connectionName))) return false;
            const result = await this._connectionStorage.deleteConnection(connectionName);
            this._post({ command: 'connectionDeleted', success: result.success, message: result.message });
            return result.success;
        } catch (error) {
            this._post({ command: 'connectionDeleted', success: false, message: `Failed to delete connection: ${error.message}` });
            return false;
        }
    }

    async handleTestConnection(connectionConfig) {
        try {
            await this._connectionManager.testConnection(connectionConfig);
            this._post({ command: 'testConnectionResult', success: true, message: 'Connection test successful!' });
        } catch (error) {
            this._post({ command: 'testConnectionResult', success: false, message: `Connection test failed: ${error.message}` });
        }
    }
}

module.exports = SavedConnectionHandlers;
