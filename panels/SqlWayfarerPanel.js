'use strict';

const vscode = require('vscode');
const debug = require('../database/debugLog');
const path = require('path');
const fs = require('fs');

const ConnectionManager = require('../database/ConnectionManager');
const { createVsCodeTokenFetcher } = require('../database/entraToken');
const DatabaseService = require('../database/DatabaseService');
const DependencyService = require('../database/DependencyService');
const IndexService = require('../database/IndexServices');
const CommentsService = require('../database/CommentsService');
const DataDictionaryService = require('../database/DataDictionaryService');
const ScriptGeneratorService = require('../database/ScriptGeneratorService');
const WriteFootprintService = require('../database/WriteFootprintService');
const QueryGraphService = require('../database/QueryGraphService');
const BabelfishSqlParser = require('../database/BabelfishSqlParser');
const QueryRiskAnalyzer = require('../database/QueryRiskAnalyzer');
const { SyntaxChecker } = require('../database/SyntaxChecker');

const { connectionIdentity } = require('../database/connectionIdentity');
const { readIconSprite } = require('./iconSprite');
const { readAutocompleteSettings } = require('./autocompleteSettings');
const SyntaxHandlers = require('./handlers/SyntaxHandlers');
const { isConnectionLostMessage } = require('../database/connectionLoss');

// Messages whose text can tell that the connection was lost.
const ERROR_COMMANDS = new Set(['error', 'queryError']);
// Messages that prove the server answered: a lost connection came back.
const ANSWER_COMMANDS = new Set(['queryResult', 'planResult', 'objectsLoaded', 'databasesLoaded']);
const { PanelStateStore } = require('./panelState');
const { RatingPrompt } = require('./ratingPrompt');
const ConnectionHandlers = require('./handlers/ConnectionHandlers');
const DatabaseHandlers = require('./handlers/DatabaseHandlers');
const CommentsHandlers = require('./handlers/CommentsHandlers');
const IndexHandlers = require('./handlers/IndexHandlers');
const SchemaSourceHandlers = require('./handlers/SchemaSourceHandlers');
const ConnectionRouter = require('../database/ConnectionRouter');
const QueryHandlers = require('./handlers/QueryHandlers');
const InstanceHandlers = require('./handlers/InstanceHandlers');
const CompareHandlers = require('./handlers/CompareHandlers');
const RecentHandlers = require('./handlers/RecentHandlers');
const QueryFileHandlers = require('./handlers/QueryFileHandlers');
const ExportHandlers = require('./handlers/ExportHandlers');
const ScriptHandlers = require('./handlers/ScriptHandlers');
const FootprintHandlers = require('./handlers/FootprintHandlers');
const QueryGraphHandlers = require('./handlers/QueryGraphHandlers');
const SnippetHandlers = require('./handlers/SnippetHandlers');

class SqlWayfarerPanel {
    // connectionStorage: the extension-wide one (the connections are managed
    // from the sidebar). connectionName: the saved connection this tab is
    // opened for - a tab never changes connection.
    constructor(panel, extensionUri, context, panelRegistry, connectionStorage, connectionName) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._context = context;
        this._disposables = [];
        this._currentSelectedDatabase = null;
        // Which tab of the panel (query / explorer) is open.
        // Mirrors the webview, and is restored with the database when the
        // page is rebuilt - see PanelStateStore.
        this._activeTab = null;
        // Tab to restore on the next database list, set when the page was
        // just rebuilt (see _restorePanelState).
        this._pendingTabRestore = null;
        // True between the webview reporting a fresh page and the next
        // connection: only then is the open tab worth restoring.
        this._pageFresh = false;
        // Set when the panel is disposed, so the async initialization can
        // bail out instead of touching a disposed webview.
        this._disposed = false;
        // Set once a connect succeeds (see ConnectionHandlers) - null while
        // disconnected. Used to refuse a second tab on the same server+login
        // (PanelRegistry.findByConnectionIdentity) and to scope this panel's
        // query history / draft recovery to "whichever connection is active".
        this.connectionIdentity = null;
        // Human-readable form of the above (saved connection name, or the
        // server address for an unsaved ad-hoc connection) - shown in the
        // VS Code tab title so several open tabs can be told apart.
        this.connectionLabel = connectionName;
        // Name of the saved connection this tab was opened for (see
        // PanelRegistry.findByConnectionName).
        this.connectionName = connectionName;
        // Known from the start, not once connected: a second click on a
        // connection of the same server + login, while this tab is still
        // connecting, must find this tab instead of opening a doomed second
        // one (see ConnectionLauncher.open).
        const saved = connectionStorage.getConnection(connectionName);
        this.connectionIdentity = saved ? connectionIdentity(saved) : null;
        // True while a connection attempt is running, so a double click on
        // Retry does not start two.
        this._connecting = false;
        // Set when an error says the connection is gone, until the server
        // answers again (or the tab reconnects): the webview is told once.
        this._connectionLost = false;
        this._panelRegistry = panelRegistry;
        this._panelRegistry.register(this);

