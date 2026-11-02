'use strict';

// Tracks every currently-open SqlWayfarerPanel instance (one extension-wide
// instance, constructed once in extension.js and threaded through
// createOrShow). Needed now that panels are no longer a singleton: broadcasting
// a shared resource (snippets) to every open tab, and refusing a second tab
// for a connection another tab already has open, both require looking beyond
// "this one panel".
class PanelRegistry {
    constructor() {
        this._panels = [];
    }

    register(panel) {
        this._panels.push(panel);
    }

    unregister(panel) {
        const index = this._panels.indexOf(panel);
        if (index !== -1) this._panels.splice(index, 1);
    }

    // Another panel (not this one) already connected to the same server+login.
    findByConnectionIdentity(identity, excludePanel) {
        if (!identity) return null;
        return this._panels.find(p => p !== excludePanel && p.connectionIdentity === identity) || null;
    }

    // The panel opened for this saved connection, if any.
    findByConnectionName(name) {
        if (!name) return null;
        return this._panels.find(p => p.connectionName === name) || null;
    }

    // A saved connection was renamed: its tab follows, so it is still found
    // (and still shown as open) under the new name.
    renameConnection(oldName, newName) {
        const panel = this.findByConnectionName(oldName);
        if (!panel) return;
        panel.renameConnection(newName);
        this.notifyOpenConnectionsChanged();
    }

    // Names of the saved connections that have a tab open.
    openConnectionNames() {
        return this._panels.map(p => p.connectionName).filter(Boolean);
    }

    // Tells whoever shows the list of connections (the sidebar) which ones
    // have a tab open. Only the targets that asked for it are called: the
    // panels have no use for it.
    notifyOpenConnectionsChanged() {
        const names = this.openConnectionNames();
        for (const panel of this._panels) {
            if (typeof panel.onOpenConnectionsChanged !== 'function') continue;
            try { panel.onOpenConnectionsChanged(names); } catch (error) { console.warn('PanelRegistry.notifyOpenConnectionsChanged: a target failed', error); }
        }
    }

    broadcast(message) {
        // One stale/disposed target throwing (e.g. posting to a webview mid-
        // teardown) must never stop the rest from getting the message - a
        // bare loop with no try/catch here would silently cut off every
        // panel/sidebar registered after the one that threw.
        for (const panel of this._panels) {
            try { panel.post(message); } catch (error) { console.warn('PanelRegistry.broadcast: a target failed to receive the message', error); }
        }
    }
}

module.exports = PanelRegistry;
