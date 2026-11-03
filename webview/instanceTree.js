// The "Instance" view of the Query tab's side panel: the databases of the
// connection the queries run on, their objects, and the actions on them
// (script, rename, delete). Loaded level by level: the objects of a database
// are only read when it is opened.

const INSTANCE_GROUPS = [
    { type: 'Table', label: 'Tables' },
    { type: 'View', label: 'Views' },
    { type: 'Procedure', label: 'Procedures' },
    { type: 'Function', label: 'Functions' }
];

class InstanceTree {
    constructor() {
        this.view = document.getElementById('instanceView');
        this.tree = document.getElementById('instanceTree');
        this.filterInput = document.getElementById('instanceFilterInput');
        this.tabFiles = document.getElementById('panelTabFiles');
        this.tabInstance = document.getElementById('panelTabInstance');
        this.filesView = document.getElementById('sqlFilesView');
        this.active = false;
        this._reset();

        this.tabFiles.addEventListener('click', () => this.setActive(false));
        this.tabInstance.addEventListener('click', () => this.setActive(true));
        this.filterInput.addEventListener('input', () => {
            this.filter = this.filterInput.value.trim().toLowerCase();
            this.render();
        });
        this.tree.addEventListener('click', (e) => {
            const row = e.target.closest('.instance-row');
            if (!row) return;
            this.select(row.dataset.key);
            if (row.dataset.kind !== 'object') this.toggle(row.dataset.key);
        });
        this.tree.addEventListener('dblclick', (e) => {
            const row = e.target.closest('.instance-row[data-kind="object"]');
            if (row) this.showDetails(row);
        });
        this.tree.addEventListener('contextmenu', (e) => {
            const row = e.target.closest('.instance-row');
            if (!row) return;
            e.preventDefault();
            this.select(row.dataset.key);
            this.openMenu(row, { x: e.clientX, y: e.clientY });
        });
        this.tree.addEventListener('keydown', (e) => this.onKey(e));
    }

    _reset() {
        this.databases = null;      // null: not asked yet
        this.objects = new Map();   // database -> objects | { loading } | { error }
        this.expanded = new Set();
        this.selected = null;
        this.filter = '';
    }

    // A new connection: what was listed belongs to the previous one.
    reset() {
        this._reset();
        this.filterInput.value = '';
        if (this.active) this.load();
        else this.render();
    }

    // === The rows (pure) ====================================================

    static groupKey(database, type) { return `grp:${database}:${type}`; }
    static dbKey(database) { return `db:${database}`; }
    static objectKey(database, object) { return `obj:${database}:${object.qualified_name}`; }

    static matches(object, filter) {
        return !filter || (object.name || '').toLowerCase().includes(filter) || (object.qualified_name || '').toLowerCase().includes(filter);
    }

    // What the tree shows, as a flat list. With a filter, whatever holds a
    // match is opened, and databases whose objects were never read can only
    // match by their own name.
    static rows({ databases, objects, expanded, filter }) {
        const rows = [];
        for (const database of databases || []) {
            const entry = objects.get(database);
            const loaded = Array.isArray(entry);
            const nameMatches = !filter || database.toLowerCase().includes(filter);
            const hits = loaded ? entry.filter(o => InstanceTree.matches(o, filter)) : [];
            if (filter && !nameMatches && hits.length === 0) continue;

            const dbKey = InstanceTree.dbKey(database);
            const open = expanded.has(dbKey) || (filter && !nameMatches && hits.length > 0);
            rows.push({ key: dbKey, kind: 'db', depth: 0, database, open });
            if (!open) continue;
            if (!loaded) {
                rows.push({ key: `${dbKey}:note`, kind: 'note', depth: 1, text: entry && entry.error ? entry.error : 'Loading…', error: !!(entry && entry.error) });
                continue;
            }
            const shown = nameMatches ? entry : hits;
            for (const group of INSTANCE_GROUPS) {
                const inGroup = shown.filter(o => o.object_type === group.type);
                if (inGroup.length === 0) continue;
                const groupKey = InstanceTree.groupKey(database, group.type);
                const groupOpen = expanded.has(groupKey) || (filter && !nameMatches);
                rows.push({ key: groupKey, kind: 'group', depth: 1, database, type: group.type, label: group.label, count: inGroup.length, open: groupOpen });
                if (!groupOpen) continue;
                for (const object of inGroup) {
                    rows.push({ key: InstanceTree.objectKey(database, object), kind: 'object', depth: 2, database, object });
                }
            }
            if (rows[rows.length - 1].kind === 'db') rows.push({ key: `${dbKey}:note`, kind: 'note', depth: 1, text: 'No tables, views, procedures or functions.' });
        }
        return rows;
    }

    // === View ===============================================================

