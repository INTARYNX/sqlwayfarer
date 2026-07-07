'use strict';

const vscode = require('vscode');
const SqlWayfarerPanel = require('./panels/SqlWayfarerPanel');

// Minimal tree view provider — single entry point to open the panel
class SqlWayfarerViewProvider {
    getTreeItem(element) { return element; }

    getChildren(element) {
        if (!element) {
            const item = new vscode.TreeItem('SQL Wayfarer', vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('compass');
            item.description = 'Click to open';
            item.command = { command: 'sqlwayfarer.sqlwayfarer', title: 'Open SQL Wayfarer' };
            return [item];
        }
        return [];
    }
}

function activate(context) {
    vscode.window.registerTreeDataProvider('sqlWayfarerView', new SqlWayfarerViewProvider());

    const sqlWayfarerDisposable = vscode.commands.registerCommand('sqlwayfarer.sqlwayfarer', function () {
        SqlWayfarerPanel.createOrShow(context.extensionUri, context);
        // Small delay lets the panel open before the sidebar closes, avoiding focus issues
        setTimeout(() => vscode.commands.executeCommand('workbench.action.closeSidebar'), 200);
    });

    const helloWorldDisposable = vscode.commands.registerCommand('sqlwayfarer.helloWorld', function () {
        vscode.window.showInformationMessage('Hello World from SQL Wayfarer!');
    });

    context.subscriptions.push(sqlWayfarerDisposable, helloWorldDisposable);
}

function deactivate() {}

module.exports = { activate, deactivate };
