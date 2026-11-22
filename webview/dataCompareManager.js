// The "Data" mode of the Compare tab: pick tables, compare their rows with a
// reference (a snapshot of this database, or another one), see what was
// added/modified/removed row by row, and get the re-entrant MERGE/DELETE
// script - the data equivalent of CompareManager (webview/compareManager.js).
// Three screens, each needing the one before: the table picker, the result
// (list of differing rows + detail), and the Apply dialog.

const DATA_STATUS = {
    added: { icon: 'diff-added', title: 'Not in the reference' },
    removed: { icon: 'diff-removed', title: 'Not in the current database' },
    modified: { icon: 'diff-modified', title: 'Different from the reference' }
};

class DataCompareManager {
    constructor() {
        this.el = {
            reference: document.getElementById('dataCompareReference'),
            listTables: document.getElementById('dataListTablesBtn'),
            note: document.getElementById('dataCompareNote'),
            pickerEmpty: document.getElementById('dataPickerEmpty'),
            picker: document.getElementById('dataTablePicker'),
            tableSummary: document.getElementById('dataTableSummary'),
            tableFilter: document.getElementById('dataTableFilter'),
            tableList: document.getElementById('dataTableList'),
            pickerFooter: document.getElementById('dataPickerFooter'),
            tableSelected: document.getElementById('dataTableSelected'),
            runCompare: document.getElementById('dataRunCompareBtn'),
            result: document.getElementById('dataCompareResult'),
            resultSummary: document.getElementById('dataResultSummary'),
            resultStatusFilter: document.getElementById('dataResultStatusFilter'),
            resultFilter: document.getElementById('dataResultFilter'),
            resultList: document.getElementById('dataResultList'),
            resultDetail: document.getElementById('dataResultDetail'),
            footer: document.getElementById('dataCompareFooter'),
            selected: document.getElementById('dataSelected'),
            includeDeletes: document.getElementById('dataIncludeDeletes'),
            apply: document.getElementById('dataApplyBtn'),
            exportZip: document.getElementById('dataExportBtn'),
            script: document.getElementById('dataScriptBtn'),
            applyOverlay: document.getElementById('dataApplyOverlay'),
            applyConnection: document.getElementById('dataApplyConnection'),
            applyDatabase: document.getElementById('dataApplyDatabase'),
            applyStatus: document.getElementById('dataApplyStatus'),
            applyProgress: document.getElementById('dataApplyProgress'),
            applyBar: document.getElementById('dataApplyBar'),
            applyProgressText: document.getElementById('dataApplyProgressText'),
            applyResult: document.getElementById('dataApplyResult'),
            applyStop: document.getElementById('dataApplyStopBtn'),
            applyRun: document.getElementById('dataApplyRunBtn'),
            applyClose: document.getElementById('dataApplyCloseBtn')
        };
        this.database = null;
        this.sources = null;
        this.chosen = new Map(); // database -> the reference picked last
        this.tablesData = null;  // the last getDataCompareTables answer
        this.selectedTables = new Set(); // ids checked in the table picker
        this.pickerFilter = '';
        this.running = false;
        this.result = null;      // the last runDataCompare answer
        this.selected = new Set(); // table ids included in the script/export/apply
        this.active = null;      // the row shown on the right: "schema.name\u0000kind\u0000index"
        this.filter = '';
        this.statuses = new Set();
        this.view = 'changes';
        this.applying = false;

        this.el.reference.addEventListener('change', () => {
            this.chosen.set(this.database, this.el.reference.value);
            this.el.reference.title = this.el.reference.selectedOptions[0] ? this.el.reference.selectedOptions[0].textContent : '';
            this.tablesData = null;
            this.result = null;
            this.renderPicker();
            this.renderResult();
            this.updateListButton();
        });
        this.el.listTables.addEventListener('click', () => this.listTables());
        this.el.tableFilter.addEventListener('input', () => { this.pickerFilter = this.el.tableFilter.value.trim().toLowerCase(); this.renderPicker(); });
        this.el.tableList.addEventListener('click', e => {
            const box = e.target.closest('input[type="checkbox"]');
            if (!box || box.disabled) return;
            const id = box.closest('.compare-row').dataset.id;
            if (box.checked) this.selectedTables.add(id); else this.selectedTables.delete(id);
            this.renderPickerFooter();
        });
        this.el.runCompare.addEventListener('click', () => this.runCompare());

        this.el.resultFilter.addEventListener('input', () => { this.filter = this.el.resultFilter.value.trim().toLowerCase(); this.renderResultList(); });
        this.el.resultStatusFilter.addEventListener('click', e => {
            const chip = e.target.closest('.compare-chip');
            if (!chip) return;
            const value = chip.dataset.status;
            if (this.statuses.has(value)) this.statuses.delete(value); else this.statuses.add(value);
            this.renderResultStatusFilter();
            this.renderResultList();
        });
        this.el.resultList.addEventListener('click', e => {
            const box = e.target.closest('.compare-group input[type="checkbox"]');
            if (box) {
                const id = box.closest('.compare-group').dataset.id;
                if (box.checked) this.selected.add(id); else this.selected.delete(id);
                this.renderFooter();
                return;
            }
            const row = e.target.closest('.compare-row');
            if (row) this.show(row.dataset.id);
        });
        this.el.resultList.addEventListener('keydown', e => this.onListKey(e));
        this.el.resultDetail.addEventListener('click', e => {
            const tab = e.target.closest('[data-view]');
            if (!tab || tab.disabled) return;
            this.view = tab.dataset.view;
            this.renderDetail();
        });
        this.el.includeDeletes.addEventListener('change', () => this.renderFooter());
        this.el.script.addEventListener('click', () => this.buildScript());
        this.el.exportZip.addEventListener('click', () => vscode.postMessage({ command: 'exportDataZip', ...this.choice() }));

        this.el.apply.addEventListener('click', () => this.openApply());
        this.el.applyClose.addEventListener('click', () => this.closeApply());
        this.el.applyOverlay.addEventListener('click', e => { if (e.target === this.el.applyOverlay) this.closeApply(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && this.el.applyOverlay.classList.contains('visible')) this.closeApply(); });
        this.el.applyConnection.addEventListener('change', () => this.requestTargetDatabases());
        this.el.applyDatabase.addEventListener('change', () => this.updateApplyButtons());
        this.el.applyRun.addEventListener('click', () => this.runApply());
        this.el.applyStop.addEventListener('click', () => vscode.postMessage({ command: 'cancelApplyDataCompare' }));
    }