    setActive(active) {
        this.active = active;
        this.tabFiles.classList.toggle('active', !active);
        this.tabFiles.setAttribute('aria-selected', String(!active));
        this.tabInstance.classList.toggle('active', active);
        this.tabInstance.setAttribute('aria-selected', String(active));
        this.filesView.hidden = active;
        this.view.hidden = !active;
        // Files only apply to the files, the totals too.
        if (active) {
            if (this.databases === null) this.load();
            else this.render();
        } else if (window.queryFileManager) {
            window.queryFileManager.loadFilesTree();
        }
    }

    load() {
        this.tree.innerHTML = '<p class="placeholder-text">Loading…</p>';
        vscode.postMessage({ command: 'getInstanceDatabases' });
    }

    // The header's refresh: the databases, and every one that is open.
    refresh() {
        const open = [...this.objects.keys()];
        this.objects = new Map();
        this.databases = null;
        this.load();
        this._reopen = open.filter(db => this.expanded.has(InstanceTree.dbKey(db)));
    }

    refreshDatabase(database) {
        this.objects.set(database, { loading: true });
        this.render();
        vscode.postMessage({ command: 'getInstanceObjects', database });
    }

    // Collapse everything; again: open the databases that are already read
    // (opening all of them would read every database of the instance).
    toggleCollapseAll() {
        const anyOpen = this.expanded.size > 0;
        this.expanded = new Set();
        if (!anyOpen) for (const [db, entry] of this.objects) if (Array.isArray(entry)) this.expanded.add(InstanceTree.dbKey(db));
        this.render();
    }

    onDatabases(message) {
        this.databases = message.databases || [];
        if (message.message) this.tree.innerHTML = `<p class="placeholder-text">${this._escape(message.message)}</p>`;
        else this.render();
        for (const db of this._reopen || []) {
            if (this.databases.includes(db)) this.refreshDatabase(db);
        }
        this._reopen = null;
    }

    onObjects(message) {
        this.objects.set(message.database, message.objects || []);
        this.render();
    }

    onObjectsError(message) {
        this.objects.set(message.database, { error: message.message });
        this.render();
    }

    // Rename or Delete went through: what the database holds changed.
    onChanged(message) {
        this.refreshDatabase(message.database);
        // The Explorer shows the same database: it follows.
        if (appState.currentDatabase === message.database) vscode.postMessage({ command: 'getObjects', database: message.database });
    }

    _ensureLoaded(key) {
        if (!key.startsWith('db:')) return;
        const database = key.slice(3);
        if (!this.objects.has(database)) this.refreshDatabase(database);
    }

    toggle(key) {
        if (this.expanded.has(key)) this.expanded.delete(key);
        else {
            this.expanded.add(key);
            this._ensureLoaded(key);
        }
        this.render();
    }

    select(key) {
        this.selected = key;
        this.tree.querySelectorAll('.instance-row.selected').forEach(r => r.classList.remove('selected'));
        const row = this._rowEl(key);
        if (row) row.classList.add('selected');
    }

    _rowEl(key) {
        return [...this.tree.querySelectorAll('.instance-row')].find(r => r.dataset.key === key) || null;
    }

