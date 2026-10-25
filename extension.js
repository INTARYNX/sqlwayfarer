'use strict';

const vscode = require('vscode');
const SqlWayfarerPanel = require('./panels/SqlWayfarerPanel');
const PanelRegistry = require('./panels/PanelRegistry');
const SnippetSidebarProvider = require('./panels/SnippetSidebarProvider');

function activate(context) {
    // One registry for the whole extension host, shared by every panel
    // opened during this session, and by the sidebar's snippet manager - see
    // PanelRegistry.
    const panelRegistry = new PanelRegistry();

    const sidebarProvider = new SnippetSidebarProvider(context.extensionUri, context, panelRegistry);
    context.subscriptions.push(
        // retainContextWhenHidden: without it, VS Code tears down this view's
        // webview content (and its in-memory snippet list) every time it's
        // hidden - switching to a different activity bar icon and back - and
        // nothing reliably reloads it, which is exactly "snippets disappear".
        vscode.window.registerWebviewViewProvider('sqlWayfarerView', sidebarProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    const sqlWayfarerDisposable = vscode.commands.registerCommand('sqlwayfarer.sqlwayfarer', function () {
        SqlWayfarerPanel.createOrShow(context.extensionUri, context, panelRegistry);
    });

    context.subscriptions.push(sqlWayfarerDisposable);
}

function deactivate() {}

module.exports = { activate, deactivate };
