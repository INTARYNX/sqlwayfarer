/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Main message handler
class MessageHandler {
    constructor(connectionStatus, explorerManager, tabManager, commentsManager, detailsTabManager, codeViewManager, objectsTabManager, indexingModalManager, queryManager, queryFileManager) {
        this.connectionStatus = connectionStatus;
        this.explorerManager = explorerManager;
        this.tabManager = tabManager;
        this.commentsManager = commentsManager;
        this.detailsTabManager = detailsTabManager;
        this.codeViewManager = codeViewManager;
        this.objectsTabManager = objectsTabManager;
        this.indexingModalManager = indexingModalManager;
        this.queryManager = queryManager;
        this.queryFileManager = queryFileManager;
        this.databaseSelector = new DatabaseSelectorManager();
    }

    handleMessage(event) {
        const message = event.data;

        switch (message.command) {
            case 'connectionStatus':
                if (message.success) document.getElementById('productionBanner').hidden = !message.production;
                if (message.success && window.schemaSourceManager) window.schemaSourceManager.request();
                if (message.success && window.instanceTree) window.instanceTree.reset();
                if (message.success && window.compareManager) window.compareManager.reset();
                if (message.success && window.recentChanges) window.recentChanges.reset();
                if (this.connectionStatus.onConnectionStatus(message)) {
                    // Land directly on Query after every successful connection -
                    // Explorer (and its indexing) is opt-in, see TabManager.
                    this.tabManager.switchTab('query');
                }
                break;

            case 'snippetsImported':
                // Imports are started from the sidebar; a tab only says it when it is told.
                if (this.queryManager) this.queryManager.setStatus(`Snippets imported: ${message.added || 0}${message.overwritten ? `, ${message.overwritten} overwritten` : ''}.`, 'success');
                break;

            case 'schemaSources':
                if (window.schemaSourceManager) window.schemaSourceManager.onSchemaSources(message);
                break;

            case 'schemaSourceChanged':
                if (window.schemaSourceManager) window.schemaSourceManager.onSchemaSourceChanged(message);
                break;

            case 'queryDatabases':
                if (window.schemaSourceManager) window.schemaSourceManager.onQueryDatabases(message);
                break;

            case 'connectionLost':
                this.connectionStatus.onConnectionLost(message.message);
                break;

            case 'connectionRecovered':
                this.connectionStatus.hideBanner();
                break;

            case 'requestCurrentDatabase':
                vscode.postMessage({
                    command: 'setCurrentDatabase',
                    database: appState.currentDatabase || '',
                    // A sync reply: the extension asked, so an empty answer
                    // means "nothing selected here", not "the user cleared
                    // the selection".
                    sync: true
                });
                break;

            case 'databasesLoaded':
                this.explorerManager.onDatabasesLoaded(message.databases, message.currentDatabase);
                if (this.queryFileManager) this.queryFileManager.onDatabasesLoaded();
                // Only worth a hint when nothing is selected yet - a
                // connection saved with a database opens on it.
                if (!appState.currentDatabase) this.databaseSelector.showReadyGlow();
                // The tab the panel was on, when the page was rebuilt.
                if (message.activeTab) {
                    this.tabManager.switchTab(message.activeTab);
                }
                if (this.codeViewManager) {
                    this.codeViewManager.onDatabaseChanged();
                }
                // Fires on every (re)connection - a fresh connection may point
                // at a different server, see SqlAutocomplete.onConnected.
                if (this.queryManager) {
                    this.queryManager.onConnected();
                }
                break;

            case 'selectDatabase':
                this.explorerManager.selectDatabase(message.database);
                break;

            case 'objectsLoaded':
                this.explorerManager.onObjectsLoaded(message.objects, message.database);
                break;

            case 'autocompleteSettings':
                if (this.queryManager) {
                    this.queryManager.autocomplete.applySettings(message.settings);
                }
                break;

            case 'diagnosticsSettings':
                if (this.queryManager) this.queryManager.setSyntaxEnabled(message.syntax);
                break;

            case 'syntaxResult':
                if (this.queryManager) this.queryManager.onSyntaxResult(message);
                break;

            case 'objectParametersLoaded':
                if (this.queryManager) {
                    this.queryManager.autocomplete.onParametersLoaded(message.database, message.objectName, message.parameters);
                }
                break;

            case 'autocompleteObjectsLoaded':
                if (this.queryManager) {
                    this.queryManager.onAutocompleteObjectsLoaded(message);
                }
                break;

            case 'tableStatsLoaded':
                this.explorerManager.onTableStatsLoaded(message.database, message.stats);
                break;

            case 'foreignKeysLoaded':
                this.explorerManager.onForeignKeysLoaded(message.database, message.foreignKeys);
                break;

            case 'scriptGenerated':
                if (message.preview) {
                    this.explorerManager.onScriptGenerated(message.objectName, message.script);
                } else if (this.queryManager) {
                    this.tabManager.switchTab('query');
                    // From the instance tree, on a database that is not the one the editor runs on.
                    const runsOn = this.queryManager.targetDatabase();
                    const useLine = message.database && message.database !== runsOn ? `USE [${message.database.replace(/]/g, ']]')}]\nGO\n\n` : '';
                    // A new tab: the query being edited is not overwritten.
                    if (this.queryManager.openScriptInNewTab) this.queryManager.openScriptInNewTab(useLine + message.script);
                    else this.queryManager.setQueryText(useLine + message.script);
                }
                break;

            case 'columnUsageResult':
                this.explorerManager.onColumnUsageResult(message.tableName, message.usage);
                break;

            case 'tableDetailsLoaded':
                this.explorerManager.onTableDetailsLoaded(
                    message.tableName,
                    message.columns,
                    message.indexes,
                    message.foreignKeys,
                    message.dependencies,
                    message.stats,
                    message.database
                );
                break;

            case 'writeFootprintResult':
                if (window.footprintManager) window.footprintManager.onResult(message);
                break;

            case 'queryGraphResult':
                if (window.footprintManager) window.footprintManager.onQueryGraphResult(message);
                break;

            case 'footprintDocResult':
                if (window.footprintManager) window.footprintManager.onDocResult(message);
                break;

            case 'objectDetailsLoaded':
                this.explorerManager.onObjectDetailsLoaded(
                    message.objectName,
                    message.objectType,
                    message.dependencies,
                    message.definition,
                    message.database
                );
                break;

            // Index-related messages
            case 'indexResult':
                if (this.objectsTabManager) {
                    this.objectsTabManager.displayIndex(message.indexData, message.database);
                }
                // handleGetIndex's plain path has no 'indexingCompleted' message of
                // its own - this is the only signal that it's done, so hide (or
                // cancel the still-pending scheduled show of) the progress modal here too.
                if (this.indexingModalManager) {
                    this.indexingModalManager.hide();
                }
                break;

            case 'indexStatus':
                if (this.objectsTabManager) {
                    this.objectsTabManager.onIndexStatus(message);
                }
                break;

            case 'indexingProgress':
                if (this.objectsTabManager) {
                    this.objectsTabManager.onIndexingProgress(message);
                }
                if (this.indexingModalManager) {
                    this.indexingModalManager.updateProgress(message.progress, message.current, message.total, message.message);
                }
                break;

            case 'indexingCompleted':
                if (this.objectsTabManager) {
                    this.objectsTabManager.onIndexingCompleted(message.database, message.success, message.message);
                }
                if (this.indexingModalManager) {
                    this.indexingModalManager.hide();
                }
                this.explorerManager.onIndexingSettled(message.database);
                break;

            // Comments Messages
            case 'tableExtendedPropertiesResult':
                this.commentsManager.onTableExtendedPropertiesResult(message.tableName, message.properties);
                break;

            case 'objectExtendedPropertiesResult':
                this.commentsManager.onObjectExtendedPropertiesResult(message.objectName, message.objectType, message.properties);
                break;

            case 'updateDescriptionResult':
                this.commentsManager.onUpdateDescriptionResult(message);
                break;

            case 'deleteDescriptionResult':
                this.commentsManager.onDeleteDescriptionResult(message);
                break;

            case 'error':
                this.handleError(message.message);
                break;

            case 'indexingStarted':
                if (this.objectsTabManager) {
                    this.objectsTabManager.onIndexingStarted(message.database, message.forced);
                }
                if (this.indexingModalManager) {
                    const startMessage = message.forced ? 'Force reindexing started...' : 'Indexing started...';
                    // A build only ever starts from a user action, so show it at once.
                    this.indexingModalManager.show(startMessage, message.database);
                }
                break;

            case 'indexingCancelled':
                if (this.objectsTabManager) {
                    this.objectsTabManager.onIndexingCancelled(message);
                }
                if (this.indexingModalManager) {
                    this.indexingModalManager.hide();
                }
                // No per-database info on cancellation - unlock unconditionally.
                this.explorerManager.setPanelsLocked(false);
                break;
            case 'forceReindexConfirmed':
                if (this.objectsTabManager) {
                    this.objectsTabManager.onForceReindexConfirmed(message.database);
                }
                break;

            case 'dependencyTreeResult':
                if (this.explorerManager._isAwaitedDetails(message.database, message.objectName)) this.explorerManager.displayDependencyTree(message.dependencyTree);
                break;

            case 'queryResult':
                if (this.queryManager) {
                    this.queryManager.onQueryResult(message);
                }
                break;

            case 'transactionState':
                if (this.queryManager) {
                    this.queryManager.onTransactionState(message);
                }
                break;

            case 'recentChanges':
                if (window.recentChanges) window.recentChanges.onChanges(message);
                break;

            case 'recentFailed':
                if (window.recentChanges) window.recentChanges.onFailed(message);
                break;

            case 'recentDefinition':
                if (window.recentChanges) window.recentChanges.onDefinition(message);
                break;

            case 'compareSources':
                if (window.compareManager) window.compareManager.onSources(message);
                break;

            case 'compareResult':
                if (window.compareManager) window.compareManager.onResult(message);
                break;

            case 'compareFailed':
                if (window.compareManager) window.compareManager.onFailed(message);
                break;

            case 'compareScript':
                if (window.compareManager) window.compareManager.onScript(message);
                break;

            case 'compareExported':
                if (window.compareManager) window.compareManager.onExported(message);
                break;

            case 'compareTargets':
                if (window.compareManager) window.compareManager.onTargets(message);
                break;

            case 'compareTargetDatabases':
                if (window.compareManager) window.compareManager.onTargetDatabases(message);
                break;

            case 'compareTargetStatus':
                if (window.compareManager) window.compareManager.onTargetStatus(message);
                break;

            case 'compareApplyProgress':
                if (window.compareManager) window.compareManager.onApplyProgress(message);
                break;

            case 'compareApplied':
                if (window.compareManager) window.compareManager.onApplied(message);
                break;

            case 'compareApplyDeclined':
                if (window.compareManager) window.compareManager.onApplyDeclined();
                break;

            case 'compareSnapshotDone':
                if (window.compareManager) window.compareManager.onSnapshotDone(message);
                break;

            case 'instanceDatabases':
                if (window.instanceTree) window.instanceTree.onDatabases(message);
                break;

            case 'instanceObjects':
                if (window.instanceTree) window.instanceTree.onObjects(message);
                break;

            case 'instanceObjectsError':
                if (window.instanceTree) window.instanceTree.onObjectsError(message);
                break;

            case 'instanceChanged':
                if (window.instanceTree) window.instanceTree.onChanged(message);
                break;

            case 'planResult':
                if (this.queryManager) {
                    this.queryManager.onPlanResult(message);
                }
                break;

            case 'queryError':
                if (this.queryManager) {
                    this.queryManager.onQueryError(message);
                }
                break;

            case 'queryHistoryLoaded':
                if (this.queryManager) {
                    this.queryManager.onHistoryLoaded(message.history);
                }
                break;

            case 'snippetsLoaded':
                if (this.queryManager) {
                    this.queryManager.onSnippetsLoaded(message.snippets);
                }
                break;

            case 'snippetNamePrompted':
                if (this.queryManager) {
                    this.queryManager.onSnippetNamePrompted(message.name);
                }
                break;

            case 'sqlFilesListed':
                if (this.queryFileManager) this.queryFileManager.onSqlFilesListed(message);
                break;

            case 'sqlFilesSearched':
                if (this.queryFileManager) this.queryFileManager.onSqlFilesSearched(message);
                break;

            case 'sqlFileOpened':
                if (this.queryFileManager) this.queryFileManager.onSqlFileOpened(message);
                break;

            case 'sqlFileError':
                if (this.queryFileManager) this.queryFileManager.onSqlFileError(message);
                break;

            case 'sqlFileSaved':
                if (this.queryFileManager) this.queryFileManager.onSqlFileSaved(message);
                break;

            case 'sqlFileSavedAs':
                if (this.queryFileManager) this.queryFileManager.onSqlFileSavedAs(message);
                break;

            case 'draftRecoveryLoaded':
                if (this.queryFileManager) this.queryFileManager.onDraftRecoveryLoaded(message);
                break;

            case 'discardConfirmed':
                if (this.queryFileManager) this.queryFileManager.onDiscardConfirmed(message);
                break;

            case 'objectColumnsLoaded':
                if (this.queryManager) {
                    this.queryManager.onObjectColumnsLoaded(message);
                }
                break;

            case 'dataDictionaryExported':
                this.explorerManager.onDictionaryExported();
                break;

            case 'buildStats':
                if (this.objectsTabManager) {
                    this.objectsTabManager.onBuildStats(message);
                }
                break;

            case 'resultsExported':
                if (this.queryManager) {
                    this.queryManager.onCsvExported(message);
                }
                break;

            case 'definitionSearchResult':
                this.explorerManager.filterManager.onDefinitionSearchResult(message);
                break;

            default:
                console.warn(`Unknown command: ${message.command}`);
        }
    }

