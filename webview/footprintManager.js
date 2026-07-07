'use strict';

// "Table footprint" view for a procedure/function/view. Three tabs:
//   - Graph : proc-centric footprint (reads/writes + trigger cascade), Cytoscape.
//   - Schema: pure relational ER of the footprint tables (PK/FK), Cytoscape.
//   - Tables: lean per-table doc (columns, PK/FK, descriptions), HTML.
// The heavy analysis is server-side; the doc for Schema/Tables is fetched lazily
// on first switch. Cytoscape + dagre are vendored locally.
class FootprintManager {
    constructor() {
        this.overlay = document.getElementById('writeFootprintOverlay');
        this.titleEl = document.getElementById('writeFootprintTitle');
        this.graphEl = document.getElementById('writeFootprintGraph');
        this.metaEl = document.getElementById('writeFootprintMeta');
        this.schemaEl = document.getElementById('footprintSchemaGraph');
        this.docEl = document.getElementById('footprintTablesDoc');

        this._cy = null;
        this._schemaCy = null;
        this._registered = false;
        this._showReads = true;
        this._activeTab = 'graph';
        this._fp = null;
        this._doc = null;
        this._docByName = {};
        this._docRequested = false;

        this.showReadsChk = document.getElementById('footprintShowReads');
        if (this.showReadsChk) this.showReadsChk.addEventListener('change', () => {
            this._showReads = this.showReadsChk.checked;
            this._applyReadsVisibility();
        });

        this.overlay.querySelectorAll('.fp-tab').forEach(btn => {
            btn.addEventListener('click', () => this.switchTab(btn.dataset.fptab));
        });

        document.getElementById('writeFootprintCloseBtn').addEventListener('click', () => this.close());
        this.overlay.addEventListener('click', (e) => { if (e.target === this.overlay) this.close(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.overlay.classList.contains('visible')) this.close();
        });
    }

    _ensureRegistered() {
        if (!this._registered && window.cytoscape && window.cytoscapeDagre) {
            window.cytoscape.use(window.cytoscapeDagre);
            this._registered = true;
        }
        return this._registered;
    }

    open(objectName) {
        if (!appState.currentDatabase) return;
        this._showReads = true;
        if (this.showReadsChk) this.showReadsChk.checked = true;
        this._fp = null;
        this._doc = null;
        this._docByName = {};
        this._docRequested = false;
        this._destroyGraphs();
        this.schemaEl.innerHTML = '';
        this.docEl.innerHTML = '';
        this.switchTab('graph', true);

        this.titleEl.textContent = `Table footprint — ${objectName}`;
        this.metaEl.textContent = 'Analyzing…';
        this.graphEl.innerHTML = '';
        this.overlay.classList.add('visible');
        vscode.postMessage({ command: 'getWriteFootprint', database: appState.currentDatabase, objectName });
    }

    close() {
        this.overlay.classList.remove('visible');
        this._destroyGraphs();
    }

    _destroyGraphs() {
        if (this._cy) { this._cy.destroy(); this._cy = null; }
        if (this._schemaCy) { this._schemaCy.destroy(); this._schemaCy = null; }
    }

    switchTab(name, silent) {
        this._activeTab = name;
        this.overlay.querySelectorAll('.fp-tab').forEach(b => b.classList.toggle('active', b.dataset.fptab === name));
        this.overlay.querySelectorAll('.fp-panel').forEach(p => p.classList.toggle('active', p.dataset.fppanel === name));
        if (silent) return;
        if (name === 'graph') { if (this._cy) { this._cy.resize(); this._cy.fit(this._cy.elements(':visible'), 30); } }
        else if (name === 'schema') { this._showSchema(); }
        else if (name === 'tables') { this._showTables(); }
    }

    // === Graph tab (footprint) ===

    onResult(message) {
        if (!this.overlay.classList.contains('visible')) return;
        if (!message.success) { this.metaEl.textContent = message.message || 'Analysis failed.'; return; }
        this._fp = message.footprint;
        this.renderGraph(this._fp);
        // If the user is already on Schema/Tables, populate it now that data exists.
        if (this._activeTab === 'schema') this._showSchema();
        else if (this._activeTab === 'tables') this._showTables();
    }