    static idOf(table) { return `${table.schema}.${table.name}`; }
    static rowId(tableId, kind, index) { return `${tableId}\u0000${kind}\u0000${index}`; }
    static parseRowId(id) { const [tableId, kind, index] = id.split('\u0000'); return { tableId, kind, index: Number(index) }; }

    static formatCount(n) { return n === null || n === undefined ? '?' : n.toLocaleString(); }

    // A value as the webview receives it (JSON): a date is an ISO string, a
    // binary is { type: 'Buffer', data: [...] } - shown as text, not scripted.
    static formatValue(value) {
        if (value === null || value === undefined) return 'NULL';
        if (value && value.type === 'Buffer' && Array.isArray(value.data)) return `0x${value.data.map(b => (b & 255).toString(16).padStart(2, '0')).join('')}`;
        if (typeof value === 'string') {
            const iso = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z$/.exec(value);
            if (iso) return `${iso[1]} ${iso[2]}`;
        }
        return String(value);
    }

    static keyLabel(table, keyValues) { return table.key.map((c, i) => `${c}=${DataCompareManager.formatValue(keyValues[i])}`).join(', '); }

    static rowOf(table, kind, index) { return kind === 'modified' ? table.modified[index].after : table[kind][index]; }
    static keyOf(table, kind, index) { const row = DataCompareManager.rowOf(table, kind, index); return table.key.map(c => row[c]); }

    // === Activation, reset =================================================

    onActivated(database) {
        if (database !== this.database) {
            this.database = database;
            this.tablesData = null;
            this.result = null;
            this.renderPicker();
            this.renderResult();
            this.setNote('');
        }
        this.renderReferenceSelect();
    }

