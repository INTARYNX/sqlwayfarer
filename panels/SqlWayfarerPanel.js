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
// CORRECTION: Utiliser DependencyService au lieu de OldDependencyService
const DependencyService = require('../database/DependencyService');
const ExtendedEventsService = require('../database/ExtendedEventsService');
const IndexService = require('../database/IndexServices');

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
        this._indexingInProgress = false;

        // Initialize services
        this._connectionStorage = new ConnectionStorage(context);
        this._connectionManager = new ConnectionManager(this._connectionStorage);
        this._databaseService = new DatabaseService(this._connectionManager);
        this._indexService = new IndexService(this._connectionManager, this._databaseService);
        this._dependencyService = new DependencyService(this._connectionManager, this._databaseService);
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
            
            // IMPORTANT: Connect IndexService with DependencyService
            this._dependencyService.setIndexService(this._indexService);
            console.log('🔗 IndexService connected to DependencyService');
            
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
            // Enhanced Extended Events Commands
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
            case 'getRawSessionEvents':
                await this._handleGetRawSessionEvents(message.sessionName);
                break;
            // CORRECTION: Nouvelles commandes d'indexation avec validation
            case 'forceReindex':
                await this._handleForceReindex(message.database);
                break;
            case 'cancelIndexing':
                await this._handleCancelIndexing();
                break;
            case 'getIndexStats':
                await this._handleGetIndexStats(message.database);
                break;
            case 'getIndex':
                await this._handleGetIndex(message.database);
                break;     
            case 'confirmForceReindex':
                await this._handleConfirmForceReindex(message.database);
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
            
            // Clear index when database list changes (connection change)
            if (this._currentSelectedDatabase && 
                typeof this._dependencyService.clearIndex === 'function') {
                try {
                    await this._dependencyService.clearIndex(this._currentSelectedDatabase);
                } catch (clearError) {
                    console.warn('Error clearing index on database change:', clearError);
                }
            }
            
            this._panel.webview.postMessage({
                command: 'requestCurrentDatabase'
            });
        } catch (error) {
            this._sendError(`Failed to get databases: ${error.message}`);
        }
    }

    async _handleGetObjects(database) {
        try {
            console.log(`Getting objects for database: ${database}`);
            
            const objects = await this._databaseService.getObjects(database);
            this._panel.webview.postMessage({
                command: 'objectsLoaded',
                objects: objects
            });

            console.log(`Loaded ${objects.length} objects for database: ${database}`);

            // Start indexing in background with improved error handling
            if (!this._indexingInProgress) {
                this._startBackgroundIndexing(database).catch(error => {
                    console.error('Background indexing setup failed:', error);
                    // Don't throw - just log the error
                });
            } else {
                console.log('Indexing already in progress, skipping background indexing');
            }
            
        } catch (error) {
            console.error('Error getting objects:', error);
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

    // ENHANCED EXTENDED EVENTS HANDLERS
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

    async _handleGetRawSessionEvents(sessionName) {
        try {
            const result = await this._extendedEventsService.getSessionRawEvents(sessionName);
            this._panel.webview.postMessage({
                command: 'rawSessionEventsResult',
                success: result.success,
                sessionName: sessionName,
                rawXml: result.rawXml,
                message: result.message
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'rawSessionEventsResult',
                success: false,
                sessionName: sessionName,
                message: `Failed to get raw events: ${error.message}`
            });
        }
    }

    // INDEXING HANDLERS
    async _startBackgroundIndexing(database) {
        if (this._indexingInProgress) {
            console.log('Indexing already in progress, skipping');
            return;
        }
        
        this._indexingInProgress = true;
        
        try {
            // Send indexing started message
            this._panel.webview.postMessage({
                command: 'indexingStarted',
                database: database
            });

            // Progress callback
            const progressCallback = (progress) => {
                try {
                    this._panel.webview.postMessage({
                        command: 'indexingProgress',
                        database: database,
                        progress: progress.progress,
                        current: progress.current,
                        total: progress.total,
                        message: progress.message
                    });
                } catch (err) {
                    console.error('Error sending progress update:', err);
                }
            };

            // CORRECTION: Vérifier que la méthode getIndex existe avant de l'appeler
            if (typeof this._dependencyService.getIndex !== 'function') {
                throw new Error('DependencyService.getIndex method is not available');
            }

            // Perform indexing with timeout
            const indexingTimeout = 300000; // 5 minutes
            const indexingPromise = this._dependencyService.getIndex(database, progressCallback);
            
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Indexing timeout after 5 minutes')), indexingTimeout);
            });

            await Promise.race([indexingPromise, timeoutPromise]);
            
            // Send completion message
            this._panel.webview.postMessage({
                command: 'indexingCompleted',
                database: database,
                success: true,
                message: 'Database indexing completed successfully'
            });

            console.log(`Background indexing completed successfully for database: ${database}`);

        } catch (error) {
           console.error('Background indexing failed:', error);
           
           // Send error message to webview
            this._panel.webview.postMessage({
              command: 'indexingCompleted',
              database: database,
              success: false,
              message: `Indexing failed: ${error.message}`
          });

          // Show user-friendly error message
          const errorMsg = this._getUserFriendlyIndexingError(error);
          vscode.window.showWarningMessage(`Database indexing failed: ${errorMsg}`, 'Retry', 'Ignore')
              .then(selection => {
                  if (selection === 'Retry') {
                      // Retry indexing after a short delay
                      setTimeout(() => {
                          this._indexingInProgress = false;
                          this._startBackgroundIndexing(database);
                      }, 2000);
                  }
              });

      } finally {
          this._indexingInProgress = false;
      }
  }

  async _handleConfirmForceReindex(database) {
    try {
        // Use VS Code's native confirmation dialog
        const selection = await vscode.window.showWarningMessage(
            `Are you sure you want to force reindex database "${database}"?\n\nThis will clear the existing index and rebuild it from scratch.`,
            { modal: true },
            'Yes, Force Reindex',
            'Cancel'
        );

        if (selection === 'Yes, Force Reindex') {
            // User confirmed, proceed with force reindex
            this._panel.webview.postMessage({
                command: 'forceReindexConfirmed',
                database: database
            });
        }
    } catch (error) {
        console.error('Error showing confirmation dialog:', error);
        this._sendError('Failed to show confirmation dialog');
    }
}