    renderGraph(fp) {
        if (!fp || !fp.found) { this.metaEl.textContent = 'Object not found in the index.'; return; }
        if (!this._ensureRegistered()) { this.metaEl.textContent = 'Graph library failed to load.'; return; }

        const targetId = `obj::${fp.target.qualifiedName}`;
        const elements = [{ data: { id: targetId, label: fp.target.qualifiedName, kind: 'target' } }];

        const counts = { write: 0, read: 0, trigger: 0, possible: 0 };
        for (const t of fp.tables) {
            let kind;
            if (t.access === 'possible') { kind = 'possible'; counts.possible++; }
            else if (t.viaTriggerOnly) { kind = 'trigger'; counts.trigger++; }
            else if (t.access === 'write') { kind = 'write'; counts.write++; }
            else { kind = 'read'; counts.read++; }
            elements.push({ data: { id: `tbl::${t.qualifiedName}`, label: t.qualifiedName, kind } });

            if (kind === 'possible') {
                elements.push({ data: { id: `acc::${t.qualifiedName}`, source: targetId, target: `tbl::${t.qualifiedName}`, edge: 'access-possible' } });
            } else if (!t.viaTriggerOnly) {
                elements.push({ data: { id: `acc::${t.qualifiedName}`, source: targetId, target: `tbl::${t.qualifiedName}`,
                    edge: t.access === 'write' ? 'access-write' : 'access-read' } });
            }
        }
        for (const rel of fp.relationships || []) {
            elements.push({ data: { id: `fk::${rel.fkName}::${rel.fromTable}::${rel.toTable}`,
                source: `tbl::${rel.fromTable}`, target: `tbl::${rel.toTable}`, edge: 'fk' } });
        }

        if (this._cy) { this._cy.destroy(); this._cy = null; }
        this._cy = window.cytoscape({
            container: this.graphEl, elements, wheelSensitivity: 0.2, minZoom: 0.2, maxZoom: 1.3,
            style: FootprintManager._graphStyle(),
            layout: { name: 'dagre', rankDir: 'LR', nodeSep: 30, rankSep: 70, animate: false }
        });
        this._cy.on('tap', 'node[kind != "target"]', (evt) => this._revealTable(evt.target.data('label')));

        this._applyReadsVisibility();
        this._renderMeta(fp, counts);
    }

    _applyReadsVisibility() {
        if (!this._cy) return;
        const reads = this._cy.nodes('[kind = "read"]');
        reads.union(reads.connectedEdges()).style('display', this._showReads ? 'element' : 'none');
        const visible = this._cy.elements(':visible');
        if (visible.length) {
            visible.layout({ name: 'dagre', rankDir: 'LR', nodeSep: 30, rankSep: 70, animate: false }).run();
            this._cy.fit(visible, 30);
        }
    }

    _renderMeta(fp, counts) {
        const parts = [
            `${counts.write} written`, `${counts.read} read`, `${counts.trigger} via trigger`,
            `${counts.possible} possible`, `${(fp.triggersFired || []).length} triggers fired`
        ];
        if (fp.unresolved && fp.unresolved.length) parts.push(`${fp.unresolved.length} unresolved refs`);
        if (fp.truncated) parts.push('depth-limited');

        this.metaEl.innerHTML = '';
        const summary = document.createElement('div');
        summary.className = 'footprint-summary';
        summary.textContent = parts.join(' · ');
        const caveat = document.createElement('div');
        caveat.className = 'footprint-caveat';
        caveat.textContent = 'Static analysis — dynamic SQL is scanned by name; dashed “possible” tables are unconfirmed and their read/write direction is unknown.';
        this.metaEl.appendChild(summary);
        this.metaEl.appendChild(caveat);
    }

    // === Lazy doc fetch (shared by Schema + Tables tabs) ===

    _ensureDoc() {
        if (this._docRequested || !this._fp) return;
        this._docRequested = true;
        const tableNames = this._fp.tables.map(t => t.qualifiedName);
        vscode.postMessage({ command: 'getFootprintDoc', database: appState.currentDatabase, tableNames });
    }

