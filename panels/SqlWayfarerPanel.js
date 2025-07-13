'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const ConnectionStorage = require('../storage/ConnectionStorage');
const ConnectionManager = require('../database/ConnectionManager');
const DatabaseService = require('../database/DatabaseService');
const DependencyService = require('../database/DependencyService');

/**
 * Manages the SQL Wayfarer webview panel
 * Orchestrates communication between frontend and backend services
 */
class SqlWayfarerPanel {
    /**
     * @param {vscode.WebviewPanel} panel
     * @param {vscode.Uri} extensionUri
     * @param {vscode.ExtensionContext} context
     */
    constructor(panel, extensionUri, context) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._context = context;
        this._disposables = [];

        // Initialize services
        this._connectionStorage = new ConnectionStorage(context);
        this._connectionManager = new ConnectionManager(this._connectionStorage);
        this._databaseService = new DatabaseService(this._connectionManager);
        this._dependencyService = new DependencyService(this._connectionManager);

        this._initialize();
    }

    /**
     * Create or show the SQL Wayfarer panel
     * @param {vscode.Uri} extensionUri
     * @param {vscode.ExtensionContext} context
     */
    static createOrShow(extensionUri, context) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (SqlWayfarerPanel.currentPanel) {
            SqlWayfarerPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'sqlwayfarer-sqlwayfarer',
            'SQL Wayfarer',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri]
            }
        );

        SqlWayfarerPanel.currentPanel = new SqlWayfarerPanel(panel, extensionUri, context);
    }

    /**
     * Initialize the panel
     * @private
     */
    async _initialize() {
        try {
            // Load saved connections
            await this._connectionStorage.initialize();
            
            // Set up panel
            this._update();
            this._setupEventHandlers();
            
            console.log('SqlWayfarerPanel initialized successfully');
        } catch (error) {
            console.error('Error initializing SqlWayfarerPanel:', error);
            vscode.window.showErrorMessage(`Failed to initialize SQL Wayfarer: ${error.message}`);
        }
    }

    /**
     * Set up event handlers
     * @private
     */
    _setupEventHandlers() {
        // Handle panel disposal
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from webview
        this._panel.webview.onDidReceiveMessage(
            async message => {
                try {
                    await this._handleMessage(message);
                } catch (error) {
                    console.error('Error handling message:', error);
                    this._sendError(`Error processing request: ${error.message}`);
                }
            },
            null,
            this._disposables
        );
    }

    /**
     * Handle messages from the webview
     * @param {Object} message - Message from webview
     * @private
     */
    async _handleMessage(message) {
        switch (message.command) {
            case 'connect':
                await this._handleConnect(message.connectionConfig);
                break;
            case 'saveConnection':
                await this._handleSaveConnection(message.connectionConfig);
                break;
            case 'deleteConnection':
                await this._handleDeleteConnection(message.connectionName);
                break;
            case 'loadConnections':
                await this._handleLoadConnections();
                break;
            case 'loadConnectionForDisplay':
                await this._handleLoadConnectionForDisplay(message.connectionName);
                break;
            case 'connectWithSaved':
                await this._handleConnectWithSaved(message.connectionName);
                break;    
            case 'testConnection':
                await this._handleTestConnection(message.connectionConfig);
                break;
            case 'getDatabases':
                await this._handleGetDatabases();
                break;
            case 'getObjects':
                await this._handleGetObjects(message.database);
                break;
            case 'getTableDetails':
                await this._handleGetTableDetails(message.database, message.table);
                break;
            case 'getObjectDetails':
                await this._handleGetObjectDetails(message.database, message.objectName, message.objectType);
                break;
            case 'searchObjects':
                await this._handleSearchObjects(message.database, message.searchPattern, message.objectTypes);
                break;
            case 'getTableRowCount':
                await this._handleGetTableRowCount(message.database, message.tableName);
                break;
            case 'getTableSampleData':
                await this._handleGetTableSampleData(message.database, message.tableName, message.limit);
                break;
            case 'getDependencyTree':
                await this._handleGetDependencyTree(message.database, message.objectName, message.maxDepth);
                break;
            case 'getImpactAnalysis':
                await this._handleGetImpactAnalysis(message.database, message.objectName);
                break;
            // Table Usage Analysis Commands
            case 'getTableUsageAnalysis':
                await this._handleGetTableUsageAnalysis(message.database, message.objectName);
                break;
            case 'getTableUsageByObjects':
                await this._handleGetTableUsageByObjects(message.database, message.tableName);
                break;
            case 'getTriggerAnalysis':
                await this._handleGetTriggerAnalysis(message.database);
                break;
            case 'getAllTablesForUsage':
                await this._handleGetAllTablesForUsage(message.database);
                break;
            // Extended Properties (Comments) Commands
            case 'getTableExtendedProperties':
                await this._handleGetTableExtendedProperties(message.database, message.tableName);
                break;
            case 'getObjectExtendedProperties':
                await this._handleGetObjectExtendedProperties(message.database, message.objectName, message.objectType);
                break;
            case 'updateTableDescription':
                await this._handleUpdateTableDescription(message.database, message.tableName, message.description);
                break;
            case 'updateColumnDescription':
                await this._handleUpdateColumnDescription(message.database, message.tableName, message.columnName, message.description);
                break;
            case 'updateObjectDescription':
                await this._handleUpdateObjectDescription(message.database, message.objectName, message.description);
                break;
            case 'deleteTableDescription':
                await this._handleDeleteTableDescription(message.database, message.tableName);
                break;
            case 'deleteColumnDescription':
                await this._handleDeleteColumnDescription(message.database, message.tableName, message.columnName);
                break;
            // Extended Events Commands
            case 'createExtendedEventSession':
                await this._handleCreateExtendedEventSession(message.database, message.procedureName, message.sessionName);
                break;
            case 'startExtendedEventSession':
                await this._handleStartExtendedEventSession(message.database, message.sessionName);
                break;
            case 'stopExtendedEventSession':
                await this._handleStopExtendedEventSession(message.database, message.sessionName);
                break;
            case 'deleteExtendedEventSession':
                await this._handleDeleteExtendedEventSession(message.database, message.sessionName);
                break;
            default:
                console.warn(`Unknown command: ${message.command}`);
        }
    }

    /**
     * Handle connection request
     * @param {Object} connectionConfig
     * @private
     */
    async _handleConnect(connectionConfig) {
        try {
            const result = await this._connectionManager.connect(connectionConfig);
            
            this._panel.webview.postMessage({
                command: 'connectionStatus',
                success: result.success,
                message: result.message
            });
            
            if (result.success) {
                // Automatically get databases after connection
                await this._handleGetDatabases();
            }
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'connectionStatus',
                success: false,
                message: `Connection failed: ${error.message}`
            });
        }
    }

    /**
     * Handle load connection for display request
     * @param {string} connectionName
     * @private
     */
    async _handleLoadConnectionForDisplay(connectionName) {
        try {
            const connection = await this._connectionManager.getConnectionForDisplay(connectionName);
            
            this._panel.webview.postMessage({
                command: 'connectionLoadedForDisplay',
                connection: connection
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'error',
                message: `Failed to load connection: ${error.message}`
            });
        }
    }

    /**
     * Handle connect with saved connection
     * @param {string} connectionName
     * @private
     */
    async _handleConnectWithSaved(connectionName) {
        try {
            const result = await this._connectionManager.connectWithSaved(connectionName);
            this._panel.webview.postMessage({
                command: 'connectionStatus',
                success: result.success,
                message: result.message
            });

            if (result.success) {
                await this._handleGetDatabases();
            }
        } catch (error) {
            this._sendError(`Failed to connect with saved connection: ${error.message}`);
        }
    }    

    /**
     * Handle save connection request
     * @param {Object} connectionConfig
     * @private
     */
    async _handleSaveConnection(connectionConfig) {
        try {
            const result = await this._connectionStorage.saveConnection(connectionConfig);
            
            this._panel.webview.postMessage({
                command: 'connectionSaved',
                success: result.success,
                message: result.message
            });
            
            if (result.success) {
                await this._handleLoadConnections();
            }
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'connectionSaved',
                success: false,
                message: `Failed to save connection: ${error.message}`
            });
        }
    }

    /**
     * Handle delete connection request
     * @param {string} connectionName
     * @private
     */
    async _handleDeleteConnection(connectionName) {
        try {
            const result = await this._connectionStorage.deleteConnection(connectionName);
            
            this._panel.webview.postMessage({
                command: 'connectionDeleted',
                success: result.success,
                message: result.message
            });
            
            if (result.success) {
                await this._handleLoadConnections();
            }
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'connectionDeleted',
                success: false,
                message: `Failed to delete connection: ${error.message}`
            });
        }
    }

    /**
     * Handle load connections request
     * @private
     */
    async _handleLoadConnections() {
        try {
            const connections = this._connectionStorage.getSavedConnections();
            
            this._panel.webview.postMessage({
                command: 'savedConnectionsLoaded',
                connections: connections
            });
        } catch (error) {
            console.error('Error loading saved connections:', error);
            this._sendError('Failed to load saved connections');
        }
    }

    /**
     * Handle test connection request
     * @param {Object} connectionConfig
     * @private
     */
    async _handleTestConnection(connectionConfig) {
        try {
            const result = await this._connectionManager.testConnection(connectionConfig);
            
            this._panel.webview.postMessage({
                command: 'testConnectionResult',
                success: result.success,
                message: result.message
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'testConnectionResult',
                success: false,
                message: `Connection test failed: ${error.message}`
            });
        }
    }

    /**
     * Handle get databases request
     * @private
     */
    async _handleGetDatabases() {
        try {
            const databases = await this._databaseService.getDatabases();
            
            this._panel.webview.postMessage({
                command: 'databasesLoaded',
                databases: databases
            });
        } catch (error) {
            this._sendError(`Failed to get databases: ${error.message}`);
        }
    }

    /**
     * Handle get objects request
     * @param {string} database
     * @private
     */
    async _handleGetObjects(database) {
        try {
            const objects = await this._databaseService.getObjects(database);
            
            this._panel.webview.postMessage({
                command: 'objectsLoaded',
                objects: objects
            });
        } catch (error) {
            this._sendError(`Failed to get objects: ${error.message}`);
        }
    }

    /**
     * Handle get table details request
     * @param {string} database
     * @param {string} tableName
     * @private
     */
    async _handleGetTableDetails(database, tableName) {
        try {
            const tableDetails = await this._databaseService.getTableDetails(database, tableName);
            
            // Get dependencies using DependencyService
            const dependencies = await this._dependencyService.getDependencies(database, tableName);
            
            this._panel.webview.postMessage({
                command: 'tableDetailsLoaded',
                tableName: tableName,
                columns: tableDetails.columns,
                indexes: tableDetails.indexes,
                foreignKeys: tableDetails.foreignKeys,
                dependencies: dependencies
            });
        } catch (error) {
            this._sendError(`Failed to get table details: ${error.message}`);
        }
    }

    /**
     * Handle get object details request
     * @param {string} database
     * @param {string} objectName
     * @param {string} objectType
     * @private
     */
    async _handleGetObjectDetails(database, objectName, objectType) {
        try {
            // Get object info
            const objectInfo = await this._databaseService.getObjectInfo(database, objectName);
            
            // Get dependencies
            const dependencies = await this._dependencyService.getDependencies(database, objectName);

            // Get object definition for views, procedures, functions
            let definition = null;
            if (objectType !== 'Table') {
                definition = await this._databaseService.getObjectDefinition(database, objectName);
            }

            this._panel.webview.postMessage({
                command: 'objectDetailsLoaded',
                objectName: objectName,
                objectType: objectType,
                objectInfo: objectInfo,
                dependencies: dependencies,
                definition: definition
            });
        } catch (error) {
            this._sendError(`Failed to get object details: ${error.message}`);
        }
    }

    /**
     * Handle search objects request
     * @param {string} database
     * @param {string} searchPattern
     * @param {Array} objectTypes
     * @private
     */
    async _handleSearchObjects(database, searchPattern, objectTypes) {
        try {
            const objects = await this._databaseService.searchObjects(database, searchPattern, objectTypes);
            
            this._panel.webview.postMessage({
                command: 'searchObjectsResult',
                objects: objects
            });
        } catch (error) {
            this._sendError(`Failed to search objects: ${error.message}`);
        }
    }

    /**
     * Handle get table row count request
     * @param {string} database
     * @param {string} tableName
     * @private
     */
    async _handleGetTableRowCount(database, tableName) {
        try {
            const rowCount = await this._databaseService.getTableRowCount(database, tableName);
            
            this._panel.webview.postMessage({
                command: 'tableRowCountResult',
                tableName: tableName,
                rowCount: rowCount
            });
        } catch (error) {
            this._sendError(`Failed to get table row count: ${error.message}`);
        }
    }

    /**
     * Handle get table sample data request
     * @param {string} database
     * @param {string} tableName
     * @param {number} limit
     * @private
     */
    async _handleGetTableSampleData(database, tableName, limit = 100) {
        try {
            const sampleData = await this._databaseService.getTableSampleData(database, tableName, limit);
            
            this._panel.webview.postMessage({
                command: 'tableSampleDataResult',
                tableName: tableName,
                sampleData: sampleData
            });
        } catch (error) {
            this._sendError(`Failed to get table sample data: ${error.message}`);
        }
    }

    /**
     * Handle get dependency tree request
     * @param {string} database
     * @param {string} objectName
     * @param {number} maxDepth
     * @private
     */
    async _handleGetDependencyTree(database, objectName, maxDepth = 3) {
        try {
            const dependencyTree = await this._dependencyService.getDependencyTree(database, objectName, maxDepth);
            
            this._panel.webview.postMessage({
                command: 'dependencyTreeResult',
                objectName: objectName,
                dependencyTree: dependencyTree
            });
        } catch (error) {
            this._sendError(`Failed to get dependency tree: ${error.message}`);
        }
    }

    /**
     * Handle get impact analysis request
     * @param {string} database
     * @param {string} objectName
     * @private
     */
    async _handleGetImpactAnalysis(database, objectName) {
        try {
            const impactAnalysis = await this._dependencyService.getImpactAnalysis(database, objectName);
            
            this._panel.webview.postMessage({
                command: 'impactAnalysisResult',
                objectName: objectName,
                impactAnalysis: impactAnalysis
            });
        } catch (error) {
            this._sendError(`Failed to get impact analysis: ${error.message}`);
        }
    }

    /**
     * Handle get table usage analysis request
     * @param {string} database
     * @param {string} objectName
     * @private
     */
    async _handleGetTableUsageAnalysis(database, objectName) {
        try {
            const analysis = await this._dependencyService.getTableUsageAnalysis(database, objectName);
            
            this._panel.webview.postMessage({
                command: 'tableUsageAnalysisResult',
                objectName: objectName,
                analysis: analysis
            });
        } catch (error) {
            this._sendError(`Failed to get table usage analysis: ${error.message}`);
        }
    }

    /**
     * Handle get table usage by objects request
     * @param {string} database
     * @param {string} tableName
     * @private
     */
    async _handleGetTableUsageByObjects(database, tableName) {
        try {
            const usage = await this._dependencyService.getTableUsageByObjects(database, tableName);
            
            this._panel.webview.postMessage({
                command: 'tableUsageByObjectsResult',
                tableName: tableName,
                usage: usage
            });
        } catch (error) {
            this._sendError(`Failed to get table usage by objects: ${error.message}`);
        }
    }

    /**
     * Handle get trigger analysis request
     * @param {string} database
     * @private
     */
    async _handleGetTriggerAnalysis(database) {
        try {
            const triggers = await this._dependencyService.getTriggerAnalysis(database);
            
            this._panel.webview.postMessage({
                command: 'triggerAnalysisResult',
                database: database,
                triggers: triggers
            });
        } catch (error) {
            this._sendError(`Failed to get trigger analysis: ${error.message}`);
        }
    }

    /**
     * Handle get all tables for usage analysis
     * @param {string} database
     * @private
     */
    async _handleGetAllTablesForUsage(database) {
        try {
            // Reuse existing getObjects but filter for tables only
            const allObjects = await this._databaseService.getObjects(database);
            const tables = allObjects.filter(obj => obj.object_type === 'Table');
            
            this._panel.webview.postMessage({
                command: 'allTablesForUsageResult',
                database: database,
                tables: tables
            });
        } catch (error) {
            this._sendError(`Failed to get tables for usage analysis: ${error.message}`);
        }
    }

    // Extended Properties (Comments) Handlers

    /**
     * Handle get table extended properties request
     * @param {string} database
     * @param {string} tableName
     * @private
     */
    async _handleGetTableExtendedProperties(database, tableName) {
        try {
            const properties = await this._dependencyService.getTableExtendedProperties(database, tableName);
            
            this._panel.webview.postMessage({
                command: 'tableExtendedPropertiesResult',
                tableName: tableName,
                properties: properties
            });
        } catch (error) {
            this._sendError(`Failed to get table extended properties: ${error.message}`);
        }
    }

    /**
     * Handle get object extended properties request
     * @param {string} database
     * @param {string} objectName
     * @param {string} objectType
     * @private
     */
    async _handleGetObjectExtendedProperties(database, objectName, objectType) {
        try {
            const properties = await this._dependencyService.getObjectExtendedProperties(database, objectName, objectType);
            
            this._panel.webview.postMessage({
                command: 'objectExtendedPropertiesResult',
                objectName: objectName,
                objectType: objectType,
                properties: properties
            });
        } catch (error) {
            this._sendError(`Failed to get object extended properties: ${error.message}`);
        }
    }

    /**
     * Handle update table description request
     * @param {string} database
     * @param {string} tableName
     * @param {string} description
     * @private
     */
    async _handleUpdateTableDescription(database, tableName, description) {
        try {
            const result = await this._dependencyService.updateTableDescription(database, tableName, description);
            
            this._panel.webview.postMessage({
                command: 'updateDescriptionResult',
                success: result.success,
                message: result.message,
                type: 'table',
                tableName: tableName
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'updateDescriptionResult',
                success: false,
                message: `Failed to update table description: ${error.message}`,
                type: 'table',
                tableName: tableName
            });
        }
    }

    /**
     * Handle update column description request
     * @param {string} database
     * @param {string} tableName
     * @param {string} columnName
     * @param {string} description
     * @private
     */
    async _handleUpdateColumnDescription(database, tableName, columnName, description) {
        try {
            const result = await this._dependencyService.updateColumnDescription(database, tableName, columnName, description);
            
            this._panel.webview.postMessage({
                command: 'updateDescriptionResult',
                success: result.success,
                message: result.message,
                type: 'column',
                tableName: tableName,
                columnName: columnName
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'updateDescriptionResult',
                success: false,
                message: `Failed to update column description: ${error.message}`,
                type: 'column',
                tableName: tableName,
                columnName: columnName
            });
        }
    }

    /**
     * Handle update object description request
     * @param {string} database
     * @param {string} objectName
     * @param {string} description
     * @private
     */
    async _handleUpdateObjectDescription(database, objectName, description) {
        try {
            const result = await this._dependencyService.updateObjectDescription(database, objectName, description);
            
            this._panel.webview.postMessage({
                command: 'updateDescriptionResult',
                success: result.success,
                message: result.message,
                type: 'object',
                objectName: objectName
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'updateDescriptionResult',
                success: false,
                message: `Failed to update object description: ${error.message}`,
                type: 'object',
                objectName: objectName
            });
        }
    }

    /**
     * Handle delete table description request
     * @param {string} database
     * @param {string} tableName
     * @private
     */
    async _handleDeleteTableDescription(database, tableName) {
        try {
            const result = await this._dependencyService.deleteTableDescription(database, tableName);
            
            this._panel.webview.postMessage({
                command: 'deleteDescriptionResult',
                success: result.success,
                message: result.message,
                type: 'table',
                tableName: tableName
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'deleteDescriptionResult',
                success: false,
                message: `Failed to delete table description: ${error.message}`,
                type: 'table',
                tableName: tableName
            });
        }
    }

    /**
     * Handle delete column description request
     * @param {string} database
     * @param {string} tableName
     * @param {string} columnName
     * @private
     */
    async _handleDeleteColumnDescription(database, tableName, columnName) {
        try {
            const result = await this._dependencyService.deleteColumnDescription(database, tableName, columnName);
            
            this._panel.webview.postMessage({
                command: 'deleteDescriptionResult',
                success: result.success,
                message: result.message,
                type: 'column',
                tableName: tableName,
                columnName: columnName
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'deleteDescriptionResult',
                success: false,
                message: `Failed to delete column description: ${error.message}`,
                type: 'column',
                tableName: tableName,
                columnName: columnName
            });
        }
    }

    // Extended Events Handlers

    /**
     * Handle create extended event session request
     * @param {string} database - Database name
     * @param {string} procedureName - Procedure name
     * @param {string} sessionName - Session name
     * @private
     */
    async _handleCreateExtendedEventSession(database, procedureName, sessionName) {
        try {
            // TODO: Implement extended event session creation logic
            // For now, return a mock success response
            this._panel.webview.postMessage({
                command: 'extendedEventSessionCreated',
                success: true,
                sessionName: sessionName,
                message: `Extended Event session '${sessionName}' created successfully for procedure '${procedureName}'`
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'extendedEventSessionCreated',
                success: false,
                message: `Failed to create Extended Event session: ${error.message}`
            });
        }
    }

    /**
     * Handle start extended event session request
     * @param {string} database - Database name
     * @param {string} sessionName - Session name
     * @private
     */
    async _handleStartExtendedEventSession(database, sessionName) {
        try {
            // TODO: Implement extended event session start logic
            this._panel.webview.postMessage({
                command: 'extendedEventSessionStarted',
                success: true,
                message: `Extended Event session '${sessionName}' started successfully`
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'extendedEventSessionStarted',
                success: false,
                message: `Failed to start Extended Event session: ${error.message}`
            });
        }
    }

    /**
     * Handle stop extended event session request
     * @param {string} database - Database name
     * @param {string} sessionName - Session name
     * @private
     */
    async _handleStopExtendedEventSession(database, sessionName) {
        try {
            // TODO: Implement extended event session stop logic
            this._panel.webview.postMessage({
                command: 'extendedEventSessionStopped',
                success: true,
                message: `Extended Event session '${sessionName}' stopped successfully`
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'extendedEventSessionStopped',
                success: false,
                message: `Failed to stop Extended Event session: ${error.message}`
            });
        }
    }

    /**
     * Handle delete extended event session request
     * @param {string} database - Database name
     * @param {string} sessionName - Session name
     * @private
     */
    async _handleDeleteExtendedEventSession(database, sessionName) {
        try {
            // TODO: Implement extended event session deletion logic
            this._panel.webview.postMessage({
                command: 'extendedEventSessionDeleted',
                success: true,
                message: `Extended Event session '${sessionName}' deleted successfully`
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'extendedEventSessionDeleted',
                success: false,
                message: `Failed to delete Extended Event session: ${error.message}`
            });
        }
    }

    /**
     * Send error message to webview
     * @param {string} message
     * @private
     */
    _sendError(message) {
        this._panel.webview.postMessage({
            command: 'error',
            message: message
        });
    }

    /**
     * Update the webview content
     * @private
     */
    _update() {
        this._panel.title = 'SQL Wayfarer';
        this._panel.webview.html = this._getHtmlForWebview();
    }

    /**
     * Generate HTML for webview
     * @returns {string} HTML content
     * @private
     */
    _getHtmlForWebview() {
        // Get file URIs
        const stylesUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'webview', 'styles.css')
        );
        
        // Get URIs for the JavaScript files
        const tabManagerUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'webview', 'tabManager.js')
        );
        
        const connectionManagerUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'webview', 'connectionManager.js')
        );
        
        const tableUsageManagerUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'webview', 'tableUsageManager.js')
        );
        
        const commentsManagerUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'webview', 'commentsManager.js')
        );

        const extendedEventsManagerUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'webview', 'extendedEventsManager.js')
        );

        const commentsStylesUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'webview', 'comments.css')
        );

        const extendedEventsStylesUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'webview', 'extendedEvents.css')
        );
        
        const mainScriptUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'webview', 'main.js')
        );
        
        // Read the HTML template
        const htmlPath = path.join(this._extensionUri.fsPath, 'webview', 'index.html');
        let html = fs.readFileSync(htmlPath, 'utf8');
        
        // Replace placeholders with actual URIs
        html = html.replace('{{STYLES_URI}}', stylesUri.toString());
        html = html.replace('{{COMMENTS_STYLES_URI}}', commentsStylesUri.toString());
        html = html.replace('{{EXTENDED_EVENTS_STYLES_URI}}', extendedEventsStylesUri.toString());
        html = html.replace('{{TAB_MANAGER_URI}}', tabManagerUri.toString());
        html = html.replace('{{CONNECTION_MANAGER_URI}}', connectionManagerUri.toString());
        html = html.replace('{{TABLE_USAGE_MANAGER_URI}}', tableUsageManagerUri.toString());
        html = html.replace('{{COMMENTS_MANAGER_URI}}', commentsManagerUri.toString());
        html = html.replace('{{EXTENDED_EVENTS_MANAGER_URI}}', extendedEventsManagerUri.toString());
        html = html.replace('{{MAIN_SCRIPT_URI}}', mainScriptUri.toString());
        
        return html;
    }

    /**
     * Dispose of the panel and clean up resources
     */
    async dispose() {
        SqlWayfarerPanel.currentPanel = undefined;

        this._panel.dispose();

        // Dispose of connection manager which will close active connections
        if (this._connectionManager) {
            await this._connectionManager.dispose();
        }

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}

// Initialize static property
SqlWayfarerPanel.currentPanel = undefined;

module.exports = SqlWayfarerPanel;