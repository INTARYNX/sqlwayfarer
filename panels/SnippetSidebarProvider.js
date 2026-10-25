'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const SnippetHandlers = require('./handlers/SnippetHandlers');

// Hosts the SQL snippet CRUD manager in the activity bar sidebar (view id
// 'sqlWayfarerView', see package.json's "views" contribution) instead of a
// VS Code TreeView - snippets need a rich inline editor (name + multi-line
// SQL), which a native tree item/quick-pick can't give, and this way they're
// reachable without a SQL Wayfarer tab open at all. Registers itself with
// the same PanelRegistry the panels use so a snippet change here reaches
// every open tab's own "Snippets" dropdown, and vice versa (see
// SnippetHandlers's broadcast param).
class SnippetSidebarProvider {
    constructor(extensionUri, context, panelRegistry) {
        this._extensionUri = extensionUri;
        this._context = context;
        this._panelRegistry = panelRegistry;
    }

    resolveWebviewView(webviewView) {
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        webviewView.webview.html = this._getHtml(webviewView.webview);

        const post = message => webviewView.webview.postMessage(message);
        const registryEntry = { post, connectionIdentity: null };
        this._panelRegistry.register(registryEntry);
        webviewView.onDidDispose(() => this._panelRegistry.unregister(registryEntry));

        const snippets = new SnippetHandlers(post, this._context.globalState, message => this._panelRegistry.broadcast(message));

        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'getSnippets':         await snippets.handleGetSnippets(); break;
                case 'addSnippet':          await snippets.handleAddSnippet(message.name, message.sql); break;
                case 'updateSnippet':       await snippets.handleUpdateSnippet(message.oldName, message.newName, message.sql); break;
                case 'deleteSnippet':       await snippets.handleDeleteSnippet(message.name); break;
                // Same "open a tab" entry point as the '+' button inside an
                // already-open panel's tab-nav (SqlWayfarerPanel._handleMessage) -
                // this one is what opens the very first tab.
                case 'openNewPanel':        await vscode.commands.executeCommand('sqlwayfarer.sqlwayfarer'); break;
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
            if (webviewView.visible) snippets.handleGetSnippets();
        });
    }

    _getHtml(webview) {
        const u = (...p) => webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, ...p)).toString();

        const htmlPath = path.join(this._extensionUri.fsPath, 'webview', 'sidebarSnippets.html');
        let html = fs.readFileSync(htmlPath, 'utf8');

        html = html.replace(/\{\{CSP_SOURCE\}\}/g, webview.cspSource);
        html = html.replace('{{CODICON_STYLES_URI}}',  u('webview', 'codicons', 'codicon.css'));
        html = html.replace('{{STYLES_URI}}',          u('webview', 'styles.css'));
        html = html.replace('{{COMMENTS_STYLES_URI}}', u('webview', 'comments.css'));
        html = html.replace('{{BUILTIN_SNIPPETS_URI}}', u('webview', 'builtinSnippets.js'));
        html = html.replace('{{SNIPPET_MANAGER_URI}}', u('webview', 'snippetManager.js'));
        html = html.replace('{{SIDEBAR_MAIN_URI}}',    u('webview', 'sidebarMain.js'));

        return html;
    }
}

module.exports = SnippetSidebarProvider;