    reset() {
        this.database = null;
        this.sources = null;
        this.chosen = new Map();
        this.tablesData = null;
        this.result = null;
        this.selectedTables = new Set();
        this.selected = new Set();
        this.renderReferenceSelect();
        this.renderPicker();
        this.renderResult();
        this.setNote('');
    }

    setSources(message) {
        this.sources = message;
        this.renderReferenceSelect();
    }

    setNote(text, kind = '') {
        this.el.note.textContent = text;
        this.el.note.className = `compare-note${kind ? ` ${kind}` : ''}`;
    }

    // === The reference select, and listing the tables =======================

    renderReferenceSelect() {
        const select = this.el.reference;
        const kept = this.chosen.get(this.database) || select.value;
        select.textContent = '';
        const sources = this.sources;
        if (sources && sources.database === this.database) {
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
        }
        if (!select.firstChild) {
            const o = document.createElement('option');
            o.value = '';
            o.textContent = this.database ? 'No snapshot yet: take one in "Compared with a reference"' : 'Select a database first';
            select.appendChild(o);
        }
        select.title = select.selectedOptions[0] ? select.selectedOptions[0].textContent : '';
        this.updateListButton();
    }

    updateListButton() {
        this.el.listTables.disabled = !this.el.reference.value || this.running;
    }

    listTables() {
        const reference = this.el.reference.value;
        if (!reference || !this.database) return;
        this.running = true;
        this.updateListButton();
        this.setNote(`Listing the tables of ${reference} and ${this.database}…`);
        vscode.postMessage({ command: 'getDataCompareTables', database: this.database, reference });
    }

    onFailed(message) {
        this.running = false;
        this.updateListButton();
        this.setNote(message.message, 'error');
        if (this.el.applyOverlay.classList.contains('visible')) {
            this.applying = false;
            this.el.applyProgress.hidden = true;
            this.setApplyStatus(message.message, 'error');
            this.updateApplyButtons();
        }
    }

    onTables(message) {
        if (message.database !== this.database) return;
        this.running = false;
        this.tablesData = message;
        this.result = null;
        this.selectedTables = new Set(message.comparable.map(DataCompareManager.idOf));
        this.pickerFilter = '';
        this.el.tableFilter.value = '';
        this.updateListButton();
        const parts = [`${message.comparable.length} comparable table(s)`];
        if (message.notComparable.length > 0) parts.push(`${message.notComparable.length} not comparable`);
        this.setNote(parts.join(', '), message.support.supported ? 'success' : 'error');
        if (!message.support.supported) this.setNote(message.support.reason, 'error');
        this.renderResult();
        this.renderPicker();
    }

    // === The table picker ====================================================

    renderPicker() {
        const list = this.el.tableList;
        list.textContent = '';
        const data = this.tablesData;
        this.el.pickerEmpty.hidden = !!data;
        this.el.picker.hidden = !data;
        this.el.pickerFooter.hidden = !data;
        if (!data) return;

        const matches = id => !this.pickerFilter || id.toLowerCase().includes(this.pickerFilter);
        this.el.tableSummary.textContent = data.support.supported
            ? `Pick the tables to compare, then "Compare data".`
            : data.support.reason;

        for (const table of data.comparable) {
            const id = DataCompareManager.idOf(table);
            if (matches(id)) list.appendChild(this.pickerRow(table, id, true));
        }
        for (const table of data.notComparable) {
            const id = DataCompareManager.idOf(table);
            if (matches(id)) list.appendChild(this.pickerRow(table, id, false));
        }
        if (!list.firstChild) {
            const p = document.createElement('p');
            p.className = 'placeholder-text';
            p.textContent = 'Nothing matches the filter.';
            list.appendChild(p);
        }
        this.renderPickerFooter();
    }

