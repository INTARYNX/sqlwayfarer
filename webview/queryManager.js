/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// webview/builtinSnippets.js is loaded first (see index.html) and declares
// BUILTIN_SNIPPETS as a bare script-scope global, the same way sqlAutocomplete.js's
// SqlAutocomplete class is referenced below without an import - classic
// <script> tags share one global scope. Under Node (require()'d by tests),
// there is no such shared scope, so pull it in explicitly there instead.
function builtinSnippets() {
    return (typeof module !== 'undefined' && module.exports) ? require('./builtinSnippets') : BUILTIN_SNIPPETS;
}

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

    copyResultSet(set) {
        const tsv = QueryManager.toDelimited(set, '\t');
        navigator.clipboard.writeText(tsv).then(
            () => this.setStatus(`Copied ${set.rows.length} row(s) to clipboard.`, 'success'),
            () => this.setStatus('Copy to clipboard failed.', 'error')
        );
    }

    exportResultSetCsv(set, index) {
        const suffix = this.lastResultSets.length > 1 ? `-${index + 1}` : '';
        // set is already capped to the Max rows limit by the time it gets here -
        // the CSV can only ever contain what's in it, never the full result set.
        this._pendingCsvTruncation = set.rows.length < set.totalRows
            ? { shown: set.rows.length, total: set.totalRows }
            : null;
        vscode.postMessage({
            command: 'exportCsv',
            csv: QueryManager.toDelimited(set, ','),
            defaultName: `query-results${suffix}.csv`
        });
    }

    exportResultSetJson(set, index) {
        const suffix = this.lastResultSets.length > 1 ? `-${index + 1}` : '';
        this._pendingCsvTruncation = set.rows.length < set.totalRows
            ? { shown: set.rows.length, total: set.totalRows }
            : null;
        vscode.postMessage({
            command: 'exportJson',
            json: QueryManager.toJson(set),
            defaultName: `query-results${suffix}.json`
        });
    }

    onCsvExported(message) {
        const truncation = this._pendingCsvTruncation;
        this._pendingCsvTruncation = null;
        const format = message.format || 'CSV';
        if (message.success) {
            const note = truncation
                ? ` (showing ${truncation.shown} of ${truncation.total} rows - raise Max rows to export more)`
                : '';
            this.setStatus(`${format} saved to ${message.path}${note}`, 'success');
        } else if (message.cancelled) {
            this.setStatus(`${format} export cancelled.`, '');
        } else {
            this.setStatus(`${format} export failed: ${message.message}`, 'error');
        }
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
                window.explorerManager.revealExternalObject(database, schema || 'dbo', name);
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
        const DEFAULT_HEIGHT = 140;
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
            wrap.style.height = `${DEFAULT_HEIGHT}px`;
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

    // Fill the editor with a given SQL string and run it immediately
    // (used by the per-object "Top 10" shortcut in Explorer).
    runQueryText(sql) {
        this.input.value = sql;
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
    }

    // Fill the editor without running (used by the Explorer script generator)
    setQueryText(sql) {
        this.input.value = sql;
        this.input.focus();
        this.input.setSelectionRange(0, 0);
        this.input.scrollTop = 0;
        this.setStatus('Script inserted - review and run when ready.', '');
    }

    // The single entry point for the Run button, Ctrl+Enter and F5. Whether
    // this also captures the actual execution plan (SET STATISTICS XML, an
    // extra plan recordset per statement) depends only on the toggle - same
    // model as SSMS's Ctrl+M, instead of a separate "run with plan" action.
    runQuery() {
        const database = this.targetDatabase();
        const query = this.input.value.trim();

        if (this.isRunning) return;
        if (!database) {
            this.setStatus(this.runsOnOtherConnection() ? 'Choose the database to run on first ("Run on").' : 'Select a database above first.', 'error');
            return;
        }
        if (!query) {
            this.setStatus('Enter a query first.', 'error');
            return;
        }

        this._runLineOffset = QueryManager.leadingBlankLines(this.input.value);
        this.setRunning(true);
        this.setStatus(this.includeActualPlan ? 'Running with actual execution plan...' : 'Running...', '');
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
        const query = this.input.value.trim();

        if (this.isRunning) return;
        if (!database) {
            this.setStatus(this.runsOnOtherConnection() ? 'Choose the database to run on first ("Run on").' : 'Select a database above first.', 'error');
            return;
        }
        if (!query) {
            this.setStatus('Enter a query first.', 'error');
            return;
        }

        this._runLineOffset = QueryManager.leadingBlankLines(this.input.value);
        this.setRunning(true, false);
        this.setStatus('Generating estimated plan...', '');
        this.setResultsHtml('<p class="placeholder-text">Generating estimated plan...</p>');

        vscode.postMessage({ command: 'getEstimatedPlan', database, query });
    }

    // Formats the selection, or the whole script. Leaves the text alone when it
    // cannot be parsed.
    formatQuery() {
        if (typeof this.input.formatSql !== 'function') return;
        if (this.input.formatSql()) this.setStatus('Formatted.', 'success');
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

    onQueryResult(message) {
        this.setRunning(false);
        const resultSets = message.resultSets || [];
        this.lastResultSets = resultSets;
        const duration = this.formatDuration(message.durationMs);
        const planXmls = message.planXmls || [];

        if (resultSets.length === 0) {
            const affected = Array.isArray(message.rowsAffected)
                ? message.rowsAffected.reduce((sum, n) => sum + n, 0)
                : 0;
            if (planXmls.length > 0) {
                this.displayResultSets(resultSets, message.timeline, planXmls);
            } else {
                let html = `<p class="placeholder-text">Query executed successfully. ${affected} row(s) affected.</p>`;
                html += this.buildMessagesBlock(message.timeline, resultSets);
                this.setResultsHtml(html);
            }
            this.setStatus(`Done in ${duration} — ${affected} row(s) affected.`, 'success');
            return;
        }

        this.displayResultSets(resultSets, message.timeline, planXmls);

        const totalShown = resultSets.reduce((sum, set) => sum + set.rows.length, 0);
        const totalRows = resultSets.reduce((sum, set) => sum + set.totalRows, 0);
        const truncated = totalShown < totalRows ? ` (showing ${totalShown} of ${totalRows})` : '';
        const setsLabel = resultSets.length > 1 ? `${resultSets.length} result sets, ` : '';
        this.setStatus(`Done in ${duration} — ${setsLabel}${totalRows} row(s)${truncated}.`, 'success');
    }

    // Response to getEstimatedPlan: never produces result sets or messages,
    // just the plan(s) - reuses displayResultSets so the Execution Plan tab
    // is built the exact same way as for an actual-plan run.
    onPlanResult(message) {
        this.setRunning(false);
        const planXmls = message.planXmls || [];
        this.lastResultSets = [];
        if (planXmls.length === 0) {
            this.setResultsHtml('<p class="placeholder-text">No execution plan was returned.</p>');
            this.setStatus('No plan returned.', 'error');
            return;
        }
        this.displayResultSets([], [], planXmls);
        // A GO-separated script is planned one batch at a time - some batches
        // can fail to plan (e.g. referencing an object only a later batch
        // creates) while others still produce a usable plan.
        const failedNote = message.planErrors?.length ? ` (${message.planErrors.length} batch(es) could not be planned)` : '';
        this.setStatus(`Estimated execution plan generated${failedNote}.`, 'success');
    }

    // The error text, escaped, with "Line N" turned into a link to that line of
    // the editor (the extension reports the line of the query that was run).
    static linkErrorLines(text, escape) {
        return escape(text).replace(/\bLine (\d+):/g,
            '<a class="error-line-link" role="button" tabindex="0" data-line="$1" title="Go to this line">Line $1</a>:');
    }

    // The query is trimmed before it is sent, so the lines the server counts
    // start after the blank lines at the top of the editor.
    static leadingBlankLines(text) {
        const leading = /^\s*/.exec(text || '')[0];
        return (leading.match(/\n/g) || []).length;
    }

    goToErrorLine(reportedLine) {
        if (typeof this.input.goToLine !== 'function') return;
        this.input.goToLine(Number(reportedLine) + (this._runLineOffset || 0));
    }

    onQueryError(message) {
        this.setRunning(false);
        const errorHtml = `<pre class="query-error-box">${QueryManager.linkErrorLines(message.message, t => this.escapeHtml(t))}</pre>`;

        if (Array.isArray(message.resultSets) && message.resultSets.length > 0) {
            // The batch failed partway through - show whatever it produced
            // before the error, with the error itself pinned above it, instead
            // of discarding results the user already paid the round-trip for.
            this.lastResultSets = message.resultSets;
            this.displayResultSets(message.resultSets, message.timeline || [], []);
            const scroll = this.resultsContainer.querySelector('.result-scroll');
            if (scroll) scroll.insertAdjacentHTML('afterbegin', errorHtml);
        } else {
            this.setResultsHtml(errorHtml);
        }

        const duration = message.durationMs ? ` after ${this.formatDuration(message.durationMs)}` : '';
        this.setStatus(message.cancelled ? `Query cancelled${duration}.` : `Query failed${duration}.`, 'error');
    }

    // Every innerHTML write on the results pane goes through here so the
    // scrollable area is always the same element - needed for the sticky
    // table header and for the tab strip above it to stay put while it scrolls.
    setResultsHtml(bodyHtml, tabsHtml = '') {
        this.resultsContainer.innerHTML = tabsHtml + `<div class="result-scroll">${bodyHtml}</div>`;
    }

    displayResultSets(resultSets, timeline, planXmls = []) {
        this.activeResultIndex = 0;
        // Filter/sort are per-grid view state, not data - every fresh run
        // starts clean instead of carrying over the previous run's filter.
        this._gridState = resultSets.map(() => ({ filterText: '', sortCol: null, sortDir: 1, limit: QueryManager.MAX_RENDERED_ROWS }));
        const hasMessages = !!(timeline && timeline.some(entry => entry.type === 'message'));
        const hasPlan = planXmls && planXmls.length > 0;

        // Tabs appear whenever there's more than one grid, or when prints/plan
        // need their own tab instead of being glued under whichever grid (if
        // any) is active.
        const tabsHtml = (resultSets.length > 1 || hasMessages || hasPlan)
            ? this.buildTabsHtml(resultSets, hasMessages, hasPlan)
            : '';

        let html = '';
        resultSets.forEach((set, index) => {
            html += `<div class="result-set-pane" data-rs-pane="${index}"${index === 0 ? '' : ' style="display:none;"'}>`
                + this.buildResultSetActionsHtml(set, index)
                + `<div class="result-set-table-wrap" data-rs-table="${index}">`
                + this.buildResultSetTableHtml(this.visibleRows(set, index), set.columns, index)
                + '</div></div>';
        });

        let nextIndex = resultSets.length;
        if (hasMessages) {
            html += `<div class="result-set-pane" data-rs-pane="${nextIndex}"${nextIndex === 0 ? '' : ' style="display:none;"'}>`
                + this.buildMessagesBlock(timeline, resultSets)
                + '</div>';
            nextIndex++;
        }
        if (hasPlan) {
            html += `<div class="result-set-pane" data-rs-pane="${nextIndex}"${nextIndex === 0 ? '' : ' style="display:none;"'}>`
                + '<div class="query-plan-container" id="queryPlanContainer"></div>'
                + '</div>';
        }

        this.setResultsHtml(html, tabsHtml);

        if (hasPlan) {
            this._pendingPlanXmls = planXmls;
            this.renderPendingPlanIfVisible();
        }
    }

    // One tab per result set, each labelled with its row count and - when the
    // backend could match it 1:1 to a statement - a tooltip naming that query.
    // Trailing "Messages" and "Execution Plan" tabs hold PRINT/RAISERROR
    // output and the plan on their own, instead of either showing up under
    // whichever grid (if any) happens to be active. Whichever tab comes
    // first is the one marked active, regardless of which kinds are present.
    buildTabsHtml(resultSets, hasMessages, hasPlan) {
        const tabs = resultSets.map((set, index) => {
            const title = set.sourceStatement ? QueryManager.truncate(set.sourceStatement, 180) : '';
            return {
                title,
                label: `Result ${index + 1} <span class="result-tab-count">${set.totalRows}</span>`
                    + (title ? ' <i class="codicon codicon-info"></i>' : '')
            };
        });
        if (hasMessages) tabs.push({ label: '<i class="codicon codicon-output"></i> Messages' });
        if (hasPlan) tabs.push({ label: '<i class="codicon codicon-graph"></i> Execution Plan' });

        let html = '<div class="result-tabs" role="tablist">';
        tabs.forEach((tab, index) => {
            html += `<button type="button" class="result-tab${index === 0 ? ' active' : ''}" `
                + `data-rs-tab="${index}" role="tab"${tab.title ? ` title="${this.escapeHtml(tab.title)}"` : ''}>`
                + tab.label + '</button>';
        });
        html += '</div>';
        return html;
    }

    // QP.showPlan measures real layout (getBoundingClientRect) to draw the
    // connector lines between nodes, which fails on a container that's
    // display:none - as the Execution Plan pane is whenever Result 1 (or
    // Messages) is the tab shown first. Render is deferred until the pane
    // the plan lives in is actually visible; showResultSet calls this again
    // on every tab switch, and it's a no-op once already rendered.
    renderPendingPlanIfVisible() {
        if (!this._pendingPlanXmls) return;
        const container = document.getElementById('queryPlanContainer');
        if (!container || container.offsetParent === null) return;
        const planXmls = this._pendingPlanXmls;
        this._pendingPlanXmls = null;
        this.renderQueryPlans(planXmls);
    }

    // QP.showPlan needs a live DOM node per plan - it injects markup and
    // draws connecting lines - so it can't be part of the innerHTML string
    // built in displayResultSets; run it once that HTML is actually mounted
    // and visible (see renderPendingPlanIfVisible).
    renderQueryPlans(planXmls) {
        const container = document.getElementById('queryPlanContainer');
        if (!container) return;
        planXmls.forEach((xml, index) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'query-plan-item';
            container.appendChild(wrapper);
            try {
                QP.showPlan(wrapper, xml);
            } catch (err) {
                console.error(`QP.showPlan failed for plan ${index + 1}:`, err, xml);
                wrapper.innerHTML = `<p class="placeholder-text">Could not render plan ${index + 1}: ${this.escapeHtml(err.message)}</p>`
                    + `<pre class="query-plan-raw-xml">${this.escapeHtml(xml.slice(0, 500))}${xml.length > 500 ? '…' : ''}</pre>`;
            }
        });
    }

    buildResultSetActionsHtml(set, index) {
        return `<div class="result-set-actions">`
            + `<span class="rs-label">${set.totalRows} row(s)</span>`
            + `<input type="text" class="rs-filter" data-rs-filter="${index}" placeholder="Filter rows…" spellcheck="false">`
            + `<span class="rs-spacer"></span>`
            + `<button data-rs-action="copy" data-rs-index="${index}" title="Copy to clipboard (tab-separated, pastes into Excel)"><i class="codicon codicon-copy"></i> Copy</button>`
            + `<button data-rs-action="csv" data-rs-index="${index}" title="Export this result set as a CSV file"><i class="codicon codicon-desktop-download"></i> CSV</button>`
            + `<button data-rs-action="json" data-rs-index="${index}" title="Export this result set as a JSON file (an array of objects)"><i class="codicon codicon-json"></i> JSON</button>`
            + `<button data-rs-action="columns" data-rs-index="${index}" title="List the column names (one per line, to copy)" aria-label="List the column names"><i class="codicon codicon-list-flat"></i></button>`
            + `<button data-rs-action="temp" data-rs-index="${index}" title="Script this result set as CREATE TABLE #Results + INSERT, in a new query tab"><i class="codicon codicon-table"></i> #Temp</button>`
            + `</div>`
            + (set.rows.length < set.totalRows
                ? `<p class="truncation-note"><i class="codicon codicon-warning"></i> Showing first ${set.rows.length} of ${set.totalRows} rows (max rows limit).</p>`
                : '');
    }

    // rows is already filtered/sorted (see visibleRows) - this only renders.
    buildResultSetTableHtml(rows, columns, index) {
        if (rows.length === 0) {
            const state = this._gridState[index];
            return state && state.filterText
                ? '<p class="placeholder-text">No rows match this filter.</p>'
                : '<p class="placeholder-text">No rows.</p>';
        }

        const state = this._gridState[index] || {};
        // Only a prefix of the rows is drawn - see MAX_RENDERED_ROWS.
        const limit = state.limit || QueryManager.MAX_RENDERED_ROWS;
        const drawn = rows.length > limit ? rows.slice(0, limit) : rows;

        // A column of numbers (and NULLs) reads better aligned to the right.
        const numeric = new Set(columns.filter(col =>
            drawn.some(row => typeof row[col] === 'number')
            && drawn.every(row => row[col] === null || row[col] === undefined || typeof row[col] === 'number')));

        // Once a column was resized every column has a width and the table lays out by them.
        const widths = state.widths || null;
        let html = widths
            ? `<table class="rs-fixed" style="width:${QueryManager.tableWidthStyle(columns, widths)}">${QueryManager.colgroupHtml(columns, widths)}<thead><tr>`
            : '<table><thead><tr>';
        columns.forEach(col => {
            const sorted = state.sortCol === col;
            const arrow = sorted ? ` <i class="codicon codicon-arrow-${state.sortDir === 1 ? 'up' : 'down'}"></i>` : '';
            html += `<th data-sort-col="${this.escapeHtml(col)}" data-rs-index="${index}" `
                + `class="rs-sortable${sorted ? ' sorted' : ''}${numeric.has(col) ? ' rs-num' : ''}" title="Click to sort">${this.escapeHtml(col)}${arrow}<span class="rs-resizer" title="Drag to resize, double-click to reset"></span></th>`;
        });
        html += (widths ? '<th class="rs-filler"></th>' : '') + '</tr></thead><tbody>';

        drawn.forEach(row => {
            html += '<tr>';
            columns.forEach(col => {
                const isNull = row[col] === null || row[col] === undefined;
                const classes = (numeric.has(col) ? 'rs-num' : '') + (isNull ? ' rs-null' : '');
                html += `<td${classes.trim() ? ` class="${classes.trim()}"` : ''}>${this.escapeHtml(this.formatValue(row[col]))}</td>`;
            });
            html += (widths ? '<td class="rs-filler"></td>' : '') + '</tr>';
        });
        html += '</tbody></table>';

        if (drawn.length < rows.length) {
            html += `<p class="truncation-note"><i class="codicon codicon-warning"></i> `
                + `The grid shows the first ${drawn.length} of ${rows.length} rows - Copy and the exports include all of them. `
                + `<button data-rs-action="more" data-rs-index="${index}">Show ${Math.min(QueryManager.MAX_RENDERED_ROWS, rows.length - drawn.length)} more</button> `
                + `<button data-rs-action="more" data-rs-all="1" data-rs-index="${index}">Show all</button></p>`;
        }
        return html;
    }

    // "a,\nb,\nc": the names one under the other, a comma after each but the last.
    static columnNames(columns, brackets) {
        return columns
            .map((col, i) => col === '' ? `Column${i + 1}` : col)
            .map(col => brackets ? `[${col.replace(/]/g, ']]')}]` : col)
            .join(',\n');
    }

    // A pop-up with the column names, to copy all of them or a part.
    showColumnNames(set) {
        if (!this._columnsModal) {
            const byId = id => document.getElementById(id);
            const m = this._columnsModal = {
                overlay: byId('resultColumnsModalOverlay'), title: byId('resultColumnsModalTitle'),
                text: byId('resultColumnsText'), brackets: byId('resultColumnsBrackets'), copy: byId('resultColumnsCopyBtn')
            };
            const close = () => m.overlay.classList.remove('visible');
            byId('resultColumnsModalCloseBtn').addEventListener('click', close);
            m.overlay.addEventListener('click', (e) => { if (e.target === m.overlay) close(); });
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && m.overlay.classList.contains('visible')) close(); });
            m.brackets.addEventListener('change', () => this._renderColumnNames());
            m.copy.addEventListener('click', () => {
                // What is selected, or everything.
                const selected = m.text.value.slice(m.text.selectionStart, m.text.selectionEnd);
                const text = selected || m.text.value;
                navigator.clipboard.writeText(text).then(
                    () => this.setStatus(selected ? 'Selected column names copied.' : `${this._columnsOfModal.length} column name(s) copied.`, 'success'),
                    () => this.setStatus('Copy to clipboard failed.', 'error')
                );
            });
        }
        const m = this._columnsModal;
        this._columnsOfModal = set.columns;
        m.title.textContent = `Columns (${set.columns.length})`;
        this._renderColumnNames();
        m.overlay.classList.add('visible');
        m.text.focus();
        m.text.select();
        // select() scrolls to the end of a long list: back to the first name.
        m.text.scrollTop = 0;
    }

    _renderColumnNames() {
        const m = this._columnsModal;
        m.text.value = QueryManager.columnNames(this._columnsOfModal, m.brackets.checked);
        m.text.rows = Math.min(Math.max(this._columnsOfModal.length, 4), 20);
    }

    // The result set as CREATE TABLE #Results + INSERT, in a new query tab (all
    // the rows fetched, whatever the filter and the sort of the grid).
    scriptAsTempTable(set, index) {
        if (!this.openScriptInNewTab) return;
        this.openScriptInNewTab(TempTableScript.build(set, TempTableScript.tableName(index)));
        this.setStatus(`${set.rows.length} row(s) scripted as ${TempTableScript.tableName(index)} in a new tab.`, 'success');
    }

    static totalWidth(columns, widths) {
        return columns.reduce((sum, col) => sum + (widths[col] || QueryManager.DEFAULT_COLUMN_WIDTH), 0);
    }

    // The last <col> has no width: with the filler cells it takes what the
    // columns leave, so the table always spans the whole grid.
    static colgroupHtml(columns, widths) {
        return '<colgroup>' + columns.map(col => `<col style="width:${widths[col] || QueryManager.DEFAULT_COLUMN_WIDTH}px">`).join('') + '<col></colgroup>';
    }

    static tableWidthStyle(columns, widths) {
        return `max(100%, ${QueryManager.totalWidth(columns, widths)}px)`;
    }

    // Starts a drag on a header's right edge. The first drag freezes the widths
    // the columns have now; the table then keeps them (see buildResultSetTableHtml).
    startColumnResize(handle, event) {
        event.preventDefault();
        event.stopPropagation();
        const th = handle.parentElement;
        const table = th.closest('table');
        const index = Number(th.dataset.rsIndex);
        const headers = [...table.querySelectorAll('thead th[data-sort-col]')];
        const columns = headers.map(t => t.dataset.sortCol);
        const state = this._gridState[index] || (this._gridState[index] = {});
        if (!state.widths) {
            state.widths = {};
            headers.forEach(t => { state.widths[t.dataset.sortCol] = Math.round(t.getBoundingClientRect().width); });
            table.classList.add('rs-fixed');
            table.insertAdjacentHTML('afterbegin', QueryManager.colgroupHtml(columns, state.widths));
            table.querySelectorAll('thead tr').forEach(tr => tr.insertAdjacentHTML('beforeend', '<th class="rs-filler"></th>'));
            table.querySelectorAll('tbody tr').forEach(tr => tr.insertAdjacentHTML('beforeend', '<td class="rs-filler"></td>'));
            table.style.width = QueryManager.tableWidthStyle(columns, state.widths);
        }
        const position = columns.indexOf(th.dataset.sortCol);
        const colElement = table.querySelectorAll('col')[position];
        const startX = event.clientX;
        const startWidth = state.widths[th.dataset.sortCol];
        handle.setPointerCapture(event.pointerId);
        const move = (e) => {
            const width = Math.max(QueryManager.MIN_COLUMN_WIDTH, Math.round(startWidth + e.clientX - startX));
            state.widths[th.dataset.sortCol] = width;
            colElement.style.width = `${width}px`;
            table.style.width = QueryManager.tableWidthStyle(columns, state.widths);
        };
        const end = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', end);
            handle.removeEventListener('pointercancel', end);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    }

    // Client-side view only - the underlying result set (and what Copy/CSV
    // export) is untouched.
    visibleRows(set, index) {
        const state = this._gridState[index];
        if (!state) return set.rows;

        let rows = set.rows;
        if (state.filterText) {
            const needle = state.filterText.toLowerCase();
            rows = rows.filter(row => set.columns.some(col => this.formatValue(row[col]).toLowerCase().includes(needle)));
        }
        if (state.sortCol) {
            const col = state.sortCol;
            const dir = state.sortDir;
            rows = [...rows].sort((a, b) => {
                const av = a[col];
                const bv = b[col];
                if (av === bv) return 0;
                if (av === null || av === undefined) return 1;
                if (bv === null || bv === undefined) return -1;
                return (av < bv ? -1 : 1) * dir;
            });
        }
        return rows;
    }

    sortResultSet(index, column) {
        const state = this._gridState[index];
        if (!state) return;
        if (state.sortCol === column) state.sortDir *= -1;
        else { state.sortCol = column; state.sortDir = 1; }
        this.rerenderResultTable(index);
    }

    filterResultSet(index, filterText) {
        const state = this._gridState[index];
        if (!state) return;
        state.filterText = filterText;
        this.rerenderResultTable(index);
    }

    // Draws more rows of the grid (the next page, or all of them).
    showMoreRows(index, all) {
        const state = this._gridState[index];
        if (!state) return;
        state.limit = all ? Infinity : (state.limit || QueryManager.MAX_RENDERED_ROWS) + QueryManager.MAX_RENDERED_ROWS;
        this.rerenderResultTable(index);
    }

    // Replaces only the table (not the surrounding actions bar, which holds
    // the filter <input> itself) so typing/sorting never steals its focus.
    rerenderResultTable(index) {
        const wrap = this.resultsContainer.querySelector(`.result-set-table-wrap[data-rs-table="${index}"]`);
        const set = this.lastResultSets[index];
        if (!wrap || !set) return;
        wrap.innerHTML = this.buildResultSetTableHtml(this.visibleRows(set, index), set.columns, index);
    }

    // Switch which result set's tab/pane is visible; the tables for every
    // result set are already in the DOM, so this only toggles display.
    showResultSet(index) {
        this.activeResultIndex = index;
        this.resultsContainer.querySelectorAll('.result-tab').forEach((tab, i) => {
            tab.classList.toggle('active', i === index);
        });
        this.resultsContainer.querySelectorAll('.result-set-pane').forEach(pane => {
            pane.style.display = Number(pane.dataset.rsPane) === index ? '' : 'none';
        });
        this.renderPendingPlanIfVisible();
    }

    // PRINT / RAISERROR output and "a grid was produced here" markers, shown
    // in their own "Messages" tab, one line per event, in the exact order
    // they happened - no guessing which message belongs to which grid.
    buildMessagesBlock(timeline, resultSets) {
        if (!timeline || timeline.length === 0) return '';
        const lines = timeline.map(entry => {
            if (entry.type === 'resultSet') {
                const set = resultSets[entry.index];
                const count = set ? set.totalRows : 0;
                return `<div class="message-rs-marker">`
                    + `<button type="button" class="message-rs-link" data-rs-tab="${entry.index}" `
                    + `title="Jump to Result ${entry.index + 1}"><i class="codicon codicon-arrow-right"></i> Result ${entry.index + 1} `
                    + `<span class="result-tab-count">${count} row(s)</span></button></div>`;
            }
            return `<div class="message-line">${this.escapeHtml(entry.text)}</div>`;
        });
        return `<div class="query-messages">${lines.join('')}</div>`;
    }

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

    // === Formatting helpers ===

    // RFC 4180-style: quote fields containing the separator, quotes or newlines.
    // Used with '\t' for clipboard (pastes into Excel) and ',' for CSV export.
    static toDelimited(set, separator) {
        // Excel/LibreOffice/Sheets treat a cell starting with one of these as a
        // formula to evaluate on open - prefix with a literal quote (Excel's own
        // "force text" convention) so a result value like "=cmd|'/C calc'!A0"
        // never executes. Quoting the field for the separator/newline rule below
        // isn't enough on its own: Excel still evaluates a quoted leading '='.
        const FORMULA_LEADING_RE = /^[=+\-@\t\r]/;
        const escapeField = (value) => {
            let text;
            if (value === null || value === undefined) text = '';
            else if (value instanceof Date) text = value.toISOString();
            else if (typeof value === 'object') text = JSON.stringify(value);
            else text = String(value);
            if (FORMULA_LEADING_RE.test(text)) text = `'${text}`;
            if (text.includes(separator) || text.includes('"') || text.includes('\n') || text.includes('\r')) {
                text = `"${text.replace(/"/g, '""')}"`;
            }
            return text;
        };

        const lines = [set.columns.map(escapeField).join(separator)];
        for (const row of set.rows) {
            lines.push(set.columns.map(col => escapeField(row[col])).join(separator));
        }
        return lines.join('\r\n');
    }

    // The rows as a JSON array of objects, keys in column order (a Date becomes
    // its ISO string, as JSON.stringify does).
    static toJson(set) {
        const rows = set.rows.map(row => {
            const out = {};
            for (const col of set.columns) out[col] = row[col] === undefined ? null : row[col];
            return out;
        });
        return JSON.stringify(rows, null, 2);
    }

    // Collapse to one line and cap length, for a tooltip that stays readable.
    static truncate(text, maxLength) {
        const flat = text.replace(/\s+/g, ' ').trim();
        return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
    }

    // JSON.stringify's own form for a Date: "2008-04-30T00:00:00.000Z".
    // Always milliseconds, always the 'Z' suffix - so the shape is exact.
    static JSON_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

    formatDuration(ms) {
        if (typeof ms !== 'number') return '?';
        return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
    }

    formatValue(value) {
        if (value === null || value === undefined) return 'NULL';
        // SSMS-style "2008-04-30 00:00:00.000" instead of ISO 8601's
        // "2008-04-30T00:00:00.000Z" - same UTC instant (tedious already
        // returns datetime/datetime2 values as the exact stored wall-clock
        // value in UTC, not shifted), just reformatted for how it reads in
        // the grid. CSV/clipboard export (toDelimited) deliberately keeps
        // the unambiguous ISO form instead, for round-tripping into other tools.
        if (value instanceof Date) return value.toISOString().replace('T', ' ').replace('Z', '');
        // The extension host and the webview talk over JSON, so a datetime
        // arrives here as a *string* (JSON.stringify's Date form), never as
        // a Date object - the branch above can therefore never fire for a
        // result set, and the raw "2008-04-30T00:00:00.000Z" is what shows
        // up in the grid. Reformat that exact shape; JSON.stringify always
        // emits milliseconds and the 'Z' suffix, so the pattern is exact.
        if (typeof value === 'string' && QueryManager.JSON_DATE_RE.test(value)) {
            return value.replace('T', ' ').replace('Z', '');
        }
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
    }

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

// Allow unit tests to require() this file; in the webview `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = QueryManager;
}
