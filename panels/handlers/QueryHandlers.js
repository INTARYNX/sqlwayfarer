'use strict';

class QueryHandlers {
    constructor(postMessage, connectionManager) {
        this._post = postMessage;
        this._connectionManager = connectionManager;
    }

    async handleExecuteQuery(database, query) {
        if (!database) {
            this._post({ command: 'queryError', message: 'No database selected.' });
            return;
        }
        if (!query || !query.trim()) {
            this._post({ command: 'queryError', message: 'Query is empty.' });
            return;
        }

        try {
            const result = await this._connectionManager.executeQueryInDatabase(database, query);

            // `mssql` puts SELECT rows in .recordset; statements with no result set
            // (INSERT/UPDATE/DELETE/DDL) leave it empty and report .rowsAffected instead.
            const recordset = result.recordset;
            if (recordset && recordset.length > 0) {
                const columns = recordset.columns ? Object.keys(recordset.columns) : Object.keys(recordset[0]);
                this._post({ command: 'queryResult', columns, rows: recordset, rowsAffected: result.rowsAffected });
            } else {
                this._post({ command: 'queryResult', columns: [], rows: [], rowsAffected: result.rowsAffected });
            }
        } catch (error) {
            this._post({ command: 'queryError', message: error.message });
        }
    }
}

module.exports = QueryHandlers;
