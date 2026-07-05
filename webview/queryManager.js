/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Simple query tool: runs free-form SQL against the currently selected database.
class QueryManager {
    constructor() {
        this.runBtn = document.getElementById('runQueryBtn');
        this.input = document.getElementById('queryInput');
        this.status = document.getElementById('queryStatus');
        this.resultsContainer = document.getElementById('queryResultsContainer');
        this.initEventListeners();
    }

    initEventListeners() {
        this.runBtn.addEventListener('click', () => this.runQuery());
        this.input.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                this.runQuery();
            }
        });
    }

    // Called by ExplorerManager whenever the shared database selector changes
    onDatabaseChanged(database) {
        this.runBtn.disabled = !database;
        this.setStatus(database ? '' : 'Select a database in Explorer to run queries.', '');
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

        if (!database) {
            this.setStatus('Select a database in Explorer first.', 'error');
            return;
        }
        if (!query) {
            this.setStatus('Enter a query first.', 'error');
            return;
        }

        this.runBtn.disabled = true;
        this.setStatus('Running...', '');
        this.resultsContainer.innerHTML = '<p class="placeholder-text">Running query...</p>';

        vscode.postMessage({ command: 'executeQuery', database, query });
    }

    onQueryResult(message) {
        this.runBtn.disabled = !appState.currentDatabase;
        const columns = message.columns || [];
        const rows = message.rows || [];

        if (columns.length === 0) {
            const affected = Array.isArray(message.rowsAffected)
                ? message.rowsAffected.reduce((sum, n) => sum + n, 0)
                : 0;
            this.resultsContainer.innerHTML = `<p class="placeholder-text">Query executed successfully. ${affected} row(s) affected.</p>`;
            this.setStatus(`Done — ${affected} row(s) affected.`, 'success');
            return;
        }

        this.displayResults(columns, rows);
        this.setStatus(`Done — ${rows.length} row(s) returned.`, 'success');
    }

    onQueryError(message) {
        this.runBtn.disabled = !appState.currentDatabase;
        this.resultsContainer.innerHTML = `<pre class="query-error-box">${this.escapeHtml(message.message)}</pre>`;
        this.setStatus('Query failed.', 'error');
    }

    displayResults(columns, rows) {
        if (rows.length === 0) {
            this.resultsContainer.innerHTML = '<p class="placeholder-text">Query returned no rows.</p>';
            return;
        }

        let html = '<table><thead><tr>';
        columns.forEach(col => {
            html += `<th>${this.escapeHtml(col)}</th>`;
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

        this.resultsContainer.innerHTML = html;
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

    escapeHtml(text) {
        if (text === null || text === undefined) return '';
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
    }
}
