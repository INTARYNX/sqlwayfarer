// "Modified since" of the Compare tab: what was created or altered in the
// database lately, from the dates the server keeps on its objects. No snapshot
// needed. It does not see what was dropped, nor what happened to the data.

const RECENT_KIND_LABEL = { table: 'Tables', view: 'Views', function: 'Functions', procedure: 'Procedures', trigger: 'Triggers', constraint: 'Constraints', synonym: 'Synonyms', sequence: 'Sequences' };
const RECENT_WITH_CODE = new Set(['view', 'procedure', 'function', 'trigger']);

class RecentChanges {
    constructor() {
        this.el = {
            period: document.getElementById('recentPeriod'),
            refresh: document.getElementById('recentRefreshBtn'),
            note: document.getElementById('recentNote'),
            empty: document.getElementById('recentEmpty'),
            result: document.getElementById('recentResult'),
            summary: document.getElementById('recentSummary'),
            filter: document.getElementById('recentFilter'),
            list: document.getElementById('recentList'),
            detail: document.getElementById('recentDetail')
        };
        this.database = null;
        this.data = null;     // what the extension answered
        this.active = null;   // key of the item shown
        this.filter = '';
        this.loading = false;

        // What the period can also be: the moment a snapshot of the database was taken.
        this.snapshotGroup = document.createElement('optgroup');
        this.snapshotGroup.label = 'Since a snapshot of this database';
        this.el.period.addEventListener('change', () => this.load());
        this.el.refresh.addEventListener('click', () => this.load());
        this.el.filter.addEventListener('input', () => { this.filter = this.el.filter.value.trim().toLowerCase(); this.renderList(); });
        this.el.list.addEventListener('click', (e) => {
            const row = e.target.closest('.recent-row');
            if (row) this.show(row.dataset.key);
        });
        this.el.list.addEventListener('keydown', (e) => this.onKey(e));
    }

    // === Pure helpers (also used by the tests) ==============================

    static keyOf(item) { return `${item.kind}:${item.schema}.${item.name}`; }

    // "just now", "12 min ago", "3 h ago", "2 days ago"
    static formatAge(seconds) {
        const s = Math.max(0, Number(seconds) || 0);
        if (s < 60) return 'just now';
        if (s < 3600) return `${Math.floor(s / 60)} min ago`;
        if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
        const days = Math.floor(s / 86400);
        return `${days} day${days > 1 ? 's' : ''} ago`;
    }

    static matches(item, filter) {
        if (!filter) return true;
        return `${item.schema}.${item.name} ${item.kind} ${item.status} ${item.parent || ''}`.toLowerCase().includes(filter);
    }

    // The counts by kind, in a fixed order: "3 tables · 2 procedures · 1 constraint".
    static summaryText(items) {
        const counts = {};
        for (const item of items) counts[item.kind] = (counts[item.kind] || 0) + 1;
        return Object.keys(RECENT_KIND_LABEL).filter(kind => counts[kind]).map(kind => {
            const n = counts[kind];
            const label = RECENT_KIND_LABEL[kind].toLowerCase();
            return `${n} ${n === 1 ? label.replace(/ies$/, 'y').replace(/s$/, '') : label}`;
        }).join(' · ');
    }

    // === Loading ============================================================

    // The period the select stands on: the last minutes, or since a snapshot.
    selection() {
        const value = this.el.period.value;
        return value.startsWith('snapshot:') ? { snapshot: value.slice('snapshot:'.length) } : { minutes: Number(value) };
    }

    // The snapshots of the database of the tab ([{ name, createDate }]), offered
    // after the fixed periods. One that was dropped is no longer a period.
    setSnapshots(snapshots) {
        const previous = this.el.period.value;
        this.snapshotGroup.textContent = '';
        for (const s of snapshots || []) {
            const option = document.createElement('option');
            option.value = `snapshot:${s.name}`;
            option.textContent = `${s.name}  (${new Date(s.createDate).toLocaleString()})`;
            this.snapshotGroup.appendChild(option);
        }
        if (this.snapshotGroup.firstChild) this.el.period.appendChild(this.snapshotGroup);
        else this.snapshotGroup.remove();

        if (previous.startsWith('snapshot:') && ![...this.el.period.options].some(o => o.value === previous)) {
            this.el.period.value = this.el.period.querySelector('option[selected]').value;
            this.data = null;
            this.active = null;
            this.render();
            if (!this.el.period.closest('.compare-view').hidden) this.load();
        } else {
            this.el.period.value = previous;
        }
    }

    onActivated(database) {
        if (database !== this.database) {
            this.database = database;
            this.data = null;
            this.active = null;
            this.render();
        }
        if (database && !this.data && !this.loading) this.load();
    }

    reset() {
        this.database = null;
        this.data = null;
        this.active = null;
        this.render();
    }

    load() {
        if (!this.database) return;
        this.loading = true;
        this.setNote('Reading the dates of the objects…');
        vscode.postMessage({ command: 'getRecentChanges', database: this.database, ...this.selection() });
    }