    onDocResult(message) {
        if (!this.overlay.classList.contains('visible')) return;
        if (!message.success) {
            const msg = `<p class="fp-doc-msg">${message.message || 'Failed to load table documentation.'}</p>`;
            this.schemaEl.innerHTML = ''; this.docEl.innerHTML = msg;
            return;
        }
        this._doc = message.doc || { tables: [] };
        this._docByName = {};
        for (const t of this._doc.tables) this._docByName[t.qualifiedName.toLowerCase()] = t;
        if (this._activeTab === 'schema') this._renderSchema();
        else if (this._activeTab === 'tables') this._renderTablesDoc();
    }

    // === Schema tab (pure ER) ===

    _showSchema() {
        if (!this._fp) return;
        if (this._schemaCy) { this._schemaCy.resize(); this._schemaCy.fit(undefined, 30); return; }
        if (this._doc) this._renderSchema();
        else { this._ensureDoc(); this.schemaEl.innerHTML = '<p class="fp-doc-msg">Loading…</p>'; }
    }

    _renderSchema() {
        if (!this._ensureRegistered() || !this._fp) return;
        this.schemaEl.innerHTML = '';
        const elements = [];
        for (const t of this._fp.tables) {
            const d = this._docByName[t.qualifiedName.toLowerCase()];
            elements.push({ data: { id: `s::${t.qualifiedName}`, label: FootprintManager._schemaLabel(t.qualifiedName, d) } });
        }
        for (const rel of this._fp.relationships || []) {
            // child (holds FK) → referenced parent
            elements.push({ data: { id: `sfk::${rel.fkName}`, source: `s::${rel.fromTable}`, target: `s::${rel.toTable}`, label: rel.fkName } });
        }

        this._schemaCy = window.cytoscape({
            container: this.schemaEl, elements, wheelSensitivity: 0.2, minZoom: 0.2, maxZoom: 1.3,
            style: FootprintManager._schemaStyle(),
            layout: { name: 'dagre', rankDir: 'LR', nodeSep: 35, rankSep: 80, animate: false }
        });
        this._schemaCy.on('tap', 'node', (evt) => this._revealTable(evt.target.id().replace(/^s::/, '')));
        this._schemaCy.fit(undefined, 30);
    }

    // === Tables tab (HTML doc) ===

    _showTables() {
        if (!this._fp) return;
        if (this._doc) this._renderTablesDoc();
        else { this._ensureDoc(); this.docEl.innerHTML = '<p class="fp-doc-msg">Loading…</p>'; }
    }

