/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const ConnectionStorage = require('../storage/ConnectionStorage');
const ConnectionManager = require('../database/ConnectionManager');
const DatabaseService = require('../database/DatabaseService');
const DependencyService = require('../database/DependencyService');
const ExtendedEventsService = require('../database/ExtendedEventsService');

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
        this._currentSelectedDatabase = null;

        // Initialize services
        this._connectionStorage = new ConnectionStorage(context);
        this._connectionManager = new ConnectionManager(this._connectionStorage);
        this._databaseService = new DatabaseService(this._connectionManager);
        this._dependencyService = new DependencyService(this._connectionManager);
        this._extendedEventsService = new ExtendedEventsService(this._connectionManager);

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
            case 'setCurrentDatabase':
                this._currentSelectedDatabase = message.database;
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
            case 'createExecutionFlowSession':
                await this._handleCreateExecutionFlowSession(message.database, message.sessionName, message.config);
                break;
            case 'startExecutionFlowSession':
                await this._handleStartExecutionFlowSession(message.sessionName);
                break;
            case 'stopExecutionFlowSession':
                await this._handleStopExecutionFlowSession(message.sessionName);
                break;
            case 'deleteExecutionFlowSession':
                await this._handleDeleteExecutionFlowSession(message.sessionName);
                break;
            case 'getExecutionFlowSessionInfo':
                await this._handleGetExecutionFlowSessionInfo(message.sessionName);
                break;
            case 'listExecutionFlowSessions':
                await this._handleListExecutionFlowSessions();
                break;
            default:
                console.warn(`Unknown command: ${message.command}`);
        }
    }

    // CONNECTION HANDLERS
    async _handleConnect(connectionConfig) {
        try {
            const result = await this._connectionManager.connect(connectionConfig);
            this._panel.webview.postMessage({
                command: 'connectionStatus',
                success: result.success,
                message: result.message
            });
            if (result.success) {
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

    // DATABASE HANDLERS
    async _handleGetDatabases() {
        try {
            const databases = await this._databaseService.getDatabases();
            this._panel.webview.postMessage({
                command: 'databasesLoaded',
                databases: databases
            });
            this._panel.webview.postMessage({
                command: 'requestCurrentDatabase'
            });
        } catch (error) {
            this._sendError(`Failed to get databases: ${error.message}`);
        }
    }

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

    async _handleGetTableDetails(database, tableName) {
        try {
            const tableDetails = await this._databaseService.getTableDetails(database, tableName);
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

    async _handleGetObjectDetails(database, objectName, objectType) {
        try {
            const objectInfo = await this._databaseService.getObjectInfo(database, objectName);
            const dependencies = await this._dependencyService.getDependencies(database, objectName);
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

    // TABLE USAGE HANDLERS
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

    async _handleGetAllTablesForUsage(database) {
        try {
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

    // COMMENTS HANDLERS
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

    // EXTENDED EVENTS HANDLERS
    async _handleCreateExecutionFlowSession(database, sessionName, config) {
        try {
            const targetDatabase = database || this._getCurrentDatabase();
            const result = await this._extendedEventsService.createExecutionFlowSession(targetDatabase, sessionName, config || {});
            this._panel.webview.postMessage({
                command: 'executionFlowSessionCreated',
                success: result.success,
                message: result.message,
                sessionName: result.sessionName || sessionName
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'executionFlowSessionCreated',
                success: false,
                message: `Failed to create execution flow session: ${error.message}`
            });
        }
    }

    async _handleStartExecutionFlowSession(sessionName) {
        try {
            const result = await this._extendedEventsService.startSession(sessionName);
            this._panel.webview.postMessage({
                command: 'executionFlowSessionStarted',
                success: result.success,
                message: result.message,
                sessionName: sessionName
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'executionFlowSessionStarted',
                success: false,
                message: `Failed to start execution flow session: ${error.message}`
            });
        }
    }

    async _handleStopExecutionFlowSession(sessionName) {
        try {
            const result = await this._extendedEventsService.stopSession(sessionName);
            this._panel.webview.postMessage({
                command: 'executionFlowSessionStopped',
                success: result.success,
                message: result.message,
                sessionName: sessionName
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'executionFlowSessionStopped',
                success: false,
                message: `Failed to stop execution flow session: ${error.message}`
            });
        }
    }

    async _handleDeleteExecutionFlowSession(sessionName) {
        try {
            const result = await this._extendedEventsService.deleteSession(sessionName);
            this._panel.webview.postMessage({
                command: 'executionFlowSessionDeleted',
                success: result.success,
                message: result.message,
                sessionName: sessionName
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'executionFlowSessionDeleted',
                success: false,
                message: `Failed to delete execution flow session: ${error.message}`
            });
        }
    }

    async _handleGetExecutionFlowSessionInfo(sessionName) {
        try {
            const info = await this._extendedEventsService.getSessionInfo(sessionName);
            this._panel.webview.postMessage({
                command: 'executionFlowSessionInfo',
                success: true,
                sessionName: sessionName,
                info: info
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'executionFlowSessionInfo',
                success: false,
                message: `Failed to get session info: ${error.message}`
            });
        }
    }

    async _handleListExecutionFlowSessions() {
        try {
            const sessions = await this._extendedEventsService.listSessions();
            this._panel.webview.postMessage({
                command: 'executionFlowSessionsList',
                success: true,
                sessions: sessions
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'executionFlowSessionsList',
                success: false,
                message: `Failed to list sessions: ${error.message}`
            });
        }
    }

    // UTILITY METHODS
    _getCurrentDatabase() {
        return this._currentSelectedDatabase || 'master';
    }

    _sendError(message) {
        this._panel.webview.postMessage({
            command: 'error',
            message: message
        });
    }

    _update() {
        this._panel.title = 'SQL Wayfarer';
        this._panel.webview.html = this._getHtmlForWebview();
    }

    _getHtmlForWebview() {
        const stylesUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'styles.css'));
        const tabManagerUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'tabManager.js'));
        const connectionManagerUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'connectionManager.js'));
        const tableUsageManagerUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'tableUsageManager.js'));
        const commentsManagerUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'commentsManager.js'));
        const extendedEventsManagerUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'extendedEventsManager.js'));
        const commentsStylesUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'comments.css'));
        const extendedEventsStylesUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'extendedEvents.css'));
        const tableUsageStylesUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'tableUsage.css'));
        const mainScriptUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'main.js'));

        const htmlPath = path.join(this._extensionUri.fsPath, 'webview', 'index.html');
        let html = fs.readFileSync(htmlPath, 'utf8');

        html = html.replace('{{STYLES_URI}}', stylesUri.toString());
        html = html.replace('{{COMMENTS_STYLES_URI}}', commentsStylesUri.toString());
        html = html.replace('{{EXTENDED_EVENTS_STYLES_URI}}', extendedEventsStylesUri.toString());
        html = html.replace('{{TABLE_USAGE_STYLES_URI}}', tableUsageStylesUri.toString());
        html = html.replace('{{TAB_MANAGER_URI}}', tabManagerUri.toString());
        html = html.replace('{{CONNECTION_MANAGER_URI}}', connectionManagerUri.toString());
        html = html.replace('{{TABLE_USAGE_MANAGER_URI}}', tableUsageManagerUri.toString());
        html = html.replace('{{COMMENTS_MANAGER_URI}}', commentsManagerUri.toString());
        html = html.replace('{{EXTENDED_EVENTS_MANAGER_URI}}', extendedEventsManagerUri.toString());
        html = html.replace('{{MAIN_SCRIPT_URI}}', mainScriptUri.toString());

        return html;
    }

    async dispose() {
        SqlWayfarerPanel.currentPanel = undefined;
        this._panel.dispose();

        if (this._extendedEventsService) {
            await this._extendedEventsService.dispose();
        }
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

SqlWayfarerPanel.currentPanel = undefined;
module.exports = SqlWayfarerPanel;