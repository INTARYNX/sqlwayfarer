/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// The part of the Explorer that shows the list of objects: the schema groups, the
// keyboard, the context menu and the script menu. It is mixed into ExplorerManager
// (see explorerManager.js), so `this` is the ExplorerManager.
// Methods of ExplorerManager: the list of objects.
class ExplorerObjectListMethods {
    // Jump to the Query tab and run a quick "SELECT TOP 10" on this object
    handlePeekTop10(obj) {
        const bracketed = this._getQualifiedName(obj)
            .split('.')
            // ']' must be doubled to close the bracketed identifier properly
            // ([Foo]]Bar]) - otherwise a name containing ']' breaks out of it.
            .map(part => `[${part.replace(/]/g, ']]')}]`)
            .join('.');
        const sql = `SELECT TOP 10 * FROM ${bracketed}`;

        if (window.tabManager) {
            window.tabManager.switchTab('query');
        }
        if (window.queryManager) {
            window.queryManager.runQueryText(sql);
        }
    }

    // Script types offered by the generate-script button, per object type
    _getScriptOptions(objectType) {
        switch (objectType) {
            case 'Table': return [
                { type: 'select', label: 'SELECT (all columns)' },
                { type: 'insert', label: 'INSERT template' },
                { type: 'update', label: 'UPDATE template' },
                { type: 'create', label: 'CREATE TABLE' }
            ];
            case 'View': return [
                { type: 'select', label: 'SELECT (all columns)' },
                { type: 'create', label: 'CREATE (definition)' },
                { type: 'dropcreate', label: 'DROP and CREATE' }
            ];
            case 'Procedure': return [
                { type: 'exec', label: 'EXEC template' },
                { type: 'create', label: 'CREATE (definition)' },
                { type: 'dropcreate', label: 'DROP and CREATE' }
            ];
            case 'Function': return [
                { type: 'select', label: 'SELECT (call)' },
                { type: 'create', label: 'CREATE (definition)' },
                { type: 'dropcreate', label: 'DROP and CREATE' }
            ];
            default: return [];
        }
    }

    openScriptMenu(anchorBtn, obj) {
        const items = this._getScriptOptions(obj.object_type).map(opt => ({
            label: opt.label,
            onClick: () => vscode.postMessage({
                command: 'generateScript',
                database: appState.currentDatabase,
                objectName: obj.qualified_name || obj.name,
                objectType: obj.object_type,
                scriptType: opt.type
            })
        }));
        this._openPopupMenu(anchorBtn, items, { alignRight: true });
    }

