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

        this.items = [];
        this.selectedIndex = 0;
        this.ctx = null;
        this.columnsCache = {};       // "database::qualifiedName" (lower) -> [{ name, type }]
        this.pendingColumns = new Set();
        this.objectsCache = {};       // database (lower) -> objects[], for cross-database references
        this.pendingObjectsDbs = new Set();

        this.initEventListeners();
    }

    // === Event wiring ===

    initEventListeners() {
        this.textarea.addEventListener('input', () => this.update());
        // Capture phase on purpose: the editor handles keys on its own
        // contenteditable (a descendant of the container), so a bubble-phase
        // listener here would run *after* CodeMirror already inserted a
        // newline for Enter/Tab or moved the cursor for the arrow keys.
        // Capturing on the container runs first, and stopPropagation() then
        // keeps the key away from CodeMirror entirely.
        this.textarea.addEventListener('keydown', (e) => this.onKeyDown(e), true);
        // Delay so a mousedown on a suggestion can accept before the dropdown goes away.
        this.textarea.addEventListener('blur', () => setTimeout(() => this.hide(), 150));
        this.textarea.addEventListener('scroll', () => this.hide());
        this.textarea.addEventListener('click', () => this.hide());
    }

    // Is the editor focused? The element that holds the focus is CodeMirror's
    // contenteditable (.cm-content), a *descendant* of the container, so
    // `document.activeElement === container` is never true - the adapter
    // exposes the real answer.
    isEditorFocused() {
        if (typeof this.textarea.isFocused === 'function') return this.textarea.isFocused();
        return document.activeElement === this.textarea;
    }

    onKeyDown(e) {
        if (!this.isOpen()) {
            if (e.ctrlKey && e.code === 'Space') {
                e.preventDefault();
                e.stopPropagation();
                this.update(true);
            }
            return;
        }

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                e.stopPropagation();
                this.select(this.selectedIndex + 1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                e.stopPropagation();
                this.select(this.selectedIndex - 1);
                break;
            case 'Enter':
            case 'Tab':
                if (e.ctrlKey || e.metaKey) {
                    this.hide(); // let Ctrl+Enter reach the "run query" shortcut
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                this.accept();
                break;
            case 'Escape':
                e.preventDefault();
                e.stopPropagation();
                this.hide();
                break;
        }
    }

    // === Lifecycle ===

    // Called when the database selector changes. The column/object caches are
    // keyed by database name already, so they stay valid across a switch -
    // only the open dropdown (built against the old context) needs closing.
    reset() {
        this.hide();
    }

    // Called on every (re)connection: a new connection may point at a
    // different server, so previously cached cross-database objects/columns
    // could now be wrong - unlike reset(), this does need to wipe them.
    onConnected() {
        this.objectsCache = {};
        this.pendingObjectsDbs.clear();
        this.columnsCache = {};
        this.pendingColumns.clear();
        this.hide();
    }

    onColumnsLoaded(database, objectName, columns) {
        const key = SqlAutocomplete._colKey(database, objectName);
        this.pendingColumns.delete(key);
        this.columnsCache[key] = columns || [];
        // Refresh only if the user is still typing in the editor.
        if (this.isEditorFocused()) this.update();
    }

    // Objects of a database other than the one currently selected, fetched on
    // demand for a three-part "Database.Schema.Object" reference.
    onDatabaseObjectsLoaded(database, objects) {
        const key = (database || '').toLowerCase();
        this.pendingObjectsDbs.delete(key);
        this.objectsCache[key] = objects || [];
        if (this.isEditorFocused()) this.update();
    }

    // === Suggestion computation ===

    update(force = false) {
        const objects = (typeof appState !== 'undefined' && appState.allObjects) || [];
        const databases = (typeof appState !== 'undefined' && appState.databases) || [];
        const currentDatabase = typeof appState !== 'undefined' ? appState.currentDatabase : null;
        const text = this.textarea.value;
        const caret = this.textarea.selectionStart;

        // "... JOIN Orders o ON" just typed: offer the FK-based condition
        // before falling back to plain keyword/object completion.
        const joinCtx = SqlAutocomplete.extractJoinOnContext(text, caret);
        if (joinCtx) {
            const foreignKeys = (typeof appState !== 'undefined' && appState.foreignKeys) || [];
            const joinItems = SqlAutocomplete.buildJoinConditionSuggestions(joinCtx, objects, text.slice(0, caret), foreignKeys);
            if (joinItems.length > 0) {
                this.ctx = { partialStart: caret };
                this.render(joinItems);
                return;
            }
        }

        const ctx = SqlAutocomplete.extractContext(text, caret);

        if (!ctx.base && !ctx.partial) {
            this.hide();
            return;
        }

        const aliases = SqlAutocomplete.parseAliases(this.textarea.value);
        const { items, needsColumns, needsDatabaseObjects } = SqlAutocomplete.buildSuggestions(
            ctx, objects, aliases,
            (database, qualifiedName) => this.columnsCache[SqlAutocomplete._colKey(database, qualifiedName)],
            {
                minLength: force ? 0 : 2,
                databases,
                currentDatabase,
                getDatabaseObjects: database => this.objectsCache[(database || '').toLowerCase()]
            }
        );

        if (needsColumns) this.requestColumns(needsColumns.database, needsColumns.qualifiedName);
        if (needsDatabaseObjects) this.requestDatabaseObjects(needsDatabaseObjects);

        if (items.length === 0) {
            this.hide();
            return;
        }

        this.ctx = ctx;
        this.render(items);
    }

    requestColumns(database, qualifiedName) {
        const key = SqlAutocomplete._colKey(database, qualifiedName);
        if (this.pendingColumns.has(key) || this.columnsCache[key]) return;
        this.pendingColumns.add(key);
        vscode.postMessage({ command: 'getObjectColumns', database, objectName: qualifiedName });
    }

    requestDatabaseObjects(database) {
        const key = (database || '').toLowerCase();
        if (this.pendingObjectsDbs.has(key) || this.objectsCache[key]) return;
        this.pendingObjectsDbs.add(key);
        vscode.postMessage({ command: 'getAutocompleteObjects', database });
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

    // Position the dropdown under the caret. coordsAtOffset (sqlEditor.js,
    // backed by CodeMirror's coordsAtPos) returns pixel coordinates already
    // relative to the editor container, which exactly fills query-input-wrap
    // (inset:0, no border/padding of its own) - the same element this.dropdown
    // is anchored to, so no extra translation is needed.
    position() {
        const ta = this.textarea;
        const coords = ta.coordsAtOffset(ta.selectionStart);
        if (!coords) return;

        this.dropdown.style.top = `${coords.bottom}px`;
        this.dropdown.style.left = `${Math.max(0, Math.min(coords.left, this.container.clientWidth - 260))}px`;
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
            case 'Database': return '<i class="codicon codicon-database"></i>';
            case 'column': return '▪';
            case 'joinCondition': return '<i class="codicon codicon-references"></i>';
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
        // The keyword right before the token - "exec"/"execute" is what makes a
        // bare procedure name a sensible suggestion instead of noise.
        const precedingKeyword = SqlAutocomplete._wordBefore(text, tokenStart);
        if (lastDot === -1) {
            return { base: '', partial: token, partialStart: tokenStart, precedingKeyword };
        }
        return {
            base: token.slice(0, lastDot),
            partial: token.slice(lastDot + 1),
            partialStart: tokenStart + lastDot + 1,
            precedingKeyword
        };
    }

    // Nearest word immediately before a position, lowercased ("" if none).
    static _wordBefore(text, pos) {
        const m = text.slice(0, pos).match(/(\w+)\s*$/);
        return m ? m[1].toLowerCase() : '';
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

    // Scan FROM/JOIN/UPDATE/INTO clauses for every "source [AS] alias" pair,
    // alias included even when absent (needed by the join-condition lookup,
    // which must also find unaliased tables already in scope).
    static scanTableRefs(text) {
        const refs = [];
        const re = /\b(?:from|join|update|into)\s+((?:\[[^\]]+\]|\w+)(?:\s*\.\s*(?:\[[^\]]+\]|\w+))*)(?:\s+(?:as\s+)?(\[[^\]]+\]|\w+))?/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
            const source = m[1].replace(/[[\]\s]/g, '');
            let alias = m[2] ? m[2].replace(/[[\]]/g, '') : null;
            if (alias && SqlAutocomplete.RESERVED.has(alias.toLowerCase())) alias = null;
            refs.push({ source, alias });
        }
        return refs;
    }

    // alias (lowercase) -> source, for refs that actually have one.
    static parseAliases(text) {
        const aliases = {};
        for (const { source, alias } of SqlAutocomplete.scanTableRefs(text)) {
            if (alias) aliases[alias.toLowerCase()] = source;
        }
        return aliases;
    }

    // Resolve a bare/schema-qualified name typed in the editor to the matching
    // entry in the explorer's object index.
    static _resolveObjectRef(ref, objects) {
        const target = ref.replace(/[[\]]/g, '').toLowerCase();
        return SqlAutocomplete._objectIndex(objects).byName.get(target);
    }

    // Index over an object list: name -> object, schema -> objects, and the
    // pre-lowered names used to match a prefix. Built once per list (the
    // explorer replaces the list as a whole, it never mutates it in place)
    // and cached by the list's identity - see _objectIndexCache.
    //
    // Without it, every keystroke walked the whole list three times over
    // (once for the suggestions, once per table already cited for the join
    // conditions, once for the schema) and lowercased every name on the
    // way: on a 20 000 object database that is hundreds of thousands of
    // string allocations per character typed.
    static _objectIndex(objects) {
        const list = objects || [];
        let index = SqlAutocomplete._objectIndexCache.get(list);
        if (index) return index;

        index = { byName: new Map(), bySchema: new Map(), entries: [] };
        for (const obj of list) {
            const qualified = (obj.qualified_name || '').toLowerCase();
            const bare = (obj.object_name || obj.name || '').toLowerCase();
            const name = (obj.name || '').toLowerCase();

            // A reference can be the qualified name, the object name or the
            // bare name: the first object answering to any of them wins,
            // exactly like the linear search this replaces.
            for (const key of [qualified, bare, name]) {
                if (key && !index.byName.has(key)) index.byName.set(key, obj);
            }

            const schema = (obj.schema_name || '').toLowerCase();
            if (schema) {
                let schemaObjects = index.bySchema.get(schema);
                if (!schemaObjects) {
                    schemaObjects = [];
                    index.bySchema.set(schema, schemaObjects);
                }
                schemaObjects.push(obj);
            }

            index.entries.push({ obj, bare, qualified });
        }

        SqlAutocomplete._objectIndexCache.set(list, index);
        return index;
    }

    // Detect "... [INNER|LEFT|RIGHT|FULL|CROSS] JOIN <table> [[AS] alias] ON"
    // with nothing typed after ON yet - the moment to offer a FK-based condition.
    static extractJoinOnContext(text, caret) {
        const before = text.slice(0, caret);
        const re = /\b(?:(?:inner|cross)\s+|(?:left|right|full)\s+(?:outer\s+)?)?join\s+((?:\[[^\]]+\]|\w+)(?:\s*\.\s*(?:\[[^\]]+\]|\w+))*)(?:\s+(?:as\s+)?(\[[^\]]+\]|\w+))?\s+on\s*$/i;
        const m = re.exec(before);
        if (!m) return null;
        return {
            table: m[1].replace(/[[\]\s]/g, ''),
            alias: m[2] ? m[2].replace(/[[\]]/g, '') : null
        };
    }

    // Raw FK rows (one per column) between two tables, direction-agnostic,
    // grouped back into one edge per constraint for composite keys.
    static _fkEdgesBetween(foreignKeys, tableA, tableB) {
        const a = tableA.toLowerCase();
        const b = tableB.toLowerCase();
        const byName = new Map();
        for (const fk of foreignKeys || []) {
            const from = (fk.fromTable || '').toLowerCase();
            const to = (fk.toTable || '').toLowerCase();
            if (!((from === a && to === b) || (from === b && to === a))) continue;
            if (!byName.has(fk.fkName)) {
                byName.set(fk.fkName, { fkName: fk.fkName, fromTable: fk.fromTable, toTable: fk.toTable, pairs: [] });
            }
            byName.get(fk.fkName).pairs.push({ fromColumn: fk.fromColumn, toColumn: fk.toColumn });
        }
        return [...byName.values()];
    }

    // "a.Col1 = b.Col1 AND a.Col2 = b.Col2", aliases placed on the side that
    // matches the FK's own direction (not insertion order).
    static _formatJoinCondition(edge, newTable, newAlias, otherAlias) {
        const fromIsNew = edge.fromTable.toLowerCase() === newTable.toLowerCase();
        const fromAlias = fromIsNew ? newAlias : otherAlias;
        const toAlias = fromIsNew ? otherAlias : newAlias;
        return edge.pairs.map(p => `${fromAlias}.${p.fromColumn} = ${toAlias}.${p.toColumn}`).join(' AND ');
    }

    // One suggestion per FK relationship found between the table just joined
    // and any table already in scope - exactly SQL Prompt's "join suggestion".
    static buildJoinConditionSuggestions(joinCtx, objects, textBeforeCaret, foreignKeys) {
        if (!foreignKeys || foreignKeys.length === 0) return [];

        const newObj = SqlAutocomplete._resolveObjectRef(joinCtx.table, objects);
        if (!newObj) return [];
        // Without an explicit alias, SQL Server's implicit correlation name is
        // the bare table name - not whatever schema prefix the user typed.
        const newAlias = joinCtx.alias || newObj.object_name || newObj.name;
        const newTableLower = joinCtx.table.replace(/[[\]]/g, '').toLowerCase();

        const priorRefs = SqlAutocomplete.scanTableRefs(textBeforeCaret)
            .filter(r => r.source.toLowerCase() !== newTableLower);

        const items = [];
        const seenFk = new Set();
        for (const ref of priorRefs) {
            const otherObj = SqlAutocomplete._resolveObjectRef(ref.source, objects);
            if (!otherObj || otherObj.qualified_name.toLowerCase() === newObj.qualified_name.toLowerCase()) continue;
            const otherAlias = ref.alias || otherObj.object_name || otherObj.name;

            for (const edge of SqlAutocomplete._fkEdgesBetween(foreignKeys, newObj.qualified_name, otherObj.qualified_name)) {
                if (seenFk.has(edge.fkName)) continue;
                seenFk.add(edge.fkName);
                const condition = SqlAutocomplete._formatJoinCondition(edge, newObj.qualified_name, newAlias, otherAlias);
                items.push({ label: condition, insert: condition, kind: 'joinCondition', detail: `FK ${edge.fkName}` });
            }
        }
        return items;
    }

    // Build the suggestion list for a given context.
    // getColumns(database, qualifiedName) returns cached columns or undefined;
    // when undefined is hit, needsColumns tells the caller which {database,
    // qualifiedName} to fetch. options.databases/currentDatabase/
    // getDatabaseObjects(database) are what make a three-part
    // "Database.Schema.Object" reference work - see _resolveWithinDatabase.
    static buildSuggestions(ctx, objects, aliases, getColumns, options = {}) {
        const minLength = options.minLength === undefined ? 2 : options.minLength;
        const partial = (ctx.partial || '').toLowerCase();
        const items = [];
        // A bare procedure name only makes sense right after EXEC/EXECUTE -
        // offering it after SELECT/WHERE/etc. is just noise.
        const execContext = SqlAutocomplete.EXEC_KEYWORDS.has(ctx.precedingKeyword);

        // Top level: keywords + database names + object names
        if (!ctx.base) {
            if (partial.length < minLength) return { items };
            for (const kw of SqlAutocomplete.KEYWORDS) {
                if (kw.toLowerCase().startsWith(partial)) {
                    items.push({ label: kw, insert: kw, kind: 'keyword' });
                }
            }
            for (const db of options.databases || []) {
                if (db.toLowerCase().startsWith(partial)) {
                    items.push({ label: db, insert: db, kind: 'Database', detail: 'Database' });
                }
            }
            items.push(...SqlAutocomplete._flatObjectItems(objects, partial, execContext));
            return { items: items.slice(0, SqlAutocomplete.MAX_ITEMS) };
        }

        const base = ctx.base.replace(/[[\]]/g, '');
        const baseLower = base.toLowerCase();
        // An alias may itself point at a cross-database table ("FROM
        // OtherDb.dbo.Orders o" then "o.") - resolve it before checking for a
        // leading database segment, not after.
        const resolvedBase = (aliases[baseLower] || base).replace(/[[\]]/g, '');
        const segments = resolvedBase.split('.');
        const databases = options.databases || [];
        const firstLower = segments[0].toLowerCase();
        const isCrossDb = databases.some(db => db.toLowerCase() === firstLower);

        if (isCrossDb) {
            const database = segments[0];
            const remainder = segments.slice(1).join('.');
            const isCurrent = (options.currentDatabase || '').toLowerCase() === firstLower;
            const dbObjects = isCurrent ? objects : (options.getDatabaseObjects && options.getDatabaseObjects(database));
            if (!dbObjects) return { items: [], needsDatabaseObjects: database };

            return SqlAutocomplete._resolveWithinDatabase(database, remainder, partial, dbObjects, {}, getColumns, execContext);
        }

        return SqlAutocomplete._resolveWithinDatabase(options.currentDatabase, base, partial, objects, aliases, getColumns, execContext);
    }

    // Every non-Procedure object matching partial, plus Procedures too when
    // execContext is set (right after EXEC/EXECUTE). Shared by the top-level
    // branch and the empty-remainder case of a "Database." reference.
    static _flatObjectItems(objects, partial, execContext) {
        const items = [];
        for (const entry of SqlAutocomplete._objectIndex(objects).entries) {
            const obj = entry.obj;
            if (obj.object_type === 'Procedure' && !execContext) continue;
            if ((partial && entry.bare.startsWith(partial)) || entry.qualified.startsWith(partial)) {
                // obj.name is already schema-qualified except for dbo - exactly what we want to insert
                items.push({ label: obj.name, insert: obj.name, kind: obj.object_type, detail: obj.object_type });
            }
        }
        return items;
    }

    // Resolves what comes after a dot within one database's object list:
    // nothing yet ("Database.|") lists everything, a schema name lists that
    // schema's objects, and a table/alias lists its columns (needsColumns
    // includes which database to fetch them from).
    static _resolveWithinDatabase(database, base, partial, objects, aliases, getColumns, execContext) {
        if (!base) {
            return { items: SqlAutocomplete._flatObjectItems(objects, partial, execContext).slice(0, SqlAutocomplete.MAX_ITEMS) };
        }

        const items = [];
        const baseLower = base.toLowerCase();

        // "schema." -> objects of that schema
        const schemaObjects = SqlAutocomplete._objectIndex(objects).bySchema.get(baseLower) || [];
        if (schemaObjects.length > 0) {
            for (const obj of schemaObjects) {
                if (!partial || obj.object_name.toLowerCase().startsWith(partial)) {
                    items.push({ label: obj.object_name, insert: obj.object_name, kind: obj.object_type, detail: obj.object_type });
                }
            }
            return { items: items.slice(0, SqlAutocomplete.MAX_ITEMS) };
        }

        // "table." or "alias." -> columns
        const obj = SqlAutocomplete._resolveObjectRef(aliases[baseLower] || base, objects);
        if (!obj || (obj.object_type !== 'Table' && obj.object_type !== 'View')) return { items };

        const columns = getColumns(database, obj.qualified_name);
        if (!columns) return { items, needsColumns: { database, qualifiedName: obj.qualified_name } };

        for (const col of columns) {
            if (!partial || col.name.toLowerCase().startsWith(partial)) {
                items.push({ label: col.name, insert: col.name, kind: 'column', detail: col.type });
            }
        }
        return { items: items.slice(0, SqlAutocomplete.MAX_ITEMS) };
    }

    static _colKey(database, qualifiedName) {
        return `${(database || '').toLowerCase()}::${(qualifiedName || '').toLowerCase()}`;
    }
}

SqlAutocomplete.MAX_ITEMS = 15;

// Index over an object list, cached by the list's identity. The explorer
// replaces the list as a whole (it never mutates it in place), so a new
// list means a new index and the old one is collected with its list.
SqlAutocomplete._objectIndexCache = new WeakMap();

// Keywords after which a bare procedure name is a sensible suggestion.
SqlAutocomplete.EXEC_KEYWORDS = new Set(['exec', 'execute']);

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
