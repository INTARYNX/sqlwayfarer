'use strict';

const vscode = require('vscode');

const HISTORY_KEY = 'sqlwayfarer.queryHistory';
const HISTORY_LIMIT = 50;
const DEFAULT_MAX_ROWS = 1000;
const QUERY_TIMEOUT_MS = 5 * 60 * 1000;

class QueryHandlers {
    constructor(postMessage, connectionManager, workspaceState, riskAnalyzer = null) {
        this._post = postMessage;
        this._connectionManager = connectionManager;
        this._workspaceState = workspaceState;
        this._riskAnalyzer = riskAnalyzer;
        this._currentRequest = null;
        this._cancelReason = null;
    }

    // Modal confirmation for destructive statements; overridable in tests.
    async _confirmRisks(risks) {
        const selection = await vscode.window.showWarningMessage(
            'This query contains potentially destructive statements. Execute anyway?',
            { modal: true, detail: risks.join('\n') },
            'Execute'
        );
        return selection === 'Execute';
    }

    async handleExecuteQuery(database, query, maxRows) {
        if (!database) {
            this._post({ command: 'queryError', message: 'No database selected.' });
            return;
        }
        if (!query || !query.trim()) {
            this._post({ command: 'queryError', message: 'Query is empty.' });
            return;
        }
        if (this._currentRequest) {
            this._post({ command: 'queryError', message: 'A query is already running. Cancel it first.' });
            return;
        }

        if (this._riskAnalyzer) {
            const risks = this._riskAnalyzer.analyze(query);
            if (risks.length > 0 && !(await this._confirmRisks(risks))) {
                this._post({
                    command: 'queryError',
                    message: `Execution cancelled — potentially destructive statements:\n${risks.join('\n')}`,
                    cancelled: true
                });
                return;
            }
        }

        let request;
        try {
            request = this._connectionManager.createRequest();
        } catch (error) {
            this._post({ command: 'queryError', message: error.message });
            return;
        }

        const rowCap = Number(maxRows) > 0 ? Number(maxRows) : DEFAULT_MAX_ROWS;
        const startedAt = Date.now();

        this._currentRequest = request;
        this._cancelReason = null;

        // Streaming keeps memory bounded: rows beyond the cap are counted but
        // discarded instead of accumulating in the extension host.
        request.stream = true;

        const resultSets = [];
        const messages = [];
        const rowsAffected = [];
        const errors = [];
        let currentSet = null;

        request.on('recordset', columns => {
            currentSet = { columns: Object.keys(columns), rows: [], totalRows: 0 };
            resultSets.push(currentSet);
        });
        request.on('row', row => {
            if (!currentSet) return;
            currentSet.totalRows++;
            if (currentSet.rows.length < rowCap) currentSet.rows.push(row);
        });
        request.on('info', info => {
            if (info && info.message) messages.push(info.message);
        });
        request.on('rowsaffected', count => rowsAffected.push(count));
        request.on('error', err => errors.push(err));

        const timeout = setTimeout(() => {
            this._cancelReason = 'timeout';
            try { request.cancel(); } catch { /* request already finished */ }
        }, QUERY_TIMEOUT_MS);

        try {
            // In stream mode data arrives through events; the promise only signals
            // completion. Errors may surface here, as 'error' events, or both.
            await request.query(`USE [${database}];\n${query}`);
        } catch (error) {
            errors.push(error);
        } finally {
            clearTimeout(timeout);
            this._currentRequest = null;
        }

        const durationMs = Date.now() - startedAt;

        if (errors.length > 0) {
            let message;
            if (this._cancelReason === 'timeout') {
                message = `Query timed out after ${QUERY_TIMEOUT_MS / 1000}s and was cancelled.`;
            } else if (this._cancelReason === 'cancelled') {
                message = 'Query cancelled.';
            } else {
                // Same error can arrive as both an event and a rejection - dedupe on text.
                message = [...new Set(errors.map(e => this._formatSqlError(e)))].join('\n');
            }
            await this._recordHistory(database, query, false, durationMs);
            this._post({ command: 'queryError', message, durationMs, cancelled: this._cancelReason === 'cancelled' });
            return;
        }

        await this._recordHistory(database, query, true, durationMs);
        this._post({ command: 'queryResult', resultSets, rowsAffected, messages, durationMs, maxRows: rowCap });
    }

    handleCancelQuery() {
        if (!this._currentRequest) return;
        this._cancelReason = 'cancelled';
        try { this._currentRequest.cancel(); } catch { /* request already finished */ }
    }

    async handleGetQueryHistory() {
        this._post({ command: 'queryHistoryLoaded', history: this._getHistory() });
    }

    async handleClearQueryHistory() {
        await this._workspaceState.update(HISTORY_KEY, []);
        this._post({ command: 'queryHistoryLoaded', history: [] });
    }

    _formatSqlError(error) {
        const line = error.lineNumber || (error.originalError && error.originalError.info && error.originalError.info.lineNumber);
        // The injected `USE [database];` line shifts user SQL down by one.
        return line > 1 ? `Line ${line - 1}: ${error.message}` : error.message;
    }

    _getHistory() {
        return this._workspaceState.get(HISTORY_KEY, []);
    }

    // Prepend the query, dropping any older identical entry so re-runs don't pile up.
    async _recordHistory(database, query, success, durationMs) {
        const history = this._getHistory().filter(e => !(e.query === query && e.database === database));
        history.unshift({ query, database, success, durationMs, timestamp: Date.now() });
        if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
        await this._workspaceState.update(HISTORY_KEY, history);
        this._post({ command: 'queryHistoryLoaded', history });
    }
}

module.exports = QueryHandlers;
