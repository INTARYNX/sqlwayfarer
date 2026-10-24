'use strict';

const vscode = require('vscode');
const fs = require('fs').promises;
const path = require('path');

const DRAFTS_KEY = 'sqlwayfarer.queryDrafts';

// Browse/open/save .sql files from the workspace root for the Query tab's
// file-backed sub-tabs, plus a crash-recovery snapshot for unsaved drafts
// (file-backed tabs don't need it - their content already lives on disk).
class QueryFileHandlers {
    constructor(postMessage, workspaceState) {
        this._post = postMessage;
        this._workspaceState = workspaceState;
    }

    _workspaceRoot() {
        const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        return folder ? folder.uri.fsPath : null;
    }

    // root defaults to the workspace folder; overridable so tests can point
    // it at a fixture directory without touching vscode.workspace.workspaceFolders.
    async handleListSqlFiles(root = this._workspaceRoot()) {
        if (!root) {
            // Distinct from "workspace open but no .sql files" - the panel
            // needs to tell the two apart instead of showing the same dead end.
            this._post({ command: 'sqlFilesListed', files: [], noWorkspace: true });
            return;
        }

        try {
            const files = [];
            await this._walkSqlFiles(root, root, files, 0);
            files.sort((a, b) => a.relativeDir.localeCompare(b.relativeDir) || a.name.localeCompare(b.name));
            this._post({ command: 'sqlFilesListed', files });
        } catch (error) {
            console.error('Failed to list SQL files:', error);
            this._post({ command: 'sqlFilesListed', files: [] });
        }
    }

    // Recurses into subdirectories so the side panel can show the whole
    // workspace tree, not just the root - skips node_modules/dotfolders
    // (noise, and potentially huge) and caps depth against symlink loops.
    async _walkSqlFiles(dir, root, results, depth) {
        if (depth > 8) return;
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await this._walkSqlFiles(full, root, results, depth + 1);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.sql')) {
                const relativeDir = path.relative(root, dir).split(path.sep).join('/');
                results.push({ name: entry.name, path: full, relativeDir });
            }
        }
    }

    async handleOpenSqlFile(filePath) {
        try {
            const content = await fs.readFile(filePath, 'utf8');
            this._post({ command: 'sqlFileOpened', path: filePath, name: path.basename(filePath), content });
        } catch (error) {
            this._post({ command: 'sqlFileError', message: `Could not open ${path.basename(filePath)}: ${error.message}` });
        }
    }

    async handleSaveSqlFile(filePath, content) {
        try {
            await fs.writeFile(filePath, content, 'utf8');
            this._post({ command: 'sqlFileSaved', path: filePath, success: true });
        } catch (error) {
            this._post({ command: 'sqlFileSaved', path: filePath, success: false, message: error.message });
        }
    }

    async handleSaveSqlFileAs(content, suggestedName) {
        const root = this._workspaceRoot();
        const defaultDir = root || require('os').homedir();
        try {
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(defaultDir, suggestedName || 'query.sql')),
                filters: { SQL: ['sql'] }
            });
            if (!uri) {
                this._post({ command: 'sqlFileSavedAs', cancelled: true });
                return;
            }
            await fs.writeFile(uri.fsPath, content, 'utf8');
            this._post({ command: 'sqlFileSavedAs', path: uri.fsPath, name: path.basename(uri.fsPath), success: true });
        } catch (error) {
            this._post({ command: 'sqlFileSavedAs', success: false, message: error.message });
        }
    }

    // Closing a modified file-backed tab asks for confirmation through the
    // native warning dialog, same idiom as QueryHandlers._confirmRisks -
    // window.confirm() doesn't work inside a webview.
    async handleConfirmDiscardChanges(name) {
        const selection = await vscode.window.showWarningMessage(
            `"${name}" has unsaved changes. Discard them?`,
            { modal: true },
            'Discard'
        );
        this._post({ command: 'discardConfirmed', discard: selection === 'Discard' });
    }

    async handleGetDraftRecovery() {
        this._post({ command: 'draftRecoveryLoaded', drafts: this._workspaceState.get(DRAFTS_KEY, []) });
    }

    async handleSaveDraftRecovery(drafts) {
        await this._workspaceState.update(DRAFTS_KEY, Array.isArray(drafts) ? drafts : []);
    }
}

module.exports = QueryFileHandlers;