        this._connectionStorage = connectionStorage;
        this._connectionManager = new ConnectionManager(
            this._connectionStorage,
            createVsCodeTokenFetcher(vscode),
            path.join(this._extensionUri.fsPath, 'helper', 'SqlWayfarerSspi.exe')
        );
        this._panelState = new PanelStateStore(context.workspaceState);
        // Asks the user, every now and then, to rate the extension: the
        // Marketplace shows the rating right in the search results.
        this._ratingPrompt = new RatingPrompt(context);
        // The schema (Explorer, index, autocompletion, comments, dictionary,
        // footprint) is read through a router: it follows the run connection
        // unless the user plugs the schema on another saved connection, say a
        // development copy while the queries run on production.
        this._schemaRouter = new ConnectionRouter(this._connectionManager);
        this._databaseService = new DatabaseService(this._schemaRouter);
        this._targetDatabaseService = new DatabaseService(this._connectionManager);
        this._indexService = new IndexService(this._schemaRouter, this._databaseService);
        this._dependencyService = new DependencyService();
        this._commentsService = new CommentsService(this._schemaRouter);
        this._dataDictionaryService = new DataDictionaryService(this._schemaRouter, this._indexService);
        this._writeFootprintService = new WriteFootprintService(this._schemaRouter, this._indexService, this._databaseService);
        this._queryGraphService = new QueryGraphService(this._schemaRouter, this._indexService, this._databaseService);

        const post = msg => this.post(msg);
        const getDb = () => this._currentSelectedDatabase;
        const getConnectionIdentity = () => this.connectionIdentity;
        const broadcast = msg => this._panelRegistry.broadcast(msg);
        // Handed to ConnectionHandlers so it can refuse connecting to a
        // server+login another open tab already has, and reveal that tab
        // instead - see PanelRegistry.findByConnectionIdentity.
        const panelController = {
            findDuplicate: identity => this._panelRegistry.findByConnectionIdentity(identity, this),
            reveal: panel => panel.reveal(),
            // Shown as a VS Code notification: the refused tab's own status
            // line is easy to miss, and the focus has just moved to the
            // other tab.
            notify: message => vscode.window.showInformationMessage(message),
            onConnectionChanged: (identity, label) => this._onConnectionChanged(identity, label)
        };

