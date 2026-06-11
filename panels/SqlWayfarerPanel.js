'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const ConnectionStorage = require('../storage/ConnectionStorage');
const ConnectionManager = require('../database/ConnectionManager');
const DatabaseService = require('../database/DatabaseService');
const DependencyService = require('../database/DependencyService');
const ExtendedEventsService = require('../database/ExtendedEventsService');
const IndexService = require('../database/IndexServices');
const CommentsService = require('../database/CommentsService');

const ConnectionHandlers = require('./handlers/ConnectionHandlers');
const DatabaseHandlers = require('./handlers/DatabaseHandlers');
const CommentsHandlers = require('./handlers/CommentsHandlers');
const ExtendedEventsHandlers = require('./handlers/ExtendedEventsHandlers');
const IndexHandlers = require('./handlers/IndexHandlers');

class SqlWayfarerPanel {
    constructor(panel, extensionUri, context) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._context = context;
        this._disposables = [];
        this._currentSelectedDatabase = null;

        this._connectionStorage = new ConnectionStorage(context);
        this._connectionManager = new ConnectionManager(this._connectionStorage);
        this._databaseService = new DatabaseService(this._connectionManager);
        this._indexService = new IndexService(this._connectionManager, this._databaseService);
        this._dependencyService = new DependencyService();
        this._commentsService = new CommentsService(this._connectionManager);
        this._extendedEventsService = new ExtendedEventsService(this._connectionManager);

        const post = msg => this._panel.webview.postMessage(msg);
        const getDb = () => this._currentSelectedDatabase;

        this._conn = new ConnectionHandlers(post, this._connectionManager, this._connectionStorage);
        this._db = new DatabaseHandlers(post, this._databaseService, this._dependencyService, this._indexService, getDb);
        this._comments = new CommentsHandlers(post, this._commentsService);
        this._ee = new ExtendedEventsHandlers(post, this._extendedEventsService, getDb);
        this._idx = new IndexHandlers(post, this._indexService, this._dependencyService, getDb);

