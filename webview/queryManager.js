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
    constructor() {
        this.runBtn = document.getElementById('runQueryBtn');
        this.estimatedPlanBtn = document.getElementById('estimatedPlanBtn');
        this.actualPlanBtn = document.getElementById('actualPlanBtn');
        this.cancelBtn = document.getElementById('cancelQueryBtn');
        this.maxRowsSelect = document.getElementById('maxRowsSelect');
        this.historySelect = document.getElementById('queryHistorySelect');
        this.snippetsSelect = document.getElementById('querySnippetsSelect');
        this.input = document.getElementById('queryInput');
        this.status = document.getElementById('queryStatus');
        this.resultsContainer = document.getElementById('queryResultsContainer');
        this.history = [];
        this.customSnippets = [];
        this.lastResultSets = [];
        this._gridState = [];
        this.isRunning = false;
        this.splitter = document.getElementById('querySplitter');
        this.autocomplete = new SqlAutocomplete(this.input);
        this.highlighter = new SqlHighlighter(this.input);
        this.initEventListeners();
        this.initSplitter();
        vscode.postMessage({ command: 'getQueryHistory' });
        vscode.postMessage({ command: 'getSnippets' });
    }

    initEventListeners() {
        this.runBtn.addEventListener('click', () => this.runQuery());
        this.estimatedPlanBtn.addEventListener('click', () => this.runEstimatedPlan());
        this.actualPlanBtn.addEventListener('click', () => this.runActualPlan());
        this.cancelBtn.addEventListener('click', () => this.cancelQuery());
        this.historySelect.addEventListener('change', () => this.applyHistorySelection());
        this.snippetsSelect.addEventListener('change', () => this.applySnippetSelection());
        this.input.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                this.runQuery();
            }
        });
        // Ctrl+Click or double-click on an object name jumps to its definition in the Explorer
        this.input.addEventListener('click', (e) => {
            if (e.ctrlKey || e.metaKey) this.goToDefinition();
        });
        this.input.addEventListener('dblclick', () => this.goToDefinition());
        // Tabs and Copy / CSV buttons are re-rendered with every result set: one
        // delegated listener on the container instead of per-element bindings.
        this.resultsContainer.addEventListener('click', (e) => {
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
            if (button.dataset.rsAction === 'copy') this.copyResultSet(set);
            else this.exportResultSetCsv(set, index);
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
        vscode.postMessage({
            command: 'exportCsv',
            csv: QueryManager.toDelimited(set, ','),
            defaultName: `query-results${suffix}.csv`
        });
    }

    onCsvExported(message) {
        if (message.success) {
            this.setStatus(`CSV saved to ${message.path}`, 'success');
        } else if (message.cancelled) {
            this.setStatus('CSV export cancelled.', '');
        } else {
            this.setStatus(`CSV export failed: ${message.message}`, 'error');
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
    // textarea itself - the highlight overlay fills it via inset:0 and would
    // otherwise fall out of sync with the textarea's own height.
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

    // Called by ExplorerManager whenever the shared database selector changes
    onDatabaseChanged(database) {
        this.autocomplete.reset();
        this.runBtn.disabled = !database || this.isRunning;
        this.estimatedPlanBtn.disabled = !database || this.isRunning;
        this.actualPlanBtn.disabled = !database || this.isRunning;
        if (!this.isRunning) {
            this.setStatus(database ? '' : 'Select a database above to run queries.', '');
        }
    }

    // Fill the editor with a given SQL string and run it immediately
    // (used by the per-object "Top 10" shortcut in Explorer).
    runQueryText(sql) {
        this.input.value = sql;
        this.highlighter.render();
        this.runQuery();
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
        this.highlighter.render();
    }

    // Fill the editor without running (used by the Explorer script generator)
    setQueryText(sql) {
        this.input.value = sql;
        this.highlighter.render();
        this.input.focus();
        this.input.setSelectionRange(0, 0);
        this.input.scrollTop = 0;
        this.setStatus('Script inserted - review and run when ready.', '');
    }

    runQuery() {
        const database = appState.currentDatabase;
        const query = this.input.value.trim();

        if (this.isRunning) return;
        if (!database) {
            this.setStatus('Select a database above first.', 'error');
            return;
        }
        if (!query) {
            this.setStatus('Enter a query first.', 'error');
            return;
        }

        this.setRunning(true);
        this.setStatus('Running...', '');
        this.setResultsHtml('<p class="placeholder-text">Running query...</p>');

        vscode.postMessage({
            command: 'executeQuery',
            database,
            query,
            maxRows: Number(this.maxRowsSelect.value)
        });
    }

    // SET SHOWPLAN_XML ON never executes the query - just compiles and plans
    // it - so unlike the other two there's nothing to cancel here.
    runEstimatedPlan() {
        const database = appState.currentDatabase;
        const query = this.input.value.trim();

        if (this.isRunning) return;
        if (!database) {
            this.setStatus('Select a database above first.', 'error');
            return;
        }
        if (!query) {
            this.setStatus('Enter a query first.', 'error');
            return;
        }

        this.setRunning(true, false);
        this.setStatus('Generating estimated plan...', '');
        this.setResultsHtml('<p class="placeholder-text">Generating estimated plan...</p>');

        vscode.postMessage({ command: 'getEstimatedPlan', database, query });
    }

    // SET STATISTICS XML ON: the query actually runs (same risk check as a
    // normal run), with an extra plan recordset appended per statement.
    runActualPlan() {
        const database = appState.currentDatabase;
        const query = this.input.value.trim();

        if (this.isRunning) return;
        if (!database) {
            this.setStatus('Select a database above first.', 'error');
            return;
        }
        if (!query) {
            this.setStatus('Enter a query first.', 'error');
            return;
        }

        this.setRunning(true);
        this.setStatus('Running with actual execution plan...', '');
        this.setResultsHtml('<p class="placeholder-text">Running query...</p>');

        vscode.postMessage({
            command: 'getActualPlan',
            database,
            query,
            maxRows: Number(this.maxRowsSelect.value)
        });
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
        this.runBtn.disabled = running || !appState.currentDatabase;
        this.estimatedPlanBtn.disabled = running || !appState.currentDatabase;
        this.actualPlanBtn.disabled = running || !appState.currentDatabase;
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
        this.setStatus('Estimated execution plan generated.', 'success');
    }

    onQueryError(message) {
        this.setRunning(false);
        this.setResultsHtml(`<pre class="query-error-box">${this.escapeHtml(message.message)}</pre>`);
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
        this._gridState = resultSets.map(() => ({ filterText: '', sortCol: null, sortDir: 1 }));
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
        let html = '<table><thead><tr>';
        columns.forEach(col => {
            const sorted = state.sortCol === col;
            const arrow = sorted ? (state.sortDir === 1 ? ' ▲' : ' ▼') : '';
            html += `<th data-sort-col="${this.escapeHtml(col)}" data-rs-index="${index}" `
                + `class="rs-sortable${sorted ? ' sorted' : ''}" title="Click to sort">${this.escapeHtml(col)}${arrow}</th>`;
        });
        html += '</tr></thead><tbody>';

        rows.forEach(row => {
            html += '<tr>';
            columns.forEach(col => {
                html += `<td>${this.escapeHtml(this.formatValue(row[col]))}</td>`;
            });
            html += '</tr>';
        });
        html += '</tbody></table>';
        return html;
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
                    + `title="Jump to Result ${entry.index + 1}">→ Result ${entry.index + 1} `
                    + `<span class="result-tab-count">${count} row(s)</span></button></div>`;
            }
            return `<div class="message-line">${this.escapeHtml(entry.text)}</div>`;
        });
        return `<div class="query-messages">${lines.join('')}</div>`;
    }

    // === History ===

    onHistoryLoaded(history) {
        this.history = history || [];
        this.historySelect.innerHTML = '<option value="">🕘 History…</option>';

        this.history.forEach((entry, index) => {
            const option = document.createElement('option');
            const time = new Date(entry.timestamp);
            const timeLabel = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
            const queryLabel = entry.query.replace(/\s+/g, ' ').slice(0, 60);
            option.value = String(index);
            option.textContent = `${entry.success ? '✓' : '✗'} ${timeLabel} [${entry.database}] ${queryLabel}`;
            this.historySelect.appendChild(option);
        });

        if (this.history.length > 0) {
            const clearOption = document.createElement('option');
            clearOption.value = 'clear';
            clearOption.textContent = '🗑 Clear history';
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
            this.highlighter.render();
            this.input.focus();
        }
    }

    // === Snippets ===

    onSnippetsLoaded(snippets) {
        this.customSnippets = snippets || [];
        this.renderSnippetsMenu();
    }

    renderSnippetsMenu() {
        this.snippetsSelect.innerHTML = '<option value="">📋 Snippets…</option>';

        const builtinGroup = document.createElement('optgroup');
        builtinGroup.label = 'Built-in';
        QueryManager.BUILTIN_SNIPPETS.forEach((snippet, index) => {
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
        addOption.textContent = '➕ Save selection as snippet…';
        manageGroup.appendChild(addOption);
        if (this.customSnippets.length > 0) {
            const deleteOption = document.createElement('option');
            deleteOption.value = 'delete';
            deleteOption.textContent = '🗑 Delete a custom snippet…';
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
            const snippet = QueryManager.BUILTIN_SNIPPETS[Number(value.slice('builtin:'.length))];
            sql = snippet && snippet.sql;
        } else if (value.startsWith('custom:')) {
            const name = value.slice('custom:'.length);
            const snippet = this.customSnippets.find(s => s.name === name);
            sql = snippet && snippet.sql;
        }
        if (sql) this.insertAtCursor(sql);
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
    // own accept() does for a completion - same sql:valuechange event so the
    // syntax highlighter overlay stays in sync.
    insertAtCursor(text) {
        const ta = this.input;
        ta.focus();
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
        const caret = start + text.length;
        ta.setSelectionRange(caret, caret);
        ta.dispatchEvent(new CustomEvent('sql:valuechange'));
    }

    // === Formatting helpers ===

    // RFC 4180-style: quote fields containing the separator, quotes or newlines.
    // Used with '\t' for clipboard (pastes into Excel) and ',' for CSV export.
    static toDelimited(set, separator) {
        const escapeField = (value) => {
            let text;
            if (value === null || value === undefined) text = '';
            else if (value instanceof Date) text = value.toISOString();
            else if (typeof value === 'object') text = JSON.stringify(value);
            else text = String(value);
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

    // Collapse to one line and cap length, for a tooltip that stays readable.
    static truncate(text, maxLength) {
        const flat = text.replace(/\s+/g, ' ').trim();
        return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
    }

    formatDuration(ms) {
        if (typeof ms !== 'number') return '?';
        return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
    }

    formatValue(value) {
        if (value === null || value === undefined) return 'NULL';
        if (value instanceof Date) return value.toISOString();
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

// Ready-made snippets offered alongside any custom ones the user saves.
QueryManager.BUILTIN_SNIPPETS = [
    { name: 'SELECT TOP 100', sql: 'SELECT TOP 100 *\nFROM ' },
    { name: 'COUNT rows', sql: 'SELECT COUNT(*) AS row_count\nFROM ' },
    { name: 'INSERT INTO', sql: 'INSERT INTO table_name (column1, column2)\nVALUES (value1, value2);' },
    { name: 'UPDATE ... WHERE', sql: 'UPDATE table_name\nSET column1 = value1\nWHERE condition;' },
    { name: 'DELETE ... WHERE', sql: 'DELETE FROM table_name\nWHERE condition;' },
    { name: 'CREATE TABLE', sql: 'CREATE TABLE table_name (\n    id INT IDENTITY(1,1) PRIMARY KEY,\n    column1 NVARCHAR(100) NOT NULL\n);' },
    { name: 'GROUP BY ... HAVING', sql: 'SELECT column1, COUNT(*) AS cnt\nFROM table_name\nGROUP BY column1\nHAVING COUNT(*) > 1;' },
    { name: 'ROW_NUMBER window function', sql: 'SELECT *,\n    ROW_NUMBER() OVER (PARTITION BY column1 ORDER BY column2) AS rn\nFROM table_name;' },
    { name: 'Temp table', sql: 'CREATE TABLE #temp (\n    id INT\n);\n\nDROP TABLE #temp;' },
    { name: 'BEGIN TRAN / COMMIT', sql: 'BEGIN TRAN;\n\n\nCOMMIT TRAN;\n-- ROLLBACK TRAN;' }
];

// Allow unit tests to require() this file; in the webview `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = QueryManager;
}
