// The Compare tab: the database the queries run on against a reference (a
// snapshot of it, or another database), what changed, and the re-entrant
// script of the changes that are picked. Nothing is ever run from here: the
// script goes to the editor, to be read first.

const COMPARE_GROUPS = [
    { kind: 'schema', label: 'Schemas' },
    { kind: 'table', label: 'Tables' },
    { kind: 'view', label: 'Views' },
    { kind: 'function', label: 'Functions' },
    { kind: 'procedure', label: 'Procedures' },
    { kind: 'trigger', label: 'Triggers' }
];
const COMPARE_RISKS = ['safe', 'caution', 'destructive', 'manual'];
const COMPARE_STATUS = {
    added: { icon: 'diff-added', title: 'Added since the reference' },
    removed: { icon: 'diff-removed', title: 'Removed since the reference' },
    modified: { icon: 'diff-modified', title: 'Modified since the reference' }
};
const COMPARE_RISK_TITLE = {
    caution: 'Can fail on the data that is there, or loses something that is not data',
    destructive: 'Loses data: left out of the script unless destructive changes are included',
    manual: 'Cannot be done in place: left out of the script'
};

class CompareManager {
    constructor() {
        this.el = {
            reference: document.getElementById('compareReference'),
            run: document.getElementById('compareRunBtn'),
            snapshot: document.getElementById('compareSnapshotBtn'),
            dropSnapshot: document.getElementById('compareDropSnapshotBtn'),
            note: document.getElementById('compareNote'),
            empty: document.getElementById('compareEmpty'),
            result: document.getElementById('compareResult'),
            summary: document.getElementById('compareSummary'),
            filter: document.getElementById('compareFilter'),
            list: document.getElementById('compareList'),
            detail: document.getElementById('compareDetail'),
            footer: document.getElementById('compareFooter'),
            destructive: document.getElementById('compareDestructive'),
            target: document.getElementById('compareTarget'),
            selected: document.getElementById('compareSelected'),
            script: document.getElementById('compareScriptBtn'),
            apply: document.getElementById('compareApplyBtn'),
            overlay: document.getElementById('compareApplyOverlay'),
            applyConnection: document.getElementById('compareApplyConnection'),
            applyDatabase: document.getElementById('compareApplyDatabase'),
            applyStatus: document.getElementById('compareApplyStatus'),
            applyProgress: document.getElementById('compareApplyProgress'),
            applyBar: document.getElementById('compareApplyBar'),
            applyProgressText: document.getElementById('compareApplyProgressText'),
            applyResult: document.getElementById('compareApplyResult'),
            applyStop: document.getElementById('compareApplyStopBtn'),
            applyRun: document.getElementById('compareApplyRunBtn'),
            applyClose: document.getElementById('compareApplyCloseBtn')
        };
        this.applying = false;
        this.targetReady = false;
        this.mode = 'ref';
        this.modeRef = document.getElementById('compareModeRef');
        this.modeRecent = document.getElementById('compareModeRecent');
        this.refView = document.getElementById('compareRefView');
        this.recentView = document.getElementById('compareRecentView');
        this.modeRef.addEventListener('click', () => this.setMode('ref'));
        this.modeRecent.addEventListener('click', () => this.setMode('recent'));
        this.database = null;     // the database the sources were listed for
        this.sources = null;
        this.result = null;       // { database, reference, diff, ... }
        this.selected = new Set();
        this.active = null;       // the id of the change shown on the right
        this.filter = '';
        this.running = false;
        this.chosen = new Map();  // database -> the reference picked last

        this.el.reference.addEventListener('change', () => {
            this.chosen.set(this.database, this.el.reference.value);
            this.el.reference.title = this.el.reference.selectedOptions[0] ? this.el.reference.selectedOptions[0].textContent : '';
            this.updateButtons();
        });
        this.el.run.addEventListener('click', () => this.compare());
        this.el.snapshot.addEventListener('click', () => vscode.postMessage({ command: 'takeSnapshot', database: this.database }));
        this.el.dropSnapshot.addEventListener('click', () => vscode.postMessage({ command: 'dropSnapshot', database: this.database, name: this.el.reference.value }));
        this.el.filter.addEventListener('input', () => { this.filter = this.el.filter.value.trim().toLowerCase(); this.renderList(); });
        this.el.destructive.addEventListener('change', () => this.renderFooter());
        this.el.script.addEventListener('click', () => this.buildScript());
        this.el.list.addEventListener('click', (e) => {
            const row = e.target.closest('.compare-row');
            if (!row) return;
            if (e.target.closest('input[type="checkbox"]')) {
                if (e.target.checked) this.selected.add(row.dataset.id); else this.selected.delete(row.dataset.id);
                this.renderFooter();
                return;
            }
            this.show(row.dataset.id);
        });
        this.el.list.addEventListener('keydown', (e) => this.onListKey(e));

        this.el.apply.addEventListener('click', () => this.openApply());
        this.el.applyClose.addEventListener('click', () => this.closeApply());
        this.el.overlay.addEventListener('click', (e) => { if (e.target === this.el.overlay) this.closeApply(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.el.overlay.classList.contains('visible')) this.closeApply(); });
        this.el.applyConnection.addEventListener('change', () => this.requestTargetDatabases());
        this.el.applyDatabase.addEventListener('change', () => this.requestTargetStatus());
        this.el.applyRun.addEventListener('click', () => this.runApply());
        this.el.applyStop.addEventListener('click', () => vscode.postMessage({ command: 'cancelApplyCompare' }));
    }