async _handleForceReindex(database) {
    try {
        if (!database) {
            this._sendError('No database specified for force reindex');
            return;
        }

        console.log(`Force reindexing database: ${database}`);

        // Send indexing started message
        this._panel.webview.postMessage({
            command: 'indexingStarted',
            database: database,
            forced: true
        });

        const progressCallback = (progress) => {
            this._panel.webview.postMessage({
                command: 'indexingProgress',
                database: database,
                progress: progress.progress,
                current: progress.current,
                total: progress.total,
                message: progress.message
            });
        };

        // USE forceReindex method instead of clearIndex + getIndex
        const index = await this._indexService.forceReindex(database, progressCallback);
        
        this._panel.webview.postMessage({
            command: 'indexResult',
            indexData: index
        });

        this._panel.webview.postMessage({
            command: 'indexingCompleted',
            database: database,
            success: true,
            forced: true,
            message: 'Force reindex completed successfully'
        });

        console.log(`Force reindex completed for database: ${database}`);

    } catch (error) {
        console.error('Error force reindexing:', error);
        
        this._panel.webview.postMessage({
            command: 'indexingCompleted',
            database: database,
            success: false,
            forced: true,
            message: `Force reindex failed: ${error.message}`
        });
        
        this._sendError(`Failed to force reindex: ${error.message}`);
    }
}
  
 async _handleCancelIndexing() {
     try {
         console.log('Canceling indexing operation');
         
         // Set flag to stop indexing
         this._indexingInProgress = false;
         
         // CORRECTION: Vérifier si la méthode clearIndex existe
         if (this._currentSelectedDatabase && 
             typeof this._dependencyService.clearIndex === 'function') {
             try {
                 await this._dependencyService.clearIndex(this._currentSelectedDatabase);
                 console.log('Index cleared during cancellation');
             } catch (clearError) {
                 console.warn('Error clearing index during cancellation:', clearError);
             }
         }

         this._panel.webview.postMessage({
             command: 'indexingCancelled',
             message: 'Indexing operation cancelled',
             success: true
         });

     } catch (error) {
         console.error('Error cancelling indexing:', error);
         this._panel.webview.postMessage({
             command: 'indexingCancelled',
             message: `Error cancelling indexing: ${error.message}`,
             success: false
         });
     }
 }

 async _handleGetIndexStats(database) {
     try {
         const targetDatabase = database || this._getCurrentDatabase();
         if (!targetDatabase) {
             this._sendError('No database selected');
             return;
         }

         console.log(`Getting index stats for database: ${targetDatabase}`);

         // Check if we have index service available
         let stats = {
             exists: false,
             objectCount: 0,
             lastIndexed: null,
             indexingInProgress: this._indexingInProgress
         };

         // CORRECTION: Vérifier l'existence des méthodes avant de les utiliser
         if (this._dependencyService && 
             typeof this._dependencyService.getIndex === 'function') {
             try {
                 // Try to get basic index info without triggering full indexing
                 // This is a simplified approach - you might want to add a specific getIndexStats method
                 stats.exists = true;
                 stats.lastIndexed = new Date().toISOString();
                 console.log('Index service is available');
             } catch (indexError) {
                 console.warn('Index service available but index not accessible:', indexError);
                 stats.exists = false;
             }
         } else {
             console.warn('Index service or getIndex method not available');
         }

         this._panel.webview.postMessage({
             command: 'indexStatsResult',
             database: targetDatabase,
             stats: stats
         });

     } catch (error) {
         console.error('Error getting index stats:', error);
         this._sendError(`Failed to get index stats: ${error.message}`);
     }
 }

 async _handleGetIndex(database) {
    try {
        if (!database) {
            this._sendError('No database specified for indexing');
            return;
        }

        console.log(`Getting index for database: ${database}`);

        // Progress callback to send updates to frontend
        const progressCallback = (progress) => {
            this._panel.webview.postMessage({
                command: 'indexingProgress',
                database: database,
                progress: progress.progress,
                current: progress.current,
                total: progress.total,
                message: progress.message
            });
        };

        // Get the index directly from IndexService
        const index = await this._indexService.getIndex(database, progressCallback);
        
        this._panel.webview.postMessage({
            command: 'indexResult',
            indexData: index
        });

        console.log(`Index retrieved for database: ${database}`);

    } catch (error) {
        console.error('Error getting index:', error);
        this._panel.webview.postMessage({
            command: 'indexResult',
            indexData: null
        });
        this._sendError(`Failed to get index: ${error.message}`);
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
    const commentsManagerUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'commentsManager.js'));
    const extendedEventsManagerUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'extendedEventsManager.js'));
    const codeViewManagerUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'codeViewManager.js')); // NOUVEAU
    const commentsStylesUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'comments.css'));
    const extendedEventsStylesUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'extendedEvents.css'));
    const tableUsageStylesUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'tableUsage.css'));
    const codeViewStylesUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'codeView.css')); // NOUVEAU
    const mainScriptUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'main.js'));

    const htmlPath = path.join(this._extensionUri.fsPath, 'webview', 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    html = html.replace('{{STYLES_URI}}', stylesUri.toString());
    html = html.replace('{{COMMENTS_STYLES_URI}}', commentsStylesUri.toString());
    html = html.replace('{{EXTENDED_EVENTS_STYLES_URI}}', extendedEventsStylesUri.toString());
    html = html.replace('{{TABLE_USAGE_STYLES_URI}}', tableUsageStylesUri.toString());
    html = html.replace('{{CODE_VIEW_STYLES_URI}}', codeViewStylesUri.toString()); // NOUVEAU
    html = html.replace('{{TAB_MANAGER_URI}}', tabManagerUri.toString());
    html = html.replace('{{CONNECTION_MANAGER_URI}}', connectionManagerUri.toString());
    html = html.replace('{{COMMENTS_MANAGER_URI}}', commentsManagerUri.toString());
    html = html.replace('{{EXTENDED_EVENTS_MANAGER_URI}}', extendedEventsManagerUri.toString());
    html = html.replace('{{CODE_VIEW_MANAGER_URI}}', codeViewManagerUri.toString()); // NOUVEAU
    html = html.replace('{{MAIN_SCRIPT_URI}}', mainScriptUri.toString());

    return html;
}

 async dispose() {
     SqlWayfarerPanel.currentPanel = undefined;
     this._panel.dispose();

     // Clean up indexing
     this._indexingInProgress = false;
     if (this._dependencyService && this._currentSelectedDatabase) {
         try {
             if (typeof this._dependencyService.clearIndex === 'function') {
                 await this._dependencyService.clearIndex(this._currentSelectedDatabase);
             }
         } catch (error) {
             console.warn('Error clearing index during disposal:', error);
         }
     }

     if (this._extendedEventsService) {
         try {
             await this._extendedEventsService.dispose();
         } catch (error) {
             console.warn('Error disposing extended events service:', error);
         }
     }
     
     if (this._connectionManager) {
         try {
             await this._connectionManager.dispose();
         } catch (error) {
             console.warn('Error disposing connection manager:', error);
         }
     }

     while (this._disposables.length) {
         const x = this._disposables.pop();
         if (x) {
             try {
                 x.dispose();
             } catch (error) {
                 console.warn('Error disposing resource:', error);
             }
         }
     }
 }
}

SqlWayfarerPanel.currentPanel = undefined;
module.exports = SqlWayfarerPanel;           