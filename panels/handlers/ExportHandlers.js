'use strict';

const vscode = require('vscode');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

class ExportHandlers {
    constructor(postMessage, dataDictionaryService) {
        this._post = postMessage;
        this._dataDictionaryService = dataDictionaryService;
    }

    async handleExportDataDictionary(database) {
        if (!database) {
            this._post({ command: 'dataDictionaryExported', success: false, message: 'No database selected.' });
            return;
        }

        try {
            const markdown = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `SQL Wayfarer: generating data dictionary for ${database}…` },
                () => this._dataDictionaryService.generateMarkdown(database)
            );

            const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
            const defaultDir = workspaceFolder ? workspaceFolder.uri.fsPath : os.homedir();
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(defaultDir, `${database}-data-dictionary.md`)),
                filters: { Markdown: ['md'] }
            });
            if (!uri) {
                this._post({ command: 'dataDictionaryExported', success: false, cancelled: true });
                return;
            }

            await fs.writeFile(uri.fsPath, markdown, 'utf8');
            this._post({ command: 'dataDictionaryExported', success: true, path: uri.fsPath });

            // Fire-and-forget: the info toast stays up until dismissed, no need to hold the handler.
            vscode.window.showInformationMessage(`Data dictionary saved to ${path.basename(uri.fsPath)}`, 'Open')
                .then(async action => {
                    if (action === 'Open') {
                        const doc = await vscode.workspace.openTextDocument(uri);
                        await vscode.window.showTextDocument(doc);
                    }
                });
        } catch (error) {
            console.error('Data dictionary export failed:', error);
            vscode.window.showErrorMessage(`Data dictionary export failed: ${error.message}`);
            this._post({ command: 'dataDictionaryExported', success: false, message: error.message });
        }
    }
}

module.exports = ExportHandlers;