        this._initialize();
    }

    static createOrShow(extensionUri, context) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (SqlWayfarerPanel.currentPanel) {
            SqlWayfarerPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'sqlwayfarer-sqlwayfarer',
            'SQL Wayfarer',
            column || vscode.ViewColumn.One,
            { enableScripts: true, localResourceRoots: [extensionUri] }
        );

        SqlWayfarerPanel.currentPanel = new SqlWayfarerPanel(panel, extensionUri, context);
    }

    async _initialize() {
        try {
            await this._connectionStorage.initialize();
            this._dependencyService.setIndexService(this._indexService);
            console.log('IndexService connected to DependencyService');
            this._update();
            this._setupEventHandlers();
            console.log('SqlWayfarerPanel initialized successfully');
        } catch (error) {
            console.error('Error initializing SqlWayfarerPanel:', error);
            vscode.window.showErrorMessage(`Failed to initialize SQL Wayfarer: ${error.message}`);
        }
    }

    _setupEventHandlers() {
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(
            async message => {
                try {
                    await this._handleMessage(message);
                } catch (error) {
                    console.error('Error handling message:', error);
                    this._panel.webview.postMessage({ command: 'error', message: `Error processing request: ${error.message}` });
                }
            },
            null,
            this._disposables
        );
    }

    async _handleMessage(message) {
        const { conn: c, db: d, comments: cm, ee, idx: ix } = {
            conn: this._conn, db: this._db, comments: this._comments, ee: this._ee, idx: this._idx
        };

        switch (message.command) {
            // Connection
            case 'connect': {
                const ok = await c.handleConnect(message.connectionConfig);
                if (ok) await d.handleGetDatabases();
                break;
            }
            case 'connectWithSaved': {
                const ok = await c.handleConnectWithSaved(message.connectionName);
                if (ok) await d.handleGetDatabases();
                break;
            }
            case 'saveConnection': {
                const ok = await c.handleSaveConnection(message.connectionConfig);
                if (ok) await c.handleLoadConnections();
                break;
            }
            case 'deleteConnection': {
                const ok = await c.handleDeleteConnection(message.connectionName);
                if (ok) await c.handleLoadConnections();
                break;
            }
            case 'loadConnections':             await c.handleLoadConnections(); break;
            case 'loadConnectionForDisplay':    await c.handleLoadConnectionForDisplay(message.connectionName); break;
            case 'testConnection':              await c.handleTestConnection(message.connectionConfig); break;

            // Database
            case 'setCurrentDatabase':          this._currentSelectedDatabase = message.database; break;
            case 'getDatabases':                await d.handleGetDatabases(); break;
            case 'getObjects':
                await d.handleGetObjects(message.database);
                if (!ix.isIndexing) ix.startBackgroundIndexing(message.database).catch(e => console.error('Background indexing setup failed:', e));
                break;
            case 'getTableDetails':             await d.handleGetTableDetails(message.database, message.table); break;
            case 'getObjectDetails':            await d.handleGetObjectDetails(message.database, message.objectName, message.objectType); break;
            case 'searchObjects':               await d.handleSearchObjects(message.database, message.searchPattern, message.objectTypes); break;
            case 'getTableRowCount':            await d.handleGetTableRowCount(message.database, message.tableName); break;
            case 'getTableSampleData':          await d.handleGetTableSampleData(message.database, message.tableName, message.limit); break;
            case 'getDependencyTree':           await d.handleGetDependencyTree(message.database, message.objectName, message.maxDepth); break;
            case 'getImpactAnalysis':           await d.handleGetImpactAnalysis(message.database, message.objectName); break;

            // Comments (extended properties)
            case 'getTableExtendedProperties':  await cm.handleGetTableExtendedProperties(message.database, message.tableName); break;
            case 'getObjectExtendedProperties': await cm.handleGetObjectExtendedProperties(message.database, message.objectName, message.objectType); break;
            case 'updateTableDescription':      await cm.handleUpdateTableDescription(message.database, message.tableName, message.description); break;
            case 'updateColumnDescription':     await cm.handleUpdateColumnDescription(message.database, message.tableName, message.columnName, message.description); break;
            case 'updateObjectDescription':     await cm.handleUpdateObjectDescription(message.database, message.objectName, message.objectType, message.description); break;
            case 'deleteTableDescription':      await cm.handleDeleteTableDescription(message.database, message.tableName); break;
            case 'deleteColumnDescription':     await cm.handleDeleteColumnDescription(message.database, message.tableName, message.columnName); break;

            // Extended Events
            case 'createExecutionFlowSession':  await ee.handleCreateExecutionFlowSession(message.database, message.sessionName, message.config); break;
            case 'startExecutionFlowSession':   await ee.handleStartExecutionFlowSession(message.sessionName); break;
            case 'stopExecutionFlowSession':    await ee.handleStopExecutionFlowSession(message.sessionName); break;
            case 'deleteExecutionFlowSession':  await ee.handleDeleteExecutionFlowSession(message.sessionName); break;
            case 'getExecutionFlowSessionInfo': await ee.handleGetExecutionFlowSessionInfo(message.sessionName); break;
            case 'listExecutionFlowSessions':   await ee.handleListExecutionFlowSessions(); break;
            case 'getRawSessionEvents':         await ee.handleGetRawSessionEvents(message.sessionName); break;

            // Indexing
            case 'forceReindex':                await ix.handleForceReindex(message.database); break;
            case 'cancelIndexing':              await ix.handleCancelIndexing(); break;
            case 'getIndexStats':               await ix.handleGetIndexStats(message.database); break;
            case 'getIndex':                    await ix.handleGetIndex(message.database); break;
            case 'confirmForceReindex':         await ix.handleConfirmForceReindex(message.database); break;

            default:
                console.warn(`Unknown command: ${message.command}`);
        }
    }

    _update() {
        this._panel.title = 'SQL Wayfarer';
        this._panel.webview.html = this._getHtmlForWebview();
    }

    _getHtmlForWebview() {
        const w = this._panel.webview;
        const u = (...p) => w.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, ...p)).toString();

        const htmlPath = path.join(this._extensionUri.fsPath, 'webview', 'index.html');
        let html = fs.readFileSync(htmlPath, 'utf8');

        html = html.replace('{{STYLES_URI}}',               u('webview', 'styles.css'));
        html = html.replace('{{COMMENTS_STYLES_URI}}',      u('webview', 'comments.css'));
        html = html.replace('{{EXTENDED_EVENTS_STYLES_URI}}', u('webview', 'extendedEvents.css'));
        html = html.replace('{{TABLE_USAGE_STYLES_URI}}',   u('webview', 'tableUsage.css'));
        html = html.replace('{{CODE_VIEW_STYLES_URI}}',     u('webview', 'codeView.css'));
        html = html.replace('{{TAB_MANAGER_URI}}',          u('webview', 'tabManager.js'));
        html = html.replace('{{CONNECTION_MANAGER_URI}}',   u('webview', 'connectionManager.js'));
        html = html.replace('{{COMMENTS_MANAGER_URI}}',     u('webview', 'commentsManager.js'));
        html = html.replace('{{EXTENDED_EVENTS_MANAGER_URI}}', u('webview', 'extendedEventsManager.js'));
        html = html.replace('{{CODE_VIEW_MANAGER_URI}}',    u('webview', 'codeViewManager.js'));
        html = html.replace('{{MAIN_SCRIPT_URI}}',          u('webview', 'main.js'));

        return html;
    }

    async dispose() {
        SqlWayfarerPanel.currentPanel = undefined;
        this._panel.dispose();

        this._idx.cancel();
        if (this._currentSelectedDatabase) {
            try {
                await this._indexService.clearIndex(this._currentSelectedDatabase);
            } catch (error) {
                console.warn('Error clearing index during disposal:', error);
            }
        }

        if (this._extendedEventsService) {
            try { await this._extendedEventsService.dispose(); } catch (error) { console.warn('Error disposing extended events service:', error); }
        }
        if (this._connectionManager) {
            try { await this._connectionManager.dispose(); } catch (error) { console.warn('Error disposing connection manager:', error); }
        }

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                try { x.dispose(); } catch (error) { console.warn('Error disposing resource:', error); }
            }
        }
    }
}

SqlWayfarerPanel.currentPanel = undefined;
module.exports = SqlWayfarerPanel;
