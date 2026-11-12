/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// ExplorerManager class with enhanced schema support and object name utilities
// ExplorerManager class with enhanced schema support and object name utilities
class ExplorerManager {
    constructor() {
        this.initDOMElements();
        this.initEventListeners();
        this.dependencyVisualizer = new DependencyVisualizer();
        this.filterManager = new FilterManager();
        // qualified_name -> { row_count, reserved_kb }, filled by tableStatsLoaded
        this.tableStats = new Map();
        // Schema names collapsed in the Objects list - kept across re-renders
        // (filter changes, reindex refreshes) instead of resetting every time,
        // so a long object list stays navigable on a database with a lot of objects.
        this._collapsedSchemas = new Set();
        // obj.name -> its .object-item element, rebuilt on every displayObjects()
        // call. Filtering (updateObjectDisplay) looks up one element per object
        // on every keystroke - without this index it used querySelector in that
        // loop, an O(n) DOM scan per object, i.e. O(n^2) overall, which is what
        // froze the Explorer on a database with a lot of objects.
        this._objectItemsByName = new Map();
        // The objects open in the Explorer: { id, database, schema, object, label, objectType }.
        this._objectTabs = [];
        this._activeObjectTabId = null;
        this._nextObjectTabId = 1;
        this._activatingObjectTab = false;
    }

    initDOMElements() {
        this.elements = {
            databaseSelect: document.getElementById('databaseSelect'),
            objectList: document.getElementById('objectList'),
            detailsContent: document.getElementById('detailsContent'),
            explorerSection: document.querySelector('.explorer-section'),
            exportDictionaryBtn: document.getElementById('exportDictionaryBtn'),
            dictionaryFullChk: document.getElementById('dictionaryFullChk')
        };
    }

    initEventListeners() {
        this.elements.databaseSelect.addEventListener('change', () => this.handleDatabaseChange());
        this.elements.exportDictionaryBtn.addEventListener('click', () => this.handleExportDictionary());
        this.initObjectListKeyboard();

        // Cross-database dependency links (Dependencies table, dependency tree).
        // Their markup is re-rendered on every selection, so the click is
        // delegated from the document instead of being bound per node.
        document.addEventListener('click', (e) => {
            const link = e.target?.closest?.('.dep-link');
            if (!link) return;
            e.preventDefault();
            const db = link.dataset.db;
            const name = link.dataset.name;
            if (!db || !name) return;
            this.revealExternalObject(db, link.dataset.schema || 'dbo', name, { newTab: true });
        });

        // The Explorer tab works like the Query one: it names the active object,
        // with its cross, an arrow for the list of the others and a way to start
        // another one.
        this.objectTabsDropdown = document.getElementById('explorerTabsDropdown');
        const tabsBtn = document.getElementById('explorerTabsBtn');
        const explorerTab = document.querySelector('.tab-button[data-tab="explorer"]');
        tabsBtn.addEventListener('click', (e) => { e.stopPropagation(); this.toggleObjectTabsDropdown(); });
        explorerTab.addEventListener('dblclick', (e) => { e.stopPropagation(); this.toggleObjectTabsDropdown(); });
        document.getElementById('explorerActiveClose').addEventListener('click', (e) => {
            e.stopPropagation();
            this.closeObjectTab(this._activeObjectTabId);
        });
        this.objectTabsDropdown.addEventListener('click', (e) => {
            const close = e.target.closest('[data-qtab-close]');
            if (close) { e.stopPropagation(); this.closeObjectTab(Number(close.dataset.qtabClose)); return; }
            if (e.target.closest('[data-qtab-add]')) { this.addObjectTab(); this.closeObjectTabsDropdown(); return; }
            const item = e.target.closest('.query-tabs-dropdown-item');
            if (item) { this.activateObjectTab(Number(item.dataset.qtabId)); this.closeObjectTabsDropdown(); }
        });
        document.addEventListener('click', (e) => {
            if (!this.objectTabsDropdown.classList.contains('visible')) return;
            if (this.objectTabsDropdown.contains(e.target) || tabsBtn.contains(e.target) || explorerTab.contains(e.target)) return;
            this.closeObjectTabsDropdown();
        });
    }

    // === Object tabs ========================================================
    // One tab per inspected object. A link (dependency, tree, graph, editor)
    // opens a tab of its own; a click in the object list or the instance tree
    // reuses the active one. Showing a tab reads its object again.

    toggleObjectTabsDropdown() {
        if (this.objectTabsDropdown.classList.contains('visible')) this.closeObjectTabsDropdown();
        else {
            // One list at a time: the Query's closes.
            if (window.queryFileManager) window.queryFileManager.closeTabsDropdown();
            this.renderObjectTabsDropdown();
            this.objectTabsDropdown.classList.add('visible');
        }
    }