    // Popup mechanics for the script menu and the context menu: one menu open
    // at a time, closed by any outside click or Escape, usable with the
    // keyboard (arrows, Home/End, Enter) - the focus goes back to where it was.
    // `at` ({ x, y }) opens it at a point (right click) instead of under an anchor.
    _openPopupMenu(anchorBtn, items, { alignRight = false, at = null } = {}) {
        this.closePopupMenu();
        if (items.length === 0) return;
        const returnFocus = document.activeElement;

        const menu = document.createElement('div');
        menu.className = 'script-menu';
        menu.setAttribute('role', 'menu');
        items.forEach(({ label, title, onClick, separatorBefore }) => {
            if (separatorBefore) {
                const separator = document.createElement('div');
                separator.className = 'script-menu-separator';
                separator.setAttribute('role', 'separator');
                menu.appendChild(separator);
            }
            const item = document.createElement('button');
            item.className = 'script-menu-item';
            item.setAttribute('role', 'menuitem');
            item.textContent = label;
            if (title) item.title = title;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closePopupMenu();
                onClick();
            });
            menu.appendChild(item);
        });
        menu.addEventListener('keydown', (e) => this._onPopupMenuKey(e, menu, returnFocus));

        document.body.appendChild(menu);
        if (at) {
            menu.style.top = `${Math.max(8, Math.min(at.y, window.innerHeight - menu.offsetHeight - 8))}px`;
            menu.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - menu.offsetWidth - 8))}px`;
        } else {
            const rect = anchorBtn.getBoundingClientRect();
            menu.style.top = `${Math.min(rect.bottom + 2, window.innerHeight - menu.offsetHeight - 8)}px`;
            const left = alignRight ? rect.right - menu.offsetWidth : rect.left;
            menu.style.left = `${Math.min(Math.max(8, left), window.innerWidth - menu.offsetWidth - 8)}px`;
        }

        this._popupMenu = menu;
        this._popupMenuCloser = (e) => {
            if (!menu.contains(e.target)) this.closePopupMenu();
        };
        // Deferred so the opening click does not immediately close the menu
        setTimeout(() => document.addEventListener('click', this._popupMenuCloser), 0);
        const first = menu.querySelector('.script-menu-item');
        if (first) first.focus();
    }

    _onPopupMenuKey(event, menu, returnFocus) {
        const entries = [...menu.querySelectorAll('.script-menu-item')];
        const index = entries.indexOf(document.activeElement);
        let next = null;
        switch (event.key) {
            case 'ArrowDown': next = entries[(index + 1) % entries.length]; break;
            case 'ArrowUp': next = entries[(index - 1 + entries.length) % entries.length]; break;
            case 'Home': next = entries[0]; break;
            case 'End': next = entries[entries.length - 1]; break;
            case 'Escape':
            case 'Tab':
                event.preventDefault();
                this.closePopupMenu();
                if (returnFocus && returnFocus.focus) returnFocus.focus();
                return;
            default: return;
        }
        event.preventDefault();
        if (next) next.focus();
    }

    closePopupMenu() {
        if (this._popupMenu) {
            this._popupMenu.remove();
            document.removeEventListener('click', this._popupMenuCloser);
            this._popupMenu = null;
            this._popupMenuCloser = null;
        }
    }

    // ---- Keyboard and context menu of the object list ------------------------

    // The rows that can be reached now: the schema headers, and the objects
    // that are neither filtered out nor in a collapsed schema.
    _visibleObjectRows() {
        return [...this.elements.objectList.querySelectorAll('.schema-header:not(.hidden), .object-item:not(.hidden):not(.schema-collapsed)')];
    }

    initObjectListKeyboard() {
        const list = this.elements.objectList;
        // One tab stop for the whole list; the rows are moved between with the
        // arrow keys (their own tabindex is -1).
        list.tabIndex = 0;
        list.setAttribute('role', 'tree');
        list.setAttribute('aria-label', 'Database objects');
        list.addEventListener('focus', (e) => {
            // Coming from outside: go to the selected object, or the first row.
            if (e.target !== list || list.contains(e.relatedTarget)) return;
            const rows = this._visibleObjectRows();
            const target = rows.find(r => r.classList.contains('selected')) || rows[0];
            if (target) target.focus();
        });
        list.addEventListener('keydown', (e) => this._onObjectListKey(e));
        list.addEventListener('contextmenu', (e) => {
            const row = e.target.closest('.object-item');
            if (!row) return;
            e.preventDefault();
            this.openObjectContextMenu(row, { x: e.clientX, y: e.clientY });
        });
    }

    _onObjectListKey(event) {
        const row = event.target.closest('.schema-header, .object-item');
        if (!row || event.altKey || event.ctrlKey || event.metaKey) return;
        const rows = this._visibleObjectRows();
        const index = rows.indexOf(row);
        const isHeader = row.classList.contains('schema-header');
        let target = null;

        switch (event.key) {
            case 'ArrowDown': target = rows[index + 1]; break;
            case 'ArrowUp': target = rows[index - 1]; break;
            case 'PageDown': target = rows[Math.min(index + 10, rows.length - 1)]; break;
            case 'PageUp': target = rows[Math.max(index - 10, 0)]; break;
            case 'Home': target = rows[0]; break;
            case 'End': target = rows[rows.length - 1]; break;
            case 'ArrowRight':
                if (isHeader) {
                    if (row.classList.contains('collapsed')) this._toggleSchemaCollapse(row.dataset.schema);
                    else target = rows[index + 1] && !rows[index + 1].classList.contains('schema-header') ? rows[index + 1] : null;
                }
                break;
            case 'ArrowLeft':
                if (isHeader) {
                    if (!row.classList.contains('collapsed')) this._toggleSchemaCollapse(row.dataset.schema);
                } else {
                    target = this.elements.objectList.querySelector(`.schema-header[data-schema="${CSS.escape(row.dataset.schema)}"]`);
                }
                break;
            case 'Enter':
            case ' ':
                if (isHeader) this._toggleSchemaCollapse(row.dataset.schema);
                else row.click();
                break;
            case 'ContextMenu':
                if (!isHeader) {
                    const box = row.getBoundingClientRect();
                    this.openObjectContextMenu(row, { x: box.left + 24, y: box.bottom });
                }
                break;
            case 'F10':
                if (event.shiftKey && !isHeader) {
                    const box = row.getBoundingClientRect();
                    this.openObjectContextMenu(row, { x: box.left + 24, y: box.bottom });
                    break;
                }
                return;
            default:
                // Typing the start of a name jumps to the next object that begins with it.
                if (event.key.length === 1 && /\S/.test(event.key)) {
                    this._objectTypeahead = (this._objectTypeahead || '') + event.key.toLowerCase();
                    clearTimeout(this._objectTypeaheadTimer);
                    this._objectTypeaheadTimer = setTimeout(() => { this._objectTypeahead = ''; }, 600);
                    const needle = this._objectTypeahead;
                    const ordered = rows.slice(index + 1).concat(rows.slice(0, index + 1));
                    target = ordered.find(r => (r.querySelector('.object-name-with-icon, .schema-name')?.textContent || '').trim().toLowerCase().startsWith(needle));
                    break;
                }
                return;
        }
        event.preventDefault();
        if (target) {
            target.focus();
            target.scrollIntoView({ block: 'nearest' });
        }
    }

    // Right click (or the menu key) on an object: what the row's own buttons
    // offer, plus opening its details and copying its name.
    openObjectContextMenu(row, at) {
        const obj = (appState.allObjects || []).find(o => o.name === row.dataset.name);
        if (!obj) return;
        const database = appState.currentDatabase;
        const qualified = this._getQualifiedName(obj);
        const items = [{ label: 'Show details', onClick: () => this.handleObjectClick(row, obj) }];
        if (obj.object_type === 'Table' || obj.object_type === 'View') {
            items.push({ label: 'Select top 10 rows', onClick: () => this.handlePeekTop10(obj) });
        }
        this._getScriptOptions(obj.object_type).forEach((opt, i) => items.push({
            label: `Script: ${opt.label}`,
            separatorBefore: i === 0,
            onClick: () => vscode.postMessage({
                command: 'generateScript', database, objectName: qualified, objectType: obj.object_type, scriptType: opt.type
            })
        }));
        items.push({
            label: 'Copy name',
            separatorBefore: true,
            onClick: () => navigator.clipboard.writeText(qualified).catch(() => {})
        });
        this._openPopupMenu(row, items, { at });
    }

    _buildStatsBadge(qualifiedName) {
        const stats = this.tableStats.get(qualifiedName);
        if (!stats) return null;

        const badge = document.createElement('span');
        badge.className = 'object-stats';
        badge.textContent = `${this._formatCompactCount(stats.row_count)} · ${this._formatKb(stats.reserved_kb)}`;
        badge.title = `${Number(stats.row_count).toLocaleString('en-US')} rows · ${this._formatKb(stats.reserved_kb)} reserved`;
        return badge;
    }

    _formatCompactCount(n) {
        n = Number(n) || 0;
        if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
        return String(n);
    }

    _formatKb(kb) {
        kb = Number(kb) || 0;
        if (kb >= 1024 * 1024) return (kb / (1024 * 1024)).toFixed(1) + ' GB';
        if (kb >= 1024) return (kb / 1024).toFixed(1) + ' MB';
        return `${kb} KB`;
    }

    displayObjects(objects) {
        this.elements.objectList.innerHTML = '';
        this._objectItemsByName.clear();

        if (objects.length === 0) {
            this.elements.objectList.innerHTML = '<p class="placeholder-text">No objects found in this database.</p>';
            return;
        }

        const objectsBySchema = this._groupObjectsBySchema(objects);

        Object.keys(objectsBySchema).sort().forEach(schema => {
            if (schema !== 'dbo' || Object.keys(objectsBySchema).length > 1) {
                const schemaHeader = document.createElement('div');
                schemaHeader.className = 'schema-header';
                // dataset lets the filter update the badge and hide empty schemas
                schemaHeader.dataset.schema = schema;
                schemaHeader.dataset.total = objectsBySchema[schema].length;
                schemaHeader.innerHTML = `
                <span class="schema-name"><i class="codicon codicon-chevron-down schema-chevron"></i><i class="codicon codicon-folder"></i> ${this.escapeHtml(schema)}</span>
                <span class="schema-count">(${objectsBySchema[schema].length})</span>
            `;
                schemaHeader.tabIndex = -1;
                schemaHeader.setAttribute('role', 'treeitem');
                schemaHeader.setAttribute('aria-expanded', String(!this._collapsedSchemas.has(schema)));
                schemaHeader.addEventListener('click', () => this._toggleSchemaCollapse(schema));
                this.elements.objectList.appendChild(schemaHeader);
            }

            objectsBySchema[schema].forEach(obj => {
                const div = document.createElement('div');
                div.className = 'object-item';
                div.tabIndex = -1;
                div.setAttribute('role', 'treeitem');

                const objectDisplayName = obj.object_name || obj.name.split('.').pop();

                // Get icon based on object type
                const icon = this._getObjectTypeIcon(obj.object_type);

                const nameSpan = document.createElement('span');
                nameSpan.className = 'object-name-with-icon';
                nameSpan.innerHTML = `${icon} ${this.escapeHtml(objectDisplayName)}`;

                div.appendChild(nameSpan);
                div.dataset.name = obj.name;
                div.dataset.qualifiedName = obj.qualified_name || obj.name;
                div.dataset.type = obj.object_type;
                div.dataset.schema = obj.schema_name || 'dbo';
                this._objectItemsByName.set(obj.name, div);

                if (obj.object_type === 'Table') {
                    const badge = this._buildStatsBadge(div.dataset.qualifiedName);
                    if (badge) div.appendChild(badge);
                }

                if (this._getScriptOptions(obj.object_type).length > 0) {
                    const scriptBtn = document.createElement('button');
                    scriptBtn.className = 'object-script-btn';
                    // Reached from the keyboard through the context menu.
                    scriptBtn.tabIndex = -1;
                    scriptBtn.title = 'Generate a SQL script for this object';
                    scriptBtn.innerHTML = '<i class="codicon codicon-file-code"></i>';
                    scriptBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.openScriptMenu(scriptBtn, obj);
                    });
                    div.appendChild(scriptBtn);
                }

                if (obj.object_type === 'Table' || obj.object_type === 'View') {
                    const peekBtn = document.createElement('button');
                    peekBtn.className = 'object-peek-btn';
                    peekBtn.tabIndex = -1;
                    peekBtn.title = 'Run SELECT TOP 10 * FROM this object';
                    peekBtn.innerHTML = `${swIcon('run')} Top 10`;
                    peekBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.handlePeekTop10(obj);
                    });
                    div.appendChild(peekBtn);
                }

                div.addEventListener('click', () => this.handleObjectClick(div, obj));

                this.elements.objectList.appendChild(div);
            });
        });

        // Shown by the filter when a search matches nothing
        const noMatches = document.createElement('p');
        noMatches.id = 'noMatchesMessage';
        noMatches.className = 'placeholder-text hidden';
        noMatches.textContent = 'No objects match the current search.';
        this.elements.objectList.appendChild(noMatches);

        // Re-apply whichever schemas were already collapsed - displayObjects
        // rebuilds the whole list (new DOM nodes) on every call, so the
        // collapsed/expanded state itself lives in _collapsedSchemas, not the DOM.
        this._applySchemaCollapseState();
    }

    _toggleSchemaCollapse(schema) {
        if (this._collapsedSchemas.has(schema)) {
            this._collapsedSchemas.delete(schema);
        } else {
            this._collapsedSchemas.add(schema);
        }
        this._applySchemaCollapseState();
    }

    _applySchemaCollapseState() {
        this.elements.objectList.querySelectorAll('.schema-header').forEach(header => {
            header.classList.toggle('collapsed', this._collapsedSchemas.has(header.dataset.schema));
            header.setAttribute('aria-expanded', String(!this._collapsedSchemas.has(header.dataset.schema)));
        });
        // A separate class from .hidden (used by the search/type filter) so the
        // two stay independent - an item is visible only when neither hides it.
        this.elements.objectList.querySelectorAll('.object-item').forEach(item => {
            item.classList.toggle('schema-collapsed', this._collapsedSchemas.has(item.dataset.schema));
        });
    }

    _getObjectTypeIcon(objectType) {
        return swObjectIcon(objectType, null);
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
                const typeA = a.object_type || '';
                const typeB = b.object_type || '';
                if (typeA !== typeB) return typeA.localeCompare(typeB);
                return (a.name || '').localeCompare(b.name || '');
            });
        });

        return grouped;
    }

    // Renders the auto-generated call snippet (EXEC/SELECT template) requested
    // from onObjectDetailsLoaded. Guards against a stale response landing after
    // the user has since selected a different object.
    onScriptGenerated(objectName, script) {
        if (objectName !== this._pendingCallSnippetFor) return;
        const section = document.getElementById('callSnippetSection');
        if (!section) return;

        section.innerHTML = `
            <div class="section-header">Call snippet</div>
            <div class="call-snippet-actions">
                <button type="button" id="copyCallSnippetBtn" title="Copy to clipboard"><i class="codicon codicon-copy"></i> Copy</button>
                <button type="button" id="insertCallSnippetBtn" title="Insert into the query editor"><i class="codicon codicon-insert"></i> Insert in editor</button>
            </div>
            <pre class="call-snippet-code">${this.escapeHtml(script)}</pre>
        `;

        document.getElementById('copyCallSnippetBtn').addEventListener('click', (e) => {
            navigator.clipboard.writeText(script).then(() => {
                const btn = e.currentTarget;
                const original = btn.innerHTML;
                btn.innerHTML = '<i class="codicon codicon-check"></i> Copied';
                setTimeout(() => { btn.innerHTML = original; }, 1500);
            });
        });
        document.getElementById('insertCallSnippetBtn').addEventListener('click', () => {
            if (window.tabManager) window.tabManager.switchTab('query');
            if (window.queryManager) window.queryManager.setQueryText(script);
        });
    }
}
