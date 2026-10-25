'use strict';

const { connectionIdentity } = require('../../database/connectionIdentity');

const NOOP_PANEL_CONTROLLER = {
    findDuplicate: () => null,
    reveal: () => {},
    onConnectionChanged: () => {},
    notify: () => {}
};

class ConnectionHandlers {
    constructor(postMessage, connectionManager, connectionStorage, panelController = NOOP_PANEL_CONTROLLER, whenReady = () => Promise.resolve()) {
        this._post = postMessage;
        this._connectionManager = connectionManager;
        this._connectionStorage = connectionStorage;
        this._panelController = panelController;
        // Resolved once the connection storage is readable. The webview asks
        // for the saved connections as soon as its page loads, which now
        // happens before the storage has been read - answering with an empty
        // list at that point would leave the tab with no connection to pick.
        this._whenReady = whenReady;
    }

    // One tab per server+login: a second connection to the same server would
    // make the per-connection query history ambiguous (and share the
    // per-connection draft bucket), so it is refused and the other tab is
    // revealed instead. The tab that tried has to say so plainly - a silent
    // refusal leaves it looking broken.
    _refuseDuplicate(identity, label) {
        const duplicate = this._panelController.findDuplicate(identity);
        if (!duplicate) return false;
        this._panelController.reveal(duplicate);
        const name = label ? `'${label}'` : 'This connection';
        const message = `${name} is already open in another tab - a server + login can only be used by one tab at a time. Switched to that tab.`;
        this._post({ command: 'connectionStatus', success: false, message });
        this._notify(message);
        return true;
    }

    // Surface the reason as a VS Code notification too: the status line of
    // the tab that was refused is easy to miss, especially since the focus
    // has just moved to the other tab.
    _notify(message) {
        if (typeof this._panelController.notify === 'function') {
            this._panelController.notify(message);
        }
    }

    async handleConnect(connectionConfig) {
        const identity = connectionIdentity(connectionConfig);
        if (this._refuseDuplicate(identity, connectionConfig.name)) return false;

        try {
            await this._connectionManager.connect(connectionConfig);
            // No connectionConfig.name on a plain ad-hoc "Connect" (only
            // saveConnection/testConnection set it) - fall back to the
            // server address so the tab title still reads as something.
            this._panelController.onConnectionChanged(identity, connectionConfig.name || connectionConfig.server);
            this._post({ command: 'connectionStatus', success: true, message: 'Connected successfully!' });
            return true;
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
        const saved = this._connectionStorage.getConnection(connectionName);
        const identity = saved && connectionIdentity(saved);
        if (this._refuseDuplicate(identity, connectionName)) return false;

        try {
            await this._connectionManager.connectWithSaved(connectionName);
            // Remember for auto-connect on next startup.
            await this._connectionStorage.setLastConnectionName(connectionName);
            this._panelController.onConnectionChanged(identity, connectionName);
            this._post({ command: 'connectionStatus', success: true, message: 'Connected successfully!' });
            return true;
        } catch (error) {
            this._post({ command: 'connectionStatus', success: false, message: `Failed to connect: ${error.message}` });
            return false;
        }
    }

    async handleSaveConnection(connectionConfig, originalName = null) {
        try {
            const result = await this._connectionStorage.saveConnection(connectionConfig, originalName);
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
            // The storage may not be readable yet (the webview's page loads
            // before it is) - wait for it rather than answering with an
            // empty list.
            await this._whenReady();
            const connections = this._connectionStorage.getSavedConnections();
            const lastConnection = this._connectionStorage.getLastConnectionName();
            let autoConnect = this._connectionStorage.getAutoConnectEnabled();
            // The connection auto-connect would pick may already be open in
            // another tab: connecting to it would be refused, and the refusal
            // used to leave this tab empty and unusable. Skip the auto-connect
            // instead, and say why - the tab stays usable, with the busy
            // connection preselected and an explicit message.
            let busyConnection = null;
            if (autoConnect && lastConnection) {
                const saved = this._connectionStorage.getConnection(lastConnection);
                const identity = saved && connectionIdentity(saved);
                if (identity && this._panelController.findDuplicate(identity)) {
                    autoConnect = false;
                    busyConnection = lastConnection;
                }
            }
            this._post({
                command: 'savedConnectionsLoaded',
                connections,
                lastConnection,
                autoConnect,
                busyConnection
            });
            if (busyConnection) {
                this._notify(`'${busyConnection}' is already open in another tab - a server + login can only be used by one tab at a time. Pick another connection here.`);
            }
        } catch (error) {
            console.error('Error loading saved connections:', error);
            this._post({ command: 'error', message: 'Failed to load saved connections' });
        }
    }

    async handleSetAutoConnect(enabled) {
        try {
            await this._connectionStorage.setAutoConnectEnabled(enabled);
        } catch (error) {
            console.error('Error saving auto-connect preference:', error);
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

module.exports = ConnectionHandlers;
