'use strict';

// Bridges the webview "Write footprint" view to the WriteFootprintService: given
// a programmable object, returns every table it reads/writes including the
// tables reached only through trigger cascades, plus the FK edges between them.
class FootprintHandlers {
    constructor(postMessage, footprintService, dataDictionaryService, getCurrentDatabase) {
        this._post = postMessage;
        this._service = footprintService;
        this._dataDictionaryService = dataDictionaryService;
        this._getCurrentDatabase = getCurrentDatabase;
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
}

module.exports = FootprintHandlers;