    // The tab shows one of two views: the comparison with a reference, or what was modified lately.
    setMode(mode) {
        this.mode = mode;
        this.modeRef.classList.toggle('active', mode === 'ref');
        this.modeRef.setAttribute('aria-selected', String(mode === 'ref'));
        this.modeRecent.classList.toggle('active', mode === 'recent');
        this.modeRecent.setAttribute('aria-selected', String(mode === 'recent'));
        this.refView.hidden = mode !== 'ref';
        this.recentView.hidden = mode !== 'recent';
        if (mode === 'recent' && window.recentChanges) window.recentChanges.onActivated(this.database);
    }

    // === Pure helpers (also used by the tests) ==============================

    static idOf(change) { return `${change.kind}:${change.name}`; }

    static worstRisk(ops) {
        return ops.reduce((worst, op) => (COMPARE_RISKS.indexOf(op.risk) > COMPARE_RISKS.indexOf(worst) ? op.risk : worst), 'safe');
    }

    // The changes by kind, those that match the filter, and a count per group.
    static group(changes, filter) {
        return COMPARE_GROUPS
            .map(group => ({ ...group, changes: changes.filter(c => c.kind === group.kind && (!filter || c.name.toLowerCase().includes(filter))) }))
            .filter(group => group.changes.length > 0);
    }

    static columns(list) { return list.map(c => `${c.name}${c.desc ? ' DESC' : ''}`).join(', '); }

    static describeColumn(c) {
        if (c.computed) return `${c.name} AS ${c.computed.definition}${c.computed.persisted ? ' PERSISTED' : ''}`;
        let text = `${c.name} ${c.type}`;
        if (c.collation) text += ` COLLATE ${c.collation}`;
        if (c.identity) text += ` IDENTITY(${c.identity.seed},${c.identity.increment})`;
        text += c.nullable ? ' NULL' : ' NOT NULL';
        if (c.default) text += ` DEFAULT ${c.default.definition}`;
        return text;
    }

    static describeKey(key) { return `(${CompareManager.columns(key.columns)})${key.clustered ? ' clustered' : ''}`; }

    static describeIndex(ix) {
        return `${ix.unique ? 'unique ' : ''}${ix.name} (${CompareManager.columns(ix.columns)})${ix.included.length ? ` INCLUDE (${ix.included.join(', ')})` : ''}${ix.filter ? ` WHERE ${ix.filter}` : ''}${ix.disabled ? ' (disabled)' : ''}`;
    }

    static describeForeignKey(fk) {
        const action = a => String(a).replace(/_/g, ' ');
        return `${fk.systemNamed ? '' : `${fk.name} `}(${fk.columns.join(', ')}) → ${fk.refSchema}.${fk.refTable} (${fk.refColumns.join(', ')})${fk.onDelete !== 'NO_ACTION' ? ` ON DELETE ${action(fk.onDelete)}` : ''}${fk.onUpdate !== 'NO_ACTION' ? ` ON UPDATE ${action(fk.onUpdate)}` : ''}`;
    }

