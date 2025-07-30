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
        this.tabButtons = document.querySelectorAll('.tab-button');
        this.tabContents = document.querySelectorAll('.tab-content');
        this.initEventListeners();
    }

    initEventListeners() {
        this.tabButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                const tabName = e.target.dataset.tab;
                this.switchTab(tabName);
            });
        });
    }

    switchTab(tabName) {
        // Check if user can access tabs that require connection
        if ((tabName === 'explorer' || tabName === 'tableUsage' || tabName === 'extendedEvents') && !appState.isConnected) {
            this.showStatus('Please connect to a database first before using this feature.', 'error');
            return;
        }

        appState.activeTab = tabName;

        // Update tab buttons
        this.tabButtons.forEach(button => {
            button.classList.toggle('active', button.dataset.tab === tabName);
        });

        // Update tab content
        this.tabContents.forEach(content => {
            content.classList.toggle('active', content.id === `${tabName}Tab`);
        });

        if ((tabName === 'explorer' || tabName === 'tableUsage' || tabName === 'extendedEvents' || tabName === 'objects') && !appState.isConnected) {
            this.showStatus('Please connect to a database first before using this feature.', 'error');
            return;
        }

        // Specific actions when changing tabs
        if (tabName === 'explorer' && appState.isConnected) {
            this.onExplorerTabActivated();
        } else if (tabName === 'tableUsage' && appState.isConnected) {
            this.onTableUsageTabActivated();
        } else if (tabName === 'extendedEvents' && appState.isConnected) {
            this.onExtendedEventsTabActivated();
        }
    }

    onExplorerTabActivated() {
        // Reload databases if necessary
        if (!appState.currentDatabase) {
            vscode.postMessage({ command: 'getDatabases' });
        }
        // No forced database selection - user decides when to explore
    }

    onTableUsageTabActivated() {
        // Initialize Table Usage tab if necessary
        if (window.tableUsageManager) {
            // Synchronize with current database
            window.tableUsageManager.onDatabaseChanged(appState.currentDatabase);
            
            // Reload databases if necessary
            if (!appState.currentDatabase) {
                vscode.postMessage({ command: 'getDatabases' });
            }
        }
    }

    onExtendedEventsTabActivated() {
        // Initialize Extended Events tab if necessary
        if (window.extendedEventsManager) {
            // Synchronize with current database
            window.extendedEventsManager.onDatabaseChanged(appState.currentDatabase);
            
            // Reload databases if necessary
            if (!appState.currentDatabase) {
                vscode.postMessage({ command: 'getDatabases' });
            }
        }
    }

    showStatus(message, type) {
        const statusElement = document.getElementById('connectionStatus');
        if (statusElement) {
            statusElement.className = 'status ' + type;
            statusElement.textContent = message;
        }
    }
}