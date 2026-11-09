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
        // Files chosen in the Save As dialog (resolved paths), outside the workspace or not.
        this._savedAs = new Set();
        // Files the extension itself listed (resolved paths): a junction or a
        // link in the workspace can lead to another drive, and a file the
        // list shows must open wherever it really is.
        this._listed = new Set();
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
        // A file the user picked in the Save As dialog is theirs, wherever it is.
        if (this._savedAs.has(resolved) || this._listed.has(resolved)) return true;
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
            this._listed = new Set(files.map(f => path.resolve(f.path)));
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

    // The encoding of a file, by its byte order mark: SSMS saves UTF-16 by
    // default. Without a mark the file is UTF-8.
    static detectEncoding(buffer) {
        if (buffer[0] === 0xFF && buffer[1] === 0xFE) return 'utf16le';
        if (buffer[0] === 0xFE && buffer[1] === 0xFF) return 'utf16be';
        if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) return 'utf8bom';
        return 'utf8';
    }

    static decode(buffer) {
        switch (QueryFileHandlers.detectEncoding(buffer)) {
            case 'utf16le': return buffer.subarray(2).toString('utf16le');
            case 'utf16be': return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
            case 'utf8bom': return buffer.subarray(3).toString('utf8');
            default: return buffer.toString('utf8');
        }
    }

    // The bytes of a text in the encoding the file was opened with.
    static encode(text, encoding) {
        switch (encoding) {
            case 'utf16le': return Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);
            case 'utf16be': return Buffer.concat([Buffer.from([0xFE, 0xFF]), Buffer.from(text, 'utf16le').swap16()]);
            case 'utf8bom': return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')]);
            default: return Buffer.from(text, 'utf8');
        }
    }

    async handleOpenSqlFile(filePath) {
        if (!this._isInsideWorkspace(filePath)) {
            this._post({ command: 'sqlFileError', message: `Refusing to open a file outside the workspace: ${filePath}` });
            return;
        }
        try {
            const buffer = await fs.readFile(filePath);
            const encoding = QueryFileHandlers.detectEncoding(buffer);
            const content = QueryFileHandlers.decode(buffer);
            this._post({ command: 'sqlFileOpened', path: filePath, name: path.basename(filePath), content, encoding });
        } catch (error) {
            this._post({ command: 'sqlFileError', message: `Could not open ${path.basename(filePath)}: ${error.message}` });
        }
    }

    async handleSaveSqlFile(filePath, content, encoding) {
        if (!this._isInsideWorkspace(filePath)) {
            this._post({ command: 'sqlFileSaved', path: filePath, success: false, message: `Refusing to save a file outside the workspace: ${filePath}` });
            return;
        }
        try {
            await fs.writeFile(filePath, QueryFileHandlers.encode(content, encoding));
            this._post({ command: 'sqlFileSaved', path: filePath, success: true });
        } catch (error) {
            this._post({ command: 'sqlFileSaved', path: filePath, success: false, message: error.message });
        }
    }

    // The Save As dialog: resolves to the chosen uri, or undefined.
    _pickSaveFile(defaultPath) {
        return vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(defaultPath), filters: { SQL: ['sql'] } });
    }

    async handleSaveSqlFileAs(content, suggestedName, encoding) {
        const root = this._workspaceRoot();
        const defaultDir = root || require('os').homedir();
        try {
            const uri = await this._pickSaveFile(path.join(defaultDir, suggestedName || 'query.sql'));
            if (!uri) {
                this._post({ command: 'sqlFileSavedAs', cancelled: true });
                return;
            }
            await fs.writeFile(uri.fsPath, QueryFileHandlers.encode(content, encoding));
            this._savedAs.add(path.resolve(uri.fsPath));
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