    // One operation of a table change, as a line: + added, − removed, ~ changed.
    static describeOp(op) {
        const d = CompareManager;
        switch (op.op) {
            case 'addColumn': return { sign: '+', text: `column ${d.describeColumn(op.column)}`, note: op.needsDefault ? 'NOT NULL with no default: fails if the table has rows' : '' };
            case 'dropColumn': return { sign: '−', text: `column ${op.column.name}`, note: '' };
            case 'alterColumn': {
                const parts = op.changes.map(what => {
                    if (what === 'type') return `${op.from.type} → ${op.to.type}`;
                    if (what === 'nullable') return `${op.from.nullable ? 'NULL' : 'NOT NULL'} → ${op.to.nullable ? 'NULL' : 'NOT NULL'}`;
                    if (what === 'collation') return `collation ${op.from.collation || '(database)'} → ${op.to.collation || '(database)'}`;
                    if (what === 'identity') return `identity ${op.from.identity ? `(${op.from.identity.seed},${op.from.identity.increment})` : 'none'} → ${op.to.identity ? `(${op.to.identity.seed},${op.to.identity.increment})` : 'none'}`;
                    return 'computed expression';
                });
                return { sign: '~', text: `column ${op.name}: ${parts.join(', ')}`, note: '' };
            }
            case 'addDefault': return { sign: '+', text: `default on ${op.column}: ${op.default.definition}`, note: '' };
            case 'dropDefault': return { sign: '−', text: `default on ${op.column}`, note: '' };
            case 'alterDefault': return { sign: '~', text: `default on ${op.column}: ${op.from.definition} → ${op.to.definition}`, note: '' };
            case 'addPrimaryKey': return { sign: '+', text: `primary key ${d.describeKey(op.primaryKey)}`, note: '' };
            case 'dropPrimaryKey': return { sign: '−', text: `primary key ${d.describeKey(op.primaryKey)}`, note: '' };
            case 'alterPrimaryKey': return { sign: '~', text: `primary key ${d.describeKey(op.from)} → ${d.describeKey(op.to)}`, note: '' };
            case 'addUnique': return { sign: '+', text: `unique ${op.unique.systemNamed ? '' : `${op.unique.name} `}${d.describeKey(op.unique)}`, note: '' };
            case 'dropUnique': return { sign: '−', text: `unique ${op.unique.systemNamed ? '' : `${op.unique.name} `}${d.describeKey(op.unique)}`, note: '' };
            case 'alterUnique': return { sign: '~', text: `unique ${op.to.name} ${d.describeKey(op.from)} → ${d.describeKey(op.to)}`, note: '' };
            case 'addIndex': return { sign: '+', text: `index ${d.describeIndex(op.index)}`, note: '' };
            case 'dropIndex': return { sign: '−', text: `index ${d.describeIndex(op.index)}`, note: '' };
            case 'alterIndex': return { sign: '~', text: `index ${d.describeIndex(op.from)} → ${d.describeIndex(op.to)}`, note: '' };
            case 'addForeignKey': return { sign: '+', text: `foreign key ${d.describeForeignKey(op.foreignKey)}`, note: '' };
            case 'dropForeignKey': return { sign: '−', text: `foreign key ${d.describeForeignKey(op.foreignKey)}`, note: '' };
            case 'alterForeignKey': return { sign: '~', text: `foreign key ${d.describeForeignKey(op.from)} → ${d.describeForeignKey(op.to)}`, note: '' };
            case 'addCheck': return { sign: '+', text: `check ${op.check.systemNamed ? '' : `${op.check.name} `}${op.check.definition}`, note: '' };
            case 'dropCheck': return { sign: '−', text: `check ${op.check.systemNamed ? '' : `${op.check.name} `}${op.check.definition}`, note: '' };
            case 'alterCheck': return { sign: '~', text: `check ${op.to.name}: ${op.from.definition} → ${op.to.definition}`, note: '' };
            case 'createSchema': return { sign: '+', text: 'schema', note: '' };
            case 'dropSchema': return { sign: '−', text: 'schema', note: '' };
            case 'createTable': return { sign: '+', text: 'table', note: '' };
            case 'dropTable': return { sign: '−', text: 'table', note: '' };
            case 'createModule': return { sign: '+', text: 'definition', note: '' };
            case 'dropModule': return { sign: '−', text: 'definition', note: '' };
            case 'recreate': return { sign: '~', text: 'moved to another table: dropped and created again', note: '' };
            case 'alter': return { sign: '~', text: op.what.map(w => (w === 'definition' ? 'definition' : w === 'options' ? 'SET options' : w === 'disabled' ? 'enabled or disabled' : w)).join(', '), note: '' };
            default: return { sign: '~', text: op.op, note: '' };
        }
    }

    // The lines that show a whole table (one that is added or removed).
    static describeTable(table) {
        const d = CompareManager;
        const lines = table.columns.map(c => `column ${d.describeColumn(c)}`);
        if (table.primaryKey) lines.push(`primary key ${d.describeKey(table.primaryKey)}`);
        table.uniques.forEach(u => lines.push(`unique ${u.systemNamed ? '' : `${u.name} `}${d.describeKey(u)}`));
        table.indexes.forEach(ix => lines.push(`index ${d.describeIndex(ix)}`));
        table.foreignKeys.forEach(fk => lines.push(`foreign key ${d.describeForeignKey(fk)}`));
        table.checks.forEach(ck => lines.push(`check ${ck.systemNamed ? '' : `${ck.name} `}${ck.definition}`));
        return lines;
    }