    handleError(message) {
        console.error('SQL Wayfarer Error:', message);
        this.connectionStatus.showStatus(message);
    }
}

// Application initialization
document.addEventListener('DOMContentLoaded', function () {
    // Tells the extension this page was just built, so it can restore what
    // this tab was showing (selected database, open tab) instead of
    // starting from scratch.
    vscode.postMessage({ command: 'panelReady' });

    const tabManager = new TabManager();
    const connectionStatus = new ConnectionStatus();
    const explorerManager = new ExplorerManager();
    const commentsManager = new CommentsManager();
    const codeViewManager = new CodeViewManager();
    const detailsTabManager = new DetailsTabManager();
    const objectsTabManager = new ObjectsTabManager();
    const indexingModalManager = new IndexingModalManager();
    const queryManager = new QueryManager();
    const queryFileManager = new QueryFileManager(queryManager);
    queryManager.openScriptInNewTab = text => queryFileManager.addDraftTabWithContent(text);
    const footprintManager = new FootprintManager();
    const schemaSourceManager = new SchemaSourceManager();
    const instanceTree = new InstanceTree();
    const compareManager = new CompareManager();
    const recentChanges = new RecentChanges();

    const messageHandler = new MessageHandler(
        connectionStatus,
        explorerManager,
        tabManager,
        commentsManager,
        detailsTabManager,
        codeViewManager,
        objectsTabManager,
        indexingModalManager,
        queryManager,
        queryFileManager
    );

    // Make managers available globally
    window.explorerManager = explorerManager;
    window.commentsManager = commentsManager;
    window.codeViewManager = codeViewManager;
    window.detailsTabManager = detailsTabManager;
    window.objectsTabManager = objectsTabManager;
    window.queryManager = queryManager;
    window.schemaSourceManager = schemaSourceManager;
    window.queryFileManager = queryFileManager;
    window.instanceTree = instanceTree;
    window.compareManager = compareManager;
    window.recentChanges = recentChanges;
    window.tabManager = tabManager;
    window.connectionStatus = connectionStatus;
    window.footprintManager = footprintManager;

    window.addEventListener('message', (event) => messageHandler.handleMessage(event));

});