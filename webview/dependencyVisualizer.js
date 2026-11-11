/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Dependency visualizer
class DependencyVisualizer {
    constructor() {
        this.viz = null;
        this._vizLoading = null;
        this.currentMode = 'both';
        this.currentObjectName = null;
        this.dependencies = null;
        this.initEventListeners();
    }

    // Viz.js and the Graphviz engine behind it weigh 2 MB: they are loaded the
    // first time a graph is drawn, not each time the panel opens.
    static _loadScript(uri) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = uri;
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Could not load ${uri}`));
            document.head.appendChild(script);
        });
    }

    initViz() {
        if (this.viz) return Promise.resolve();
        if (!this._vizLoading) {
            const uri = name => (document.querySelector(`meta[name="${name}"]`) || {}).content;
            // The API first, then the engine it calls.
            this._vizLoading = DependencyVisualizer._loadScript(uri('viz-script'))
                .then(() => DependencyVisualizer._loadScript(uri('viz-render-script')))
                .then(() => { this.viz = new Viz(); })
                .catch(error => {
                    console.error('Failed to initialize Viz.js:', error);
                    // Asked again on the next graph rather than failing for good.
                    this._vizLoading = null;
                });
        }
        return this._vizLoading;
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
        await this.initViz();
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
            this._attachExternalNodeHandlers(graphContainer, dependencies);
        } catch (error) {
            console.error('Error rendering graph:', error);
            document.getElementById('dependencyGraph').innerHTML =
                '<p style="color: var(--vscode-errorForeground);">Error rendering dependency graph</p>';
        }
    }

    // Cross-database nodes become clickable in the rendered SVG: viz.js emits
    // one <g class="node"> per node, with the node name in its <title>.
    _attachExternalNodeHandlers(container, dependencies) {
        const externals = (dependencies.dependsOn || []).filter(d => d.is_external && d.external_database);
        if (externals.length === 0) return;
        const byName = new Map(externals.map(d => [d.referenced_object, d]));
        container.querySelectorAll('g.node').forEach(node => {
            const title = node.querySelector('title');
            const dep = byName.get(title ? title.textContent : '');
            if (!dep) return;
            node.classList.add('dep-node-external');
            node.addEventListener('click', () => {
                if (window.explorerManager) {
                    window.explorerManager.revealExternalObject(dep.external_database, dep.schema_name || 'dbo', dep.object_name, { newTab: true });
                }
            });
        });
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
                    // A node living in another database keeps a distinct look
                    // (dashed border) so it reads as "not in this database".
                    const color = dep.is_external ? '#0B4F6C' : this.getNodeColorDark(dep.referenced_object_type);
                    const extra = dep.is_external ? ', style="filled,dashed", penwidth=2' : '';
                    dot += `  "${depName}" [fillcolor="${color}", fontcolor="white", label="${depName}\\n(${dep.referenced_object_type})"${extra}];\n`;
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