    closeObjectTabsDropdown() {
        this.objectTabsDropdown.classList.remove('visible');
    }

    _trackObjectTab(target, { newTab }) {
        if (this._activatingObjectTab) return;
        const lower = text => (text || '').toLowerCase();
        const existing = this._objectTabs.find(t => !t.empty && t.database === target.database
            && lower(t.schema) === lower(target.schema) && lower(t.object) === lower(target.object));
        const active = this._objectTabs.find(t => t.id === this._activeObjectTabId);
        if (existing) {
            this._activeObjectTabId = existing.id;
            if (target.objectType) existing.objectType = target.objectType;
        } else if (active && (!newTab || active.empty)) {
            Object.assign(active, target, { empty: false });
        } else {
            const tab = { id: this._nextObjectTabId++, empty: false, ...target };
            this._objectTabs.push(tab);
            this._activeObjectTabId = tab.id;
        }
        this.renderObjectTabs();
    }

    // A tab with no object yet: the next one picked fills it.
    addObjectTab() {
        const tab = { id: this._nextObjectTabId++, empty: true, database: appState.currentDatabase, schema: '', object: '', label: 'New', objectType: null };
        this._objectTabs.push(tab);
        this._activeObjectTabId = tab.id;
        this._showNoObject();
        if (window.tabManager) window.tabManager.switchTab('explorer');
        this.renderObjectTabs();
    }

    _showNoObject() {
        appState.selectedObject = null;
        const prevSelected = this.elements.objectList.querySelector('.selected');
        if (prevSelected) prevSelected.classList.remove('selected');
        this.elements.detailsContent.innerHTML = '<p>Select an object to view its details.</p>';
    }

    renderObjectTabs() {
        const active = this._objectTabs.find(t => t.id === this._activeObjectTabId);
        document.getElementById('explorerActiveTabLabel').textContent = active ? active.label : '';
        document.getElementById('explorerActiveClose').hidden = !active;
        const count = document.getElementById('explorerTabsCount');
        count.hidden = this._objectTabs.length < 2;
        count.textContent = String(this._objectTabs.length);
        if (this.objectTabsDropdown.classList.contains('visible')) this.renderObjectTabsDropdown();
    }

    // The list is the other tabs: the active one is on the Explorer tab, with its own cross.
    renderObjectTabsDropdown() {
        const items = this._objectTabs.filter(t => t.id !== this._activeObjectTabId).map(tab => {
            const full = tab.empty ? 'An empty tab' : `${tab.database}.${tab.schema}.${tab.object}`;
            return `<div class="query-tabs-dropdown-item" data-qtab-id="${tab.id}" role="menuitem" title="${this.escapeHtml(full)}">`
                + `<span class="qtab-name">${this.escapeHtml(tab.label)}</span>`
                + (!tab.empty && tab.database ? `<span class="qtab-db" title="Database of this object">${this.escapeHtml(tab.database)}</span>` : '')
                + `<span class="qtab-close" data-qtab-close="${tab.id}">×</span>`
                + '</div>';
        }).join('');
        this.objectTabsDropdown.innerHTML = items
            + '<button type="button" class="query-tabs-dropdown-add" data-qtab-add="1"><i class="codicon codicon-add"></i> New tab</button>';
    }

    activateObjectTab(id) {
        const tab = this._objectTabs.find(t => t.id === id);
        if (!tab) return;
        this._activeObjectTabId = id;
        this.renderObjectTabs();
        if (tab.empty) { this._showNoObject(); return; }
        this._activatingObjectTab = true;
        try {
            // The database belongs to the tab: showing it puts the Explorer on that database.
            const sameDatabase = tab.database === appState.currentDatabase;
            if (!sameDatabase) this.switchToDatabase(tab.database);
            const element = sameDatabase ? this._objectItemsByName.get(tab.label) : null;
            const obj = element && (appState.allObjects || []).find(o => o.name === tab.label);
            if (element && obj) this.handleObjectClick(element, obj);
            else this.revealExternalObject(tab.database, tab.schema, tab.object);
        } finally {
            this._activatingObjectTab = false;
        }
    }

    closeObjectTab(id) {
        const index = this._objectTabs.findIndex(t => t.id === id);
        if (index === -1) return;
        this._objectTabs.splice(index, 1);
        if (id !== this._activeObjectTabId) { this.renderObjectTabs(); return; }
        const next = this._objectTabs[Math.min(index, this._objectTabs.length - 1)];
        if (next) { this.activateObjectTab(next.id); return; }
        this._activeObjectTabId = null;
        this._showNoObject();
        this.renderObjectTabs();
    }

