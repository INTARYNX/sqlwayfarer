'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const ConnectionStorage = require('../storage/ConnectionStorage');
const ConnectionManager = require('../database/ConnectionManager');
const DatabaseService = require('../database/DatabaseService');
const DependencyService = require('../database/DependencyService');
const IndexService = require('../database/IndexServices');
const CommentsService = require('../database/CommentsService');
const DataDictionaryService = require('../database/DataDictionaryService');
const ScriptGeneratorService = require('../database/ScriptGeneratorService');
const WriteFootprintService = require('../database/WriteFootprintService');
const BabelfishSqlParser = require('../database/BabelfishSqlParser');
const QueryRiskAnalyzer = require('../database/QueryRiskAnalyzer');

const { PanelStateStore } = require('./panelState');
const { RatingPrompt } = require('./ratingPrompt');
const ConnectionHandlers = require('./handlers/ConnectionHandlers');
const DatabaseHandlers = require('./handlers/DatabaseHandlers');
const CommentsHandlers = require('./handlers/CommentsHandlers');
const IndexHandlers = require('./handlers/IndexHandlers');
const QueryHandlers = require('./handlers/QueryHandlers');
const QueryFileHandlers = require('./handlers/QueryFileHandlers');
const ExportHandlers = require('./handlers/ExportHandlers');
const ScriptHandlers = require('./handlers/ScriptHandlers');
const FootprintHandlers = require('./handlers/FootprintHandlers');
const SnippetHandlers = require('./handlers/SnippetHandlers');

class SqlWayfarerPanel {
    constructor(panel, extensionUri, context, panelRegistry) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._context = context;
        this._disposables = [];
        this._currentSelectedDatabase = null;
        // Which tab of the panel (configuration / query / explorer) is open.
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
        this.connectionLabel = null;
        this._panelRegistry = panelRegistry;
        this._panelRegistry.register(this);

        // Resolved once the connection storage is readable. The webview asks
        // for the saved connections as soon as its page loads, which now
        // happens before the storage has been read - so the handler waits
        // for this instead of answering with an empty list.
        this._readyPromise = new Promise(resolve => { this._resolveReady = resolve; });

        this._connectionStorage = new ConnectionStorage(context);
        this._connectionManager = new ConnectionManager(this._connectionStorage);
        this._panelState = new PanelStateStore(context.workspaceState);
        // Asks the user, every now and then, to rate the extension: the
        // Marketplace shows the rating right in the search results.
        this._ratingPrompt = new RatingPrompt(context);
        this._databaseService = new DatabaseService(this._connectionManager);
        this._indexService = new IndexService(this._connectionManager, this._databaseService);
        this._dependencyService = new DependencyService();
        this._commentsService = new CommentsService(this._connectionManager);
        this._dataDictionaryService = new DataDictionaryService(this._connectionManager, this._indexService);
        this._writeFootprintService = new WriteFootprintService(this._connectionManager, this._indexService, this._databaseService);

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

        this._conn = new ConnectionHandlers(post, this._connectionManager, this._connectionStorage, panelController, () => this._readyPromise);
        this._db = new DatabaseHandlers(post, this._databaseService, this._dependencyService, this._indexService, getDb);
        this._comments = new CommentsHandlers(post, this._commentsService);
        this._idx = new IndexHandlers(post, this._indexService, this._dependencyService, getDb);
        const riskParser = new BabelfishSqlParser();
        riskParser.setEnabled(true);
        this._query = new QueryHandlers(post, this._connectionManager, context.workspaceState, new QueryRiskAnalyzer(riskParser), getConnectionIdentity, () => this._ratingPrompt.onQuerySucceeded());
        this._queryFiles = new QueryFileHandlers(post, context.workspaceState, getConnectionIdentity);
        this._export = new ExportHandlers(post, this._dataDictionaryService);
        this._script = new ScriptHandlers(post, new ScriptGeneratorService(this._connectionManager, this._databaseService));
        this._footprint = new FootprintHandlers(post, this._writeFootprintService, this._dataDictionaryService, getDb);
        this._snippets = new SnippetHandlers(post, context.globalState, broadcast);

