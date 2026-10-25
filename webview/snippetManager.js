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
class SnippetManager {
    constructor() {
        this.customSnippets = [];
        this.editingOriginalName = null;
        this.initDOMElements();
        this.initEventListeners();
        vscode.postMessage({ command: 'getSnippets' });
    }

    initDOMElements() {
        this.elements = {
            newBtn: document.getElementById('newSnippetBtn'),
            list: document.getElementById('snippetManagerList'),
            formOverlay: document.getElementById('snippetFormOverlay'),
            formTitle: document.getElementById('snippetFormTitle'),
            formCloseBtn: document.getElementById('snippetFormCloseBtn'),
            cancelFormBtn: document.getElementById('cancelSnippetFormBtn'),
            saveFormBtn: document.getElementById('saveSnippetBtn'),
            nameInput: document.getElementById('snippetNameInput'),
            sqlInput: document.getElementById('snippetSqlInput'),
            formStatus: document.getElementById('snippetFormStatus')
        };
    }

    initEventListeners() {
        this.elements.newBtn.addEventListener('click', () => this.openForm());
        this.elements.formCloseBtn.addEventListener('click', () => this.closeForm());
        this.elements.cancelFormBtn.addEventListener('click', () => this.closeForm());
        this.elements.saveFormBtn.addEventListener('click', () => this.saveForm());
        this.elements.formOverlay.addEventListener('click', (e) => {
            if (e.target === this.elements.formOverlay) this.closeForm();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.elements.formOverlay.classList.contains('visible')) {
                this.closeForm();
            }
        });

        // Rows are re-rendered on every update: one delegated listener instead
        // of per-row bindings.
        this.elements.list.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-snippet-action]');
            if (!btn) return;
            const row = btn.closest('[data-snippet-name]');
            if (!row) return;
            const name = row.dataset.snippetName;
            const isBuiltin = row.dataset.snippetBuiltin === 'true';

            if (btn.dataset.snippetAction === 'edit') this.editCustomSnippet(name);
            else if (btn.dataset.snippetAction === 'duplicate') this.duplicateSnippet(name, isBuiltin);
            else if (btn.dataset.snippetAction === 'delete') this.deleteSnippet(name);
        });
    }

    onSnippetsLoaded(snippets) {
        this.customSnippets = snippets || [];
        this.renderList();
    }

    renderList() {
        const builtinRows = BUILTIN_SNIPPETS.map(s => this.buildRowHtml(s.name, s.sql, true)).join('');
        const customRows = this.customSnippets.length > 0
            ? this.customSnippets.map(s => this.buildRowHtml(s.name, s.sql, false)).join('')
            : '<p class="placeholder-text">No custom snippets yet - click "+ New Snippet" to add one.</p>';

        this.elements.list.innerHTML = `
            <div class="snippet-group-label">Built-in</div>
            ${builtinRows}
            <div class="snippet-group-label">Custom</div>
            ${customRows}
        `;
    }

    buildRowHtml(name, sql, isBuiltin) {
        const preview = sql.replace(/\s+/g, ' ').trim().slice(0, 90);
        const actions = isBuiltin
            ? `<button type="button" data-snippet-action="duplicate" title="Duplicate as a custom snippet"><i class="codicon codicon-copy"></i></button>`
            : `<button type="button" data-snippet-action="edit" title="Edit"><i class="codicon codicon-edit"></i></button>
               <button type="button" data-snippet-action="duplicate" title="Duplicate"><i class="codicon codicon-copy"></i></button>
               <button type="button" data-snippet-action="delete" title="Delete"><i class="codicon codicon-trash"></i></button>`;

        return `<div class="snippet-row" data-snippet-name="${this.escapeHtml(name)}" data-snippet-builtin="${isBuiltin}">
            <div class="snippet-row-main">
                <div class="snippet-row-name">${this.escapeHtml(name)}</div>
                <div class="snippet-row-preview">${this.escapeHtml(preview)}</div>
            </div>
            <div class="snippet-row-actions">${actions}</div>
        </div>`;
    }

    openForm(snippet = null) {
        this.editingOriginalName = snippet ? snippet.name : null;
        this.elements.formTitle.textContent = snippet ? 'Edit Snippet' : 'New Snippet';
        this.elements.nameInput.value = snippet ? snippet.name : '';
        this.elements.sqlInput.value = snippet ? snippet.sql : '';
        this.elements.formStatus.textContent = '';
        this.elements.formOverlay.classList.add('visible');
        this.elements.nameInput.focus();
    }

    closeForm() {
        this.elements.formOverlay.classList.remove('visible');
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

    deleteSnippet(name) {
        if (!confirm(`Delete snippet "${name}"?`)) return;
        vscode.postMessage({ command: 'deleteSnippet', name });
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

        if (this.editingOriginalName && this.editingOriginalName !== name) {
            vscode.postMessage({ command: 'updateSnippet', oldName: this.editingOriginalName, newName: name, sql });
        } else {
            vscode.postMessage({ command: 'addSnippet', name, sql });
        }
        this.closeForm();
    }

    showFormStatus(message, type) {
        this.elements.formStatus.className = 'status ' + type;
        this.elements.formStatus.textContent = message;
    }

    escapeHtml(text) {
        if (text === null || text === undefined) return '';
        return String(text).replace(/[&<>"']/g, ch => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
        ));
    }
}