    static notComparedText(counts) {
        const labels = { synonyms: 'synonym', sequences: 'sequence', userTypes: 'user type', clrObjects: 'CLR object', ddlTriggers: 'DDL trigger', otherIndexes: 'columnstore/XML/hash index', partitionedTables: 'partitioned table', temporalTables: 'temporal table', memoryOptimizedTables: 'memory-optimized table' };
        return Object.entries(counts || {}).map(([kind, n]) => `${n} ${labels[kind] || kind}${n > 1 ? 's' : ''}`).join(', ');
    }

    // === Sources and the comparison =========================================

    onActivated() {
        const database = window.queryManager ? window.queryManager.targetDatabase() : appState.currentDatabase;
        if (database !== this.database) {
            this.database = database;
            this.result = null;
            this.sources = null;
            this.renderResult();
            this.setNote('');
            // The snapshots of the other database are not periods of this one.
            if (window.recentChanges) window.recentChanges.setSnapshots([]);
        }
        vscode.postMessage({ command: 'getCompareSources', database: database || null });
        if (this.mode === 'recent' && window.recentChanges) window.recentChanges.onActivated(database);
    }

    // The database of the tab changed while the Compare tab is showing: what it lists is for the other one.
    onDatabaseChanged() {
        if (appState.activeTab === 'compare' && !this.applying) this.onActivated();
    }

    // A new connection: what was listed belongs to the previous one.
    reset() {
        this.database = null;
        this.sources = null;
        this.result = null;
        this.chosen = new Map();
        this.renderSources();
        this.renderResult();
        this.setNote('');
        if (window.recentChanges) window.recentChanges.setSnapshots([]);
    }

    onSources(message) {
        if (message.database !== this.database) return;
        this.sources = message;
        this.renderSources();
        if (window.recentChanges) window.recentChanges.setSnapshots(message.snapshots);
    }

    renderSources() {
        const select = this.el.reference;
        const kept = this.chosen.get(this.database) || select.value;
        select.textContent = '';
        const sources = this.sources;
        if (sources) {
            const add = (parent, value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; parent.appendChild(o); };
            if (sources.snapshots.length > 0) {
                const group = document.createElement('optgroup');
                group.label = `Snapshots of ${sources.database}`;
                sources.snapshots.forEach(s => add(group, s.name, `${s.name}  (${new Date(s.createDate).toLocaleString()})`));
                select.appendChild(group);
            }
            if (sources.databases.length > 0) {
                const group = document.createElement('optgroup');
                group.label = 'Other databases';
                sources.databases.forEach(name => add(group, name, name));
                select.appendChild(group);
            }
            const values = [...select.querySelectorAll('option')].map(o => o.value);
            if (values.includes(kept)) select.value = kept;
            else if (sources.snapshots.length > 0) select.value = sources.snapshots[0].name;
        }
        // The whole name, when the field is too narrow to show it.
        select.title = select.selectedOptions[0] ? select.selectedOptions[0].textContent : '';
        if (!select.firstChild) {
            const o = document.createElement('option');
            o.value = '';
            o.textContent = this.database ? 'No snapshot yet: take one' : 'Select a database first';
            select.appendChild(o);
        }
        this.updateButtons();
    }

    isSnapshot(name) {
        return !!(this.sources && this.sources.snapshots.some(s => s.name === name));
    }

    updateButtons() {
        const reference = this.el.reference.value;
        const support = this.sources && this.sources.support;
        this.el.run.disabled = !reference || this.running;
        this.el.snapshot.disabled = !support || !support.supported || this.running;
        this.el.snapshot.title = support && !support.supported ? support.reason : `Take a snapshot of ${this.database || 'the database'} now, to compare with it later`;
        this.el.dropSnapshot.hidden = !this.isSnapshot(reference);
        this.el.dropSnapshot.disabled = this.running;
    }

    setNote(text, kind = '') {
        this.el.note.textContent = text;
        this.el.note.className = `compare-note${kind ? ` ${kind}` : ''}`;
    }

    compare() {
        const reference = this.el.reference.value;
        if (!reference || !this.database) return;
        this.running = true;
        this.updateButtons();
        this.setNote(`Reading ${reference} and ${this.database}…`);
        vscode.postMessage({ command: 'runCompare', database: this.database, reference });
    }

    onFailed(message) {
        this.running = false;
        this.updateButtons();
        this.setNote(message.message, 'error');
        // A failure while the apply dialog is open belongs to it too.
        if (this.el.overlay.classList.contains('visible')) {
            this.applying = false;
            this.el.applyProgress.hidden = true;
            this.setApplyStatus(message.message, 'error');
            this.updateApplyButtons();
        }
    }