        this._conn = new ConnectionHandlers(post, this._connectionManager, this._connectionStorage, panelController);
        this._db = new DatabaseHandlers(post, this._databaseService, this._dependencyService, this._indexService, getDb);
        this._comments = new CommentsHandlers(post, this._commentsService);
        this._idx = new IndexHandlers(post, this._indexService, this._dependencyService, getDb);
        const riskParser = new BabelfishSqlParser();
        riskParser.setEnabled(true);
        this._query = new QueryHandlers(post, this._connectionManager, context.workspaceState, new QueryRiskAnalyzer(riskParser), getConnectionIdentity, () => this._ratingPrompt.onQuerySucceeded(), () => this._isProduction());
        this._queryFiles = new QueryFileHandlers(post, context.workspaceState, getConnectionIdentity);
        this._export = new ExportHandlers(post, this._dataDictionaryService);
        this._script = new ScriptHandlers(post, new ScriptGeneratorService(this._schemaRouter, this._databaseService));
        // The instance tree is always the connection the queries run on - never a schema source -
        // since what it deletes or renames is done there.
        this._instanceScript = new ScriptHandlers(post, new ScriptGeneratorService(this._connectionManager, this._targetDatabaseService));
        this._recent = new RecentHandlers(post, { connectionManager: this._connectionManager });
        this._compare = new CompareHandlers(post, {
            connectionManager: this._connectionManager,
            connectionStorage: this._connectionStorage,
            getOwnName: () => this.connectionName,
            createManager: () => new ConnectionManager(
                this._connectionStorage,
                createVsCodeTokenFetcher(vscode),
                path.join(this._extensionUri.fsPath, 'helper', 'SqlWayfarerSspi.exe')
            ),
            confirm: async (message, detail, action) => (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action
        });
        this._instance = new InstanceHandlers(post, {
            databaseService: this._targetDatabaseService,
            connectionManager: this._connectionManager,
            query: this._query,
            ask: async (prompt, value, validateInput) => vscode.window.showInputBox({ prompt, value, validateInput }),
            confirm: async (message, detail, action) => (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action
        });
        this._footprint = new FootprintHandlers(post, this._writeFootprintService, this._dataDictionaryService, getDb);
        this._queryGraph = new QueryGraphHandlers(post, this._queryGraphService, getDb);
        this._snippets = new SnippetHandlers(post, context.globalState, broadcast);
        this._schemaSource = new SchemaSourceHandlers(post, {
            router: this._schemaRouter,
            createManager: () => new ConnectionManager(
                this._connectionStorage,
                createVsCodeTokenFetcher(vscode),
                path.join(this._extensionUri.fsPath, 'helper', 'SqlWayfarerSspi.exe')
            ),
            connectionStorage: this._connectionStorage,
            targetDatabaseService: this._targetDatabaseService,
            getOwnName: () => this.connectionName,
            onChanged: (name, restoring) => this._onSchemaSourceChanged(name, restoring)
        });

        // Syntax check of the query editor (off unless sqlwayfarer.diagnostics.syntax is set):
        // SQL Server parses the text on a connection of its own.
        this._syntax = new SyntaxHandlers(post, new SyntaxChecker({
            createManager: () => new ConnectionManager(
                this._connectionStorage,
                createVsCodeTokenFetcher(vscode),
                path.join(this._extensionUri.fsPath, 'helper', 'SqlWayfarerSspi.exe')
            ),
            getConnectionName: () => this.connectionName
        }), () => vscode.workspace.getConfiguration('sqlwayfarer.diagnostics').get('syntax', false) === true);

        // The page goes up straight away - the webview shows a loading
        // overlay until it is ready (see index.html), so there is no blank
        // screen and no second page load to swap in.
        this._setupEventHandlers();
        this._update();

        this._initialize();
        // The sidebar shows which connections have a tab.
        this._panelRegistry.notifyOpenConnectionsChanged();
    }

    // One call = one new tab, each with its own independent connection -
    // unlike the single-panel-reused-forever design this replaced, there is
    // no "reveal the existing one" shortcut here; PanelRegistry is what lets
    // these multiple instances still coordinate (shared snippets, no two
    // tabs on the same connection) without being a singleton themselves.
    static createOrShow(extensionUri, context, panelRegistry, connectionStorage, connectionName) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        const panel = vscode.window.createWebviewPanel(
            'sqlwayfarer-sqlwayfarer',
            'SQL Wayfarer',
            column || vscode.ViewColumn.One,
            // enableFindWidget: native Ctrl+F over all rendered content
            // (code definitions, query results, object lists).
            // retainContextWhenHidden: without it, VS Code tears the webview
            // down every time the tab is hidden and rebuilds it on the way
            // back - re-parsing ~3 MB of vendored scripts and re-running
            // every request, with a black screen in between. Keeping the
            // context also preserves the tab's state (selected database,
            // open queries, filters), which was lost on every switch.
            { enableScripts: true, localResourceRoots: [extensionUri], enableFindWidget: true, retainContextWhenHidden: true }
        );

        return new SqlWayfarerPanel(panel, extensionUri, context, panelRegistry, connectionStorage, connectionName);
    }

    post(message) {
        // A connection attempt or a query can end after the tab was closed.
        if (this._disposed) return;
        // The webview rebuilds the database list from scratch when it gets
        // this message, which wipes the selected database - so the panel's
        // own state travels with it and the webview puts the selection back.
        if (message.command === 'databasesLoaded') {
            message.currentDatabase = this._currentSelectedDatabase;
            message.activeTab = this._pendingTabRestore;
            this._pendingTabRestore = null;
        }
        this._panel.webview.postMessage(message);
        this._watchConnection(message);
    }

    // The tab learns that the connection died from the errors that come back
    // (a query, the object list...), and that it lives again from the answers.
    _watchConnection(message) {
        if (!this._connectionLost && ERROR_COMMANDS.has(message.command) && isConnectionLostMessage(message.message)) {
            this._connectionLost = true;
            this._panel.webview.postMessage({ command: 'connectionLost', message: 'The connection to the server was lost.' });
        } else if (this._connectionLost && ANSWER_COMMANDS.has(message.command)) {
            this._connectionLost = false;
            this._panel.webview.postMessage({ command: 'connectionRecovered' });
        }
    }

