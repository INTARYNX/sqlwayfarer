'use strict';

const { connectionIdentity } = require('../../database/connectionIdentity');

const NOOP_PANEL_CONTROLLER = {
    findDuplicate: () => null,
    reveal: () => {},
    onConnectionChanged: () => {},
    notify: () => {}
};

// The connection of one tab. The saved connections themselves are managed
// from the sidebar (see SavedConnectionHandlers); a tab only connects to the
// one it was opened for.
class ConnectionHandlers {
    constructor(postMessage, connectionManager, connectionStorage, panelController = NOOP_PANEL_CONTROLLER) {
        this._post = postMessage;
        this._connectionManager = connectionManager;
        this._connectionStorage = connectionStorage;
        this._panelController = panelController;
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

    async handleConnectWithSaved(connectionName) {
        const saved = this._connectionStorage.getConnection(connectionName);
        const identity = saved && connectionIdentity(saved);
        if (this._refuseDuplicate(identity, connectionName)) return false;

        try {
            await this._connectionManager.connectWithSaved(connectionName);
            // Remember for the "open the last connection" shortcut.
            await this._connectionStorage.setLastConnectionName(connectionName);
            this._panelController.onConnectionChanged(identity, connectionName);
            this._post({ command: 'connectionStatus', success: true, message: 'Connected successfully!', production: !!(saved && saved.production) });
            return true;
        } catch (error) {
            this._post({ command: 'connectionStatus', success: false, message: `Failed to connect: ${error.message}` });
            return false;
        }
    }
}

module.exports = ConnectionHandlers;
