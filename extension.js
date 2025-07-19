'use strict';

const vscode = require('vscode');
const SqlWayfarerPanel = require('./panels/SqlWayfarerPanel');

/**
 * Provider minimal pour que l'icône apparaisse
 */
class SqlWayfarerViewProvider {
    getTreeItem(element) {
        return element;
    }

    getChildren(element) {
        if (!element) {
            // Retourne un élément simple avec une action
            const item = new vscode.TreeItem('SQL Wayfarer', vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('compass');
            item.description = 'Click to open';
            item.command = {
                command: 'sqlwayfarer.sqlwayfarer',
                title: 'Open SQL Wayfarer'
            };
            return [item];
        }
        return [];
    }
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('SQL Wayfarer extension is now active!');

    // Enregistrer le provider pour que l'icône apparaisse
    const viewProvider = new SqlWayfarerViewProvider();
    vscode.window.registerTreeDataProvider('sqlWayfarerView', viewProvider);

    // Commande principale SQL Wayfarer avec fermeture automatique
    const sqlWayfarerDisposable = vscode.commands.registerCommand('sqlwayfarer.sqlwayfarer', function () {
        console.log('Opening SQL Wayfarer...');
        
        // Ouvrir SQL Wayfarer
        SqlWayfarerPanel.createOrShow(context.extensionUri, context);
        
        // Fermer automatiquement la sidebar après un court délai
        setTimeout(() => {
            vscode.commands.executeCommand('workbench.action.closeSidebar');
        }, 200);
    });

    // Original Hello World command (garder pour compatibilité si nécessaire)
    const helloWorldDisposable = vscode.commands.registerCommand('sqlwayfarer.helloWorld', function () {
        vscode.window.showInformationMessage('Hello World from SQL Wayfarer!');
    });

    // Enregistrer les commandes
    context.subscriptions.push(sqlWayfarerDisposable);
    context.subscriptions.push(helloWorldDisposable);

    console.log('SQL Wayfarer extension activated successfully');
}

function deactivate() {
    console.log('SQL Wayfarer extension deactivated');
}

module.exports = {
    activate,
    deactivate
};