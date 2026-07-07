/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

const vscode = acquireVsCodeApi();

// Global application state
class AppState {
    constructor() {
        this.activeTab = 'configuration';
        this.activeDetailsTab = 'structure';
        this.isConnected = false;
        this.currentDatabase = null;
        this.selectedObject = null;
        this.savedConnections = [];
        this.connectionConfig = null;
        this.currentDependencies = null;
        this.pendingVisualization = null;
        this.allObjects = [];
        this.filteredObjects = [];
        this.currentIndex = null; // Store the raw index data
        this.filters = {
            search: '',
            inCode: false,
            types: {
                Table: true,
                View: true,
                Procedure: true,
                Function: true
            }
        };
        // Set of qualified names (lowercase) matching the "search in code" query;
        // null while no code search is active or results are pending.
        this.definitionMatches = null;
    }
}

const appState = new AppState();

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
        this.status = 'none'; // none | indexing | ready | error
        this.initEventListeners();
    }

    initEventListeners() {
        if (this.forceReindexBtn) {
            this.forceReindexBtn.addEventListener('click', () => this.handleForceReindex());
        }
        if (this.indicatorBtn) {
            this.indicatorBtn.addEventListener('click', () => this.openModal());
        }
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
    }

    closeModal() {
        this.modalOverlay.classList.remove('visible');
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

    // Called when database changes
    onDatabaseChanged(database) {
        this.currentDatabase = database;

        if (!database) {
            this.showPlaceholder();
            this.forceReindexBtn.disabled = true;
            this.indicatorBtn.disabled = true;
            this.setStatus('none', 'No database selected');
            return;
        }

        this.forceReindexBtn.disabled = false;
        this.indicatorBtn.disabled = false;
        this.showLoading();

        // Request index from backend
        vscode.postMessage({
            command: 'getIndex',
            database: database
        });
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
        this.objectsJsonContent.innerHTML = `<p class="placeholder-text">${result.message}</p>`;
        this.setStatus(this.currentDatabase ? 'error' : 'none', result.message);
    }

    // Show loading state
    showLoading(message = 'Loading database index...') {
        this.objectsJsonContent.innerHTML = `<p class="placeholder-text">${message}</p>`;
    }

    // Show placeholder
    showPlaceholder() {
        this.objectsJsonContent.innerHTML = '<p class="placeholder-text">Select a database to view the raw JSON index of all objects.</p>';
    }

    // Display raw JSON index
    displayIndex(indexData) {
        this.forceReindexBtn.disabled = false;

        if (!indexData) {
            this.objectsJsonContent.innerHTML = '<p class="placeholder-text">No index data available.</p>';
            return;
        }

        // Format and display the raw JSON
        const formattedJson = JSON.stringify(indexData, null, 2);
        this.objectsJsonContent.textContent = formattedJson;
    }

    // Handle indexing progress
    onIndexingProgress(progress) {
        this.objectsJsonContent.innerHTML = `<p class="placeholder-text">Indexing in progress... ${progress.progress}% (${progress.current}/${progress.total})<br>${progress.message}</p>`;
    }

    // Handle indexing completion
    onIndexingCompleted(database, success, message) {
        this.forceReindexBtn.disabled = false;

        if (success) {
            this.setStatus('ready', 'Index up to date');
            // Request the index data
            vscode.postMessage({
                command: 'getIndex',
                database: database
            });
        } else {
            this.objectsJsonContent.innerHTML = `<p class="placeholder-text">Indexing failed: ${message}</p>`;
            this.setStatus('error', message);
        }
    }

    // Handle force reindex completion
    onForceReindexCompleted(database, success, message) {
        this.onIndexingCompleted(database, success, message);
    }
}

