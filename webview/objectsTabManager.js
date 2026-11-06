/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Builds a collapsible DOM tree for a JSON value. Containers (objects/arrays)
// start collapsed; their children are only built the first time they're
// expanded, so opening the modal on a huge index only ever pays the
// DOM-construction cost for whatever the user actually drills into - instead
// of eagerly formatting/rendering the entire thing up front.
function buildJsonNode(key, value, depth) {
    const isContainer = value !== null && typeof value === 'object';
    const isArray = isContainer && Array.isArray(value);
    const entries = isContainer ? (isArray ? value.map((v, i) => [i, v]) : Object.entries(value)) : null;

    const wrapper = document.createElement('div');
    wrapper.className = 'json-node';

    const row = document.createElement('div');
    row.className = 'json-row';
    row.style.paddingLeft = `${depth * 16}px`;
    wrapper.appendChild(row);

    const toggle = document.createElement('span');
    toggle.className = (isContainer && entries.length > 0) ? 'json-toggle codicon codicon-chevron-right' : 'json-toggle-spacer';
    row.appendChild(toggle);

    if (key !== null) {
        const keySpan = document.createElement('span');
        keySpan.className = 'json-key';
        keySpan.textContent = `${key}: `;
        row.appendChild(keySpan);
    }

    if (!isContainer) {
        const valueSpan = document.createElement('span');
        valueSpan.className = `json-value json-value-${value === null ? 'null' : typeof value}`;
        valueSpan.textContent = value === null ? 'null' : JSON.stringify(value);
        row.appendChild(valueSpan);
        return wrapper;
    }

    const openBrace = isArray ? '[' : '{';
    const closeBrace = isArray ? ']' : '}';
    const preview = document.createElement('span');
    preview.className = 'json-preview';
    preview.textContent = entries.length === 0
        ? `${openBrace}${closeBrace}`
        : `${openBrace}…${closeBrace} (${entries.length} ${isArray ? 'item' : 'key'}${entries.length === 1 ? '' : 's'})`;
    row.appendChild(preview);

    if (entries.length === 0) return wrapper;

    const childrenEl = document.createElement('div');
    childrenEl.className = 'json-children';
    childrenEl.style.display = 'none';
    wrapper.appendChild(childrenEl);

    let built = false;
    const expand = () => {
        toggle.classList.replace('codicon-chevron-right', 'codicon-chevron-down');
        preview.style.display = 'none';
        childrenEl.style.display = '';
        if (built) return;
        built = true;
        const renderChildren = () => {
            for (const [k, v] of entries) childrenEl.appendChild(buildJsonNode(k, v, depth + 1));
        };
        // Building DOM for a very large container (e.g. the "objects" map on a
        // big database) can itself take a noticeable moment - defer past the
        // next paint so the chevron flip is visible before that work runs,
        // instead of the click just appearing to hang.
        if (entries.length > 200) {
            childrenEl.textContent = 'Expanding…';
            setTimeout(() => { childrenEl.textContent = ''; renderChildren(); }, 0);
        } else {
            renderChildren();
        }
    };
    const collapseNode = () => {
        toggle.classList.replace('codicon-chevron-down', 'codicon-chevron-right');
        preview.style.display = '';
        childrenEl.style.display = 'none';
    };
    const toggleHandler = () => {
        if (childrenEl.style.display === 'none') expand(); else collapseNode();
    };
    toggle.addEventListener('click', toggleHandler);
    preview.addEventListener('click', toggleHandler);

    return wrapper;
}

function renderJsonTree(container, data) {
    container.innerHTML = '';
    if (data === null || typeof data !== 'object') {
        container.textContent = JSON.stringify(data, null, 2);
        return;
    }
    const isArray = Array.isArray(data);
    const entries = isArray ? data.map((v, i) => [i, v]) : Object.entries(data);
    for (const [k, v] of entries) container.appendChild(buildJsonNode(k, v, 0));
}

