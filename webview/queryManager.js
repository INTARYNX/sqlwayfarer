/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Query tool: runs free-form SQL against the currently selected database.
// Supports multiple result sets, row cap, cancellation and a persisted history.
class QueryManager {
    // Rows drawn in the grid. The extension caps what it fetches (200 000
    // rows), but the webview builds the whole table as one HTML string:
    // 200 000 rows x 10 columns is tens of megabytes of markup, which
    // freezes the tab and can take the renderer down with it. The data
    // itself is untouched - Copy and CSV export work on the full result
    // set, only the grid shows a prefix of it.
    static MAX_RENDERED_ROWS = 2000;
    static DEFAULT_COLUMN_WIDTH = 120;
    static SYNTAX_CHECK_DELAY_MS = 700;
    static SYNTAX_RETRY_MS = 35000;
    static MIN_COLUMN_WIDTH = 40;

    constructor() {
        this.runBtn = document.getElementById('runQueryBtn');
        this.estimatedPlanBtn = document.getElementById('estimatedPlanBtn');
        this.includeActualPlanToggle = document.getElementById('includeActualPlanToggle');
        this.queryGraphBtn = document.getElementById('queryGraphBtn');
        this.formatBtn = document.getElementById('formatQueryBtn');
        // SSMS-style "Include Actual Execution Plan" toggle (Ctrl+M) - when on,
        // Run Query also captures the real plan instead of needing a separate action.
        this.includeActualPlan = false;
        this.cancelBtn = document.getElementById('cancelQueryBtn');
        this.maxRowsSelect = document.getElementById('maxRowsSelect');
        this.historySelect = document.getElementById('queryHistorySelect');
        this.snippetsSelect = document.getElementById('querySnippetsSelect');
        this.input = window.SqlCodeMirror.attach(document.getElementById('queryInput'), {
            placeholder: 'SELECT TOP 100 * FROM ...'
        });
        this.status = document.getElementById('queryStatus');
        this.transactionBar = document.getElementById('queryTransaction');
        this.transactionText = document.getElementById('queryTransactionText');
        this.resultsContainer = document.getElementById('queryResultsContainer');
        this.history = [];
        this.customSnippets = [];
        this.lastResultSets = [];
        this._gridState = [];
        this.isRunning = false;
        this.splitter = document.getElementById('querySplitter');
        this.autocomplete = new SqlAutocomplete(this.input);
        this.initEventListeners();
        this.initSplitter();
        vscode.postMessage({ command: 'getQueryHistory' });
        vscode.postMessage({ command: 'getSnippets' });
    }

