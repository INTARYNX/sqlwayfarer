/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Full CRUD view of SQL snippets, hosted in the activity bar sidebar (see
// panels/SnippetSidebarProvider.js) so it's reachable without a SQL Wayfarer
// tab open: lists built-in snippets (read-only, duplicate-to-customize)
// alongside custom ones (edit/duplicate/delete), backed by the same
// addSnippet/deleteSnippet/updateSnippet commands the Query editor's own
// quick "Snippets" dropdown uses - snippets are global, so an edit made here
// is broadcast to every open tab's dropdown too (see SnippetHandlers).
// Same look as the connections: filter and "+" on top, rows, an inline form.
class SnippetManager {
    constructor() {
        this.customSnippets = [];
        this.editingOriginalName = null;
        this.initDOMElements();
        this.initEventListeners();
        vscode.postMessage({ command: 'getSnippets' });
    }

    initDOMElements() {
        const byId = id => document.getElementById(id);
        this.elements = {
            listView: byId('snippetListView'),
            formView: byId('snippetFormView'),
            newBtn: byId('newSnippetBtn'),
            importBtn: byId('importSnippetsBtn'),
            status: byId('snippetsStatus'),
            abbrInput: byId('snippetAbbrInput'),
            filter: byId('snippetFilter'),
            list: byId('snippetManagerList'),
            backBtn: byId('snippetFormBackBtn'),
            formTitle: byId('snippetFormTitle'),
            saveBtn: byId('saveSnippetBtn'),
            nameInput: byId('snippetNameInput'),
            sqlInput: byId('snippetSqlInput'),
            formStatus: byId('snippetFormStatus')
        };
    }

    initEventListeners() {
        const e = this.elements;
        e.newBtn.addEventListener('click', () => this.openForm());
        e.importBtn.addEventListener('click', () => {
            this.showStatus('', '');
            vscode.postMessage({ command: 'importSnippets' });
        });
        e.backBtn.addEventListener('click', () => this.closeForm());
        e.saveBtn.addEventListener('click', () => this.saveForm());
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !e.formView.hidden) this.closeForm();
        });
        e.filter.addEventListener('input', () => this.renderList());
        e.filter.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                e.filter.value = '';
                this.renderList();
            }
        });

        // Rows are re-rendered on every update: one delegated listener instead
        // of per-row bindings.
        e.list.addEventListener('click', event => {
            const row = event.target.closest('[data-snippet-name]');
            if (!row) return;
            const button = event.target.closest('button[data-snippet-action]');
            // A custom snippet opens for editing; a built-in one has no
            // default action (it is only duplicated, from its button).
            const action = button ? button.dataset.snippetAction
                : (row.dataset.snippetBuiltin === 'true' ? null : 'edit');
            this.runAction(row, action);
        });
        e.list.addEventListener('keydown', event => {
            const row = event.target.closest('[data-snippet-name]');
            if (!row || event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return;
            event.preventDefault();
            this.runAction(row, 'edit');
        });
    }

    runAction(row, action) {
        const name = row.dataset.snippetName;
        const isBuiltin = row.dataset.snippetBuiltin === 'true';
        if (action === 'edit') this.editCustomSnippet(name);
        else if (action === 'duplicate') this.duplicateSnippet(name, isBuiltin);
        else if (action === 'delete') this.deleteSnippet(name);
    }

    onSnippetsLoaded(snippets) {
        this.customSnippets = snippets || [];
        this.renderList();
    }

    matchesFilter(snippet) {
        const needle = this.elements.filter.value.trim().toLowerCase();
        return !needle || snippet.name.toLowerCase().includes(needle) || snippet.sql.toLowerCase().includes(needle)
            || (snippet.abbreviation || '').toLowerCase().includes(needle) || (snippet.description || '').toLowerCase().includes(needle);
    }

    // The answer of an import: what came in, in a line.
    onSnippetsImported(message) {
        const parts = [];
        if (message.added) parts.push(`${message.added} imported`);
        if (message.overwritten) parts.push(`${message.overwritten} overwritten`);
        if (message.leftOut) parts.push(`${message.leftOut} already existed and were kept`);
        if (message.skippedFiles) parts.push(`${message.skippedFiles} file${message.skippedFiles === 1 ? '' : 's'} could not be read`);
        const failed = !message.added && !message.overwritten;
        this.showStatus(parts.length ? `Snippets: ${parts.join(', ')}.` : 'Nothing imported.', failed ? 'error' : 'success');
    }

    showStatus(message, type) {
        this.elements.status.className = 'sb-status ' + type;
        this.elements.status.textContent = message;
    }

    renderList() {
        const filtering = this.elements.filter.value.trim() !== '';
        const custom = this.customSnippets.filter(s => this.matchesFilter(s));
        const builtin = BUILTIN_SNIPPETS.filter(s => this.matchesFilter(s));

        let html = '';
        if (custom.length > 0) {
            html += `<div class="sb-group-label">Custom</div>${custom.map(s => this.buildRowHtml(s.name, s.sql, false, s)).join('')}`;
        } else if (!filtering && this.customSnippets.length === 0) {
            html += '<div class="sb-group-label">Custom</div><p class="sb-empty">No custom snippet yet.<br>Click + to add one.</p>';
        }
        if (builtin.length > 0) {
            html += `<div class="sb-group-label">Built-in</div>${builtin.map(s => this.buildRowHtml(s.name, s.sql, true)).join('')}`;
        }
        if (!html) html = '<p class="sb-empty">No snippet matches.</p>';
        this.elements.list.innerHTML = html;
    }

    buildRowHtml(name, sql, isBuiltin, snippet = null) {
        const preview = sql.replace(/\s+/g, ' ').trim().slice(0, 90);
        const actions = isBuiltin
            ? `<button type="button" class="sb-icon-btn" data-snippet-action="duplicate" title="Duplicate as a custom snippet" aria-label="Duplicate"><i class="codicon codicon-copy"></i></button>`
            : `<button type="button" class="sb-icon-btn" data-snippet-action="edit" title="Edit" aria-label="Edit"><i class="codicon codicon-edit"></i></button>
               <button type="button" class="sb-icon-btn" data-snippet-action="duplicate" title="Duplicate" aria-label="Duplicate"><i class="codicon codicon-copy"></i></button>
               <button type="button" class="sb-icon-btn" data-snippet-action="delete" title="Delete" aria-label="Delete"><i class="codicon codicon-trash"></i></button>`;
        const interactive = isBuiltin ? '' : ' clickable" role="button" tabindex="0';

        return `<div class="sb-row${interactive}" data-snippet-name="${this.escapeHtml(name)}" data-snippet-builtin="${isBuiltin}">
            <i class="codicon codicon-${isBuiltin ? 'lock' : 'code'} sb-row-icon"></i>
            <div class="sb-row-main">
                <div class="sb-row-name">${this.escapeHtml(name)}${snippet && snippet.abbreviation && snippet.abbreviation.toLowerCase() !== name.toLowerCase() ? ` <span class="sb-badge" title="Abbreviation: type it in the editor to expand the snippet">${this.escapeHtml(snippet.abbreviation)}</span>` : ''}</div>
                <div class="sb-row-sub" title="${this.escapeHtml(snippet && snippet.description ? snippet.description : '')}">${this.escapeHtml(snippet && snippet.description ? snippet.description : preview)}</div>
            </div>
            <div class="sb-row-actions">${actions}</div>
        </div>`;
    }

    openForm(snippet = null) {
        const e = this.elements;
        this.editingOriginalName = snippet ? snippet.name : null;
        e.formTitle.textContent = snippet ? `Edit ${snippet.name}` : 'New snippet';
        e.nameInput.value = snippet ? snippet.name : '';
        e.sqlInput.value = snippet ? snippet.sql : '';
        e.abbrInput.value = snippet && snippet.abbreviation ? snippet.abbreviation : '';
        this.showFormStatus('', '');
        e.listView.hidden = true;
        e.formView.hidden = false;
        e.nameInput.focus();
    }

    closeForm() {
        this.elements.formView.hidden = true;
        this.elements.listView.hidden = false;
        this.editingOriginalName = null;
    }

    editCustomSnippet(name) {
        const snippet = this.customSnippets.find(s => s.name === name);
        if (snippet) this.openForm(snippet);
    }

    duplicateSnippet(name, isBuiltin) {
        const source = isBuiltin
            ? BUILTIN_SNIPPETS.find(s => s.name === name)
            : this.customSnippets.find(s => s.name === name);
        if (!source) return;

        this.openForm();
        this.elements.nameInput.value = `${source.name} (copy)`;
        this.elements.sqlInput.value = source.sql;
        this.elements.nameInput.select();
    }

    // The extension asks - a webview cannot show a dialog of its own.
    deleteSnippet(name) {
        vscode.postMessage({ command: 'confirmDeleteSnippet', name });
    }

    saveForm() {
        const name = this.elements.nameInput.value.trim();
        const sql = this.elements.sqlInput.value.trim();
        if (!name) {
            this.showFormStatus('Name is required.', 'error');
            return;
        }
        if (!sql) {
            this.showFormStatus('SQL is required.', 'error');
            return;
        }
        const clashesWithBuiltin = BUILTIN_SNIPPETS.some(s => s.name === name);
        if (clashesWithBuiltin && name !== this.editingOriginalName) {
            this.showFormStatus('That name is already used by a built-in snippet.', 'error');
            return;
        }

        const clashesWithCustom = this.customSnippets.some(s => s.name === name && s.name !== this.editingOriginalName);
        if (clashesWithCustom) {
            this.showFormStatus('A custom snippet with that name already exists.', 'error');
            return;
        }

        const abbreviation = this.elements.abbrInput.value.trim();
        // An edit always goes through update, renamed or not: it keeps what
        // the form does not show (description, placeholders) of an imported snippet.
        if (this.editingOriginalName) {
            vscode.postMessage({ command: 'updateSnippet', oldName: this.editingOriginalName, newName: name, sql, abbreviation });
        } else {
            vscode.postMessage({ command: 'addSnippet', name, sql, abbreviation });
        }
        this.closeForm();
    }

    showFormStatus(message, type) {
        this.elements.formStatus.className = 'sb-status ' + type;
        this.elements.formStatus.textContent = message;
    }

    escapeHtml(text) {
        if (text === null || text === undefined) return '';
        return String(text).replace(/[&<>"']/g, ch => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
        ));
    }
}
