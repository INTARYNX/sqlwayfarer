'use strict';

const fs = require('fs').promises;
const { readCmsServers } = require('../../database/cmsImport');
const { parseRegisteredServersFile } = require('../../database/regsrvrImport');
const { planConnectionImport } = require('../../database/connectionImport');

const MAX_FILE_BYTES = 5000000;

// Imports connections from a Central Management Server or from a registered
// servers file (.regsrvr), into the saved connections. The dialogs are `ui`
// (VS Code's own pickers, see connectionImportUi.js); the reading is in
// database/cmsImport.js and database/regsrvrImport.js.
class ConnectionImportHandlers {
    // createManager(): a ConnectionManager of its own, used to read the CMS.
    // onImported(): the list of saved connections changed.
    constructor(postMessage, connectionStorage, { createManager, ui, onImported = async () => {} }) {
        this._post = postMessage;
        this._storage = connectionStorage;
        this._createManager = createManager;
        this._ui = ui;
        this._onImported = onImported;
    }

    async handleImportConnections() {
        const source = await this._ui.pickSource();
        if (!source) return;
        const entries = source === 'cms' ? await this._readCms() : await this._readFile();
        if (!entries || entries.length === 0) return;
        await this._offer(entries);
    }

    async _readCms() {
        const saved = this._storage.getSavedConnections();
        if (saved.length === 0) {
            this._ui.info('Save the connection to the Central Management Server first, then import from it.');
            return null;
        }
        const name = await this._ui.pickCmsConnection(saved);
        if (!name) return null;
        const manager = this._createManager();
        try {
            await manager.connectWithSaved(name);
            const entries = await readCmsServers(manager);
            if (entries.length === 0) this._ui.info(`No registered server in the Central Management Server of '${name}'.`);
            return entries;
        } catch (error) {
            this._ui.error(`Could not read the Central Management Server of '${name}': ${error.message}${/permission|denied/i.test(error.message) ? ' (reading it takes the ServerGroupReaderRole role in msdb)' : ''}`);
            return null;
        } finally {
            try { await manager.dispose(); } catch { /* nothing was open */ }
        }
    }

    async _readFile() {
        const file = await this._ui.pickFile();
        if (!file) return null;
        let text;
        try {
            const stat = await fs.stat(file);
            if (stat.size > MAX_FILE_BYTES) throw new Error('the file is too large');
            text = await fs.readFile(file, 'utf8');
        } catch (error) {
            this._ui.error(`Cannot read the file: ${error.message}`);
            return null;
        }
        const parsed = parseRegisteredServersFile(text);
        if (parsed.entries.length === 0) this._ui.error(parsed.errors[0] || 'No registered server found in the file.');
        return parsed.entries;
    }

    async _offer(entries) {
        const plan = planConnectionImport(this._storage.getSavedConnections(), entries);
        const chosen = await this._ui.pickEntries(plan);
        if (!chosen || chosen.length === 0) return;

        let added = 0;
        let overwritten = 0;
        let failed = 0;
        for (const item of chosen) {
            const result = await this._storage.saveConnection(item.config);
            if (!result.success) failed++;
            else if (item.sameName) overwritten++;
            else added++;
        }
        this._post({ command: 'connectionsImported', added, overwritten, failed });
        await this._onImported();
    }
}

module.exports = ConnectionImportHandlers;
