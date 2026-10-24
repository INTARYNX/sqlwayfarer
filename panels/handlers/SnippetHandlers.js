'use strict';

const vscode = require('vscode');

const SNIPPETS_KEY = 'sqlwayfarer.customSnippets';

// Custom snippets are personal productivity templates, not tied to a single
// project, so they're stored in globalState (unlike query history, which is
// workspaceState-scoped on purpose).
class SnippetHandlers {
    constructor(postMessage, globalState) {
        this._post = postMessage;
        this._globalState = globalState;
    }

    async handleGetSnippets() {
        this._post({ command: 'snippetsLoaded', snippets: this._getSnippets() });
    }

    // window.prompt() isn't implemented in Electron's webview renderer (it
    // silently returns null, no dialog ever shows) - naming/picking a
    // snippet has to go through VS Code's own native input box / quick pick.
    async handlePromptSnippetName() {
        const name = await vscode.window.showInputBox({
            prompt: 'Snippet name',
            placeHolder: 'e.g. Select top 100',
            validateInput: value => (value && value.trim() ? null : 'Name is required')
        });
        this._post({ command: 'snippetNamePrompted', name });
    }

    async handlePromptDeleteSnippet() {
        const snippets = this._getSnippets();
        if (snippets.length === 0) return;
        const picked = await vscode.window.showQuickPick(
            snippets.map(s => s.name),
            { placeHolder: 'Delete which snippet?' }
        );
        if (picked) await this.handleDeleteSnippet(picked);
    }

    // Adding a snippet with an existing name overwrites it, so re-saving a
    // tweaked version doesn't pile up duplicates.
    async handleAddSnippet(name, sql) {
        if (!name || !name.trim() || !sql || !sql.trim()) return;
        const snippets = this._getSnippets().filter(s => s.name !== name.trim());
        snippets.push({ name: name.trim(), sql, createdAt: Date.now() });
        snippets.sort((a, b) => a.name.localeCompare(b.name));
        await this._globalState.update(SNIPPETS_KEY, snippets);
        this._post({ command: 'snippetsLoaded', snippets });
    }

    // Rename and/or content update in one go: drops both the old and the new
    // name before re-adding, so a rename never leaves the old entry behind
    // and never collides with an existing snippet already using the new name.
    async handleUpdateSnippet(oldName, newName, sql) {
        if (!newName || !newName.trim() || !sql || !sql.trim()) return;
        const snippets = this._getSnippets().filter(s => s.name !== oldName && s.name !== newName.trim());
        snippets.push({ name: newName.trim(), sql, createdAt: Date.now() });
        snippets.sort((a, b) => a.name.localeCompare(b.name));
        await this._globalState.update(SNIPPETS_KEY, snippets);
        this._post({ command: 'snippetsLoaded', snippets });
    }

    async handleDeleteSnippet(name) {
        const snippets = this._getSnippets().filter(s => s.name !== name);
        await this._globalState.update(SNIPPETS_KEY, snippets);
        this._post({ command: 'snippetsLoaded', snippets });
    }

    _getSnippets() {
        return this._globalState.get(SNIPPETS_KEY, []);
    }
}

module.exports = SnippetHandlers;