    reveal() {
        this._panel.reveal();
    }

    // Another saved connection of the same server + login was opened: this
    // tab serves both, so it moves to that connection's database.
    selectDatabase(database) {
        if (!database) return;
        // Set before anything is sent: a tab still connecting picks it up
        // with its list of databases.
        this._currentSelectedDatabase = database;
        this._persistPanelState({ database });
        this.post({ command: 'selectDatabase', database });
    }

    // Read from the saved connection each time, so marking it (or not) from
    // the sidebar counts for the next query without reconnecting.
    _isProduction() {
        const saved = this._connectionStorage.getConnection(this.connectionName);
        return !!(saved && saved.production);
    }

    // The saved connection of this tab was renamed (from the sidebar).
    renameConnection(newName) {
        this.connectionName = newName;
        this.connectionLabel = newName;
        this._updateTitle();
    }

    // Called after a successful connect. What the panel remembers (selected
    // database, open tab) belongs to one connection: when this tab connects
    // to another server, what was in memory belonged to the previous one -
    // save it under its own identity and start the new connection clean.
    _onConnectionChanged(identity, label) {
        if (this.connectionIdentity !== identity) {
            this._persistPanelState({ database: this._currentSelectedDatabase, tab: this._activeTab });
            this.connectionIdentity = identity;
            this._currentSelectedDatabase = null;
            this._activeTab = null;
        }
        this._restorePanelState();
        this.connectionLabel = label || null;
        this._updateTitle();
        this._queryFiles.maybeOfferRecoveryForCurrentIdentity();
    }

    // Restores what this connection was showing. The database is data, not
    // a UI mode: reconnecting to a server puts you back on the database you
    // were working in. The open tab is only restored when the page was just
    // rebuilt (the user came back to the tab) - a connection the user just
    // opened still starts on Query, as before.
    _restorePanelState() {
        const state = this._panelState.get(this.connectionIdentity);
        if (!this._currentSelectedDatabase && state && state.database) {
            this._currentSelectedDatabase = state.database;
        }
        if (this._pageFresh) {
            this._pageFresh = false;
            // 'configuration' was the connection form, which no longer exists.
            this._activeTab = (state && state.tab !== 'configuration' && state.tab) || null;
            this._pendingTabRestore = this._activeTab;
        }
    }

    // Saves part of the panel state for the current connection. Only the
    // given fields are written: the webview tells us about the database and
    // the tab separately, and one must not wipe the other.
    _persistPanelState(patch) {
        if (!this.connectionIdentity) return;
        this._panelState.set(this.connectionIdentity, patch).catch(error => {
            console.warn('Could not persist the panel state:', error.message);
        });
    }

    async _initialize() {
        try {
            this._dependencyService.setIndexService(this._indexService);
            this._dependencyService.setConnectionManager(this._schemaRouter);
            // Needed to resolve the type of objects living in another database
            // (cross-database dependencies in the Explorer graph).
            this._dependencyService.setDatabaseService(this._databaseService);
            debug('IndexService connected to DependencyService');
            debug('SqlWayfarerPanel initialized successfully');
        } catch (error) {
            console.error('Error initializing SqlWayfarerPanel:', error);
            vscode.window.showErrorMessage(`Failed to initialize SQL Wayfarer: ${error.message}`);
        }
    }

    // Connects this tab to its saved connection - once the page is up, and
    // again on Retry. A page rebuilt while the connection is still alive just
    // gets the status again.
    async _connect() {
        if (this._connecting || this._disposed) return;
        this._connecting = true;
        try {
            await this._connectNow();
        } finally {
            this._connecting = false;
        }
    }

    // The connection itself, without the guard: _reconnect() holds it while
    // it resets the tab, then calls this.
    async _connectNow() {
        if (this._connectionManager.isConnected()) {
            this._restorePanelState();
            this.post({ command: 'connectionStatus', success: true, message: 'Connected successfully!', production: this._isProduction() });
            await this._restoreSchemaSource();
            await this._db.handleGetDatabases();
            return;
        }
        // A connection saved with a database opens on it.
        const saved = this._connectionStorage.getConnection(this.connectionName);
        if (saved && saved.database) this._currentSelectedDatabase = saved.database;
        const ok = await this._conn.handleConnectWithSaved(this.connectionName);
        if (ok) {
            await this._restoreSchemaSource();
            await this._db.handleGetDatabases();
        }
    }

