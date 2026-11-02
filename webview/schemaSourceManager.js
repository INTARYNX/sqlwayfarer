/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// The schema source of the tab: the Explorer, the index and the autocompletion
// can read another saved connection (say a development copy) while the queries
// keep running on the tab's own connection (say production). A banner says so
// for as long as the two differ, and the Query tab gets its own "Run on"
// database, since the database names of the two servers need not match.
class SchemaSourceManager {
    constructor() {
        this.select = document.getElementById('schemaSourceSelect');
        this.wrap = document.getElementById('schemaSourceWrap');
        this.banner = document.getElementById('sourceBanner');
        this.bannerText = document.getElementById('sourceBannerText');
        this.bannerReset = document.getElementById('sourceBannerReset');
        this.runWrap = document.getElementById('queryDatabaseWrap');
        this.runSelect = document.getElementById('queryDatabaseSelect');
        this.active = false;
        this.ownName = null;
        this.queryDatabase = '';
        this.queryDatabases = [];
        this._run = null;
        this._schema = null;
        if (this.select) this.select.addEventListener('change', () => this.choose(this.select.value));
        if (this.bannerReset) this.bannerReset.addEventListener('click', () => this.choose(''));
        if (this.runSelect) this.runSelect.addEventListener('change', () => this.onQueryDatabaseChosen(this.runSelect.value));
    }

    // Asked after every connection: which saved connections the schema can come from.
    request() {
        vscode.postMessage({ command: 'getSchemaSources' });
    }

    choose(name) {
        if (this.select) this.select.disabled = true;
        vscode.postMessage({ command: 'selectSchemaSource', name: name || '' });
    }

    onSchemaSources(message) {
        this.ownName = message.ownName;
        if (!this.select) return;
        const others = (message.sources || []).filter(s => !s.isOwn);
        this.select.innerHTML = '';
        const own = document.createElement('option');
        own.value = '';
        own.textContent = 'Schema: this connection';
        this.select.appendChild(own);
        for (const source of others) {
            const option = document.createElement('option');
            option.value = source.name;
            option.textContent = `Schema: ${source.name} (${source.server})`;
            this.select.appendChild(option);
        }
        this.select.value = message.activeName && others.some(s => s.name === message.activeName) ? message.activeName : '';
        this.select.disabled = false;
        // Nothing to choose between: the control stays out of the way.
        this.wrap.hidden = others.length === 0 && !message.activeName;
    }

    onSchemaSourceChanged(message) {
        if (this.select) this.select.disabled = false;
        if (message.error) {
            this.select.value = message.activeName || '';
            if (window.queryManager) window.queryManager.setStatus(message.error, 'error');
            return;
        }
        this.active = !!message.active;
        this._schema = message.schema || null;
        this._run = message.run || null;
        if (this.select) this.select.value = message.activeName || '';
        // What was selected belonged to the previous schema.
        const explorerSelect = document.getElementById('databaseSelect');
        if (explorerSelect && explorerSelect.value) {
            explorerSelect.value = '';
            explorerSelect.dispatchEvent(new Event('change'));
        }
        this.queryDatabase = '';
        this.render();
        if (this.active) vscode.postMessage({ command: 'getQueryDatabases' });
        if (window.queryManager) window.queryManager.refreshRunState();
    }

    onQueryDatabases(message) {
        this.queryDatabases = message.databases || [];
        this.fillRunSelect();
        // The same name on both servers is the usual case: take it.
        this.adoptSchemaDatabase(appState.currentDatabase);
    }

    // The Explorer moved to another database: follow it when the run side has one of that name.
    adoptSchemaDatabase(database) {
        if (!this.active || this.queryDatabase || !database) return;
        const match = this.queryDatabases.find(db => db.toLowerCase() === database.toLowerCase());
        if (match) this.onQueryDatabaseChosen(match);
    }

    onQueryDatabaseChosen(database) {
        this.queryDatabase = database || '';
        if (this.runSelect) this.runSelect.value = this.queryDatabase;
        this.render();
        if (window.queryManager) window.queryManager.refreshRunState();
    }

    fillRunSelect() {
        if (!this.runSelect) return;
        this.runSelect.innerHTML = '<option value="">Select...</option>';
        for (const db of this.queryDatabases) {
            const option = document.createElement('option');
            option.value = db;
            option.textContent = db;
            this.runSelect.appendChild(option);
        }
        this.runSelect.value = this.queryDatabase;
    }

    // The database the queries run on: the Explorer's while the schema and the
    // queries share a connection, the "Run on" one otherwise.
    targetDatabase() {
        return this.active ? this.queryDatabase : appState.currentDatabase;
    }

    render() {
        if (!this.banner) return;
        this.banner.hidden = !this.active;
        if (this.runWrap) this.runWrap.hidden = !this.active;
        if (!this.active) return;
        const e = text => (window.queryManager ? window.queryManager.escapeHtml(text) : String(text));
        const schema = this._schema || {};
        const run = this._run || {};
        const runDb = this.queryDatabase ? ` · ${e(this.queryDatabase)}` : ' · <em>no database chosen</em>';
        this.bannerText.innerHTML =
            `<span class="source-banner-schema"><i class="codicon codicon-database"></i> Schema: <strong>${e(schema.name || '?')}</strong>${schema.server ? ` (${e(schema.server)})` : ''}</span>`
            + `<span class="source-banner-run"><i class="codicon codicon-play"></i> Queries run on: <strong>${e(run.name || '?')}</strong>${run.server ? ` (${e(run.server)})` : ''}${runDb}</span>`;
        if (this.bannerReset) this.bannerReset.textContent = `Use ${run.name || 'the run connection'} for the schema`;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = SchemaSourceManager;
}
