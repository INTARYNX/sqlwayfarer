'use strict';

const { collectSnippetFiles, toStoredSnippet, mergeSnippets, planImport } = require('../../database/snippetImport');
const { parseSqlPromptSnippetFiles } = require('../../database/sqlPromptSnippet');

// The editor API is loaded when a dialog is needed, so the rest of this file
// can be tested without VS Code.
const BUILTIN_NAMES = require('../../webview/builtinSnippets').map(s => s.name);
const vscodeApi = () => require('vscode');

const SNIPPETS_KEY = 'sqlwayfarer.customSnippets';

// Custom snippets are personal productivity templates, not tied to a single
// project, so they're stored in globalState (like the query history and the
// drafts, which follow the connection, not the folder that is open).
class SnippetHandlers {
    constructor(postMessage, globalState, broadcast = postMessage, importUi = null) {
        this._post = postMessage;
        this._globalState = globalState;
        this._importUi = importUi;
        // Snippets live in globalState - already shared by every open tab -
        // but each tab also keeps its own in-memory copy fetched once at
        // load, so a change made in one tab needs to be pushed to every
        // other open tab too, not just posted back to whichever tab made it.
        this._broadcast = broadcast;
    }

    async handleGetSnippets() {
        this._post({ command: 'snippetsLoaded', snippets: this._getSnippets() });
    }

    // window.prompt() isn't implemented in Electron's webview renderer (it
    // silently returns null, no dialog ever shows) - naming/picking a
    // snippet has to go through VS Code's own native input box / quick pick.
    async handlePromptSnippetName() {
        const name = await vscodeApi().window.showInputBox({
            prompt: 'Snippet name',
            placeHolder: 'e.g. Select top 100',
            validateInput: value => (value && value.trim() ? null : 'Name is required')
        });
        this._post({ command: 'snippetNamePrompted', name });
    }

    async handlePromptDeleteSnippet() {
        const snippets = this._getSnippets();
        if (snippets.length === 0) return;
        const picked = await vscodeApi().window.showQuickPick(
            snippets.map(s => s.name),
            { placeHolder: 'Delete which snippet?' }
        );
        if (picked) await this.handleDeleteSnippet(picked);
    }

    // Adding a snippet with an existing name overwrites it, so re-saving a
    // tweaked version doesn't pile up duplicates.
    async handleAddSnippet(name, sql, abbreviation) {
        if (!name || !name.trim() || !sql || !sql.trim()) return;
        const all = this._getSnippets();
        const snippets = all.filter(s => s.name !== name.trim());
        // Re-saving keeps what the form does not show (description, fields, source).
        const snippet = Object.assign({}, all.find(s => s.name === name.trim()), { name: name.trim(), sql, createdAt: Date.now() });
        if (abbreviation && abbreviation.trim()) snippet.abbreviation = abbreviation.trim();
        else if (abbreviation !== undefined) delete snippet.abbreviation;
        snippets.push(snippet);
        snippets.sort((a, b) => a.name.localeCompare(b.name));
        await this._globalState.update(SNIPPETS_KEY, snippets);
        this._broadcast({ command: 'snippetsLoaded', snippets });
    }

    // Rename and/or content update in one go. The webview already refuses to
    // submit a name collision, but never trust that as the only guard against
    // silently destroying a different snippet - if the target name is already
    // used by another snippet, refuse instead of dropping it.
    async handleUpdateSnippet(oldName, newName, sql, abbreviation) {
        if (!newName || !newName.trim() || !sql || !sql.trim()) return;
        const trimmedNew = newName.trim();
        const snippets = this._getSnippets();

        if (trimmedNew !== oldName && snippets.some(s => s.name === trimmedNew)) {
            this._post({ command: 'snippetsLoaded', snippets });
            return;
        }

        // What the form does not edit (description, placeholders, where it
        // came from) is kept: an imported snippet must stay a working one.
        const previous = snippets.find(s => s.name === oldName) || {};
        const updated = snippets.filter(s => s.name !== oldName);
        const next = Object.assign({}, previous, { name: trimmedNew, sql, createdAt: Date.now() });
        if (abbreviation !== undefined) {
            if (abbreviation && abbreviation.trim()) next.abbreviation = abbreviation.trim();
            else delete next.abbreviation;
        }
        updated.push(next);
        updated.sort((a, b) => a.name.localeCompare(b.name));
        await this._globalState.update(SNIPPETS_KEY, updated);
        this._broadcast({ command: 'snippetsLoaded', snippets: updated });
    }

    async handleDeleteSnippet(name) {
        const snippets = this._getSnippets().filter(s => s.name !== name);
        await this._globalState.update(SNIPPETS_KEY, snippets);
        this._broadcast({ command: 'snippetsLoaded', snippets });
    }

    // Imports SQL Prompt snippets (.sqlpromptsnippet) from files or a folder:
    // asks what to import, reads it, says what was found, and merges it with
    // the saved snippets once the user agrees.
    async handleImportSnippets() {
        const ui = this._importUi || require('./snippetImportUi').createVsCodeImportUi(vscodeApi());
        const source = await ui.pickSource();
        if (!source) return;
        const paths = await ui.pickPaths(source);
        if (!paths || paths.length === 0) return;

        const { files, skipped: unreadable, truncated } = await collectSnippetFiles(paths);
        const parsed = parseSqlPromptSnippetFiles(files);
        const skipped = [...unreadable, ...parsed.skipped];
        const imported = parsed.snippets.map(snippet => toStoredSnippet(snippet));
        if (imported.length === 0) {
            this._post({ command: 'snippetsImported', added: 0, overwritten: 0, leftOut: 0, skippedFiles: skipped.length });
            ui.info(skipped.length
                ? `No snippet could be read (${skipped.length} file${skipped.length === 1 ? '' : 's'} skipped): ${skipped[0].reason}`
                : 'No .sqlpromptsnippet file found.');
            return;
        }

        const plan = planImport(this._getSnippets(), imported, BUILTIN_NAMES);
        const choice = await ui.confirmImport({ found: imported.length, duplicates: plan.duplicates.map(s => s.name), skipped, truncated });
        if (!choice) return;

        // Read again: the saved snippets may have changed while the dialog was open.
        const result = mergeSnippets(this._getSnippets(), imported, choice === 'overwrite', BUILTIN_NAMES);
        await this._globalState.update(SNIPPETS_KEY, result.snippets);
        this._broadcast({ command: 'snippetsLoaded', snippets: result.snippets });
        this._post({ command: 'snippetsImported', added: result.added, overwritten: result.overwritten, leftOut: result.leftOut, skippedFiles: skipped.length });
    }

    _getSnippets() {
        return this._globalState.get(SNIPPETS_KEY, []);
    }
}

module.exports = SnippetHandlers;
