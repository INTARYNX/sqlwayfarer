/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

const { splitBatches } = require('./sqlBatches');

// === Syntax check by SQL Server itself ===
//
// The server is the authority on T-SQL syntax, so the check is its own parser:
// SET PARSEONLY ON, then the text of each batch. Nothing runs, nothing is
// resolved (an unknown table is not an error here), and what it reports is
// exactly what running the batch would report.
//
// Safety:
//  - the check has a connection of its own, never the one queries run on, so a
//    session option can never leak into the user's work;
//  - PARSEONLY is set again before every batch;
//  - a batch that mentions PARSEONLY is not sent: SET PARSEONLY OFF takes
//    effect at parse time, so the rest of that very batch would run;
//  - a script with sqlcmd variables or directives is not checked ($(x), :setvar,
//    :r...): they are not T-SQL and would be reported as errors.

const BATCH_TIMEOUT_MS = 10000;
const MAX_ERRORS = 50;
const SQLCMD_RE = /^[ \t]*:\w+|\$\(\w+\)/m;

// "Incorrect syntax near 'FROM'." / "...near the keyword 'FROM'." -> FROM
function nearToken(message) {
    const match = /near (?:the keyword )?'([^'\r\n]{1,60})'/i.exec(message);
    return match ? match[1] : '';
}

// What the server said, as [{ line, message, near }] on the lines of the whole
// script (the server counts from the start of each batch). One per line.
function toDiagnostics(errors, startLine) {
    const seen = new Set();
    const out = [];
    for (const error of errors) {
        const relative = error.lineNumber || (error.originalError && error.originalError.info && error.originalError.info.lineNumber) || 1;
        const line = startLine + relative - 1;
        if (seen.has(line)) continue;
        seen.add(line);
        out.push({ line, message: error.message, near: nearToken(error.message) });
    }
    return out;
}

class SyntaxChecker {
    // createManager(): a ConnectionManager of its own. getConnectionName(): the
    // saved connection the tab runs on.
    constructor({ createManager, getConnectionName, timeoutMs = BATCH_TIMEOUT_MS }) {
        this._createManager = createManager;
        this._getConnectionName = getConnectionName;
        this._timeoutMs = timeoutMs;
        this._manager = null;
        this._connection = null;
    }

    async _session() {
        if (this._connection) return this._connection;
        const manager = this._createManager();
        try {
            await manager.connectWithSaved(this._getConnectionName());
            const connection = await manager.acquireConnection();
            this._manager = manager;
            this._connection = connection;
            await connection.createRequest().batch('SET PARSEONLY ON');
            return connection;
        } catch (error) {
            await this.reset();
            try { await manager.dispose(); } catch { /* nothing was open */ }
            throw error;
        }
    }

    // Returns [{ line, message, near }]; [] when the script is fine or is not checked.
    async check(text) {
        if (typeof text !== 'string' || text.trim() === '' || SQLCMD_RE.test(text)) return [];
        const batches = splitBatches(text).filter(batch => !/parseonly/i.test(batch.sql));
        if (batches.length === 0) return [];
        try {
            const connection = await this._session();
            const diagnostics = [];
            for (const batch of batches) {
                await connection.createRequest().batch('SET PARSEONLY ON');
                diagnostics.push(...toDiagnostics(await this._parse(connection, batch.sql), batch.startLine));
                if (diagnostics.length >= MAX_ERRORS) break;
            }
            return diagnostics.slice(0, MAX_ERRORS);
        } catch (error) {
            // A broken session is not reused.
            await this.reset();
            throw error;
        }
    }

    async _parse(connection, sql) {
        const request = connection.createRequest();
        request.stream = true;
        const errors = [];
        request.on('error', error => errors.push(error));
        const timer = setTimeout(() => { try { request.cancel(); } catch { /* already finished */ } }, this._timeoutMs);
        try {
            await request.query(sql);
        } catch (error) {
            // A SQL Server error with a line is the answer (the same error also
            // arrives as an event); anything else - a lost connection, a cancel - is a failed check.
            if (!(error && error.number && error.lineNumber !== undefined)) throw error;
            if (!errors.some(e => e.message === error.message && e.lineNumber === error.lineNumber)) errors.push(error);
        } finally {
            clearTimeout(timer);
        }
        return errors;
    }

    async reset() {
        const manager = this._manager;
        const connection = this._connection;
        this._manager = null;
        this._connection = null;
        // The pool does not close while a connection is still taken from it.
        if (connection) { try { connection.release(); } catch { /* already gone */ } }
        if (manager) { try { await manager.dispose(); } catch { /* already closed */ } }
    }

    async dispose() {
        await this.reset();
    }
}

module.exports = { SyntaxChecker, toDiagnostics, nearToken, SQLCMD_RE };