// Simple Objects Tab Manager (now backed by a modal opened from the top-bar indicator)
class ObjectsTabManager {
    constructor() {
        this.objectsJsonContent = document.getElementById('objectsJsonContent');
        this.forceReindexBtn = document.getElementById('forceReindexBtn');
        this.indicatorBtn = document.getElementById('objectsIndicatorBtn');
        this.indicatorDot = document.getElementById('objectsIndicatorDot');
        this.modalOverlay = document.getElementById('objectsModalOverlay');
        this.modalCloseBtn = document.getElementById('objectsModalCloseBtn');
        this.currentDatabase = null;
        this.status = 'none'; // none | indexing | ready | stale | error
        this.noticeEl = document.getElementById('indexNotice');
        this.state = 'unknown'; // what the host said: none | ready | stale | building | unknown
        this._dismissed = new Set(); // databases whose notice the user closed with "Not now"
        this._loadedForDatabase = null; // which database the displayed index belongs to
        this._rawIndexData = null; // last index received, formatted lazily (see _renderJsonIfNeeded)
        this._jsonRendered = false;
        this.statsContent = document.getElementById('indexStatsContent');
        this.view = 'json'; // json | stats - which part of the Index window is shown
        this._statsMarkdown = '';
        this.initEventListeners();
    }

