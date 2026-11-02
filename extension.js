'use strict';

const vscode = require('vscode');
const SqlWayfarerPanel = require('./panels/SqlWayfarerPanel');
const PanelRegistry = require('./panels/PanelRegistry');
const SnippetSidebarProvider = require('./panels/SnippetSidebarProvider');
const ConnectionLauncher = require('./panels/connectionLauncher');
const ConnectionStorage = require('./storage/ConnectionStorage');

function activate(context) {
    // One registry for the whole extension host, shared by every panel
    // opened during this session, and by the sidebar - see PanelRegistry.
    const panelRegistry = new PanelRegistry();

    // The saved connections are managed from the sidebar and used by every
    // tab: one storage for all of them.
    const connectionStorage = new ConnectionStorage(context);
    const storageReady = connectionStorage.initialize().catch(error => {
        console.error('Error loading saved connections:', error);
        vscode.window.showErrorMessage(`Failed to initialize SQL Wayfarer: ${error.message}`);
    });

    const launcher = new ConnectionLauncher({
        storage: connectionStorage,
        registry: panelRegistry,
        ready: storageReady,
        openLastConnection: () => vscode.workspace.getConfiguration('sqlwayfarer').get('openLastConnection', true),
        createPanel: name => SqlWayfarerPanel.createOrShow(context.extensionUri, context, panelRegistry, connectionStorage, name),
        ui: {
            pick: (items, placeHolder) => vscode.window.showQuickPick(items, { placeHolder }),
            info: message => vscode.window.showInformationMessage(message),
            error: message => vscode.window.showErrorMessage(message),
            focusSidebar: () => vscode.commands.executeCommand('workbench.view.extension.sql-wayfarer-container')
        }
    });

    const sidebarProvider = new SnippetSidebarProvider(context.extensionUri, context, panelRegistry, connectionStorage, storageReady);
    context.subscriptions.push(
        // retainContextWhenHidden: without it, VS Code tears down this view's
        // webview content (and its in-memory snippet list) every time it's
        // hidden - switching to a different activity bar icon and back - and
        // nothing reliably reloads it, which is exactly "snippets disappear".
        vscode.window.registerWebviewViewProvider('sqlWayfarerView', sidebarProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    context.subscriptions.push(
        // Palette and title bar entry.
        vscode.commands.registerCommand('sqlwayfarer.sqlwayfarer', () => launcher.openDefault()),
        // What the sidebar's Connect button runs.
        vscode.commands.registerCommand('sqlwayfarer.openConnection', name => launcher.open(name))
    );
}

function deactivate() {}

module.exports = { activate, deactivate };