    pickerRow(table, id, comparable) {
        const row = document.createElement('div');
        row.className = 'compare-row';
        row.dataset.id = id;
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.disabled = !comparable || !this.tablesData.support.supported;
        box.checked = comparable && this.selectedTables.has(id);
        box.setAttribute('aria-label', `Include ${id}`);
        row.appendChild(box);
        const name = document.createElement('span');
        name.className = 'compare-name';
        name.textContent = id;
        row.appendChild(name);
        const note = document.createElement('span');
        note.className = 'compare-op-note';
        note.textContent = comparable
            ? `${DataCompareManager.formatCount(table.rowCountReference)} → ${DataCompareManager.formatCount(table.rowCountCurrent)} row(s)`
            : table.reason;
        row.appendChild(note);
        if (comparable && table.excludedColumns.length > 0) {
            note.title = `Not compared: ${table.excludedColumns.map(c => `${c.name} (${c.reason})`).join('; ')}`;
        }
        return row;
    }

    renderPickerFooter() {
        if (!this.tablesData) return;
        this.el.tableSelected.textContent = `${this.selectedTables.size} of ${this.tablesData.comparable.length} table(s) selected`;
        this.el.runCompare.disabled = this.selectedTables.size === 0 || !this.tablesData.support.supported;
    }

    // === Running the comparison, and its progress ===========================

    runCompare() {
        if (this.selectedTables.size === 0) return;
        this.running = true;
        this.el.runCompare.disabled = true;
        this.setNote(`Comparing ${this.selectedTables.size} table(s)…`);
        vscode.postMessage({ command: 'runDataCompare', database: this.database, reference: this.el.reference.value, tables: [...this.selectedTables] });
    }

    onProgress(message) {
        if (message.table) this.setNote(`Comparing ${message.table}… (${message.done} of ${message.total})`);
    }

    // === The result ==========================================================

    onResult(message) {
        if (message.database !== this.database) return;
        this.running = false;
        this.result = message;
        this.selected = new Set(message.tables.map(DataCompareManager.idOf));
        this.filter = '';
        this.statuses.clear();
        this.el.resultFilter.value = '';
        this.el.includeDeletes.checked = false;
        const total = message.tables.reduce((n, t) => n + t.counts.added + t.counts.modified + t.counts.removed, 0);
        this.active = null;
        for (const table of message.tables) {
            for (const kind of ['added', 'modified', 'removed']) {
                if (table[kind].length > 0) { this.active = DataCompareManager.rowId(DataCompareManager.idOf(table), kind, 0); break; }
            }
            if (this.active) break;
        }
        this.setNote(`Compared in ${(message.durationMs / 1000).toFixed(1)} s: ${total} row(s) differ.`, 'success');
        this.renderResult();
    }

    renderResult() {
        const result = this.result;
        this.el.result.hidden = !result;
        this.el.footer.hidden = !result;
        // The picker and the result never show at once: a fresh result replaces it.
        if (result) {
            this.el.pickerEmpty.hidden = true;
            this.el.picker.hidden = true;
            this.el.pickerFooter.hidden = true;
        }
        if (!result) return;

        const summary = this.el.resultSummary;
        summary.textContent = '';
        const heading = document.createElement('div');
        heading.className = 'compare-heading';
        heading.textContent = `${result.reference} → ${result.database}`;
        summary.appendChild(heading);
        const counts = document.createElement('div');
        counts.className = 'compare-counts';
        const total = { added: 0, modified: 0, removed: 0 };
        result.tables.forEach(t => { total.added += t.counts.added; total.modified += t.counts.modified; total.removed += t.counts.removed; });
        counts.textContent = (total.added + total.modified + total.removed === 0)
            ? 'Identical, for the tables compared.'
            : `${total.added} added · ${total.modified} modified · ${total.removed} removed`;
        summary.appendChild(counts);
        const truncated = result.tables.filter(t => t.truncated);
        if (truncated.length > 0) {
            const note = document.createElement('div');
            note.className = 'compare-skipped';
            note.textContent = `Too many differences to show in full: ${truncated.map(DataCompareManager.idOf).join(', ')} (the counts are exact, the rows shown are not all of them).`;
            summary.appendChild(note);
        }

        this.renderResultStatusFilter();
        this.renderResultList();
        this.renderFooter();
        this.renderDetail();
    }