    initEventListeners() {
        if (this.forceReindexBtn) {
            this.forceReindexBtn.addEventListener('click', () => this.handleForceReindex());
        }
        if (this.indicatorBtn) {
            this.indicatorBtn.addEventListener('click', () => this.openModal());
        }
        // The notice's buttons, and any "Build index" link shown in place of a missing result.
        document.addEventListener('click', (e) => {
            const target = e.target.closest('[data-index-action]');
            if (!target) return;
            if (target.dataset.indexAction === 'build') this.buildIndex();
            else if (target.dataset.indexAction === 'dismiss') this.dismissNotice();
        });
        // The Index / Stats tabs of the Index window, and the report button of the Stats view.
        this.modalOverlay.addEventListener('click', (e) => {
            const tab = e.target.closest('[data-index-view]');
            if (tab) { this.showView(tab.dataset.indexView); return; }
            const action = e.target.closest('[data-index-stats-action]');
            if (action && action.dataset.indexStatsAction === 'copy') this.copyStatsReport();
        });
        if (this.modalCloseBtn) {
            this.modalCloseBtn.addEventListener('click', () => this.closeModal());
        }
        if (this.modalOverlay) {
            this.modalOverlay.addEventListener('click', (e) => {
                if (e.target === this.modalOverlay) this.closeModal();
            });
        }
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.modalOverlay.classList.contains('visible')) {
                this.closeModal();
            }
        });
    }

    openModal() {
        this.modalOverlay.classList.add('visible');
        this._renderJsonIfNeeded();
        if (this.view === 'stats') this.requestStats();
    }

    closeModal() {
        this.modalOverlay.classList.remove('visible');
    }

    // Switches the Index window between the raw index and the statistics of the builds.
    showView(view) {
        this.view = view;
        this.modalOverlay.querySelectorAll('[data-index-view]').forEach(tab => tab.classList.toggle('active', tab.dataset.indexView === view));
        this.objectsJsonContent.hidden = view !== 'json';
        if (this.statsContent) this.statsContent.hidden = view !== 'stats';
        if (view === 'stats') this.requestStats();
    }

    requestStats() {
        if (this.currentDatabase) vscode.postMessage({ command: 'getBuildStats', database: this.currentDatabase });
    }

    onBuildStats(message) {
        if (message.database !== this.currentDatabase || !this.statsContent) return;
        this._statsMarkdown = message.markdown || '';
        this.statsContent.innerHTML = IndexStatsView.html({ runs: message.runs });
    }

    copyStatsReport() {
        if (!this._statsMarkdown) return;
        navigator.clipboard.writeText(this._statsMarkdown).catch(() => {});
    }

    // Builds the collapsible tree for the current index, deferred until the
    // modal is actually opened (instead of eagerly whenever an index result
    // arrives). Top-level containers start collapsed, so this itself is cheap
    // regardless of index size - see buildJsonNode for the per-node lazy
    // expansion that keeps large subtrees (e.g. "objects") cheap too.
    _renderJsonIfNeeded() {
        if (this._jsonRendered || !this._rawIndexData) return;
        renderJsonTree(this.objectsJsonContent, this._rawIndexData);
        this._jsonRendered = true;
    }

    // Reflect index status on the top-bar indicator dot
    setStatus(status, title) {
        this.status = status;
        if (this.indicatorDot) {
            this.indicatorDot.className = `indicator-dot dot-${status}`;
        }
        if (this.indicatorBtn && title) {
            this.indicatorBtn.title = title;
        }
    }

    // Called when database changes. Never builds anything: when Explorer is
    // open it only asks where the index of the new database stands, otherwise
    // that waits until Explorer is opened (TabManager.onExplorerTabActivated).
    onDatabaseChanged(database) {
        this.currentDatabase = database;
        this.state = 'unknown';
        this.hideNotice();
        appState.indexState = 'unknown';

        if (!database) {
            this.showPlaceholder();
            this.forceReindexBtn.disabled = true;
            this.indicatorBtn.disabled = true;
            this.setStatus('none', 'No database selected');
            return;
        }

        this.forceReindexBtn.disabled = false;
        this.indicatorBtn.disabled = false;

        if (appState.activeTab === 'explorer') {
            this.requestIndex(database);
        } else {
            this.showPlaceholder();
            this.setStatus('none', 'Index status is checked when Explorer is opened');
        }
    }

    // Asks the host where the index of `database` stands (none / ready / stale /
    // building). Only looks: the index is built when the user asks for it
    // (buildIndex), never as a side effect of opening the Explorer.
    requestIndex(database) {
        if (!database) return;
        vscode.postMessage({ command: 'getIndexStatus', database });
    }

    // The host's answer to requestIndex.
    onIndexStatus(message) {
        if (message.database !== this.currentDatabase) return;
        this.state = message.state;
        appState.indexState = message.state;

        switch (message.state) {
            case 'ready':
            case 'stale':
                this.setStatus(message.state, message.state === 'ready'
                    ? 'Index up to date'
                    : 'Index out of date - the schema changed since it was built');
                // Load what is cached (for the viewer) - this reads, it does not build.
                if (this._loadedForDatabase !== message.database) {
                    vscode.postMessage({ command: 'loadIndex', database: message.database });
                }
                if (message.state === 'stale' && !this._dismissed.has(message.database)) this.showNotice('stale', message);
                else this.hideNotice();
                break;
            case 'none':
                this._loadedForDatabase = null;
                this._rawIndexData = null;
                this._jsonRendered = false;
                this.setStatus('none', 'Index not built - see the notice in Explorer');
                this.objectsJsonContent.innerHTML = '<p class="placeholder-text">The index of this database has not been built yet. Use "Build index" in the Explorer notice.</p>';
                if (!this._dismissed.has(message.database)) this.showNotice('none', message);
                else this.hideNotice();
                break;
            case 'building':
                this.setStatus('indexing', 'Indexing...');
                this.hideNotice();
                break;
            default:
                this.setStatus('none', 'Index status unavailable');
                this.hideNotice();
        }
    }

    // The explanation and the choice, shown above the Explorer while there is
    // no usable index. kind: 'none' | 'stale'.
    showNotice(kind, message) {
        if (!this.noticeEl) return;
        const db = this.escapeHtml(this.currentDatabase);
        const icon = '<i class="codicon codicon-info index-notice-icon"></i>';
        let body;
        let after = ''; // below the buttons: the list of changed objects can be long
        if (kind === 'stale') {
            const built = message.builtAt ? this.escapeHtml(new Date(message.builtAt).toLocaleString()) : 'earlier';
            body = `
                <strong>The index of ${db} is out of date</strong>
                <p>It was built on ${built}, and the schema has changed since. Dependencies and column usage may be wrong or missing for the objects that changed.</p>
                <p>Updating only re-analyzes the objects that changed, so it is much quicker than the first build. Nothing is updated until you choose to.</p>`;
            after = this.changesHtml(message.changes);
        } else {
            body = `
                <strong>The dependency index of ${db} is not built</strong>
                <p>The index records which views, procedures, functions and triggers use which tables and columns. It is what the dependency <em>Tree</em> and <em>Graph</em>, the column usage, the write footprint and the query graph rely on (the data dictionary also lists dependencies from it).</p>
                <p>Building it reads the definition of every object of the database: from a few seconds to several minutes on a large one, with some load on the server. It only runs when you ask. The result is saved on this computer, so the next time only the changed objects are analyzed.</p>
                <p>Without the index, everything else works as usual: the object list, structure, code, comments, search and the Query tab.</p>`;
        }
        this.noticeEl.innerHTML = `
            ${icon}
            <div class="index-notice-body">
                ${body}
                <div class="index-notice-actions">
                    <button class="primary" data-index-action="build">${kind === 'stale' ? 'Update index' : 'Build index'}</button>
                    <button data-index-action="dismiss">Not now</button>
                </div>
                ${after}
            </div>`;
        this.noticeEl.hidden = false;
    }

    // The objects an update would re-analyze, as a collapsible list.
    changesHtml(changes) {
        if (!changes) return '';
        const LIMIT = 100;
        const groups = [['modified', 'Modified'], ['added', 'New'], ['removed', 'Removed']];
        const total = groups.reduce((n, [key]) => n + (changes[key] || []).length, 0);
        if (total === 0) return '';
        let shown = 0;
        const sections = groups.map(([key, label]) => {
            const names = (changes[key] || []).slice(0, Math.max(0, LIMIT - shown));
            shown += names.length;
            if (names.length === 0) return '';
            const more = (changes[key] || []).length - names.length;
            return `<div class="index-changes-group"><span class="index-changes-label">${label} (${(changes[key] || []).length})</span>`
                + `<ul>${names.map(n => `<li>${this.escapeHtml(n)}</li>`).join('')}${more > 0 ? `<li>... and ${more} more</li>` : ''}</ul></div>`;
        }).join('');
        return `<details class="index-changes"><summary>${total} object${total === 1 ? '' : 's'} to re-analyze</summary>${sections}</details>`;
    }

    hideNotice() {
        if (this.noticeEl) this.noticeEl.hidden = true;
    }

    // "Not now": the notice stays away for this database until the panel is reopened.
    dismissNotice() {
        if (this.currentDatabase) this._dismissed.add(this.currentDatabase);
        this.hideNotice();
    }

    // The user's decision to build (or update) the index.
    buildIndex() {
        const database = this.currentDatabase;
        if (!database) return;
        this.hideNotice();
        this.showLoading('Indexing...');
        this.setStatus('indexing', 'Indexing...');
        // The object list/graph stay greyed out until displayIndex unlocks them -
        // they'd otherwise read from a stale or half-built index.
        if (window.explorerManager) window.explorerManager.setPanelsLocked(true);
        vscode.postMessage({ command: 'getIndex', database });
    }

    // Handle force reindex button click
    handleForceReindex() {
        if (!this.currentDatabase) {
            return;
        }

        // Use VS Code's showWarningMessage instead of confirm()
        vscode.postMessage({
            command: 'confirmForceReindex',
            database: this.currentDatabase
        });
    }

    // Handle confirmation response from backend
    onForceReindexConfirmed(database) {
        this.showLoading('Force reindexing...');
        this.forceReindexBtn.disabled = true;

        vscode.postMessage({
            command: 'forceReindex',
            database: database
        });
    }

    // Handle indexing started
    onIndexingStarted(database, forced = false) {
        const message = forced ? 'Force reindexing started...' : 'Indexing started...';
        this.showLoading(message);
        this.forceReindexBtn.disabled = true;
        this.setStatus('indexing', message);
    }

    // Handle indexing cancelled
    onIndexingCancelled(result) {
        this.forceReindexBtn.disabled = false;
        // A cancellation for a database the user has since switched away from
        // shouldn't stomp on whatever's now shown for the current one.
        if (result.database && result.database !== this.currentDatabase) return;
        this.objectsJsonContent.innerHTML = `<p class="placeholder-text">${this.escapeHtml(result.message)}</p>`;
        this.setStatus(this.currentDatabase ? 'error' : 'none', result.message);
        this.requestIndex(this.currentDatabase);
    }

    escapeHtml(text) {
        if (text === null || text === undefined) return '';
        return String(text).replace(/[&<>"']/g, ch => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
        ));
    }

    // Show loading state
    showLoading(message = 'Loading database index...') {
        this.objectsJsonContent.innerHTML = `<p class="placeholder-text">${this.escapeHtml(message)}</p>`;
    }

    // Show placeholder
    showPlaceholder() {
        this.objectsJsonContent.innerHTML = '<p class="placeholder-text">Select a database to view the raw JSON index of all objects.</p>';
    }

    // Store the raw JSON index; the (potentially expensive) formatting is
    // deferred to _renderJsonIfNeeded, only once the modal is actually opened.
    // database is whichever database this result actually belongs to (may not
    // be this.currentDatabase anymore if the user switched database while the
    // build was in flight) - tracking it separately from the displayed data is
    // what lets requestIndex tell "already loaded" apart from "stale result".
    displayIndex(indexData, database = this.currentDatabase) {
        this.forceReindexBtn.disabled = false;
        if (window.explorerManager) window.explorerManager.setPanelsLocked(false);

        if (!indexData) {
            if (database === this.currentDatabase) {
                this.objectsJsonContent.innerHTML = '<p class="placeholder-text">No index data available.</p>';
                this.setStatus(this.currentDatabase ? 'error' : 'none', 'Indexing failed or was cancelled');
                // Offer the choice again.
                this.requestIndex(database);
            }
            return;
        }

        this._loadedForDatabase = database;

        // A result for a database the user has since switched away from -
        // keep it cached (requestIndex won't refetch it needlessly later) but
        // don't overwrite what's currently on screen for a different database.
        if (database !== this.currentDatabase) return;

        this._rawIndexData = indexData;
        this._jsonRendered = false;
        // A loaded cached index may be out of date: keep what the status said.
        if (this.state === 'stale') {
            this.setStatus('stale', 'Index out of date - the schema changed since it was built');
        } else {
            this.state = 'ready';
            appState.indexState = 'ready';
            this.hideNotice();
            this.setStatus('ready', 'Index up to date');
        }

        // A build just finished: its figures are new.
        if (this.view === 'stats') this.requestStats();

        if (this.modalOverlay.classList.contains('visible')) {
            this._renderJsonIfNeeded();
        } else {
            this.objectsJsonContent.innerHTML = '<p class="placeholder-text">Index ready - click to view.</p>';
        }
    }

    // Handle indexing progress
    onIndexingProgress(progress) {
        this.objectsJsonContent.innerHTML = `<p class="placeholder-text">Indexing in progress... ${progress.progress}% (${progress.current}/${progress.total})<br>${this.escapeHtml(progress.message)}</p>`;
    }

    // Handle indexing completion
    onIndexingCompleted(database, success, message) {
        this.forceReindexBtn.disabled = false;

        if (success) {
            this.setStatus('ready', 'Index up to date');
            // Read the index that was just built (this does not build anything).
            this._loadedForDatabase = null;
            this.state = 'ready';
            vscode.postMessage({
                command: 'loadIndex',
                database: database
            });
        } else {
            this.objectsJsonContent.innerHTML = `<p class="placeholder-text">Indexing failed: ${this.escapeHtml(message)}</p>`;
            this.setStatus('error', message);
            if (database === this.currentDatabase) this.requestIndex(database);
        }
    }

    // Handle force reindex completion
    onForceReindexCompleted(database, success, message) {
        this.onIndexingCompleted(database, success, message);
    }
}