    setNote(text, kind = '') {
        this.el.note.textContent = text;
        this.el.note.className = `compare-note${kind ? ` ${kind}` : ''}`;
    }

    onChanges(message) {
        if (message.database !== this.database) return;
        this.loading = false;
        this.data = message;
        this.active = message.items.length > 0 ? RecentChanges.keyOf(message.items[0]) : null;
        this.filter = '';
        this.el.filter.value = '';
        this.setNote(message.truncated ? `Only the first ${message.items.length} are shown.` : `Server time ${message.serverTime}.`, message.truncated ? 'error' : '');
        this.render();
        this.requestDefinition();
    }

    onFailed(message) {
        this.loading = false;
        this.setNote(message.message, 'error');
    }

    // === View ===============================================================

    render() {
        const data = this.data;
        this.el.empty.hidden = !!data && data.items.length > 0;
        this.el.result.hidden = !data || data.items.length === 0;
        if (data && data.items.length === 0) {
            this.el.empty.textContent = '';
            const p = document.createElement('p');
            p.textContent = 'Nothing was created or altered in this period.';
            this.el.empty.appendChild(p);
        } else if (!data) {
            this.el.empty.textContent = '';
            const intro = document.createElement('p');
            intro.textContent = 'See what was created or altered in this database lately, without a snapshot: the dates the server keeps on every object.';
            const limits = document.createElement('p');
            limits.textContent = 'It sees tables (structure, indexes and constraints), views, procedures, functions, triggers, synonyms and sequences. It does not see what was dropped, nor what happened to the data: a snapshot shows what was dropped.';
            this.el.empty.append(intro, limits);
        }
        if (!data) return;

        this.el.summary.textContent = '';
        const heading = document.createElement('div');
        heading.className = 'compare-heading';
        heading.textContent = data.snapshot
            ? `${data.items.length} object(s) since the snapshot ${data.snapshot}${data.since ? ` (taken ${data.since})` : ''}`
            : `${data.items.length} object(s) in the last ${this.el.period.selectedOptions[0].textContent.toLowerCase()}`;
        const counts = document.createElement('div');
        counts.className = 'compare-counts';
        counts.textContent = RecentChanges.summaryText(data.items);
        this.el.summary.append(heading, counts);
        this.renderList();
        this.renderDetail();
    }

    renderList() {
        const list = this.el.list;
        list.textContent = '';
        if (!this.data) return;
        const items = this.data.items.filter(item => RecentChanges.matches(item, this.filter));
        if (items.length === 0) {
            const p = document.createElement('p');
            p.className = 'placeholder-text';
            p.textContent = 'Nothing matches the filter.';
            list.appendChild(p);
            return;
        }
        for (const item of items) list.appendChild(this.rowNode(item));
    }

    iconFor(item) {
        switch (item.kind) {
            case 'table': return swObjectIcon('Table');
            case 'view': return swObjectIcon('View');
            case 'procedure': return swObjectIcon('Procedure');
            case 'function': return swObjectIcon('Function');
            case 'trigger': return swObjectIcon('Trigger');
            case 'constraint': return '<i class="codicon codicon-key"></i>';
            default: return '<i class="codicon codicon-symbol-misc"></i>';
        }
    }

    rowNode(item) {
        const key = RecentChanges.keyOf(item);
        const row = document.createElement('div');
        row.className = `recent-row${key === this.active ? ' active' : ''}`;
        row.dataset.key = key;
        row.tabIndex = -1;
        row.setAttribute('role', 'option');

        const icon = document.createElement('span');
        icon.className = 'recent-icon';
        icon.innerHTML = this.iconFor(item);
        row.appendChild(icon);

        const name = document.createElement('span');
        name.className = 'compare-name';
        name.textContent = item.kind === 'constraint' && item.parent ? `${item.name}  ·  ${item.parent}` : `${item.schema}.${item.name}`;
        name.title = `${item.kind} ${item.schema}.${item.name}`;
        row.appendChild(name);

        const badge = document.createElement('span');
        badge.className = `recent-badge ${item.status}`;
        badge.textContent = item.status;
        badge.title = item.status === 'new' ? 'Created, and not altered since' : 'Altered after it was created';
        row.appendChild(badge);

        const age = document.createElement('span');
        age.className = 'recent-age';
        age.textContent = RecentChanges.formatAge(item.modifiedAge);
        row.appendChild(age);
        return row;
    }

    onKey(event) {
        const rows = [...this.el.list.querySelectorAll('.recent-row')];
        const row = event.target.closest && event.target.closest('.recent-row');
        if (rows.length === 0) return;
        const index = row ? rows.indexOf(row) : -1;
        let target = null;
        if (event.key === 'ArrowDown') target = rows[Math.min(index + 1, rows.length - 1)];
        else if (event.key === 'ArrowUp') target = rows[Math.max(index - 1, 0)];
        else if (event.key === 'Home') target = rows[0];
        else if (event.key === 'End') target = rows[rows.length - 1];
        else if (event.key === 'Enter' && row) { this.reveal(this.itemOf(row.dataset.key)); event.preventDefault(); return; }
        else return;
        event.preventDefault();
        if (target) { this.show(target.dataset.key); target.focus(); target.scrollIntoView({ block: 'nearest' }); }
    }