    // The schema source this tab had (kept with its panel state) is connected again.
    async _restoreSchemaSource() {
        const state = this._panelState.get(this.connectionIdentity);
        if (state && state.schemaSource) await this._schemaSource.restore(state.schemaSource);
    }

    // The schema now comes from another connection (or is back on the run one):
    // what was selected and indexed belonged to the previous source.
    _onSchemaSourceChanged(name, restoring = false) {
        this._indexService.requestCancelAll();
        if (restoring) return; // the stored database is kept, the caller lists the databases
        this._currentSelectedDatabase = null;
        this._persistPanelState({ database: null, schemaSource: name });
        this._db.handleGetDatabases();
    }

    async _reconnect() {
        if (this._connecting || this._disposed) return;
        this._connecting = true;
        try {
            this._connectionLost = false;
            try { await this._connectionManager.dispose(); } catch (error) { console.warn('Error closing the lost connection:', error); }
            await this._schemaSource.reset();
            await this._syntax.reset();
            await this._query.resetSession();
            await this._compare.reset();
            await this._connectNow();
        } finally {
            this._connecting = false;
        }
    }

    // The query editor's autocompletion follows the sqlwayfarer.autocomplete.* settings, live.
    _postAutocompleteSettings() {
        this.post({ command: 'autocompleteSettings', settings: readAutocompleteSettings(vscode.workspace.getConfiguration('sqlwayfarer.autocomplete')) });
    }

    _postDiagnosticsSettings() {
        const syntax = vscode.workspace.getConfiguration('sqlwayfarer.diagnostics').get('syntax', false) === true;
        // Off: the connection of the check is closed, not kept for nothing.
        if (!syntax) this._syntax.reset().catch(() => {});
        this.post({ command: 'diagnosticsSettings', syntax });
    }

