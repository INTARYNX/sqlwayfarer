/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// The part of the Query tool that shows what a run returned: the result sets, the
// grid (sort, filter, resize, more rows), the messages, the plans and the
// errors. It is mixed into QueryManager (see queryManager.js), so `this` is the
// QueryManager.
class QueryResultsMethods {
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

    // === One results view per query tab ===
    //
    // The results pane belongs to the active tab: leaving a tab sets what it
    // shows aside (the DOM itself, with the data behind it and the status), and
    // coming back puts it as it was.

    captureResultsView() {
        const nodes = document.createDocumentFragment();
        const scroll = this.resultsContainer.querySelector('.result-scroll');
        const view = {
            scrollTop: scroll ? scroll.scrollTop : 0,
            scrollLeft: scroll ? scroll.scrollLeft : 0,
            lastResultSets: this.lastResultSets,
            gridState: this._gridState,
            activeResultIndex: this.activeResultIndex,
            statusText: this.status.textContent,
            statusClass: this.status.className,
            nodes
        };
        while (this.resultsContainer.firstChild) nodes.appendChild(this.resultsContainer.firstChild);
        return view;
    }

    // `view` is null for a tab that never ran anything: the empty pane.
    restoreResultsView(view) {
        this.resultsContainer.textContent = '';
        if (!view) {
            this.lastResultSets = [];
            this._gridState = [];
            this.activeResultIndex = 0;
            this.setResultsHtml('<p class="placeholder-text">Run a query to see results here.</p>');
            this.setStatus(this.targetDatabase() ? '' : 'Select a database above to run queries.', '');
            return;
        }
        this.lastResultSets = view.lastResultSets;
        this._gridState = view.gridState;
        this.activeResultIndex = view.activeResultIndex;
        this.resultsContainer.appendChild(view.nodes);
        this.status.textContent = view.statusText;
        this.status.className = view.statusClass;
        const scroll = this.resultsContainer.querySelector('.result-scroll');
        if (scroll) { scroll.scrollTop = view.scrollTop; scroll.scrollLeft = view.scrollLeft; }
    }

    // The answer of a run goes to the tab that ran it, which may no longer be
    // the one on screen: it is drawn in that tab's own view, then the view on
    // screen comes back.
    _inRunTab(show) {
        const files = window.queryFileManager;
        const owner = files && this.runTabId != null ? files.tabs.find(t => t.id === this.runTabId) : null;
        if (!files || !owner || owner.id === files.activeTabId) { show(); return; }
        const onScreen = this.captureResultsView();
        this.restoreResultsView(owner.results || null);
        try { show(); } finally {
            owner.results = this.captureResultsView();
            this.restoreResultsView(onScreen);
        }
    }

    onQueryResult(message) { this._inRunTab(() => this._showQueryResult(message)); }

    _showQueryResult(message) {
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
    onPlanResult(message) { this._inRunTab(() => this._showPlanResult(message)); }

    _showPlanResult(message) {
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

    onQueryError(message) { this._inRunTab(() => this._showQueryError(message)); }

    _showQueryError(message) {
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
        this._gridState = resultSets.map(set => ({ filterText: '', sortCol: null, sortDir: 1, limit: QueryManager.MAX_RENDERED_ROWS, types: QueryManager.typesByColumn(set) }));
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
            html += `<div class="result-set-pane rs-grid-pane" data-rs-pane="${index}"${index === 0 ? '' : ' style="display:none;"'}>`
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
            + `<button data-rs-action="columns" data-rs-index="${index}" title="List the column names (one per line, to copy)" aria-label="List the column names"><i class="codicon codicon-symbol-field"></i></button>`
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

        // A column of numbers (and NULLs): tabular figures, left-aligned as the SQL Server tools do.
        const types = state.types || {};
        const numeric = new Set(columns.filter(col => (types[col] && types[col].kind === 'number')
            || (drawn.some(row => typeof row[col] === 'number')
                && drawn.every(row => row[col] === null || row[col] === undefined || typeof row[col] === 'number'))));

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
                html += `<td${classes.trim() ? ` class="${classes.trim()}"` : ''}>${this.escapeHtml(this.formatValue(row[col], types[col]))}</td>`;
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
            // A column with no name (see database/resultColumns.js) is not a name to copy.
            .map((col, i) => col === '' || /^\(No column name\)(?: \(\d+\))?$/.test(col) ? `Column${i + 1}` : col)
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
        if (!set.columns || set.columns.length === 0) {
            this.setStatus('This result set has no column: there is nothing to script.', 'error');
            return;
        }
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
            rows = rows.filter(row => set.columns.some(col => this.formatValue(row[col], state.types && state.types[col]).toLowerCase().includes(needle)));
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
                return QueryManager.compareValues(av, bv, state.types && state.types[col]) * dir;
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
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = QueryResultsMethods;
}