    // Generate and save the Markdown data dictionary for the selected database
    handleExportDictionary() {
        if (!appState.currentDatabase) return;
        this.elements.exportDictionaryBtn.disabled = true;
        this.elements.exportDictionaryBtn.innerHTML = '<i class="codicon codicon-library"></i> Exporting…';
        vscode.postMessage({
            command: 'exportDataDictionary',
            database: appState.currentDatabase,
            full: !!(this.elements.dictionaryFullChk && this.elements.dictionaryFullChk.checked)
        });
    }

    onDictionaryExported() {
        this.elements.exportDictionaryBtn.disabled = !appState.currentDatabase;
        this.elements.exportDictionaryBtn.innerHTML = '<i class="codicon codicon-library"></i> Dictionary';
    }

    // Grey out / re-enable the explorer panels
    setPanelsLocked(locked) {
        this.elements.explorerSection.classList.toggle('locked', locked);
    }

    // Called when background indexing completes for a database - unlocks the
    // panels only if that database is still the one currently selected (the
    // user may have gone back to "select a database" while it was indexing).
    onIndexingSettled(database) {
        if (appState.currentDatabase && database === appState.currentDatabase) {
            this.setPanelsLocked(false);
        }
    }

    // Reveal an object by its qualified (or bare) name, e.g. from a footprint
    // graph node. Matches against the loaded object list, case-insensitively.
    revealByName(name) {
        const q = (name || '').toLowerCase();
        const obj = (appState.allObjects || []).find(o =>
            (o.qualified_name || '').toLowerCase() === q || (o.name || '').toLowerCase() === q);
        if (obj) this.revealObject(obj);
    }

    // Jump to an object from elsewhere in the app (e.g. Ctrl+Click in the query
    // editor): switch to the Explorer tab, scroll to the object and select it.
    revealObject(obj) {
        if (window.tabManager) {
            window.tabManager.switchTab('explorer');
        }
        const element = this._objectItemsByName.get(obj.name);
        if (element) {
            element.scrollIntoView({ block: 'center' });
            this.handleObjectClick(element, obj, { newTab: true });
        }
    }

    // Jump to an object in a database other than the one currently selected
    // (e.g. a 3-part "otherDb.schema.object" reference in the query editor).
    // That database's object list was never loaded into the tree, so there's
    // no node to select/scroll to and the object's type isn't known yet -
    // ask the backend to resolve it and fetch its details in one round trip.
    revealExternalObject(database, schema, name, { newTab = false } = {}) {
        if (window.tabManager) {
            window.tabManager.switchTab('explorer');
        }
        this._trackObjectTab({ database, schema, object: name, label: `${schema}.${name}`, objectType: null }, { newTab });
        const prevSelected = this.elements.objectList.querySelector('.selected');
        if (prevSelected) prevSelected.classList.remove('selected');

        const qualifiedName = `${schema}.${name}`;
        this._currentDetailsDatabase = database;
        appState.selectedObject = { name: qualifiedName, qualified_name: qualifiedName, object_name: name, schema_name: schema, database };
        this.elements.detailsContent.innerHTML =
            `<p class="placeholder-text">Loading ${this.escapeHtml(database)}.${this.escapeHtml(qualifiedName)}…</p>`;

        // The tree shows the object that was left until the new one is read.
        const tree = document.getElementById('treeContainer');
        if (appState.activeDetailsTab === 'tree' && tree) {
            tree.innerHTML = `<p class="placeholder-text">Loading ${this.escapeHtml(database)}.${this.escapeHtml(qualifiedName)}…</p>`;
        }
        this._externalPending = qualifiedName;

        vscode.postMessage({ command: 'getObjectDetailsAuto', database, objectName: qualifiedName });
    }

    // UTILITY METHODS FOR CONSISTENT OBJECT NAME HANDLING
    _getQualifiedName(obj) {
        return obj.qualified_name || obj.name;
    }

    _getDisplayName(obj) {
        return obj.name;
    }

    // The database the explorer works on, picked from elsewhere (the instance
    // tree): the same as choosing it in the select. False when it is already
    // the one, or the select does not list it.
    switchToDatabase(database) {
        const select = this.elements.databaseSelect;
        if (!database || select.value === database || ![...select.options].some(o => o.value === database)) return false;
        select.value = database;
        select.dispatchEvent(new Event('change'));
        return true;
    }