    renderResultStatusFilter() {
        const box = this.el.resultStatusFilter;
        box.textContent = '';
        const result = this.result;
        if (!result) { box.hidden = true; return; }
        const total = { added: 0, modified: 0, removed: 0 };
        result.tables.forEach(t => { total.added += t.counts.added; total.modified += t.counts.modified; total.removed += t.counts.removed; });
        box.hidden = (total.added + total.modified + total.removed) === 0;
        if (box.hidden) return;
        for (const status of ['added', 'modified', 'removed']) {
            if (total[status] === 0) continue;
            const el = document.createElement('button');
            el.type = 'button';
            el.dataset.status = status;
            el.className = `compare-chip ${status}${this.statuses.has(status) ? ' on' : ''}`;
            el.setAttribute('aria-pressed', String(this.statuses.has(status)));
            el.title = DATA_STATUS[status].title;
            el.textContent = `${status[0].toUpperCase()}${status.slice(1)} ${total[status]}`;
            box.appendChild(el);
        }
    }

    // The rows of a table that match the current filter/status tags.
    rowsOf(table) {
        const kinds = this.statuses.size === 0 ? ['added', 'modified', 'removed'] : [...this.statuses];
        const rows = [];
        for (const kind of kinds) {
            for (let i = 0; i < table[kind].length; i++) {
                const key = DataCompareManager.keyOf(table, kind, i);
                const label = DataCompareManager.keyLabel(table, key);
                if (this.filter && !label.toLowerCase().includes(this.filter) && !DataCompareManager.idOf(table).toLowerCase().includes(this.filter)) continue;
                rows.push({ kind, index: i, label });
            }
        }
        return rows;
    }

    renderResultList() {
        const list = this.el.resultList;
        list.textContent = '';
        if (!this.result) return;
        const groups = this.result.tables.map(table => ({ table, id: DataCompareManager.idOf(table), rows: this.rowsOf(table) })).filter(g => g.rows.length > 0);
        if (groups.length === 0) {
            const p = document.createElement('p');
            p.className = 'placeholder-text';
            p.textContent = 'Nothing differs, or nothing matches the filter.';
            list.appendChild(p);
            return;
        }
        for (const group of groups) {
            const header = document.createElement('div');
            header.className = 'compare-group';
            header.dataset.id = group.id;
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = this.selected.has(group.id);
            box.setAttribute('aria-label', `Include ${group.id} in the script`);
            header.appendChild(box);
            const label = document.createElement('span');
            label.textContent = `${group.id} (${group.rows.length})`;
            header.appendChild(label);
            list.appendChild(header);
            for (const row of group.rows) list.appendChild(this.rowNode(group.table, group.id, row));
        }
    }

    rowNode(table, tableId, row) {
        const id = DataCompareManager.rowId(tableId, row.kind, row.index);
        const el = document.createElement('div');
        el.className = `compare-row${id === this.active ? ' active' : ''}`;
        el.dataset.id = id;
        el.tabIndex = -1;
        el.setAttribute('role', 'treeitem');
        const status = DATA_STATUS[row.kind];
        const icon = document.createElement('i');
        icon.className = `codicon codicon-${status.icon} compare-status ${row.kind}`;
        icon.title = status.title;
        el.appendChild(icon);
        const name = document.createElement('span');
        name.className = 'compare-name';
        name.textContent = row.label;
        el.appendChild(name);
        return el;
    }

    onListKey(event) {
        const rows = [...this.el.resultList.querySelectorAll('.compare-row')];
        if (rows.length === 0) return;
        const row = event.target.closest && event.target.closest('.compare-row');
        const index = row ? rows.indexOf(row) : -1;
        let target = null;
        if (event.key === 'ArrowDown') target = rows[Math.min(index + 1, rows.length - 1)];
        else if (event.key === 'ArrowUp') target = rows[Math.max(index - 1, 0)];
        else if (event.key === 'Home') target = rows[0];
        else if (event.key === 'End') target = rows[rows.length - 1];
        else return;
        event.preventDefault();
        if (target) { this.show(target.dataset.id); target.focus(); target.scrollIntoView({ block: 'nearest' }); }
    }

