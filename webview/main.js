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
        this.filters = {
            search: '',
            types: {
                Table: true,
                View: true,
                Procedure: true,
                Function: true
            }
        };
    }
}

const appState = new AppState();

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
        if (tabName === 'comments' && appState.selectedObject && appState.currentDatabase) {
            window.commentsManager.loadCommentsForObject(
                appState.currentDatabase,
                appState.selectedObject.name,
                appState.selectedObject.object_type
            );
        }
    }
}

// Database selector UI manager
class DatabaseSelectorManager {
    constructor() {
        this.databaseSelect = document.getElementById('databaseSelect');
    }

    // Show elegant glow animation when connection is ready
    showReadyGlow() {
        this.databaseSelect.classList.add('database-ready-glow');
        
        // Remove animation after it completes (2 seconds for 2 pulses)
        setTimeout(() => {
            this.databaseSelect.classList.remove('database-ready-glow');
        }, 2000);

        // Show temporary notification
        this.showReadyNotification();
    }

    showReadyNotification() {
        // Create notification element
        const notification = document.createElement('div');
        notification.className = 'database-ready-notification';
        notification.innerHTML = `
            <span class="notification-icon">✨</span>
            <span class="notification-text">Connected! Select a database to explore</span>
        `;

        // Add to header section
        const headerSection = document.querySelector('.header-section');
        headerSection.appendChild(notification);

        // Remove notification after 4 seconds
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
        switch(mode) {
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
        dot += '  node [shape=box, style=filled, fontname="Arial", fontsize=10];\n';
        dot += '  edge [fontname="Arial", fontsize=8];\n\n';

        dot += `  "${objectName}" [fillcolor="#007ACC", fontcolor="white", fontweight=bold];\n\n`;

        const addedNodes = new Set([objectName]);
        const addedEdges = new Set();

        if ((this.currentMode === 'dependencies' || this.currentMode === 'both') && 
            dependencies.dependsOn && dependencies.dependsOn.length > 0) {
            
            dependencies.dependsOn.forEach(dep => {
                const depName = dep.referenced_object;
                if (!addedNodes.has(depName)) {
                    const color = this.getNodeColor(dep.referenced_object_type);
                    dot += `  "${depName}" [fillcolor="${color}", fontcolor="white", label="${depName}\\n(${dep.referenced_object_type})"];\n`;
                    addedNodes.add(depName);
                }
                
                const edgeKey = `${objectName}->${depName}`;
                if (!addedEdges.has(edgeKey)) {
                    const label = dep.dependency_type || 'depends on';
                    dot += `  "${objectName}" -> "${depName}" [label="${label}", color="#0066CC", fontcolor="#0066CC"];\n`;
                    addedEdges.add(edgeKey);
                }
            });
        }

        if ((this.currentMode === 'references' || this.currentMode === 'both') && 
            dependencies.referencedBy && dependencies.referencedBy.length > 0) {
            
            dependencies.referencedBy.forEach(ref => {
                const refName = ref.referencing_object;
                if (!addedNodes.has(refName)) {
                    const color = this.getNodeColor(ref.referencing_object_type);
                    dot += `  "${refName}" [fillcolor="${color}", fontcolor="white", label="${refName}\\n(${ref.referencing_object_type})"];\n`;
                    addedNodes.add(refName);
                }
                
                const edgeKey = `${refName}->${objectName}`;
                if (!addedEdges.has(edgeKey)) {
                    const label = ref.dependency_type || 'references';
                    dot += `  "${refName}" -> "${objectName}" [label="${label}", color="#CC6600", fontcolor="#CC6600"];\n`;
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
        this.initEventListeners();
    }

    initEventListeners() {
        const searchInput = document.getElementById('objectSearch');
        searchInput.addEventListener('input', (e) => {
            appState.filters.search = e.target.value.toLowerCase();
            this.applyFilters();
        });

        document.getElementById('clearSearchBtn').addEventListener('click', () => {
            searchInput.value = '';
            appState.filters.search = '';
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
            const matchesSearch = !searchTerm || 
                obj.name.toLowerCase().includes(searchTerm);
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

        appState.filteredObjects.forEach(obj => {
            const item = objectList.querySelector(`[data-name="${obj.name}"]`);
            if (item) {
                item.classList.remove('hidden');
            }
        });

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
        this.setAllFilters(true);
    }
}

// Explorer manager
class ExplorerManager {
    constructor() {
        this.initDOMElements();
        this.initEventListeners();
        this.dependencyVisualizer = new DependencyVisualizer();
        this.filterManager = new FilterManager();
    }

    initDOMElements() {
        this.elements = {
            databaseSelect: document.getElementById('databaseSelect'),
            objectList: document.getElementById('objectList'),
            detailsContent: document.getElementById('detailsContent')
        };
    }

    initEventListeners() {
        this.elements.databaseSelect.addEventListener('change', () => this.handleDatabaseChange());
    }

    handleDatabaseChange() {
        const database = this.elements.databaseSelect.value;
        appState.currentDatabase = database;
        
        // Send current database to backend
        vscode.postMessage({
            command: 'setCurrentDatabase',
            database: database
        });
        
        if (database) {
            this.elements.objectList.innerHTML = '<p class="placeholder-text">Loading objects...</p>';
            this.elements.detailsContent.innerHTML = '<p>Select an object to view its details.</p>';
            
            this.filterManager.resetFilters();
            this.filterManager.disableFilters();
            
            // Reset comments when database changes
            window.commentsManager.onDatabaseChanged();
            
            // Reset extended events when database changes
            if (window.extendedEventsManager) {
                window.extendedEventsManager.onDatabaseChanged(database);
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
            if (window.extendedEventsManager) {
                window.extendedEventsManager.onDatabaseChanged(null);
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
        
        // Load details for structure tab
        if (obj.object_type === 'Table') {
            vscode.postMessage({
                command: 'getTableDetails',
                database: appState.currentDatabase,
                table: obj.name
            });
        } else {
            vscode.postMessage({
                command: 'getObjectDetails',
                database: appState.currentDatabase,
                objectName: obj.name,
                objectType: obj.object_type
            });
        }

        // Load comments if comments tab is active
        if (appState.activeDetailsTab === 'comments') {
            window.commentsManager.loadCommentsForObject(
                appState.currentDatabase,
                obj.name,
                obj.object_type
            );
        }
    }

    handleShowDependencies(objectName, event) {
        event.stopPropagation();
        
        appState.pendingVisualization = objectName;
        
        if (appState.selectedObject && appState.selectedObject.name === objectName && appState.currentDependencies) {
            this.dependencyVisualizer.showDependencyVisualization(objectName, appState.currentDependencies);
        } else {
            vscode.postMessage({
                command: 'getObjectDetails',
                database: appState.currentDatabase,
                objectName: objectName,
                objectType: 'Object'
            });
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
        this.displayObjects(objects);
        this.filterManager.enableFilters();
        this.filterManager.updateObjectCount();
    }

    displayObjects(objects) {
        this.elements.objectList.innerHTML = '';
        
        if (objects.length === 0) {
            this.elements.objectList.innerHTML = '<p class="placeholder-text">No objects found in this database.</p>';
            return;
        }
        
        objects.forEach(obj => {
            const div = document.createElement('div');
            div.className = 'object-item';
            
            const nameSpan = document.createElement('span');
            nameSpan.innerHTML = `${obj.name}<span class="object-type">(${obj.object_type})</span>`;
            
            const vizBtn = document.createElement('button');
            vizBtn.className = 'viz-object-btn';
            vizBtn.textContent = 'Graph';
            vizBtn.onclick = (e) => this.handleShowDependencies(obj.name, e);
            
            div.appendChild(nameSpan);
            div.appendChild(vizBtn);
            div.dataset.name = obj.name;
            div.dataset.type = obj.object_type;
            
            div.addEventListener('click', () => this.handleObjectClick(div, obj));
            
            this.elements.objectList.appendChild(div);
        });
    }

    onTableDetailsLoaded(tableName, columns, indexes, foreignKeys, dependencies) {
        appState.currentDependencies = dependencies;
        
        const html = [
            `<div class="section-header">Table: ${tableName}</div>`,
            this.buildColumnsTable(columns),
            this.buildIndexesTable(indexes),
            this.buildForeignKeysTable(foreignKeys),
            this.buildDependenciesSection(dependencies)
        ].join('');
        
        this.elements.detailsContent.innerHTML = html;
        this.checkPendingVisualization(tableName, dependencies);
    }

    onObjectDetailsLoaded(objectName, objectType, dependencies, definition) {
        appState.currentDependencies = dependencies;
        
        let html = `<div class="section-header">${objectType}: ${objectName}</div>`;
        
        if (definition) {
            html += this.buildDefinitionSection(definition);
        }
        
        html += this.buildDependenciesSection(dependencies);
        
        this.elements.detailsContent.innerHTML = html;
        this.checkPendingVisualization(objectName, dependencies);
    }

    checkPendingVisualization(objectName, dependencies) {
        if (appState.pendingVisualization === objectName) {
            appState.pendingVisualization = null;
            setTimeout(() => {
                this.dependencyVisualizer.showDependencyVisualization(objectName, dependencies);
            }, 100);
        }
    }

    buildColumnsTable(columns) {
        if (!columns || columns.length === 0) {
            return '<h3>Columns</h3><p>No columns found.</p>';
        }

        let html = '<h3>Columns</h3>';
        html += '<table><tr><th>Name</th><th>Type</th><th>Nullable</th><th>Default</th><th>Length</th></tr>';
        
        columns.forEach(col => {
            html += `<tr>
                <td>${this.escapeHtml(col.COLUMN_NAME)}</td>
                <td>${this.escapeHtml(col.DATA_TYPE)}</td>
                <td>${col.IS_NULLABLE}</td>
                <td>${this.escapeHtml(col.COLUMN_DEFAULT || '')}</td>
                <td>${col.CHARACTER_MAXIMUM_LENGTH || ''}</td>
            </tr>`;
        });
        
        html += '</table>';
        return html;
    }

    buildIndexesTable(indexes) {
        let html = '<h3>Indexes</h3>';
        
        if (indexes && indexes.length > 0) {
            html += '<table><tr><th>Name</th><th>Type & Properties</th><th>Columns</th></tr>';
            
            indexes.forEach(idx => {
                let badges = '';
                
                // Primary Key badge
                if (idx.is_primary_key === true || idx.is_primary_key === 1 || 
                    (idx.index_name && idx.index_name.toLowerCase().includes('pk_')) ||
                    (idx.type_desc && idx.type_desc.toLowerCase().includes('primary'))) {
                    badges += '<span class="index-badge index-primary">Primary Key</span>';
                }
                
                // Unique badge
                if ((idx.is_unique === true || idx.is_unique === 1)) {
                    badges += '<span class="index-badge index-unique">Unique</span>';
                }
                
                // Clustered/NonClustered badge
                if (idx.type_desc) {
                    const typeDesc = idx.type_desc.toLowerCase();
                    if (typeDesc.includes('clustered') && !typeDesc.includes('nonclustered')) {
                        badges += '<span class="index-badge index-clustered">Clustered</span>';
                    } else if (typeDesc.includes('nonclustered') || typeDesc.includes('heap')) {
                        badges += '<span class="index-badge index-normal">NonClustered</span>';
                    }
                }
                
                // If no badges were added, add a default one
                if (!badges) {
                    badges = '<span class="index-badge index-normal">Index</span>';
                }
                
                html += `<tr>
                    <td><strong>${this.escapeHtml(idx.index_name)}</strong></td>
                    <td>${badges}</td>
                    <td><code style="background: var(--vscode-textCodeBlock-background); padding: 2px 4px; border-radius: 2px;">${this.escapeHtml(idx.columns)}</code></td>
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
            html += '<table><tr><th>Name</th><th>Column</th><th>Referenced Table</th><th>Referenced Column</th></tr>';
            
            foreignKeys.forEach(fk => {
                html += `<tr>
                    <td>${this.escapeHtml(fk.fk_name)}</td>
                    <td>${this.escapeHtml(fk.column_name)}</td>
                    <td>${this.escapeHtml(fk.referenced_table)}</td>
                    <td>${this.escapeHtml(fk.referenced_column)}</td>
                </tr>`;
            });
            
            html += '</table>';
        } else {
            html += '<p>No foreign keys found.</p>';
        }
        
        return html;
    }

    buildDefinitionSection(definition) {
        let html = '<h3>Definition</h3>';
        html += '<div class="definition-container">';
        html += `<pre><code>${this.escapeHtml(definition || 'No definition available')}</code></pre>`;
        html += '</div>';
        return html;
    }

    buildDependenciesSection(dependencies) {
        if (!dependencies) {
            return '<h3>Dependencies</h3><p>No dependency information available.</p>';
        }
        
        let html = '<h3>Dependencies</h3>';
        
        if (appState.selectedObject) {
            html += `<div style="margin-bottom: 15px;">
                <button onclick="window.explorerManager.dependencyVisualizer.showDependencyVisualization('${appState.selectedObject.name}', appState.currentDependencies)" 
                        class="viz-btn">Show Dependency Graph</button>
            </div>`;
        }
        
        html += '<h4>Dependencies (objects this depends on):</h4>';
        if (dependencies.dependsOn && dependencies.dependsOn.length > 0) {
            html += '<table><tr><th>Object Name</th><th>Type</th><th>Dependency Type</th></tr>';
            dependencies.dependsOn.forEach(dep => {
                html += `<tr>
                    <td>${this.escapeHtml(dep.referenced_object)}</td>
                    <td>${this.escapeHtml(dep.referenced_object_type)}</td>
                    <td>${this.escapeHtml(dep.dependency_type || 'Unknown')}</td>
                </tr>`;
            });
            html += '</table>';
        } else {
            html += '<p>No dependencies found.</p>';
        }
        
        html += '<h4>Referenced by (objects that depend on this):</h4>';
        if (dependencies.referencedBy && dependencies.referencedBy.length > 0) {
            html += '<table><tr><th>Object Name</th><th>Type</th><th>Dependency Type</th></tr>';
            dependencies.referencedBy.forEach(ref => {
                html += `<tr>
                    <td>${this.escapeHtml(ref.referencing_object)}</td>
                    <td>${this.escapeHtml(ref.referencing_object_type)}</td>
                    <td>${this.escapeHtml(ref.dependency_type || 'Unknown')}</td>
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
    constructor(connectionManager, explorerManager, tabManager, tableUsageManager, commentsManager, extendedEventsManager, detailsTabManager) {
        this.connectionManager = connectionManager;
        this.explorerManager = explorerManager;
        this.tabManager = tabManager;
        this.tableUsageManager = tableUsageManager;
        this.commentsManager = commentsManager;
        this.extendedEventsManager = extendedEventsManager;
        this.detailsTabManager = detailsTabManager;
        this.databaseSelector = new DatabaseSelectorManager();
    }

    handleMessage(event) {
        const message = event.data;
        
        switch (message.command) {
            case 'savedConnectionsLoaded':
                this.connectionManager.onSavedConnectionsLoaded(message.connections);
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
                    // Show elegant glow instead of forcing tab switch
                    this.databaseSelector.showReadyGlow();
                }
                break;
                
            case 'requestCurrentDatabase':
                // Send current database to backend
                vscode.postMessage({
                    command: 'setCurrentDatabase',
                    database: appState.currentDatabase
                });
                break;
                
            case 'databasesLoaded':
                this.explorerManager.onDatabasesLoaded(message.databases);
                this.tableUsageManager.onDatabaseChanged(appState.currentDatabase);
                break;
                
            case 'objectsLoaded':
                this.explorerManager.onObjectsLoaded(message.objects);
                this.tableUsageManager.onObjectsLoaded(message.objects);
                if (this.extendedEventsManager) {
                    this.extendedEventsManager.onObjectsLoaded(message.objects);
                }
                break;
                
            case 'tableDetailsLoaded':
                this.explorerManager.onTableDetailsLoaded(
                    message.tableName, 
                    message.columns, 
                    message.indexes, 
                    message.foreignKeys,
                    message.dependencies
                );
                break;
            case 'objectDetailsLoaded':
               this.explorerManager.onObjectDetailsLoaded(
                   message.objectName,
                   message.objectType,
                   message.dependencies,
                   message.definition
               );
               break;
               
           // Table Usage Messages
           case 'allTablesForUsageResult':
               this.tableUsageManager.onAllTablesLoaded(message.tables);
               break;
               
           case 'tableUsageAnalysisResult':
               this.tableUsageManager.onTableUsageAnalysisResult(message.objectName, message.analysis);
               break;
               
           case 'tableUsageByObjectsResult':
               this.tableUsageManager.onTableUsageByObjectsResult(message.tableName, message.usage);
               break;
               
           case 'triggerAnalysisResult':
               this.tableUsageManager.onTriggerAnalysisResult(message.database, message.triggers);
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
               
           // Enhanced Extended Events Messages
           case 'executionFlowSessionCreated':
               if (this.extendedEventsManager) {
                   this.extendedEventsManager.onSessionCreated(message);
               }
               break;
               
           case 'executionFlowSessionStarted':
               if (this.extendedEventsManager) {
                   this.extendedEventsManager.onSessionStarted(message);
               }
               break;
               
           case 'executionFlowSessionStopped':
               if (this.extendedEventsManager) {
                   this.extendedEventsManager.onSessionStopped(message);
               }
               break;
               
           case 'executionFlowSessionDeleted':
               if (this.extendedEventsManager) {
                   this.extendedEventsManager.onSessionDeleted(message);
               }
               break;
               
           case 'executionFlowSessionInfo':
               if (this.extendedEventsManager) {
                   this.extendedEventsManager.onSessionInfoReceived(message.sessionName, message.info);
               }
               break;
               
           // Raw events message handler
           case 'rawSessionEventsResult':
               if (this.extendedEventsManager) {
                   this.extendedEventsManager.onRawEventsReceived(
                       message.sessionName, 
                       message.rawXml, 
                       message.message
                   );
               }
               break;
               
           case 'executionFlowSessionsList':
               if (this.extendedEventsManager) {
                   // Handle sessions list if needed
                   console.log('Available sessions:', message.sessions);
               }
               break;
               
           case 'extendedEventsReceived':
               if (this.extendedEventsManager) {
                   this.extendedEventsManager.onEventsReceived(message.events);
               }
               break;
               
           case 'error':
               this.handleError(message.message);
               break;
               
           default:
               console.warn(`Unknown command: ${message.command}`);
       }
   }    

   handleError(message) {
       console.error('SQL Wayfarer Error:', message);
       if (appState.activeTab === 'configuration') {
           this.connectionManager.showStatus(message, 'error');
       } else if (appState.activeTab === 'tableUsage') {
           this.tableUsageManager.showStatus(message, 'error');
       } else if (appState.activeTab === 'extendedEvents' && this.extendedEventsManager) {
           this.extendedEventsManager.showStatus(message, 'error');
       } else {
           this.tabManager.showStatus(message, 'error');
       }
   }
}

// Application initialization
document.addEventListener('DOMContentLoaded', function() {
   console.log('SQL Wayfarer webview loaded');
   
   const tabManager = new TabManager();
   const connectionManager = new ConnectionManager();
   const explorerManager = new ExplorerManager();
   const tableUsageManager = new TableUsageManager();
   const commentsManager = new CommentsManager();
   const detailsTabManager = new DetailsTabManager();
   
   // Extended Events Manager - optional
   let extendedEventsManager = null;
   if (typeof ExtendedEventsManager !== 'undefined') {
       extendedEventsManager = new ExtendedEventsManager();
   }
   
   const messageHandler = new MessageHandler(
       connectionManager, 
       explorerManager, 
       tabManager, 
       tableUsageManager, 
       commentsManager,
       extendedEventsManager,
       detailsTabManager
   );
   
   // Make managers available globally
   window.explorerManager = explorerManager;
   window.tableUsageManager = tableUsageManager;
   window.commentsManager = commentsManager;
   window.detailsTabManager = detailsTabManager;
   if (extendedEventsManager) {
       window.extendedEventsManager = extendedEventsManager;
   }
   
   window.addEventListener('message', (event) => messageHandler.handleMessage(event));
   
   connectionManager.loadSavedConnections();
});