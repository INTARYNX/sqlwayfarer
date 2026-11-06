/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Filter and search manager
class FilterManager {
    constructor() {
        this._definitionSearchTimer = null;
        this.initEventListeners();
    }

    initEventListeners() {
        const searchInput = document.getElementById('objectSearch');
        searchInput.addEventListener('input', (e) => {
            appState.filters.search = e.target.value.toLowerCase();
            this.handleSearchInput();
        });

        document.getElementById('searchInCodeChk').addEventListener('change', (e) => {
            appState.filters.inCode = e.target.checked;
            appState.definitionMatches = null;
            this.handleSearchInput();
        });

        document.getElementById('clearSearchBtn').addEventListener('click', () => {
            searchInput.value = '';
            appState.filters.search = '';
            appState.definitionMatches = null;
            this.applyFilters();
        });

        document.getElementById('filterTable').addEventListener('change', (e) => {
            appState.filters.types.Table = e.target.checked;
            this.applyFilters();
        });

        document.getElementById('filterView').addEventListener('change', (e) => {
            appState.filters.types.View = e.target.checked;
            this.applyFilters();
        });

        document.getElementById('filterProcedure').addEventListener('change', (e) => {
            appState.filters.types.Procedure = e.target.checked;
            this.applyFilters();
        });

        document.getElementById('filterFunction').addEventListener('change', (e) => {
            appState.filters.types.Function = e.target.checked;
            this.applyFilters();
        });

        document.getElementById('selectAllTypesBtn').addEventListener('click', () => {
            this.setAllFilters(true);
        });

        document.getElementById('clearAllTypesBtn').addEventListener('click', () => {
            this.setAllFilters(false);
        });
    }

    // Name filtering is instant and local; "in code" searches are debounced
    // and delegated to the backend (sys.sql_modules full-text LIKE).
    handleSearchInput() {
        clearTimeout(this._definitionSearchTimer);

        if (appState.filters.inCode && appState.filters.search.length >= 2) {
            appState.definitionMatches = null;
            document.getElementById('objectCount').textContent = '(searching code…)';
            this._definitionSearchTimer = setTimeout(() => {
                vscode.postMessage({
                    command: 'searchDefinitions',
                    database: appState.currentDatabase,
                    searchText: document.getElementById('objectSearch').value
                });
            }, 400);
            return;
        }

        appState.definitionMatches = null;
        this.applyFilters();
    }

    onDefinitionSearchResult(message) {
        if (!appState.filters.inCode) return;
        // Ignore stale responses from a previous keystroke
        if ((message.searchText || '').toLowerCase() !== appState.filters.search) return;

        appState.definitionMatches = new Set(
            (message.objects || []).map(o => o.qualified_name.toLowerCase())
        );
        this.applyFilters();
    }

    setAllFilters(checked) {
        Object.keys(appState.filters.types).forEach(type => {
            appState.filters.types[type] = checked;
            const checkbox = document.getElementById(`filter${type}`);
            if (checkbox) {
                checkbox.checked = checked;
            }
        });
        this.applyFilters();
    }

    applyFilters() {
        const searchTerm = appState.filters.search;
        const typeFilters = appState.filters.types;

        appState.filteredObjects = appState.allObjects.filter(obj => {
            let matchesSearch;
            if (appState.filters.inCode && searchTerm.length >= 2) {
                // Code-scope search: only objects whose definition matched server-side
                matchesSearch = appState.definitionMatches
                    ? appState.definitionMatches.has((obj.qualified_name || obj.name).toLowerCase())
                    : false;
            } else if (appState.filters.inCode) {
                matchesSearch = true; // query too short for a code search
            } else {
                matchesSearch = !searchTerm || obj.name.toLowerCase().includes(searchTerm);
            }
            const matchesType = typeFilters[obj.object_type] === true;
            return matchesSearch && matchesType;
        });

        this.updateObjectDisplay();
    }

    updateObjectDisplay() {
        const objectList = document.getElementById('objectList');
        const objectItems = objectList.querySelectorAll('.object-item');

        objectItems.forEach(item => {
            item.classList.add('hidden');
        });

        const visibleBySchema = {};
        // _objectItemsByName lives on ExplorerManager (which owns the actual
        // .object-item elements via displayObjects), not on this FilterManager -
        // a plain `this._objectItemsByName` here is undefined and throws on
        // every filter change. Map lookup instead of a querySelector scan of
        // the whole list - see the field's own comment for why that mattered.
        const itemsByName = window.explorerManager._objectItemsByName;
        appState.filteredObjects.forEach(obj => {
            const item = itemsByName.get(obj.name);
            if (item) {
                item.classList.remove('hidden');
            }
            const schema = obj.schema_name || 'dbo';
            visibleBySchema[schema] = (visibleBySchema[schema] || 0) + 1;
        });

        // Schema badges reflect the filter ("3 of 15") and empty schemas disappear
        objectList.querySelectorAll('.schema-header').forEach(header => {
            const total = Number(header.dataset.total);
            const visible = visibleBySchema[header.dataset.schema] || 0;
            header.classList.toggle('hidden', visible === 0);
            header.querySelector('.schema-count').textContent =
                visible === total ? `(${total})` : `(${visible} of ${total})`;
        });

        const noMatches = document.getElementById('noMatchesMessage');
        if (noMatches) {
            noMatches.classList.toggle('hidden', appState.filteredObjects.length > 0 || appState.allObjects.length === 0);
        }

        this.updateObjectCount();
    }

    updateObjectCount() {
        const countElement = document.getElementById('objectCount');
        const filteredCount = appState.filteredObjects.length;
        const totalCount = appState.allObjects.length;

        if (filteredCount === totalCount) {
            countElement.textContent = `(${totalCount})`;
        } else {
            countElement.textContent = `(${filteredCount} of ${totalCount})`;
        }
    }

    enableFilters() {
        document.getElementById('objectSearch').disabled = false;
        document.getElementById('clearSearchBtn').disabled = false;
        document.getElementById('searchInCodeChk').disabled = false;
        document.getElementById('filterTable').disabled = false;
        document.getElementById('filterView').disabled = false;
        document.getElementById('filterProcedure').disabled = false;
        document.getElementById('filterFunction').disabled = false;
        document.getElementById('selectAllTypesBtn').disabled = false;
        document.getElementById('clearAllTypesBtn').disabled = false;
    }

    disableFilters() {
        document.getElementById('objectSearch').disabled = true;
        document.getElementById('clearSearchBtn').disabled = true;
        document.getElementById('searchInCodeChk').disabled = true;
        document.getElementById('filterTable').disabled = true;
        document.getElementById('filterView').disabled = true;
        document.getElementById('filterProcedure').disabled = true;
        document.getElementById('filterFunction').disabled = true;
        document.getElementById('selectAllTypesBtn').disabled = true;
        document.getElementById('clearAllTypesBtn').disabled = true;
    }