// Blocking modal shown while database indexing is running
class IndexingModalManager {
    constructor() {
        this.overlay = document.getElementById('indexingModalOverlay');
        this.messageEl = document.getElementById('indexingModalMessage');
        this.progressFill = document.getElementById('indexingProgressFill');
        this.progressText = document.getElementById('indexingProgressText');
        this.cancelBtn = document.getElementById('indexingCancelBtn');
        this._previousFocus = null;
        this.cancelBtn.addEventListener('click', () => {
            this.cancelBtn.disabled = true;
            this.messageEl.textContent = 'Cancelling…';
            vscode.postMessage({ command: 'cancelIndexing' });
        });
        // Piège à focus : l'overlay bloque les clics mais pas le clavier — sans ça,
        // un Ctrl+Enter dans l'éditeur de requête exécuterait une requête sur la
        // connexion unique pendant l'indexation, et Tab atteint l'UI en arrière-plan.
        document.addEventListener('keydown', (e) => {
            if (!this.overlay.classList.contains('visible')) return;
            if (e.key === 'Tab' || !this.overlay.contains(e.target)) {
                e.preventDefault();
                e.stopPropagation();
                this.cancelBtn.focus();
            }
        }, true);
    }

    show(message) {
        this.messageEl.textContent = message;
        this.progressFill.style.width = '0%';
        this.progressText.textContent = '';
        this.cancelBtn.disabled = false;
        this.overlay.classList.add('visible');
        this._previousFocus = document.activeElement;
        this.cancelBtn.focus();
    }

    updateProgress(progress, current, total, message) {
        this.progressFill.style.width = `${progress}%`;
        this.progressText.textContent = `${progress}% (${current}/${total})`;
        if (message) {
            this.messageEl.textContent = message;
        }
    }

    hide() {
        this.overlay.classList.remove('visible');
        if (this._previousFocus && typeof this._previousFocus.focus === 'function') {
            this._previousFocus.focus();
        }
        this._previousFocus = null;
    }
}

// Details Tab Manager
class DetailsTabManager {
    constructor() {
        this.initEventListeners();
    }

    initEventListeners() {
        const detailsTabButtons = document.querySelectorAll('.details-tab-button');
        detailsTabButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                const tabName = e.target.dataset.detailsTab;
                this.switchDetailsTab(tabName);
            });
        });
    }

    switchDetailsTab(tabName) {
        appState.activeDetailsTab = tabName;

        // Update button states
        document.querySelectorAll('.details-tab-button').forEach(button => {
            button.classList.toggle('active', button.dataset.detailsTab === tabName);
        });

        // Update tab content
        document.querySelectorAll('.details-tab-content').forEach(content => {
            content.classList.toggle('active', content.id === `${tabName}DetailsTab`);
        });

        // Load content for the active tab if needed
        if (appState.selectedObject && appState.currentDatabase) {
            const objectNameForBackend = window.explorerManager._getQualifiedName(appState.selectedObject);

            switch (tabName) {
                case 'comments':
                    window.commentsManager.loadCommentsForObject(
                        appState.currentDatabase,
                        appState.selectedObject.name,
                        appState.selectedObject.object_type
                    );
                    break;

                case 'code':
                    window.codeViewManager.loadCodeForObject(
                        appState.currentDatabase,
                        objectNameForBackend,
                        appState.selectedObject.object_type,
                        appState.selectedObject.definition
                    );
                    break;

                case 'tree':
                    vscode.postMessage({
                        command: 'getDependencyTree',
                        database: appState.currentDatabase,
                        objectName: objectNameForBackend,
                        maxDepth: 3
                    });
                    break;

                case 'graph':
                    // NEW: Load dependency graph
                    vscode.postMessage({
                        command: 'getObjectDetails',
                        database: appState.currentDatabase,
                        objectName: objectNameForBackend,
                        objectType: appState.selectedObject.object_type
                    });
                    break;
            }
        }
    }
}

// Database selector UI manager
class DatabaseSelectorManager {
    constructor() {
        this.databaseSelect = document.getElementById('databaseSelect');
    }

    showReadyGlow() {
        this.databaseSelect.classList.add('database-ready-glow');

        setTimeout(() => {
            this.databaseSelect.classList.remove('database-ready-glow');
        }, 2000);

        this.showReadyNotification();
    }

    showReadyNotification() {
        const notification = document.createElement('div');
        notification.className = 'database-ready-notification';
        notification.innerHTML = `
            <span class="notification-icon"><i class="codicon codicon-sparkle"></i></span>
            <span class="notification-text">Connected! Select a database to explore</span>
        `;

        const headerSection = document.querySelector('.header-section');
        headerSection.appendChild(notification);

        setTimeout(() => {
            if (notification.parentNode) {
                notification.classList.add('fade-out');
                setTimeout(() => {
                    notification.parentNode.removeChild(notification);
                }, 300);
            }
        }, 4000);
    }
}