    show(id) {
        this.active = id;
        this.el.resultList.querySelectorAll('.compare-row.active').forEach(r => r.classList.remove('active'));
        const row = [...this.el.resultList.querySelectorAll('.compare-row')].find(r => r.dataset.id === id);
        if (row) row.classList.add('active');
        this.view = 'changes';
        this.renderDetail();
    }

    // === The detail ==========================================================

    activeTable() {
        if (!this.active || !this.result) return null;
        const { tableId } = DataCompareManager.parseRowId(this.active);
        return this.result.tables.find(t => DataCompareManager.idOf(t) === tableId);
    }

    renderDetail() {
        const detail = this.el.resultDetail;
        detail.textContent = '';
        if (!this.active || !this.result) {
            const p = document.createElement('p');
            p.className = 'placeholder-text';
            p.textContent = this.result ? 'Pick a row to see it.' : '';
            detail.appendChild(p);
            return;
        }
        const { tableId, kind, index } = DataCompareManager.parseRowId(this.active);
        const table = this.activeTable();
        if (!table) return;
        const key = DataCompareManager.keyOf(table, kind, index);

        const title = document.createElement('div');
        title.className = 'compare-detail-title';
        title.textContent = `${tableId} — ${DataCompareManager.keyLabel(table, key)} — ${kind}`;
        detail.appendChild(title);

        const sides = { before: kind !== 'added', after: kind !== 'removed' };
        const view = this.view !== 'changes' && !sides[this.view] ? 'changes' : this.view;
        const bar = document.createElement('div');
        bar.className = 'compare-views';
        bar.setAttribute('role', 'tablist');
        for (const [name, enabled, label] of [['changes', true, 'Differences'], ['before', sides.before, `Reference (${this.result.reference})`], ['after', sides.after, `Current (${this.result.database})`]]) {
            const tab = document.createElement('button');
            tab.type = 'button';
            tab.dataset.view = name;
            tab.disabled = !enabled;
            tab.className = `compare-view-tab${view === name ? ' active' : ''}`;
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', String(view === name));
            tab.textContent = label;
            bar.appendChild(tab);
        }
        detail.appendChild(bar);

        if (view === 'changes') { this.renderRowChanges(detail, table, kind, index); return; }
        const row = view === 'before'
            ? (kind === 'modified' ? table.modified[index].before : table.removed[index])
            : (kind === 'modified' ? table.modified[index].after : table.added[index]);
        this.renderFullRow(detail, table, row);
    }

    renderRowChanges(parent, table, kind, index) {
        const box = document.createElement('div');
        box.className = 'compare-ops';
        const line = (sign, text) => {
            const el = document.createElement('div');
            el.className = `compare-op ${sign === '+' ? 'add' : sign === '−' ? 'del' : 'mod'}`;
            const s = document.createElement('span');
            s.className = 'compare-sign';
            s.textContent = sign;
            el.appendChild(s);
            const t = document.createElement('span');
            t.className = 'compare-op-text';
            t.textContent = text;
            el.appendChild(t);
            box.appendChild(el);
        };
        if (kind === 'modified') {
            const { before, after, changedColumns } = table.modified[index];
            for (const c of changedColumns) line('~', `${c}: ${DataCompareManager.formatValue(before[c])} → ${DataCompareManager.formatValue(after[c])}`);
        } else {
            const row = DataCompareManager.rowOf(table, kind, index);
            for (const c of table.columns) line(kind === 'added' ? '+' : '−', `${c}: ${DataCompareManager.formatValue(row[c])}`);
        }
        parent.appendChild(box);
    }

    renderFullRow(parent, table, row) {
        const box = document.createElement('div');
        box.className = 'compare-ops';
        if (!row) {
            const p = document.createElement('p');
            p.className = 'placeholder-text';
            p.textContent = 'There is no row on that side.';
            parent.appendChild(p);
            return;
        }
        for (const c of table.columns) {
            const el = document.createElement('div');
            el.className = 'compare-op';
            const t = document.createElement('span');
            t.className = 'compare-op-text';
            t.textContent = `${c}: ${DataCompareManager.formatValue(row[c])}`;
            el.appendChild(t);
            box.appendChild(el);
        }
        parent.appendChild(box);
    }