    onResult(message) {
        this.running = false;
        this.result = message;
        this.selected = new Set(message.diff.changes.map(CompareManager.idOf));
        this.active = message.diff.changes.length > 0 ? CompareManager.idOf(message.diff.changes[0]) : null;
        this.filter = '';
        this.el.filter.value = '';
        // Before 2016 SP1 there is no CREATE OR ALTER: the script is told which to write.
        this.el.target.value = message.createOrAlter ? 'modern' : 'legacy';
        this.updateButtons();
        this.setNote(`Compared in ${(message.durationMs / 1000).toFixed(1)} s.`, 'success');
        this.renderResult();
    }

    onSnapshotDone(message) {
        this.setNote(`Snapshot ${message.name} ${message.action}.`, 'success');
        // The snapshot that was just taken is the reference to compare with: it is picked
        // when the list comes back, so its name stays in the field.
        if (message.action === 'taken') this.chosen.set(this.database, message.name);
    }

    // === The result =========================================================

    renderResult() {
        const result = this.result;
        this.el.empty.hidden = !!result;
        this.el.result.hidden = !result;
        this.el.footer.hidden = !result || result.diff.identical;
        if (!result) return;

        const { diff } = result;
        const summary = this.el.summary;
        summary.textContent = '';
        const heading = document.createElement('div');
        heading.className = 'compare-heading';
        heading.textContent = `${result.reference} → ${result.database}`;
        summary.appendChild(heading);
        const counts = document.createElement('div');
        counts.className = 'compare-counts';
        counts.textContent = diff.identical
            ? 'Identical.'
            : `${diff.summary.added} added · ${diff.summary.modified} modified · ${diff.summary.removed} removed`;
        summary.appendChild(counts);
        const notCompared = [CompareManager.notComparedText(diff.notCompared.reference), CompareManager.notComparedText(diff.notCompared.current)].filter(Boolean);
        if (notCompared.length > 0) {
            const note = document.createElement('div');
            note.className = 'compare-skipped';
            note.textContent = `Not compared: ${notCompared[notCompared.length - 1]}`;
            note.title = 'Present in the database, and not part of the comparison';
            summary.appendChild(note);
        }
        if (diff.skipped.length > 0) {
            const note = document.createElement('div');
            note.className = 'compare-skipped';
            note.textContent = `${diff.skipped.length} definition(s) cannot be read (encrypted, or VIEW DEFINITION is missing)`;
            note.title = diff.skipped.map(s => s.name).join('\n');
            summary.appendChild(note);
        }
        this.renderList();
        this.renderFooter();
        this.renderDetail();
    }

    renderList() {
        const list = this.el.list;
        list.textContent = '';
        if (!this.result) return;
        const groups = CompareManager.group(this.result.diff.changes, this.filter);
        if (groups.length === 0) {
            const p = document.createElement('p');
            p.className = 'placeholder-text';
            p.textContent = this.result.diff.identical ? 'Nothing differs.' : 'Nothing matches the filter.';
            list.appendChild(p);
            return;
        }
        for (const group of groups) {
            const header = document.createElement('div');
            header.className = 'compare-group';
            header.textContent = `${group.label} (${group.changes.length})`;
            list.appendChild(header);
            for (const change of group.changes) list.appendChild(this.rowNode(change));
        }
    }

    rowNode(change) {
        const id = CompareManager.idOf(change);
        const row = document.createElement('div');
        row.className = `compare-row${id === this.active ? ' active' : ''}`;
        row.dataset.id = id;
        row.tabIndex = -1;
        row.setAttribute('role', 'treeitem');

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = this.selected.has(id);
        box.setAttribute('aria-label', `Include ${change.name}`);
        row.appendChild(box);

        const status = COMPARE_STATUS[change.status];
        const icon = document.createElement('i');
        icon.className = `codicon codicon-${status.icon} compare-status ${change.status}`;
        icon.title = status.title;
        row.appendChild(icon);

        const name = document.createElement('span');
        name.className = 'compare-name';
        name.textContent = change.name;
        row.appendChild(name);

        const risk = CompareManager.worstRisk(change.ops);
        if (risk !== 'safe') {
            const badge = document.createElement('span');
            badge.className = `compare-risk ${risk}`;
            badge.textContent = risk;
            badge.title = COMPARE_RISK_TITLE[risk];
            row.appendChild(badge);
        }
        return row;
    }

    onListKey(event) {
        const rows = [...this.el.list.querySelectorAll('.compare-row')];
        const row = event.target.closest && event.target.closest('.compare-row');
        if (rows.length === 0) return;
        const index = row ? rows.indexOf(row) : -1;
        let target = null;
        if (event.key === 'ArrowDown') target = rows[Math.min(index + 1, rows.length - 1)];
        else if (event.key === 'ArrowUp') target = rows[Math.max(index - 1, 0)];
        else if (event.key === 'Home') target = rows[0];
        else if (event.key === 'End') target = rows[rows.length - 1];
        else if (event.key === ' ' && row && event.target === row) {
            const id = row.dataset.id;
            if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
            row.querySelector('input').checked = this.selected.has(id);
            this.renderFooter();
        } else return;
        event.preventDefault();
        if (target) { this.show(target.dataset.id); target.focus(); target.scrollIntoView({ block: 'nearest' }); }
    }

