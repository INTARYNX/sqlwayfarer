'use strict';

// Bridges the webview "Write footprint" view to the WriteFootprintService: given
// a programmable object, returns every table it reads/writes including the
// tables reached only through trigger cascades, plus the FK edges between them.
class FootprintHandlers {
    constructor(postMessage, footprintService, dataDictionaryService, getCurrentDatabase, relatedTablesService) {
        this._post = postMessage;
        this._service = footprintService;
        this._dataDictionaryService = dataDictionaryService;
        this._getCurrentDatabase = getCurrentDatabase;
        this._relatedTablesService = relatedTablesService;
    }

    async handleGetWriteFootprint(database, objectName) {
        const db = database || this._getCurrentDatabase();
        if (!db || !objectName) {
            this._post({ command: 'writeFootprintResult', success: false, message: 'No object selected.' });
            return;
        }
        try {
            const footprint = await this._service.analyze(db, objectName);
            this._post({ command: 'writeFootprintResult', success: true, objectName, footprint });
        } catch (error) {
            console.error('Write footprint failed:', error);
            this._post({ command: 'writeFootprintResult', success: false, objectName, message: error.message });
        }
    }

    // Lean per-table documentation for the footprint's tables (Schema/Tables tabs).
    async handleGetFootprintDoc(database, tableNames) {
        const db = database || this._getCurrentDatabase();
        if (!db) {
            this._post({ command: 'footprintDocResult', success: false, message: 'No database selected.' });
            return;
        }
        try {
            const doc = await this._dataDictionaryService.collectTablesDoc(db, tableNames || []);
            this._post({ command: 'footprintDocResult', success: true, doc });
        } catch (error) {
            console.error('Footprint doc failed:', error);
            this._post({ command: 'footprintDocResult', success: false, message: error.message });
        }
    }

    // The Schema tab's "Expand" action: tables linked to the given set by an
    // FK, or commonly used alongside it by other procedures/views (mined from
    // the cached index) - never fetched until asked for.
    async handleGetRelatedTables(database, tableNames) {
        const db = database || this._getCurrentDatabase();
        if (!db) {
            this._post({ command: 'relatedTablesResult', success: false, message: 'No database selected.' });
            return;
        }
        try {
            const related = await this._relatedTablesService.relatedTables(db, tableNames || []);
            this._post({ command: 'relatedTablesResult', success: true, related });
        } catch (error) {
            console.error('Related tables failed:', error);
            this._post({ command: 'relatedTablesResult', success: false, message: error.message });
        }
    }

    // "Add table": once a table is added by hand, every FK among the whole
    // set now on screen (seed, FK/usage neighbors, previously added tables)
    // is recomputed fresh, so an FK to or from the new table is never missed.
    async handleGetRelationshipsAmong(database, tableNames) {
        const db = database || this._getCurrentDatabase();
        if (!db) {
            this._post({ command: 'relationshipsAmongResult', success: false, message: 'No database selected.' });
            return;
        }
        try {
            const relationships = await this._relatedTablesService.relationshipsAmong(db, tableNames || []);
            this._post({ command: 'relationshipsAmongResult', success: true, relationships });
        } catch (error) {
            console.error('Relationships among failed:', error);
            this._post({ command: 'relationshipsAmongResult', success: false, message: error.message });
        }
    }
}

module.exports = FootprintHandlers;
