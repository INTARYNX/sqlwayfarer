'use strict';

const vscode = acquireVsCodeApi();

// État global de l'application
class AppState {
    constructor() {
        this.activeTab = 'configuration';
        this.isConnected = false;
        this.currentDatabase = null;
        this.selectedObject = null;
        this.savedConnections = [];
        this.connectionConfig = null;
    }
}

const appState = new AppState();

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
        // Vérifier si l'utilisateur peut accéder à l'onglet Explorer
        if (tabName === 'explorer' && !appState.isConnected) {
            this.showStatus('Please connect to a database first before using the Explorer.', 'error');
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
        }
    }

    onExplorerTabActivated() {
        // Recharger les bases de données si nécessaire
        if (!appState.currentDatabase) {
            vscode.postMessage({ command: 'getDatabases' });
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

// Gestionnaire de connexion
class ConnectionManager {
    constructor() {
        this.initDOMElements();
        this.initEventListeners();
        this.loadSavedConnections();
    }

    initDOMElements() {
        this.elements = {
            savedConnectionSelect: document.getElementById('savedConnectionSelect'),
            loadConnectionBtn: document.getElementById('loadConnectionBtn'),
            deleteConnectionBtn: document.getElementById('deleteConnectionBtn'),
            connectionMethodRadios: document.querySelectorAll('input[name="connectionMethod"]'),
            connectionFields: document.getElementById('connectionFields'),
            connectionStringDiv: document.getElementById('connectionStringDiv'),
            serverInput: document.getElementById('serverInput'),
            portInput: document.getElementById('portInput'),
            databaseInput: document.getElementById('databaseInput'),
            usernameInput: document.getElementById('usernameInput'),
            passwordInput: document.getElementById('passwordInput'),
            encryptCheckbox: document.getElementById('encryptCheckbox'),
            trustCertCheckbox: document.getElementById('trustCertCheckbox'),
            connectionString: document.getElementById('connectionString'),
            connectionNameInput: document.getElementById('connectionNameInput'),
            saveConnectionBtn: document.getElementById('saveConnectionBtn'),
            testConnectionBtn: document.getElementById('testConnectionBtn'),
            connectBtn: document.getElementById('connectBtn'),
            connectionStatus: document.getElementById('connectionStatus')
        };
    }

    initEventListeners() {
        this.elements.loadConnectionBtn.addEventListener('click', () => this.handleLoadConnection());
        this.elements.deleteConnectionBtn.addEventListener('click', () => this.handleDeleteConnection());
        this.elements.connectionMethodRadios.forEach(radio => {
            radio.addEventListener('change', () => this.handleConnectionMethodChange());
        });
        this.elements.saveConnectionBtn.addEventListener('click', () => this.handleSaveConnection());
        this.elements.testConnectionBtn.addEventListener('click', () => this.handleTestConnection());
        this.elements.connectBtn.addEventListener('click', () => this.handleConnect());
    }

    loadSavedConnections() {
        vscode.postMessage({ command: 'loadConnections' });
    }

    handleConnectionMethodChange() {
        const selectedMethod = document.querySelector('input[name="connectionMethod"]:checked').value;
        
        if (selectedMethod === 'fields') {
            this.elements.connectionFields.style.display = 'block';
            this.elements.connectionStringDiv.style.display = 'none';
        } else {
            this.elements.connectionFields.style.display = 'none';
            this.elements.connectionStringDiv.style.display = 'block';
        }
    }

    handleLoadConnection() {
        const selectedConnectionName = this.elements.savedConnectionSelect.value;
        if (!selectedConnectionName) return;
        
        const connection = appState.savedConnections.find(conn => conn.name === selectedConnectionName);
        if (!connection) return;
        
        this.loadConnectionToForm(connection);
    }

    loadConnectionToForm(connection) {
        if (connection.useConnectionString) {
            document.querySelector('input[value="string"]').checked = true;
            this.elements.connectionString.value = connection.connectionString || '';
        } else {
            document.querySelector('input[value="fields"]').checked = true;
            this.elements.serverInput.value = connection.server || '';
            this.elements.portInput.value = connection.port || '';
            this.elements.databaseInput.value = connection.database || '';
            this.elements.usernameInput.value = connection.username || '';
            this.elements.passwordInput.value = ''; // Pour la sécurité
            this.elements.encryptCheckbox.checked = connection.encrypt || false;
            this.elements.trustCertCheckbox.checked = connection.trustServerCertificate !== false;
        }
        
        this.elements.connectionNameInput.value = connection.name;
        this.handleConnectionMethodChange();
    }

    handleDeleteConnection() {
        const selectedConnectionName = this.elements.savedConnectionSelect.value;
        if (!selectedConnectionName) {
            this.showStatus('Please select a connection to delete.', 'error');
            return;
        }
        
        if (confirm(`Are you sure you want to delete the connection "${selectedConnectionName}"?`)) {
            vscode.postMessage({
                command: 'deleteConnection',
                connectionName: selectedConnectionName
            });
        }
    }

    handleSaveConnection() {
        const connectionName = this.elements.connectionNameInput.value.trim();
        if (!connectionName) {
            this.showStatus('Please enter a connection name.', 'error');
            return;
        }
        
        const connectionConfig = this.buildConnectionConfig();
        connectionConfig.name = connectionName;
        
        vscode.postMessage({
            command: 'saveConnection',
            connectionConfig: connectionConfig
        });
    }

    handleTestConnection() {
        const connectionConfig = this.buildConnectionConfig();
        
        this.setButtonState(this.elements.testConnectionBtn, true, 'Testing...');
        
        vscode.postMessage({
            command: 'testConnection',
            connectionConfig: connectionConfig
        });
    }

    handleConnect() {
        const connectionConfig = this.buildConnectionConfig();
        appState.connectionConfig = connectionConfig;
        
        this.setButtonState(this.elements.connectBtn, true, 'Connecting...');
        
        vscode.postMessage({
            command: 'connect',
            connectionConfig: connectionConfig
        });
    }

    buildConnectionConfig() {
        const useConnectionString = document.querySelector('input[value="string"]').checked;
        
        const config = {
            useConnectionString: useConnectionString
        };
        
        if (useConnectionString) {
            config.connectionString = this.elements.connectionString.value.trim();
        } else {
            config.server = this.elements.serverInput.value.trim();
            config.port = this.elements.portInput.value.trim();
            config.database = this.elements.databaseInput.value.trim();
            config.username = this.elements.usernameInput.value.trim();
            config.password = this.elements.passwordInput.value;
            config.encrypt = this.elements.encryptCheckbox.checked;
            config.trustServerCertificate = this.elements.trustCertCheckbox.checked;
        }
        
        return config;
    }

    setButtonState(button, disabled, text) {
        button.disabled = disabled;
        if (text) button.textContent = text;
    }

    showStatus(message, type) {
        this.elements.connectionStatus.className = 'status ' + type;
        this.elements.connectionStatus.textContent = message;
    }

    // Gestionnaires de messages
    onSavedConnectionsLoaded(connections) {
        appState.savedConnections = connections;
        
        this.elements.savedConnectionSelect.innerHTML = '<option value="">Select a saved connection...</option>';
        connections.forEach(conn => {
            const option = document.createElement('option');
            option.value = conn.name;
            option.textContent = conn.name;
            this.elements.savedConnectionSelect.appendChild(option);
        });
    }

    onConnectionSaved(message) {
        this.showStatus(message.message, message.success ? 'success' : 'error');
    }

    onConnectionDeleted(message) {
        this.showStatus(message.message, message.success ? 'success' : 'error');
        
        if (message.success) {
            this.elements.savedConnectionSelect.value = '';
            this.elements.connectionNameInput.value = '';
        }
    }

    onTestConnectionResult(message) {
        this.setButtonState(this.elements.testConnectionBtn, false, 'Test Connection');
        this.showStatus(message.message, message.success ? 'success' : 'error');
    }

    onConnectionStatus(message) {
        this.setButtonState(this.elements.connectBtn, false, 'Connect');
        this.showStatus(message.message, message.success ? 'success' : 'error');
        
        if (message.success) {
            appState.isConnected = true;
            // Permettre l'accès à l'onglet Explorer
            document.querySelector('[data-tab="explorer"]').disabled = false;
        }
    }
}

// Gestionnaire d'exploration
class ExplorerManager {
    constructor() {
        this.initDOMElements();
        this.initEventListeners();
    }

    initDOMElements() {
        this.elements = {
            databaseSelect: document.getElementById('databaseSelect'),
            objectList: document.getElementById('objectList'),
            detailsContent: document.getElementById('detailsContent')
        };
    }

    initEventListeners() {
        this.elements.databaseSelect.addEventListener('change', () => this.handleDatabaseChange());
    }

    handleDatabaseChange() {
        const database = this.elements.databaseSelect.value;
        appState.currentDatabase = database;
        
        if (database) {
            this.elements.objectList.innerHTML = '<p class="placeholder-text">Loading objects...</p>';
            this.elements.detailsContent.innerHTML = '<p>Loading...</p>';
            vscode.postMessage({
                command: 'getObjects',
                database: database
            });
        } else {
            this.elements.objectList.innerHTML = '<p class="placeholder-text">Select a database to view objects.</p>';
            this.elements.detailsContent.innerHTML = '<p>Select a database first.</p>';
        }
    }

    handleObjectClick(element, obj) {
        // Supprimer la sélection précédente
        const prevSelected = this.elements.objectList.querySelector('.selected');
        if (prevSelected) {
            prevSelected.classList.remove('selected');
        }
        
        // Ajouter la sélection à l'élément actuel
        element.classList.add('selected');
        appState.selectedObject = obj;
        
        // Charger les détails selon le type d'objet
        if (obj.object_type === 'Table') {
            vscode.postMessage({
                command: 'getTableDetails',
                database: appState.currentDatabase,
                table: obj.name
            });
        } else {
            vscode.postMessage({
                command: 'getObjectDetails',
                database: appState.currentDatabase,
                objectName: obj.name,
                objectType: obj.object_type
            });
        }
    }

    // Gestionnaires de messages
    onDatabasesLoaded(databases) {
        this.elements.databaseSelect.disabled = false;
        this.elements.databaseSelect.innerHTML = '<option value="">Select a database...</option>';
        
        databases.forEach(db => {
            const option = document.createElement('option');
            option.value = db;
            option.textContent = db;
            this.elements.databaseSelect.appendChild(option);
        });
    }

    onObjectsLoaded(objects) {
        this.displayObjects(objects);
    }

    displayObjects(objects) {
        this.elements.objectList.innerHTML = '';
        
        if (objects.length === 0) {
            this.elements.objectList.innerHTML = '<p class="placeholder-text">No objects found in this database.</p>';
            return;
        }
        
        objects.forEach(obj => {
            const div = document.createElement('div');
            div.className = 'object-item';
            div.innerHTML = `${obj.name}<span class="object-type">(${obj.object_type})</span>`;
            div.dataset.name = obj.name;
            div.dataset.type = obj.object_type;
            
            div.addEventListener('click', () => this.handleObjectClick(div, obj));
            
            this.elements.objectList.appendChild(div);
        });
    }

    onTableDetailsLoaded(tableName, columns, indexes, foreignKeys, dependencies) {
        const html = [
            `<div class="section-header">Table: ${tableName}</div>`,
            this.buildColumnsTable(columns),
            this.buildIndexesTable(indexes),
            this.buildForeignKeysTable(foreignKeys),
            this.buildDependenciesSection(dependencies)
        ].join('');
        
        this.elements.detailsContent.innerHTML = html;
    }

    onObjectDetailsLoaded(objectName, objectType, dependencies, definition) {
        let html = `<div class="section-header">${objectType}: ${objectName}</div>`;
        
        if (definition) {
            html += this.buildDefinitionSection(definition);
        }
        
        html += this.buildDependenciesSection(dependencies);
        
        this.elements.detailsContent.innerHTML = html;
    }

    // Méthodes de construction HTML
    buildColumnsTable(columns) {
        if (!columns || columns.length === 0) {
            return '<h3>Columns</h3><p>No columns found.</p>';
        }

        let html = '<h3>Columns</h3>';
        html += '<table><tr><th>Name</th><th>Type</th><th>Nullable</th><th>Default</th><th>Length</th></tr>';
        
        columns.forEach(col => {
            html += `<tr>
                <td>${this.escapeHtml(col.COLUMN_NAME)}</td>
                <td>${this.escapeHtml(col.DATA_TYPE)}</td>
                <td>${col.IS_NULLABLE}</td>
                <td>${this.escapeHtml(col.COLUMN_DEFAULT || '')}</td>
                <td>${col.CHARACTER_MAXIMUM_LENGTH || ''}</td>
            </tr>`;
        });
        
        html += '</table>';
        return html;
    }

    buildIndexesTable(indexes) {
        let html = '<h3>Indexes</h3>';
        
        if (indexes && indexes.length > 0) {
            html += '<table><tr><th>Name</th><th>Type</th><th>Unique</th><th>Primary Key</th><th>Columns</th></tr>';
            
            indexes.forEach(idx => {
                html += `<tr>
                    <td>${this.escapeHtml(idx.index_name)}</td>
                    <td>${this.escapeHtml(idx.type_desc)}</td>
                    <td>${idx.is_unique ? 'Yes' : 'No'}</td>
                    <td>${idx.is_primary_key ? 'Yes' : 'No'}</td>
                    <td>${this.escapeHtml(idx.columns)}</td>
                </tr>`;
            });
            
            html += '</table>';
        } else {
            html += '<p>No indexes found.</p>';
        }
        
        return html;
    }

    buildForeignKeysTable(foreignKeys) {
        let html = '<h3>Foreign Keys</h3>';
        
        if (foreignKeys && foreignKeys.length > 0) {
            html += '<table><tr><th>Name</th><th>Column</th><th>Referenced Table</th><th>Referenced Column</th></tr>';
            
            foreignKeys.forEach(fk => {
                html += `<tr>
                    <td>${this.escapeHtml(fk.fk_name)}</td>
                    <td>${this.escapeHtml(fk.column_name)}</td>
                    <td>${this.escapeHtml(fk.referenced_table)}</td>
                    <td>${this.escapeHtml(fk.referenced_column)}</td>
                </tr>`;
            });
            
            html += '</table>';
        } else {
            html += '<p>No foreign keys found.</p>';
        }
        
        return html;
    }

    buildDefinitionSection(definition) {
        let html = '<h3>Definition</h3>';
        html += '<div class="definition-container">';
        html += `<pre><code>${this.escapeHtml(definition || 'No definition available')}</code></pre>`;
        html += '</div>';
        return html;
    }

    buildDependenciesSection(dependencies) {
        if (!dependencies) {
            return '<h3>Dependencies</h3><p>No dependency information available.</p>';
        }
        
        let html = '<h3>Dependencies</h3>';
        
        // Objets dont dépend cet objet
        html += '<h4>Dependencies (objects this depends on):</h4>';
        if (dependencies.dependsOn && dependencies.dependsOn.length > 0) {
            html += '<table><tr><th>Object Name</th><th>Type</th><th>Dependency Type</th></tr>';
            dependencies.dependsOn.forEach(dep => {
                html += `<tr>
                    <td>${this.escapeHtml(dep.referenced_object)}</td>
                    <td>${this.escapeHtml(dep.referenced_object_type)}</td>
                    <td>${this.escapeHtml(dep.dependency_type || 'Unknown')}</td>
                </tr>`;
            });
            html += '</table>';
        } else {
            html += '<p>No dependencies found.</p>';
        }
        
        // Objets qui dépendent de cet objet
        html += '<h4>Referenced by (objects that depend on this):</h4>';
        if (dependencies.referencedBy && dependencies.referencedBy.length > 0) {
            html += '<table><tr><th>Object Name</th><th>Type</th><th>Dependency Type</th></tr>';
            dependencies.referencedBy.forEach(ref => {
                html += `<tr>
                    <td>${this.escapeHtml(ref.referencing_object)}</td>
                    <td>${this.escapeHtml(ref.referencing_object_type)}</td>
                    <td>${this.escapeHtml(ref.dependency_type || 'Unknown')}</td>
                </tr>`;
            });
            html += '</table>';
        } else {
            html += '<p>No objects reference this object.</p>';
        }
        
        return html;
    }

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Gestionnaire principal de messages
class MessageHandler {
    constructor(connectionManager, explorerManager, tabManager) {
        this.connectionManager = connectionManager;
        this.explorerManager = explorerManager;
        this.tabManager = tabManager;
    }

    handleMessage(event) {
        const message = event.data;
        
        switch (message.command) {
            case 'savedConnectionsLoaded':
                this.connectionManager.onSavedConnectionsLoaded(message.connections);
                break;
                
            case 'connectionSaved':
                this.connectionManager.onConnectionSaved(message);
                break;
                
            case 'connectionDeleted':
                this.connectionManager.onConnectionDeleted(message);
                break;
                
            case 'testConnectionResult':
                this.connectionManager.onTestConnectionResult(message);
                break;
                
            case 'connectionStatus':
                this.connectionManager.onConnectionStatus(message);
                if (message.success) {
                    // Basculer automatiquement vers l'onglet Explorer après connexion réussie
                    setTimeout(() => {
                        this.tabManager.switchTab('explorer');
                    }, 1000);
                }
                break;
                
            case 'databasesLoaded':
                this.explorerManager.onDatabasesLoaded(message.databases);
                break;
                
            case 'objectsLoaded':
                this.explorerManager.onObjectsLoaded(message.objects);
                break;
                
            case 'tableDetailsLoaded':
                this.explorerManager.onTableDetailsLoaded(
                    message.tableName, 
                    message.columns, 
                    message.indexes, 
                    message.foreignKeys,
                    message.dependencies
                );
                break;
                
            case 'objectDetailsLoaded':
                this.explorerManager.onObjectDetailsLoaded(
                    message.objectName,
                    message.objectType,
                    message.dependencies,
                    message.definition
                );
                break;
                
            case 'error':
                this.handleError(message.message);
                break;
        }
    }

    handleError(message) {
        console.error('SQL Wayfarer Error:', message);
        // Afficher l'erreur dans l'onglet actuel
        if (appState.activeTab === 'configuration') {
            this.connectionManager.showStatus(message, 'error');
        } else {
            // Afficher dans la console pour l'onglet Explorer
            this.tabManager.showStatus(message, 'error');
        }
    }
}

// Initialisation de l'application
document.addEventListener('DOMContentLoaded', function() {
    console.log('SQL Wayfarer webview loaded');
    
    // Initialiser les gestionnaires
    const tabManager = new TabManager();
    const connectionManager = new ConnectionManager();
    const explorerManager = new ExplorerManager();
    const messageHandler = new MessageHandler(connectionManager, explorerManager, tabManager);
    
    // Configurer le gestionnaire de messages
    window.addEventListener('message', (event) => messageHandler.handleMessage(event));
    
    // Charger les connexions sauvegardées au démarrage
    connectionManager.loadSavedConnections();
});