    show(id) {
        this.active = id;
        this.el.list.querySelectorAll('.compare-row.active').forEach(r => r.classList.remove('active'));
        const row = [...this.el.list.querySelectorAll('.compare-row')].find(r => r.dataset.id === id);
        if (row) row.classList.add('active');
        this.renderDetail();
    }

    // === The detail =========================================================

    renderDetail() {
        const detail = this.el.detail;
        detail.textContent = '';
        const change = this.result && this.result.diff.changes.find(c => CompareManager.idOf(c) === this.active);
        if (!change) {
            const p = document.createElement('p');
            p.className = 'placeholder-text';
            p.textContent = this.result && !this.result.diff.identical ? 'Pick a change to see it.' : '';
            detail.appendChild(p);
            return;
        }
        const title = document.createElement('div');
        title.className = 'compare-detail-title';
        title.textContent = `${change.kind} ${change.name} — ${change.status}`;
        detail.appendChild(title);

        if (change.kind === 'table') this.renderTableDetail(detail, change);
        else if (change.kind === 'schema') this.renderLines(detail, change.ops.map(op => ({ ...CompareManager.describeOp(op), risk: op.risk })));
        else this.renderModuleDetail(detail, change);
    }

    renderLines(parent, lines) {
        const box = document.createElement('div');
        box.className = 'compare-ops';
        for (const line of lines) {
            const el = document.createElement('div');
            el.className = `compare-op ${line.sign === '+' ? 'add' : line.sign === '−' ? 'del' : 'mod'}`;
            const sign = document.createElement('span');
            sign.className = 'compare-sign';
            sign.textContent = line.sign;
            el.appendChild(sign);
            const text = document.createElement('span');
            text.className = 'compare-op-text';
            text.textContent = line.text;
            el.appendChild(text);
            if (line.risk && line.risk !== 'safe') {
                const badge = document.createElement('span');
                badge.className = `compare-risk ${line.risk}`;
                badge.textContent = line.risk;
                badge.title = COMPARE_RISK_TITLE[line.risk];
                el.appendChild(badge);
            }
            if (line.note) {
                const note = document.createElement('span');
                note.className = 'compare-op-note';
                note.textContent = line.note;
                el.appendChild(note);
            }
            box.appendChild(el);
        }
        parent.appendChild(box);
    }

    renderTableDetail(parent, change) {
        if (change.status === 'added') this.renderLines(parent, CompareManager.describeTable(change.current).map(text => ({ sign: '+', text })));
        else if (change.status === 'removed') this.renderLines(parent, CompareManager.describeTable(change.reference).map(text => ({ sign: '−', text })));
        else this.renderLines(parent, change.ops.map(op => ({ ...CompareManager.describeOp(op), risk: op.risk })));
    }

    renderModuleDetail(parent, change) {
        const op = change.ops[0];
        if (change.status === 'modified') this.renderLines(parent, [{ ...CompareManager.describeOp(op), risk: op.risk }]);
        const before = change.status === 'added' ? '' : LineDiff.normalize(change.reference.definition);
        const after = change.status === 'removed' ? '' : LineDiff.normalize(change.current.definition);
        if ((change.reference && change.reference.definition === null) || (change.current && change.current.definition === null)) {
            const p = document.createElement('p');
            p.className = 'placeholder-text';
            p.textContent = 'The definition cannot be read (encrypted, or VIEW DEFINITION is missing).';
            parent.appendChild(p);
            return;
        }
        if (change.status === 'modified' && before === after) return;
        const lines = LineDiff.diff(before, after);
        const code = document.createElement('div');
        code.className = 'compare-code';
        for (const part of LineDiff.hunks(lines, change.status === 'modified' ? 3 : lines.length)) {
            if (part.gap !== undefined) {
                const gap = document.createElement('div');
                gap.className = 'compare-gap';
                gap.textContent = `… ${part.gap} unchanged line${part.gap > 1 ? 's' : ''}`;
                code.appendChild(gap);
                continue;
            }
            for (const line of part.lines) {
                const el = document.createElement('div');
                el.className = `compare-line ${line.type}`;
                const number = document.createElement('span');
                number.className = 'compare-lineno';
                number.textContent = String(line.type === 'del' ? line.oldLine : line.newLine);
                el.appendChild(number);
                const sign = document.createElement('span');
                sign.className = 'compare-sign';
                sign.textContent = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ';
                el.appendChild(sign);
                const text = document.createElement('span');
                text.className = 'compare-line-text';
                text.textContent = line.text;
                el.appendChild(text);
                code.appendChild(el);
            }
        }
        parent.appendChild(code);
    }

