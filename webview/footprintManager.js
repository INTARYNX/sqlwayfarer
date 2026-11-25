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
        this.schemaMetaEl = document.getElementById('footprintSchemaMeta');
        this.expandBtn = document.getElementById('footprintExpandBtn');
        this.expandDepthInput = document.getElementById('footprintExpandDepth');
        this.tablesSearchInput = document.getElementById('footprintTablesSearch');
        this.tablesListEl = document.getElementById('footprintTablesList');
        this.maximizeBtn = document.getElementById('footprintMaximizeBtn');
        this.docEl = document.getElementById('footprintTablesDoc');
        this.legendEl = document.getElementById('footprintLegend');
        this.queryLegendEl = document.getElementById('queryGraphLegend');
        this._mode = 'footprint';

        this._cy = null;
        this._schemaCy = null;
        // Which layout placed the tables of the Schema tab: 'elk', or 'dagre'
        // when the ELK engine could not be loaded.
        this._schemaLayoutEngine = null;
        this._registered = false;
        this._showReads = true;
        this._activeTab = 'graph';
        this._fp = null;
        this._doc = null;
        this._docByName = {};
        this._docRequested = false;
        // Tables Expand (global or per-table "+1 level") has brought in so
        // far - accumulates across calls, never replaced wholesale (see
        // _mergeRelated), so an earlier find survives a later Expand.
        this._related = [];
        this._expandRequested = false;
        // Tables the user picked by hand through the tables panel.
        this._manual = [];
        // The authoritative FK graph among the whole set currently shown
        // (seed + related + manual) - null until the first Expand/Add/
        // per-table expand asks for it; _fp.relationships (seed-only, already
        // correct and free of a round trip) is used until then. See
        // _refreshRelationships / onRelationshipsAmongResult / _renderSchema.
        this._relationships = null;
        // Schema tab node labels: keys only (default, compact) or every column.
        this._schemaAllColumns = false;
        // True from open()/openQueryGraph() to close(). The overlay itself
        // keeps the 'visible' class the whole time - it belongs to whichever
        // app tab opened it (see _attachToTab) and is hidden/shown by that
        // tab's own display:none, same as everything else in it, not by
        // toggling 'visible' on tab switches.
        this._open = false;

        this.showReadsChk = document.getElementById('footprintShowReads');
        if (this.showReadsChk) this.showReadsChk.addEventListener('change', () => {
            this._showReads = this.showReadsChk.checked;
            this._applyReadsVisibility();
        });

        this.schemaAllColumnsChk = document.getElementById('footprintSchemaAllColumns');
        if (this.schemaAllColumnsChk) this.schemaAllColumnsChk.addEventListener('change', () => {
            this._schemaAllColumns = this.schemaAllColumnsChk.checked;
            this._renderSchema();
        });

        if (this.expandBtn) this.expandBtn.addEventListener('click', () => this._expandRelated());
        if (this.tablesSearchInput) this.tablesSearchInput.addEventListener('input', () => this._renderTablesPanel());
        if (this.maximizeBtn) this.maximizeBtn.addEventListener('click', () => this._toggleMaximize());

        this.overlay.querySelectorAll('.fp-tab').forEach(btn => {
            btn.addEventListener('click', () => this.switchTab(btn.dataset.fptab));
        });

        // One delegated listener covers both panes' zoom toolbars.
        this.overlay.addEventListener('click', (e) => {
            const btn = e.target.closest('.graph-zoom-btn');
            if (btn) this._graphZoomAction(btn.closest('.graph-zoom-controls').dataset.for, btn.dataset.zoomAction);
        });

        document.getElementById('writeFootprintCloseBtn').addEventListener('click', () => this.close());
        // Stays open until explicitly closed (the × button or Escape) - a
        // stray click outside it (easy to do on a full-window graph) must
        // not lose the analysis. Escape only applies while it is actually on
        // screen (its tab is the active one), not just conceptually open.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this._isShown()) this.close();
        });
    }

    // True once open()/openQueryGraph() moved the overlay into its owning
    // tab (see _attachToTab) and that tab is the one actually on screen -
    // 'visible' alone isn't enough, since the class stays on while another
    // app tab hides the overlay along with the rest of its owning tab.
    _isShown() {
        return this.overlay.classList.contains('visible') && this.overlay.getClientRects().length > 0;
    }

    // The modal belongs to whichever app tab opened it (Explorer for the
    // write footprint, Query for the query graph) - moving it there lets the
    // app's own per-tab display:none hide/show it along with the rest of
    // that tab, instead of a one-off tab-aware show/hide of its own.
    _attachToTab(tabId) {
        const container = document.getElementById(tabId);
        if (container && this.overlay.parentElement !== container) container.appendChild(this.overlay);
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
        this._attachToTab('explorerTab');
        this._showReads = true;
        if (this.showReadsChk) this.showReadsChk.checked = true;
        this._schemaAllColumns = false;
        if (this.schemaAllColumnsChk) this.schemaAllColumnsChk.checked = false;
        this._fp = null;
        this._doc = null;
        this._docByName = {};
        this._docRequested = false;
        this._resetRelated();
        this._destroyGraphs();
        this.schemaEl.innerHTML = '';
        this.docEl.innerHTML = '';
        this.switchTab('graph', true);

        this._mode = 'footprint';
        this.overlay.classList.remove('fp-query-mode');
        this._setLegend('footprint');

        this.titleEl.textContent = `Table footprint — ${objectName}`;
        this.metaEl.textContent = 'Analyzing…';
        this.graphEl.innerHTML = '';
        this._open = true;
        this.overlay.classList.add('visible');
        this._setMaximized(true);
        vscode.postMessage({ command: 'getWriteFootprint', database: appState.currentDatabase, objectName });
    }

    // === Query graph (the same overlay, fed with the graph of a query) ===

    openQueryGraph(sql, options = {}) {
        if (!appState.currentDatabase) return;
        this._attachToTab('queryTab');
        this._schemaAllColumns = false;
        if (this.schemaAllColumnsChk) this.schemaAllColumnsChk.checked = false;
        this._fp = null;
        this._doc = null;
        this._docByName = {};
        this._docRequested = false;
        this._resetRelated();
        this._destroyGraphs();
        this.schemaEl.innerHTML = '';
        this.docEl.innerHTML = '';
        this.switchTab('graph', true);

        this._mode = 'query';
        this.overlay.classList.add('fp-query-mode');
        this._setLegend('query');

        // The graph covers the selected query or the whole buffer - the title
        // says which, so the scope is never a guess.
        const scope = options && options.scope === 'selection' ? 'selection' : 'buffer';
        this.titleEl.textContent = scope === 'selection'
            ? 'Query graph — selected query'
            : 'Query graph — whole query';
        this.metaEl.textContent = 'Analyzing…';
        this.graphEl.innerHTML = '';
        this._open = true;
        this.overlay.classList.add('visible');
        this._setMaximized(true);
        vscode.postMessage({ command: 'getQueryGraph', database: appState.currentDatabase, sql });
    }

    onQueryGraphResult(message) {
        if (!this._open) return;
        if (!message.success) {
            this.metaEl.textContent = message.message || 'Analysis failed.';
            return;
        }
        // The Schema and Tables tabs work on the same shape as the footprint.
        this._fp = message.graph;
        this.renderQueryGraph(this._fp);
        if (this._activeTab === 'schema') this._showSchema();
        else if (this._activeTab === 'tables') this._showTables();
    }

    renderQueryGraph(graph) {
        const tables = (graph && graph.tables) || [];
        if (!this._ensureRegistered()) { this.metaEl.textContent = 'Graph library failed to load.'; return; }
        if (tables.length === 0) {
            this.metaEl.innerHTML = '';
            const empty = document.createElement('div');
            empty.className = 'footprint-summary';
            empty.textContent = graph && graph.parseFailed
                ? 'The query could not be parsed - nothing to graph.'
                : 'No table found in this query.';
            this.metaEl.appendChild(empty);
            return;
        }

        const elements = [];
        const ids = new Map();
        for (const t of tables) {
            const id = `q::${t.qualifiedName}`;
            ids.set(t.qualifiedName, id);
            // A table reached through a procedure or a function is shown apart:
            // the query does not read it directly.
            const via = (t.via && t.via.length) ? t.via.join(' > ') : '';
            elements.push({
                data: {
                    id, name: t.qualifiedName, qname: t.qualifiedName, kind: t.access === 'via-code' ? 'via-code' : 'direct',
                    label: via ? `${t.qualifiedName}\nvia ${via}` : t.qualifiedName
                }
            });
        }
        for (const j of (graph.joins || [])) {
            const source = ids.get(j.from);
            const target = ids.get(j.to);
            if (!source || !target) continue;
            elements.push({
                data: {
                    id: `qj::${j.from}::${j.to}::${j.condition}`,
                    source, target, edge: 'join', label: j.condition,
                    confident: j.confident === false ? 0 : 1
                }
            });
        }

        if (this._cy) { this._cy.destroy(); this._cy = null; }
        this._cy = window.cytoscape({
            container: this.graphEl, elements, wheelSensitivity: 1, minZoom: 0.2, maxZoom: 3,
            boxSelectionEnabled: true,
            style: FootprintManager._queryGraphStyle(),
            // The tables are far enough apart for the condition written on the
            // line between them: a gap that is too short hides it behind the nodes.
            layout: { name: 'dagre', rankDir: 'LR', nodeSep: 40, rankSep: Math.max(90, FootprintManager._joinLabelWidth(graph.joins || []) + 40), animate: false }
        });
        this._cy.on('cxttap', 'node', (evt) => this._openGraphContextMenu(this._cy, evt));
        // A double click opens the table in the Explorer (a single click only
        // selects it, to move or read it): cytoscape has no double click event,
        // two taps on the same node in a row are one.
        let lastTap = { id: null, at: 0 };
        this._cy.on('tap', 'node', (evt) => {
            const now = Date.now();
            const id = evt.target.id();
            if (lastTap.id === id && now - lastTap.at < 400) {
                lastTap = { id: null, at: 0 };
                this._revealTable(evt.target.data('name'));
            } else {
                lastTap = { id, at: now };
            }
        });
        this._fitCapped(this._cy, this._cy.elements(), 30);
        this._renderQueryMeta(graph);
    }

    // The width the longest join condition takes on a line (9 px text, wrapped at
    // JOIN_LABEL_MAX_WIDTH).
    static _joinLabelWidth(joins) {
        const context = document.createElement('canvas').getContext('2d');
        let widest = 0;
        for (const join of joins) {
            const text = String(join.condition || '');
            const width = context ? (context.font = '9px sans-serif', context.measureText(text).width) : text.length * 5.5;
            widest = Math.max(widest, width);
        }
        return Math.min(widest, FootprintManager.JOIN_LABEL_MAX_WIDTH);
    }

    _renderQueryMeta(graph) {
        const joins = (graph.joins || []).length;
        const direct = (graph.tables || []).filter(t => t.access !== 'via-code').length;
        const viaCode = (graph.tables || []).length - direct;
        const parts = [`${direct} table${direct === 1 ? '' : 's'} read`, `${joins} join${joins === 1 ? '' : 's'}`];
        if (viaCode) parts.push(`${viaCode} via code`);
        if (graph.unresolved && graph.unresolved.length) parts.push(`${graph.unresolved.length} unresolved`);
        if (graph.truncated) parts.push('depth-limited');

        this.metaEl.innerHTML = '';
        const summary = document.createElement('div');
        summary.className = 'footprint-summary';
        summary.textContent = parts.join(' · ');
        const caveat = document.createElement('div');
        caveat.className = 'footprint-caveat';
        caveat.textContent = 'Static analysis — dynamic SQL is not followed; a dashed edge is a join whose condition does not qualify its columns.';
        this.metaEl.appendChild(summary);
        this.metaEl.appendChild(caveat);
    }

    // The footprint and the query graph do not show the same things: each
    // mode has its own legend.
    _setLegend(mode) {
        if (this.legendEl) this.legendEl.style.display = mode === 'query' ? 'none' : '';
        if (this.queryLegendEl) this.queryLegendEl.style.display = mode === 'query' ? '' : 'none';
    }

    close() {
        this._open = false;
        this.overlay.classList.remove('visible');
        this._destroyGraphs();
    }

    // Hooked from TabManager.switchTab on every app tab change. Showing and
    // hiding the modal along with the rest of its owning tab is automatic
    // (see _attachToTab) - the only thing left to do here is fix up the
    // cytoscape instances once that tab is the one actually on screen again,
    // since their container had zero size while hidden behind another tab.
    onAppTabChanged(tabName) {
        if (!this._open) return;
        const owner = this._mode === 'footprint' ? 'explorer' : 'query';
        if (tabName !== owner) return;
        [this._cy, this._schemaCy].forEach(cy => { if (cy) { cy.resize(); this._fitCapped(cy, undefined, 30); } });
    }

    _destroyGraphs() {
        if (this._cy) { this._cy.destroy(); this._cy = null; }
        if (this._schemaCy) { this._schemaCy.destroy(); this._schemaCy = null; }
        this._setSchemaPending(false);
    }

    switchTab(name, silent) {
        this._activeTab = name;
        this.overlay.querySelectorAll('.fp-tab').forEach(b => b.classList.toggle('active', b.dataset.fptab === name));
        this.overlay.querySelectorAll('.fp-panel').forEach(p => p.classList.toggle('active', p.dataset.fppanel === name));
        if (silent) return;
        if (name === 'graph') { if (this._cy) { this._cy.resize(); this._fitCapped(this._cy, this._cy.elements(':visible'), 30); } }
        else if (name === 'schema') { this._showSchema(); }
        else if (name === 'tables') { this._showTables(); }
    }

    // === Graph tab (footprint) ===

    onResult(message) {
        if (!this._open) return;
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
        const elements = [{ data: { id: targetId, label: fp.target.qualifiedName, qname: fp.target.qualifiedName, kind: 'target' } }];

        const counts = { write: 0, read: 0, trigger: 0, possible: 0, conditional: 0 };
        for (const t of fp.tables) {
            let kind;
            if (t.access === 'possible') { kind = 'possible'; counts.possible++; }
            else if (t.viaTriggerOnly) { kind = 'trigger'; counts.trigger++; }
            else if (t.access === 'write') { kind = 'write'; counts.write++; }
            else { kind = 'read'; counts.read++; }
            if (t.conditional) counts.conditional++;
            elements.push({ data: { id: `tbl::${t.qualifiedName}`, label: t.qualifiedName, qname: t.qualifiedName, kind, conditional: !!t.conditional } });

            if (kind === 'possible') {
                elements.push({ data: { id: `acc::${t.qualifiedName}`, source: targetId, target: `tbl::${t.qualifiedName}`, edge: 'access-possible' } });
            } else if (kind === 'trigger') {
                // Edge from the table whose write actually fired the trigger (not
                // from the analyzed object) so the graph shows *why* this table is
                // here, labelled with the trigger itself instead of leaving it
                // floating with no visible cause.
                const from = t.viaTriggerFrom ? `tbl::${t.viaTriggerFrom.table}` : targetId;
                const label = t.viaTriggerFrom ? FootprintManager._shortName(t.viaTriggerFrom.trigger) : '';
                elements.push({ data: { id: `acc::${t.qualifiedName}`, source: from, target: `tbl::${t.qualifiedName}`, edge: 'access-trigger', label } });
            } else {
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
            container: this.graphEl, elements, wheelSensitivity: 1, minZoom: 0.2, maxZoom: 3,
            boxSelectionEnabled: true,
            style: FootprintManager._graphStyle(),
            layout: { name: 'dagre', rankDir: 'LR', nodeSep: 30, rankSep: 70, animate: false }
        });
        // Reveal in Explorer is a context-menu action only (see
        // _openGraphContextMenu) - a plain click never jumps away on its
        // own; it just selects the node (native Cytoscape behavior), same
        // as the Schema tab's own nodes.
        this._cy.on('cxttap', 'node', (evt) => this._openGraphContextMenu(this._cy, evt));

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
            this._fitCapped(this._cy, visible, 30);
        }
    }

    _renderMeta(fp, counts) {
        const parts = [
            `${counts.write} written`, `${counts.read} read`, `${counts.trigger} via trigger`,
            `${counts.possible} possible`, `${(fp.triggersFired || []).length} triggers fired`
        ];
        if (counts.conditional) parts.push(`${counts.conditional} not on every run (dotted)`);
        if (fp.unresolved && fp.unresolved.length) parts.push(`${fp.unresolved.length} unresolved refs`);
        if (fp.parseIssues && fp.parseIssues.length) parts.push(`${fp.parseIssues.length} partially parsed`);
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

        // An object whose definition did not parse cleanly was analyzed
        // partially: its footprint may be missing tables and triggers.
        if (fp.parseIssues && fp.parseIssues.length) {
            const warning = document.createElement('div');
            warning.className = 'footprint-warning';
            const names = fp.parseIssues.map(p => p.object).join(', ');
            warning.textContent = `Partial analysis — ${names} could not be parsed cleanly. `
                + 'Their footprint may be incomplete: check the definition for a syntax error.';
            this.metaEl.appendChild(warning);
        }
    }

    // === Lazy doc fetch (shared by Schema + Tables tabs) ===

    _ensureDoc() {
        if (this._docRequested || !this._fp) return;
        this._docRequested = true;
        this._fetchDoc(this._fp.tables.map(t => t.qualifiedName));
    }

    // Asks for the doc of whichever of `tableNames` isn't already known - the
    // initial fetch and a later Expand share this, both merged in onDocResult.
    _fetchDoc(tableNames) {
        const missing = (tableNames || []).filter(n => !this._docByName[n.toLowerCase()]);
        if (missing.length === 0) return;
        vscode.postMessage({ command: 'getFootprintDoc', database: appState.currentDatabase, tableNames: missing });
    }

    onDocResult(message) {
        if (!this._open) return;
        if (!message.success) {
            const msg = `<p class="fp-doc-msg">${FootprintManager._esc(message.message || 'Failed to load table documentation.')}</p>`;
            this.schemaEl.innerHTML = ''; this.docEl.innerHTML = msg;
            return;
        }
        // Merged, not replaced: a later fetch (Expand related tables) only
        // ever adds tables the first one didn't already have.
        if (!this._doc) this._doc = { tables: [] };
        for (const t of (message.doc && message.doc.tables) || []) {
            const key = t.qualifiedName.toLowerCase();
            if (!this._docByName[key]) this._doc.tables.push(t);
            this._docByName[key] = t;
        }
        if (this._activeTab === 'schema') this._renderSchema();
        else if (this._activeTab === 'tables') this._renderTablesDoc();
    }

    // === Schema tab (pure ER) ===

    _showSchema() {
        if (!this._fp) return;
        if (this._schemaCy) { this._schemaCy.resize(); this._fitCapped(this._schemaCy, undefined, 30); this._renderTablesPanel(); return; }
        if (this._doc) this._renderSchema();
        else { this._ensureDoc(); this.schemaEl.innerHTML = '<p class="fp-doc-msg">Loading…</p>'; }
    }

    _resetRelated() {
        this._related = [];
        this._expandRequested = false;
        this._manual = [];
        this._relationships = null;
        if (this.schemaMetaEl) this.schemaMetaEl.textContent = '';
        if (this.tablesSearchInput) this.tablesSearchInput.value = '';
        if (this.expandDepthInput) this.expandDepthInput.value = '1';
        this._setExpandButtonState('idle');
    }

    // Reads the panel's depth input (1-5, default 1 on anything invalid).
    _expandDepth() {
        const n = this.expandDepthInput ? parseInt(this.expandDepthInput.value, 10) : 1;
        return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 1;
    }

    _setExpandButtonState(state) {
        if (!this.expandBtn) return;
        this.expandBtn.disabled = state === 'loading';
        this.expandBtn.innerHTML = state === 'loading'
            ? '<i class="codicon codicon-loading codicon-modifier-spin"></i> Expanding…'
            : state === 'done'
                ? '<i class="codicon codicon-refresh"></i> Refresh'
                : '<i class="codicon codicon-type-hierarchy"></i> Expand';
    }

    // Asks for tables linked to the query/footprint's own seed tables by a
    // foreign key (chased up to the panel's depth setting) or commonly used
    // alongside them - only on request, never by default. Always rooted at
    // the fixed seed, not at whatever is currently shown: rooting it at the
    // ever-growing shown set instead would make every click of this same
    // button (even at the same depth) reach one hop further than the last,
    // so "Refresh" would never actually settle - it would just keep adding
    // tables forever.
    _expandRelated() {
        if (!this._fp || !this._fp.tables.length || this._expandRequested) return;
        this._expandRequested = true;
        this._setExpandButtonState('loading');
        vscode.postMessage({
            command: 'getRelatedTables', database: appState.currentDatabase,
            tableNames: this._fp.tables.map(t => t.qualifiedName), depth: this._expandDepth()
        });
    }

    // Context menu: "Add adjacent tables (+1 level)" on a single table,
    // regardless of the panel's own depth setting.
    _expandOneTable(qualifiedName) {
        if (this._expandRequested) return;
        this._expandRequested = true;
        this._setExpandButtonState('loading');
        vscode.postMessage({
            command: 'getRelatedTables', database: appState.currentDatabase,
            tableNames: [qualifiedName], depth: 1
        });
    }

    // Adds only the genuinely new tables of `newOnes` to _related (never
    // replaces it wholesale - an earlier Expand's finds must survive a later
    // one, whatever triggered it). Returns what was actually added.
    _mergeRelated(newOnes) {
        const clean = (s) => (s || '').replace(/\[|\]/g, '').toLowerCase();
        const shown = new Set(this._shownTableNames().map(clean));
        const added = [];
        for (const r of newOnes || []) {
            const key = clean(r.qualifiedName);
            if (shown.has(key)) continue;
            shown.add(key);
            this._related.push(r);
            added.push(r);
        }
        return added;
    }

    onRelatedTablesResult(message) {
        if (!this._open) return;
        this._expandRequested = false;
        this._setExpandButtonState('done');
        if (!message.success) {
            if (this.schemaMetaEl) this.schemaMetaEl.textContent = message.message || 'Could not look up related tables.';
            return;
        }
        const added = this._mergeRelated(message.related || []);
        if (this.schemaMetaEl) {
            this.schemaMetaEl.textContent = added.length
                ? `${added.length} related table${added.length === 1 ? '' : 's'} added.`
                : 'No new related tables found - no FK neighbor at this depth, and no shared usage in other procedures/views.';
        }
        if (added.length === 0) return;
        // The doc of the newly found tables is fetched before re-rendering,
        // so their PK/FK columns show the first time they appear, not a
        // bare name that re-renders a moment later once the doc arrives.
        this._fetchDoc(added.map(r => r.qualifiedName));
        this._refreshRelationships();
        this._renderSchema();
    }

    // The authoritative FK graph among the whole set now shown - asked for
    // again on every change to that set (Expand, per-table expand, Add,
    // Remove), so an FK between two neighbor tables (not just seed<->neighbor)
    // is never missed. See _renderSchema for how this supersedes the anchor-
    // based FK edges once it has been fetched at least once.
    _refreshRelationships() {
        vscode.postMessage({ command: 'getRelationshipsAmong', database: appState.currentDatabase, tableNames: this._shownTableNames() });
    }

    // Every table currently drawn in the Schema tab, whatever brought it
    // there - the query/footprint itself, Expand, or Add table.
    _shownTableNames() {
        const seed = this._fp ? this._fp.tables.map(t => t.qualifiedName) : [];
        const related = (this._related || []).map(r => r.qualifiedName);
        return [...seed, ...related, ...this._manual];
    }

    // Picked by hand from the tables panel: any table of the database, not
    // just one an FK already pointed at. Once added, every FK among the
    // whole set now on screen is recomputed fresh (see
    // relationshipsAmong) - an FK between the new table and *any* table
    // already shown, not just a seed one.
    _addTable(qualifiedName) {
        const clean = (s) => (s || '').replace(/\[|\]/g, '').toLowerCase();
        const already = new Set(this._shownTableNames().map(clean));
        if (already.has(clean(qualifiedName))) return;
        this._manual.push(qualifiedName);
        this._fetchDoc([qualifiedName]);
        this._refreshRelationships();
        this._renderSchema();
    }

    // "Remove from view": only ever a table Expand or Add table brought in -
    // a seed table is part of the query/footprint itself and stays. Removing
    // a table can only shrink the valid set of FK edges, never add to it, so
    // _relationships is filtered in place rather than asked for again.
    _removeFromSchema(qualifiedName) {
        const clean = (s) => (s || '').replace(/\[|\]/g, '').toLowerCase();
        const target = clean(qualifiedName);
        this._manual = this._manual.filter(n => clean(n) !== target);
        this._related = this._related.filter(r => clean(r.qualifiedName) !== target);
        if (this._relationships) {
            this._relationships = this._relationships.filter(r => clean(r.fromTable) !== target && clean(r.toTable) !== target);
        }
        this._renderSchema();
    }

    onRelationshipsAmongResult(message) {
        if (!this._open || !message.success) return;
        this._relationships = message.relationships || [];
        this._renderSchema();
    }

    _renderSchema() {
        if (!this._ensureRegistered() || !this._fp) return;
        this._renderTablesPanel();
        // The graph of the previous render is destroyed before its container is
        // emptied, not after: the canvas of a live instance has to be removed
        // by the instance itself.
        if (this._schemaCy) { this._schemaCy.destroy(); this._schemaCy = null; }
        this.schemaEl.innerHTML = '';
        const elements = [];
        const seedNames = new Set(this._fp.tables.map(t => t.qualifiedName.toLowerCase()));
        const nodeId = (name) => `s::${name}`;
        const addTableNode = (name, kind) => {
            const d = this._docByName[name.toLowerCase()];
            elements.push({ data: { id: nodeId(name), qname: name, kind, label: FootprintManager._schemaLabel(name, d, this._schemaAllColumns) } });
        };

        for (const t of this._fp.tables) addTableNode(t.qualifiedName, 'seed');
        const drawnNames = new Set(seedNames);
        for (const r of this._related || []) {
            if (drawnNames.has(r.qualifiedName.toLowerCase())) continue; // already drawn as a seed table
            addTableNode(r.qualifiedName, r.via);
            drawnNames.add(r.qualifiedName.toLowerCase());
        }
        for (const name of this._manual) {
            if (drawnNames.has(name.toLowerCase())) continue; // already drawn as a seed/related table
            addTableNode(name, 'added');
            drawnNames.add(name.toLowerCase());
        }

        // FK edges. _relationships is the authoritative graph among the whole
        // set now shown (asked for again on every Expand/Add/per-table
        // expand/Remove - see _refreshRelationships) - it alone can show an
        // FK between two non-seed tables, which the anchor-based neighbor
        // data below never can, so once it has landed at least once it
        // supersedes the fallback entirely. Until then (no round trip yet),
        // the footprint's own seed-only relationships plus the anchor-based
        // edges of FK neighbors are already exact for that smaller set.
        let fkRelationships;
        if (this._relationships !== null) {
            fkRelationships = this._relationships;
        } else {
            fkRelationships = [...(this._fp.relationships || [])];
            for (const r of this._related || []) {
                if (!r.anchorTable || r.via !== 'fk') continue;
                // direction is which role the NEIGHBOR plays: 'parent' (it is
                // referenced by our anchor, which holds the FK) or 'child'
                // (it holds its own FK pointing at our anchor).
                const [source, target] = r.direction === 'parent' ? [r.anchorTable, r.qualifiedName] : [r.qualifiedName, r.anchorTable];
                fkRelationships.push({ fkName: r.fkName, fromTable: source, toTable: target });
            }
        }
        for (const rel of fkRelationships) {
            // Defensive: a response for a table set that has since shrunk
            // (Remove from view, while a request was still in flight) must
            // not reference a node that is no longer drawn.
            if (!drawnNames.has(rel.fromTable.toLowerCase()) || !drawnNames.has(rel.toTable.toLowerCase())) continue;
            elements.push({ data: { id: `fk::${rel.fkName}::${rel.fromTable}::${rel.toTable}`, source: nodeId(rel.fromTable), target: nodeId(rel.toTable), kind: 'fk', label: rel.fkName } });
        }
        // The tables are placed by ELK, not by a layout of Cytoscape (see
        // _layoutSchema): the preset layout only keeps them together until
        // the real positions come. It must not fit the viewport either: the
        // tables are still piled up at that point, and fitting them would
        // zoom the pane to its maximum.
        this._setSchemaPending(true);
        this._schemaLayoutEngine = null;
        const cy = window.cytoscape({
            container: this.schemaEl, elements, wheelSensitivity: 1, minZoom: 0.2, maxZoom: 3,
            boxSelectionEnabled: true,
            style: FootprintManager._schemaStyle(),
            layout: { name: 'preset', fit: false }
        });
        this._schemaCy = cy;
        // Reveal in Explorer is a context-menu action only (see
        // _openGraphContextMenu) - a plain click never jumps away on its
        // own; it just selects the node (native Cytoscape behavior).
        cy.on('cxttap', 'node', (evt) => this._openGraphContextMenu(cy, evt, { removable: evt.target.data('kind') !== 'seed' }));
        this._layoutSchema(cy);
    }

    // Places the tables with ELK: the sizes are the ones Cytoscape gave them
    // (the labels decide them), the positions go back into Cytoscape. The
    // layout is asynchronous - the pane can be redrawn or closed while it
    // runs, hence the check that this graph is still the one on screen.
    async _layoutSchema(cy) {
        const elk = await FootprintManager._elkEngine();
        if (this._schemaCy !== cy) return;
        // The size of a table is only known once it has been drawn: its
        // label is measured while it is drawn. A table measured at zero
        // would be laid out on top of the others.
        await FootprintManager._waitForSizes(cy, () => this._schemaCy === cy);
        if (this._schemaCy !== cy) return;
        // A table whose size was still zero when the graph was created leaves
        // a stale style cache behind: Cytoscape keeps it out of the hit
        // test, and the table would not even be clickable. Both caches are
        // dropped here, and the renderer rebuilds them at the next frame.
        FootprintManager._refreshHitTest(cy);
        await FootprintManager._nextFrame();
        if (this._schemaCy !== cy) return;
        if (elk) {
            const nodes = [];
            cy.nodes().forEach(n => nodes.push({ id: n.id(), width: n.outerWidth(), height: n.outerHeight() }));
            const edges = [];
            cy.edges().forEach(e => edges.push({ id: e.id(), source: e.source().id(), target: e.target().id() }));
            let layout = null;
            try {
                layout = await elk.layout(SchemaLayout.buildGraph(nodes, edges));
            } catch (err) {
                console.error('The ELK layout failed:', err);
            }
            if (this._schemaCy !== cy) return;
            if (layout) {
                SchemaLayout.apply(cy, layout);
                this._schemaLayoutEngine = 'elk';
                this._setSchemaPending(false);
                this._fitCapped(cy, undefined, 30);
                return;
            }
        }
        // No ELK (the engine could not be loaded, or it failed): the dagre
        // layout the Schema tab used before still draws the tables.
        cy.layout({ name: 'dagre', rankDir: 'LR', nodeSep: 35, rankSep: 80, animate: false }).run();
        this._schemaLayoutEngine = 'dagre';
        this._setSchemaPending(false);
        this._fitCapped(cy, undefined, 30);
    }

    // While ELK places the tables, the pane stays empty: the tables piled up
    // where the preset layout leaves them look worse than a pane that is
    // briefly blank.
    _setSchemaPending(pending) {
        this.schemaEl.classList.toggle('fp-layout-pending', pending);
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
                const fk = c.fkRef ? `<span class="fp-fk" title="References ${esc(c.fkRef)}">FK</span> ` : '';
                const pk = c.isPk ? `${swIcon('key')} ` : '';
                return `<tr>
                    <td>${pk}${fk}<strong>${esc(c.name)}</strong></td>
                    <td>${esc(c.type)}</td>
                    <td class="fp-center">${c.nullable ? '<i class="codicon codicon-check"></i>' : ''}</td>
                    <td>${esc(c.default)}</td>
                    <td>${esc(c.description)}</td>
                </tr>`;
            }).join('');
            const desc = t.description ? `<div class="fp-table-desc">${esc(t.description)}</div>` : '';
            return `<div class="fp-table-card">
                <h4>${esc(t.qualifiedName)}</h4>
                ${desc}
                <table class="fp-cols">
                    <colgroup>
                        <col class="fp-col-name"><col class="fp-col-type"><col class="fp-col-null">
                        <col class="fp-col-default"><col class="fp-col-desc">
                    </colgroup>
                    <thead><tr><th>Column</th><th>Type</th><th>Null</th><th>Default</th><th>Description</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
        }).join('');
        this.docEl.innerHTML = html;
    }

    // Never closes the modal - the whole point is to check a table while
    // keeping the graph open, from a single click, a context menu, or either.
    _revealTable(qualifiedName) {
        if (window.explorerManager && typeof window.explorerManager.revealByName === 'function') {
            window.explorerManager.revealByName(qualifiedName);
        }
    }

    // === Graph controls: context menu, zoom, fullscreen (Graph and Schema tabs) ===

    // Right-click a node: zoom to it, reveal it in the Explorer, and - on the
    // Schema tab only - pull in that one table's own neighbors by one level,
    // or - a table Expand or Add table brought in - remove it from view.
    // Reuses the app's one popup-menu widget instead of a second menu
    // implementation.
    _openGraphContextMenu(cy, evt, { removable = false } = {}) {
        if (!window.explorerManager || !window.explorerManager._openPopupMenu) return;
        const node = evt.target;
        const qname = node.data('qname') || node.data('name') || node.data('label');
        const items = [
            { label: 'Zoom to this table', onClick: () => cy.animate({ fit: { eles: node, padding: 80 } }, { duration: 250 }) },
            { label: 'Reveal in Explorer', onClick: () => this._revealTable(qname) }
        ];
        if (cy === this._schemaCy) {
            items.push({ label: 'Add adjacent tables (+1 level)', separatorBefore: true, onClick: () => this._expandOneTable(qname) });
        }
        if (removable) items.push({ label: 'Remove from view', onClick: () => this._removeFromSchema(qname) });
        const point = evt.originalEvent;
        window.explorerManager._openPopupMenu(this.overlay, items, { at: { x: point.clientX, y: point.clientY } });
    }

    // + / - / fit buttons, shared by the Graph and Schema panes (data-for on
    // their .graph-zoom-controls says which). Fit zooms to the selection
    // (a box-drag selects several nodes) when there is one, the whole graph otherwise.
    _graphZoomAction(forWhich, action) {
        const cy = forWhich === 'schema' ? this._schemaCy : this._cy;
        if (!cy) return;
        const center = { x: cy.width() / 2, y: cy.height() / 2 };
        if (action === 'in') cy.zoom({ level: cy.zoom() * 1.25, renderedPosition: center });
        else if (action === 'out') cy.zoom({ level: cy.zoom() / 1.25, renderedPosition: center });
        else if (action === 'fit') {
            const selected = cy.$(':selected');
            this._fitCapped(cy, selected.length ? selected : undefined, 30);
        }
    }

    // cy.fit() alone zooms in as far as it takes to fill the pane - fine with
    // a dozen tables, but a lone node or two then renders oversized. Capped
    // so a small graph still reads at a normal size; the zoom-in button can
    // still go well past this (see maxZoom on the cytoscape instances).
    _fitCapped(cy, eles, padding) {
        cy.fit(eles, padding);
        if (cy.zoom() > FootprintManager.FIT_ZOOM_CAP) {
            cy.zoom({ level: FootprintManager.FIT_ZOOM_CAP, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
        }
    }

    // Full window by default (the modal is only worth opening to look at a
    // graph), but never over the app's own tab bar above it, and without
    // graying it out either - the overlay itself (backdrop + dialog) is
    // narrowed to start below the tab bar, not just the dialog inside it.
    // Measured fresh each time since a banner can change the tab bar's
    // height while the modal is open. cy.resize()+fit() so a graph created
    // before maximizing (or minimizing back) isn't stuck measuring the old
    // container size.
    _setMaximized(maximized) {
        const dialog = this.overlay.querySelector('.modal-dialog-footprint');
        if (!dialog) return;
        dialog.classList.toggle('fp-maximized', maximized);
        this.overlay.classList.toggle('fp-maximized', maximized);
        if (maximized) {
            const toolbar = document.querySelector('.app-toolbar');
            this.overlay.style.setProperty('--fp-top-offset', `${toolbar ? Math.max(0, toolbar.getBoundingClientRect().bottom) : 0}px`);
        }
        if (this.maximizeBtn) {
            this.maximizeBtn.title = maximized ? 'Restore' : 'Maximize';
            this.maximizeBtn.innerHTML = `<i class="codicon codicon-screen-${maximized ? 'normal' : 'full'}"></i>`;
        }
        [this._cy, this._schemaCy].forEach(cy => { if (cy) { cy.resize(); this._fitCapped(cy, undefined, 30); } });
    }

    _toggleMaximize() {
        const dialog = this.overlay.querySelector('.modal-dialog-footprint');
        this._setMaximized(!(dialog && dialog.classList.contains('fp-maximized')));
    }

    // === Tables panel (Schema tab): browse/search every table of the database,
    // add it, jump to it if it's already on screen, or remove it ===

    // Every table of the database, searched live by the panel's own input,
    // each row showing whether it is on screen already. Re-rendered on every
    // state change that affects "what is shown" (see _renderSchema).
    //   - Not shown: click adds it (_addTable).
    //   - Already shown (seed or not): click jumps to it on the canvas
    //     (_centerOnTable) - this is also how a table is found on the
    //     schema once it's there, since typing its name narrows the list to
    //     it. Removing it is a separate, explicit action (the small ✕), not
    //     the same click as locating it - the two are easy to confuse
    //     otherwise, and a search should never risk removing what it finds.
    //   - Seed tables can't be removed (they are the query/footprint itself),
    //     so they get no ✕.
    _renderTablesPanel() {
        if (!this.tablesListEl || !this._fp) return;
        const clean = (s) => (s || '').replace(/\[|\]/g, '').toLowerCase();
        const seed = new Set(this._fp.tables.map(t => clean(t.qualifiedName)));
        const shown = new Set(this._shownTableNames().map(clean));
        const allTables = (appState.allObjects || [])
            .filter(o => o.object_type === 'Table')
            .map(o => o.qualified_name || o.object_name || o.name)
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b));

        const needle = this.tablesSearchInput ? this.tablesSearchInput.value.trim().toLowerCase() : '';
        const matches = needle ? allTables.filter(n => n.toLowerCase().includes(needle)) : allTables;

        this.tablesListEl.innerHTML = '';
        if (matches.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'script-menu-empty';
            empty.textContent = 'No match.';
            this.tablesListEl.appendChild(empty);
            return;
        }
        for (const name of matches) {
            const key = clean(name);
            const isSeed = seed.has(key);
            const isShown = shown.has(key);
            const row = document.createElement('div');
            row.className = 'fp-tables-row' + (isShown ? ' fp-tables-row-shown' : '');
            row.setAttribute('role', 'menuitem');
            row.tabIndex = 0;
            row.title = isSeed ? `${name} - in your query/footprint, click to locate it`
                : isShown ? `${name} - click to locate it, or remove it with ✕`
                    : `${name} - click to add it to the view`;
            const icon = document.createElement('i');
            icon.className = 'codicon ' + (isSeed ? 'codicon-pinned' : isShown ? 'codicon-target' : 'codicon-add');
            row.appendChild(icon);
            const label = document.createElement('span');
            label.textContent = name;
            row.appendChild(label);
            const activate = () => { if (isShown) this._centerOnTable(name); else this._addTable(name); };
            row.addEventListener('click', activate);
            row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
            if (isShown && !isSeed) {
                const remove = document.createElement('button');
                remove.className = 'fp-tables-row-remove';
                remove.title = `Remove ${name} from view`;
                remove.setAttribute('aria-label', `Remove ${name} from view`);
                remove.innerHTML = '<i class="codicon codicon-close"></i>';
                remove.addEventListener('click', (e) => { e.stopPropagation(); this._removeFromSchema(name); });
                row.appendChild(remove);
            }
            this.tablesListEl.appendChild(row);
        }
    }

    // Jumps the schema graph to an already-shown table, by name - the tables
    // panel's own way to search a table and center it. The context menu's
    // "Zoom to this table" does the same animation from a node it already
    // has in hand (see _openGraphContextMenu); this one looks the node up by
    // name instead, for the panel.
    _centerOnTable(qualifiedName) {
        if (!this._schemaCy) return;
        const node = this._schemaCy.getElementById(`s::${qualifiedName}`);
        if (!node || node.empty()) return;
        this._schemaCy.animate({ fit: { eles: node, padding: 80 } }, { duration: 250 });
    }

    // One line per column with a small icon for its role (🔑 PK, 🔗 FK - a
    // column that is both gets both), under a separator so the table name
    // reads as a header instead of just the first line of a plain list.
    // Keys only by default (compact); allColumns lists every column of the
    // table instead, for when a key-only view isn't enough to work from.
    static _schemaLabel(qualifiedName, doc, allColumns) {
        if (!doc) return qualifiedName;
        const pk = doc.primaryKey || [];
        const pkSet = new Set(pk);
        const fkByCol = {};
        for (const f of doc.foreignKeys || []) { if (!fkByCol[f.column]) fkByCol[f.column] = f.refTable; }
        const allNames = (doc.columns || []).map(c => c.name);
        // PK columns first (in key order), then either every other column
        // (allColumns) or just the FK-only ones (the compact default).
        const ordered = allColumns && allNames.length
            ? [...pk, ...allNames.filter(c => !pkSet.has(c))]
            : [...pk, ...Object.keys(fkByCol).filter(c => !pkSet.has(c))];
        const seen = new Set();
        const lines = [];
        for (const col of ordered) {
            if (seen.has(col)) continue;
            seen.add(col);
            const icon = `${pkSet.has(col) ? '🔑' : ''}${fkByCol[col] ? '🔗' : ''}`;
            lines.push(`${icon} ${col}`.trim());
        }
        return lines.length ? `${qualifiedName}\n${FootprintManager.SCHEMA_SEPARATOR}\n${lines.join('\n')}` : qualifiedName;
    }

    static _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    // The ELK engine (1.6 MB) is loaded the first time a schema is laid out,
    // not with the page - the way Viz.js is loaded for the dependency graph.
    static _loadElk() {
        if (FootprintManager._elkLoading) return FootprintManager._elkLoading;
        const uri = (document.querySelector('meta[name="elk-script"]') || {}).content;
        if (!uri) return Promise.resolve(null);
        FootprintManager._elkLoading = new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = uri;
            script.onload = () => resolve(window.ELK || null);
            // A failure is not final: the file may be missing from an older
            // build, and the next schema asks again - so the failed tag is
            // removed instead of being left behind in <head> on every retry.
            script.onerror = () => { script.remove(); FootprintManager._elkLoading = null; resolve(null); };
            document.head.appendChild(script);
        });
        return FootprintManager._elkLoading;
    }

    // The ELK engine itself, once: null when the script could not be loaded
    // (the Schema tab then falls back on the dagre layout).
    static async _elkEngine() {
        if (FootprintManager._elk) return FootprintManager._elk;
        const Engine = await FootprintManager._loadElk();
        if (!Engine) return null;
        FootprintManager._elk = new Engine();
        return FootprintManager._elk;
    }

    // The next frame of the page: Cytoscape draws its graph in one, and
    // measures the labels of the tables in it.
    static _nextFrame() {
        return new Promise(resolve => requestAnimationFrame(() => resolve()));
    }

    // Waits for the tables to have a size: their label is measured while
    // they are drawn, and a table measured at zero would be laid out on top
    // of the others. isCurrent lets the wait give up as soon as this graph
    // is no longer the one on screen, instead of polling a destroyed cy for
    // the rest of the 10 frames.
    static async _waitForSizes(cy, isCurrent) {
        for (let i = 0; i < 10; i++) {
            await FootprintManager._nextFrame();
            if (!isCurrent()) return false;
            if (cy.nodes().every(n => n.outerWidth() > 0 && n.outerHeight() > 0)) return true;
        }
        return false;
    }

    // Drops the caches Cytoscape keeps on the style of the tables: one whose
    // size was still zero when the graph was created is left out of the hit
    // test, and would not even be clickable. The renderer rebuilds them at
    // the next frame.
    static _refreshHitTest(cy) {
        cy.nodes().dirtyStyleCache();
        const renderer = cy.renderer();
        if (renderer && typeof renderer.invalidateCachedZSortedEles === 'function') {
            renderer.invalidateCachedZSortedEles();
        }
    }

    // 'dbo.trg_Inventory_LowStock' -> 'trg_Inventory_LowStock', for a trigger-cascade
    // edge label that doesn't repeat the schema already shown on both endpoints.
    static _shortName(qualifiedName) {
        const s = String(qualifiedName || '');
        return s.includes('.') ? s.slice(s.indexOf('.') + 1) : s;
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
            { selector: 'node[?conditional]', style: { 'border-width': 2, 'border-style': 'dotted', 'border-color': '#fff' } },
            // Box-select feedback (the zoom toolbar's Fit button zooms to this).
            { selector: 'node:selected', style: { 'overlay-color': '#ffffff', 'overlay-opacity': 0.18, 'overlay-padding': 6 } },
            { selector: 'edge', style: { 'curve-style': 'bezier', 'width': 1.5, 'target-arrow-shape': 'triangle', 'arrow-scale': 0.9 } },
            { selector: 'edge[edge = "fk"]', style: { 'line-color': '#8892a0', 'target-arrow-color': '#8892a0' } },
            { selector: 'edge[edge = "access-write"]', style: { 'line-color': '#c0392b', 'target-arrow-color': '#c0392b', 'width': 2 } },
            { selector: 'edge[edge = "access-read"]', style: { 'line-color': '#6b7684', 'target-arrow-color': '#6b7684', 'line-style': 'dashed' } },
            { selector: 'edge[edge = "access-possible"]', style: { 'line-color': '#8892a0', 'line-style': 'dotted', 'target-arrow-shape': 'none', 'opacity': 0.7 } },
            { selector: 'edge[edge = "access-trigger"]', style: {
                'line-color': '#e8a33d', 'target-arrow-color': '#e8a33d', 'line-style': 'dashed', 'width': 2,
                'label': 'data(label)', 'font-size': 9, 'color': '#e8a33d',
                'text-background-color': '#1e1e1e', 'text-background-opacity': 0.85, 'text-background-padding': 2
            } }
        ];
    }

    static _queryGraphStyle() {
        const node = (bg) => ({
            'background-color': bg, 'label': 'data(label)', 'color': '#fff',
            'font-size': 11, 'text-valign': 'center', 'text-halign': 'center',
            'text-wrap': 'wrap', 'text-max-width': 160, 'width': 'label', 'height': 'label',
            'padding': '8px', 'shape': 'round-rectangle', 'text-outline-width': 0
        });
        return [
            { selector: 'node[kind = "direct"]', style: { ...node('#0e639c'), 'border-width': 2, 'border-color': '#3794ff' } },
            { selector: 'node[kind = "via-code"]', style: { ...node('#7d3c98'), 'border-width': 2, 'border-style': 'dashed', 'border-color': '#c39bd3' } },
            { selector: 'node:selected', style: { 'overlay-color': '#ffffff', 'overlay-opacity': 0.18, 'overlay-padding': 6 } },
            { selector: 'edge', style: {
                'curve-style': 'bezier', 'width': 1.8, 'line-color': '#4a9eda', 'target-arrow-color': '#4a9eda',
                'target-arrow-shape': 'triangle', 'arrow-scale': 0.9,
                'label': 'data(label)', 'font-size': 9, 'color': '#9ecbff',
                // A long condition is wrapped: the gap between two tables is made for
                // this width (see _joinLabelWidth).
                'text-wrap': 'wrap', 'text-max-width': FootprintManager.JOIN_LABEL_MAX_WIDTH,
                'text-background-color': '#1e1e1e', 'text-background-opacity': 0.85, 'text-background-padding': 2
            } },
            // A join whose condition does not qualify its columns: the partner
            // comes from the join order, not from the condition itself.
            { selector: 'edge[confident = 0]', style: { 'line-style': 'dashed', 'line-color': '#8892a0', 'target-arrow-color': '#8892a0' } }
        ];
    }

    static _schemaStyle() {
        const node = (bg, borderColor) => ({
            'background-color': bg, 'border-color': borderColor, 'border-width': 2,
            'label': 'data(label)', 'color': '#e0e6ee', 'font-size': 11, 'line-height': 1.5,
            // Left-justified multi-line label → reads like an entity/table box
            // (name on top, one key column per line) instead of a centred blob.
            'text-valign': 'center', 'text-halign': 'center', 'text-justification': 'left',
            'text-wrap': 'wrap', 'text-max-width': 260,
            'width': 'label', 'height': 'label', 'padding': '10px', 'shape': 'round-rectangle'
        });
        return [
            // Seed: a table actually in the query/footprint. FK/usage neighbors
            // (added by Expand) get their own colors so it stays obvious which
            // is which - solid border for an FK-confirmed relationship, dashed
            // for one only seen in how other code uses these tables together
            // (never drawn with an edge - see _renderSchema).
            { selector: 'node[kind = "seed"]', style: node('#1f3a52', '#3794ff') },
            { selector: 'node[kind = "fk"]', style: node('#2d3340', '#8892a0') },
            { selector: 'node[kind = "usage"]', style: { ...node('#2d3340', '#c39bd3'), 'border-style': 'dashed' } },
            // Added by hand (Add table), not found by Expand.
            { selector: 'node[kind = "added"]', style: node('#2d3340', '#e8a33d') },
            // Box-select feedback (the zoom toolbar's Fit button zooms to this).
            { selector: 'node:selected', style: { 'overlay-color': '#ffffff', 'overlay-opacity': 0.18, 'overlay-padding': 6 } },
            { selector: 'edge', style: {
                'curve-style': 'bezier', 'width': 1.5, 'line-color': '#8892a0',
                'target-arrow-shape': 'triangle', 'target-arrow-color': '#8892a0', 'arrow-scale': 0.9,
                'label': 'data(label)', 'font-size': 9, 'color': '#9aa4b2',
                'text-background-color': '#1e1e1e', 'text-background-opacity': 0.7, 'text-background-padding': 2
            } }
        ];
    }
}

// The widest a join condition gets on a line before it wraps.
FootprintManager.JOIN_LABEL_MAX_WIDTH = 200;

// Separates a schema node's table-name header from its PK/FK column list.
FootprintManager.SCHEMA_SEPARATOR = '─'.repeat(18);

// The ELK engine that places the tables of the Schema tab, and the load of
// its script (once per page) - see _loadElk.
FootprintManager._elk = null;
FootprintManager._elkLoading = null;

// cy.fit()'s own zoom level, past which a node reads as oversized rather
// than simply "fit to the pane" - see _fitCapped.
FootprintManager.FIT_ZOOM_CAP = 1.4;

// Allow unit tests to require() this file; in the webview `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = FootprintManager;
}
