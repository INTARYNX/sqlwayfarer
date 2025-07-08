'use strict';

const vscode = acquireVsCodeApi();

// État global de l'application
class AppState {
    constructor() {
        this.activeTab = 'configuration';
        this.isConnected = false;
        this.currentDatabase = null;
        this.selectedObject = null;
        this.savedConnections = [];
        this.connectionConfig = null;
        this.currentDependencies = null;
        this.pendingVisualization = null;
        this.allObjects = []; // Store all objects for filtering
        this.filteredObjects = []; // Store filtered objects
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

// Gestionnaire de visualisation des dépendances
class DependencyVisualizer {
    constructor() {
        this.viz = null;
        this.currentMode = 'both'; // 'dependencies', 'references', 'both'
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
        
        // Update button states
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
        
        // Regenerate graph
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

        // Central node (current object) - using VS Code accent color
        dot += `  "${objectName}" [fillcolor="#007ACC", fontcolor="white", fontweight=bold];\n\n`;

        const addedNodes = new Set([objectName]);
        const addedEdges = new Set();

        // Add dependencies (objects this object depends on)
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

        // Add references (objects that depend on this object)
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

        // If no dependencies found, show a message
        if (addedNodes.size === 1) {
            dot += '  "No dependencies\\nfound" [fillcolor="#666666", fontcolor="white"];\n';
            dot += `  "${objectName}" -> "No dependencies\\nfound" [style=dashed, color="#888888"];\n`;
        }

        dot += '}';
        return dot;
    }

    getNodeColor(objectType) {
        // Using darker colors that work better with white text and VS Code theme
        switch (objectType) {
            case 'Table':
                return '#0E639C'; // Dark blue
            case 'View':
                return '#CC6900'; // Dark orange
            case 'Procedure':
                return '#7B1FA2'; // Dark purple
            case 'Function':
                return '#5D4037'; // Dark brown
            default:
                return '#455A64'; // Dark blue grey
        }
    }
}

// Gestionnaire de filtrage et recherche
class FilterManager {
    constructor() {
        this.initEventListeners();
    }

    initEventListeners() {
        // Search input
        const searchInput = document.getElementById('objectSearch');
        searchInput.addEventListener('input', (e) => {
            appState.filters.search = e.target.value.toLowerCase();
            this.applyFilters();
        });

        // Clear search button
        document.getElementById('clearSearchBtn').addEventListener('click', () => {
            searchInput.value = '';
            appState.filters.search = '';
            this.applyFilters();
        });

        // Type filter checkboxes
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

        // Filter action buttons
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
            // Apply search filter
            const matchesSearch = !searchTerm || 
                obj.name.toLowerCase().includes(searchTerm);

            // Apply type filter
            const matchesType = typeFilters[obj.object_type] === true;

            return matchesSearch && matchesType;
        });

        this.updateObjectDisplay();
    }

    updateObjectDisplay() {
        const objectList = document.getElementById('objectList');
        const objectItems = objectList.querySelectorAll('.object-item');

        // Hide all items first
        objectItems.forEach(item => {
            item.classList.add('hidden');
        });

        // Show filtered items
        appState.filteredObjects.forEach(obj => {
            const item = objectList.querySelector(`[data-name="${obj.name}"]`);
            if (item) {
                item.classList.remove('hidden');
            }
        });

        // Update count
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

// Gestionnaire d'exploration
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
        
        if (database) {
            this.elements.objectList.innerHTML = '<p class="placeholder-text">Loading objects...</p>';
            this.elements.detailsContent.innerHTML = '<p>Loading...</p>';
            
            // Reset filters and disable them while loading
            this.filterManager.resetFilters();
            this.filterManager.disableFilters();
            
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
        }
    }

    handleObjectClick(element, obj) {
        // Supprimer la sélection précédente
        const prevSelected = this.elements.objectList.querySelector('.selected');
        if (prevSelected) {
            prevSelected.classList.remove('selected');
        }
        
        // Ajouter la sélection à l'élément actuel
        element.classList.add('selected');
        appState.selectedObject = obj;
        
        // Charger les détails selon le type d'objet (SANS ouvrir automatiquement le graphique)
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
    }

