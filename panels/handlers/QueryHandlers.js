'use strict';

const vscode = require('vscode');
const { bracketIdentifier } = require('../../database/sqlIdentifier');
const { describeColumn } = require('../../database/columnTypes');
const { uniqueColumnKeys } = require('../../database/resultColumns');
const { splitBatches } = require('../../database/sqlBatches');
const { QuerySession } = require('../../database/QuerySession');

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

class QueryHandlers {
    constructor(postMessage, connectionManager, workspaceState, riskAnalyzer = null, getConnectionIdentity = () => null, onQuerySucceeded = null, isProduction = () => false) {
        this._post = postMessage;
        this._connectionManager = connectionManager;
        this._workspaceState = workspaceState;
        this._riskAnalyzer = riskAnalyzer;
        // True while the connection of this tab is marked as production.
        this._isProduction = isProduction;
        this._getConnectionIdentity = getConnectionIdentity;
        // Notified after every successful query (used to ask for a rating).
        this._onQuerySucceeded = onQuerySucceeded;
        // One connection for the whole panel: a transaction a script opens
        // stays on it until it is committed or rolled back (see QuerySession).
        this._session = new QuerySession(connectionManager);
        this._currentRequest = null;
        this._cancelReason = null;
        // Set synchronously before the (now async) connection acquire, so a
        // second call arriving during that brief await window is still
        // rejected - _currentRequest alone can't guard that gap, since it's
        // only set once a request actually exists, one batch in.
        this._executing = false;
    }

