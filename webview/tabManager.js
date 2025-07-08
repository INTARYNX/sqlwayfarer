'use strict';

// Gestionnaire d'onglets
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
        // Vérifier si l'utilisateur peut accéder aux onglets qui nécessitent une connexion
        if ((tabName === 'explorer' || tabName === 'tableUsage') && !appState.isConnected) {
            this.showStatus('Please connect to a database first before using this feature.', 'error');
            return;
        }

        appState.activeTab = tabName;

        // Mettre à jour les boutons d'onglets
        this.tabButtons.forEach(button => {
            button.classList.toggle('active', button.dataset.tab === tabName);
        });

        // Mettre à jour le contenu des onglets
        this.tabContents.forEach(content => {
            content.classList.toggle('active', content.id === `${tabName}Tab`);
        });

        // Actions spécifiques lors du changement d'onglet
        if (tabName === 'explorer' && appState.isConnected) {
            this.onExplorerTabActivated();
        } else if (tabName === 'tableUsage' && appState.isConnected) {
            this.onTableUsageTabActivated();
        }
    }

    onExplorerTabActivated() {
        // Recharger les bases de données si nécessaire
        if (!appState.currentDatabase) {
            vscode.postMessage({ command: 'getDatabases' });
        }
    }

    onTableUsageTabActivated() {
        // Initialiser l'onglet Table Usage si nécessaire
        if (window.tableUsageManager) {
            // Synchroniser avec la base de données actuelle
            window.tableUsageManager.onDatabaseChanged(appState.currentDatabase);
            
            // Recharger les bases de données si nécessaire
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