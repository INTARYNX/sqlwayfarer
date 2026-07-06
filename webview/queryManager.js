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
        this.cancelBtn = document.getElementById('cancelQueryBtn');
        this.maxRowsSelect = document.getElementById('maxRowsSelect');
        this.historySelect = document.getElementById('queryHistorySelect');
        this.input = document.getElementById('queryInput');
        this.status = document.getElementById('queryStatus');
        this.resultsContainer = document.getElementById('queryResultsContainer');
        this.history = [];
        this.lastResultSets = [];
        this.isRunning = false;
        this.splitter = document.getElementById('querySplitter');
        this.autocomplete = new SqlAutocomplete(this.input);
        this.initEventListeners();
        this.initSplitter();
        vscode.postMessage({ command: 'getQueryHistory' });
    }

    initEventListeners() {
        this.runBtn.addEventListener('click', () => this.runQuery());
        this.cancelBtn.addEventListener('click', () => this.cancelQuery());
        this.historySelect.addEventListener('change', () => this.applyHistorySelection());
        this.input.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                this.runQuery();
            }
        });
        // Ctrl+Click on an object name jumps to its definition in the Explorer
        this.input.addEventListener('click', (e) => {
            if (e.ctrlKey || e.metaKey) this.goToDefinition();
        });
        // Copy / CSV buttons are re-rendered with every result set: one delegated
        // listener on the container instead of per-button bindings.
        this.resultsContainer.addEventListener('click', (e) => {
            const button = e.target.closest('button[data-rs-action]');
            if (!button) return;
            const index = Number(button.dataset.rsIndex);
            const set = this.lastResultSets[index];
            if (!set) return;
            if (button.dataset.rsAction === 'copy') this.copyResultSet(set);
            else this.exportResultSetCsv(set, index);
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

    // Resolve the identifier under the caret (alias-aware) and reveal it in the Explorer
    goToDefinition() {
        const word = SqlAutocomplete.wordAt(this.input.value, this.input.selectionStart);
        if (!word) return;

        const clean = word.replace(/[[\]]/g, '');
        const aliases = SqlAutocomplete.parseAliases(this.input.value);
        const target = (aliases[clean.toLowerCase()] || clean).toLowerCase();

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
    // double-click resets to the default height.
    initSplitter() {
        const DEFAULT_HEIGHT = 140;
        const MIN_HEIGHT = 80;

        this.splitter.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startY = e.clientY;
            const startHeight = this.input.offsetHeight;
            const section = this.input.parentElement;
            this.splitter.classList.add('dragging');
            document.body.style.userSelect = 'none';

            const onMove = (ev) => {
                // keep at least 100px for the results pane below
                const maxHeight = section.clientHeight - 100;
                const height = Math.min(Math.max(startHeight + ev.clientY - startY, MIN_HEIGHT), maxHeight);
                this.input.style.height = `${height}px`;
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
            this.input.style.height = `${DEFAULT_HEIGHT}px`;
        });
    }

    // Cached columns belong to the previous database - drop them on change
    onObjectColumnsLoaded(message) {
        this.autocomplete.onColumnsLoaded(message.objectName, message.columns);
    }

    // Called by ExplorerManager whenever the shared database selector changes
    onDatabaseChanged(database) {
        this.autocomplete.reset();
        this.runBtn.disabled = !database || this.isRunning;
        if (!this.isRunning) {
            this.setStatus(database ? '' : 'Select a database in Explorer to run queries.', '');
        }
    }

    // Fill the editor with a given SQL string and run it immediately
    // (used by the per-object "Top 10" shortcut in Explorer).
    runQueryText(sql) {
        this.input.value = sql;
        this.runQuery();
    }

    // Fill the editor without running (used by the Explorer script generator)
    setQueryText(sql) {
        this.input.value = sql;
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
            this.setStatus('Select a database in Explorer first.', 'error');
            return;
        }
        if (!query) {
            this.setStatus('Enter a query first.', 'error');
            return;
        }

        this.setRunning(true);
        this.setStatus('Running...', '');
        this.resultsContainer.innerHTML = '<p class="placeholder-text">Running query...</p>';

        vscode.postMessage({
            command: 'executeQuery',
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

    // Toggle the Run/Cancel pair while a query is in flight
    setRunning(running) {
        this.isRunning = running;
        this.runBtn.disabled = running || !appState.currentDatabase;
        this.cancelBtn.style.display = running ? '' : 'none';
    }

    onQueryResult(message) {
        this.setRunning(false);
        const resultSets = message.resultSets || [];
        this.lastResultSets = resultSets;
        const duration = this.formatDuration(message.durationMs);

        if (resultSets.length === 0) {
            const affected = Array.isArray(message.rowsAffected)
                ? message.rowsAffected.reduce((sum, n) => sum + n, 0)
                : 0;
            let html = `<p class="placeholder-text">Query executed successfully. ${affected} row(s) affected.</p>`;
            html += this.buildMessagesBlock(message.messages);
            this.resultsContainer.innerHTML = html;
            this.setStatus(`Done in ${duration} — ${affected} row(s) affected.`, 'success');
            return;
        }

        this.displayResultSets(resultSets, message.messages);

        const totalShown = resultSets.reduce((sum, set) => sum + set.rows.length, 0);
        const totalRows = resultSets.reduce((sum, set) => sum + set.totalRows, 0);
        const truncated = totalShown < totalRows ? ` (showing ${totalShown} of ${totalRows})` : '';
        const setsLabel = resultSets.length > 1 ? `${resultSets.length} result sets, ` : '';
        this.setStatus(`Done in ${duration} — ${setsLabel}${totalRows} row(s)${truncated}.`, 'success');
    }

    onQueryError(message) {
        this.setRunning(false);
        this.resultsContainer.innerHTML = `<pre class="query-error-box">${this.escapeHtml(message.message)}</pre>`;
        const duration = message.durationMs ? ` after ${this.formatDuration(message.durationMs)}` : '';
        this.setStatus(message.cancelled ? `Query cancelled${duration}.` : `Query failed${duration}.`, 'error');
    }

    displayResultSets(resultSets, messages) {
        let html = '';

        resultSets.forEach((set, index) => {
            const label = resultSets.length > 1
                ? `Result ${index + 1} — ${set.totalRows} row(s)`
                : `${set.totalRows} row(s)`;
            html += `<div class="result-set-actions">`
                + `<span class="rs-label">${label}</span>`
                + `<span class="rs-spacer"></span>`
                + `<button data-rs-action="copy" data-rs-index="${index}" title="Copy to clipboard (tab-separated, pastes into Excel)"><i class="codicon codicon-copy"></i> Copy</button>`
                + `<button data-rs-action="csv" data-rs-index="${index}" title="Export this result set as a CSV file"><i class="codicon codicon-desktop-download"></i> CSV</button>`
                + `</div>`;

            if (set.rows.length < set.totalRows) {
                html += `<p class="truncation-note"><i class="codicon codicon-warning"></i> Showing first ${set.rows.length} of ${set.totalRows} rows (max rows limit).</p>`;
            }

            if (set.rows.length === 0) {
                html += '<p class="placeholder-text">No rows.</p>';
                return;
            }

            html += '<table><thead><tr>';
            set.columns.forEach(col => {
                html += `<th>${this.escapeHtml(col)}</th>`;
            });
            html += '</tr></thead><tbody>';

            set.rows.forEach(row => {
                html += '<tr>';
                set.columns.forEach(col => {
                    html += `<td>${this.escapeHtml(this.formatValue(row[col]))}</td>`;
                });
                html += '</tr>';
            });
            html += '</tbody></table>';
        });

        html += this.buildMessagesBlock(messages);
        this.resultsContainer.innerHTML = html;
    }

    // PRINT / RAISERROR informational output, shown under the results like SSMS "Messages"
    buildMessagesBlock(messages) {
        if (!messages || messages.length === 0) return '';
        return `<div class="query-messages"><pre>${this.escapeHtml(messages.join('\n'))}</pre></div>`;
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
            this.input.focus();
        }
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

// Allow unit tests to require() this file; in the webview `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = QueryManager;
}
