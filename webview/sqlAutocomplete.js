/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// SQL autocompletion for the query textarea.
// Objects come from the already-loaded explorer index (appState.allObjects);
// columns are fetched on demand from the backend and cached per object.
// The pure logic (context extraction, alias parsing, suggestion building)
// lives in static methods so it can be unit-tested without a DOM.
class SqlAutocomplete {
    constructor(textarea) {
        this.textarea = textarea;
        this.container = textarea.parentElement;

        this.dropdown = document.createElement('ul');
        this.dropdown.className = 'sql-autocomplete';
        this.dropdown.style.display = 'none';
        this.container.appendChild(this.dropdown);

        this.mirror = null;
        this.items = [];
        this.selectedIndex = 0;
        this.ctx = null;
        this.columnsCache = {};       // qualified name (lower) -> [{ name, type }]
        this.pendingColumns = new Set();

        this.initEventListeners();
    }

    // === Event wiring ===

    initEventListeners() {
        this.textarea.addEventListener('input', () => this.update());
        this.textarea.addEventListener('keydown', (e) => this.onKeyDown(e));
        // Delay so a mousedown on a suggestion can accept before the dropdown goes away.
        this.textarea.addEventListener('blur', () => setTimeout(() => this.hide(), 150));
        this.textarea.addEventListener('scroll', () => this.hide());
        this.textarea.addEventListener('click', () => this.hide());
    }

    onKeyDown(e) {
        if (!this.isOpen()) {
            if (e.ctrlKey && e.code === 'Space') {
                e.preventDefault();
                this.update(true);
            }
            return;
        }

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                this.select(this.selectedIndex + 1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                this.select(this.selectedIndex - 1);
                break;
            case 'Enter':
            case 'Tab':
                if (e.ctrlKey || e.metaKey) {
                    this.hide(); // let Ctrl+Enter reach the "run query" shortcut
                    return;
                }
                e.preventDefault();
                this.accept();
                break;
            case 'Escape':
                e.preventDefault();
                this.hide();
                break;
        }
    }

    // === Lifecycle ===

    // Called when the database selector changes: cached columns belong to the old db.
    reset() {
        this.columnsCache = {};
        this.pendingColumns.clear();
        this.hide();
    }

    onColumnsLoaded(objectName, columns) {
        const key = (objectName || '').toLowerCase();
        this.pendingColumns.delete(key);
        this.columnsCache[key] = columns || [];
        // Refresh only if the user is still typing in the editor.
        if (document.activeElement === this.textarea) this.update();
    }

    // === Suggestion computation ===

    update(force = false) {
        const objects = (typeof appState !== 'undefined' && appState.allObjects) || [];
        const ctx = SqlAutocomplete.extractContext(this.textarea.value, this.textarea.selectionStart);

        if (!ctx.base && !ctx.partial) {
            this.hide();
            return;
        }

        const aliases = SqlAutocomplete.parseAliases(this.textarea.value);
        const { items, needsColumns } = SqlAutocomplete.buildSuggestions(
            ctx, objects, aliases,
            qualifiedName => this.columnsCache[qualifiedName.toLowerCase()],
            { minLength: force ? 0 : 2 }
        );

        if (needsColumns) this.requestColumns(needsColumns);

        if (items.length === 0) {
            this.hide();
            return;
        }

        this.ctx = ctx;
        this.render(items);
    }

    requestColumns(qualifiedName) {
        const key = qualifiedName.toLowerCase();
        if (this.pendingColumns.has(key) || this.columnsCache[key]) return;
        this.pendingColumns.add(key);
        vscode.postMessage({
            command: 'getObjectColumns',
            database: appState.currentDatabase,
            objectName: qualifiedName
        });
    }

    // === Rendering ===

