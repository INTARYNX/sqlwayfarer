'use strict';

const vscode = require('vscode');
const SqlWayfarerPanel = require('./panels/SqlWayfarerPanel');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('Congratulations, your extension "sqlwayfarer" is now active!');

    // Original Hello World command
    const helloWorldDisposable = vscode.commands.registerCommand('sqlwayfarer.helloWorld', function () {
        vscode.window.showInformationMessage('Hello World from sqlwayfarer!');
    });

    // SQL Wayfarer command
    const sqlWayfarerDisposable = vscode.commands.registerCommand('sqlwayfarer.sqlwayfarer', function () {
        console.log('sqlwayfarer.sqlwayfarer command executed');
        SqlWayfarerPanel.createOrShow(context.extensionUri, context);
    });

    context.subscriptions.push(helloWorldDisposable);
    context.subscriptions.push(sqlWayfarerDisposable);
    console.log('sqlwayfarer extension with SQL Wayfarer activated successfully');
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};