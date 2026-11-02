'use strict';

// The dialogs of the connection import, on VS Code's own pickers (a webview
// cannot show one). Kept apart so the import itself can be tested without them.
function createVsCodeConnectionImportUi(vscode) {
    return {
        // 'cms' | 'file' | undefined (cancelled).
        async pickSource() {
            const picked = await vscode.window.showQuickPick([
                { label: '$(server) From a Central Management Server…', description: 'reads its registered servers and groups', value: 'cms' },
                { label: '$(file) From a registered servers file…', description: '.regsrvr, exported by SSMS', value: 'file' }
            ], { title: 'Import connections', placeHolder: 'Where are the servers?' });
            return picked ? picked.value : undefined;
        },

        // The saved connection that reaches the CMS: its name, or undefined.
        async pickCmsConnection(saved) {
            const picked = await vscode.window.showQuickPick(
                saved.map(c => ({ label: c.name, description: c.server })).sort((a, b) => a.label.localeCompare(b.label)),
                { title: 'Central Management Server', placeHolder: 'Which saved connection is the Central Management Server?' }
            );
            return picked ? picked.label : undefined;
        },

        async pickFile() {
            const uris = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { 'Registered servers': ['regsrvr', 'xml'], 'All files': ['*'] },
                openLabel: 'Import',
                title: 'Import registered servers'
            });
            return uris && uris[0] ? uris[0].fsPath : undefined;
        },

        // plan: [{ entry, config, sameName, sameTarget }] -> the chosen ones.
        // What is saved already starts unchecked.
        async pickEntries(plan) {
            const items = [];
            let group = null;
            const ordered = plan.slice().sort((a, b) => (a.entry.group || '').localeCompare(b.entry.group || '', undefined, { numeric: true, sensitivity: 'base' })
                || a.config.name.localeCompare(b.config.name, undefined, { numeric: true, sensitivity: 'base' }));
            for (const item of ordered) {
                const itemGroup = item.entry.group || '';
                if (itemGroup !== group) {
                    group = itemGroup;
                    items.push({ kind: vscode.QuickPickItemKind.Separator, label: group || 'No group' });
                }
                const target = item.config.server + (item.config.port ? `:${item.config.port}` : '');
                const note = item.sameName ? 'already saved - would be overwritten'
                    : item.sameTarget ? `same server as '${item.sameTarget}'` : '';
                items.push({
                    label: item.config.name,
                    description: target,
                    detail: note || undefined,
                    picked: !item.sameName && !item.sameTarget,
                    item
                });
            }
            const picked = await vscode.window.showQuickPick(items, {
                canPickMany: true,
                title: `Import connections (${plan.length} found)`,
                placeHolder: 'Check the servers to import - no password is imported'
            });
            return picked ? picked.map(p => p.item) : undefined;
        },

        info(message) { vscode.window.showInformationMessage(message); },
        error(message) { vscode.window.showErrorMessage(message); }
    };
}

module.exports = { createVsCodeConnectionImportUi };
