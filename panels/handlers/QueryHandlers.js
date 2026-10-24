'use strict';

const vscode = require('vscode');
const sql = require('mssql');

const HISTORY_KEY = 'sqlwayfarer.queryHistory';
const HISTORY_LIMIT = 50;
const DEFAULT_MAX_ROWS = 1000;
const QUERY_TIMEOUT_MS = 5 * 60 * 1000;

// SQL Server's showplan XML starts with <?xml version="1.0" encoding="utf-16"?>
// and can carry a leading BOM. Both are meaningless once the driver has
// already decoded the column into a JS string, but the webview's DOMParser
// chokes on them (silently producing an empty document, no <ShowPlanXML>
// root, which is what html-query-plan needs) - strip them before sending.
function sanitizePlanXml(xmlText) {
    const text = typeof xmlText === 'string' ? xmlText : String(xmlText);
    return text.replace(/^﻿/, '').replace(/^<\?xml[^>]*\?>\s*/i, '');
}

// T-SQL doesn't require a semicolon between statements, so a line starting
// with one of these also ends whatever came before it - not just a ';' does.
const STATEMENT_LEADER_RE = /^(select|with|insert|update|delete|merge|exec|execute)\b/i;

// Best-effort split of a batch into top-level statements: on ';', and on a
// line break into one of the keywords above, both only outside comments,
// string literals, bracketed identifiers and parentheses (so a subquery or a
// CTE's own body never causes a split). Not a real T-SQL parser - just enough
// to label result sets with the statement that produced them when the counts
// line up 1:1. A statement that itself contains nested newline-led keywords
// at depth 0 (e.g. a CTE followed by its final SELECT) can still be split in
// two; that only costs the label for that batch, never a wrong one, since
// labels are applied solely when the split count matches the recordset count.
function splitTopLevelStatements(sql) {
    const statements = [];
    let current = '';
    let depth = 0;
    let i = 0;
    const n = sql.length;

    const flush = () => {
        if (current.trim()) statements.push(current.trim());
        current = '';
    };

    while (i < n) {
        const ch = sql[i];

        if (ch === '-' && sql[i + 1] === '-') {
            const end = sql.indexOf('\n', i);
            const stop = end === -1 ? n : end + 1;
            current += sql.slice(i, stop);
            i = stop;
            continue;
        }
        if (ch === '/' && sql[i + 1] === '*') {
            const end = sql.indexOf('*/', i + 2);
            const stop = end === -1 ? n : end + 2;
            current += sql.slice(i, stop);
            i = stop;
            continue;
        }
        if (ch === "'") {
            let j = i + 1;
            while (j < n) {
                if (sql[j] === "'") {
                    if (sql[j + 1] === "'") { j += 2; continue; }
                    j += 1;
                    break;
                }
                j++;
            }
            current += sql.slice(i, j);
            i = j;
            continue;
        }
        if (ch === '[') {
            const end = sql.indexOf(']', i + 1);
            const stop = end === -1 ? n : end + 1;
            current += sql.slice(i, stop);
            i = stop;
            continue;
        }
        if (ch === '(') {
            depth++;
            current += ch;
            i++;
            continue;
        }
        if (ch === ')') {
            depth = Math.max(0, depth - 1);
            current += ch;
            i++;
            continue;
        }
        if (ch === ';' && depth === 0) {
            flush();
            i++;
            continue;
        }
        if ((ch === '\n' || ch === '\r') && depth === 0 && current.trim()) {
            const afterWs = sql.slice(i + 1).replace(/^[ \t\r\n]*/, '');
            if (STATEMENT_LEADER_RE.test(afterWs)) {
                flush();
                i++;
                continue;
            }
        }
        current += ch;
        i++;
    }
    flush();
    return statements;
}

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

    // actualPlan wraps the batch in SET STATISTICS XML ON/OFF: the query still
    // really executes (destructive statements included - same risk check
    // applies), but each statement gets an extra recordset appended right
    // after its own results, containing that statement's XML showplan with
    // real row counts. Detected by shape (a lone Xml-typed column) rather
    // than trusting column names, which SQL Server doesn't guarantee.
    async handleExecuteQuery(database, query, maxRows, actualPlan = false) {
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
        // Chronological record of everything the batch produced - a grid
        // starting or a PRINT/RAISERROR message - in the exact order SQL
        // Server emitted them, so the UI can show the real interleaving
        // instead of guessing which message belongs to which grid.
        const timeline = [];
        const rowsAffected = [];
        const errors = [];
        const planXmls = [];
        let currentSet = null;
        let currentIsPlan = false;

        request.on('recordset', columns => {
            const keys = Object.keys(columns);
            currentIsPlan = actualPlan && keys.length === 1 && columns[keys[0]]?.type?.name === 'Xml';
            if (actualPlan) {
                console.log('[QueryHandlers] actual-plan recordset:', keys.map(k => `${JSON.stringify(k)}:${columns[k]?.type?.name}`), 'detected as plan:', currentIsPlan);
            }
            if (currentIsPlan) {
                currentSet = null;
                return;
            }
            currentSet = { columns: keys, rows: [], totalRows: 0 };
            timeline.push({ type: 'resultSet', index: resultSets.length });
            resultSets.push(currentSet);
        });
        request.on('row', row => {
            if (currentIsPlan) {
                const xml = Object.values(row)[0];
                if (xml) planXmls.push(sanitizePlanXml(xml));
                return;
            }
            if (!currentSet) return;
            currentSet.totalRows++;
            if (currentSet.rows.length < rowCap) currentSet.rows.push(row);
        });
        request.on('info', info => {
            if (info && info.message) timeline.push({ type: 'message', text: info.message });
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
            const batch = actualPlan
                ? `SET STATISTICS XML ON;\nUSE [${database}];\n${query}\nSET STATISTICS XML OFF;`
                : `USE [${database}];\n${query}`;
            await request.query(batch);
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

        // Label each result set with the statement that produced it - only when
        // the split lines up 1:1 with the recordsets, so a mismatch (e.g. a proc
        // call yielding several sets from one EXEC) never shows a wrong guess.
        const statements = splitTopLevelStatements(query);
        if (statements.length === resultSets.length) {
            resultSets.forEach((set, i) => { set.sourceStatement = statements[i]; });
        }

        await this._recordHistory(database, query, true, durationMs);
        this._post({
            command: 'queryResult',
            resultSets, rowsAffected, timeline, durationMs, maxRows: rowCap,
            planXmls: actualPlan ? planXmls : undefined
        });
    }

    handleGetActualPlan(database, query, maxRows) {
        return this.handleExecuteQuery(database, query, maxRows, true);
    }

    // SET SHOWPLAN_XML must be the only statement in its batch, and the batch
    // it governs is never executed - just planned - so none of the normal
    // execution machinery (streaming, risk confirmation, history) applies
    // here. The 3 statements (ON / query / OFF) have to land on the exact
    // same physical connection - node-mssql only guarantees that via a
    // Transaction, since a plain pooled Request can be handed any connection.
    async handleGetEstimatedPlan(database, query) {
        if (!database) {
            this._post({ command: 'queryError', message: 'No database selected.' });
            return;
        }
        if (!query || !query.trim()) {
            this._post({ command: 'queryError', message: 'Query is empty.' });
            return;
        }

        let transaction;
        try {
            transaction = new sql.Transaction(this._connectionManager.getPool());
        } catch (error) {
            this._post({ command: 'queryError', message: error.message });
            return;
        }

        try {
            await transaction.begin();
            await new sql.Request(transaction).query('SET SHOWPLAN_XML ON');
            let result;
            try {
                result = await new sql.Request(transaction).query(`USE [${database}];\n${query}`);
            } finally {
                // Always turn it back off, even on failure, so this connection
                // isn't left stuck in plan-only mode once it's released to the pool.
                await new sql.Request(transaction).query('SET SHOWPLAN_XML OFF');
            }
            await transaction.commit();

            const row = result.recordset && result.recordset[0];
            const xml = row && Object.values(row)[0];
            if (!xml) {
                this._post({ command: 'queryError', message: 'No execution plan was returned.' });
                return;
            }
            this._post({ command: 'planResult', planXmls: [sanitizePlanXml(xml)] });
        } catch (error) {
            try { await transaction.rollback(); } catch { /* connection may already be gone */ }
            this._post({ command: 'queryError', message: `Failed to get estimated plan: ${this._formatSqlError(error)}` });
        }
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

QueryHandlers.splitTopLevelStatements = splitTopLevelStatements;
module.exports = QueryHandlers;
