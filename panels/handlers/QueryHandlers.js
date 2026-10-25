'use strict';

const vscode = require('vscode');
const { bracketIdentifier } = require('../../database/sqlIdentifier');

const HISTORY_KEY = 'sqlwayfarer.queryHistory';
const HISTORY_LIMIT = 50;
const DEFAULT_MAX_ROWS = 1000;
const QUERY_TIMEOUT_MS = 5 * 60 * 1000;
// "Unlimited" still needs a ceiling - without one, a multi-million-row SELECT
// accumulates entirely in the extension host (and then in one postMessage to
// the webview), risking an OOM that kills every open tab.
const UNLIMITED_SAFETY_CAP = 200000;

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

// SSMS/sqlcmd's "GO" batch separator - not real T-SQL, so it must never
// reach the server as part of a batch's text. A line counts as a separator
// only when it contains nothing but "GO" (optionally a repeat count, "GO 3",
// and/or a trailing line comment), outside comments, string literals and
// bracketed identifiers - same tokenizing rigor as splitTopLevelStatements.
const GO_LINE_RE = /^[ \t]*go[ \t]*(\d+)?[ \t]*(--.*)?\r?$/i;

// Splits a script into separate batches on standalone GO lines. Unlike a
// semicolon (which only separates statements WITHIN one batch/request), each
// GO-delimited batch is sent to the server as its own, separate round trip -
// variables and SET options from one batch don't carry over to the next,
// exactly as in SSMS. Returns [{ sql, repeat, startLine }]: repeat is the
// count after "GO N" (defaulting to 1, meaning run this batch that many times
// in a row), and startLine is the batch's 1-indexed line number in the
// ORIGINAL script - needed to translate a server-reported error line (always
// relative to just that one batch's own text) back into the line the user
// actually sees in the editor, the same correction SSMS itself makes.
function splitBatches(sql) {
    const batches = [];
    let current = '';
    let currentStartLine = 1;
    let lineBuffer = '';
    let lineNo = 1;
    let i = 0;
    const n = sql.length;

    const countNewlines = (text) => (text.match(/\n/g) || []).length;

    const flushLine = (newlineChar) => {
        const match = GO_LINE_RE.exec(lineBuffer);
        if (match) {
            const repeat = match[1] ? Math.max(1, parseInt(match[1], 10)) : 1;
            if (current.trim()) batches.push({ sql: current, repeat, startLine: currentStartLine });
            current = '';
            currentStartLine = lineNo + 1;
        } else {
            current += lineBuffer + (newlineChar || '');
        }
        lineBuffer = '';
    };

    while (i < n) {
        const ch = sql[i];

        if (ch === '-' && sql[i + 1] === '-') {
            const end = sql.indexOf('\n', i);
            const stop = end === -1 ? n : end;
            lineBuffer += sql.slice(i, stop);
            i = stop;
            continue;
        }
        if (ch === '/' && sql[i + 1] === '*') {
            const end = sql.indexOf('*/', i + 2);
            const stop = end === -1 ? n : end + 2;
            lineNo += countNewlines(sql.slice(i, stop));
            lineBuffer += sql.slice(i, stop);
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
            lineNo += countNewlines(sql.slice(i, j));
            lineBuffer += sql.slice(i, j);
            i = j;
            continue;
        }
        if (ch === '[') {
            const end = sql.indexOf(']', i + 1);
            const stop = end === -1 ? n : end + 1;
            lineNo += countNewlines(sql.slice(i, stop));
            lineBuffer += sql.slice(i, stop);
            i = stop;
            continue;
        }
        if (ch === '\n') {
            flushLine('\n');
            lineNo++;
            i++;
            continue;
        }
        lineBuffer += ch;
        i++;
    }
    flushLine('');
    if (current.trim()) batches.push({ sql: current, repeat: 1, startLine: currentStartLine });

    return batches;
}

