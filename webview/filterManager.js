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