    handleDatabaseChange() {
        const database = this.elements.databaseSelect.value;
        appState.currentDatabase = database;
        this.elements.exportDictionaryBtn.disabled = !database;
        if (window.schemaSourceManager) window.schemaSourceManager.adoptSchemaDatabase(database);

        // The explorer works as soon as a database is chosen: it does not wait
        // for the dependency index, which is only built when the user asks
        // (the lock around a build: see ObjectsTabManager.buildIndex).
        this.setPanelsLocked(!database);

        vscode.postMessage({
            command: 'setCurrentDatabase',
            database: database
        });

        if (database) {
            this.elements.objectList.innerHTML = '<p class="placeholder-text">Loading objects...</p>';
            this.elements.detailsContent.innerHTML = '<p>Select an object to view its details.</p>';

            this.filterManager.resetFilters();
            this.filterManager.disableFilters();

            window.commentsManager.onDatabaseChanged();

            // NEW: Notify Objects tab about database change
            if (window.objectsTabManager) {
                window.objectsTabManager.onDatabaseChanged(database);
            }

            if (window.queryManager) {
                window.queryManager.onDatabaseChanged(database);
            }
            if (window.compareManager) window.compareManager.onDatabaseChanged();

            vscode.postMessage({
                command: 'getObjects',
                database: database
            });
            vscode.postMessage({
                command: 'getForeignKeys',
                database: database
            });
        } else {
            this.elements.objectList.innerHTML = '<p class="placeholder-text">Select a database to view objects.</p>';
            this.elements.detailsContent.innerHTML = '<p>Select a database first.</p>';
            appState.allObjects = [];
            appState.filteredObjects = [];
            appState.foreignKeys = [];
            this.filterManager.disableFilters();
            this.filterManager.updateObjectCount();
            window.commentsManager.onDatabaseChanged();
            if (window.objectsTabManager) {
                window.objectsTabManager.onDatabaseChanged(null);
            }
            if (window.queryManager) {
                window.queryManager.onDatabaseChanged(null);
            }
            if (window.compareManager) window.compareManager.onDatabaseChanged();
        }
    }

    handleObjectClick(element, obj, { newTab = false } = {}) {
        const prevSelected = this.elements.objectList.querySelector('.selected');
        if (prevSelected) {
            prevSelected.classList.remove('selected');
            prevSelected.removeAttribute('aria-selected');
        }

        element.classList.add('selected');
        element.setAttribute('aria-selected', 'true');
        appState.selectedObject = obj;
        this._currentDetailsDatabase = appState.currentDatabase;

        const objectNameForBackend = this._getQualifiedName(obj);
        const dot = objectNameForBackend.indexOf('.');
        this._trackObjectTab({
            database: appState.currentDatabase,
            schema: obj.schema_name || (dot > 0 ? objectNameForBackend.slice(0, dot) : 'dbo'),
            object: obj.object_name || (dot > 0 ? objectNameForBackend.slice(dot + 1) : objectNameForBackend),
            label: obj.name,
            objectType: obj.object_type
        }, { newTab });

        if (obj.object_type === 'Table') {
            vscode.postMessage({
                command: 'getTableDetails',
                database: appState.currentDatabase,
                table: objectNameForBackend
            });
        } else {
            vscode.postMessage({
                command: 'getObjectDetails',
                database: appState.currentDatabase,
                objectName: objectNameForBackend,
                objectType: obj.object_type
            });
        }

        this._refreshActiveDetailsTab(appState.currentDatabase, objectNameForBackend, obj.object_type);
    }

    // The tab of the details that is showing (comments, code, tree) is filled for the
    // object that was just selected. The graph is drawn when the details arrive.
    _refreshActiveDetailsTab(database, objectName, objectType) {
        if (appState.activeDetailsTab === 'comments') {
            window.commentsManager.loadCommentsForObject(database, objectName, objectType);
        } else if (appState.activeDetailsTab === 'code') {
            window.codeViewManager.loadCodeForObject(database, objectName, objectType);
        } else if (appState.activeDetailsTab === 'tree') {
            vscode.postMessage({ command: 'getDependencyTree', database, objectName, maxDepth: 3 });
        }
    }

    // The details of an object of another database have arrived, so its type is known: the
    // tab that is showing (the tree, the code, the comments) follows the object, which the
    // click on a link alone did not do - on the Tree tab, nothing seemed to happen.
    _onExternalResolved(objectName, objectType) {
        if (this._externalPending !== objectName) return;
        this._externalPending = null;
        if (appState.selectedObject) appState.selectedObject.object_type = objectType;
        const tab = this._objectTabs.find(t => t.id === this._activeObjectTabId);
        if (tab && !tab.objectType) { tab.objectType = objectType; this.renderObjectTabs(); }
        this._refreshActiveDetailsTab(this._currentDetailsDatabase, objectName, objectType);
    }

