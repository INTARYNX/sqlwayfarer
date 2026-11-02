'use strict';

// The dialogs of the snippet import, on VS Code's own pickers (a webview
// cannot show one). Kept apart so the import itself can be tested without them.
function createVsCodeImportUi(vscode) {
    return {
        // 'files' | 'folder' | undefined (cancelled). On Windows and Linux one
        // dialog cannot pick both, so the user says which first.
        async pickSource() {
            const picked = await vscode.window.showQuickPick([
                { label: '$(files) Choose snippet files…', value: 'files' },
                { label: '$(folder-opened) Choose a folder…', description: 'every .sqlpromptsnippet file in it, subfolders included', value: 'folder' }
            ], { title: 'Import SQL Prompt snippets', placeHolder: 'Where are the snippets?' });
            return picked ? picked.value : undefined;
        },

        async pickPaths(source) {
            const uris = await vscode.window.showOpenDialog({
                canSelectMany: source === 'files',
                canSelectFiles: source === 'files',
                canSelectFolders: source === 'folder',
                filters: source === 'files' ? { 'SQL Prompt snippets': ['sqlpromptsnippet'], 'All files': ['*'] } : undefined,
                openLabel: 'Import',
                title: source === 'files' ? 'Import SQL Prompt snippets' : 'Import every snippet of a folder'
            });
            return uris ? uris.map(uri => uri.fsPath) : undefined;
        },

        // 'import' | 'overwrite' | undefined (cancelled).
        async confirmImport({ found, duplicates, skipped, truncated }) {
            const lines = [];
            if (duplicates.length) lines.push(`Already saved under the same name (${duplicates.length}): ${duplicates.slice(0, 8).join(', ')}${duplicates.length > 8 ? ', ...' : ''}`);
            if (skipped.length) lines.push(`Not readable (${skipped.length}): ${skipped.slice(0, 5).map(s => `${s.path.split(/[\\/]/).pop()} - ${s.reason}`).join(' | ')}${skipped.length > 5 ? ' | ...' : ''}`);
            if (truncated) lines.push('Only the first 5000 files were read.');
            const buttons = duplicates.length ? ['Import, keep the existing ones', 'Import and overwrite'] : ['Import'];
            const answer = await vscode.window.showInformationMessage(
                `${found} snippet${found === 1 ? '' : 's'} found.`,
                { modal: true, detail: lines.join('\n') || undefined },
                ...buttons
            );
            if (!answer) return undefined;
            return answer === 'Import and overwrite' ? 'overwrite' : 'import';
        },

        info(message) {
            vscode.window.showInformationMessage(message);
        }
    };
}

module.exports = { createVsCodeImportUi };
