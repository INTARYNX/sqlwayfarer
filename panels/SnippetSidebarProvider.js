'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const SnippetHandlers = require('./handlers/SnippetHandlers');
const SavedConnectionHandlers = require('./handlers/SavedConnectionHandlers');
const ConnectionManager = require('../database/ConnectionManager');
const { getBuildTime } = require('./buildInfo');
const { readIconSprite } = require('./iconSprite');
const { createVsCodeTokenFetcher } = require('../database/entraToken');

// Hosts the saved connections and the SQL snippet CRUD manager (two tabs) in the
// activity bar sidebar (view id
// 'sqlWayfarerView', see package.json's "views" contribution) instead of a
// VS Code TreeView - snippets need a rich inline editor (name + multi-line
// SQL), which a native tree item/quick-pick can't give, and this way they're
// reachable without a SQL Wayfarer tab open at all. Registers itself with
// the same PanelRegistry the panels use so a snippet change here reaches
// every open tab's own "Snippets" dropdown, and vice versa (see
// SnippetHandlers's broadcast param). The connections are managed here too -
// a tab is opened for one of them, it does not pick or edit connections.
class SnippetSidebarProvider {
    // connectionStorage / storageReady: the extension-wide storage of the
    // saved connections, and the promise of it being readable.
    constructor(extensionUri, context, panelRegistry, connectionStorage, storageReady = Promise.resolve()) {
        this._extensionUri = extensionUri;
        this._context = context;
        this._panelRegistry = panelRegistry;
        this._connectionStorage = connectionStorage;
        this._storageReady = storageReady;
    }

    resolveWebviewView(webviewView) {
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        webviewView.webview.html = this._getHtml(webviewView.webview);

        const post = message => webviewView.webview.postMessage(message);
        // Which connections have a tab open, pushed by the registry whenever a
        // tab is opened or closed.
        const registryEntry = {
            post,
            connectionIdentity: null,
            onOpenConnectionsChanged: names => post({ command: 'openConnectionsChanged', names })
        };
        this._panelRegistry.register(registryEntry);

        // Only used to test a connection.
        const connectionManager = new ConnectionManager(
            this._connectionStorage,
            createVsCodeTokenFetcher(vscode),
            path.join(this._extensionUri.fsPath, 'helper', 'SqlWayfarerSspi.exe')
        );
        webviewView.onDidDispose(() => {
            this._panelRegistry.unregister(registryEntry);
            connectionManager.dispose().catch(() => { /* nothing open */ });
        });

        const snippets = new SnippetHandlers(post, this._context.globalState, message => this._panelRegistry.broadcast(message));
        const connections = new SavedConnectionHandlers(post, connectionManager, this._connectionStorage, {
            openConnectionNames: () => this._panelRegistry.openConnectionNames(),
            confirmDelete: async name => {
                const answer = await vscode.window.showWarningMessage(`Delete the connection "${name}"?`, { modal: true }, 'Delete');
                return answer === 'Delete';
            },
            whenReady: () => this._storageReady,
            onRenamed: (oldName, newName) => this._panelRegistry.renameConnection(oldName, newName),
            openConnection: name => vscode.commands.executeCommand('sqlwayfarer.openConnection', name)
        });

        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'getSnippets':         await snippets.handleGetSnippets(); break;
                case 'addSnippet':          await snippets.handleAddSnippet(message.name, message.sql, message.abbreviation); break;
                case 'updateSnippet':       await snippets.handleUpdateSnippet(message.oldName, message.newName, message.sql, message.abbreviation); break;
                case 'importSnippets':      await snippets.handleImportSnippets(); break;
                case 'deleteSnippet':       await snippets.handleDeleteSnippet(message.name); break;
                // The extension asks, a webview cannot show a dialog.
                case 'confirmDeleteSnippet': {
                    const answer = await vscode.window.showWarningMessage(`Delete the snippet "${message.name}"?`, { modal: true }, 'Delete');
                    if (answer === 'Delete') await snippets.handleDeleteSnippet(message.name);
                    break;
                }

                // Saved connections
                case 'loadConnections':          await connections.handleLoadConnections(); break;
                case 'saveConnection': {
                    const ok = await connections.handleSaveConnection(message.connectionConfig, message.originalName);
                    if (ok) await connections.handleLoadConnections();
                    break;
                }
                case 'saveAndOpenConnection':    await connections.handleSaveAndOpenConnection(message.connectionConfig, message.originalName); break;
                case 'deleteConnection': {
                    const ok = await connections.handleDeleteConnection(message.connectionName);
                    if (ok) await connections.handleLoadConnections();
                    break;
                }
                case 'testConnection':           await connections.handleTestConnection(message.connectionConfig); break;
                // Opens (or shows) the tab of that connection.
                case 'connectToSaved':           await vscode.commands.executeCommand('sqlwayfarer.openConnection', message.connectionName); break;
                default:
                    console.warn(`Unknown command in SnippetSidebarProvider: ${message.command}`);
            }
        });

        // Belt and suspenders alongside retainContextWhenHidden (see
        // extension.js): if this view's webview content ever does get
        // discarded while hidden (a reload, a VS Code version without full
        // retention, ...), re-push the current list the moment it becomes
        // visible again instead of leaving a stale or empty one on screen.
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                snippets.handleGetSnippets();
                connections.handleLoadConnections();
            }
        });
    }

    _getHtml(webview) {
        const u = (...p) => webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, ...p)).toString();

        const htmlPath = path.join(this._extensionUri.fsPath, 'webview', 'sidebar.html');
        let html = fs.readFileSync(htmlPath, 'utf8');

        html = html.replace('{{BUILD_TIME}}', getBuildTime(this._extensionUri.fsPath));
        html = html.replace('{{ICON_SPRITE}}', () => readIconSprite(this._extensionUri.fsPath));
        html = html.replace(/\{\{CSP_SOURCE\}\}/g, webview.cspSource);
        html = html.replace('{{CODICON_STYLES_URI}}',  u('webview', 'codicons', 'codicon.css'));
        html = html.replace('{{SIDEBAR_STYLES_URI}}',  u('webview', 'sidebar.css'));
        html = html.replace('{{BUILTIN_SNIPPETS_URI}}', u('webview', 'builtinSnippets.js'));
        html = html.replace('{{SNIPPET_MANAGER_URI}}', u('webview', 'snippetManager.js'));
        html = html.replace('{{SIDEBAR_CONNECTIONS_URI}}', u('webview', 'sidebarConnections.js'));
        html = html.replace('{{SIDEBAR_MAIN_URI}}',    u('webview', 'sidebarMain.js'));

        return html;
    }
}

module.exports = SnippetSidebarProvider;
