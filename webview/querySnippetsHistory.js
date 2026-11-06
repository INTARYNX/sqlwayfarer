/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// The part of the Query tool that inserts text into the editor: the history of
// the queries and the snippets. Mixed into QueryManager (see queryManager.js),
// so `this` is the QueryManager.

// webview/builtinSnippets.js is loaded first (see index.html) and declares
// BUILTIN_SNIPPETS as a bare script-scope global, the same way sqlAutocomplete.js's
// SqlAutocomplete class is referenced below without an import - classic
// <script> tags share one global scope. Under Node (require()'d by tests),
// there is no such shared scope, so pull it in explicitly there instead.
function builtinSnippets() {
    return (typeof module !== 'undefined' && module.exports) ? require('./builtinSnippets') : BUILTIN_SNIPPETS;
}

class QuerySnippetsMethods {
    // === History ===

    onHistoryLoaded(history) {
        this.history = history || [];
        this.historySelect.innerHTML = '<option value="">History…</option>';

        this.history.forEach((entry, index) => {
            const option = document.createElement('option');
            const time = new Date(entry.timestamp);
            const timeLabel = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
            const queryLabel = entry.query.replace(/\s+/g, ' ').slice(0, 60);
            option.value = String(index);
            option.textContent = `${entry.success ? '' : 'Failed · '}${timeLabel} [${entry.database}] ${queryLabel}`;
            this.historySelect.appendChild(option);
        });

        if (this.history.length > 0) {
            const clearOption = document.createElement('option');
            clearOption.value = 'clear';
            clearOption.textContent = 'Clear history';
            this.historySelect.appendChild(clearOption);
        }
    }

    applyHistorySelection() {
        const value = this.historySelect.value;
        this.historySelect.value = '';
        if (!value) return;

        if (value === 'clear') {
            vscode.postMessage({ command: 'clearQueryHistory' });
            return;
        }

        const entry = this.history[Number(value)];
        if (entry) {
            this.input.value = entry.query;
            this.input.focus();
        }
    }

    // === Snippets ===

    onSnippetsLoaded(snippets) {
        this.customSnippets = snippets || [];
        this.autocomplete.setSnippets(this.customSnippets);
        this.renderSnippetsMenu();
    }

    renderSnippetsMenu() {
        this.snippetsSelect.innerHTML = '<option value="">Snippets…</option>';

        const builtinGroup = document.createElement('optgroup');
        builtinGroup.label = 'Built-in';
        builtinSnippets().forEach((snippet, index) => {
            const option = document.createElement('option');
            option.value = `builtin:${index}`;
            option.textContent = snippet.name;
            builtinGroup.appendChild(option);
        });
        this.snippetsSelect.appendChild(builtinGroup);

        if (this.customSnippets.length > 0) {
            const customGroup = document.createElement('optgroup');
            customGroup.label = 'Custom';
            this.customSnippets.forEach(snippet => {
                const option = document.createElement('option');
                option.value = `custom:${snippet.name}`;
                option.textContent = snippet.name;
                customGroup.appendChild(option);
            });
            this.snippetsSelect.appendChild(customGroup);
        }

        const manageGroup = document.createElement('optgroup');
        manageGroup.label = 'Manage';
        const addOption = document.createElement('option');
        addOption.value = 'add';
        addOption.textContent = 'Save selection as snippet…';
        manageGroup.appendChild(addOption);
        if (this.customSnippets.length > 0) {
            const deleteOption = document.createElement('option');
            deleteOption.value = 'delete';
            deleteOption.textContent = 'Delete a custom snippet…';
            manageGroup.appendChild(deleteOption);
        }
        this.snippetsSelect.appendChild(manageGroup);
    }

    applySnippetSelection() {
        const value = this.snippetsSelect.value;
        this.snippetsSelect.value = '';
        if (!value) return;

        if (value === 'add') {
            this.saveSelectionAsSnippet();
            return;
        }
        if (value === 'delete') {
            this.deleteCustomSnippet();
            return;
        }

        let sql = null;
        if (value.startsWith('builtin:')) {
            const snippet = builtinSnippets()[Number(value.slice('builtin:'.length))];
            sql = snippet && snippet.sql;
        } else if (value.startsWith('custom:')) {
            const name = value.slice('custom:'.length);
            const snippet = this.customSnippets.find(s => s.name === name);
            if (snippet && snippet.sql) {
                this.insertCustomSnippet(snippet);
                return;
            }
        }
        if (sql) this.insertAtCursor(sql);
    }

    // A custom snippet may carry placeholders ($Name$ fields to Tab through,
    // $CURSOR$, $SELECTEDTEXT$ - as in the snippets imported from SQL Prompt).
    insertCustomSnippet(snippet) {
        const ta = this.input;
        ta.focus();
        if (typeof ta.insertSnippet === 'function') ta.insertSnippet(snippet.sql, snippet.placeholders || []);
        else this.insertAtCursor(snippet.sql);
    }

    // Saves the selected text (or the whole editor content, if nothing is
    // selected) as a reusable custom snippet under a name the user picks.
    // Naming happens through VS Code's native input box (requested via
    // promptSnippetName/onSnippetNamePrompted) - window.prompt() doesn't
    // work in a webview, Electron never implemented it.
    saveSelectionAsSnippet() {
        const selected = this.input.value.slice(this.input.selectionStart, this.input.selectionEnd).trim();
        const sql = selected || this.input.value.trim();
        if (!sql) {
            this.setStatus('Nothing to save: select some SQL, or write a query first.', 'error');
            return;
        }
        this._pendingSnippetSql = sql;
        vscode.postMessage({ command: 'promptSnippetName' });
    }

    // Response to the promptSnippetName request above.
    onSnippetNamePrompted(name) {
        const sql = this._pendingSnippetSql;
        this._pendingSnippetSql = null;
        if (!name || !name.trim() || !sql) return;
        vscode.postMessage({ command: 'addSnippet', name: name.trim(), sql });
    }

    deleteCustomSnippet() {
        if (this.customSnippets.length === 0) return;
        vscode.postMessage({ command: 'promptDeleteSnippet' });
    }

    // Splices text into the editor at the current caret (or over the current
    // selection) instead of replacing the whole query, like SqlAutocomplete's
    // own accept() does for a completion.
    insertAtCursor(text) {
        const ta = this.input;
        ta.focus();
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        // Replace the range, not the whole document: the snippet stays one
        // undo step, and the query around it is left untouched.
        if (typeof ta.replaceRange === 'function') {
            ta.replaceRange(start, end, text);
            return;
        }
        ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
        const caret = start + text.length;
        ta.setSelectionRange(caret, caret);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = QuerySnippetsMethods;
}
