/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Bootstrap for the activity bar sidebar (see panels/SnippetSidebarProvider.js):
// two tabs, the saved connections and the snippets - much smaller than
// webview/main.js since this view is not the full SQL Wayfarer panel.
const vscode = acquireVsCodeApi();

document.addEventListener('DOMContentLoaded', () => {
    const snippetManager = new SnippetManager();
    const connections = new SidebarConnections();

    // Which tab was open comes back when the view is rebuilt.
    const tabs = document.querySelectorAll('[data-sb-tab]');
    const views = document.querySelectorAll('[data-sb-view]');
    const showTab = name => {
        tabs.forEach(tab => {
            const active = tab.dataset.sbTab === name;
            tab.classList.toggle('active', active);
            tab.setAttribute('aria-selected', String(active));
        });
        views.forEach(view => view.classList.toggle('active', view.dataset.sbView === name));
        vscode.setState(Object.assign({}, vscode.getState(), { tab: name }));
    };
    tabs.forEach(tab => tab.addEventListener('click', () => showTab(tab.dataset.sbTab)));
    const saved = vscode.getState();
    showTab(saved && saved.tab === 'snippets' ? 'snippets' : 'connections');

    window.addEventListener('message', (event) => {
        const message = event.data;
        switch (message.command) {
            case 'snippetsLoaded':           snippetManager.onSnippetsLoaded(message.snippets); break;
            case 'snippetsImported':         snippetManager.onSnippetsImported(message); break;
            case 'savedConnectionsLoaded':   connections.onSavedConnectionsLoaded(message); break;
            case 'openConnectionsChanged':   connections.onOpenConnectionsChanged(message.names); break;
            case 'connectionSaved':          connections.onConnectionSaved(message); break;
            case 'connectionsImported':      connections.onConnectionsImported(message); break;
            case 'connectionDeleted':        connections.onConnectionDeleted(message); break;
            case 'testConnectionResult':     connections.onTestConnectionResult(message); break;
            case 'connectionsError':         connections.onError(message.message); break;
        }
    });
});
