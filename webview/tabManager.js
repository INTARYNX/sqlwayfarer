/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Tab manager
class TabManager {
    constructor() {
        this.tabButtons = document.querySelectorAll('[data-tab]');
        this.tabContents = document.querySelectorAll('.tab-content');
        this.explorerToolbarActions = document.getElementById('explorerToolbarActions');
        this.queryToolbarActions = document.getElementById('queryToolbarActions');
        this.initEventListeners();
        this.updateToolbarActions(appState.activeTab);
    }

    initEventListeners() {
        this.tabButtons.forEach(button => {
            // button.dataset, not e.target.dataset - the Query button can contain
            // a child label (active sub-tab name), which would otherwise be the
            // click target and carry no data-tab of its own.
            button.addEventListener('click', () => this.switchTab(button.dataset.tab));
        });
    }

    switchTab(tabName) {
        // Check if user can access tabs that require connection
        if ((tabName === 'explorer' || tabName === 'query') && !appState.isConnected) {
            this.showStatus('Please connect to a database first before using this feature.', 'error');
            return;
        }

        appState.activeTab = tabName;

        // The extension keeps the open tab of every panel, so a tab that was
        // rebuilt comes back on the same one (see SqlWayfarerPanel).
        vscode.postMessage({ command: 'setActiveTab', tab: tabName });

        // Update tab buttons
        this.tabButtons.forEach(button => {
            button.classList.toggle('active', button.dataset.tab === tabName);
        });

        // Update tab content
        this.tabContents.forEach(content => {
            content.classList.toggle('active', content.id === `${tabName}Tab`);
        });

        this.updateToolbarActions(tabName);

        // Specific actions when changing tabs
        if (tabName === 'explorer') {
            this.onExplorerTabActivated();
        }
    }

    // The single top toolbar shows different controls per tab: Dictionary/Full/
    // Objects for Explorer, Run Query/Max rows/History for Query (the database
    // selector itself is always visible).
    updateToolbarActions(tabName) {
        if (this.explorerToolbarActions) {
            this.explorerToolbarActions.style.display = tabName === 'explorer' ? '' : 'none';
        }
        if (this.queryToolbarActions) {
            this.queryToolbarActions.style.display = tabName === 'query' ? '' : 'none';
        }
    }

    onExplorerTabActivated() {
        // Reload databases if necessary
        if (!appState.currentDatabase) {
            vscode.postMessage({ command: 'getDatabases' });
            return;
        }
        // Only asks where the dependency index stands (and the Explorer shows a
        // notice with the choice). It is never built here: a big database
        // shouldn't pay the indexing cost just because the Explorer is opened.
        if (window.objectsTabManager) {
            window.objectsTabManager.requestIndex(appState.currentDatabase);
        }
    }

    showStatus(message) {
        if (window.connectionStatus) window.connectionStatus.showStatus(message);
    }
}