    itemOf(key) {
        return this.data ? this.data.items.find(i => RecentChanges.keyOf(i) === key) : null;
    }

    show(key) {
        this.active = key;
        this.el.list.querySelectorAll('.recent-row.active').forEach(r => r.classList.remove('active'));
        const row = [...this.el.list.querySelectorAll('.recent-row')].find(r => r.dataset.key === key);
        if (row) row.classList.add('active');
        this.renderDetail();
        this.requestDefinition();
    }

    // The table (or the object) to look at in the Explorer: the parent for a constraint or a trigger.
    explorerTarget(item) {
        if (item.kind === 'constraint' || item.kind === 'trigger') {
            if (!item.parent) return null;
            const parts = item.parent.split('.');
            return { schema: parts[0], name: parts.slice(1).join('.') };
        }
        return ['table', 'view', 'procedure', 'function'].includes(item.kind) ? { schema: item.schema, name: item.name } : null;
    }

    reveal(item) {
        const target = item && this.explorerTarget(item);
        if (target && window.explorerManager) window.explorerManager.revealExternalObject(this.database, target.schema, target.name, { newTab: true });
    }

    requestDefinition() {
        const item = this.itemOf(this.active);
        if (!item || !RECENT_WITH_CODE.has(item.kind)) return;
        this.definitions = this.definitions || new Map();
        const key = `${this.database}:${RecentChanges.keyOf(item)}:${item.modified}`;
        if (this.definitions.has(key)) return;
        vscode.postMessage({ command: 'getRecentDefinition', database: this.database, schema: item.schema, name: item.name });
    }

    onDefinition(message) {
        if (message.database !== this.database) return;
        const item = this.data && this.data.items.find(i => i.schema === message.schema && i.name === message.name && RECENT_WITH_CODE.has(i.kind));
        if (!item) return;
        this.definitions = this.definitions || new Map();
        this.definitions.set(`${this.database}:${RecentChanges.keyOf(item)}:${item.modified}`, message.definition);
        if (this.active === RecentChanges.keyOf(item)) this.renderDetail();
    }

    renderDetail() {
        const detail = this.el.detail;
        detail.textContent = '';
        const item = this.itemOf(this.active);
        if (!item) return;

        const title = document.createElement('div');
        title.className = 'compare-detail-title';
        title.textContent = `${item.kind} ${item.schema}.${item.name}`;
        detail.appendChild(title);

        const facts = document.createElement('div');
        facts.className = 'recent-facts';
        const fact = (label, value) => {
            const line = document.createElement('div');
            const strong = document.createElement('span');
            strong.className = 'recent-fact-label';
            strong.textContent = label;
            line.append(strong, document.createTextNode(value));
            facts.appendChild(line);
        };
        fact('Created', `${item.created}  (${RecentChanges.formatAge(item.createdAge)})`);
        fact('Modified', item.status === 'altered' ? `${item.modified}  (${RecentChanges.formatAge(item.modifiedAge)})` : 'not since it was created');
        if (item.status === 'altered' && item.createdInPeriod) fact('', 'Created and altered in this period.');
        if (item.parent) fact(item.kind === 'trigger' ? 'On table' : 'Of', item.parent);
        detail.appendChild(facts);

        const target = this.explorerTarget(item);
        if (target) {
            const button = document.createElement('button');
            button.className = 'recent-reveal';
            button.innerHTML = '<i class="codicon codicon-go-to-file"></i> ';
            button.appendChild(document.createTextNode(`Show ${item.kind === 'constraint' || item.kind === 'trigger' ? 'its table' : 'it'} in the Explorer`));
            button.addEventListener('click', () => this.reveal(item));
            detail.appendChild(button);
        }

        if (RECENT_WITH_CODE.has(item.kind)) {
            const key = `${this.database}:${RecentChanges.keyOf(item)}:${item.modified}`;
            const note = document.createElement('p');
            note.className = 'placeholder-text';
            if (!this.definitions || !this.definitions.has(key)) {
                note.textContent = 'Loading the code…';
                detail.appendChild(note);
                return;
            }
            const definition = this.definitions.get(key);
            if (definition === null || definition === undefined) {
                note.textContent = 'The code cannot be read (encrypted, or VIEW DEFINITION is missing).';
                detail.appendChild(note);
                return;
            }
            const code = document.createElement('div');
            code.className = 'compare-code';
            LineDiff.split(definition).forEach((text, i) => {
                const line = document.createElement('div');
                line.className = 'compare-line same';
                const number = document.createElement('span');
                number.className = 'compare-lineno';
                number.textContent = String(i + 1);
                const content = document.createElement('span');
                content.className = 'compare-line-text';
                content.textContent = text;
                line.append(number, content);
                code.appendChild(line);
            });
            detail.appendChild(code);
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { RecentChanges };
}