    initEventListeners() {
        this.runBtn.addEventListener('click', () => this.runQuery());
        document.getElementById('queryCommitBtn').addEventListener('click', () => this.endTransaction('commit'));
        document.getElementById('queryRollbackBtn').addEventListener('click', () => this.endTransaction('rollback'));
        // "Line N" in an error message: delegated, the results are re-rendered.
        const onErrorLine = (e) => {
            const link = e.target.closest && e.target.closest('.error-line-link');
            if (!link) return;
            if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            this.goToErrorLine(link.dataset.line);
        };
        this.resultsContainer.addEventListener('click', onErrorLine);
        this.resultsContainer.addEventListener('keydown', onErrorLine);
        this.estimatedPlanBtn.addEventListener('click', () => this.runEstimatedPlan());
        this.includeActualPlanToggle.addEventListener('click', () => this.toggleIncludeActualPlan());
        if (this.queryGraphBtn) {
            this.queryGraphBtn.addEventListener('click', () => this.showQueryGraph());
        }
        if (this.formatBtn) this.formatBtn.addEventListener('click', () => this.formatQuery());
        this.input.addEventListener('sw-format', () => this.formatQuery());
        // Syntax check (the setting is the extension's, see setSyntaxEnabled): after a pause in typing.
        // The syntax check follows every change of the text, whoever made it:
        // a script loaded by the page has to be checked as well.
        this.input.addEventListener('content-changed', () => this.scheduleSyntaxCheck());
        this.cancelBtn.addEventListener('click', () => this.cancelQuery());
        this.historySelect.addEventListener('change', () => this.applyHistorySelection());
        this.snippetsSelect.addEventListener('change', () => this.applySnippetSelection());
        this.input.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                this.runQuery();
            }
        });
        // F5 is SSMS's own "Execute" shortcut - matched here regardless of which
        // widget inside the Query tab has focus (editor, grid, max rows...), the
        // same reach F5 has in SSMS. Scoped to the Query tab being active so it
        // doesn't fire while the user is on Explorer.
        // Capture phase on window, and stopPropagation(): VS Code forwards the
        // webview's key events to the workbench, where F5 is bound to "Select
        // debugger" - so without stopping the event here, running a query also
        // pops that picker up in the middle of the screen.
        window.addEventListener('keydown', (e) => {
            if (e.key !== 'F5' || appState.activeTab !== 'query') return;
            e.preventDefault();
            e.stopPropagation();
            this.runQuery();
        }, true);
        // Ctrl+Click or double-click on an object name jumps to its definition in the Explorer
        this.input.addEventListener('click', (e) => {
            if (e.ctrlKey || e.metaKey) this.goToDefinition();
        });
        this.input.addEventListener('dblclick', () => this.goToDefinition());
        // Tabs and Copy / CSV buttons are re-rendered with every result set: one
        // delegated listener on the container instead of per-element bindings.
        // Dragging the edge of a column header resizes it (double-click: back to automatic widths).
        this.resultsContainer.addEventListener('pointerdown', (e) => {
            const handle = e.target.closest('.rs-resizer');
            if (handle && e.button === 0) this.startColumnResize(handle, e);
        });
        this.resultsContainer.addEventListener('dblclick', (e) => {
            const handle = e.target.closest('.rs-resizer');
            if (!handle) return;
            const index = Number(handle.parentElement.dataset.rsIndex);
            if (this._gridState[index]) delete this._gridState[index].widths;
            this.rerenderResultTable(index);
        });
        this.resultsContainer.addEventListener('click', (e) => {
            // The handle belongs to the header, but a drag on it is not a sort.
            if (e.target.closest('.rs-resizer')) return;
            const tab = e.target.closest('button[data-rs-tab]');
            if (tab) {
                this.showResultSet(Number(tab.dataset.rsTab));
                return;
            }

            const th = e.target.closest('th[data-sort-col]');
            if (th) {
                this.sortResultSet(Number(th.dataset.rsIndex), th.dataset.sortCol);
                return;
            }

            const button = e.target.closest('button[data-rs-action]');
            if (!button) return;
            const index = Number(button.dataset.rsIndex);
            const set = this.lastResultSets[index];
            if (!set) return;
            const action = button.dataset.rsAction;
            if (action === 'copy') this.copyResultSet(set);
            else if (action === 'json') this.exportResultSetJson(set, index);
            else if (action === 'temp') this.scriptAsTempTable(set, index);
            else if (action === 'columns') this.showColumnNames(set);
            else if (action === 'more') this.showMoreRows(index, button.dataset.rsAll === '1');
            else this.exportResultSetCsv(set, index);
        });

        // Double-click a cell: its value goes to the clipboard.
        this.resultsContainer.addEventListener('dblclick', (e) => {
            const cell = e.target.closest('td');
            if (!cell || !this.resultsContainer.contains(cell)) return;
            navigator.clipboard.writeText(cell.textContent).then(
                () => this.setStatus('Cell copied to clipboard.', 'success'),
                () => this.setStatus('Copy to clipboard failed.', 'error')
            );
        });

        // Separate listener (not delegated through the click one above) so
        // typing in a filter box never re-creates the box itself - only the
        // table wrap it sits next to gets rebuilt, see rerenderResultTable.
        this.resultsContainer.addEventListener('input', (e) => {
            const input = e.target.closest('input[data-rs-filter]');
            if (!input) return;
            this.filterResultSet(Number(input.dataset.rsFilter), input.value);
        });
    }

    // Resolve the identifier under the caret (alias-aware) and reveal it in the Explorer.
    // Handles 1-part (bare/aliased), 2-part (schema.object) and 3-part
    // (database.schema.object) identifiers - the last form points at another
    // database on the same connection and can't be found in appState.allObjects,
    // which only holds the currently selected database's objects.
    goToDefinition() {
        const word = SqlAutocomplete.wordAt(this.input.value, this.input.selectionStart);
        if (!word) return;

        const clean = word.replace(/[[\]]/g, '');
        const aliases = SqlAutocomplete.parseAliases(this.input.value);
        const resolved = aliases[clean.toLowerCase()] || clean;

        const parts = resolved.split('.').filter(Boolean);
        const name = parts[parts.length - 1];
        const schema = parts.length >= 2 ? parts[parts.length - 2] : null;
        const database = parts.length >= 3 ? parts[parts.length - 3] : null;

        if (database && database.toLowerCase() !== (appState.currentDatabase || '').toLowerCase()) {
            if (window.explorerManager) {
                window.explorerManager.revealExternalObject(database, schema || 'dbo', name, { newTab: true });
            } else {
                this.setStatus(`Can't resolve '${clean}' from here.`, 'error');
            }
            return;
        }

        const target = (schema ? `${schema}.${name}` : name).toLowerCase();
        const obj = (appState.allObjects || []).find(o =>
            o.qualified_name.toLowerCase() === target ||
            (o.object_name || '').toLowerCase() === target ||
            (o.name || '').toLowerCase() === target
        );

        if (obj && window.explorerManager) {
            window.explorerManager.revealObject(obj);
        } else {
            this.setStatus(`No object named '${clean}' in this database.`, 'error');
        }
    }

    // Drag the bar between editor and results to resize the SQL input;
    // double-click resets to the default height. Resizes the wrapper, not the
    // editor itself - CodeMirror fills it via height:100% on its own.
    initSplitter() {
        const MIN_HEIGHT = 80;
        const wrap = this.input.parentElement;

        this.splitter.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startY = e.clientY;
            const startHeight = wrap.offsetHeight;
            const section = wrap.parentElement;
            this.splitter.classList.add('dragging');
            document.body.style.userSelect = 'none';

            const onMove = (ev) => {
                // keep at least 100px for the results pane below
                const maxHeight = section.clientHeight - 100;
                const height = Math.min(Math.max(startHeight + ev.clientY - startY, MIN_HEIGHT), maxHeight);
                wrap.style.height = `${height}px`;
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                this.splitter.classList.remove('dragging');
                document.body.style.userSelect = '';
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        this.splitter.addEventListener('dblclick', () => {
            wrap.style.height = ''; // back to the stylesheet's two thirds
        });
    }

    onObjectColumnsLoaded(message) {
        this.autocomplete.onColumnsLoaded(message.database, message.objectName, message.columns);
    }

    // Objects of a database other than the currently selected one, fetched on
    // demand for a "Database.Schema.Object" reference in the query editor.
    onAutocompleteObjectsLoaded(message) {
        this.autocomplete.onDatabaseObjectsLoaded(message.database, message.objects);
    }

    // A fresh connection may point at a different server - see SqlAutocomplete.onConnected.
    onConnected() {
        this.autocomplete.onConnected();
    }

    // The database the queries run on: the Explorer's, unless the schema is
    // read from another connection (then the "Run on" one, see SchemaSourceManager).
    targetDatabase() {
        return window.schemaSourceManager ? window.schemaSourceManager.targetDatabase() : appState.currentDatabase;
    }

    runsOnOtherConnection() {
        return !!(window.schemaSourceManager && window.schemaSourceManager.active);
    }

    // The target database changed: what can be run follows.
    refreshRunState() {
        this.setRunning(this.isRunning, this.cancelBtn.style.display !== 'none');
        if (this.targetDatabase() && /database to run on/.test(this.status.textContent)) this.setStatus('', '');
    }

    // Called by ExplorerManager whenever the shared database selector changes
    onDatabaseChanged(database) {
        this.autocomplete.reset();
        const target = this.targetDatabase();
        this.runBtn.disabled = !target || this.isRunning;
        this.estimatedPlanBtn.disabled = !target || this.isRunning;
        this.includeActualPlanToggle.disabled = !target || this.isRunning;
        if (this.queryGraphBtn) this.queryGraphBtn.disabled = !database;
        if (!this.isRunning) {
            this.setStatus(target ? '' : (this.runsOnOtherConnection() ? 'Choose the database to run on ("Run on").' : 'Select a database above to run queries.'), '');
        }
    }

    // Run a given SQL string right away (used by the per-object "Top 10"
    // shortcut in Explorer). An editor that holds text is not overwritten: the
    // query goes to a new draft tab, an empty editor is reused.
    runQueryText(sql) {
        if (this.openScriptInNewTab && (this.input.value || '').trim()) this.openScriptInNewTab(sql);
        else this.input.value = sql;
        this.runQuery();
    }

    // Graph of the objects a query touches: the tables it reads, how they
    // are joined, and the tables reached through the procedures and functions
    // it calls.
    //
    // Two scopes, both reachable by a plain click:
    //   - text selected: the graph covers THAT query only - the one selected
    //     inside a buffer that holds several.
    //   - nothing selected: the graph covers the whole query of the buffer.
    showQueryGraph() {
        const text = this.input.value || '';
        const selection = this.getSelectedText();
        const useSelection = selection !== null;
        const sql = (useSelection ? selection : text).trim();

        if (!sql) {
            this.setStatus(useSelection
                ? 'Nothing to graph - the selection is empty.'
                : 'Nothing to graph - the editor is empty.', 'error');
            return;
        }
        if (window.footprintManager) {
            window.footprintManager.openQueryGraph(sql, { scope: useSelection ? 'selection' : 'buffer' });
        }
    }

    // The selected text, or null when there is no selection (or only
    // whitespace around the caret).
    getSelectedText() {
        const text = this.input.value || '';
        const start = this.input.selectionStart || 0;
        const end = this.input.selectionEnd || 0;
        if (end <= start) return null;
        const selected = text.slice(start, end);
        return selected.trim() ? selected : null;
    }

    // Current editor text - used by QueryFileManager to snapshot a sub-tab
    // before switching away from it.
    getEditorContent() {
        return this.input.value;
    }

    // Swap the editor's content when switching between Query sub-tabs - no
    // focus/caret/status side effects, unlike setQueryText below.
    loadEditorContent(text) {
        this.input.value = text;
        // Ctrl+Z must not bring back the text of the tab that was open before.
        if (typeof this.input.resetHistory === 'function') this.input.resetHistory();
        // Another text: what was underlined belongs to the previous one.
        if (typeof this.input.setDiagnostics === 'function') this.input.setDiagnostics([]);
        this._syntaxText = null;
        this.scheduleSyntaxCheck();
    }

    // Fill the editor without running (used by the Explorer script generator)
    setQueryText(sql) {
        // The user asked for this text: the drafts follow it like they follow
        // a typed text. setUserText is the editor's way of saying so - with a
        // plain <textarea> there is no such distinction, and the value setter
        // fires nothing.
        if (typeof this.input.setUserText === 'function') this.input.setUserText(sql);
        else this.input.value = sql;
        this.input.focus();
        this.input.setSelectionRange(0, 0);
        this.input.scrollTop = 0;
        this.setStatus('Script inserted - review and run when ready.', '');
        this.scheduleSyntaxCheck();
    }

    // What a run sends: the selected text when there is some, else the whole
    // editor (as SSMS does). offset: the lines the server counts start after the
    // lines above the text sent and the blank ones at its top.
    runSource() {
        const full = this.input.value || '';
        const selected = this.getSelectedText();
        if (selected === null) return { query: full.trim(), offset: QueryManager.leadingBlankLines(full), isSelection: false };
        const linesAbove = (full.slice(0, this.input.selectionStart).match(/\n/g) || []).length;
        return { query: selected.trim(), offset: linesAbove + QueryManager.leadingBlankLines(selected), isSelection: true };
    }

    // The single entry point for the Run button, Ctrl+Enter and F5. Whether
    // this also captures the actual execution plan (SET STATISTICS XML, an
    // extra plan recordset per statement) depends only on the toggle - same
    // model as SSMS's Ctrl+M, instead of a separate "run with plan" action.
    runQuery() {
        const database = this.targetDatabase();
        const { query, offset, isSelection } = this.runSource();

        if (this.isRunning) return;
        if (!database) {
            this.setStatus(this.runsOnOtherConnection() ? 'Choose the database to run on first ("Run on").' : 'Select a database above first.', 'error');
            return;
        }
        if (!query) {
            this.setStatus('Enter a query first.', 'error');
            return;
        }

        this._runLineOffset = offset;
        this.setRunning(true);
        this.setStatus((this.includeActualPlan ? 'Running with actual execution plan' : 'Running') + (isSelection ? ' (selection)...' : '...'), '');
        this.setResultsHtml('<p class="placeholder-text">Running query...</p>');

        vscode.postMessage({
            command: this.includeActualPlan ? 'getActualPlan' : 'executeQuery',
            database,
            query,
            maxRows: Number(this.maxRowsSelect.value)
        });
    }

    toggleIncludeActualPlan() {
        this.includeActualPlan = !this.includeActualPlan;
        this.includeActualPlanToggle.classList.toggle('active', this.includeActualPlan);
        this.includeActualPlanToggle.title = this.includeActualPlan
            ? 'Include Actual Execution Plan: ON - Run Query (F5 / Ctrl+Enter) also captures the real plan'
            : 'Include Actual Execution Plan - when on, Run Query (F5 / Ctrl+Enter) also captures the real plan';
    }

    // SET SHOWPLAN_XML ON never executes the query - just compiles and plans
    // it - so unlike the other two there's nothing to cancel here.
    runEstimatedPlan() {
        const database = this.targetDatabase();
        const { query, offset } = this.runSource();

        if (this.isRunning) return;
        if (!database) {
            this.setStatus(this.runsOnOtherConnection() ? 'Choose the database to run on first ("Run on").' : 'Select a database above first.', 'error');
            return;
        }
        if (!query) {
            this.setStatus('Enter a query first.', 'error');
            return;
        }

        this._runLineOffset = offset;
        this.setRunning(true, false);
        this.setStatus('Generating estimated plan...', '');
        this.setResultsHtml('<p class="placeholder-text">Generating estimated plan...</p>');

        vscode.postMessage({ command: 'getEstimatedPlan', database, query });
    }

    // Formats the selection, or the whole script. Leaves the text alone when it
    // cannot be parsed.
    // === Syntax check ===
    //
    // The text goes to the extension 700 ms after the last edit; SQL Server parses
    // it there (database/SyntaxChecker.js) and the errors come back as lines.

    setSyntaxEnabled(enabled) {
        this.syntaxEnabled = !!enabled;
        if (this.syntaxEnabled) this.scheduleSyntaxCheck(true);
        else this.clearSyntaxDiagnostics();
    }

    clearSyntaxDiagnostics() {
        clearTimeout(this._syntaxTimer);
        clearTimeout(this._syntaxRetryTimer);
        this._syntaxId = (this._syntaxId || 0) + 1; // an answer still on its way is for nothing
        this._syntaxText = null;
        if (typeof this.input.setDiagnostics === 'function') this.input.setDiagnostics([]);
    }

    scheduleSyntaxCheck(force = false) {
        if (!this.syntaxEnabled) return;
        clearTimeout(this._syntaxTimer);
        this._syntaxTimer = setTimeout(() => this.requestSyntaxCheck(force), QueryManager.SYNTAX_CHECK_DELAY_MS);
    }

    requestSyntaxCheck(force) {
        if (!this.syntaxEnabled || typeof this.input.setDiagnostics !== 'function') return;
        const text = this.input.value;
        if (!text.trim()) { this.clearSyntaxDiagnostics(); return; }
        if (!force && text === this._syntaxText) return;
        this._syntaxText = text;
        this._syntaxId = (this._syntaxId || 0) + 1;
        vscode.postMessage({ command: 'checkSyntax', requestId: this._syntaxId, text });
    }

    onSyntaxResult(message) {
        // The answer of an older text, or for a text that has changed since: a newer check follows.
        if (message.requestId !== this._syntaxId || this.input.value !== this._syntaxText) return;
        if (message.unavailable) {
            // No connection for the check right now: what is shown stays, and the
            // text is asked again once the extension has had its pause.
            const text = this._syntaxText;
            this._syntaxText = null;
            clearTimeout(this._syntaxRetryTimer);
            this._syntaxRetryTimer = setTimeout(() => { if (this.syntaxEnabled && this.input.value === text) this.requestSyntaxCheck(false); }, QueryManager.SYNTAX_RETRY_MS);
            return;
        }
        this.input.setDiagnostics(message.diagnostics || []);
    }

    formatQuery() {
        if (typeof this.input.formatSql !== 'function') return;
        if (this.input.formatSql()) { this.setStatus('Formatted.', 'success'); this.scheduleSyntaxCheck(); }
        else this.setStatus('Could not format: the SQL could not be parsed. The text is unchanged.', 'error');
        this.input.focus();
    }

    cancelQuery() {
        if (!this.isRunning) return;
        this.setStatus('Cancelling...', '');
        vscode.postMessage({ command: 'cancelQuery' });
    }

    // Toggle the Run/Cancel pair while a query (or plan request) is in flight.
    // showCancel is false for the estimated plan, which has nothing to cancel.
    setRunning(running, showCancel = true) {
        this.isRunning = running;
        const target = this.targetDatabase();
        this.runBtn.disabled = running || !target;
        this.estimatedPlanBtn.disabled = running || !target;
        this.includeActualPlanToggle.disabled = running || !target;
        this.cancelBtn.style.display = (running && showCancel) ? '' : 'none';
    }

    endTransaction(action) {
        vscode.postMessage({ command: 'endTransaction', action });
    }

    // The bar exists only while a transaction is open on the tab's session.
    onTransactionState(message) {
        const count = Number(message.count) || 0;
        this.transactionBar.hidden = count === 0;
        this.transactionText.textContent = count === 1 ? 'Transaction open' : `Transaction open (${count} levels)`;
        if (message.error) this.status.textContent = message.error;
    }

    // JSON.stringify's own form for a Date: "2008-04-30T00:00:00.000Z".
    // Always milliseconds, always the 'Z' suffix - so the shape is exact.
    static JSON_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

    setStatus(message, type) {
        this.status.textContent = message;
        this.status.className = 'query-status' + (type ? ` ${type}` : '');
    }

    // Regex-based instead of a DOM element: called once per cell, so it has to be cheap.
    escapeHtml(text) {
        if (text === null || text === undefined) return '';
        return String(text).replace(/[&<>"']/g, ch => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
        ));
    }
}