    handleShowDependencies(objectName, event) {
        event.stopPropagation();

        appState.pendingVisualization = objectName;

        if (appState.selectedObject && this._getDisplayName(appState.selectedObject) === objectName && appState.currentDependencies) {
            this.dependencyVisualizer.showDependencyVisualization(objectName, appState.currentDependencies);
        } else {
            const obj = appState.allObjects.find(o => this._getDisplayName(o) === objectName);
            const qualifiedName = obj ? this._getQualifiedName(obj) : objectName;

            vscode.postMessage({
                command: 'getObjectDetails',
                database: appState.currentDatabase,
                objectName: qualifiedName,
                objectType: 'Object'
            });
        }
    }

    onDatabasesLoaded(databases, currentDatabase) {
        appState.databases = databases || [];
        this.elements.databaseSelect.disabled = false;
        this.elements.databaseSelect.innerHTML = '<option value="">Select a database...</option>';

        databases.forEach(db => {
            const option = document.createElement('option');
            option.value = db;
            option.textContent = db;
            this.elements.databaseSelect.appendChild(option);
        });

        // The list above replaced the whole selector, so the selection went
        // with it: put it back when the panel tells us which database this
        // tab was on (reconnect, or a tab that was rebuilt).
        if (currentDatabase) {
            const match = (databases || []).find(db => db.toLowerCase() === currentDatabase.toLowerCase());
            if (match) {
                this.elements.databaseSelect.value = match;
                // Dispatched so the rest of the app follows the selection
                // (objects, foreign keys, autocomplete) exactly as it does
                // when the user picks a database by hand.
                this.elements.databaseSelect.dispatchEvent(new Event('change'));
            } else {
                // The database is gone (dropped, renamed): tell the
                // extension, it must not keep querying it.
                vscode.postMessage({ command: 'setCurrentDatabase', database: '' });
            }
        }
    }

    // The extension moved this tab to another database (another saved
    // connection of the same server was opened). Same path as picking it by hand.
    selectDatabase(database) {
        const match = (appState.databases || []).find(db => db.toLowerCase() === database.toLowerCase());
        if (!match) return;
        this.elements.databaseSelect.value = match;
        this.elements.databaseSelect.dispatchEvent(new Event('change'));
    }

    // Stale responses (user switched database again before this arrived) are
    // dropped, same guard as onTableStatsLoaded.
    onForeignKeysLoaded(database, foreignKeys) {
        if (database !== appState.currentDatabase) return;
        appState.foreignKeys = foreignKeys || [];
    }

    // The answer to a request for another database than the one now selected
    // (the user switched meanwhile) is dropped. A message with no database is not judged.
    onObjectsLoaded(objects, database) {
        if (database && database !== appState.currentDatabase) return;
        appState.allObjects = objects;
        appState.filteredObjects = objects;
        // Stats for the new database arrive in a separate follow-up message
        this.tableStats = new Map();
        this.displayObjects(objects);
        this.filterManager.enableFilters();
        this.filterManager.updateObjectCount();
    }

    // Stats arrive after the list is rendered - decorate the existing items.
    // A slow stats query can outlive a database switch: drop stale responses.
    onTableStatsLoaded(database, stats) {
        if (database !== appState.currentDatabase) return;

        this.tableStats = new Map((stats || []).map(s => [s.qualified_name, s]));

        this.elements.objectList.querySelectorAll('.object-item[data-type="Table"]').forEach(item => {
            const oldBadge = item.querySelector('.object-stats');
            if (oldBadge) oldBadge.remove();

            const badge = this._buildStatsBadge(item.dataset.qualifiedName);
            if (badge) {
                // Same slot as displayObjects: right before the buttons
                const anchor = item.querySelector('.object-script-btn, .object-peek-btn');
                item.insertBefore(badge, anchor);
            }
        });
    }

    escapeHtml(text) {
        if (text === null || text === undefined) return '';
        return String(text).replace(/[&<>"']/g, ch => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
        ));
    }
}

// The class is written in three files, one per part of the Explorer: this one
// (the connection, the database, the loads), explorerObjectList.js and
// explorerDetails.js. The other two are loaded first; their methods are put on
// ExplorerManager here.
for (const Part of [ExplorerObjectListMethods, ExplorerDetailsMethods]) {
    for (const name of Object.getOwnPropertyNames(Part.prototype)) {
        if (name === 'constructor') continue;
        Object.defineProperty(ExplorerManager.prototype, name, Object.getOwnPropertyDescriptor(Part.prototype, name));
    }
}
