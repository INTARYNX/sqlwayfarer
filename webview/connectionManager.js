'use strict';

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