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

// Simple Objects Tab Manager
class ObjectsTabManager {
    constructor() {
        this.objectsJsonContent = document.getElementById('objectsJsonContent');
        this.forceReindexBtn = document.getElementById('forceReindexBtn');
        this.currentDatabase = null;
        this.initEventListeners();
    }

    initEventListeners() {
        if (this.forceReindexBtn) {
            this.forceReindexBtn.addEventListener('click', () => this.handleForceReindex());
        }
    }

    // Called when database changes
    onDatabaseChanged(database) {
        this.currentDatabase = database;
        
        if (!database) {
            this.showPlaceholder();
            this.forceReindexBtn.disabled = true;
            return;
        }
        
        this.forceReindexBtn.disabled = false;
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
    }

    // Handle indexing cancelled
    onIndexingCancelled(result) {
        this.forceReindexBtn.disabled = false;
        this.objectsJsonContent.innerHTML = `<p class="placeholder-text">${result.message}</p>`;
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
            // Request the index data
            vscode.postMessage({
                command: 'getIndex',
                database: database
            });
        } else {
            this.objectsJsonContent.innerHTML = `<p class="placeholder-text">Indexing failed: ${message}</p>`;
        }
    }

    // Handle force reindex completion
    onForceReindexCompleted(database, success, message) {
        this.onIndexingCompleted(database, success, message);
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
            switch (tabName) {
                case 'comments':
                    window.commentsManager.loadCommentsForObject(
                        appState.currentDatabase,
                        appState.selectedObject.name,
                        appState.selectedObject.object_type
                    );
                    break;
                    
                case 'code':
                    const objectNameForBackend = window.explorerManager._getQualifiedName(appState.selectedObject);
                    window.codeViewManager.loadCodeForObject(
                        appState.currentDatabase,
                        objectNameForBackend,
                        appState.selectedObject.object_type,
                        appState.selectedObject.definition
                    );
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
            <span class="notification-icon">✨</span>
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

// ExplorerManager class with enhanced schema support and object name utilities
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
            
            if (window.extendedEventsManager) {
                window.extendedEventsManager.onDatabaseChanged(database);
            }

            // NEW: Notify Objects tab about database change
            if (window.objectsTabManager) {
                window.objectsTabManager.onDatabaseChanged(database);
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
            if (window.objectsTabManager) {
                window.objectsTabManager.onDatabaseChanged(null);
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
       
       const objectsBySchema = this._groupObjectsBySchema(objects);
       
       Object.keys(objectsBySchema).sort().forEach(schema => {
           if (schema !== 'dbo' || Object.keys(objectsBySchema).length > 1) {
               const schemaHeader = document.createElement('div');
               schemaHeader.className = 'schema-header';
               schemaHeader.innerHTML = `
                   <span class="schema-name">📁 ${schema}</span>
                   <span class="schema-count">(${objectsBySchema[schema].length})</span>
               `;
               this.elements.objectList.appendChild(schemaHeader);
           }
           
           objectsBySchema[schema].forEach(obj => {
               const div = document.createElement('div');
               div.className = 'object-item';
               
               const objectDisplayName = obj.object_name || obj.name.split('.').pop();
               
               const nameSpan = document.createElement('span');
               nameSpan.innerHTML = `${objectDisplayName}<span class="object-type">(${obj.object_type})</span>`;
               
               const vizBtn = document.createElement('button');
               vizBtn.className = 'viz-object-btn';
               vizBtn.textContent = 'Graph';
               vizBtn.onclick = (e) => this.handleShowDependencies(obj.name, e);
               
               div.appendChild(nameSpan);
               div.appendChild(vizBtn);
               div.dataset.name = obj.name;
               div.dataset.qualifiedName = obj.qualified_name || obj.name;
               div.dataset.type = obj.object_type;
               div.dataset.schema = obj.schema_name || 'dbo';
               
               div.addEventListener('click', () => this.handleObjectClick(div, obj));
               
               this.elements.objectList.appendChild(div);
           });
       });
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

   onTableDetailsLoaded(tableName, columns, indexes, foreignKeys, dependencies) {
       console.log(`Table details loaded for: ${tableName}`);
       
       appState.currentDependencies = dependencies;
       
       const html = [
           `<div class="section-header">Table: ${this.escapeHtml(tableName)}</div>`,
           this.buildColumnsTable(columns),
           this.buildIndexesTable(indexes),
           this.buildForeignKeysTable(foreignKeys),
           this.buildDependenciesSection(dependencies)
       ].join('');
       
       this.elements.detailsContent.innerHTML = html;
       this.checkPendingVisualization(tableName, dependencies);
   }

    onObjectDetailsLoaded(objectName, objectType, dependencies, definition) {
        console.log(`Object details loaded for: ${objectName} (${objectType})`);
        
        appState.currentDependencies = dependencies;
        
        if (appState.selectedObject) {
            appState.selectedObject.definition = definition;
        }
        
        let html = `<div class="section-header">${objectType}: ${this.escapeHtml(objectName)}</div>`;
        html += this.buildDependenciesSection(dependencies);
        
        this.elements.detailsContent.innerHTML = html;
        this.checkPendingVisualization(objectName, dependencies);
        
        if (appState.activeDetailsTab === 'code' && window.codeViewManager) {
            window.codeViewManager.onDefinitionReceived(objectName, definition);
        }
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
       html += `<table>
           <tr>
               <th>Name</th>
               <th>Type</th>
               <th>Nullable</th>
               <th>Default</th>
               <th>Length</th>
               <th>Extra</th>
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
           </tr>`;
       });
       
       html += '</table>';
       return html;
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
       
       if (appState.selectedObject) {
           const objectName = this._getQualifiedName(appState.selectedObject);
           html += `<div style="margin-bottom: 15px;">
               <button onclick="window.explorerManager.dependencyVisualizer.showDependencyVisualization('${objectName}', appState.currentDependencies)" 
                       class="viz-btn">Show Dependency Graph</button>
           </div>`;
       }
       
       html += '<h4>Dependencies (objects this depends on):</h4>';
       if (dependencies.dependsOn && dependencies.dependsOn.length > 0) {
           html += '<table><tr><th>Object Name</th><th>Type</th><th>Dependency Type</th><th>Operations</th></tr>';
           dependencies.dependsOn.forEach(dep => {
               const operations = dep.operations ? dep.operations.join(', ') : (dep.dependency_type || 'Unknown');
               html += `<tr>
                   <td>${this.escapeHtml(dep.referenced_object)}</td>
                   <td>${this.escapeHtml(dep.referenced_object_type)}</td>
                   <td>${this.escapeHtml(dep.dependency_type || 'Unknown')}</td>
                   <td><small>${this.escapeHtml(operations)}</small></td>
               </tr>`;
           });
           html += '</table>';
       } else {
           html += '<p>No dependencies found.</p>';
       }
       
       html += '<h4>Referenced by (objects that depend on this):</h4>';
       if (dependencies.referencedBy && dependencies.referencedBy.length > 0) {
           html += '<table><tr><th>Object Name</th><th>Type</th><th>Dependency Type</th><th>Operations</th></tr>';
           dependencies.referencedBy.forEach(ref => {
               const operations = ref.operations ? ref.operations.join(', ') : (ref.dependency_type || 'Unknown');
               html += `<tr>
                   <td>${this.escapeHtml(ref.referencing_object)}</td>
                   <td>${this.escapeHtml(ref.referencing_object_type)}</td>
                   <td>${this.escapeHtml(ref.dependency_type || 'Unknown')}</td>
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
    constructor(connectionManager, explorerManager, tabManager, tableUsageManager, commentsManager, extendedEventsManager, detailsTabManager, codeViewManager, objectsTabManager) {
        this.connectionManager = connectionManager;
        this.explorerManager = explorerManager;
        this.tabManager = tabManager;
        this.tableUsageManager = tableUsageManager;
        this.commentsManager = commentsManager;
        this.extendedEventsManager = extendedEventsManager;
        this.detailsTabManager = detailsTabManager;
        this.codeViewManager = codeViewManager;
        this.objectsTabManager = objectsTabManager;
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
                    this.databaseSelector.showReadyGlow();
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
                this.tableUsageManager.onDatabaseChanged(appState.currentDatabase);
                if (this.codeViewManager) {
                    this.codeViewManager.onDatabaseChanged();
                }
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

            // NEW: Index-related messages
            case 'indexResult':
                if (this.objectsTabManager) {
                    this.objectsTabManager.displayIndex(message.indexData);
                }
                break;

            case 'indexingProgress':
                if (this.objectsTabManager) {
                    this.objectsTabManager.onIndexingProgress(message);
                }
                break;

            case 'indexingCompleted':
                if (this.objectsTabManager) {
                    this.objectsTabManager.onIndexingCompleted(message.database, message.success, message.message);
                }
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

            case 'indexingStarted':
                if (this.objectsTabManager) {
                    this.objectsTabManager.onIndexingStarted(message.database, message.forced);
                }
                break;

            case 'indexingCancelled':
                if (this.objectsTabManager) {
                    this.objectsTabManager.onIndexingCancelled(message);
                }
                break;    
            case 'forceReindexConfirmed':
                if (this.objectsTabManager) {
                    this.objectsTabManager.onForceReindexConfirmed(message.database);
                }
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
    const codeViewManager = new CodeViewManager();
    const detailsTabManager = new DetailsTabManager();
    const objectsTabManager = new ObjectsTabManager(); // NEW
    
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
        detailsTabManager,
        codeViewManager,
        objectsTabManager // NEW
    );
    
    // Make managers available globally
    window.explorerManager = explorerManager;
    window.tableUsageManager = tableUsageManager;
    window.commentsManager = commentsManager;
    window.codeViewManager = codeViewManager;
    window.detailsTabManager = detailsTabManager;
    window.objectsTabManager = objectsTabManager; // NEW
    if (extendedEventsManager) {
        window.extendedEventsManager = extendedEventsManager;
    }
    
    window.addEventListener('message', (event) => messageHandler.handleMessage(event));
    
    connectionManager.loadSavedConnections();
});