    _escape(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    render() {
        if (this.databases === null) return;
        const focused = this.tree.contains(document.activeElement) ? document.activeElement.dataset && document.activeElement.dataset.key : null;
        const rows = InstanceTree.rows({ databases: this.databases, objects: this.objects, expanded: this.expanded, filter: this.filter });
        this.tree.textContent = '';
        if (rows.length === 0) {
            const p = document.createElement('p');
            p.className = 'placeholder-text';
            p.textContent = this.filter ? 'Nothing matches the filter.' : 'No databases.';
            this.tree.appendChild(p);
            return;
        }
        const fragment = document.createDocumentFragment();
        for (const row of rows) fragment.appendChild(this._rowNode(row));
        this.tree.appendChild(fragment);
        if (focused) { const el = this._rowEl(focused); if (el) el.focus(); }
    }

    _rowNode(row) {
        const el = document.createElement('div');
        el.style.setProperty('--depth', row.depth);
        if (row.kind === 'note') {
            el.className = 'instance-note' + (row.error ? ' error' : '');
            el.textContent = row.text;
            return el;
        }
        el.className = 'instance-row' + (row.key === this.selected ? ' selected' : '');
        el.dataset.key = row.key;
        el.dataset.kind = row.kind;
        el.dataset.database = row.database;
        el.tabIndex = -1;
        el.setAttribute('role', 'treeitem');
        if (row.kind !== 'object') el.setAttribute('aria-expanded', String(!!row.open));

        const chevron = document.createElement('i');
        chevron.className = row.kind === 'object' ? 'codicon codicon-chevron-right instance-chevron leaf' : `codicon codicon-chevron-${row.open ? 'down' : 'right'} instance-chevron`;
        el.appendChild(chevron);

        const icon = document.createElement('span');
        icon.innerHTML = row.kind === 'db' ? swObjectIcon('Database') : row.kind === 'group' ? '<i class="codicon codicon-folder"></i>' : swObjectIcon(row.object.object_type);
        el.appendChild(icon);

        const name = document.createElement('span');
        name.className = 'instance-name';
        if (row.kind === 'db') name.textContent = row.database;
        else if (row.kind === 'group') { name.textContent = row.label; el.dataset.type = row.type; }
        else {
            name.textContent = row.object.name;
            el.dataset.name = row.object.qualified_name;
            el.dataset.schema = row.object.schema_name;
            el.dataset.object = row.object.object_name;
            el.dataset.type = row.object.object_type;
            el.title = `${row.object.object_type} ${row.database}.${row.object.qualified_name}`;
        }
        el.appendChild(name);

        if (row.kind === 'group') {
            const count = document.createElement('span');
            count.className = 'instance-count';
            count.textContent = `(${row.count})`;
            el.appendChild(count);
        }
        return el;
    }

    // === Actions ============================================================

    _objectOf(row) {
        const list = this.objects.get(row.dataset.database);
        return Array.isArray(list) ? list.find(o => o.qualified_name === row.dataset.name) : null;
    }

    showDetails(row) {
        const object = this._objectOf(row);
        if (!object || !window.explorerManager) return;
        window.explorerManager.revealExternalObject(row.dataset.database, object.schema_name || 'dbo', object.object_name);
    }

    openMenu(row, at) {
        if (!window.explorerManager) return;
        const database = row.dataset.database;
        const items = [];
        if (row.dataset.kind === 'object') {
            const object = this._objectOf(row);
            if (!object) return;
            const post = (command, extra) => vscode.postMessage(Object.assign({ command, database, objectName: object.qualified_name, objectType: object.object_type }, extra));
            const act = command => vscode.postMessage({ command, database, schema: object.schema_name, name: object.object_name, objectType: object.object_type });
            items.push({ label: 'Show details', onClick: () => this.showDetails(row) });
            window.explorerManager._getScriptOptions(object.object_type).forEach((opt, i) => items.push({
                label: `Script as ${opt.label}`,
                separatorBefore: i === 0,
                onClick: () => post('generateInstanceScript', { scriptType: opt.type })
            }));
            items.push({ label: 'Rename…', separatorBefore: true, onClick: () => act('renameInstanceObject') });
            items.push({ label: 'Delete…', onClick: () => act('dropInstanceObject') });
            items.push({ label: 'Copy name', separatorBefore: true, onClick: () => navigator.clipboard.writeText(object.qualified_name).catch(() => {}) });
        } else {
            items.push({ label: 'Refresh', onClick: () => this.refreshDatabase(database) });
            if (row.dataset.kind === 'db') {
                items.push({ label: 'Copy name', onClick: () => navigator.clipboard.writeText(database).catch(() => {}) });
            }
        }
        window.explorerManager._openPopupMenu(row, items, { at });
    }

    _visibleRows() {
        return [...this.tree.querySelectorAll('.instance-row')];
    }

    onKey(event) {
        const row = event.target.closest && event.target.closest('.instance-row');
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const rows = this._visibleRows();
        if (!row) {
            if (event.target === this.tree && rows.length > 0 && (event.key === 'ArrowDown' || event.key === 'Enter')) { event.preventDefault(); rows[0].focus(); }
            return;
        }
        const index = rows.indexOf(row);
        const open = row.getAttribute('aria-expanded') === 'true';
        const isObject = row.dataset.kind === 'object';
        let target = null;
        switch (event.key) {
            case 'ArrowDown': target = rows[index + 1]; break;
            case 'ArrowUp': target = rows[index - 1]; break;
            case 'Home': target = rows[0]; break;
            case 'End': target = rows[rows.length - 1]; break;
            case 'ArrowRight':
                if (!isObject && !open) this.toggle(row.dataset.key);
                else target = rows[index + 1];
                break;
            case 'ArrowLeft':
                if (!isObject && open) this.toggle(row.dataset.key);
                else target = this._parentRow(row, rows, index);
                break;
            case 'Enter':
                if (isObject) this.showDetails(row); else this.toggle(row.dataset.key);
                break;
            case 'ContextMenu':
            case 'F10': {
                if (event.key === 'F10' && !event.shiftKey) return;
                const box = row.getBoundingClientRect();
                this.openMenu(row, { x: box.left + 24, y: box.bottom });
                break;
            }
            case 'F2':
                if (isObject) this._act('renameInstanceObject', row);
                break;
            case 'Delete':
                if (isObject) this._act('dropInstanceObject', row);
                break;
            default: return;
        }
        event.preventDefault();
        if (target) { this.select(target.dataset.key); target.focus(); target.scrollIntoView({ block: 'nearest' }); }
    }

    _act(command, row) {
        vscode.postMessage({ command, database: row.dataset.database, schema: row.dataset.schema, name: row.dataset.object, objectType: row.dataset.type });
    }

    _parentRow(row, rows, index) {
        const depth = Number(row.style.getPropertyValue('--depth'));
        for (let i = index - 1; i >= 0; i--) {
            if (Number(rows[i].style.getPropertyValue('--depth')) < depth) return rows[i];
        }
        return null;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { InstanceTree };
}