// The class is written in four files: this one (the editor, the run, the
// transaction), queryResultsGrid.js, queryFormatting.js and
// querySnippetsHistory.js. In the webview the three parts are loaded first as
// globals; under Node (the tests) there is no shared scope, so they are
// required. Their methods - and their static ones - become QueryManager's.
const queryManagerParts = (typeof module !== 'undefined' && module.exports)
    ? [require('./queryResultsGrid'), require('./queryFormatting'), require('./querySnippetsHistory')]
    : [QueryResultsMethods, QueryFormattingMethods, QuerySnippetsMethods];
for (const Part of queryManagerParts) {
    for (const name of Object.getOwnPropertyNames(Part.prototype)) {
        if (name !== 'constructor') Object.defineProperty(QueryManager.prototype, name, Object.getOwnPropertyDescriptor(Part.prototype, name));
    }
    for (const name of Object.getOwnPropertyNames(Part)) {
        if (!['length', 'name', 'prototype'].includes(name)) Object.defineProperty(QueryManager, name, Object.getOwnPropertyDescriptor(Part, name));
    }
}

// Allow unit tests to require() this file; in the webview `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
    // The parts refer to QueryManager by name, as the webview scripts do.
    globalThis.QueryManager = QueryManager;
    module.exports = QueryManager;
}
