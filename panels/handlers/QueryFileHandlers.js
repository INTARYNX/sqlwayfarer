'use strict';

const vscode = require('vscode');
const fs = require('fs').promises;
const path = require('path');

const DRAFTS_KEY = 'sqlwayfarer.queryDrafts';

// Browse/open/save .sql files from the workspace root for the Query tab's
// file-backed sub-tabs, plus a crash-recovery snapshot for unsaved drafts
// (file-backed tabs don't need it - their content already lives on disk).
class QueryFileHandlers {
    constructor(postMessage, workspaceState, getConnectionIdentity = () => null) {
        this._post = postMessage;
        this._workspaceState = workspaceState;
        this._getConnectionIdentity = getConnectionIdentity;
    }

    // Scoped per connection so two tabs on different servers never share, or
    // clobber, each other's autosaved drafts - see connectionIdentity. Falls
    // back to one shared bucket before any connection exists (narrow window:
    // handleGetDraftRecovery fires at webview load, before auto-connect's
    // round trip can possibly have resolved yet).
    _draftsKey() {
        return `${DRAFTS_KEY}::${this._getConnectionIdentity() || '(disconnected)'}`;
    }

    _workspaceRoot() {
        const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        return folder ? folder.uri.fsPath : null;
    }

    // handleListSqlFiles only ever returns paths already under a workspace
    // folder, but the webview sends the path straight back for open/save - the
    // trust boundary is the extension host, not the webview, so re-check it
    // here rather than assuming the round-trip can't be tampered with.
    _isInsideWorkspace(filePath) {
        const folders = vscode.workspace.workspaceFolders || [];
        const resolved = path.resolve(filePath);
        return folders.some(folder => {
            const root = path.resolve(folder.uri.fsPath);
            return resolved === root || resolved.startsWith(root + path.sep);
        });
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
        if (!this._isInsideWorkspace(filePath)) {
            this._post({ command: 'sqlFileError', message: `Refusing to open a file outside the workspace: ${filePath}` });
            return;
        }
        try {
            const content = await fs.readFile(filePath, 'utf8');
            this._post({ command: 'sqlFileOpened', path: filePath, name: path.basename(filePath), content });
        } catch (error) {
            this._post({ command: 'sqlFileError', message: `Could not open ${path.basename(filePath)}: ${error.message}` });
        }
    }

    async handleSaveSqlFile(filePath, content) {
        if (!this._isInsideWorkspace(filePath)) {
            this._post({ command: 'sqlFileSaved', path: filePath, success: false, message: `Refusing to save a file outside the workspace: ${filePath}` });
            return;
        }
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
        this._post({ command: 'draftRecoveryLoaded', drafts: this._workspaceState.get(this._draftsKey(), []) });
    }

    async handleSaveDraftRecovery(drafts) {
        await this._workspaceState.update(this._draftsKey(), Array.isArray(drafts) ? drafts : []);
    }

    // Called after a successful connect (see SqlWayfarerPanel's
    // panelController.onConnectionChanged): handleGetDraftRecovery already
    // ran at webview load, before this panel had a connection (and so before
    // _draftsKey() could resolve to anything but the shared pre-connect
    // bucket) - re-check now that the real per-connection bucket is
    // resolvable, so a previous crashed session on this same server is still
    // recoverable. The webview only applies this if its tabs are still
    // pristine, so it can never clobber SQL the user already typed.
    async maybeOfferRecoveryForCurrentIdentity() {
        const drafts = this._workspaceState.get(this._draftsKey(), []);
        if (drafts.length === 0) return;
        this._post({ command: 'draftRecoveryLoaded', drafts });
    }
}

module.exports = QueryFileHandlers;