    _setupEventHandlers() {
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('sqlwayfarer.autocomplete')) this._postAutocompleteSettings();
            if (event.affectsConfiguration('sqlwayfarer.diagnostics')) this._postDiagnosticsSettings();
        }));
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
        const { db: d, comments: cm, idx: ix, query: q, queryFiles: qf } = {
            db: this._db, comments: this._comments, idx: this._idx, query: this._query, queryFiles: this._queryFiles
        };

        switch (message.command) {
            // Connection
            // The "Retry" of a tab whose connection failed.
            case 'retryConnection':             await this._connect(); break;
            // The "Reconnect" of a connection that was lost: a new connection to
            // the same server, the tab itself (queries, selected database) stays.
            case 'reconnect':                   await this._reconnect(); break;

            // Where the schema is read from (see SchemaSourceHandlers)
            case 'getSchemaSources':            this._schemaSource.handleGetSchemaSources(); break;
            case 'selectSchemaSource':          await this._schemaSource.handleSelectSchemaSource(message.name); break;
            case 'getQueryDatabases':           await this._schemaSource.handleGetQueryDatabases(); break;

            // Database
            case 'setCurrentDatabase':
                // A sync reply (the extension asked which database is
                // selected) must not wipe what we remember: a page that was
                // just rebuilt starts with no selection and would answer
                // "none", which would throw away the restored database.
                if (message.sync && !message.database) break;
                this._currentSelectedDatabase = message.database || null;
                this._persistPanelState({ database: this._currentSelectedDatabase });
                break;
            // Which tab of the panel is open - kept so a rebuilt page comes
            // back on the same tab.
            case 'setActiveTab':
                // While a restore is pending, the webview is about to be
                // moved to the restored tab: its intermediate tab (the
                // automatic switch to Query on connect) must not overwrite
                // what we are about to restore.
                if (this._pendingTabRestore) break;
                this._activeTab = message.tab || null;
                this._persistPanelState({ tab: this._activeTab });
                break;
            // The webview page was just built: the panel can restore what
            // this tab was showing instead of starting from scratch.
            case 'panelReady':
                this._pageFresh = true;
                await this._connect();
                break;
            case 'getDatabases':                await d.handleGetDatabases(); break;
            // The dependency index is never built on its own: only on the
            // user's request ('getIndex' below, from the Explorer notice).
            case 'getObjects':                  await d.handleGetObjects(message.database); break;
            case 'getTableDetails':             await d.handleGetTableDetails(message.database, message.table); break;
            case 'getColumnUsage':              await d.handleGetColumnUsage(message.database, message.table); break;
            case 'getObjectDetails':            await d.handleGetObjectDetails(message.database, message.objectName, message.objectType); break;
            case 'getObjectDetailsAuto':         await d.handleGetObjectDetailsAuto(message.database, message.objectName); break;
            case 'searchObjects':               await d.handleSearchObjects(message.database, message.searchPattern, message.objectTypes); break;
            case 'getTableRowCount':            await d.handleGetTableRowCount(message.database, message.tableName); break;
            case 'getTableSampleData':          await d.handleGetTableSampleData(message.database, message.tableName, message.limit); break;
            case 'getObjectColumns':            await d.handleGetObjectColumns(message.database, message.objectName); break;
            case 'getObjectParameters':          await d.handleGetObjectParameters(message.database, message.objectName); break;
            case 'getAutocompleteSettings':      this._postAutocompleteSettings(); this._postDiagnosticsSettings(); break;
            case 'endTransaction':               await this._query.handleEndTransaction(message.action); break;
            case 'getRecentChanges':             await this._recent.handleGetRecent(message.database, message.minutes); break;
            case 'getRecentDefinition':          await this._recent.handleGetDefinition(message.database, message.schema, message.name); break;
            case 'getCompareSources':            await this._compare.handleGetSources(message.database); break;
            case 'runCompare':                   await this._compare.handleCompare(message.database, message.reference); break;
            case 'buildCompareScript':           this._compare.handleBuildScript(message.ids, message.allowDestructive, message.legacy); break;
            case 'takeSnapshot':                 await this._compare.handleTakeSnapshot(message.database); break;
            case 'dropSnapshot':                 await this._compare.handleDropSnapshot(message.database, message.name); break;
            case 'getCompareTargets':            this._compare.handleGetTargets(); break;
            case 'getCompareTargetDatabases':    await this._compare.handleGetTargetDatabases(message.connection); break;
            case 'getCompareTargetStatus':       await this._compare.handleTargetStatus(message.ids, message.allowDestructive, message.legacy, message.connection, message.database); break;
            case 'applyCompare':                 await this._compare.handleApply(message.ids, message.allowDestructive, message.legacy, message.connection, message.database); break;
            case 'cancelApplyCompare':           this._compare.handleCancelApply(); break;
            case 'getInstanceDatabases':         await this._instance.handleGetInstanceDatabases(); break;
            case 'getInstanceObjects':           await this._instance.handleGetInstanceObjects(message.database); break;
            case 'renameInstanceObject':         await this._instance.handleRename(message.database, message.schema, message.name, message.objectType); break;
            case 'dropInstanceObject':           await this._instance.handleDrop(message.database, message.schema, message.name, message.objectType); break;
            case 'generateInstanceScript':       await this._instanceScript.handleGenerateScript(message.database, message.objectName, message.objectType, message.scriptType, false, true); break;
            case 'checkSyntax':                  await this._syntax.handleCheckSyntax(message.requestId, message.text); break;
            case 'getAutocompleteObjects':       await d.handleGetAutocompleteObjects(message.database); break;
            case 'getForeignKeys':               await d.handleGetForeignKeys(message.database); break;
            case 'searchDefinitions':           await d.handleSearchDefinitions(message.database, message.searchText); break;
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

            // Indexing
            case 'forceReindex':                await ix.handleForceReindex(message.database); break;
            case 'cancelIndexing':              await ix.handleCancelIndexing(message.database); break;
            case 'getIndexStats':               await ix.handleGetIndexStats(message.database); break;
            case 'getIndexStatus':              await ix.handleGetIndexStatus(message.database); break;
            case 'getBuildStats':               await ix.handleGetBuildStats(message.database); break;
            case 'loadIndex':                   await ix.handleLoadIndex(message.database); break;
            case 'getIndex':                    await ix.handleGetIndex(message.database); break;
            case 'confirmForceReindex':         await ix.handleConfirmForceReindex(message.database); break;

            // Query tool
            case 'executeQuery':                await q.handleExecuteQuery(message.database, message.query, message.maxRows); break;
            case 'getEstimatedPlan':            await q.handleGetEstimatedPlan(message.database, message.query); break;
            case 'getActualPlan':               await q.handleGetActualPlan(message.database, message.query, message.maxRows); break;
            case 'cancelQuery':                 q.handleCancelQuery(); break;
            case 'getQueryHistory':             await q.handleGetQueryHistory(); break;
            case 'clearQueryHistory':           await q.handleClearQueryHistory(); break;

            // Query tool - file-backed tabs
            case 'listSqlFiles':                await qf.handleListSqlFiles(); break;
            case 'openSqlFile':                  await qf.handleOpenSqlFile(message.path); break;
            case 'saveSqlFile':                  await qf.handleSaveSqlFile(message.path, message.content); break;
            case 'saveSqlFileAs':                await qf.handleSaveSqlFileAs(message.content, message.suggestedName); break;
            case 'getDraftRecovery':            await qf.handleGetDraftRecovery(); break;
            case 'saveDraftRecovery':           qf.handleSaveDraftRecovery(message.drafts); break;
            case 'confirmDiscardChanges':       await qf.handleConfirmDiscardChanges(message.name); break;

            // SQL snippets
            case 'getSnippets':                 await this._snippets.handleGetSnippets(); break;
            case 'addSnippet':                  await this._snippets.handleAddSnippet(message.name, message.sql); break;
            case 'updateSnippet':               await this._snippets.handleUpdateSnippet(message.oldName, message.newName, message.sql); break;
            case 'deleteSnippet':               await this._snippets.handleDeleteSnippet(message.name); break;
            case 'promptSnippetName':           await this._snippets.handlePromptSnippetName(); break;
            case 'promptDeleteSnippet':         await this._snippets.handlePromptDeleteSnippet(); break;

            // Script generator
            case 'generateScript':              await this._script.handleGenerateScript(message.database, message.objectName, message.objectType, message.scriptType, message.preview); break;

            // Write footprint (tables read/written by an object, trigger cascades included)
            case 'getWriteFootprint':           await this._footprint.handleGetWriteFootprint(message.database, message.objectName); break;
            case 'getFootprintDoc':             await this._footprint.handleGetFootprintDoc(message.database, message.tableNames); break;

            // Query graph (tables read by the editor's SQL, and how they join)
            case 'getQueryGraph':                await this._queryGraph.handleGetQueryGraph(message.database, message.sql); break;

            // Export
            case 'exportDataDictionary':        await this._export.handleExportDataDictionary(message.database, message.full); break;
            case 'exportCsv':                   await this._export.handleExportCsv(message.csv, message.defaultName); break;
            case 'exportJson':                  await this._export.handleExportJson(message.json, message.defaultName); break;

            default:
                console.warn(`Unknown command: ${message.command}`);
        }
    }

    _update() {
        this._updateTitle();
        this._panel.webview.html = this._getHtmlForWebview();
    }

    _updateTitle() {
        this._panel.title = this.connectionLabel ? `SQL Wayfarer — ${this.connectionLabel}` : 'SQL Wayfarer';
    }

    _getHtmlForWebview() {
        const w = this._panel.webview;
        const u = (...p) => w.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, ...p)).toString();

        const htmlPath = path.join(this._extensionUri.fsPath, 'webview', 'index.html');
        let html = fs.readFileSync(htmlPath, 'utf8');

        html = html.replace('{{ICON_SPRITE}}', () => readIconSprite(this._extensionUri.fsPath));
        html = html.replace(/\{\{CSP_SOURCE\}\}/g, w.cspSource);
        html = html.replace('{{CODICON_STYLES_URI}}',       u('webview', 'codicons', 'codicon.css'));
        html = html.replace('{{STYLES_URI}}',               u('webview', 'styles.css'));
        html = html.replace('{{COMMENTS_STYLES_URI}}',      u('webview', 'comments.css'));
        html = html.replace('{{CODE_VIEW_STYLES_URI}}',     u('webview', 'codeView.css'));
        html = html.replace('{{QUERY_PLAN_STYLES_URI}}',    u('webview', 'vendor', 'html-query-plan', 'qp.css'));
        html = html.replace('{{APP_STATE_URI}}',          u('webview', 'appState.js'));
        html = html.replace('{{ICONS_URI}}',                u('webview', 'icons.js'));
        html = html.replace('{{TAB_MANAGER_URI}}',          u('webview', 'tabManager.js'));
        html = html.replace('{{CONNECTION_STATUS_URI}}',    u('webview', 'connectionStatus.js'));
        html = html.replace('{{COMMENTS_MANAGER_URI}}',     u('webview', 'commentsManager.js'));
        html = html.replace('{{CODE_VIEW_MANAGER_URI}}',    u('webview', 'codeViewManager.js'));
        html = html.replace('{{BUILTIN_SNIPPETS_URI}}',      u('webview', 'builtinSnippets.js'));
        html = html.replace('{{SQL_MATCHER_URI}}',          u('webview', 'sqlMatcher.js'));
        html = html.replace('{{SQL_CONTEXT_URI}}',          u('webview', 'sqlContext.js'));
        html = html.replace('{{SQL_AUTOCOMPLETE_URI}}',     u('webview', 'sqlAutocomplete.js'));
        html = html.replace('{{SQL_EDITOR_URI}}',           u('dist', 'webview', 'sqlEditor.js'));
        html = html.replace('{{TEMP_TABLE_SCRIPT_URI}}',    u('webview', 'tempTableScript.js'));
        html = html.replace('{{QUERY_MANAGER_URI}}',        u('webview', 'queryManager.js'));
        html = html.replace('{{FILE_TREE_URI}}',            u('webview', 'fileTree.js'));
        html = html.replace('{{QUERY_FILE_MANAGER_URI}}',   u('webview', 'queryFileManager.js'));
        html = html.replace('{{INSTANCE_TREE_URI}}',        u('webview', 'instanceTree.js'));
        html = html.replace('{{LINE_DIFF_URI}}',            u('webview', 'lineDiff.js'));
        html = html.replace('{{COMPARE_MANAGER_URI}}',      u('webview', 'compareManager.js'));
        html = html.replace('{{RECENT_CHANGES_URI}}',       u('webview', 'recentChanges.js'));
        html = html.replace('{{FOOTPRINT_MANAGER_URI}}',    u('webview', 'footprintManager.js'));
        html = html.replace('{{INDEX_STATS_VIEW_URI}}',     u('webview', 'indexStatsView.js'));
        html = html.replace('{{SCHEMA_SOURCE_MANAGER_URI}}', u('webview', 'schemaSourceManager.js'));
        html = html.replace('{{OBJECTS_TAB_MANAGER_URI}}', u('webview', 'objectsTabManager.js'));
        html = html.replace('{{VIZ_URI}}',                   u('webview', 'vendor', 'viz.js'));
        html = html.replace('{{VIZ_RENDER_URI}}',            u('webview', 'vendor', 'viz.full.render.js'));
        html = html.replace('{{GRAPH_LIBS_URI}}',           u('dist', 'webview', 'graphLibs.js'));
        html = html.replace('{{QUERY_PLAN_URI}}',           u('webview', 'vendor', 'html-query-plan', 'qp.min.js'));
        html = html.replace('{{MAIN_SCRIPT_URI}}',          u('webview', 'main.js'));

        return html;
    }

    // A transaction a script left open is never ended silently: the user
    // chooses, and dismissing the question rolls it back (what the server does
    // anyway when the connection goes away). The question is modal: a
    // notification left unanswered would keep the locks for as long as it sits
    // in the notification center.
    async _closeQuerySession() {
        let action = 'rollback';
        try {
            if (await this._query.openTransactions() > 0) {
                const answer = await vscode.window.showWarningMessage(
                    `A transaction is still open on ${this._connectionManager.getServerName ? this._connectionManager.getServerName() : 'the server'}.`,
                    { modal: true, detail: 'It is rolled back unless you commit it.' },
                    'Commit', 'Roll back'
                );
                if (answer === 'Commit') action = 'commit';
            }
        } catch (error) {
            console.warn('Error checking the open transaction:', error);
        }
        try { await this._query.closeSession(action); } catch (error) { console.warn('Error closing the query session:', error); }
    }

    async dispose() {
        this._disposed = true;
        this._panelRegistry.unregister(this);
        this._panelRegistry.notifyOpenConnectionsChanged();
        this._panel.dispose();

        this._idx.cancel();
        this._schemaSource.dispose().catch(() => {});
        this._syntax.reset().catch(() => {});
        this._compare.dispose().catch(() => {});
        // NB: do NOT clear the index here. It is a persistent, checksum-validated
        // on-disk cache keyed by server+database — deleting it when the panel
        // closes forces a full rebuild on every reopen (crippling on large
        // databases). Staleness is handled by the schema checksum on next open.

        if (this._indexService) {
            try { await this._indexService.dispose(); } catch (error) { console.warn('Error disposing index service:', error); }
        }

        // After the other cleanups, which must not wait for the user's answer.
        await this._closeQuerySession();

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

module.exports = SqlWayfarerPanel;
