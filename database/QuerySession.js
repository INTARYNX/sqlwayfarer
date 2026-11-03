'use strict';

// The session of one query panel: a single physical connection kept for the
// life of the panel, the way a query window of SSMS has one. A transaction
// opened by a script (BEGIN TRAN) therefore stays on this connection, can be
// seen, and is ended explicitly - it is never handed back to a pool where the
// Explorer or another script would run inside it, holding its locks.
//
// The connection comes from ConnectionManager.acquireConnection(), which also
// provides transactionCount() and endTransaction(action) on it.
class QuerySession {
    constructor(connectionManager) {
        this._manager = connectionManager;
        this._connection = null;
        this._opening = null;
    }

    // The pinned connection, opened on first use.
    async get() {
        if (this._connection) return this._connection;
        if (!this._opening) {
            this._opening = this._manager.acquireConnection()
                .then(connection => { this._connection = connection; return connection; })
                .finally(() => { this._opening = null; });
        }
        return this._opening;
    }

    // Number of open transactions (@@TRANCOUNT) of the session; 0 when there
    // is no session or it cannot answer (a lost connection holds nothing).
    async transactionCount() {
        if (!this._connection) return 0;
        try {
            return Number(await this._connection.transactionCount()) || 0;
        } catch {
            this.invalidate();
            return 0;
        }
    }

    // 'commit' or 'rollback' every open level. Returns the count left (0).
    async end(action) {
        if (!this._connection) return 0;
        await this._connection.endTransaction(action);
        return this.transactionCount();
    }

    // Forgets a connection that is broken, without talking to it.
    invalidate() {
        const connection = this._connection;
        this._connection = null;
        if (connection) { try { connection.release(); } catch { /* already gone */ } }
    }

    // Closes the session; whatever transaction is still open is rolled back.
    async dispose() {
        if (this._opening) { try { await this._opening; } catch { /* never opened */ } }
        const connection = this._connection;
        this._connection = null;
        if (!connection) return;
        try { await connection.endTransaction('rollback'); } catch { /* connection already gone */ }
        try { connection.release(); } catch { /* already gone */ }
    }
}

module.exports = { QuerySession };