// Dependency visualizer
class DependencyVisualizer {
    constructor() {
        this.viz = null;
        this.currentMode = 'both';
        this.currentObjectName = null;
        this.dependencies = null;
        this.initViz();
        this.initEventListeners();
    }

    async initViz() {
        try {
            this.viz = new Viz();
        } catch (error) {
            console.error('Failed to initialize Viz.js:', error);
        }
    }

    getNodeColorDark(objectType) {
        switch (objectType) {
            case 'Table':
                return '#1976D2';      // Darker blue
            case 'View':
                return '#F57C00';      // Darker orange
            case 'Procedure':
                return '#7B1FA2';      // Purple (already dark)
            case 'Function':
                return '#5D4037';      // Brown (already dark)
            default:
                return '#424242';      // Dark gray
        }
    }

    initEventListeners() {
        document.getElementById('closeDependencyViz').addEventListener('click', () => {
            this.hideDependencyVisualization();
        });

        document.getElementById('showDependenciesBtn').addEventListener('click', () => {
            this.setMode('dependencies');
        });

        document.getElementById('showReferencesBtn').addEventListener('click', () => {
            this.setMode('references');
        });

        document.getElementById('showBothBtn').addEventListener('click', () => {
            this.setMode('both');
        });
    }

    setMode(mode) {
        this.currentMode = mode;

        document.querySelectorAll('.viz-btn').forEach(btn => btn.classList.remove('active'));

        let targetBtn;
        switch (mode) {
            case 'dependencies':
                targetBtn = document.getElementById('showDependenciesBtn');
                break;
            case 'references':
                targetBtn = document.getElementById('showReferencesBtn');
                break;
            case 'both':
                targetBtn = document.getElementById('showBothBtn');
                break;
        }
        if (targetBtn) {
            targetBtn.classList.add('active');
        }

        if (this.dependencies && this.currentObjectName) {
            this.generateGraph(this.currentObjectName, this.dependencies);
        }
    }

    showDependencyVisualization(objectName, dependencies) {
        this.currentObjectName = objectName;
        this.dependencies = dependencies;

        document.getElementById('dependencyVisualization').style.display = 'block';
        this.generateGraph(objectName, dependencies);
    }

    hideDependencyVisualization() {
        document.getElementById('dependencyVisualization').style.display = 'none';
        this.currentObjectName = null;
        this.dependencies = null;
        appState.pendingVisualization = null;
    }

    async generateGraph(objectName, dependencies) {
        if (!this.viz) {
            document.getElementById('dependencyGraph').innerHTML =
                '<p style="color: var(--vscode-errorForeground);">Visualization engine not available</p>';
            return;
        }

        const dotSource = this.generateDotSource(objectName, dependencies);

        try {
            const svg = await this.viz.renderSVGElement(dotSource);
            const graphContainer = document.getElementById('dependencyGraph');
            graphContainer.innerHTML = '';
            graphContainer.appendChild(svg);
        } catch (error) {
            console.error('Error rendering graph:', error);
            document.getElementById('dependencyGraph').innerHTML =
                '<p style="color: var(--vscode-errorForeground);">Error rendering dependency graph</p>';
        }
    }

