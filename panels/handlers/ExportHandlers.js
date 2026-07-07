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

    // The webview builds the CSV text (it already holds the rows); this side
    // only owns the save dialog and the file write.
    async handleExportCsv(csv, defaultName) {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
            const defaultDir = workspaceFolder ? workspaceFolder.uri.fsPath : os.homedir();
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(defaultDir, defaultName || 'results.csv')),
                filters: { CSV: ['csv'] }
            });
            if (!uri) {
                this._post({ command: 'csvExported', success: false, cancelled: true });
                return;
            }

            // BOM so Excel opens the file as UTF-8 instead of guessing ANSI.
            await fs.writeFile(uri.fsPath, '\ufeff' + csv, 'utf8');
            this._post({ command: 'csvExported', success: true, path: uri.fsPath });
        } catch (error) {
            console.error('CSV export failed:', error);
            vscode.window.showErrorMessage(`CSV export failed: ${error.message}`);
            this._post({ command: 'csvExported', success: false, message: error.message });
        }
    }

    async handleExportDataDictionary(database, full = false) {
        if (!database) {
            this._post({ command: 'dataDictionaryExported', success: false, message: 'No database selected.' });
            return;
        }

        try {
            const title = full
                ? `SQL Wayfarer: generating full data dictionary for ${database}…`
                : `SQL Wayfarer: generating data dictionary for ${database}…`;

            // The full export is split into a folder of files (an index plus one
            // per page of objects) so no single document carries hundreds of
            // Mermaid diagrams, which chokes Markdown readers. The basic export
            // stays a single file.
            if (full) {
                await this._exportDataDictionaryFolder(database, title);
            } else {
                await this._exportDataDictionaryFile(database, title);
            }
        } catch (error) {
            console.error('Data dictionary export failed:', error);
            vscode.window.showErrorMessage(`Data dictionary export failed: ${error.message}`);
            this._post({ command: 'dataDictionaryExported', success: false, message: error.message });
        }
    }

    async _exportDataDictionaryFile(database, title) {
        const markdown = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title },
            () => this._dataDictionaryService.generateMarkdown(database, { full: false })
        );

        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(this._defaultDir(), `${database}-data-dictionary.md`)),
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
    }

    async _exportDataDictionaryFolder(database, title) {
        const { files, indexName } = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title },
            () => this._dataDictionaryService.generateMarkdownFiles(database, { full: true })
        );

        // No native "save folder" dialog, so pick a destination directory and
        // create a named subfolder inside it.
        const picked = await vscode.window.showOpenDialog({
            defaultUri: vscode.Uri.file(this._defaultDir()),
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Export data dictionary here'
        });
        if (!picked || picked.length === 0) {
            this._post({ command: 'dataDictionaryExported', success: false, cancelled: true });
            return;
        }

        const folderName = `${database}-data-dictionary-full`.replace(/[\\/:*?"<>|]+/g, '_');
        const folder = path.join(picked[0].fsPath, folderName);
        await fs.mkdir(folder, { recursive: true });
        for (const file of files) {
            await fs.writeFile(path.join(folder, file.name), file.content, 'utf8');
        }

        const indexPath = path.join(folder, indexName);
        this._post({ command: 'dataDictionaryExported', success: true, path: indexPath });

        vscode.window.showInformationMessage(
            `Data dictionary saved to ${folderName} (${files.length} files)`, 'Open'
        ).then(async action => {
            if (action === 'Open') {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(indexPath));
                await vscode.window.showTextDocument(doc);
            }
        });
    }

    _defaultDir() {
        const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        return workspaceFolder ? workspaceFolder.uri.fsPath : os.homedir();
    }
}

module.exports = ExportHandlers;
