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
        if ((tabName === 'explorer' || tabName === 'query') && !appState.isConnected) {
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

        // Specific actions when changing tabs
        if (tabName === 'explorer') {
            this.onExplorerTabActivated();
        }
    }

    onExplorerTabActivated() {
        // Reload databases if necessary
        if (!appState.currentDatabase) {
            vscode.postMessage({ command: 'getDatabases' });
        }
        // No forced database selection - user decides when to explore
    }

    showStatus(message, type) {
        const statusElement = document.getElementById('connectionStatus');
        if (statusElement) {
            statusElement.className = 'status ' + type;
            statusElement.textContent = message;
        }
    }
}