    _renderTablesDoc() {
        const tables = (this._doc && this._doc.tables) || [];
        if (tables.length === 0) { this.docEl.innerHTML = '<p class="fp-doc-msg">No tables to document.</p>'; return; }
        const esc = FootprintManager._esc;
        const html = tables.map(t => {
            const rows = t.columns.map(c => {
                const fk = c.fkRef ? `<span class="fp-fk" title="→ ${esc(c.fkRef)}">FK</span> ` : '';
                const pk = c.isPk ? '🔑 ' : '';
                return `<tr>
                    <td>${pk}${fk}<strong>${esc(c.name)}</strong></td>
                    <td>${esc(c.type)}</td>
                    <td class="fp-center">${c.nullable ? '✓' : ''}</td>
                    <td>${esc(c.default)}</td>
                    <td>${esc(c.description)}</td>
                </tr>`;
            }).join('');
            const desc = t.description ? `<div class="fp-table-desc">${esc(t.description)}</div>` : '';
            return `<div class="fp-table-card">
                <h4>${esc(t.qualifiedName)}</h4>
                ${desc}
                <table class="fp-cols">
                    <thead><tr><th>Column</th><th>Type</th><th>Null</th><th>Default</th><th>Description</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
        }).join('');
        this.docEl.innerHTML = html;
    }

    _revealTable(qualifiedName) {
        if (window.explorerManager && typeof window.explorerManager.revealByName === 'function') {
            window.explorerManager.revealByName(qualifiedName);
            this.close();
        }
    }

    // One line per key column with its roles, e.g. "BusinessEntityID (PK, FK)".
    // A column that is both PK and FK is listed once instead of on two lines.
    static _schemaLabel(qualifiedName, doc) {
        if (!doc) return qualifiedName;
        const pk = doc.primaryKey || [];
        const pkSet = new Set(pk);
        const fkByCol = {};
        for (const f of doc.foreignKeys || []) { if (!fkByCol[f.column]) fkByCol[f.column] = f.refTable; }
        // PK columns first (in key order), then FK-only columns.
        const ordered = [...pk, ...Object.keys(fkByCol).filter(c => !pkSet.has(c))];
        const seen = new Set();
        const lines = [];
        for (const col of ordered) {
            if (seen.has(col)) continue;
            seen.add(col);
            const roles = [];
            if (pkSet.has(col)) roles.push('PK');
            if (fkByCol[col]) roles.push('FK');
            lines.push(`${col} (${roles.join(', ')})`);
        }
        return lines.length ? `${qualifiedName}\n${lines.join('\n')}` : qualifiedName;
    }

    static _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    static _graphStyle() {
        const node = (bg) => ({
            'background-color': bg, 'label': 'data(label)', 'color': '#fff',
            'font-size': 11, 'text-valign': 'center', 'text-halign': 'center',
            'text-wrap': 'wrap', 'text-max-width': 140, 'width': 'label', 'height': 'label',
            'padding': '8px', 'shape': 'round-rectangle', 'text-outline-width': 0
        });
        return [
            { selector: 'node[kind = "target"]', style: { ...node('#0e639c'), 'font-weight': 'bold', 'border-width': 2, 'border-color': '#3794ff' } },
            { selector: 'node[kind = "write"]', style: node('#c0392b') },
            { selector: 'node[kind = "read"]', style: node('#5a6673') },
            { selector: 'node[kind = "trigger"]', style: { ...node('#c77d0a'), 'border-width': 2, 'border-style': 'dashed', 'border-color': '#e8a33d' } },
            { selector: 'node[kind = "possible"]', style: { ...node('#4a5160'), 'background-opacity': 0.55, 'border-width': 2, 'border-style': 'dashed', 'border-color': '#8892a0', 'color': '#cfd6de' } },
            { selector: 'edge', style: { 'curve-style': 'bezier', 'width': 1.5, 'target-arrow-shape': 'triangle', 'arrow-scale': 0.9 } },
            { selector: 'edge[edge = "fk"]', style: { 'line-color': '#8892a0', 'target-arrow-color': '#8892a0' } },
            { selector: 'edge[edge = "access-write"]', style: { 'line-color': '#c0392b', 'target-arrow-color': '#c0392b', 'width': 2 } },
            { selector: 'edge[edge = "access-read"]', style: { 'line-color': '#6b7684', 'target-arrow-color': '#6b7684', 'line-style': 'dashed' } },
            { selector: 'edge[edge = "access-possible"]', style: { 'line-color': '#8892a0', 'line-style': 'dotted', 'target-arrow-shape': 'none', 'opacity': 0.7 } }
        ];
    }

    static _schemaStyle() {
        return [
            { selector: 'node', style: {
                'background-color': '#2d3340', 'border-color': '#4a5160', 'border-width': 1,
                'label': 'data(label)', 'color': '#e0e6ee', 'font-size': 11,
                // Left-justified multi-line label → reads like an entity/table box
                // (name on top, one key column per line) instead of a centred blob.
                'text-valign': 'center', 'text-halign': 'center', 'text-justification': 'left',
                'text-wrap': 'wrap', 'text-max-width': 260,
                'width': 'label', 'height': 'label', 'padding': '10px', 'shape': 'round-rectangle'
            } },
            { selector: 'edge', style: {
                'curve-style': 'bezier', 'width': 1.5, 'line-color': '#8892a0',
                'target-arrow-shape': 'triangle', 'target-arrow-color': '#8892a0', 'arrow-scale': 0.9,
                'label': 'data(label)', 'font-size': 9, 'color': '#9aa4b2',
                'text-background-color': '#1e1e1e', 'text-background-opacity': 0.7, 'text-background-padding': 2
            } }
        ];
    }
}