    handleShowDependencies(objectName, event) {
        event.stopPropagation();
        
        // Marquer qu'on veut afficher la visualisation pour cet objet
        appState.pendingVisualization = objectName;
        
        // Si l'objet est déjà sélectionné et qu'on a ses dépendances, afficher directement
        if (appState.selectedObject && appState.selectedObject.name === objectName && appState.currentDependencies) {
            this.dependencyVisualizer.showDependencyVisualization(objectName, appState.currentDependencies);
        } else {
            // Sinon, charger les détails d'abord
            vscode.postMessage({
                command: 'getObjectDetails',
                database: appState.currentDatabase,
                objectName: objectName,
                objectType: 'Object' // Type générique pour le chargement des dépendances
            });
        }
    }

    // Gestionnaires de messages
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
        
        // Vérifier si on doit afficher la visualisation
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
        
        // Vérifier si on doit afficher la visualisation
        this.checkPendingVisualization(objectName, dependencies);
    }

    checkPendingVisualization(objectName, dependencies) {
        // Si on a une visualisation en attente pour cet objet, l'afficher maintenant
        if (appState.pendingVisualization === objectName) {
            appState.pendingVisualization = null;
            setTimeout(() => {
                this.dependencyVisualizer.showDependencyVisualization(objectName, dependencies);
            }, 100);
        }
    }

    // Méthodes de construction HTML
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
            html += '<table><tr><th>Name</th><th>Type</th><th>Unique</th><th>Primary Key</th><th>Columns</th></tr>';
            
            indexes.forEach(idx => {
                html += `<tr>
                    <td>${this.escapeHtml(idx.index_name)}</td>
                    <td>${this.escapeHtml(idx.type_desc)}</td>
                    <td>${idx.is_unique ? 'Yes' : 'No'}</td>
                    <td>${idx.is_primary_key ? 'Yes' : 'No'}</td>
                    <td>${this.escapeHtml(idx.columns)}</td>
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
        
        // Add visualization button seulement si on a un objet sélectionné
        if (appState.selectedObject) {
            html += `<div style="margin-bottom: 15px;">
                <button onclick="window.explorerManager.dependencyVisualizer.showDependencyVisualization('${appState.selectedObject.name}', appState.currentDependencies)" 
                        class="viz-btn">Show Dependency Graph</button>
            </div>`;
        }
        
        // Objets dont dépend cet objet
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
        
        // Objets qui dépendent de cet objet
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

// Gestionnaire principal de messages
class MessageHandler {
    constructor(connectionManager, explorerManager, tabManager) {
        this.connectionManager = connectionManager;
        this.explorerManager = explorerManager;
        this.tabManager = tabManager;
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
                
            case 'connectionLoadedForConnect':
                if (this.connectionManager.onConnectionLoadedForConnect) {
                    this.connectionManager.onConnectionLoadedForConnect(message.connection);
                }
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
                    // Basculer automatiquement vers l'onglet Explorer après connexion réussie
                    setTimeout(() => {
                        this.tabManager.switchTab('explorer');
                    }, 1000);
                }
                break;
                
            case 'databasesLoaded':
                this.explorerManager.onDatabasesLoaded(message.databases);
                break;
                
            case 'objectsLoaded':
                this.explorerManager.onObjectsLoaded(message.objects);
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
                
            case 'error':
                this.handleError(message.message);
                break;
        }
    }

    handleError(message) {
        console.error('SQL Wayfarer Error:', message);
        // Afficher l'erreur dans l'onglet actuel
        if (appState.activeTab === 'configuration') {
            this.connectionManager.showStatus(message, 'error');
        } else {
            // Afficher dans la console pour l'onglet Explorer
            this.tabManager.showStatus(message, 'error');
        }
    }
}

// Initialisation de l'application
document.addEventListener('DOMContentLoaded', function() {
    console.log('SQL Wayfarer webview loaded');
    
    // Initialiser les gestionnaires
    const tabManager = new TabManager();
    const connectionManager = new ConnectionManager();
    const explorerManager = new ExplorerManager();
    const messageHandler = new MessageHandler(connectionManager, explorerManager, tabManager);
    
    // Rendre explorerManager disponible globalement pour les boutons inline
    window.explorerManager = explorerManager;
    
    // Configurer le gestionnaire de messages
    window.addEventListener('message', (event) => messageHandler.handleMessage(event));
    
    // Charger les connexions sauvegardées au démarrage
    connectionManager.loadSavedConnections();
});