    // === The script =========================================================

    renderFooter() {
        if (!this.result) return;
        const changes = this.result.diff.changes;
        const picked = changes.filter(c => this.selected.has(CompareManager.idOf(c)));
        const left = this.el.destructive.checked ? 0 : picked.reduce((n, c) => n + c.ops.filter(op => op.risk === 'destructive').length, 0);
        const manual = picked.reduce((n, c) => n + c.ops.filter(op => op.risk === 'manual').length, 0);
        const parts = [`${picked.length} of ${changes.length} selected`];
        if (left > 0) parts.push(`${left} destructive step(s) left out`);
        if (manual > 0) parts.push(`${manual} to do by hand`);
        this.el.selected.textContent = parts.join(' · ');
        this.el.script.disabled = picked.length === 0;
        this.el.apply.disabled = picked.length === 0;
    }

    // What the footer says is wanted: the changes picked, and how to write them.
    choice() {
        return { ids: [...this.selected], allowDestructive: this.el.destructive.checked, legacy: this.el.target.value === 'legacy' };
    }

    buildScript() {
        vscode.postMessage({ command: 'buildCompareScript', ...this.choice() });
    }

    // === Applying ===========================================================

    openApply() {
        if (!this.result) return;
        this.el.overlay.classList.add('visible');
        this.applying = false;
        this.targetReady = false;
        this.el.applyResult.hidden = true;
        this.el.applyResult.textContent = '';
        this.el.applyProgress.hidden = true;
        this.setApplyStatus('Pick where to apply the script. Nothing is run before you confirm.');
        this.updateApplyButtons();
        vscode.postMessage({ command: 'getCompareTargets' });
        this.requestTargetDatabases();
    }

    closeApply() {
        if (this.applying) return;
        this.el.overlay.classList.remove('visible');
    }

    setApplyStatus(text, kind = '') {
        this.el.applyStatus.textContent = text;
        this.el.applyStatus.className = `compare-apply-status${kind ? ` ${kind}` : ''}`;
    }

    updateApplyButtons() {
        this.el.applyConnection.disabled = this.applying;
        this.el.applyDatabase.disabled = this.applying;
        this.el.applyRun.disabled = this.applying || !this.targetReady;
        this.el.applyStop.hidden = !this.applying;
        this.el.applyClose.disabled = this.applying;
    }

    onTargets(message) {
        const select = this.el.applyConnection;
        const kept = select.value;
        select.textContent = '';
        const add = (value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; select.appendChild(o); };
        add('', `This connection (${message.own.server})`);
        message.connections.forEach(c => add(c.name, `${c.name} (${c.server})`));
        if ([...select.options].some(o => o.value === kept)) select.value = kept;
    }

    requestTargetDatabases() {
        this.targetReady = false;
        this.el.applyDatabase.textContent = '';
        const o = document.createElement('option');
        o.value = '';
        o.textContent = 'Loading…';
        this.el.applyDatabase.appendChild(o);
        this.setApplyStatus(this.el.applyConnection.value ? `Connecting to ${this.el.applyConnection.value}…` : 'Listing the databases…');
        this.updateApplyButtons();
        vscode.postMessage({ command: 'getCompareTargetDatabases', connection: this.el.applyConnection.value || null });
    }

    onTargetDatabases(message) {
        if ((message.connection || '') !== this.el.applyConnection.value) return;
        const select = this.el.applyDatabase;
        select.textContent = '';
        const add = (value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; select.appendChild(o); };
        add('', message.databases.length > 0 ? 'Pick a database' : 'No database');
        message.databases.forEach(name => add(name, name));
        this.setApplyStatus(message.message || (message.databases.length > 0 ? 'Pick the database to apply the script on.' : 'There is no database to apply it on.'), message.message ? 'error' : '');
    }

    requestTargetStatus() {
        this.targetReady = false;
        this.updateApplyButtons();
        const database = this.el.applyDatabase.value;
        if (!database) { this.setApplyStatus('Pick the database to apply the script on.'); return; }
        this.setApplyStatus('Reading the database…');
        vscode.postMessage({ command: 'getCompareTargetStatus', ...this.choice(), connection: this.el.applyConnection.value || null, database });
    }