    render(items) {
        this.items = items;
        this.selectedIndex = 0;
        this.dropdown.innerHTML = '';

        items.forEach((item, index) => {
            const li = document.createElement('li');
            if (index === 0) li.classList.add('selected');

            const icon = document.createElement('span');
            icon.className = 'ac-icon';
            icon.innerHTML = SqlAutocomplete.iconFor(item.kind);
            li.appendChild(icon);

            const label = document.createElement('span');
            label.textContent = item.label;
            li.appendChild(label);

            if (item.detail) {
                const detail = document.createElement('span');
                detail.className = 'ac-detail';
                detail.textContent = item.detail;
                li.appendChild(detail);
            }

            // mousedown fires before the textarea blur, so focus is preserved.
            li.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this.selectedIndex = index;
                this.accept();
            });

            this.dropdown.appendChild(li);
        });

        this.dropdown.style.display = '';
        this.position();
    }

    // Position the dropdown under the caret using the classic mirror-div trick.
    position() {
        const ta = this.textarea;
        if (!this.mirror) {
            this.mirror = document.createElement('div');
            this.mirror.className = 'sql-autocomplete-mirror';
            this.container.appendChild(this.mirror);
        }

        const style = getComputedStyle(ta);
        ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
            'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
            'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
            'boxSizing'].forEach(prop => { this.mirror.style[prop] = style[prop]; });
        this.mirror.style.width = ta.clientWidth + 'px';

        this.mirror.textContent = ta.value.slice(0, ta.selectionStart);
        const marker = document.createElement('span');
        marker.textContent = '​'; // zero-width space: measurable but invisible
        this.mirror.appendChild(marker);

        const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3;
        const top = ta.offsetTop + marker.offsetTop + lineHeight - ta.scrollTop;
        const left = ta.offsetLeft + marker.offsetLeft;

        this.dropdown.style.top = `${top}px`;
        this.dropdown.style.left = `${Math.max(0, Math.min(left, this.container.clientWidth - 260))}px`;
    }

    select(index) {
        if (this.items.length === 0) return;
        this.selectedIndex = (index + this.items.length) % this.items.length;
        [...this.dropdown.children].forEach((li, i) => {
            li.classList.toggle('selected', i === this.selectedIndex);
        });
        this.dropdown.children[this.selectedIndex].scrollIntoView({ block: 'nearest' });
    }

    accept() {
        const item = this.items[this.selectedIndex];
        if (!item || !this.ctx) {
            this.hide();
            return;
        }
        const ta = this.textarea;
        const end = ta.selectionStart;
        ta.value = ta.value.slice(0, this.ctx.partialStart) + item.insert + ta.value.slice(end);
        const caret = this.ctx.partialStart + item.insert.length;
        ta.setSelectionRange(caret, caret);
        this.hide();
    }

    isOpen() {
        return this.dropdown.style.display !== 'none';
    }

    hide() {
        this.dropdown.style.display = 'none';
        this.items = [];
        this.ctx = null;
    }

    static iconFor(kind) {
        switch (kind) {
            case 'Table': return '<i class="codicon codicon-table"></i>';
            case 'View': return '<i class="codicon codicon-eye"></i>';
            case 'Procedure': return '<i class="codicon codicon-gear"></i>';
            case 'Function': return '<i class="codicon codicon-wrench"></i>';
            case 'column': return '▪';
            default: return '<i class="codicon codicon-symbol-keyword"></i>';
        }
    }

    // === Pure logic (unit-testable, no DOM) ===

    // Split the text before the caret into base + partial around the last dot:
    // "SELECT e.Na|" -> { base: 'e', partial: 'Na', partialStart: 9 }
    static extractContext(text, caret) {
        const before = text.slice(0, caret);
        const match = before.match(/[A-Za-z0-9_$#@[\].]*$/);
        const token = match ? match[0] : '';
        const tokenStart = caret - token.length;
        const lastDot = token.lastIndexOf('.');
        if (lastDot === -1) {
            return { base: '', partial: token, partialStart: tokenStart };
        }
        return {
            base: token.slice(0, lastDot),
            partial: token.slice(lastDot + 1),
            partialStart: tokenStart + lastDot + 1
        };
    }

    // Full identifier (dots and brackets included) around an arbitrary position:
    // used by Ctrl+Click "go to definition" in the query editor.
    static wordAt(text, pos) {
        const isWordChar = ch => /[A-Za-z0-9_$#@[\].]/.test(ch);
        let start = pos;
        let end = pos;
        while (start > 0 && isWordChar(text[start - 1])) start--;
        while (end < text.length && isWordChar(text[end])) end++;
        const word = text.slice(start, end).replace(/^\.+|\.+$/g, '');
        return word || null;
    }

    // Scan FROM/JOIN/UPDATE/INTO clauses for "source [AS] alias" pairs.
    static parseAliases(text) {
        const aliases = {};
        const re = /\b(?:from|join|update|into)\s+((?:\[[^\]]+\]|\w+)(?:\s*\.\s*(?:\[[^\]]+\]|\w+))*)(?:\s+(?:as\s+)?(\[[^\]]+\]|\w+))?/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
            const source = m[1].replace(/[[\]\s]/g, '');
            const alias = m[2] ? m[2].replace(/[[\]]/g, '') : null;
            if (alias && !SqlAutocomplete.RESERVED.has(alias.toLowerCase())) {
                aliases[alias.toLowerCase()] = source;
            }
        }
        return aliases;
    }

    // Build the suggestion list for a given context.
    // getColumns(qualifiedName) returns cached columns or undefined; when undefined
    // is hit, needsColumns tells the caller which object to fetch.
    static buildSuggestions(ctx, objects, aliases, getColumns, options = {}) {
        const minLength = options.minLength === undefined ? 2 : options.minLength;
        const partial = (ctx.partial || '').toLowerCase();
        const items = [];

        // Top level: keywords + object names
        if (!ctx.base) {
            if (partial.length < minLength) return { items };
            for (const kw of SqlAutocomplete.KEYWORDS) {
                if (kw.toLowerCase().startsWith(partial)) {
                    items.push({ label: kw, insert: kw, kind: 'keyword' });
                }
            }
            for (const obj of objects) {
                const bareName = (obj.object_name || obj.name || '').toLowerCase();
                if ((partial && bareName.startsWith(partial)) || obj.qualified_name.toLowerCase().startsWith(partial)) {
                    // obj.name is already schema-qualified except for dbo - exactly what we want to insert
                    items.push({ label: obj.name, insert: obj.name, kind: obj.object_type, detail: obj.object_type });
                }
            }
            return { items: items.slice(0, SqlAutocomplete.MAX_ITEMS) };
        }

        const base = ctx.base.replace(/[[\]]/g, '');
        const baseLower = base.toLowerCase();

        // "schema." -> objects of that schema
        const schemaObjects = objects.filter(o => (o.schema_name || '').toLowerCase() === baseLower);
        if (schemaObjects.length > 0) {
            for (const obj of schemaObjects) {
                if (!partial || obj.object_name.toLowerCase().startsWith(partial)) {
                    items.push({ label: obj.object_name, insert: obj.object_name, kind: obj.object_type, detail: obj.object_type });
                }
            }
            return { items: items.slice(0, SqlAutocomplete.MAX_ITEMS) };
        }

        // "table." or "alias." -> columns
        const target = (aliases[baseLower] || base).toLowerCase();
        const obj = objects.find(o =>
            o.qualified_name.toLowerCase() === target ||
            (o.object_name || '').toLowerCase() === target ||
            (o.name || '').toLowerCase() === target
        );
        if (!obj || (obj.object_type !== 'Table' && obj.object_type !== 'View')) return { items };

        const columns = getColumns(obj.qualified_name);
        if (!columns) return { items, needsColumns: obj.qualified_name };

        for (const col of columns) {
            if (!partial || col.name.toLowerCase().startsWith(partial)) {
                items.push({ label: col.name, insert: col.name, kind: 'column', detail: col.type });
            }
        }
        return { items: items.slice(0, SqlAutocomplete.MAX_ITEMS) };
    }
}