    generateDotSource(objectName, dependencies) {
        let dot = 'digraph Dependencies {\n';
        dot += '  rankdir=LR;\n';
        dot += '  bgcolor="transparent";\n';  // NEW: Transparent background
        dot += '  node [shape=box, style=filled, fontname="Arial", fontsize=10, fontcolor="white"];\n';  // NEW: White text
        dot += '  edge [fontname="Arial", fontsize=8, color="white", fontcolor="white"];\n';  // NEW: White edges and labels
        dot += '\n';

        // Main object - bright blue for visibility
        dot += `  "${objectName}" [fillcolor="#007ACC", fontcolor="white", fontweight=bold];\n\n`;

        const addedNodes = new Set([objectName]);
        const addedEdges = new Set();

        if ((this.currentMode === 'dependencies' || this.currentMode === 'both') &&
            dependencies.dependsOn && dependencies.dependsOn.length > 0) {

            dependencies.dependsOn.forEach(dep => {
                const depName = dep.referenced_object;
                if (!addedNodes.has(depName)) {
                    const color = this.getNodeColorDark(dep.referenced_object_type);  // NEW: Dark mode colors
                    dot += `  "${depName}" [fillcolor="${color}", fontcolor="white", label="${depName}\\n(${dep.referenced_object_type})"];\n`;
                    addedNodes.add(depName);
                }

                const edgeKey = `${objectName}->${depName}`;
                if (!addedEdges.has(edgeKey)) {
                    const label = dep.dependency_type || 'depends on';
                    dot += `  "${objectName}" -> "${depName}" [label="${label}", color="#4CAF50", fontcolor="#4CAF50"];\n`;  // NEW: Green arrows
                    addedEdges.add(edgeKey);
                }
            });
        }

        if ((this.currentMode === 'references' || this.currentMode === 'both') &&
            dependencies.referencedBy && dependencies.referencedBy.length > 0) {

            dependencies.referencedBy.forEach(ref => {
                const refName = ref.referencing_object;
                if (!addedNodes.has(refName)) {
                    const color = this.getNodeColorDark(ref.referencing_object_type);  // NEW: Dark mode colors
                    dot += `  "${refName}" [fillcolor="${color}", fontcolor="white", label="${refName}\\n(${ref.referencing_object_type})"];\n`;
                    addedNodes.add(refName);
                }

                const edgeKey = `${refName}->${objectName}`;
                if (!addedEdges.has(edgeKey)) {
                    const label = ref.dependency_type || 'references';
                    dot += `  "${refName}" -> "${objectName}" [label="${label}", color="#FF9800", fontcolor="#FF9800"];\n`;  // NEW: Orange arrows
                    addedEdges.add(edgeKey);
                }
            });
        }

        if (addedNodes.size === 1) {
            dot += '  "No dependencies\\nfound" [fillcolor="#666666", fontcolor="white"];\n';
            dot += `  "${objectName}" -> "No dependencies\\nfound" [style=dashed, color="#888888"];\n`;
        }

        dot += '}';
        return dot;
    }

