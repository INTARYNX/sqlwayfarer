'use strict';

// Bridges the webview "Query graph" view to the QueryGraphService: given the
// SQL text of the editor, returns the tables it reads, the way they are
// joined together, and the tables reached through the procedures and
// functions the query calls.
class QueryGraphHandlers {
    constructor(postMessage, queryGraphService, getCurrentDatabase) {
        this._post = postMessage;
        this._service = queryGraphService;
        this._getCurrentDatabase = getCurrentDatabase;
    }

    async handleGetQueryGraph(database, sql) {
        const db = database || this._getCurrentDatabase();
        if (!db) {
            this._post({ command: 'queryGraphResult', success: false, message: 'No database selected.' });
            return;
        }
        if (!sql || !sql.trim()) {
            this._post({ command: 'queryGraphResult', success: false, message: 'Nothing to analyze in the editor.' });
            return;
        }
        try {
            const graph = await this._service.analyze(db, sql);
            this._post({ command: 'queryGraphResult', success: true, graph });
        } catch (error) {
            console.error('Query graph failed:', error);
            this._post({ command: 'queryGraphResult', success: false, message: error.message });
        }
    }
}

module.exports = QueryGraphHandlers;
