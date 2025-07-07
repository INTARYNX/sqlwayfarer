'use strict';

// Gestionnaire de connexion
class ConnectionManager {
    constructor() {
        this.initDOMElements();
        this.initEventListeners();
        this.loadSavedConnections();
        this.settingsMode = 'new'; // 'new' or 'edit'
        this.currentEditingConnection = null;
    }

    initDOMElements() {
        this.elements = {
            connectionSelect: document.getElementById('connectionSelect'),
            connectBtn: document.getElementById('connectBtn'),
            editBtn: document.getElementById('editBtn'),
            deleteBtn: document.getElementById('deleteBtn'),
            connectionSettings: document.getElementById('connectionSettings'),
            settingsTitle: document.getElementById('settingsTitle'),
            closeSettingsBtn: document.getElementById('closeSettingsBtn'),
            cancelSettingsBtn: document.getElementById('cancelSettingsBtn'),
            serverInput: document.getElementById('serverInput'),
            portInput: document.getElementById('portInput'),
            databaseInput: document.getElementById('databaseInput'),
            usernameInput: document.getElementById('usernameInput'),
            passwordInput: document.getElementById('passwordInput'),
            encryptCheckbox: document.getElementById('encryptCheckbox'),
            trustCertCheckbox: document.getElementById('trustCertCheckbox'),
            connectionNameInput: document.getElementById('connectionNameInput'),
            saveConnectionBtn: document.getElementById('saveConnectionBtn'),
            testConnectionBtn: document.getElementById('testConnectionBtn'),
            connectionStatus: document.getElementById('connectionStatus')
        };
    }

    initEventListeners() {
        this.elements.connectionSelect.addEventListener('change', () => this.handleConnectionSelectChange());
        this.elements.connectBtn.addEventListener('click', () => this.handleConnect());
        this.elements.editBtn.addEventListener('click', () => this.handleEdit());
        this.elements.deleteBtn.addEventListener('click', () => this.handleDelete());
        this.elements.closeSettingsBtn.addEventListener('click', () => this.hideSettings());
        this.elements.cancelSettingsBtn.addEventListener('click', () => this.hideSettings());
        this.elements.saveConnectionBtn.addEventListener('click', () => this.handleSaveConnection());
        this.elements.testConnectionBtn.addEventListener('click', () => this.handleTestConnection());
    }

    loadSavedConnections() {
        vscode.postMessage({ command: 'loadConnections' });
    }

    handleConnectionSelectChange() {
        const selectedValue = this.elements.connectionSelect.value;
        
        if (selectedValue === 'new') {
            this.showNewConnectionSettings();
        } else if (selectedValue && selectedValue !== '') {
            // Existing connection selected
            this.elements.editBtn.style.display = 'inline-block';
            this.elements.deleteBtn.style.display = 'inline-block';
            this.hideSettings();
        } else {
            // No selection
            this.elements.editBtn.style.display = 'none';
            this.elements.deleteBtn.style.display = 'none';
            this.hideSettings();
        }
    }

    showNewConnectionSettings() {
        this.settingsMode = 'new';
        this.currentEditingConnection = null;
        this.elements.settingsTitle.textContent = 'New Connection';
        this.clearForm();
        this.showSettings();
        this.elements.editBtn.style.display = 'none';
        this.elements.deleteBtn.style.display = 'none';
    }

    showEditConnectionSettings(connectionName) {
        this.settingsMode = 'edit';
        this.currentEditingConnection = connectionName;
        this.elements.settingsTitle.textContent = `Edit Connection: ${connectionName}`;
        
        // Load connection details
        vscode.postMessage({
            command: 'loadConnectionForDisplay',
            connectionName: connectionName
        });
        
        this.showSettings();
    }

    showSettings() {
        this.elements.connectionSettings.style.display = 'block';
    }

    hideSettings() {
        this.elements.connectionSettings.style.display = 'none';
        this.currentEditingConnection = null;
    }

    handleConnect() {
        const selectedValue = this.elements.connectionSelect.value;
        
        if (selectedValue === 'new') {
            // Connect with current form data
            const connectionConfig = this.buildConnectionConfig();
            this.connectWithConfig(connectionConfig);
        } else if (selectedValue && selectedValue !== '') {
            // Connect with saved connection - use the connection name directly
            this.setButtonState(this.elements.connectBtn, true, 'Connecting...');
            
            // Send connect command with connection name
            vscode.postMessage({
                command: 'connectWithSaved',
                connectionName: selectedValue
            });
        } else {
            this.showStatus('Please select a connection or create a new one.', 'error');
        }
    }