    getNodeColor(objectType) {
        switch (objectType) {
            case 'Table':
                return '#0E639C';
            case 'View':
                return '#CC6900';
            case 'Procedure':
                return '#7B1FA2';
            case 'Function':
                return '#5D4037';
            default:
                return '#455A64';
        }
    }
}

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
        appState.filteredObjects.forEach(obj => {
            const item = objectList.querySelector(`[data-name="${obj.name}"]`);
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
        const element = this.elements.objectList.querySelector(`[data-name="${CSS.escape(obj.name)}"]`);
        if (element) {
            element.scrollIntoView({ block: 'center' });
            this.handleObjectClick(element, obj);
        }
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

        // Panels stay greyed out until this database finishes (re)indexing.
        this.setPanelsLocked(true);

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

            vscode.postMessage({
                command: 'getObjects',
                database: database
            });
        } else {
            this.elements.objectList.innerHTML = '<p class="placeholder-text">Select a database to view objects.</p>';
            this.elements.detailsContent.innerHTML = '<p>Select a database first.</p>';
            appState.allObjects = [];
            appState.filteredObjects = [];
            this.filterManager.disableFilters();
            this.filterManager.updateObjectCount();
            window.commentsManager.onDatabaseChanged();
            if (window.objectsTabManager) {
                window.objectsTabManager.onDatabaseChanged(null);
            }
            if (window.queryManager) {
                window.queryManager.onDatabaseChanged(null);
            }
        }
    }

    handleObjectClick(element, obj) {
        const prevSelected = this.elements.objectList.querySelector('.selected');
        if (prevSelected) {
            prevSelected.classList.remove('selected');
        }

        element.classList.add('selected');
        appState.selectedObject = obj;

        const objectNameForBackend = this._getQualifiedName(obj);

        console.log(`Selected object: ${this._getDisplayName(obj)} (qualified: ${objectNameForBackend})`);

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
            .map(part => `[${part}]`)
            .join('.');
        const sql = `SELECT TOP 10 * FROM ${bracketed}`;

        if (window.tabManager) {
            window.tabManager.switchTab('query');
        }
        if (window.queryManager) {
            window.queryManager.runQueryText(sql);
        }
    }

    onDatabasesLoaded(databases) {
        this.elements.databaseSelect.disabled = false;
        this.elements.databaseSelect.innerHTML = '<option value="">Select a database...</option>';

        databases.forEach(db => {
            const option = document.createElement('option');
            option.value = db;
            option.textContent = db;
            this.elements.databaseSelect.appendChild(option);
        });
    }

    onObjectsLoaded(objects) {
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

    // Popup mechanics for the script menu: one menu open at a time,
    // closed by any outside click.
    _openPopupMenu(anchorBtn, items, { alignRight = false } = {}) {
        this.closePopupMenu();
        if (items.length === 0) return;

        const menu = document.createElement('div');
        menu.className = 'script-menu';
        items.forEach(({ label, title, onClick }) => {
            const item = document.createElement('button');
            item.className = 'script-menu-item';
            item.textContent = label;
            if (title) item.title = title;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closePopupMenu();
                onClick();
            });
            menu.appendChild(item);
        });

        document.body.appendChild(menu);
        const rect = anchorBtn.getBoundingClientRect();
        menu.style.top = `${Math.min(rect.bottom + 2, window.innerHeight - menu.offsetHeight - 8)}px`;
        const left = alignRight ? rect.right - menu.offsetWidth : rect.left;
        menu.style.left = `${Math.min(Math.max(8, left), window.innerWidth - menu.offsetWidth - 8)}px`;

        this._popupMenu = menu;
        this._popupMenuCloser = (e) => {
            if (!menu.contains(e.target)) this.closePopupMenu();
        };
        // Deferred so the opening click does not immediately close the menu
        setTimeout(() => document.addEventListener('click', this._popupMenuCloser), 0);
    }

    closePopupMenu() {
        if (this._popupMenu) {
            this._popupMenu.remove();
            document.removeEventListener('click', this._popupMenuCloser);
            this._popupMenu = null;
            this._popupMenuCloser = null;
        }
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
                <span class="schema-name"><i class="codicon codicon-folder"></i> ${schema}</span>
                <span class="schema-count">(${objectsBySchema[schema].length})</span>
            `;
                this.elements.objectList.appendChild(schemaHeader);
            }

            objectsBySchema[schema].forEach(obj => {
                const div = document.createElement('div');
                div.className = 'object-item';

                const objectDisplayName = obj.object_name || obj.name.split('.').pop();

                // Get icon based on object type
                const icon = this._getObjectTypeIcon(obj.object_type);

                const nameSpan = document.createElement('span');
                nameSpan.className = 'object-name-with-icon';
                nameSpan.innerHTML = `${icon} ${objectDisplayName}`;

                div.appendChild(nameSpan);
                div.dataset.name = obj.name;
                div.dataset.qualifiedName = obj.qualified_name || obj.name;
                div.dataset.type = obj.object_type;
                div.dataset.schema = obj.schema_name || 'dbo';

                if (obj.object_type === 'Table') {
                    const badge = this._buildStatsBadge(div.dataset.qualifiedName);
                    if (badge) div.appendChild(badge);
                }

                if (this._getScriptOptions(obj.object_type).length > 0) {
                    const scriptBtn = document.createElement('button');
                    scriptBtn.className = 'object-script-btn';
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
                    peekBtn.title = 'Run SELECT TOP 10 * FROM this object';
                    peekBtn.textContent = '▶ Top 10';
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
    }

    _getObjectTypeIcon(objectType) {
        switch (objectType) {
            case 'Table':
                return '<i class="codicon codicon-table"></i>';
            case 'View':
                return '<i class="codicon codicon-eye"></i>';
            case 'Procedure':
                return '<i class="codicon codicon-gear"></i>';
            case 'Function':
                return '<i class="codicon codicon-wrench"></i>';
            case 'Trigger':
                return '<i class="codicon codicon-zap"></i>';
            default:
                return '<i class="codicon codicon-file"></i>';
        }
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
                if (a.object_type !== b.object_type) {
                    return a.object_type.localeCompare(b.object_type);
                }
                return a.name.localeCompare(b.name);
            });
        });

        return grouped;
    }

    onTableDetailsLoaded(tableName, columns, indexes, foreignKeys, dependencies, stats) {
        console.log(`Table details loaded for: ${tableName}`);

        appState.currentDependencies = dependencies;
        this._currentDetailsTable = tableName;

        // Column lineage comes from the in-memory index - fetched separately
        // so the details view never waits on it
        vscode.postMessage({
            command: 'getColumnUsage',
            database: appState.currentDatabase,
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

    onObjectDetailsLoaded(objectName, objectType, dependencies, definition) {
        console.log(`Object details loaded for: ${objectName} (${objectType})`);

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
        html += this.buildDependenciesSection(dependencies);
        this.elements.detailsContent.innerHTML = html;

        if (canFootprint) {
            const btn = document.getElementById('writeFootprintBtn');
            if (btn) btn.addEventListener('click', () => {
                if (window.footprintManager) window.footprintManager.open(objectName);
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

    // NEW METHOD: Display dependency graph in the graph tab
    displayDependencyGraph(objectName, dependencies) {
        const container = document.getElementById('graphContainer');
        if (!container) return;

        if (!dependencies || (!dependencies.dependsOn?.length && !dependencies.referencedBy?.length)) {
            container.innerHTML = `
                <div class="graph-placeholder">
                    <h3><i class="codicon codicon-graph"></i> Dependency Graph</h3>
                    <p class="placeholder-text">No dependencies found for ${objectName}</p>
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

    displayDependencyTree(treeData) {
        const container = document.getElementById('treeContainer');
        if (!container) return;

        if (!treeData) {
            container.innerHTML = '<p class="placeholder-text">No dependency data</p>';
            return;
        }

        // Simple recursive text tree
        function buildTree(node, prefix = '') {
            let result = node.name + '\n';

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

        const treeText = buildTree(treeData);
        container.innerHTML = `<pre>${treeText}</pre>`;
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
            return '<h3>Columns</h3><p>No columns found.</p>';
        }

        let html = '<h3>Columns</h3>';
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
                (writes ? ` · ${writes}✍` : '') + (uncertain ? ' · ~' : '');

            cell.innerHTML = '';
            const btn = document.createElement('button');
            btn.className = 'col-usage-btn';
            btn.textContent = label;
            btn.title = 'Objects referencing this column (✍ = writes, ~ = uncertain matches). Click for the list.';
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
            item.textContent = `${ref.object}${ref.write ? ' ✍' : ''}${ref.confident ? '' : ' (?)'}`;
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
        let html = '<h3>Indexes</h3>';

        if (indexes && indexes.length > 0) {
            html += '<table><tr><th>Name</th><th>Type & Properties</th><th>Columns</th><th>Details</th></tr>';

            indexes.forEach(idx => {
                let badges = '';

                if (idx.is_primary_key === true || idx.is_primary_key === 1) {
                    badges += '<span class="index-badge index-primary">Primary Key</span>';
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
                    details.push(`Filtered: ${idx.filter_definition || 'Yes'}`);
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
        let html = '<h3>Foreign Keys</h3>';

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
            return '<h3>Dependencies</h3><p>No dependency information available.</p>';
        }

        let html = '<h3>Dependencies</h3>';

        html += '<h4>Dependencies (objects this depends on):</h4>';
        if (dependencies.dependsOn && dependencies.dependsOn.length > 0) {
            html += '<table><tr><th>Object Name</th><th>Type</th><th>Operations</th></tr>';
            dependencies.dependsOn.forEach(dep => {
                const operations = dep.operations ? dep.operations.join(', ') : (dep.dependency_type || 'Unknown');
                html += `<tr>
              <td>${this.escapeHtml(dep.referenced_object)}</td>
              <td>${this.escapeHtml(dep.referenced_object_type)}</td>
              <td><small>${this.escapeHtml(operations)}</small></td>
          </tr>`;
            });
            html += '</table>';
        } else {
            html += '<p>No dependencies found.</p>';
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

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Main message handler
class MessageHandler {
    constructor(connectionManager, explorerManager, tabManager, commentsManager, detailsTabManager, codeViewManager, objectsTabManager, indexingModalManager, queryManager) {
        this.connectionManager = connectionManager;
        this.explorerManager = explorerManager;
        this.tabManager = tabManager;
        this.commentsManager = commentsManager;
        this.detailsTabManager = detailsTabManager;
        this.codeViewManager = codeViewManager;
        this.objectsTabManager = objectsTabManager;
        this.indexingModalManager = indexingModalManager;
        this.queryManager = queryManager;
        this.databaseSelector = new DatabaseSelectorManager();
    }

    handleMessage(event) {
        const message = event.data;

        switch (message.command) {
            case 'savedConnectionsLoaded':
                this.connectionManager.onSavedConnectionsLoaded(message.connections, message.lastConnection, message.autoConnect);
                break;

            case 'connectionLoadedForDisplay':
                this.connectionManager.onConnectionLoadedForDisplay(message.connection);
                break;

            case 'connectionSaved':
                this.connectionManager.onConnectionSaved(message);
                break;

            case 'connectionDeleted':
                this.connectionManager.onConnectionDeleted(message);
                break;

            case 'testConnectionResult':
                this.connectionManager.onTestConnectionResult(message);
                break;

            case 'connectionStatus':
                this.connectionManager.onConnectionStatus(message);
                if (message.success) {
                    this.databaseSelector.showReadyGlow();
                    // Land directly on Explorer after every successful connection.
                    this.tabManager.switchTab('explorer');
                }
                break;

            case 'requestCurrentDatabase':
                vscode.postMessage({
                    command: 'setCurrentDatabase',
                    database: appState.currentDatabase
                });
                break;

            case 'databasesLoaded':
                this.explorerManager.onDatabasesLoaded(message.databases);
                if (this.codeViewManager) {
                    this.codeViewManager.onDatabaseChanged();
                }
                break;

            case 'objectsLoaded':
                this.explorerManager.onObjectsLoaded(message.objects);
                break;

            case 'tableStatsLoaded':
                this.explorerManager.onTableStatsLoaded(message.database, message.stats);
                break;

            case 'scriptGenerated':
                if (this.queryManager) {
                    this.tabManager.switchTab('query');
                    this.queryManager.setQueryText(message.script);
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
                    message.stats
                );
                break;

            case 'writeFootprintResult':
                if (window.footprintManager) window.footprintManager.onResult(message);
                break;

            case 'footprintDocResult':
                if (window.footprintManager) window.footprintManager.onDocResult(message);
                break;

            case 'objectDetailsLoaded':
                this.explorerManager.onObjectDetailsLoaded(
                    message.objectName,
                    message.objectType,
                    message.dependencies,
                    message.definition
                );
                break;

            // Index-related messages
            case 'indexResult':
                if (this.objectsTabManager) {
                    this.objectsTabManager.displayIndex(message.indexData);
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
                    this.indexingModalManager.show(message.forced ? 'Force reindexing started...' : 'Indexing started...');
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
                this.explorerManager.displayDependencyTree(message.dependencyTree);
                break;

            case 'queryResult':
                if (this.queryManager) {
                    this.queryManager.onQueryResult(message);
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

            case 'objectColumnsLoaded':
                if (this.queryManager) {
                    this.queryManager.onObjectColumnsLoaded(message);
                }
                break;

            case 'dataDictionaryExported':
                this.explorerManager.onDictionaryExported();
                break;

            case 'csvExported':
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
        if (appState.activeTab === 'configuration') {
            this.connectionManager.showStatus(message, 'error');
        } else {
            this.tabManager.showStatus(message, 'error');
        }
    }
}

// Application initialization
document.addEventListener('DOMContentLoaded', function () {
    console.log('SQL Wayfarer webview loaded');

    const tabManager = new TabManager();
    const connectionManager = new ConnectionManager();
    const explorerManager = new ExplorerManager();
    const commentsManager = new CommentsManager();
    const codeViewManager = new CodeViewManager();
    const detailsTabManager = new DetailsTabManager();
    const objectsTabManager = new ObjectsTabManager();
    const indexingModalManager = new IndexingModalManager();
    const queryManager = new QueryManager();
    const footprintManager = new FootprintManager();

    const messageHandler = new MessageHandler(
        connectionManager,
        explorerManager,
        tabManager,
        commentsManager,
        detailsTabManager,
        codeViewManager,
        objectsTabManager,
        indexingModalManager,
        queryManager
    );

    // Make managers available globally
    window.explorerManager = explorerManager;
    window.commentsManager = commentsManager;
    window.codeViewManager = codeViewManager;
    window.detailsTabManager = detailsTabManager;
    window.objectsTabManager = objectsTabManager;
    window.queryManager = queryManager;
    window.tabManager = tabManager;
    window.footprintManager = footprintManager;

    window.addEventListener('message', (event) => messageHandler.handleMessage(event));

    connectionManager.loadSavedConnections();
});