    // Modal confirmation for destructive statements; overridable in tests.
    async _confirmRisks(risks, production = false) {
        const selection = await vscode.window.showWarningMessage(
            production
                ? 'This is a PRODUCTION connection, and the query contains statements that change it. Execute anyway?'
                : 'This query contains potentially destructive statements. Execute anyway?',
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
            const production = this._isProduction();
            const risks = this._riskAnalyzer.analyze(query, { production });
            if (risks.length > 0 && !(await this._confirmRisks(risks, production))) {
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
            conn = await this._session.get();
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
                    // The USE only needs to run once, to establish the
                    // database selected in the dropdown as the starting
                    // context - after that, the connection's own context
                    // (whatever the script itself has done since) carries
                    // forward untouched, same as SSMS.
                    const errors = await this._executeOneBatch(
                        conn, database, batch.sql, isFirstBatch, actualPlan, rowCap,
                        resultSets, timeline, rowsAffected, planXmls
                    );
                    isFirstBatch = false;
                    if (this._cancelReason) break batchLoop;
                    for (const err of errors) {
                        formattedErrors.push(this._formatSqlError(err, batch.startLine));
                    }
                    // SSMS doesn't stop a script after one batch fails - the next
                    // GO-separated batch (or repetition) still runs.
                }
            }
        } finally {
            this._currentRequest = null;
            this._executing = false;
        }
        await this._postTransactionState();

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
        if (this._onQuerySucceeded) {
            try {
                await this._onQuerySucceeded();
            } catch (error) {
                // A failed rating prompt must never break the query result.
                console.warn('Rating prompt failed:', error.message);
            }
        }
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
        // The USE and the plan setting go as batches of their own: a batch
        // that starts with CREATE/ALTER PROCEDURE, VIEW, FUNCTION or TRIGGER
        // must be the first statement of its batch.
        const errors = [];
        let planOn = false;
        try {
            if (applyUsePrefix) await this._useDatabase(conn, database);
            if (actualPlan) {
                planOn = true;
                await conn.createRequest().batch('SET STATISTICS XML ON');
            }
            // A cancel that came in meanwhile: the script never starts.
            if (!this._cancelReason) errors.push(...await this._streamBatch(conn, batchSql, actualPlan, rowCap, resultSets, timeline, rowsAffected, planXmls));
        } catch (error) {
            errors.push(error);
        } finally {
            if (planOn) {
                // Back off even after a failure or a cancel: the connection goes back to the session.
                try { await conn.createRequest().batch('SET STATISTICS XML OFF'); } catch { /* the connection is gone */ }
            }
        }
        return errors;
    }

    // Streams one batch into the accumulators; returns its raw errors.
    async _streamBatch(conn, batchSql, actualPlan, rowCap, resultSets, timeline, rowsAffected, planXmls) {
        const request = conn.createRequest();
        this._currentRequest = request;
        // Streaming keeps memory bounded: rows beyond the cap are counted but
        // discarded instead of accumulating in the extension host.
        request.stream = true;
        // Rows by position: by name, the driver folds the columns of one name
        // into one, and has no key at all for a column with no name.
        request.arrayRowMode = true;

        const errors = [];
        let currentSet = null;
        let currentIsPlan = false;
        let keys = [];

        request.on('recordset', columns => {
            keys = uniqueColumnKeys(columns);
            // SQL Server names this recordset's single column "Microsoft SQL
            // Server 2005 XML Showplan" (a fixed legacy name, unrelated to
            // the actual server version) and reports it as NVarChar, not Xml.
            currentIsPlan = actualPlan && keys.length === 1 && keys[0] === 'Microsoft SQL Server 2005 XML Showplan';
            if (currentIsPlan) {
                currentSet = null;
                return;
            }
            currentSet = { columns: keys, types: columns.map(describeColumn), rows: [], totalRows: 0 };
            timeline.push({ type: 'resultSet', index: resultSets.length });
            resultSets.push(currentSet);
        });
        request.on('row', row => {
            if (currentIsPlan) {
                if (row[0]) planXmls.push(sanitizePlanXml(row[0]));
                return;
            }
            if (!currentSet) return;
            currentSet.totalRows++;
            if (currentSet.rows.length < rowCap) {
                const byKey = {};
                keys.forEach((key, i) => { byKey[key] = row[i]; });
                currentSet.rows.push(byKey);
            }
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
            await request.batch(batchSql);
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

        if (this._executing) {
            this._post({ command: 'queryError', message: 'A query is already running. Cancel it first.' });
            return;
        }
        this._executing = true;
        let conn;
        try {
            conn = await this._session.get();
        } catch (error) {
            this._executing = false;
            this._post({ command: 'queryError', message: error.message });
            return;
        }

        try {
            const planXmls = [];
            const planErrors = [];
            let isFirstBatch = true;

            for (const batch of batches) {
                for (let rep = 0; rep < batch.repeat; rep++) {
                    // Before SHOWPLAN goes on: with it on, a USE is planned, not run.
                    if (isFirstBatch) await this._useDatabase(conn, database);
                    isFirstBatch = false;
                    // .batch() is required here, not .query(): mssql's .query() sends
                    // the SQL via tedious's execSql (an RPC call wrapping it, in
                    // effect, in a system stored procedure), and SET SHOWPLAN_XML is
                    // explicitly documented as not working inside a stored procedure
                    // - the query just ran for real instead of being planned. .batch()
                    // sends it as a plain SQL batch, which showplan mode does respect.
                    await conn.createRequest().batch('SET SHOWPLAN_XML ON');
                    try {
                        const result = await conn.createRequest().batch(batch.sql);
                        const row = result.recordset && result.recordset[0];
                        const xml = row && Object.values(row)[0];
                        if (xml) planXmls.push(sanitizePlanXml(xml));
                        else planErrors.push(`Line ${batch.startLine}: no execution plan was returned for this batch.`);
                    } catch (error) {
                        planErrors.push(this._formatSqlError(error, batch.startLine));
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
            this._executing = false;
        }
    }

    // One statement the user has confirmed (Rename, Delete of the instance
    // tree), on the panel's session, in the database it concerns.
    async runStatement(database, sqlText) {
        if (this._executing) throw new Error('A query is running. Cancel it first.');
        this._executing = true;
        try {
            const conn = await this._session.get();
            await conn.createRequest().batch(`USE ${bracketIdentifier(database)};\n${sqlText}`);
        } finally {
            this._executing = false;
        }
        await this._postTransactionState();
    }

    // The transactions the panel's session has open, shown by the editor so
    // that one left open by a script is never forgotten.
    async _postTransactionState(error) {
        const count = await this._session.transactionCount();
        this._post({ command: 'transactionState', count, error });
        return count;
    }

    async handleEndTransaction(action) {
        if (action !== 'commit' && action !== 'rollback') return;
        if (this._executing) {
            this._post({ command: 'transactionState', count: await this._session.transactionCount(), error: 'A query is running. Cancel it first.' });
            return;
        }
        let error;
        try {
            await this._session.end(action);
        } catch (err) {
            error = err.message;
        }
        await this._postTransactionState(error);
    }

    // A query still running when the panel closes is cancelled first: the
    // connection answers one request at a time, and asking it about its
    // transaction in the middle of a run would break that run.
    async _settle() {
        if (!this._executing) return;
        this.handleCancelQuery();
        for (let i = 0; i < 100 && this._executing; i++) await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Number of open transactions, for the confirmation when the panel closes.
    async openTransactions() {
        await this._settle();
        return this._session.transactionCount();
    }

    // The connection was replaced (reconnect): whatever was open on the old
    // one is gone with it.
    async resetSession() {
        this._session.invalidate();
        await this._postTransactionState();
    }

    // Commits or rolls back what is open, then closes the session.
    async closeSession(action) {
        await this._settle();
        if (action === 'commit') {
            try { await this._session.end('commit'); } catch { /* the rollback of dispose() follows */ }
        }
        await this._session.dispose();
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

    // Makes `database` the context of the session. A batch of its own, and
    // an error without a line number: it belongs to no line of the script.
    async _useDatabase(conn, database) {
        try {
            await conn.createRequest().batch(`USE ${bracketIdentifier(database)};`);
        } catch (error) {
            throw new Error(error.message);
        }
    }

    // batchStartLine is the 1-indexed line of the batch in the ORIGINAL script
    // (1 when there's no GO at all), translating the server's batch-relative
    // line number back to the line the user actually sees in the editor - the
    // same correction SSMS itself makes for a multi-batch script.
    _formatSqlError(error, batchStartLine = 1) {
        const line = error.lineNumber || (error.originalError && error.originalError.info && error.originalError.info.lineNumber);
        if (!(line > 0)) return error.message;
        return `Line ${batchStartLine + line - 1}: ${error.message}`;
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