SqlAutocomplete.MAX_ITEMS = 15;

SqlAutocomplete.KEYWORDS = [
    'SELECT', 'FROM', 'WHERE', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN',
    'CROSS JOIN', 'JOIN', 'ON', 'AND', 'OR', 'NOT', 'NULL', 'IS NULL', 'IS NOT NULL',
    'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'ORDER BY', 'GROUP BY', 'HAVING', 'DISTINCT',
    'TOP', 'AS', 'UNION', 'UNION ALL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
    'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'DECLARE', 'BEGIN', 'COMMIT',
    'ROLLBACK', 'TRANSACTION', 'EXEC', 'WITH', 'OVER', 'PARTITION BY',
    'COUNT(*)', 'SUM', 'AVG', 'MIN', 'MAX', 'GETDATE()', 'CAST', 'CONVERT', 'ISNULL', 'COALESCE'
];

// Words that can follow a table name in FROM/JOIN but are never an alias.
SqlAutocomplete.RESERVED = new Set([
    'where', 'on', 'inner', 'left', 'right', 'full', 'cross', 'outer', 'join',
    'group', 'order', 'having', 'set', 'values', 'select', 'union', 'as', 'with',
    'option', 'output', 'when', 'then', 'else', 'end', 'and', 'or', 'not', 'exists',
    'pivot', 'unpivot', 'for'
]);

// Allow unit tests to require() this file; in the webview `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SqlAutocomplete;
}