    // Where the target stands against the changes, in a few lines.
    static statusLines(message) {
        const { counts } = message;
        const lines = [`${counts.pending} to do · ${counts.done} already as in the current database · ${counts.differs} partly done or different from the reference`];
        if (counts.differs > 0) lines.push(`Partly done or different: ${message.differs.join(', ')}${counts.differs > message.differs.length ? ', …' : ''}. The script finishes what is half done, and overwrites what is different.`);
        lines.push(`${message.steps} step(s) for SQL Server ${message.serverVersion}${message.createOrAlter ? '' : ' (before 2016 SP1: no CREATE OR ALTER)'}.`);
        if (message.skipped > 0) lines.push(`${message.skipped} step(s) left out: ${message.skippedReason}`);
        message.warnings.forEach(w => lines.push(w));
        return lines;
    }

    onTargetStatus(message) {
        if ((message.connection || '') !== this.el.applyConnection.value || message.database !== this.el.applyDatabase.value) return;
        this.el.applyStatus.textContent = '';
        this.el.applyStatus.className = 'compare-apply-status';
        for (const line of CompareManager.statusLines(message)) {
            const p = document.createElement('div');
            p.textContent = line;
            this.el.applyStatus.appendChild(p);
        }
        this.targetReady = message.steps > 0;
        if (message.steps === 0) this.setApplyStatus('Nothing to apply for the changes that are picked.', 'error');
        this.updateApplyButtons();
    }

    runApply() {
        this.applying = true;
        this.el.applyResult.hidden = true;
        this.el.applyProgress.hidden = false;
        this.el.applyBar.removeAttribute('value');
        this.el.applyProgressText.textContent = 'Waiting for your confirmation…';
        this.updateApplyButtons();
        vscode.postMessage({ command: 'applyCompare', ...this.choice(), connection: this.el.applyConnection.value || null, database: this.el.applyDatabase.value });
    }

    onApplyDeclined() {
        this.applying = false;
        this.el.applyProgress.hidden = true;
        this.updateApplyButtons();
    }

    onApplyProgress(message) {
        if (!message.total) return;
        this.el.applyBar.max = message.total;
        this.el.applyBar.value = message.done;
        this.el.applyProgressText.textContent = `${message.done} of ${message.total} batches`;
    }

    // What came of it: what ran, the errors, and what still differs on the target.
    static resultLines(message) {
        const lines = [];
        const seconds = (message.durationMs / 1000).toFixed(1);
        if (message.errors.length === 0 && !message.stopped) lines.push({ kind: 'success', text: `Applied ${message.steps} step(s) in ${seconds} s.` });
        else if (message.stopped) lines.push({ kind: 'error', text: `Stopped after ${message.ran} of ${message.batches} batches. Apply again to finish: the script picks up where it is.` });
        else lines.push({ kind: 'error', text: `The script stopped on an error (${message.ran} of ${message.batches} batches ran). Fix it, then apply again.` });
        message.errors.forEach(e => lines.push({ kind: 'error', text: `Batch ${e.batch}, line ${e.line}: ${e.message}` }));
        if (message.errors.length === 0 && !message.stopped) {
            lines.push(message.remainingCount === 0
                ? { kind: 'success', text: 'The database now is as the current one for the changes that were picked.' }
                : { kind: 'warn', text: `Still different on the database: ${message.remaining.join(', ')}${message.remainingCount > message.remaining.length ? ', …' : ''}${message.leftOut > 0 ? ' (the steps that were left out are among them)' : ''}.` });
        }
        return lines;
    }

    onApplied(message) {
        this.applying = false;
        this.targetReady = false;
        this.el.applyProgress.hidden = true;
        this.el.applyResult.hidden = false;
        this.el.applyResult.textContent = '';
        for (const line of CompareManager.resultLines(message)) {
            const el = document.createElement('div');
            el.className = `compare-apply-line ${line.kind}`;
            el.textContent = line.text;
            this.el.applyResult.appendChild(el);
        }
        this.updateApplyButtons();
    }

    onScript(message) {
        if (message.steps === 0) {
            this.setNote(message.skipped.length > 0 ? `Nothing to script: ${message.skipped.length} step(s) left out (${message.skipped[0].reason})` : 'Nothing to script.', 'error');
            return;
        }
        if (window.tabManager) window.tabManager.switchTab('query');
        if (window.queryManager && window.queryManager.openScriptInNewTab) window.queryManager.openScriptInNewTab(message.script);
        else if (window.queryManager) window.queryManager.setQueryText(message.script);
        const extra = [message.skipped.length > 0 ? `${message.skipped.length} left out` : '', message.warnings.length > 0 ? `${message.warnings.length} warning(s), see the comments` : ''].filter(Boolean).join(', ');
        if (window.queryManager) window.queryManager.setStatus(`Script of ${message.steps} step(s) - review it, then run it on the database to change.${extra ? ` (${extra})` : ''}`, '');
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CompareManager };
}
