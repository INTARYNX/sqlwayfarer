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
        this.isRunning = false;
        this.initEventListeners();
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
    }

    // Called by ExplorerManager whenever the shared database selector changes
    onDatabaseChanged(database) {
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
            if (resultSets.length > 1) {
                html += `<div class="result-set-header">Result ${index + 1} — ${set.totalRows} row(s)</div>`;
            }

            if (set.rows.length < set.totalRows) {
                html += `<p class="truncation-note">⚠ Showing first ${set.rows.length} of ${set.totalRows} rows (max rows limit).</p>`;
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