    connectWithConfig(connectionConfig) {
        appState.connectionConfig = connectionConfig;
        this.setButtonState(this.elements.connectBtn, true, 'Connecting...');
        
        vscode.postMessage({
            command: 'connect',
            connectionConfig: connectionConfig
        });
    }

    handleEdit() {
        const selectedValue = this.elements.connectionSelect.value;
        if (!selectedValue || selectedValue === 'new') return;
        
        this.showEditConnectionSettings(selectedValue);
    }

    handleDelete() {
        const selectedValue = this.elements.connectionSelect.value;
        if (!selectedValue || selectedValue === 'new') return;
        
        if (confirm(`Are you sure you want to delete the connection "${selectedValue}"?`)) {
            vscode.postMessage({
                command: 'deleteConnection',
                connectionName: selectedValue
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
        let connectionConfig;
        
        if (this.settingsMode === 'edit' && this.currentEditingConnection) {
            // Testing edited connection - merge form data with saved connection
            connectionConfig = this.buildConnectionConfig();
            connectionConfig.name = this.currentEditingConnection;
            connectionConfig.isLoadedConnection = !connectionConfig.password; // If no password entered, load from storage
        } else {
            // Testing new connection
            connectionConfig = this.buildConnectionConfig();
        }
        
        this.setButtonState(this.elements.testConnectionBtn, true, 'Testing...');
        
        vscode.postMessage({
            command: 'testConnection',
            connectionConfig: connectionConfig
        });
    }

    buildConnectionConfig() {
        const config = {
            useConnectionString: false,
            server: this.elements.serverInput.value.trim(),
            port: this.elements.portInput.value.trim(),
            database: this.elements.databaseInput.value.trim(),
            username: this.elements.usernameInput.value.trim(),
            password: this.elements.passwordInput.value,
            encrypt: this.elements.encryptCheckbox.checked,
            trustServerCertificate: this.elements.trustCertCheckbox.checked
        };
        
        return config;
    }

    loadConnectionToForm(connection) {
        this.elements.serverInput.value = connection.server || '';
        this.elements.portInput.value = connection.port || '';
        this.elements.databaseInput.value = connection.database || '';
        this.elements.usernameInput.value = connection.username || '';
        // Don't populate password field for security
        this.elements.passwordInput.value = '';
        this.elements.passwordInput.placeholder = 'Leave empty to use saved password';
        this.elements.encryptCheckbox.checked = connection.encrypt || false;
        this.elements.trustCertCheckbox.checked = connection.trustServerCertificate !== false;
        
        this.elements.connectionNameInput.value = connection.name;
    }

    setButtonState(button, disabled, text) {
        button.disabled = disabled;
        if (text) button.textContent = text;
    }

    showStatus(message, type) {
        this.elements.connectionStatus.className = 'status ' + type;
        this.elements.connectionStatus.textContent = message;
    }

    clearForm() {
        this.elements.serverInput.value = '';
        this.elements.portInput.value = '';
        this.elements.databaseInput.value = '';
        this.elements.usernameInput.value = '';
        this.elements.passwordInput.value = '';
        this.elements.encryptCheckbox.checked = false;
        this.elements.trustCertCheckbox.checked = true;
        this.elements.connectionNameInput.value = '';
        
        // Reset placeholders
        this.elements.passwordInput.placeholder = 'Password';
    }

    // Gestionnaires de messages
    onSavedConnectionsLoaded(connections) {
        appState.savedConnections = connections;
        
        this.elements.connectionSelect.innerHTML = '<option value="">Select a connection...</option>';
        
        // Add "New Connection" option
        const newOption = document.createElement('option');
        newOption.value = 'new';
        newOption.textContent = '+ New Connection';
        this.elements.connectionSelect.appendChild(newOption);
        
        // Add saved connections
        connections.forEach(conn => {
            const option = document.createElement('option');
            option.value = conn.name;
            option.textContent = conn.name;
            this.elements.connectionSelect.appendChild(option);
        });
    }

    onConnectionSaved(message) {
        this.showStatus(message.message, message.success ? 'success' : 'error');
        if (message.success) {
            // Hide settings and reload connections
            this.hideSettings();
            this.loadSavedConnections();
        }
    }

    onConnectionDeleted(message) {
        this.showStatus(message.message, message.success ? 'success' : 'error');
        
        if (message.success) {
            this.elements.connectionSelect.value = '';
            this.elements.editBtn.style.display = 'none';
            this.elements.deleteBtn.style.display = 'none';
            this.hideSettings();
            this.loadSavedConnections();
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
            // Hide settings on successful connection
            this.hideSettings();
        }
    }

    // Handle connection loaded for display (without sensitive data)
    onConnectionLoadedForDisplay(connection) {
        this.loadConnectionToForm(connection);
    }
}