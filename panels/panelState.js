'use strict';

// Per-connection UI state that has to outlive the webview page.
//
// The webview is destroyed and rebuilt every time the panel is hidden and
// shown again, and the extension host restarts with the window - so what the
// tab was showing ("MyDb" selected, Explorer open) cannot live in the page.
// It lives here, in the workspace state, keyed by connection identity.
//
// Keyed per connection (server + port + login) like the query history and the
// query drafts, so two tabs on two different servers never overwrite each
// other's state - see database/connectionIdentity.
const STATE_KEY = 'sqlwayfarer.panelState';

class PanelStateStore {
    constructor(workspaceState) {
        this._workspaceState = workspaceState;
    }

    // What we know about one connection, or null when we know nothing yet.
    get(identity) {
        if (!identity) return null;
        const all = this._workspaceState.get(STATE_KEY, {}) || {};
        return all[identity] || null;
    }

    // Merges the given fields into the connection's state. A field set to
    // null is stored as such (the user cleared the database selection), and
    // a field left out keeps its previous value.
    async set(identity, patch) {
        if (!identity) return;
        const all = { ...(this._workspaceState.get(STATE_KEY, {}) || {}) };
        all[identity] = { ...(all[identity] || {}), ...patch };
        await this._workspaceState.update(STATE_KEY, all);
    }
}

module.exports = { PanelStateStore, STATE_KEY };