    // === The script ==========================================================

    renderFooter() {
        if (!this.result) return;
        const tables = this.result.tables.filter(t => this.selected.has(DataCompareManager.idOf(t)));
        const removed = tables.reduce((n, t) => n + t.counts.removed, 0);
        const parts = [`${tables.length} of ${this.result.tables.length} table(s) selected`];
        if (removed > 0 && !this.el.includeDeletes.checked) parts.push(`${removed} removed row(s) left out`);
        this.el.selected.textContent = parts.join(' · ');
        const nothing = tables.length === 0;
        this.el.script.disabled = nothing;
        this.el.exportZip.disabled = nothing;
        this.el.apply.disabled = nothing;
    }

    choice() {
        return { ids: [...this.selected], includeDeletes: this.el.includeDeletes.checked };
    }

    buildScript() {
        vscode.postMessage({ command: 'buildDataScript', ...this.choice() });
    }

    onScript(message) {
        if (message.steps === 0) {
            this.setNote('Nothing to script.', 'error');
            return;
        }
        if (window.tabManager) window.tabManager.switchTab('query');
        if (window.queryManager && window.queryManager.openScriptInNewTab) window.queryManager.openScriptInNewTab(message.script);
        else if (window.queryManager) window.queryManager.setQueryText(message.script);
        const extra = message.warnings.length > 0 ? `${message.warnings.length} warning(s), see the comments` : '';
        if (window.queryManager) window.queryManager.setStatus(`Script of ${message.steps} step(s) - review it, then run it on the database to change.${extra ? ` (${extra})` : ''}`, '');
    }

    onExported(message) {
        if (message.cancelled) return;
        this.setNote(`Exported ${message.count} table(s) (${message.files} files) to ${message.path}`, 'success');
    }

    // === Applying =============================================================

    openApply() {
        if (!this.result) return;
        this.el.applyOverlay.classList.add('visible');
        this.applying = false;
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
        this.el.applyOverlay.classList.remove('visible');
    }

    setApplyStatus(text, kind = '') {
        this.el.applyStatus.textContent = text;
        this.el.applyStatus.className = `compare-apply-status${kind ? ` ${kind}` : ''}`;
    }

    updateApplyButtons() {
        this.el.applyConnection.disabled = this.applying;
        this.el.applyDatabase.disabled = this.applying;
        this.el.applyRun.disabled = this.applying || !this.el.applyDatabase.value;
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
        this.updateApplyButtons();
    }

    runApply() {
        this.applying = true;
        this.el.applyResult.hidden = true;
        this.el.applyProgress.hidden = false;
        this.el.applyBar.removeAttribute('value');
        this.el.applyProgressText.textContent = 'Waiting for your confirmation…';
        this.updateApplyButtons();
        vscode.postMessage({ command: 'applyDataCompare', ...this.choice(), connection: this.el.applyConnection.value || null, database: this.el.applyDatabase.value });
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

    onApplied(message) {
        this.applying = false;
        this.el.applyProgress.hidden = true;
        this.el.applyResult.hidden = false;
        this.el.applyResult.textContent = '';
        const seconds = (message.durationMs / 1000).toFixed(1);
        const lines = [];
        if (message.errors.length === 0 && !message.stopped) lines.push({ kind: 'success', text: `Applied ${message.steps} step(s) in ${seconds} s.` });
        else if (message.stopped) lines.push({ kind: 'error', text: `Stopped after ${message.ran} of ${message.batches} batches. Apply again to finish.` });
        else lines.push({ kind: 'error', text: `The script stopped on an error (${message.ran} of ${message.batches} batches ran).` });
        message.errors.forEach(e => lines.push({ kind: 'error', text: `Batch ${e.batch}, line ${e.line}: ${e.message}` }));
        for (const line of lines) {
            const el = document.createElement('div');
            el.className = `compare-apply-line ${line.kind}`;
            el.textContent = line.text;
            this.el.applyResult.appendChild(el);
        }
        this.updateApplyButtons();
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DataCompareManager };
}