    resetFilters() {
        document.getElementById('objectSearch').value = '';
        appState.filters.search = '';
        document.getElementById('searchInCodeChk').checked = false;
        appState.filters.inCode = false;
        appState.definitionMatches = null;
        this.setAllFilters(true);
    }
}

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
            this.revealExternalObject(db, link.dataset.schema || 'dbo', name);
        });
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
            this.handleObjectClick(element, obj);
        }
    }

    // Jump to an object in a database other than the one currently selected
    // (e.g. a 3-part "otherDb.schema.object" reference in the query editor).
    // That database's object list was never loaded into the tree, so there's
    // no node to select/scroll to and the object's type isn't known yet -
    // ask the backend to resolve it and fetch its details in one round trip.
    revealExternalObject(database, schema, name) {
        if (window.tabManager) {
            window.tabManager.switchTab('explorer');
        }
        const prevSelected = this.elements.objectList.querySelector('.selected');
        if (prevSelected) prevSelected.classList.remove('selected');

        const qualifiedName = `${schema}.${name}`;
        this._currentDetailsDatabase = database;
        appState.selectedObject = { name: qualifiedName, qualified_name: qualifiedName, object_name: name, schema_name: schema, database };
        this.elements.detailsContent.innerHTML =
            `<p class="placeholder-text">Loading ${this.escapeHtml(database)}.${this.escapeHtml(qualifiedName)}…</p>`;

        vscode.postMessage({ command: 'getObjectDetailsAuto', database, objectName: qualifiedName });
    }

    // UTILITY METHODS FOR CONSISTENT OBJECT NAME HANDLING
    _getQualifiedName(obj) {
        return obj.qualified_name || obj.name;
    }

    _getDisplayName(obj) {
        return obj.name;
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

    handleObjectClick(element, obj) {
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

        // Update active tab content
        if (appState.activeDetailsTab === 'comments') {
            window.commentsManager.loadCommentsForObject(
                appState.currentDatabase,
                objectNameForBackend,
                obj.object_type
            );
        } else if (appState.activeDetailsTab === 'code') {
            window.codeViewManager.loadCodeForObject(
                appState.currentDatabase,
                objectNameForBackend,
                obj.object_type
            );
        } else if (appState.activeDetailsTab === 'tree') {
            vscode.postMessage({
                command: 'getDependencyTree',
                database: appState.currentDatabase,
                objectName: objectNameForBackend,
                maxDepth: 3
            });
        } else if (appState.activeDetailsTab === 'graph') {
            // NEW: Update graph when object is selected and graph tab is active
            // The graph will be updated when objectDetailsLoaded is received
        }
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

    // Jump to the Query tab and run a quick "SELECT TOP 10" on this object
    handlePeekTop10(obj) {
        const bracketed = this._getQualifiedName(obj)
            .split('.')
            // ']' must be doubled to close the bracketed identifier properly
            // ([Foo]]Bar]) - otherwise a name containing ']' breaks out of it.
            .map(part => `[${part.replace(/]/g, ']]')}]`)
            .join('.');
        const sql = `SELECT TOP 10 * FROM ${bracketed}`;

        if (window.tabManager) {
            window.tabManager.switchTab('query');
        }
        if (window.queryManager) {
            window.queryManager.runQueryText(sql);
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

    // Script types offered by the generate-script button, per object type
    _getScriptOptions(objectType) {
        switch (objectType) {
            case 'Table': return [
                { type: 'select', label: 'SELECT (all columns)' },
                { type: 'insert', label: 'INSERT template' },
                { type: 'update', label: 'UPDATE template' },
                { type: 'create', label: 'CREATE TABLE' }
            ];
            case 'View': return [
                { type: 'select', label: 'SELECT (all columns)' },
                { type: 'create', label: 'CREATE (definition)' }
            ];
            case 'Procedure': return [
                { type: 'exec', label: 'EXEC template' },
                { type: 'create', label: 'CREATE (definition)' }
            ];
            case 'Function': return [
                { type: 'select', label: 'SELECT (call)' },
                { type: 'create', label: 'CREATE (definition)' }
            ];
            default: return [];
        }
    }

    openScriptMenu(anchorBtn, obj) {
        const items = this._getScriptOptions(obj.object_type).map(opt => ({
            label: opt.label,
            onClick: () => vscode.postMessage({
                command: 'generateScript',
                database: appState.currentDatabase,
                objectName: obj.qualified_name || obj.name,
                objectType: obj.object_type,
                scriptType: opt.type
            })
        }));
        this._openPopupMenu(anchorBtn, items, { alignRight: true });
    }

    // Popup mechanics for the script menu and the context menu: one menu open
    // at a time, closed by any outside click or Escape, usable with the
    // keyboard (arrows, Home/End, Enter) - the focus goes back to where it was.
    // `at` ({ x, y }) opens it at a point (right click) instead of under an anchor.
    _openPopupMenu(anchorBtn, items, { alignRight = false, at = null } = {}) {
        this.closePopupMenu();
        if (items.length === 0) return;
        const returnFocus = document.activeElement;

        const menu = document.createElement('div');
        menu.className = 'script-menu';
        menu.setAttribute('role', 'menu');
        items.forEach(({ label, title, onClick, separatorBefore }) => {
            if (separatorBefore) {
                const separator = document.createElement('div');
                separator.className = 'script-menu-separator';
                separator.setAttribute('role', 'separator');
                menu.appendChild(separator);
            }
            const item = document.createElement('button');
            item.className = 'script-menu-item';
            item.setAttribute('role', 'menuitem');
            item.textContent = label;
            if (title) item.title = title;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closePopupMenu();
                onClick();
            });
            menu.appendChild(item);
        });
        menu.addEventListener('keydown', (e) => this._onPopupMenuKey(e, menu, returnFocus));

        document.body.appendChild(menu);
        if (at) {
            menu.style.top = `${Math.max(8, Math.min(at.y, window.innerHeight - menu.offsetHeight - 8))}px`;
            menu.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - menu.offsetWidth - 8))}px`;
        } else {
            const rect = anchorBtn.getBoundingClientRect();
            menu.style.top = `${Math.min(rect.bottom + 2, window.innerHeight - menu.offsetHeight - 8)}px`;
            const left = alignRight ? rect.right - menu.offsetWidth : rect.left;
            menu.style.left = `${Math.min(Math.max(8, left), window.innerWidth - menu.offsetWidth - 8)}px`;
        }

        this._popupMenu = menu;
        this._popupMenuCloser = (e) => {
            if (!menu.contains(e.target)) this.closePopupMenu();
        };
        // Deferred so the opening click does not immediately close the menu
        setTimeout(() => document.addEventListener('click', this._popupMenuCloser), 0);
        const first = menu.querySelector('.script-menu-item');
        if (first) first.focus();
    }

    _onPopupMenuKey(event, menu, returnFocus) {
        const entries = [...menu.querySelectorAll('.script-menu-item')];
        const index = entries.indexOf(document.activeElement);
        let next = null;
        switch (event.key) {
            case 'ArrowDown': next = entries[(index + 1) % entries.length]; break;
            case 'ArrowUp': next = entries[(index - 1 + entries.length) % entries.length]; break;
            case 'Home': next = entries[0]; break;
            case 'End': next = entries[entries.length - 1]; break;
            case 'Escape':
            case 'Tab':
                event.preventDefault();
                this.closePopupMenu();
                if (returnFocus && returnFocus.focus) returnFocus.focus();
                return;
            default: return;
        }
        event.preventDefault();
        if (next) next.focus();
    }

    closePopupMenu() {
        if (this._popupMenu) {
            this._popupMenu.remove();
            document.removeEventListener('click', this._popupMenuCloser);
            this._popupMenu = null;
            this._popupMenuCloser = null;
        }
    }

    // ---- Keyboard and context menu of the object list ------------------------

    // The rows that can be reached now: the schema headers, and the objects
    // that are neither filtered out nor in a collapsed schema.
    _visibleObjectRows() {
        return [...this.elements.objectList.querySelectorAll('.schema-header:not(.hidden), .object-item:not(.hidden):not(.schema-collapsed)')];
    }

    initObjectListKeyboard() {
        const list = this.elements.objectList;
        // One tab stop for the whole list; the rows are moved between with the
        // arrow keys (their own tabindex is -1).
        list.tabIndex = 0;
        list.setAttribute('role', 'tree');
        list.setAttribute('aria-label', 'Database objects');
        list.addEventListener('focus', (e) => {
            // Coming from outside: go to the selected object, or the first row.
            if (e.target !== list || list.contains(e.relatedTarget)) return;
            const rows = this._visibleObjectRows();
            const target = rows.find(r => r.classList.contains('selected')) || rows[0];
            if (target) target.focus();
        });
        list.addEventListener('keydown', (e) => this._onObjectListKey(e));
        list.addEventListener('contextmenu', (e) => {
            const row = e.target.closest('.object-item');
            if (!row) return;
            e.preventDefault();
            this.openObjectContextMenu(row, { x: e.clientX, y: e.clientY });
        });
    }

    _onObjectListKey(event) {
        const row = event.target.closest('.schema-header, .object-item');
        if (!row || event.altKey || event.ctrlKey || event.metaKey) return;
        const rows = this._visibleObjectRows();
        const index = rows.indexOf(row);
        const isHeader = row.classList.contains('schema-header');
        let target = null;

        switch (event.key) {
            case 'ArrowDown': target = rows[index + 1]; break;
            case 'ArrowUp': target = rows[index - 1]; break;
            case 'PageDown': target = rows[Math.min(index + 10, rows.length - 1)]; break;
            case 'PageUp': target = rows[Math.max(index - 10, 0)]; break;
            case 'Home': target = rows[0]; break;
            case 'End': target = rows[rows.length - 1]; break;
            case 'ArrowRight':
                if (isHeader) {
                    if (row.classList.contains('collapsed')) this._toggleSchemaCollapse(row.dataset.schema);
                    else target = rows[index + 1] && !rows[index + 1].classList.contains('schema-header') ? rows[index + 1] : null;
                }
                break;
            case 'ArrowLeft':
                if (isHeader) {
                    if (!row.classList.contains('collapsed')) this._toggleSchemaCollapse(row.dataset.schema);
                } else {
                    target = this.elements.objectList.querySelector(`.schema-header[data-schema="${CSS.escape(row.dataset.schema)}"]`);
                }
                break;
            case 'Enter':
            case ' ':
                if (isHeader) this._toggleSchemaCollapse(row.dataset.schema);
                else row.click();
                break;
            case 'ContextMenu':
                if (!isHeader) {
                    const box = row.getBoundingClientRect();
                    this.openObjectContextMenu(row, { x: box.left + 24, y: box.bottom });
                }
                break;
            case 'F10':
                if (event.shiftKey && !isHeader) {
                    const box = row.getBoundingClientRect();
                    this.openObjectContextMenu(row, { x: box.left + 24, y: box.bottom });
                    break;
                }
                return;
            default:
                // Typing the start of a name jumps to the next object that begins with it.
                if (event.key.length === 1 && /\S/.test(event.key)) {
                    this._objectTypeahead = (this._objectTypeahead || '') + event.key.toLowerCase();
                    clearTimeout(this._objectTypeaheadTimer);
                    this._objectTypeaheadTimer = setTimeout(() => { this._objectTypeahead = ''; }, 600);
                    const needle = this._objectTypeahead;
                    const ordered = rows.slice(index + 1).concat(rows.slice(0, index + 1));
                    target = ordered.find(r => (r.querySelector('.object-name-with-icon, .schema-name')?.textContent || '').trim().toLowerCase().startsWith(needle));
                    break;
                }
                return;
        }
        event.preventDefault();
        if (target) {
            target.focus();
            target.scrollIntoView({ block: 'nearest' });
        }
    }

    // Right click (or the menu key) on an object: what the row's own buttons
    // offer, plus opening its details and copying its name.
    openObjectContextMenu(row, at) {
        const obj = (appState.allObjects || []).find(o => o.name === row.dataset.name);
        if (!obj) return;
        const database = appState.currentDatabase;
        const qualified = this._getQualifiedName(obj);
        const items = [{ label: 'Show details', onClick: () => this.handleObjectClick(row, obj) }];
        if (obj.object_type === 'Table' || obj.object_type === 'View') {
            items.push({ label: 'Select top 10 rows', onClick: () => this.handlePeekTop10(obj) });
        }
        this._getScriptOptions(obj.object_type).forEach((opt, i) => items.push({
            label: `Script: ${opt.label}`,
            separatorBefore: i === 0,
            onClick: () => vscode.postMessage({
                command: 'generateScript', database, objectName: qualified, objectType: obj.object_type, scriptType: opt.type
            })
        }));
        items.push({
            label: 'Copy name',
            separatorBefore: true,
            onClick: () => navigator.clipboard.writeText(qualified).catch(() => {})
        });
        this._openPopupMenu(row, items, { at });
    }

    _buildStatsBadge(qualifiedName) {
        const stats = this.tableStats.get(qualifiedName);
        if (!stats) return null;

        const badge = document.createElement('span');
        badge.className = 'object-stats';
        badge.textContent = `${this._formatCompactCount(stats.row_count)} · ${this._formatKb(stats.reserved_kb)}`;
        badge.title = `${Number(stats.row_count).toLocaleString('en-US')} rows · ${this._formatKb(stats.reserved_kb)} reserved`;
        return badge;
    }

    _formatCompactCount(n) {
        n = Number(n) || 0;
        if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
        return String(n);
    }

    _formatKb(kb) {
        kb = Number(kb) || 0;
        if (kb >= 1024 * 1024) return (kb / (1024 * 1024)).toFixed(1) + ' GB';
        if (kb >= 1024) return (kb / 1024).toFixed(1) + ' MB';
        return `${kb} KB`;
    }

    displayObjects(objects) {
        this.elements.objectList.innerHTML = '';
        this._objectItemsByName.clear();

        if (objects.length === 0) {
            this.elements.objectList.innerHTML = '<p class="placeholder-text">No objects found in this database.</p>';
            return;
        }

        const objectsBySchema = this._groupObjectsBySchema(objects);

        Object.keys(objectsBySchema).sort().forEach(schema => {
            if (schema !== 'dbo' || Object.keys(objectsBySchema).length > 1) {
                const schemaHeader = document.createElement('div');
                schemaHeader.className = 'schema-header';
                // dataset lets the filter update the badge and hide empty schemas
                schemaHeader.dataset.schema = schema;
                schemaHeader.dataset.total = objectsBySchema[schema].length;
                schemaHeader.innerHTML = `
                <span class="schema-name"><i class="codicon codicon-chevron-down schema-chevron"></i><i class="codicon codicon-folder"></i> ${this.escapeHtml(schema)}</span>
                <span class="schema-count">(${objectsBySchema[schema].length})</span>
            `;
                schemaHeader.tabIndex = -1;
                schemaHeader.setAttribute('role', 'treeitem');
                schemaHeader.setAttribute('aria-expanded', String(!this._collapsedSchemas.has(schema)));
                schemaHeader.addEventListener('click', () => this._toggleSchemaCollapse(schema));
                this.elements.objectList.appendChild(schemaHeader);
            }

            objectsBySchema[schema].forEach(obj => {
                const div = document.createElement('div');
                div.className = 'object-item';
                div.tabIndex = -1;
                div.setAttribute('role', 'treeitem');

                const objectDisplayName = obj.object_name || obj.name.split('.').pop();

                // Get icon based on object type
                const icon = this._getObjectTypeIcon(obj.object_type);

                const nameSpan = document.createElement('span');
                nameSpan.className = 'object-name-with-icon';
                nameSpan.innerHTML = `${icon} ${this.escapeHtml(objectDisplayName)}`;

                div.appendChild(nameSpan);
                div.dataset.name = obj.name;
                div.dataset.qualifiedName = obj.qualified_name || obj.name;
                div.dataset.type = obj.object_type;
                div.dataset.schema = obj.schema_name || 'dbo';
                this._objectItemsByName.set(obj.name, div);

                if (obj.object_type === 'Table') {
                    const badge = this._buildStatsBadge(div.dataset.qualifiedName);
                    if (badge) div.appendChild(badge);
                }

                if (this._getScriptOptions(obj.object_type).length > 0) {
                    const scriptBtn = document.createElement('button');
                    scriptBtn.className = 'object-script-btn';
                    // Reached from the keyboard through the context menu.
                    scriptBtn.tabIndex = -1;
                    scriptBtn.title = 'Generate a SQL script for this object';
                    scriptBtn.innerHTML = '<i class="codicon codicon-file-code"></i>';
                    scriptBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.openScriptMenu(scriptBtn, obj);
                    });
                    div.appendChild(scriptBtn);
                }

                if (obj.object_type === 'Table' || obj.object_type === 'View') {
                    const peekBtn = document.createElement('button');
                    peekBtn.className = 'object-peek-btn';
                    peekBtn.tabIndex = -1;
                    peekBtn.title = 'Run SELECT TOP 10 * FROM this object';
                    peekBtn.innerHTML = `${swIcon('run')} Top 10`;
                    peekBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.handlePeekTop10(obj);
                    });
                    div.appendChild(peekBtn);
                }

                div.addEventListener('click', () => this.handleObjectClick(div, obj));

                this.elements.objectList.appendChild(div);
            });
        });

        // Shown by the filter when a search matches nothing
        const noMatches = document.createElement('p');
        noMatches.id = 'noMatchesMessage';
        noMatches.className = 'placeholder-text hidden';
        noMatches.textContent = 'No objects match the current search.';
        this.elements.objectList.appendChild(noMatches);

        // Re-apply whichever schemas were already collapsed - displayObjects
        // rebuilds the whole list (new DOM nodes) on every call, so the
        // collapsed/expanded state itself lives in _collapsedSchemas, not the DOM.
        this._applySchemaCollapseState();
    }

    _toggleSchemaCollapse(schema) {
        if (this._collapsedSchemas.has(schema)) {
            this._collapsedSchemas.delete(schema);
        } else {
            this._collapsedSchemas.add(schema);
        }
        this._applySchemaCollapseState();
    }

    _applySchemaCollapseState() {
        this.elements.objectList.querySelectorAll('.schema-header').forEach(header => {
            header.classList.toggle('collapsed', this._collapsedSchemas.has(header.dataset.schema));
            header.setAttribute('aria-expanded', String(!this._collapsedSchemas.has(header.dataset.schema)));
        });
        // A separate class from .hidden (used by the search/type filter) so the
        // two stay independent - an item is visible only when neither hides it.
        this.elements.objectList.querySelectorAll('.object-item').forEach(item => {
            item.classList.toggle('schema-collapsed', this._collapsedSchemas.has(item.dataset.schema));
        });
    }

    _getObjectTypeIcon(objectType) {
        return swObjectIcon(objectType, null);
    }
    _groupObjectsBySchema(objects) {
        const grouped = {};

        objects.forEach(obj => {
            const schema = obj.schema_name || 'dbo';
            if (!grouped[schema]) {
                grouped[schema] = [];
            }
            grouped[schema].push(obj);
        });

        Object.keys(grouped).forEach(schema => {
            grouped[schema].sort((a, b) => {
                const typeA = a.object_type || '';
                const typeB = b.object_type || '';
                if (typeA !== typeB) return typeA.localeCompare(typeB);
                return (a.name || '').localeCompare(b.name || '');
            });
        });

        return grouped;
    }

    // Whether the details that arrive are the ones the panel waits for: the
    // object selected, in its database - or an object whose dependencies were
    // asked for to be drawn. The user may have clicked another object since.
    _isAwaitedDetails(database, name) {
        if (database && database !== (this._currentDetailsDatabase || appState.currentDatabase)) return false;
        if (appState.pendingVisualization) return true;
        const selected = appState.selectedObject;
        return !selected || !name || name === this._getQualifiedName(selected);
    }

    onTableDetailsLoaded(tableName, columns, indexes, foreignKeys, dependencies, stats, database) {
        if (!this._isAwaitedDetails(database, tableName)) return;
        appState.currentDependencies = dependencies;
        this._currentDetailsTable = tableName;

        // Column lineage comes from the in-memory index - fetched separately
        // so the details view never waits on it. Uses the database these
        // details were actually fetched from, not necessarily the one
        // currently selected (e.g. a cross-database reference).
        vscode.postMessage({
            command: 'getColumnUsage',
            database: this._currentDetailsDatabase || appState.currentDatabase,
            table: tableName
        });

        const html = [
            `<div class="section-header">Table: ${this.escapeHtml(tableName)}</div>`,
            this.buildStatsSection(stats),
            this.buildColumnsTable(columns),
            this.buildIndexesTable(indexes),
            this.buildForeignKeysTable(foreignKeys),
            this.buildDependenciesSection(dependencies)
        ].join('');

        this.elements.detailsContent.innerHTML = html;

        // Update graph tab if it's active
        if (appState.activeDetailsTab === 'graph') {
            this.displayDependencyGraph(tableName, dependencies);
        }

        this.checkPendingVisualization(tableName, dependencies);
    }

    onObjectDetailsLoaded(objectName, objectType, dependencies, definition, database) {
        if (!this._isAwaitedDetails(database, objectName)) return;
        appState.currentDependencies = dependencies;

        if (appState.selectedObject) {
            appState.selectedObject.definition = definition;
        }

        // Update structure tab
        let html = `<div class="section-header">${objectType}: ${this.escapeHtml(objectName)}</div>`;
        // Write footprint applies to programmable objects (they read/write tables).
        const ftType = appState.selectedObject && appState.selectedObject.object_type;
        const canFootprint = ['Procedure', 'Function', 'View'].includes(ftType);
        if (canFootprint) {
            html += `<div class="details-actions">
                <button id="writeFootprintBtn" class="viz-btn" title="Graph the tables this object reads and writes, including tables reached through trigger cascades">
                    <i class="codicon codicon-type-hierarchy"></i> Table footprint
                </button>
            </div>`;
        }
        // Procedures/functions get an auto-generated call snippet (EXEC/SELECT
        // template) so you don't have to dig into the object list's script menu.
        const canCallSnippet = ['Procedure', 'Function'].includes(ftType);
        if (canCallSnippet) {
            html += `<div class="call-snippet-section" id="callSnippetSection">
                <div class="section-header">Call snippet</div>
                <p class="placeholder-text">Generating…</p>
            </div>`;
        }
        html += this.buildDependenciesSection(dependencies);
        this.elements.detailsContent.innerHTML = html;

        if (canFootprint) {
            const btn = document.getElementById('writeFootprintBtn');
            if (btn) btn.addEventListener('click', () => {
                if (window.footprintManager) window.footprintManager.open(objectName);
            });
        }

        if (canCallSnippet) {
            this._pendingCallSnippetFor = objectName;
            vscode.postMessage({
                command: 'generateScript',
                database: this._currentDetailsDatabase || appState.currentDatabase,
                objectName,
                objectType: ftType,
                scriptType: ftType === 'Function' ? 'select' : 'exec',
                preview: true
            });
        }

        // Update graph tab if it's active
        if (appState.activeDetailsTab === 'graph') {
            this.displayDependencyGraph(objectName, dependencies);
        }

        // Handle code tab
        if (appState.activeDetailsTab === 'code' && window.codeViewManager) {
            window.codeViewManager.onDefinitionReceived(objectName, definition);
        }

        this.checkPendingVisualization(objectName, dependencies);
    }

    // Renders the auto-generated call snippet (EXEC/SELECT template) requested
    // from onObjectDetailsLoaded. Guards against a stale response landing after
    // the user has since selected a different object.
    onScriptGenerated(objectName, script) {
        if (objectName !== this._pendingCallSnippetFor) return;
        const section = document.getElementById('callSnippetSection');
        if (!section) return;

        section.innerHTML = `
            <div class="section-header">Call snippet</div>
            <div class="call-snippet-actions">
                <button type="button" id="copyCallSnippetBtn" title="Copy to clipboard"><i class="codicon codicon-copy"></i> Copy</button>
                <button type="button" id="insertCallSnippetBtn" title="Insert into the query editor"><i class="codicon codicon-insert"></i> Insert in editor</button>
            </div>
            <pre class="call-snippet-code">${this.escapeHtml(script)}</pre>
        `;

        document.getElementById('copyCallSnippetBtn').addEventListener('click', (e) => {
            navigator.clipboard.writeText(script).then(() => {
                const btn = e.currentTarget;
                const original = btn.innerHTML;
                btn.innerHTML = '<i class="codicon codicon-check"></i> Copied';
                setTimeout(() => { btn.innerHTML = original; }, 1500);
            });
        });
        document.getElementById('insertCallSnippetBtn').addEventListener('click', () => {
            if (window.tabManager) window.tabManager.switchTab('query');
            if (window.queryManager) window.queryManager.setQueryText(script);
        });
    }

    // NEW METHOD: Display dependency graph in the graph tab
    displayDependencyGraph(objectName, dependencies) {
        const container = document.getElementById('graphContainer');
        if (!container) return;

        if (!dependencies || (!dependencies.dependsOn?.length && !dependencies.referencedBy?.length)) {
            container.innerHTML = `
                <div class="graph-placeholder">
                    <h3><i class="codicon codicon-graph"></i> Dependency Graph</h3>
                    <p class="placeholder-text">No dependencies found for ${this.escapeHtml(objectName)}</p>
                    ${this.indexMissingHtml()}
                </div>
            `;
            return;
        }

        // Create a new visualization container for the graph tab
        container.innerHTML = `
            <div class="graph-viz-container">
                <div class="graph-header">
                    <h3><i class="codicon codicon-graph"></i> Dependency Graph: ${this.escapeHtml(objectName)}</h3>
                    <div class="viz-controls">
                        <button id="showDependenciesBtn" class="viz-btn">Dependencies</button>
                        <button id="showReferencesBtn" class="viz-btn">References</button>
                        <button id="showBothBtn" class="viz-btn active">Both</button>
                    </div>
                </div>
                <div id="dependencyGraph" class="dependency-graph"></div>
            </div>
        `;

        // Show the dependency visualization in the graph container
        setTimeout(() => {
            this.dependencyVisualizer.currentMode = 'both';
            this.dependencyVisualizer.currentObjectName = objectName;
            this.dependencyVisualizer.dependencies = dependencies;
            this.dependencyVisualizer.generateGraph(objectName, dependencies);

            // Re-attach event listeners for the controls
            document.getElementById('showDependenciesBtn').addEventListener('click', () => {
                this.dependencyVisualizer.setMode('dependencies');
            });
            document.getElementById('showReferencesBtn').addEventListener('click', () => {
                this.dependencyVisualizer.setMode('references');
            });
            document.getElementById('showBothBtn').addEventListener('click', () => {
                this.dependencyVisualizer.setMode('both');
            });
        }, 100);
    }

    checkPendingVisualization(objectName, dependencies) {
        if (appState.pendingVisualization === objectName) {
            appState.pendingVisualization = null;
            setTimeout(() => {
                this.dependencyVisualizer.showDependencyVisualization(objectName, dependencies);
            }, 100);
        }
    }

    // Shown in place of a result that needs the dependency index while it is
    // not built: an empty result would read as "no dependencies".
    indexMissingHtml() {
        if (appState.indexState !== 'none') return '';
        return `<p class="placeholder-text index-missing">The dependency index of this database is not built, so dependencies cannot be shown. <button class="link-btn" data-index-action="build">Build index</button></p>`;
    }

    displayDependencyTree(treeData) {
        const container = document.getElementById('treeContainer');
        if (!container) return;

        if (!treeData) {
            container.innerHTML = `<p class="placeholder-text">No dependency data</p>${this.indexMissingHtml()}`;
            return;
        }

        // A node living in another database is a link, like in the
        // Dependencies table.
        const renderName = (node) => {
            if (node.external && node.external.database) {
                const ext = node.external;
                const schema = ext.schema || 'dbo';
                const label = `${ext.database}.${schema}.${ext.object}`;
                return `<button class="dep-link" data-db="${this.escapeHtml(ext.database)}" data-schema="${this.escapeHtml(schema)}" data-name="${this.escapeHtml(ext.object)}" title="Open ${this.escapeHtml(label)} in ${this.escapeHtml(ext.database)}">${this.escapeHtml(node.name)}</button>`;
            }
            return this.escapeHtml(node.name);
        };

        // Simple recursive text tree
        function buildTree(node, prefix = '') {
            let result = renderName(node) + '\n';

            if (node.dependencies && node.dependencies.length > 0) {
                node.dependencies.forEach((child, index) => {
                    const isLast = index === node.dependencies.length - 1;
                    const connector = isLast ? '└── ' : '├── ';
                    const nextPrefix = prefix + (isLast ? '    ' : '│   ');

                    result += prefix + connector + buildTree(child, nextPrefix);
                });
            }

            return result;
        }

        // The names are escaped by renderName, the rest is the branches of the drawing.
        container.innerHTML = `<pre>${buildTree(treeData)}</pre>`;
    }

    // Row count and disk usage summary line shown under the table header.
    // stats is null when the backend could not read allocation metadata.
    buildStatsSection(stats) {
        if (!stats) return '';

        const parts = [
            `Rows: <strong>${Number(stats.rowCount).toLocaleString('en-US')}</strong>`,
            `Data: <strong>${this._formatKb(stats.dataKb)}</strong>`,
            `Indexes: <strong>${this._formatKb(stats.indexKb)}</strong>`,
            `Reserved: <strong>${this._formatKb(stats.reservedKb)}</strong>`
        ];
        return `<div class="table-stats">${parts.join('<span class="stat-separator">·</span>')}</div>`;
    }

    buildColumnsTable(columns) {
        if (!columns || columns.length === 0) {
            return `<h3>${swIcon('table')} Columns</h3><p>No columns found.</p>`;
        }

        let html = `<h3>${swIcon('table')} Columns</h3>`;
        html += `<table>
           <tr>
               <th>Name</th>
               <th>Type</th>
               <th>Nullable</th>
               <th>Default</th>
               <th>Length</th>
               <th>Extra</th>
               <th>Used by</th>
           </tr>`;

        columns.forEach(col => {
            const extraInfo = [];
            if (col.IS_IDENTITY) extraInfo.push('IDENTITY');
            if (col.IS_COMPUTED) extraInfo.push('COMPUTED');

            let typeDisplay = col.DATA_TYPE;
            if (col.CHARACTER_MAXIMUM_LENGTH) {
                typeDisplay += `(${col.CHARACTER_MAXIMUM_LENGTH})`;
            } else if (col.NUMERIC_PRECISION && col.NUMERIC_SCALE !== undefined) {
                typeDisplay += `(${col.NUMERIC_PRECISION},${col.NUMERIC_SCALE})`;
            }

            html += `<tr>
               <td><strong>${this.escapeHtml(col.COLUMN_NAME)}</strong></td>
               <td><code>${this.escapeHtml(typeDisplay)}</code></td>
               <td>${col.IS_NULLABLE}</td>
               <td>${this.escapeHtml(col.COLUMN_DEFAULT || '')}</td>
               <td>${col.CHARACTER_MAXIMUM_LENGTH || ''}</td>
               <td>${extraInfo.join(', ')}</td>
               <td class="col-usage" data-column="${this.escapeHtml(col.COLUMN_NAME.toLowerCase()).replace(/"/g, '&quot;')}" data-column-label="${this.escapeHtml(col.COLUMN_NAME).replace(/"/g, '&quot;')}">…</td>
           </tr>`;
        });

        html += '</table>';
        return html;
    }

    // Fill the "Used by" cells once the index-based column lineage arrives.
    // usage: { columnNameLower: [{ object, type, write, confident }] }
    onColumnUsageResult(tableName, usage) {
        if (tableName !== this._currentDetailsTable) return;

        this.elements.detailsContent.querySelectorAll('.col-usage').forEach(cell => {
            // usage === null: lookup failed (index unreadable) - unlike an
            // empty object, this is not a confident "no references"
            if (!usage) {
                cell.textContent = '';
                cell.title = 'Column usage unavailable (index could not be read)';
                return;
            }
            const refs = usage[cell.dataset.column] || [];
            if (refs.length === 0) {
                cell.textContent = '—';
                cell.title = 'No indexed object references this column';
                return;
            }

            const writes = refs.filter(r => r.write).length;
            const uncertain = refs.filter(r => !r.confident).length;
            const label = `${refs.length} object${refs.length > 1 ? 's' : ''}` +
                (writes ? ` · ${writes} <i class="codicon codicon-edit"></i>` : '') + (uncertain ? ' · ~' : '');

            cell.innerHTML = '';
            const btn = document.createElement('button');
            btn.className = 'col-usage-btn';
            btn.innerHTML = label;
            btn.title = 'Objects referencing this column (pencil = writes, ~ = uncertain matches). Click for the list.';
            const columnLabel = cell.dataset.columnLabel || cell.dataset.column;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.openColumnUsageModal(columnLabel, refs);
            });
            cell.appendChild(btn);
        });
    }

    // List of referencing objects; click reveals the object in the Explorer.
    // A real modal, not a dropdown: the list can hold 150+ objects and a menu
    // pinned to the viewport can neither scroll nor show them all.
    openColumnUsageModal(columnLabel, refs) {
        if (!this._usageModal) {
            this._usageModal = {
                overlay: document.getElementById('columnUsageModalOverlay'),
                title: document.getElementById('columnUsageModalTitle'),
                filter: document.getElementById('columnUsageFilter'),
                list: document.getElementById('columnUsageList')
            };
            const m = this._usageModal;
            document.getElementById('columnUsageModalCloseBtn').addEventListener('click', () => this.closeColumnUsageModal());
            m.overlay.addEventListener('click', (e) => {
                if (e.target === m.overlay) this.closeColumnUsageModal();
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && m.overlay.classList.contains('visible')) {
                    this.closeColumnUsageModal();
                }
            });
            m.filter.addEventListener('input', () => this._renderColumnUsageList());
            m.copyBtn = document.getElementById('columnUsageCopyBtn');
            m.copyBtn.addEventListener('click', () => this._copyColumnUsageList());
        }

        const m = this._usageModal;
        this._usageRefs = refs;
        m.title.textContent = `Objects using ${columnLabel} (${refs.length})`;
        m.filter.value = '';
        // A filter box on a three-line list is clutter
        m.filter.style.display = refs.length > 8 ? '' : 'none';
        this._renderColumnUsageList();
        m.overlay.classList.add('visible');
        if (refs.length > 8) m.filter.focus();
    }

    _renderColumnUsageList() {
        const m = this._usageModal;
        const needle = m.filter.value.trim().toLowerCase();
        const matching = this._usageRefs.filter(ref => !needle || ref.object.toLowerCase().includes(needle));
        // Kept for the Copy button: it copies what the user sees (filter applied)
        this._usageVisibleRefs = matching;

        m.list.innerHTML = '';
        if (matching.length === 0) {
            m.list.innerHTML = '<p class="placeholder-text">No matching object.</p>';
            return;
        }
        matching.forEach(ref => {
            const item = document.createElement('button');
            item.className = 'column-usage-item';
            item.append(ref.object);
            if (ref.write) {
                const pencil = document.createElement('i');
                pencil.className = 'codicon codicon-edit';
                item.append(' ', pencil);
            }
            if (!ref.confident) item.append(' (?)');
            item.title = `${ref.write ? 'Writes to' : 'Reads'} this column${ref.confident ? '' : ' (ambiguous, unqualified reference)'}. Click to reveal in Explorer.`;
            item.addEventListener('click', () => {
                const obj = (appState.allObjects || []).find(o =>
                    (o.qualified_name || '').toLowerCase() === ref.object.toLowerCase());
                this.closeColumnUsageModal();
                if (obj) this.revealObject(obj);
            });
            m.list.appendChild(item);
        });
    }

    _copyColumnUsageList() {
        const m = this._usageModal;
        const refs = this._usageVisibleRefs || [];
        if (refs.length === 0) return;

        const text = refs.map(ref => ref.object).join('\n');
        const resetLabel = '<i class="codicon codicon-copy"></i> Copy';
        navigator.clipboard.writeText(text).then(
            () => {
                m.copyBtn.innerHTML = `<i class="codicon codicon-check"></i> ${refs.length} copied`;
                setTimeout(() => { m.copyBtn.innerHTML = resetLabel; }, 1500);
            },
            () => {
                m.copyBtn.innerHTML = '<i class="codicon codicon-close"></i> Copy failed';
                setTimeout(() => { m.copyBtn.innerHTML = resetLabel; }, 1500);
            }
        );
    }

    closeColumnUsageModal() {
        if (this._usageModal) this._usageModal.overlay.classList.remove('visible');
    }

    buildIndexesTable(indexes) {
        let html = `<h3>${swIcon('index')} Indexes</h3>`;

        if (indexes && indexes.length > 0) {
            html += '<table><tr><th>Name</th><th>Type & Properties</th><th>Columns</th><th>Details</th></tr>';

            indexes.forEach(idx => {
                let badges = '';

                if (idx.is_primary_key === true || idx.is_primary_key === 1) {
                    badges += `<span class="index-badge index-primary">${swIcon('key')} Primary Key</span>`;
                }

                if (idx.is_unique === true || idx.is_unique === 1) {
                    badges += '<span class="index-badge index-unique">Unique</span>';
                }

                if (idx.is_unique_constraint === true || idx.is_unique_constraint === 1) {
                    badges += '<span class="index-badge index-unique">Unique Constraint</span>';
                }

                if (idx.type_desc) {
                    const typeDesc = idx.type_desc.toLowerCase();
                    if (typeDesc.includes('clustered') && !typeDesc.includes('nonclustered')) {
                        badges += '<span class="index-badge index-clustered">Clustered</span>';
                    } else if (typeDesc.includes('nonclustered')) {
                        badges += '<span class="index-badge index-normal">NonClustered</span>';
                    }
                }

                if (!badges) {
                    badges = '<span class="index-badge index-normal">Index</span>';
                }

                const details = [];
                if (idx.fill_factor && idx.fill_factor !== 0) {
                    details.push(`Fill Factor: ${idx.fill_factor}%`);
                }
                if (idx.has_filter) {
                    details.push(`Filtered: ${this.escapeHtml(idx.filter_definition || 'Yes')}`);
                }

                html += `<tr>
                  <td><strong>${this.escapeHtml(idx.index_name)}</strong></td>
                  <td>${badges}</td>
                  <td><code style="background: var(--vscode-textCodeBlock-background); padding: 2px 4px; border-radius: 2px;">${this.escapeHtml(idx.columns)}</code></td>
                  <td><small>${details.join('<br>')}</small></td>
              </tr>`;
            });

            html += '</table>';
        } else {
            html += '<p>No indexes found.</p>';
        }

        return html;
    }

    buildForeignKeysTable(foreignKeys) {
        let html = `<h3>${swIcon('fk')} Foreign Keys</h3>`;

        if (foreignKeys && foreignKeys.length > 0) {
            html += '<table><tr><th>Name</th><th>Column</th><th>Referenced Table</th><th>Referenced Column</th><th>Actions</th></tr>';

            foreignKeys.forEach(fk => {
                const actions = [];
                if (fk.delete_referential_action_desc && fk.delete_referential_action_desc !== 'NO_ACTION') {
                    actions.push(`ON DELETE ${fk.delete_referential_action_desc}`);
                }
                if (fk.update_referential_action_desc && fk.update_referential_action_desc !== 'NO_ACTION') {
                    actions.push(`ON UPDATE ${fk.update_referential_action_desc}`);
                }

                html += `<tr>
                  <td>${this.escapeHtml(fk.fk_name)}</td>
                  <td><strong>${this.escapeHtml(fk.column_name)}</strong></td>
                  <td>${this.escapeHtml(fk.referenced_table)}</td>
                  <td><strong>${this.escapeHtml(fk.referenced_column)}</strong></td>
                  <td><small>${actions.join('<br>')}</small></td>
              </tr>`;
            });

            html += '</table>';
        } else {
            html += '<p>No foreign keys found.</p>';
        }

        return html;
    }

    buildDependenciesSection(dependencies) {
        if (!dependencies) {
            return '<h3><i class="codicon codicon-type-hierarchy"></i> Dependencies</h3><p>No dependency information available.</p>';
        }

        let html = '<h3><i class="codicon codicon-type-hierarchy"></i> Dependencies</h3>';

        html += '<h4>Dependencies (objects this depends on):</h4>';
        if (dependencies.dependsOn && dependencies.dependsOn.length > 0) {
            html += '<table><tr><th>Object Name</th><th>Type</th><th>Operations</th></tr>';
            dependencies.dependsOn.forEach(dep => {
                const operations = dep.operations ? dep.operations.join(', ') : (dep.dependency_type || 'Unknown');
                html += `<tr>
              <td>${this.renderDependencyName(dep)}</td>
              <td>${this.escapeHtml(dep.referenced_object_type)}</td>
              <td><small>${this.escapeHtml(operations)}</small></td>
          </tr>`;
            });
            html += '</table>';
        } else {
            html += `<p>No dependencies found.</p>${this.indexMissingHtml()}`;
        }

        html += '<h4>Referenced by (objects that depend on this):</h4>';
        if (dependencies.referencedBy && dependencies.referencedBy.length > 0) {
            html += '<table><tr><th>Object Name</th><th>Type</th><th>Operations</th></tr>';
            dependencies.referencedBy.forEach(ref => {
                const operations = ref.operations ? ref.operations.join(', ') : (ref.dependency_type || 'Unknown');
                html += `<tr>
              <td>${this.escapeHtml(ref.referencing_object)}</td>
              <td>${this.escapeHtml(ref.referencing_object_type)}</td>
              <td><small>${this.escapeHtml(operations)}</small></td>
          </tr>`;
            });
            html += '</table>';
        } else {
            html += '<p>No objects reference this object.</p>';
        }

        return html;
    }

    // A dependency living in another database is a link: clicking it opens
    // that database in the Explorer and selects the object - the same path as
    // the Ctrl+Click "go to definition" on a cross-database reference.
    renderDependencyName(dep) {
        if (dep && dep.is_external && dep.external_database) {
            const schema = dep.schema_name || 'dbo';
            const label = `${dep.external_database}.${schema}.${dep.object_name}`;
            return `<button class="dep-link" data-db="${this.escapeHtml(dep.external_database)}" data-schema="${this.escapeHtml(schema)}" data-name="${this.escapeHtml(dep.object_name)}" title="Open ${this.escapeHtml(label)} in ${this.escapeHtml(dep.external_database)}">${this.escapeHtml(dep.referenced_object)}</button>`;
        }
        return this.escapeHtml(dep ? dep.referenced_object : '');
    }

    escapeHtml(text) {
        if (text === null || text === undefined) return '';
        return String(text).replace(/[&<>"']/g, ch => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
        ));
    }
}

// Main message handler
class MessageHandler {
    constructor(connectionStatus, explorerManager, tabManager, commentsManager, detailsTabManager, codeViewManager, objectsTabManager, indexingModalManager, queryManager, queryFileManager) {
        this.connectionStatus = connectionStatus;
        this.explorerManager = explorerManager;
        this.tabManager = tabManager;
        this.commentsManager = commentsManager;
        this.detailsTabManager = detailsTabManager;
        this.codeViewManager = codeViewManager;
        this.objectsTabManager = objectsTabManager;
        this.indexingModalManager = indexingModalManager;
        this.queryManager = queryManager;
        this.queryFileManager = queryFileManager;
        this.databaseSelector = new DatabaseSelectorManager();
    }

    handleMessage(event) {
        const message = event.data;

        switch (message.command) {
            case 'connectionStatus':
                if (message.success) document.getElementById('productionBanner').hidden = !message.production;
                if (message.success && window.schemaSourceManager) window.schemaSourceManager.request();
                if (message.success && window.instanceTree) window.instanceTree.reset();
                if (message.success && window.compareManager) window.compareManager.reset();
                if (message.success && window.recentChanges) window.recentChanges.reset();
                if (this.connectionStatus.onConnectionStatus(message)) {
                    // Land directly on Query after every successful connection -
                    // Explorer (and its indexing) is opt-in, see TabManager.
                    this.tabManager.switchTab('query');
                }
                break;

            case 'snippetsImported':
                // Imports are started from the sidebar; a tab only says it when it is told.
                if (this.queryManager) this.queryManager.setStatus(`Snippets imported: ${message.added || 0}${message.overwritten ? `, ${message.overwritten} overwritten` : ''}.`, 'success');
                break;

            case 'schemaSources':
                if (window.schemaSourceManager) window.schemaSourceManager.onSchemaSources(message);
                break;

            case 'schemaSourceChanged':
                if (window.schemaSourceManager) window.schemaSourceManager.onSchemaSourceChanged(message);
                break;

            case 'queryDatabases':
                if (window.schemaSourceManager) window.schemaSourceManager.onQueryDatabases(message);
                break;

            case 'connectionLost':
                this.connectionStatus.onConnectionLost(message.message);
                break;

            case 'connectionRecovered':
                this.connectionStatus.hideBanner();
                break;

            case 'requestCurrentDatabase':
                vscode.postMessage({
                    command: 'setCurrentDatabase',
                    database: appState.currentDatabase || '',
                    // A sync reply: the extension asked, so an empty answer
                    // means "nothing selected here", not "the user cleared
                    // the selection".
                    sync: true
                });
                break;

            case 'databasesLoaded':
                this.explorerManager.onDatabasesLoaded(message.databases, message.currentDatabase);
                // Only worth a hint when nothing is selected yet - a
                // connection saved with a database opens on it.
                if (!appState.currentDatabase) this.databaseSelector.showReadyGlow();
                // The tab the panel was on, when the page was rebuilt.
                if (message.activeTab) {
                    this.tabManager.switchTab(message.activeTab);
                }
                if (this.codeViewManager) {
                    this.codeViewManager.onDatabaseChanged();
                }
                // Fires on every (re)connection - a fresh connection may point
                // at a different server, see SqlAutocomplete.onConnected.
                if (this.queryManager) {
                    this.queryManager.onConnected();
                }
                break;

            case 'selectDatabase':
                this.explorerManager.selectDatabase(message.database);
                break;

            case 'objectsLoaded':
                this.explorerManager.onObjectsLoaded(message.objects, message.database);
                break;

            case 'autocompleteSettings':
                if (this.queryManager) {
                    this.queryManager.autocomplete.applySettings(message.settings);
                }
                break;

            case 'diagnosticsSettings':
                if (this.queryManager) this.queryManager.setSyntaxEnabled(message.syntax);
                break;

            case 'syntaxResult':
                if (this.queryManager) this.queryManager.onSyntaxResult(message);
                break;

            case 'objectParametersLoaded':
                if (this.queryManager) {
                    this.queryManager.autocomplete.onParametersLoaded(message.database, message.objectName, message.parameters);
                }
                break;

            case 'autocompleteObjectsLoaded':
                if (this.queryManager) {
                    this.queryManager.onAutocompleteObjectsLoaded(message);
                }
                break;

            case 'tableStatsLoaded':
                this.explorerManager.onTableStatsLoaded(message.database, message.stats);
                break;

            case 'foreignKeysLoaded':
                this.explorerManager.onForeignKeysLoaded(message.database, message.foreignKeys);
                break;

            case 'scriptGenerated':
                if (message.preview) {
                    this.explorerManager.onScriptGenerated(message.objectName, message.script);
                } else if (this.queryManager) {
                    this.tabManager.switchTab('query');
                    // From the instance tree, on a database that is not the one the editor runs on.
                    const runsOn = this.queryManager.targetDatabase();
                    const useLine = message.database && message.database !== runsOn ? `USE [${message.database.replace(/]/g, ']]')}]\nGO\n\n` : '';
                    this.queryManager.setQueryText(useLine + message.script);
                }
                break;

            case 'columnUsageResult':
                this.explorerManager.onColumnUsageResult(message.tableName, message.usage);
                break;

            case 'tableDetailsLoaded':
                this.explorerManager.onTableDetailsLoaded(
                    message.tableName,
                    message.columns,
                    message.indexes,
                    message.foreignKeys,
                    message.dependencies,
                    message.stats,
                    message.database
                );
                break;

            case 'writeFootprintResult':
                if (window.footprintManager) window.footprintManager.onResult(message);
                break;

            case 'queryGraphResult':
                if (window.footprintManager) window.footprintManager.onQueryGraphResult(message);
                break;

            case 'footprintDocResult':
                if (window.footprintManager) window.footprintManager.onDocResult(message);
                break;

            case 'objectDetailsLoaded':
                this.explorerManager.onObjectDetailsLoaded(
                    message.objectName,
                    message.objectType,
                    message.dependencies,
                    message.definition,
                    message.database
                );
                break;

            // Index-related messages
            case 'indexResult':
                if (this.objectsTabManager) {
                    this.objectsTabManager.displayIndex(message.indexData, message.database);
                }
                // handleGetIndex's plain path has no 'indexingCompleted' message of
                // its own - this is the only signal that it's done, so hide (or
                // cancel the still-pending scheduled show of) the progress modal here too.
                if (this.indexingModalManager) {
                    this.indexingModalManager.hide();
                }
                break;

            case 'indexStatus':
                if (this.objectsTabManager) {
                    this.objectsTabManager.onIndexStatus(message);
                }
                break;

            case 'indexingProgress':
                if (this.objectsTabManager) {
                    this.objectsTabManager.onIndexingProgress(message);
                }
                if (this.indexingModalManager) {
                    this.indexingModalManager.updateProgress(message.progress, message.current, message.total, message.message);
                }
                break;

            case 'indexingCompleted':
                if (this.objectsTabManager) {
                    this.objectsTabManager.onIndexingCompleted(message.database, message.success, message.message);
                }
                if (this.indexingModalManager) {
                    this.indexingModalManager.hide();
                }
                this.explorerManager.onIndexingSettled(message.database);
                break;

            // Comments Messages
            case 'tableExtendedPropertiesResult':
                this.commentsManager.onTableExtendedPropertiesResult(message.tableName, message.properties);
                break;

            case 'objectExtendedPropertiesResult':
                this.commentsManager.onObjectExtendedPropertiesResult(message.objectName, message.objectType, message.properties);
                break;

            case 'updateDescriptionResult':
                this.commentsManager.onUpdateDescriptionResult(message);
                break;

            case 'deleteDescriptionResult':
                this.commentsManager.onDeleteDescriptionResult(message);
                break;

            case 'error':
                this.handleError(message.message);
                break;

            case 'indexingStarted':
                if (this.objectsTabManager) {
                    this.objectsTabManager.onIndexingStarted(message.database, message.forced);
                }
                if (this.indexingModalManager) {
                    const startMessage = message.forced ? 'Force reindexing started...' : 'Indexing started...';
                    // A build only ever starts from a user action, so show it at once.
                    this.indexingModalManager.show(startMessage, message.database);
                }
                break;

            case 'indexingCancelled':
                if (this.objectsTabManager) {
                    this.objectsTabManager.onIndexingCancelled(message);
                }
                if (this.indexingModalManager) {
                    this.indexingModalManager.hide();
                }
                // No per-database info on cancellation - unlock unconditionally.
                this.explorerManager.setPanelsLocked(false);
                break;
            case 'forceReindexConfirmed':
                if (this.objectsTabManager) {
                    this.objectsTabManager.onForceReindexConfirmed(message.database);
                }
                break;

            case 'dependencyTreeResult':
                if (this.explorerManager._isAwaitedDetails(message.database, message.objectName)) this.explorerManager.displayDependencyTree(message.dependencyTree);
                break;

            case 'queryResult':
                if (this.queryManager) {
                    this.queryManager.onQueryResult(message);
                }
                break;

            case 'transactionState':
                if (this.queryManager) {
                    this.queryManager.onTransactionState(message);
                }
                break;

            case 'recentChanges':
                if (window.recentChanges) window.recentChanges.onChanges(message);
                break;

            case 'recentFailed':
                if (window.recentChanges) window.recentChanges.onFailed(message);
                break;

            case 'recentDefinition':
                if (window.recentChanges) window.recentChanges.onDefinition(message);
                break;

            case 'compareSources':
                if (window.compareManager) window.compareManager.onSources(message);
                break;

            case 'compareResult':
                if (window.compareManager) window.compareManager.onResult(message);
                break;

            case 'compareFailed':
                if (window.compareManager) window.compareManager.onFailed(message);
                break;

            case 'compareScript':
                if (window.compareManager) window.compareManager.onScript(message);
                break;

            case 'compareTargets':
                if (window.compareManager) window.compareManager.onTargets(message);
                break;

            case 'compareTargetDatabases':
                if (window.compareManager) window.compareManager.onTargetDatabases(message);
                break;

            case 'compareTargetStatus':
                if (window.compareManager) window.compareManager.onTargetStatus(message);
                break;

            case 'compareApplyProgress':
                if (window.compareManager) window.compareManager.onApplyProgress(message);
                break;

            case 'compareApplied':
                if (window.compareManager) window.compareManager.onApplied(message);
                break;

            case 'compareApplyDeclined':
                if (window.compareManager) window.compareManager.onApplyDeclined();
                break;

            case 'compareSnapshotDone':
                if (window.compareManager) window.compareManager.onSnapshotDone(message);
                break;

            case 'instanceDatabases':
                if (window.instanceTree) window.instanceTree.onDatabases(message);
                break;

            case 'instanceObjects':
                if (window.instanceTree) window.instanceTree.onObjects(message);
                break;

            case 'instanceObjectsError':
                if (window.instanceTree) window.instanceTree.onObjectsError(message);
                break;

            case 'instanceChanged':
                if (window.instanceTree) window.instanceTree.onChanged(message);
                break;

            case 'planResult':
                if (this.queryManager) {
                    this.queryManager.onPlanResult(message);
                }
                break;

            case 'queryError':
                if (this.queryManager) {
                    this.queryManager.onQueryError(message);
                }
                break;

            case 'queryHistoryLoaded':
                if (this.queryManager) {
                    this.queryManager.onHistoryLoaded(message.history);
                }
                break;

            case 'snippetsLoaded':
                if (this.queryManager) {
                    this.queryManager.onSnippetsLoaded(message.snippets);
                }
                break;

            case 'snippetNamePrompted':
                if (this.queryManager) {
                    this.queryManager.onSnippetNamePrompted(message.name);
                }
                break;

            case 'sqlFilesListed':
                if (this.queryFileManager) this.queryFileManager.onSqlFilesListed(message);
                break;

            case 'sqlFileOpened':
                if (this.queryFileManager) this.queryFileManager.onSqlFileOpened(message);
                break;

            case 'sqlFileError':
                if (this.queryFileManager) this.queryFileManager.onSqlFileError(message);
                break;

            case 'sqlFileSaved':
                if (this.queryFileManager) this.queryFileManager.onSqlFileSaved(message);
                break;

            case 'sqlFileSavedAs':
                if (this.queryFileManager) this.queryFileManager.onSqlFileSavedAs(message);
                break;

            case 'draftRecoveryLoaded':
                if (this.queryFileManager) this.queryFileManager.onDraftRecoveryLoaded(message);
                break;

            case 'discardConfirmed':
                if (this.queryFileManager) this.queryFileManager.onDiscardConfirmed(message);
                break;

            case 'objectColumnsLoaded':
                if (this.queryManager) {
                    this.queryManager.onObjectColumnsLoaded(message);
                }
                break;

            case 'dataDictionaryExported':
                this.explorerManager.onDictionaryExported();
                break;

            case 'buildStats':
                if (this.objectsTabManager) {
                    this.objectsTabManager.onBuildStats(message);
                }
                break;

            case 'resultsExported':
                if (this.queryManager) {
                    this.queryManager.onCsvExported(message);
                }
                break;

            case 'definitionSearchResult':
                this.explorerManager.filterManager.onDefinitionSearchResult(message);
                break;

            default:
                console.warn(`Unknown command: ${message.command}`);
        }
    }

    handleError(message) {
        console.error('SQL Wayfarer Error:', message);
        this.connectionStatus.showStatus(message);
    }
}

// Application initialization
document.addEventListener('DOMContentLoaded', function () {
    // Tells the extension this page was just built, so it can restore what
    // this tab was showing (selected database, open tab) instead of
    // starting from scratch.
    vscode.postMessage({ command: 'panelReady' });

    const tabManager = new TabManager();
    const connectionStatus = new ConnectionStatus();
    const explorerManager = new ExplorerManager();
    const commentsManager = new CommentsManager();
    const codeViewManager = new CodeViewManager();
    const detailsTabManager = new DetailsTabManager();
    const objectsTabManager = new ObjectsTabManager();
    const indexingModalManager = new IndexingModalManager();
    const queryManager = new QueryManager();
    const queryFileManager = new QueryFileManager(queryManager);
    queryManager.openScriptInNewTab = text => queryFileManager.addDraftTabWithContent(text);
    const footprintManager = new FootprintManager();
    const schemaSourceManager = new SchemaSourceManager();
    const instanceTree = new InstanceTree();
    const compareManager = new CompareManager();
    const recentChanges = new RecentChanges();

    const messageHandler = new MessageHandler(
        connectionStatus,
        explorerManager,
        tabManager,
        commentsManager,
        detailsTabManager,
        codeViewManager,
        objectsTabManager,
        indexingModalManager,
        queryManager,
        queryFileManager
    );

    // Make managers available globally
    window.explorerManager = explorerManager;
    window.commentsManager = commentsManager;
    window.codeViewManager = codeViewManager;
    window.detailsTabManager = detailsTabManager;
    window.objectsTabManager = objectsTabManager;
    window.queryManager = queryManager;
    window.schemaSourceManager = schemaSourceManager;
    window.queryFileManager = queryFileManager;
    window.instanceTree = instanceTree;
    window.compareManager = compareManager;
    window.recentChanges = recentChanges;
    window.tabManager = tabManager;
    window.connectionStatus = connectionStatus;
    window.footprintManager = footprintManager;

    window.addEventListener('message', (event) => messageHandler.handleMessage(event));

});