        // The page goes up straight away - the webview shows a loading
        // overlay until it is ready (see index.html), so there is no blank
        // screen and no second page load to swap in.
        this._setupEventHandlers();
        this._update();

        this._initialize();
    }

    // One call = one new tab, each with its own independent connection -
    // unlike the single-panel-reused-forever design this replaced, there is
    // no "reveal the existing one" shortcut here; PanelRegistry is what lets
    // these multiple instances still coordinate (shared snippets, no two
    // tabs on the same connection) without being a singleton themselves.
    static createOrShow(extensionUri, context, panelRegistry) {
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

        return new SqlWayfarerPanel(panel, extensionUri, context, panelRegistry);
    }

    post(message) {
        // The webview rebuilds the database list from scratch when it gets
        // this message, which wipes the selected database - so the panel's
        // own state travels with it and the webview puts the selection back.
        if (message.command === 'databasesLoaded') {
            message.currentDatabase = this._currentSelectedDatabase;
            message.activeTab = this._pendingTabRestore;
            this._pendingTabRestore = null;
        }
        this._panel.webview.postMessage(message);
    }

    reveal() {
        this._panel.reveal();
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
            this._activeTab = (state && state.tab) || null;
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
            await this._connectionStorage.initialize();
            // Release the waiters first: whoever asked for the saved
            // connections must get an answer even if the panel is on its way
            // out.
            this._resolveReady();
            if (this._disposed) return;
            this._dependencyService.setIndexService(this._indexService);
            this._dependencyService.setConnectionManager(this._connectionManager);
            console.log('IndexService connected to DependencyService');
            console.log('SqlWayfarerPanel initialized successfully');
        } catch (error) {
            console.error('Error initializing SqlWayfarerPanel:', error);
            // Release the waiters even on failure - the webview must get an
            // answer (an empty one) rather than hang on the loading overlay.
            this._resolveReady();
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
        const { conn: c, db: d, comments: cm, idx: ix, query: q, queryFiles: qf } = {
            conn: this._conn, db: this._db, comments: this._comments, idx: this._idx, query: this._query, queryFiles: this._queryFiles
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
                const ok = await c.handleSaveConnection(message.connectionConfig, message.originalName);
                if (ok) await c.handleLoadConnections();
                break;
            }
            case 'deleteConnection': {
                const ok = await c.handleDeleteConnection(message.connectionName);
                if (ok) await c.handleLoadConnections();
                break;
            }
            case 'loadConnections':             await c.handleLoadConnections(); break;
            case 'setAutoConnect':              await c.handleSetAutoConnect(message.enabled); break;
            case 'loadConnectionForDisplay':    await c.handleLoadConnectionForDisplay(message.connectionName); break;
            case 'testConnection':              await c.handleTestConnection(message.connectionConfig); break;
            // Re-runs the same command the activity bar/command palette use,
            // rather than duplicating createOrShow's wiring here - it already
            // has extensionUri/context/panelRegistry in closure (extension.js).
            case 'openNewPanel':                 await vscode.commands.executeCommand('sqlwayfarer.sqlwayfarer'); break;

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
                break;
            case 'getDatabases':                await d.handleGetDatabases(); break;
            // No background indexing here anymore - the dependency index is
            // only ever built when the user opens the Explorer tab (see
            // 'getIndex' below), not just from picking a database.
            case 'getObjects':                  await d.handleGetObjects(message.database); break;
            case 'getTableDetails':             await d.handleGetTableDetails(message.database, message.table); break;
            case 'getColumnUsage':              await d.handleGetColumnUsage(message.database, message.table); break;
            case 'getObjectDetails':            await d.handleGetObjectDetails(message.database, message.objectName, message.objectType); break;
            case 'getObjectDetailsAuto':         await d.handleGetObjectDetailsAuto(message.database, message.objectName); break;
            case 'searchObjects':               await d.handleSearchObjects(message.database, message.searchPattern, message.objectTypes); break;
            case 'getTableRowCount':            await d.handleGetTableRowCount(message.database, message.tableName); break;
            case 'getTableSampleData':          await d.handleGetTableSampleData(message.database, message.tableName, message.limit); break;
            case 'getObjectColumns':            await d.handleGetObjectColumns(message.database, message.objectName); break;
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

            // Export
            case 'exportDataDictionary':        await this._export.handleExportDataDictionary(message.database, message.full); break;
            case 'exportCsv':                   await this._export.handleExportCsv(message.csv, message.defaultName); break;

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

        // mtime du bundle réellement chargé (dist/extension.js) — permet de vérifier
        // qu'on teste bien le dernier build et pas une session restée sur l'ancien code.
        let buildTime = 'unknown';
        try {
            const bundlePath = path.join(this._extensionUri.fsPath, 'dist', 'extension.js');
            buildTime = fs.statSync(bundlePath).mtime.toLocaleString();
        } catch (error) {
            console.warn('Could not read build time:', error);
        }
        html = html.replace('{{BUILD_TIME}}', buildTime);

        html = html.replace(/\{\{CSP_SOURCE\}\}/g, w.cspSource);
        html = html.replace('{{CODICON_STYLES_URI}}',       u('webview', 'codicons', 'codicon.css'));
        html = html.replace('{{STYLES_URI}}',               u('webview', 'styles.css'));
        html = html.replace('{{COMMENTS_STYLES_URI}}',      u('webview', 'comments.css'));
        html = html.replace('{{CODE_VIEW_STYLES_URI}}',     u('webview', 'codeView.css'));
        html = html.replace('{{QUERY_PLAN_STYLES_URI}}',    u('webview', 'vendor', 'html-query-plan', 'qp.css'));
        html = html.replace('{{TAB_MANAGER_URI}}',          u('webview', 'tabManager.js'));
        html = html.replace('{{CONNECTION_MANAGER_URI}}',   u('webview', 'connectionManager.js'));
        html = html.replace('{{COMMENTS_MANAGER_URI}}',     u('webview', 'commentsManager.js'));
        html = html.replace('{{CODE_VIEW_MANAGER_URI}}',    u('webview', 'codeViewManager.js'));
        html = html.replace('{{BUILTIN_SNIPPETS_URI}}',      u('webview', 'builtinSnippets.js'));
        html = html.replace('{{SQL_AUTOCOMPLETE_URI}}',     u('webview', 'sqlAutocomplete.js'));
        html = html.replace('{{SQL_EDITOR_URI}}',           u('dist', 'webview', 'sqlEditor.js'));
        html = html.replace('{{QUERY_MANAGER_URI}}',        u('webview', 'queryManager.js'));
        html = html.replace('{{FILE_TREE_URI}}',            u('webview', 'fileTree.js'));
        html = html.replace('{{QUERY_FILE_MANAGER_URI}}',   u('webview', 'queryFileManager.js'));
        html = html.replace('{{FOOTPRINT_MANAGER_URI}}',    u('webview', 'footprintManager.js'));
        html = html.replace('{{VIZ_URI}}',                   u('webview', 'vendor', 'viz.js'));
        html = html.replace('{{VIZ_RENDER_URI}}',            u('webview', 'vendor', 'viz.full.render.js'));
        html = html.replace('{{DAGRE_URI}}',                u('webview', 'vendor', 'dagre.min.js'));
        html = html.replace('{{CYTOSCAPE_URI}}',            u('webview', 'vendor', 'cytoscape.min.js'));
        html = html.replace('{{CYTOSCAPE_DAGRE_URI}}',      u('webview', 'vendor', 'cytoscape-dagre.min.js'));
        html = html.replace('{{QUERY_PLAN_URI}}',           u('webview', 'vendor', 'html-query-plan', 'qp.min.js'));
        html = html.replace('{{MAIN_SCRIPT_URI}}',          u('webview', 'main.js'));

        return html;
    }

    async dispose() {
        this._disposed = true;
        this._panelRegistry.unregister(this);
        this._panel.dispose();

        this._idx.cancel();
        // NB: do NOT clear the index here. It is a persistent, checksum-validated
        // on-disk cache keyed by server+database — deleting it when the panel
        // closes forces a full rebuild on every reopen (crippling on large
        // databases). Staleness is handled by the schema checksum on next open.

        if (this._indexService) {
            try { await this._indexService.dispose(); } catch (error) { console.warn('Error disposing index service:', error); }
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

module.exports = SqlWayfarerPanel;