class QueryHandlers {
    constructor(postMessage, connectionManager, workspaceState, riskAnalyzer = null, getConnectionIdentity = () => null) {
        this._post = postMessage;
        this._connectionManager = connectionManager;
        this._workspaceState = workspaceState;
        this._riskAnalyzer = riskAnalyzer;
        this._getConnectionIdentity = getConnectionIdentity;
        this._currentRequest = null;
        this._cancelReason = null;
        // Set synchronously before the (now async) connection acquire, so a
        // second call arriving during that brief await window is still
        // rejected - _currentRequest alone can't guard that gap, since it's
        // only set once a request actually exists, one batch in.
        this._executing = false;
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
    //
    // A script containing GO batches runs each one as its own separate
    // request, sequentially, on one pinned connection shared across all of
    // them (see acquireConnection()) - so a `USE`, SET option or #temp table
    // from an earlier batch is still visible to a later one, same as SSMS.
    // Results feed into the same shared resultSets/timeline/rowsAffected so
    // the UI sees one continuous result - exactly as if GO were invisible to
    // it. A batch that errors does NOT stop the rest of the script (SSMS
    // itself doesn't either); only a user cancel or a timeout does.
    async handleExecuteQuery(database, query, maxRows, actualPlan = false) {
        if (!database) {
            this._post({ command: 'queryError', message: 'No database selected.' });
            return;
        }
        if (!query || !query.trim()) {
            this._post({ command: 'queryError', message: 'Query is empty.' });
            return;
        }
        if (this._currentRequest || this._executing) {
            this._post({ command: 'queryError', message: 'A query is already running. Cancel it first.' });
            return;
        }
        this._executing = true;

        if (this._riskAnalyzer) {
            const risks = this._riskAnalyzer.analyze(query);
            if (risks.length > 0 && !(await this._confirmRisks(risks))) {
                this._executing = false;
                this._post({
                    command: 'queryError',
                    message: `Execution cancelled — potentially destructive statements:\n${risks.join('\n')}`,
                    cancelled: true
                });
                return;
            }
        }

        const batches = splitBatches(query);
        if (batches.length === 0) {
            // The whole script was just GO line(s) with no actual SQL around them.
            this._executing = false;
            this._post({ command: 'queryError', message: 'Query is empty.' });
            return;
        }

        // 0 is the explicit "Unlimited" choice in the Max rows selector - keep
        // every row up to a safety cap instead of either falling back to the
        // default cap or accumulating truly unbounded memory.
        const rowCap = Number(maxRows) === 0 ? UNLIMITED_SAFETY_CAP
            : Number(maxRows) > 0 ? Number(maxRows) : DEFAULT_MAX_ROWS;
        const startedAt = Date.now();
        this._cancelReason = null;

        const resultSets = [];
        // Chronological record of everything the whole script produced - a grid
        // starting or a PRINT/RAISERROR message - in the exact order SQL
        // Server emitted them, across every batch, so the UI can show the real
        // interleaving instead of guessing which message belongs to which grid.
        const timeline = [];
        const rowsAffected = [];
        const planXmls = [];
        const formattedErrors = [];

        let conn;
        try {
            conn = await this._connectionManager.acquireConnection();
        } catch (error) {
            this._executing = false;
            this._post({ command: 'queryError', message: error.message });
            return;
        }

        try {
            // All GO-separated batches (and GO-N repetitions) share this one
            // pinned connection, exactly like SSMS does for a multi-batch
            // script - otherwise a `USE`, SET option or #temp table from an
            // earlier batch would silently vanish the moment a later batch
            // landed on a different pooled connection.
            let isFirstBatch = true;
            batchLoop:
            for (const batch of batches) {
                // A cancel can arrive while still acquiring the connection,
                // before any batch - or any _currentRequest - exists yet;
                // catch that here so the script never starts at all instead
                // of silently ignoring it (see handleCancelQuery).
                if (this._cancelReason) break batchLoop;
                for (let rep = 0; rep < batch.repeat; rep++) {
                    // The USE prefix only needs to run once, to establish the
                    // database selected in the dropdown as the starting
                    // context - after that, the connection's own context
                    // (whatever the script itself has done since) carries
                    // forward untouched, same as SSMS.
                    const prefixLines = (isFirstBatch ? 1 : 0) + (actualPlan ? 1 : 0);
                    const errors = await this._executeOneBatch(
                        conn, database, batch.sql, isFirstBatch, actualPlan, rowCap,
                        resultSets, timeline, rowsAffected, planXmls
                    );
                    isFirstBatch = false;
                    if (this._cancelReason) break batchLoop;
                    for (const err of errors) {
                        formattedErrors.push(this._formatSqlError(err, prefixLines, batch.startLine));
                    }
                    // SSMS doesn't stop a script after one batch fails - the next
                    // GO-separated batch (or repetition) still runs.
                }
            }
        } finally {
            this._currentRequest = null;
            this._executing = false;
            conn.release();
        }

        const durationMs = Date.now() - startedAt;

        if (this._cancelReason || formattedErrors.length > 0) {
            let message;
            if (this._cancelReason === 'timeout') {
                message = `Query timed out after ${QUERY_TIMEOUT_MS / 1000}s and was cancelled.`;
            } else if (this._cancelReason === 'cancelled') {
                message = 'Query cancelled.';
            } else {
                // Same error can arrive as both an event and a rejection - dedupe on text.
                message = [...new Set(formattedErrors)].join('\n');
            }
            await this._recordHistory(database, query, false, durationMs);
            this._post({
                command: 'queryError', message, durationMs, cancelled: this._cancelReason === 'cancelled',
                // Whatever the script produced before stopping/failing - lets the
                // UI show the partial results instead of just the error.
                resultSets: resultSets.length > 0 ? resultSets : undefined,
                rowsAffected: rowsAffected.length > 0 ? rowsAffected : undefined,
                timeline: timeline.length > 0 ? timeline : undefined
            });
            return;
        }

        // Label each result set with the statement that produced it - only when
        // the split lines up 1:1 with the recordsets, so a mismatch (e.g. a proc
        // call yielding several sets from one EXEC, or a multi-batch GO script)
        // never shows a wrong guess.
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

    // Runs one GO-separated batch (or one repetition of a "GO N" batch)
    // against the server, with the same streaming event wiring
    // handleExecuteQuery has always used, feeding results into the shared
    // accumulators so multiple batches read as one continuous result in the
    // UI. Returns the batch's raw (unformatted) errors, if any - formatting
    // needs batch.startLine, which only the caller knows.
    async _executeOneBatch(conn, database, batchSql, applyUsePrefix, actualPlan, rowCap, resultSets, timeline, rowsAffected, planXmls) {
        const request = conn.createRequest();
        this._currentRequest = request;
        // Streaming keeps memory bounded: rows beyond the cap are counted but
        // discarded instead of accumulating in the extension host.
        request.stream = true;

        const errors = [];
        let currentSet = null;
        let currentIsPlan = false;

        request.on('recordset', columns => {
            const keys = Object.keys(columns);
            // SQL Server names this recordset's single column "Microsoft SQL
            // Server 2005 XML Showplan" (a fixed legacy name, unrelated to
            // the actual server version) and reports it as NVarChar, not Xml.
            currentIsPlan = actualPlan && keys.length === 1 && keys[0] === 'Microsoft SQL Server 2005 XML Showplan';
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
            const usePrefix = applyUsePrefix ? `USE ${bracketIdentifier(database)};\n` : '';
            const sent = actualPlan
                ? `SET STATISTICS XML ON;\n${usePrefix}${batchSql}\nSET STATISTICS XML OFF;`
                : `${usePrefix}${batchSql}`;
            await request.query(sent);
        } catch (error) {
            errors.push(error);
        } finally {
            clearTimeout(timeout);
        }

        return errors;
    }

    handleGetActualPlan(database, query, maxRows) {
        return this.handleExecuteQuery(database, query, maxRows, true);
    }

    // SET SHOWPLAN_XML must be the only statement in its batch, and the batch
    // it governs is never executed - just planned - so none of the normal
    // execution machinery (streaming, risk confirmation, history) applies
    // here. The 2 statements (ON / USE+query) have to land on the exact same
    // physical connection, or ON lands on one pooled connection while the
    // query runs for real on another - acquireConnection() pins one, same as
    // handleExecuteQuery (verified against a real server; see the .batch()
    // note below for the other, equally load-bearing half of this fix).
    //
    // A GO-separated script is planned one batch at a time on that same
    // pinned connection (ON/plan/OFF per batch), same as SSMS's own "Display
    // Estimated Execution Plan" on a multi-batch script - one plan per batch.
    // Only the first batch gets the USE prefix - same reasoning as
    // handleExecuteQuery: the user's own USE (if any) must carry forward.
    async handleGetEstimatedPlan(database, query) {
        if (!database) {
            this._post({ command: 'queryError', message: 'No database selected.' });
            return;
        }
        if (!query || !query.trim()) {
            this._post({ command: 'queryError', message: 'Query is empty.' });
            return;
        }

        const batches = splitBatches(query);
        if (batches.length === 0) {
            this._post({ command: 'queryError', message: 'Query is empty.' });
            return;
        }

        let conn;
        try {
            conn = await this._connectionManager.acquireConnection();
        } catch (error) {
            this._post({ command: 'queryError', message: error.message });
            return;
        }

        try {
            const planXmls = [];
            const planErrors = [];
            let isFirstBatch = true;

            for (const batch of batches) {
                for (let rep = 0; rep < batch.repeat; rep++) {
                    const prefixLines = isFirstBatch ? 1 : 0;
                    const usePrefix = isFirstBatch ? `USE ${bracketIdentifier(database)};\n` : '';
                    isFirstBatch = false;
                    // .batch() is required here, not .query(): mssql's .query() sends
                    // the SQL via tedious's execSql (an RPC call wrapping it, in
                    // effect, in a system stored procedure), and SET SHOWPLAN_XML is
                    // explicitly documented as not working inside a stored procedure
                    // - the query just ran for real instead of being planned. .batch()
                    // sends it as a plain SQL batch, which showplan mode does respect.
                    await conn.createRequest().batch('SET SHOWPLAN_XML ON');
                    try {
                        const result = await conn.createRequest().batch(`${usePrefix}${batch.sql}`);
                        const row = result.recordset && result.recordset[0];
                        const xml = row && Object.values(row)[0];
                        if (xml) planXmls.push(sanitizePlanXml(xml));
                        else planErrors.push(`Line ${batch.startLine}: no execution plan was returned for this batch.`);
                    } catch (error) {
                        planErrors.push(this._formatSqlError(error, prefixLines, batch.startLine));
                    } finally {
                        // Always turn it back off, even on failure, so this connection
                        // isn't left stuck in plan-only mode once it's released to the pool.
                        await conn.createRequest().batch('SET SHOWPLAN_XML OFF');
                    }
                }
            }

            if (planXmls.length === 0) {
                this._post({ command: 'queryError', message: planErrors.length ? planErrors.join('\n') : 'No execution plan was returned.' });
                return;
            }
            this._post({ command: 'planResult', planXmls, planErrors: planErrors.length > 0 ? planErrors : undefined });
        } catch (error) {
            this._post({ command: 'queryError', message: `Failed to get estimated plan: ${this._formatSqlError(error)}` });
        } finally {
            conn.release();
        }
    }

    handleCancelQuery() {
        // _executing (not _currentRequest) covers the whole run, including
        // the moment the connection is still being acquired from the pool -
        // a real async step now that GO-batches share one pinned connection,
        // not the synchronous createRequest() this used to race against.
        if (!this._executing) return;
        this._cancelReason = 'cancelled';
        if (this._currentRequest) {
            try { this._currentRequest.cancel(); } catch { /* request already finished */ }
        }
    }

    async handleGetQueryHistory() {
        this._post({ command: 'queryHistoryLoaded', history: this._getHistory() });
    }

    async handleClearQueryHistory() {
        await this._workspaceState.update(this._historyKey(), []);
        this._post({ command: 'queryHistoryLoaded', history: [] });
    }

    // prefixLines is 1 for a plain batch (USE [db];) or 2 for an actualPlan
    // batch (SET STATISTICS XML ON; + USE [db];) - whatever was prefixed
    // onto THIS specific batch's own text before sending it. batchStartLine
    // is that batch's 1-indexed line in the ORIGINAL script (1 when there's
    // no GO at all), translating the server's batch-relative line number
    // back to the line the user actually sees in the editor - the same
    // correction SSMS itself makes for a multi-batch script.
    _formatSqlError(error, prefixLines = 1, batchStartLine = 1) {
        const line = error.lineNumber || (error.originalError && error.originalError.info && error.originalError.info.lineNumber);
        if (!(line > prefixLines)) return error.message;
        const originalLine = batchStartLine + (line - prefixLines) - 1;
        return `Line ${originalLine}: ${error.message}`;
    }

    // Scoped per connection (server+login) so two tabs on different servers
    // never share, or clobber, each other's history - see connectionIdentity.
    _historyKey() {
        return `${HISTORY_KEY}::${this._getConnectionIdentity() || '(disconnected)'}`;
    }

    _getHistory() {
        return this._workspaceState.get(this._historyKey(), []);
    }

    // Prepend the query, dropping any older identical entry so re-runs don't pile up.
    async _recordHistory(database, query, success, durationMs) {
        const history = this._getHistory().filter(e => !(e.query === query && e.database === database));
        history.unshift({ query, database, success, durationMs, timestamp: Date.now() });
        if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
        await this._workspaceState.update(this._historyKey(), history);
        this._post({ command: 'queryHistoryLoaded', history });
    }
}

QueryHandlers.splitTopLevelStatements = splitTopLevelStatements;
QueryHandlers.splitBatches = splitBatches;
module.exports = QueryHandlers;
