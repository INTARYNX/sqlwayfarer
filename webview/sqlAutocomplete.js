/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// SqlContext (sqlContext.js) and SqlMatcher (sqlMatcher.js) are globals, like
// every class shared between the webview's classic scripts.

// SQL autocompletion for the query editor.
// Objects come from the already-loaded explorer index (appState.allObjects);
// columns are fetched on demand from the backend and cached per object.
// The pure logic lives in static methods so it can be unit-tested without a
// DOM: compute() is the entry point (context via SqlContext, ranking via
// SqlMatcher, behaviour via the sqlwayfarer.autocomplete.* settings).
// The older building blocks (extractContext, buildSuggestions, join
// conditions...) are still used by it, and are tested on their own.
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
        this.paramsCache = {};        // "database::qualifiedName" (lower) -> [{ name, type, isOutput }]
        this.pendingParams = new Set();
        this.customSnippets = [];     // the user's own snippets, offered by name
        this.pendingForce = false;    // the list was forced (Ctrl+Space) while data was still loading
        this.settings = SqlAutocomplete.normalizeSettings(null);
        this.usage = new Map();       // usageKey -> times accepted (this session)

        this.initEventListeners();
        vscode.postMessage({ command: 'getAutocompleteSettings' });
    }

    setSnippets(snippets) {
        this.customSnippets = snippets || [];
    }

    // Settings arrive from the extension host (sqlwayfarer.autocomplete.*).
    applySettings(raw) {
        this.settings = SqlAutocomplete.normalizeSettings(raw);
        if (!this.settings.enabled) this.hide();
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
            case 'Tab': {
                if (e.ctrlKey || e.metaKey) {
                    this.hide(); // let Ctrl+Enter reach the "run query" shortcut
                    return;
                }
                const keys = this.settings.acceptKeys;
                if ((e.key === 'Enter' && keys === 'tab') || (e.key === 'Tab' && keys === 'enter')) {
                    this.hide(); // that key is not an accept key: the editor gets it
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                this.accept();
                break;
            }
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
        this.paramsCache = {};
        this.pendingParams.clear();
        this.hide();
    }

    onColumnsLoaded(database, objectName, columns) {
        const key = SqlAutocomplete._colKey(database, objectName);
        this.pendingColumns.delete(key);
        this.columnsCache[key] = columns || [];
        this.refreshAfterLoad();
    }

    onParametersLoaded(database, objectName, parameters) {
        const key = SqlAutocomplete._colKey(database, objectName);
        this.pendingParams.delete(key);
        this.paramsCache[key] = parameters || [];
        this.refreshAfterLoad();
    }

    // Refresh only if the user is still typing in the editor; a list forced with
    // Ctrl+Space while the data was loading stays forced.
    refreshAfterLoad() {
        if (!this.isEditorFocused()) return;
        const force = this.pendingForce;
        this.pendingForce = false;
        this.update(force);
    }

    // Objects of a database other than the one currently selected, fetched on
    // demand for a three-part "Database.Schema.Object" reference.
    onDatabaseObjectsLoaded(database, objects) {
        const key = (database || '').toLowerCase();
        this.pendingObjectsDbs.delete(key);
        this.objectsCache[key] = objects || [];
        this.refreshAfterLoad();
    }

    // === Suggestion computation ===

    update(force = false) {
        if (!this.settings.enabled) { this.hide(); return; }
        if (!force && !this.settings.autoTrigger && !this.isOpen()) return;

        const state = typeof appState !== 'undefined' ? appState : {};
        const result = SqlAutocomplete.compute(this.textarea.value, this.textarea.selectionStart, {
            objects: state.allObjects || [],
            databases: state.databases || [],
            currentDatabase: state.currentDatabase || null,
            foreignKeys: state.foreignKeys || [],
            getColumns: (database, qualifiedName) => this.columnsCache[SqlAutocomplete._colKey(database, qualifiedName)],
            getDatabaseObjects: database => this.objectsCache[(database || '').toLowerCase()],
            getParameters: (database, qualifiedName) => this.paramsCache[SqlAutocomplete._colKey(database, qualifiedName)],
            snippets: this.customSnippets,
            settings: this.settings,
            usage: this.usage,
            force
        });

        for (const need of result.needs.columns) this.requestColumns(need.database, need.qualifiedName);
        for (const database of result.needs.databaseObjects) this.requestDatabaseObjects(database);
        for (const need of result.needs.parameters) this.requestParameters(need.database, need.qualifiedName);
        const loading = result.needs.columns.length + result.needs.databaseObjects.length + result.needs.parameters.length > 0;
        if (loading) this.pendingForce = force;

        if (result.items.length === 0) {
            this.hide();
            return;
        }
        this.ctx = result.ctx;
        this.render(result.items);
    }

    requestColumns(database, qualifiedName) {
        const key = SqlAutocomplete._colKey(database, qualifiedName);
        if (this.pendingColumns.has(key) || this.columnsCache[key]) return;
        this.pendingColumns.add(key);
        vscode.postMessage({ command: 'getObjectColumns', database, objectName: qualifiedName });
    }

    requestParameters(database, qualifiedName) {
        const key = SqlAutocomplete._colKey(database, qualifiedName);
        if (this.pendingParams.has(key) || this.paramsCache[key]) return;
        this.pendingParams.add(key);
        vscode.postMessage({ command: 'getObjectParameters', database, objectName: qualifiedName });
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
            li.className = 'ac-item';
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

        this.info = null;
        if (this.settings.showDetails && items.some(i => i.info)) {
            this.info = document.createElement('li');
            this.info.className = 'ac-info';
            this.dropdown.appendChild(this.info);
        }
        this.dropdown.style.display = '';
        this.showInfo();
        this.position();
    }

    // The details line under the list describes the highlighted suggestion.
    showInfo() {
        if (!this.info) return;
        const item = this.items[this.selectedIndex];
        this.info.textContent = (item && item.info) || '';
        this.info.style.display = this.info.textContent ? '' : 'none';
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
        const rows = this.dropdown.querySelectorAll('li.ac-item');
        rows.forEach((li, i) => li.classList.toggle('selected', i === this.selectedIndex));
        rows[this.selectedIndex].scrollIntoView({ block: 'nearest' });
        this.showInfo();
    }

    accept() {
        const item = this.items[this.selectedIndex];
        if (!item || !this.ctx) {
            this.hide();
            return;
        }
        const ta = this.textarea;
        const start = item.replaceStart === undefined ? this.ctx.partialStart : item.replaceStart;
        let end = ta.selectionStart;
        // "[Emp|]": the closing bracket already there is replaced, not doubled.
        if (item.insert.endsWith(']') && ta.value[end] === ']') end++;
        // Replace the typed word, not the whole document: the completion
        // stays one undo step and the query around it is left untouched.
        if (typeof ta.replaceRange === 'function') {
            ta.replaceRange(start, end, item.insert);
        } else {
            ta.value = ta.value.slice(0, start) + item.insert + ta.value.slice(end);
            const caret = start + item.insert.length;
            ta.setSelectionRange(caret, caret);
        }
        if (item.caretBack) {
            const caret = start + item.insert.length - item.caretBack;
            ta.setSelectionRange(caret, caret);
        }
        if (item.usageKey) this.usage.set(item.usageKey, (this.usage.get(item.usageKey) || 0) + 1);
        this.hide();
        // "Sales." / "alias." keep going: show what comes after the dot.
        if (item.retrigger) this.update(true);
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
            case 'Table':
            case 'View':
            case 'Procedure':
            case 'Function':
            case 'Database':
                return swObjectIcon(kind);
            case 'column': return '<i class="codicon codicon-symbol-field"></i>';
            case 'joinCondition': return swIcon('join');
            case 'cte': return swIcon('view');
            case 'temp': return swIcon('table');
            case 'alias': return '<i class="codicon codicon-symbol-variable"></i>';
            case 'variable': return '<i class="codicon codicon-symbol-variable"></i>';
            case 'schema': return '<i class="codicon codicon-symbol-namespace"></i>';
            case 'snippet': return '<i class="codicon codicon-symbol-snippet"></i>';
            case 'columns': return '<i class="codicon codicon-list-flat"></i>';
            case 'parameter': return '<i class="codicon codicon-symbol-parameter"></i>';
            case 'function': return swIcon('function');
            default: return '<i class="codicon codicon-symbol-keyword"></i>';
        }
    }

    // === Pure logic (unit-testable, no DOM) ===

    // Split the text before the caret into base + partial around the last dot:
    // "SELECT e.Na|" -> { base: 'e', partial: 'Na', partialStart: 9 }.
    // Bracketed parts may contain spaces ("[Order D|").
    static extractContext(text, caret) {
        const before = text.slice(Math.max(0, caret - 256), caret);
        const match = SqlAutocomplete.TOKEN_BEFORE_CARET.exec(before);
        const token = match ? match[0] : '';
        const tokenStart = caret - token.length;
        let lastDot = -1;
        let inBracket = false;
        for (let i = 0; i < token.length; i++) {
            const ch = token[i];
            if (ch === '[') inBracket = true;
            else if (ch === ']') inBracket = false;
            else if (ch === '.' && !inBracket) lastDot = i;
        }
        // The keyword right before the token - "exec"/"execute" is what makes a
        // bare procedure name a sensible suggestion instead of noise.
        const precedingKeyword = SqlAutocomplete._wordBefore(text, tokenStart);
        if (lastDot === -1) {
            return { base: '', partial: token, partialStart: tokenStart, tokenStart, precedingKeyword };
        }
        return {
            base: token.slice(0, lastDot),
            partial: token.slice(lastDot + 1),
            partialStart: tokenStart + lastDot + 1,
            tokenStart,
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

    // "a.DeptID = b.DeptID" for the columns the new table shares by name (and type)
    // with a table already in the statement, when the name looks like a key.
    static buildNameJoinSuggestions(joinCtx, e, textBeforeCaret) {
        const KEY_NAME_RE = /(^|[a-z])(id|key|code|no|number|ref)$/i;
        const newObj = SqlAutocomplete._resolveObjectRef(joinCtx.table, e.objects);
        if (!newObj) return [];
        const newColumns = e.getColumns(e.currentDatabase, newObj.qualified_name);
        if (!newColumns) {
            SqlAutocomplete._addNeeds(e.needs, [{ database: e.currentDatabase, qualifiedName: newObj.qualified_name }]);
            return [];
        }
        const newAlias = joinCtx.alias || newObj.object_name || newObj.name;
        const newTableLower = joinCtx.table.replace(/[[\]\s]/g, '').toLowerCase();
        const items = [];
        for (const ref of SqlAutocomplete.scanTableRefs(textBeforeCaret)) {
            if (ref.source.toLowerCase() === newTableLower) continue;
            const otherObj = SqlAutocomplete._resolveObjectRef(ref.source, e.objects);
            if (!otherObj || otherObj.qualified_name.toLowerCase() === newObj.qualified_name.toLowerCase()) continue;
            const otherColumns = e.getColumns(e.currentDatabase, otherObj.qualified_name);
            if (!otherColumns) {
                SqlAutocomplete._addNeeds(e.needs, [{ database: e.currentDatabase, qualifiedName: otherObj.qualified_name }]);
                continue;
            }
            const otherAlias = ref.alias || otherObj.object_name || otherObj.name;
            for (const c of otherColumns) {
                if (!KEY_NAME_RE.test(c.name)) continue;
                const same = newColumns.find(n => n.name.toLowerCase() === c.name.toLowerCase() && (n.type || '') === (c.type || ''));
                if (!same) continue;
                const condition = `${otherAlias}.${c.name} = ${newAlias}.${same.name}`;
                items.push({ label: condition, insert: condition, kind: 'joinCondition', detail: 'same column name' });
            }
        }
        return items.slice(0, 3);
    }

    // Build the suggestion list for a given context.
    // getColumns(database, qualifiedName) returns cached columns or undefined;
    // when undefined is hit, needsColumns tells the caller which {database,
    // qualifiedName} to fetch. options.databases/currentDatabase/
    // getDatabaseObjects(database) are what make a three-part
    // "Database.Schema.Object" reference work - see _resolveWithinDatabase.
    static buildSuggestions(ctx, objects, aliases, getColumns, options = {}) {
        const minLength = options.minLength === undefined ? 2 : options.minLength;
        const limit = options.limit || SqlAutocomplete.MAX_ITEMS;
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
            return { items: items.slice(0, limit) };
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

            return SqlAutocomplete._resolveWithinDatabase(database, remainder, partial, dbObjects, {}, getColumns, execContext, limit);
        }

        return SqlAutocomplete._resolveWithinDatabase(options.currentDatabase, base, partial, objects, aliases, getColumns, execContext, limit);
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
    static _resolveWithinDatabase(database, base, partial, objects, aliases, getColumns, execContext, limit = SqlAutocomplete.MAX_ITEMS) {
        if (!base) {
            return { items: SqlAutocomplete._flatObjectItems(objects, partial, execContext).slice(0, limit) };
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
            return { items: items.slice(0, limit) };
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
        return { items: items.slice(0, limit), columnMeta: columns.map(c => Object.assign({ table: obj.qualified_name }, c)) };
    }

    // === Settings ===

    // Clamp/complete raw settings (from the extension host or a test).
    static normalizeSettings(raw) {
        const d = SqlAutocomplete.DEFAULT_SETTINGS;
        const r = raw || {};
        const bool = (key) => (typeof r[key] === 'boolean' ? r[key] : d[key]);
        const oneOf = (key, allowed) => (allowed.includes(r[key]) ? r[key] : d[key]);
        const int = (key, min, max) => {
            const v = Number(r[key]);
            return Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : d[key];
        };
        return {
            enabled: bool('enabled'),
            autoTrigger: bool('autoTrigger'),
            triggerAfterKeywords: bool('triggerAfterKeywords'),
            minChars: int('minChars', 0, 5),
            maxItems: int('maxItems', 5, 100),
            matching: oneOf('matching', ['prefix', 'contains', 'fuzzy']),
            keywordCase: oneOf('keywordCase', ['upper', 'lower', 'match']),
            acceptKeys: oneOf('acceptKeys', ['tabAndEnter', 'tab', 'enter']),
            showTypes: bool('showTypes'),
            addAlias: bool('addAlias'),
            bracketNames: oneOf('bracketNames', ['whenNeeded', 'always', 'never']),
            columnQualification: oneOf('columnQualification', ['whenAmbiguous', 'always', 'never']),
            includeSystemObjects: bool('includeSystemObjects'),
            sortByUsage: bool('sortByUsage'),
            snippets: bool('snippets'),
            showDetails: bool('showDetails')
        };
    }

    // === Identifier formatting ===

    // One name part, in brackets when it has to be (or the user opened one).
    static quote(part, mode, force = false) {
        if (mode === 'never') return part;
        const plain = /^[\p{L}_@#][\p{L}\p{N}_@#$]*$/u.test(part) && !SqlAutocomplete.RESERVED_IDENTIFIERS.has(part.toLowerCase());
        if (mode === 'always' || force || !plain) return `[${part.replace(/]/g, ']]')}]`;
        return part;
    }

    static _caseKeyword(word, mode, typed) {
        if (mode === 'lower') return word.toLowerCase();
        if (mode === 'match') {
            const letters = typed.replace(/[^\p{L}]/gu, '');
            if (letters && letters === letters.toLowerCase()) return word.toLowerCase();
        }
        return word.toUpperCase();
    }

    // Short alias from the words of a name: HumanOrders -> ho, order_lines -> ol.
    static aliasFor(name, used) {
        const text = name.replace(/^[#@]+/, '');
        const starts = SqlMatcher.wordStarts(text);
        let alias = (starts.length ? starts.map(i => text[i]).join('') : text.slice(0, 1)).toLowerCase();
        if (!alias) alias = 't';
        if (SqlAutocomplete.RESERVED_IDENTIFIERS.has(alias)) alias += '1';
        const taken = new Set([...used].map(u => u.toLowerCase()));
        let candidate = alias;
        for (let n = 2; taken.has(candidate); n++) candidate = alias + n;
        return candidate;
    }

    // === Suggestion engine ===

    // Everything between the text and the dropdown, with no DOM:
    //   env = { objects, databases, currentDatabase, foreignKeys, getColumns,
    //           getDatabaseObjects, settings, usage, force }
    // Returns { items, ctx: { partialStart }, needs: { columns, databaseObjects } }.
    static compute(text, caret, env) {
        const settings = SqlAutocomplete.normalizeSettings(env.settings);
        const needs = { columns: [], databaseObjects: [], parameters: [] };
        const result = { items: [], ctx: { partialStart: caret }, needs };
        if (!settings.enabled) return result;

        const tok = SqlAutocomplete.extractContext(text, caret);
        result.ctx = { partialStart: tok.partialStart };
        const analysis = SqlContext.analyze(text, caret, tok.tokenStart);
        if (analysis.inLiteral) return result;

        // "USE other_db" earlier in the text: the statement is resolved there.
        let objects = env.objects || [];
        let currentDatabase = env.currentDatabase || null;
        if (analysis.useDatabase && analysis.useDatabase.toLowerCase() !== (currentDatabase || '').toLowerCase()) {
            const other = env.getDatabaseObjects ? env.getDatabaseObjects(analysis.useDatabase) : undefined;
            if (other) { objects = other; currentDatabase = analysis.useDatabase; }
            else needs.databaseObjects.push(analysis.useDatabase);
        }

        const e = {
            // `objects` resolves what the statement names (even sys.objects); `visible` is what is offered.
            objects,
            visible: SqlAutocomplete._visibleObjects(objects, settings),
            databases: env.databases || [],
            currentDatabase,
            foreignKeys: env.foreignKeys || [],
            getColumns: env.getColumns || (() => undefined),
            getDatabaseObjects: env.getDatabaseObjects || (() => undefined),
            getParameters: env.getParameters || (() => undefined),
            snippets: env.snippets || [],
            temps: analysis.temps,
            settings,
            needs
        };
        const forceBracket = tok.partial.startsWith('[') || tok.partial.startsWith('"');
        const query = tok.partial;
        // Objects are matched before an item is built: a database can have tens of thousands.
        e.accepts = obj => SqlMatcher.match(obj.object_name || obj.name, query, settings.matching) !== null
            || SqlMatcher.match(obj.qualified_name || obj.name, query, settings.matching) !== null;

        let items;
        if (tok.base) {
            items = SqlAutocomplete._dottedItems(text, tok, analysis, e);
        } else {
            const built = SqlAutocomplete._clauseItems(text, caret, tok, analysis, e, !!env.force);
            if (!built) return result;
            items = built.items;
        }

        // Rank, cut, then write the final text (brackets, keyword case).
        const ranked = SqlMatcher.rank(items, query, settings.matching, settings.sortByUsage ? env.usage : null)
            .slice(0, settings.maxItems);
        for (const item of ranked) {
            if (item.parts) {
                item.insert = item.parts.map((p, i) => SqlAutocomplete.quote(p, settings.bracketNames, forceBracket && i === item.parts.length - 1)).join('.')
                    + (item.suffix || '');
                if (!item.label) item.label = item.parts[item.parts.length - 1];
            }
        }
        result.items = ranked;
        return result;
    }

    // System objects only on request.
    static _visibleObjects(objects, settings) {
        if (settings.includeSystemObjects) return objects;
        const cache = SqlAutocomplete._visibleCache;
        if (cache.source === objects) return cache.result;
        const result = objects.filter(o => !SqlAutocomplete.SYSTEM_SCHEMAS.has((o.schema_name || '').toLowerCase()));
        cache.source = objects;
        cache.result = result;
        return result;
    }

    static _sourceKey(src) {
        const parts = src.parts.filter(Boolean);
        return (src.alias || parts[parts.length - 1] || '');
    }

    // Is the caret where a table-like name is expected?
    static _sourceRole(a) {
        if (a.group) return null;
        const p = a.prevWord;
        if (['from', 'join', 'using'].includes(p)) return 'table';
        if (p === ',' && a.clause === 'from') return 'table';
        if (p === 'apply') return 'apply';
        if (p === 'update' && a.prev2Word !== 'for' && a.prev2Word !== 'after') return 'table';
        if (p === 'into' && a.root && ['insert', 'merge'].includes(a.root.firstWord)) return 'table';
        if (p === 'table' && ['truncate', 'drop', 'alter'].includes(a.prev2Word)) return 'table';
        if ((p === 'procedure' || p === 'proc') && ['drop', 'alter'].includes(a.prev2Word)) return 'proc';
        if (p === 'view' && ['drop', 'alter'].includes(a.prev2Word)) return 'view';
        if (p === 'function' && ['drop', 'alter'].includes(a.prev2Word)) return 'function';
        if (p === 'exec' || p === 'execute') return 'proc';
        if (p === 'use') return 'database';
        return null;
    }

    // Candidates for the word being typed when there is no "something." before it.
    // Returns { items } or null when nothing should pop up.
    static _clauseItems(text, caret, tok, a, e, force) {
        const settings = e.settings;
        const typed = tok.partial.replace(/[[\]"]/g, '');
        const role = SqlAutocomplete._sourceRole(a);

        // "... JOIN t ON |": the foreign-key condition comes first.
        let fkItems = [];
        const joinCtx = tok.partial === '' ? SqlAutocomplete.extractJoinOnContext(text, caret) : null;
        if (joinCtx && e.foreignKeys.length) {
            fkItems = SqlAutocomplete.buildJoinConditionSuggestions(joinCtx, e.objects, text.slice(a.stmtStart || 0, caret), e.foreignKeys);
            for (const it of fkItems) { it.priority = -10; it.match = it.label; }
        }

        // No foreign key between them: the same-name key columns are the next best.
        if (joinCtx && fkItems.length === 0) {
            fkItems = SqlAutocomplete.buildNameJoinSuggestions(joinCtx, e, text.slice(a.stmtStart || 0, caret));
            for (const it of fkItems) { it.priority = -5; it.match = it.label; }
        }

        // When to pop up on its own: enough letters typed, or right after a
        // keyword that can only be followed by a name (FROM, JOIN, EXEC...).
        const paramRole = !role && !a.group && a.clause === 'exec' && SqlAutocomplete._execProcedure(a, e) !== null;
        if (!force && fkItems.length === 0) {
            if (typed.length === 0) {
                if (!(settings.triggerAfterKeywords && (role || paramRole))) return null;
            } else if (typed.length < settings.minChars && !(paramRole && typed.startsWith('@'))) {
                return null;
            } else if (SqlAutocomplete._aliasPosition(a)) {
                return null; // probably typing an alias: leave it alone
            }
        }

        const items = [...fkItems];
        let keywordOrder = 0;
        if (force && a.clause === 'select' && !a.group) {
            const expand = SqlAutocomplete._expandStarItem(text, caret, a, e);
            if (expand) items.push(expand);
        }
        const snippets = () => {
            if (settings.snippets && typed.length > 0) items.push(...SqlAutocomplete._snippetItems(e.snippets));
        };
        const kw = (word, priority, usage = true) => ({
            label: SqlAutocomplete._caseKeyword(word, settings.keywordCase, typed), kind: 'keyword', priority,
            insert: SqlAutocomplete._caseKeyword(word, settings.keywordCase, typed), match: word,
            usageKey: usage ? `kw|${word.toLowerCase()}` : undefined, order: keywordOrder++
        });
        const fn = (name, priority) => {
            const cased = SqlAutocomplete._caseKeyword(name, settings.keywordCase, typed);
            return { label: cased + '()', insert: cased + '()', caretBack: 1, kind: 'function', detail: 'function', priority, match: name, usageKey: `fn|${name.toLowerCase()}` };
        };

        // A data type is expected here.
        if (a.typeContext) {
            for (const t of SqlAutocomplete.TYPE_KEYWORDS) items.push(kw(t, 5));
            return { items };
        }

        const g = a.group ? a.group.kind : null;
        if (g === 'insertcols') {
            SqlAutocomplete._columnItems(items, a.insertTarget ? [a.insertTarget] : [], a, e, { qualify: false });
            return { items };
        }
        if (g === 'hints') {
            for (const h of SqlAutocomplete.HINT_KEYWORDS) items.push(kw(h, 5));
            return { items };
        }
        if (g === 'definition') {
            for (const t of SqlAutocomplete.TYPE_KEYWORDS) items.push(kw(t, 5));
            return { items };
        }
        if (g === 'expr' && a.prevWord === 'as' && a.group.opener && /^(cast|try_cast|convert|try_convert)$/i.test(a.group.opener.v)) {
            for (const t of SqlAutocomplete.TYPE_KEYWORDS) items.push(kw(t, 5));
            return { items };
        }

        if (role === 'proc') {
            for (const entry of SqlAutocomplete._objectIndex(e.visible).entries) {
                if (entry.obj.object_type !== 'Procedure' || !e.accepts(entry.obj)) continue;
                items.push(SqlAutocomplete._objectItem(entry.obj, 0));
            }
            return { items };
        }
        if (role === 'database') {
            for (const db of e.databases) items.push({ label: db, parts: [db], kind: 'Database', detail: 'Database', priority: 0, match: db, usageKey: `db|${db.toLowerCase()}` });
            return { items };
        }
        if (role) {
            SqlAutocomplete._sourceItems(items, role, a, e);
            return { items };
        }

        // EXEC dbo.proc |: its parameters.
        if (a.clause === 'exec' && !a.group) {
            const params = SqlAutocomplete._parameterItems(a, e, typed);
            if (params) {
                items.push(...params);
                return { items };
            }
        }

        // Statement start: only statement keywords make sense.
        if (a.clause === 'start' && !a.group) {
            for (const k of SqlAutocomplete.STATEMENT_KEYWORDS) items.push(kw(k, 0));
            snippets();
            return { items };
        }

        const clause = a.clause;
        const expression = ['select', 'where', 'on', 'having', 'groupby', 'orderby', 'set', 'output'].includes(clause)
            || (a.group && (g === 'expr' || g === 'values'));

        if (expression) {
            if (g !== 'values' && clause !== 'values') {
                SqlAutocomplete._columnItems(items, a.sources, a, e, { qualify: true });
                if (typed.length > 0) SqlAutocomplete._aliasItems(items, a);
            }
            // CONVERT(<type>, expr): the type comes first.
            if (g === 'expr' && a.prevWord === '(' && a.group.opener && /^(convert|try_convert)$/i.test(a.group.opener.v)) {
                for (const t of SqlAutocomplete.TYPE_KEYWORDS) items.push(kw(t, -1));
            }
            // ORDER BY can use the aliases of the select list.
            if (clause === 'orderby' && a.scope && a.block) {
                const names = SqlContext.selectItems(a.scope, a.block).names;
                for (const n of names) {
                    items.push({ label: n, kind: 'column', detail: 'select list', priority: 0, match: n, parts: [n], usageKey: `alias|${n.toLowerCase()}` });
                }
            }
            for (const v of a.variables) {
                items.push({ label: v.name, insert: v.name, kind: 'variable', detail: v.type, priority: typed.startsWith('@') ? 0 : 2, match: v.name, usageKey: `var|${v.name.toLowerCase()}` });
            }
            for (const entry of SqlAutocomplete._objectIndex(e.visible).entries) {
                if (entry.obj.object_type !== 'Function' || !e.accepts(entry.obj)) continue;
                const item = SqlAutocomplete._objectItem(entry.obj, 3);
                item.parts = (entry.obj.schema_name ? [entry.obj.schema_name, entry.obj.object_name] : [entry.obj.object_name]);
                item.suffix = '()';
                item.caretBack = 1;
                items.push(item);
            }
            for (const f of SqlAutocomplete.FUNCTIONS) items.push(fn(f, 4));
            for (const k of SqlAutocomplete.EXPRESSION_KEYWORDS) items.push(kw(k, 5));
            for (const k of (SqlAutocomplete.CLAUSE_KEYWORDS[clause] || [])) items.push(kw(k, 5));
            if (a.atLineStart) {
                for (const k of SqlAutocomplete.STATEMENT_KEYWORDS) items.push(kw(k, 6));
                snippets();
            }
            return { items };
        }

        if (clause === 'from' || clause === 'join') {
            for (const k of SqlAutocomplete.AFTER_SOURCE_KEYWORDS) items.push(kw(k, 0));
            if (a.atLineStart) {
                for (const k of SqlAutocomplete.STATEMENT_KEYWORDS) items.push(kw(k, 1));
                snippets();
            }
            return { items };
        }
        if (clause === 'declare') {
            for (const t of SqlAutocomplete.TYPE_KEYWORDS) items.push(kw(t, 0));
            return { items };
        }
        if (clause === 'into' || clause === 'insert' || clause === 'exec' || clause === 'use') {
            return force ? { items: [kw('VALUES', 0), kw('SELECT', 0), kw('EXEC', 0)] } : null;
        }

        // Anything else (UPDATE t ..., MERGE, DELETE ...): the generic lists.
        for (const k of SqlAutocomplete.KEYWORDS) items.push(kw(k, 5));
        for (const db of e.databases) items.push({ label: db, parts: [db], kind: 'Database', detail: 'Database', priority: 3, match: db, usageKey: `db|${db.toLowerCase()}` });
        for (const entry of SqlAutocomplete._objectIndex(e.visible).entries) {
            if (entry.obj.object_type === 'Procedure' || !e.accepts(entry.obj)) continue;
            items.push(SqlAutocomplete._objectItem(entry.obj, 2));
        }
        return { items };
    }

    // The procedure named after EXEC when the caret is past its name:
    // { obj, used: Set of @params already given } or null.
    static _execProcedure(a, e) {
        if (!a.root || !a.block) return null;
        const tokens = a.root.shared.tokens;
        const mark = [...a.block.marks].reverse().find(m => m.clause === 'exec');
        if (!mark) return null;
        let k = mark.idx + 1;
        if (!SqlContext._isName(tokens[k]) || tokens[k].v.startsWith('@')) return null;
        const parts = [tokens[k].v];
        k++;
        while (SqlContext._isPunct(tokens[k], '.') && SqlContext._isName(tokens[k + 1])) { parts.push(tokens[k + 1].v); k += 2; }
        if (a.prevIdx < k - 1) return null; // still typing the name
        if (a.prevIdx === k - 1 && a.prevWord === '.') return null;
        const obj = SqlAutocomplete._resolveObjectRef(parts.join('.'), e.objects);
        if (!obj || obj.object_type !== 'Procedure') return null;
        const used = new Set();
        for (let j = k; j <= a.prevIdx; j++) {
            if (tokens[j].t === 'w' && tokens[j].v.startsWith('@')) used.add(tokens[j].lc);
        }
        return { obj, used };
    }

    // "@Param = " items for the parameters not given yet, plus "all parameters".
    static _parameterItems(a, e, typed) {
        const proc = SqlAutocomplete._execProcedure(a, e);
        if (!proc) return null;
        const params = e.getParameters(e.currentDatabase, proc.obj.qualified_name);
        if (!params) {
            e.needs.parameters.push({ database: e.currentDatabase, qualifiedName: proc.obj.qualified_name });
            return [];
        }
        const open = params.filter(p => !proc.used.has(p.name.toLowerCase()));
        const items = open.map((p, order) => ({
            order, label: p.name, insert: `${p.name} = `, kind: 'parameter', priority: 0, match: p.name,
            detail: [p.type, p.isOutput ? 'OUTPUT' : ''].filter(Boolean).join(' · '),
            info: `${proc.obj.name} ${p.name} ${p.type}${p.isOutput ? ' OUTPUT' : ''}`,
            usageKey: `par|${proc.obj.qualified_name.toLowerCase()}|${p.name.toLowerCase()}`
        }));
        if (open.length > 1 && !typed.replace('@', '')) {
            items.unshift({
                label: 'All parameters', insert: open.map(p => `${p.name} = `).join(',\n    '), kind: 'parameter', priority: -1, match: '',
                detail: `${open.length} parameters`, info: open.map(p => p.name).join(', ')
            });
        }
        return items;
    }

    // "SELECT *|" (or "alias.*|") with Ctrl+Space: the list of columns it stands for.
    static _expandStarItem(text, caret, a, e) {
        const star = a.prevToken;
        if (!star || star.t !== 'p' || star.v !== '*' || text.slice(star.e, caret).trim() !== '' || !a.root) return null;
        const tokens = a.root.shared.tokens;
        const before = tokens[a.prevIdx - 1];
        let alias = null;
        let replaceStart = star.s;
        if (before && before.t === 'p' && before.v === '.' && SqlContext._isName(tokens[a.prevIdx - 2])) {
            alias = tokens[a.prevIdx - 2].v;
            replaceStart = tokens[a.prevIdx - 2].s;
        } else {
            const ok = before && ((before.t === 'w' && ['select', 'distinct', 'all', 'percent', 'ties'].includes(before.lc))
                || (before.t === 'p' && before.v === ',')
                || (before.t === 'n' && SqlContext._isWord(tokens[a.prevIdx - 2], 'top')));
            if (!ok) return null; // "a * b": a multiplication
        }
        const sources = a.sources.filter(s => s.level === 0
            && (!alias || SqlAutocomplete._sourceKey(s).toLowerCase() === alias.toLowerCase()));
        if (sources.length === 0) return null;
        const names = [];
        for (const src of sources) {
            const { columns, needs } = SqlAutocomplete.resolveSourceColumns(src, e, 0);
            SqlAutocomplete._addNeeds(e.needs, needs);
            if (needs.length) return null; // still loading: the list refreshes when it arrives
            const qualifier = SqlAutocomplete._sourceKey(src);
            const qualify = sources.length > 1 || !!alias;
            for (const c of columns) {
                names.push((qualify && qualifier ? [qualifier, c.name] : [c.name]).map(p => SqlAutocomplete.quote(p, e.settings.bracketNames)).join('.'));
            }
        }
        if (names.length === 0) return null;
        return {
            label: `Expand * (${names.length} columns)`, insert: names.join(', '), replaceStart, kind: 'columns',
            detail: `${names.length} columns`, priority: -20, match: '', info: names.join(', ')
        };
    }

    // Abbreviations ("ssf" -> SELECT * FROM) and the user's own snippets.
    static _snippetItems(custom) {
        const out = [];
        const push = (name, sql, detail, marked) => {
            const marker = marked ? sql.indexOf('$0') : -1;
            const insert = marked ? sql.replace('$0', '') : sql;
            out.push({
                label: name, insert, caretBack: marker >= 0 ? insert.length - marker : 0, kind: 'snippet', detail,
                priority: 1, match: name, usageKey: `snip|${name.toLowerCase()}`, info: insert.trim()
            });
        };
        for (const ab of SqlAutocomplete.ABBREVIATIONS) push(ab.abbr, ab.sql, 'snippet', true);
        for (const sn of custom || []) {
            if (sn && sn.name && sn.sql) push(sn.name, sn.sql, 'my snippet', false);
        }
        return out;
    }

    // "FROM Employees e|": the word being typed is (probably) the alias.
    static _aliasPosition(a) {
        if (a.clause !== 'from' && a.clause !== 'join') return false;
        if (a.group || a.prevIdx < 0) return false;
        // Either the source has no alias yet, or the word being typed *is* its alias.
        return a.sources.some(s => s.level === 0 && ((!s.alias && s.endIdx === a.prevIdx + 1) || s.aliasIdx === a.prevIdx + 1));
    }

    static _objectItem(obj, priority) {
        const parts = obj.schema_name && obj.schema_name.toLowerCase() !== 'dbo' ? [obj.schema_name, obj.object_name || obj.name] : [obj.object_name || obj.name];
        return {
            label: obj.name, parts, kind: obj.object_type, detail: obj.object_type, priority,
            match: [obj.object_name || obj.name, obj.qualified_name || obj.name],
            info: `${obj.object_type} · ${obj.qualified_name || obj.name}`,
            usageKey: `obj|${(obj.qualified_name || obj.name).toLowerCase()}`
        };
    }

    // Tables, views, CTEs, temp tables, schemas, databases (and, after JOIN,
    // the foreign-key joins). `role` is 'table' or 'apply'.
    static _sourceItems(items, role, a, e) {
        const settings = e.settings;
        const used = new Set(a.sources.map(s => SqlAutocomplete._sourceKey(s)));
        const joining = a.prevWord === 'join';
        const wantsAlias = settings.addAlias && ['from', 'join', ',', 'apply'].includes(a.prevWord);

        // Tables related (by foreign key) to what is already in the statement.
        const related = new Set();
        const joinItems = [];
        if (joining && e.foreignKeys.length) {
            for (const src of a.sources) {
                if (src.level !== 0 || src.kind !== 'table') continue;
                const obj = SqlAutocomplete._resolveObjectRef(src.parts.join('.'), e.objects);
                if (!obj) continue;
                const otherAlias = src.alias || obj.object_name || obj.name;
                const seen = new Set();
                for (const fk of e.foreignKeys) {
                    const from = (fk.fromTable || '').toLowerCase();
                    const to = (fk.toTable || '').toLowerCase();
                    const mine = obj.qualified_name.toLowerCase();
                    if (from !== mine && to !== mine) continue;
                    const otherName = from === mine ? fk.toTable : fk.fromTable;
                    const newObj = SqlAutocomplete._resolveObjectRef(otherName, e.objects);
                    if (!newObj) continue;
                    related.add(newObj.qualified_name.toLowerCase());
                    if (seen.has(fk.fkName)) continue;
                    seen.add(fk.fkName);
                    const edge = SqlAutocomplete._fkEdgesBetween(e.foreignKeys, newObj.qualified_name, obj.qualified_name).find(x => x.fkName === fk.fkName);
                    if (!edge) continue;
                    const newAlias = SqlAutocomplete.aliasFor(newObj.object_name || newObj.name, used);
                    const condition = SqlAutocomplete._formatJoinCondition(edge, newObj.qualified_name, newAlias, otherAlias);
                    const base = SqlAutocomplete._objectItem(newObj, -1);
                    joinItems.push({
                        label: `${newObj.name} ${newAlias} ON ${condition}`, kind: 'joinCondition', detail: `FK ${edge.fkName}`, info: `${newObj.qualified_name} ${newAlias} ON ${condition}`, priority: -1,
                        parts: base.parts, suffix: ` ${newAlias} ON ${condition}`, match: base.match, usageKey: `join|${edge.fkName.toLowerCase()}`
                    });
                }
            }
        }
        items.push(...joinItems.slice(0, 12));

        const types = role === 'apply' ? ['Table', 'View', 'Function']
            : role === 'view' ? ['View']
            : role === 'function' ? ['Function']
            : ['Table', 'View'];
        const schemas = new Map();
        for (const entry of SqlAutocomplete._objectIndex(e.visible).entries) {
            const obj = entry.obj;
            if (!types.includes(obj.object_type)) continue;
            if (obj.schema_name && !schemas.has(obj.schema_name.toLowerCase())) schemas.set(obj.schema_name.toLowerCase(), obj.schema_name);
            if (!e.accepts(obj)) continue;
            const item = SqlAutocomplete._objectItem(obj, related.has((obj.qualified_name || '').toLowerCase()) ? 0 : 1);
            if (wantsAlias && obj.object_type !== 'Function') item.suffix = ' ' + SqlAutocomplete.aliasFor(obj.object_name || obj.name, used);
            items.push(item);
        }
        for (const cte of a.ctes) {
            items.push({ label: cte.name, parts: [cte.name], kind: 'cte', detail: 'CTE', priority: 0, match: cte.name, usageKey: `cte|${cte.name.toLowerCase()}`, suffix: wantsAlias ? ' ' + SqlAutocomplete.aliasFor(cte.name, used) : undefined });
        }
        for (const def of a.temps.values()) {
            items.push({ label: def.name, insert: def.name, kind: 'temp', detail: def.name.startsWith('@') ? 'table variable' : 'temp table', priority: 0, match: def.name, usageKey: `tmp|${def.name.toLowerCase()}` });
        }
        for (const schema of schemas.values()) {
            items.push({ label: schema, parts: [schema], suffix: '.', retrigger: true, kind: 'schema', detail: 'Schema', priority: 3, match: schema });
        }
        if (role !== 'apply') {
            for (const db of e.databases) {
                items.push({ label: db, parts: [db], suffix: '.', retrigger: true, kind: 'Database', detail: 'Database', priority: 4, match: db, usageKey: `db|${db.toLowerCase()}` });
            }
        }
    }

    // Columns of the given sources, qualified when the setting (or ambiguity) says so.
    static _columnItems(items, sources, a, e, { qualify }) {
        const settings = e.settings;
        const perSource = [];
        const count = new Map();
        for (const src of sources) {
            const { columns, needs } = SqlAutocomplete.resolveSourceColumns(src, e, 0);
            SqlAutocomplete._addNeeds(e.needs, needs);
            perSource.push({ src, columns });
            for (const c of columns) {
                const key = c.name.toLowerCase();
                count.set(key, (count.get(key) || 0) + (src.level === 0 ? 1 : 0));
            }
        }
        const multiple = sources.filter(s => s.level === 0).length > 1;
        let position = 0;
        for (const { src, columns } of perSource) {
            const qualifier = SqlAutocomplete._sourceKey(src);
            for (const c of columns) {
                const ambiguous = (count.get(c.name.toLowerCase()) || 0) > 1;
                const doQualify = qualify && qualifier && (settings.columnQualification === 'always'
                    || (settings.columnQualification === 'whenAmbiguous' && ambiguous));
                const where = multiple ? qualifier : '';
                const detail = [settings.showTypes ? c.type : '', where].filter(Boolean).join(' · ');
                items.push({
                    label: c.name, kind: 'column', detail, priority: src.level === 0 ? 0 : 1, match: c.name,
                    info: SqlAutocomplete._columnInfo(c, qualifier), order: position++,
                    parts: doQualify ? [qualifier, c.name] : [c.name],
                    usageKey: `col|${qualifier.toLowerCase()}.${c.name.toLowerCase()}`
                });
            }
        }
    }

    // "Employees.Name · nvarchar(50) · NOT NULL · PK"
    static _columnInfo(c, qualifier) {
        const flags = [];
        if (c.nullable === true) flags.push('NULL');
        else if (c.nullable === false) flags.push('NOT NULL');
        if (c.isPrimaryKey) flags.push('PK');
        if (c.isIdentity) flags.push('IDENTITY');
        return [`${c.table || qualifier}.${c.name}`, c.type, ...flags].filter(Boolean).join(' · ');
    }

    // "e" -> "e." for the tables in scope, so the dot (and its columns) is one keystroke away.
    static _aliasItems(items, a) {
        const seen = new Set();
        for (const src of a.sources) {
            if (src.level !== 0) continue;
            const key = SqlAutocomplete._sourceKey(src);
            if (!key || seen.has(key.toLowerCase())) continue;
            seen.add(key.toLowerCase());
            items.push({
                label: key, parts: [key], suffix: '.', retrigger: true, kind: 'alias',
                detail: src.parts.filter(Boolean).join('.') || src.kind, priority: 1, match: key, usageKey: `alias|${key.toLowerCase()}`
            });
        }
    }

    static _addNeeds(target, needs) {
        for (const n of needs) {
            if (n.databaseObjects) {
                if (!target.databaseObjects.includes(n.databaseObjects)) target.databaseObjects.push(n.databaseObjects);
            } else if (!target.columns.some(c => c.database === n.database && c.qualifiedName === n.qualifiedName)) {
                target.columns.push(n);
            }
        }
    }

    // After "something.": columns of an alias/table/CTE/derived/temp, objects
    // of a schema or of another database.
    static _dottedItems(text, tok, a, e) {
        const base = tok.base.replace(/[[\]"]/g, '');
        const baseLower = base.toLowerCase();

        // 1. A source of the statement: CTEs, derived tables, temp tables and
        //    table variables carry their own columns.
        const found = a.sources.find(s => {
            const parts = s.parts.filter(Boolean);
            return (s.alias && s.alias.toLowerCase() === baseLower)
                || (!s.alias && parts.length && parts.join('.').toLowerCase() === baseLower)
                || (!s.alias && parts.length && parts[parts.length - 1].toLowerCase() === baseLower);
        });
        // OUTPUT inserted. / deleted.: the columns of the statement's target.
        let output = null;
        if (!found && (baseLower === 'inserted' || baseLower === 'deleted') && a.root) {
            output = a.root.firstWord === 'insert' ? a.insertTarget
                : (a.sources.find(s => s.level === 0 && s.target) || a.sources.find(s => s.level === 0));
        }
        const owner = found && found.kind !== 'table' ? found : output;
        if (owner) {
            const { columns, needs } = SqlAutocomplete.resolveSourceColumns(owner, e, 0);
            SqlAutocomplete._addNeeds(e.needs, needs);
            return columns.map((c, order) => ({
                order, label: c.name, parts: [c.name], kind: 'column', detail: e.settings.showTypes ? c.type : '', priority: 0, match: c.name,
                info: SqlAutocomplete._columnInfo(c, owner.alias || owner.parts.join('.')),
                usageKey: `col|${baseLower}.${c.name.toLowerCase()}`
            }));
        }

        // 2. Real objects: the existing resolution (schema., database.schema.,
        //    alias -> table columns), unfiltered; ranking happens afterwards.
        // Aliases of the statement only; the whole-text scan is a fallback for when no statement could be read.
        const aliases = a.root ? {} : SqlAutocomplete.parseAliases(text);
        for (const s of a.sources) {
            if (s.alias && s.kind === 'table') aliases[s.alias.toLowerCase()] = s.parts.filter(Boolean).join('.');
        }
        const execContext = SqlAutocomplete.EXEC_KEYWORDS.has(tok.precedingKeyword);
        const built = SqlAutocomplete.buildSuggestions(
            Object.assign({}, tok, { partial: '' }), e.objects, aliases, e.getColumns,
            { minLength: 0, databases: e.databases, currentDatabase: e.currentDatabase, getDatabaseObjects: e.getDatabaseObjects, limit: 100000 }
        );
        if (built.needsColumns) SqlAutocomplete._addNeeds(e.needs, [built.needsColumns]);
        if (built.needsDatabaseObjects) SqlAutocomplete._addNeeds(e.needs, [{ databaseObjects: built.needsDatabaseObjects }]);
        const columnMeta = new Map();
        for (const c of built.columnMeta || []) columnMeta.set(c.name.toLowerCase(), c);
        return built.items.map((it, order) => {
            const isColumn = it.kind === 'column';
            const meta = isColumn ? columnMeta.get(it.label.toLowerCase()) : null;
            return {
                order, label: it.label, parts: isColumn ? [it.insert] : it.insert.split('.'), kind: it.kind, priority: isColumn ? 0 : 1, match: it.label,
                info: meta ? SqlAutocomplete._columnInfo(meta, tok.base) : undefined,
                detail: isColumn && !e.settings.showTypes ? '' : it.detail,
                usageKey: `${isColumn ? 'col' : 'obj'}|${baseLower}.${it.label.toLowerCase()}`
            };
        }).filter(it => it.kind !== 'Procedure' || execContext);
    }

    // Columns [{ name, type }] a source exposes, plus what still has to be
    // fetched: { columns, needs: [{ database, qualifiedName } | { databaseObjects }] }.
    static resolveSourceColumns(src, e, depth = 0) {
        const out = { columns: [], needs: [] };
        if (depth > 5) return out;
        if (src.kind === 'table' || src.kind === 'function') {
            // A table-valued function exposes its columns like a table does.
            const types = src.kind === 'function' ? ['Function'] : ['Table', 'View'];
            const parts = src.parts;
            let database = e.currentDatabase;
            let objects = e.objects;
            let name = parts.filter(Boolean).join('.');
            if (parts.length >= 3) {
                database = parts[0];
                name = `${parts[1] || 'dbo'}.${parts[2]}`;
                if (!(database || '').toLowerCase() || (e.currentDatabase || '').toLowerCase() !== database.toLowerCase()) {
                    objects = e.getDatabaseObjects(database);
                    if (!objects) { out.needs.push({ databaseObjects: database }); return out; }
                }
            }
            const obj = SqlAutocomplete._resolveObjectRef(name, objects);
            if (!obj || !types.includes(obj.object_type)) return out;
            const cols = e.getColumns(database, obj.qualified_name);
            if (!cols) out.needs.push({ database, qualifiedName: obj.qualified_name });
            else out.columns = cols.map(c => ({ name: c.name, type: c.type || '', nullable: c.nullable, isPrimaryKey: c.isPrimaryKey, isIdentity: c.isIdentity, table: obj.qualified_name }));
            return out;
        }

        if (src.kind === 'temp' || src.kind === 'variable') {
            const def = src.def;
            if (!def) return out;
            if (def.columns) { out.columns = def.columns.slice(); return out; }
            if (def.derived) return SqlAutocomplete._blockColumns(def.derived.scope, def.derived.block, e, depth, null);
            return out;
        }

        if (src.kind === 'cte') {
            const cte = src.cte;
            if (cte.columns && cte.columns.length) { out.columns = cte.columns.map(name => ({ name, type: '' })); return out; }
            if (cte.child) return SqlAutocomplete._blockColumns(cte.child, cte.child.blocks[0], e, depth, null);
            return out;
        }

        if (src.kind === 'derived') {
            if (src.columnNames && src.columnNames.length) { out.columns = src.columnNames.map(name => ({ name, type: '' })); return out; }
            if (src.child) return SqlAutocomplete._blockColumns(src.child, src.child.blocks[0], e, depth, null);
        }
        return out;
    }

    // Output columns of one SELECT block: the named items, plus what its
    // "*" / "alias.*" items expand to.
    static _blockColumns(scope, block, e, depth, explicit) {
        const out = { columns: [], needs: [] };
        const items = SqlContext.selectItems(scope, block);
        const columns = items.names.map(name => ({ name, type: '' }));
        for (const star of items.stars) {
            const wanted = star.alias
                ? block.sources.filter(s => SqlAutocomplete._sourceKey(s).toLowerCase() === star.alias.toLowerCase())
                : block.sources;
            for (const raw of wanted) {
                const src = SqlContext.bindInScope(raw, scope, e.temps);
                const inner = SqlAutocomplete.resolveSourceColumns(src, e, depth + 1);
                columns.push(...inner.columns);
                out.needs.push(...inner.needs);
            }
        }
        const seen = new Set();
        out.columns = (explicit || columns).filter(c => !seen.has(c.name.toLowerCase()) && seen.add(c.name.toLowerCase()));
        return out;
    }

    static _colKey(database, qualifiedName) {
        return `${(database || '').toLowerCase()}::${(qualifiedName || '').toLowerCase()}`;
    }
}

SqlAutocomplete.MAX_ITEMS = 15;

// The word (with dotted/bracketed parts) that ends at the caret.
SqlAutocomplete.TOKEN_BEFORE_CARET = /(?:(?:\[[^\][\r\n]*\]|[\p{L}\p{N}_$#@]+)?\.)*(?:\[[^\][\r\n]*|[\p{L}\p{N}_$#@]*)$/u;

// Defaults of the sqlwayfarer.autocomplete.* settings (package.json has the same).
SqlAutocomplete.DEFAULT_SETTINGS = {
    enabled: true,
    autoTrigger: true,
    triggerAfterKeywords: true,
    minChars: 2,
    maxItems: 20,
    matching: 'fuzzy',
    keywordCase: 'upper',
    acceptKeys: 'tabAndEnter',
    showTypes: true,
    addAlias: false,
    bracketNames: 'whenNeeded',
    columnQualification: 'whenAmbiguous',
    includeSystemObjects: false,
    sortByUsage: true,
    snippets: true,
    showDetails: true
};

SqlAutocomplete._visibleCache = { source: null, result: null };
SqlAutocomplete.SYSTEM_SCHEMAS = new Set(['sys', 'information_schema']);

// Names that need brackets when used as an identifier.
SqlAutocomplete.RESERVED_IDENTIFIERS = new Set((
    'add all alter and any as asc authorization backup begin between break browse bulk by cascade case check checkpoint close clustered '
    + 'coalesce collate column commit compute constraint contains continue convert create cross current cursor database dbcc deallocate '
    + 'declare default delete deny desc disk distinct distributed double drop dump else end errlvl escape except exec execute exists exit '
    + 'external fetch file fillfactor for foreign freetext from full function goto grant group having holdlock identity if in index inner '
    + 'insert intersect into is join key kill left like lineno load merge national nocheck nonclustered not null nullif of off offsets on '
    + 'open option or order outer over percent pivot plan precision primary print proc procedure public raiserror read readtext '
    + 'reconfigure references replication restore restrict return revert revoke right rollback rowcount rule save schema select '
    + 'session_user set setuser shutdown some statistics system_user table tablesample textsize then to top tran transaction trigger '
    + 'truncate try_convert tsequal union unique unpivot update updatetext use user values varying view waitfor when where while with writetext'
).split(' '));

SqlAutocomplete.STATEMENT_KEYWORDS = [
    'SELECT', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'WITH', 'DECLARE', 'SET', 'EXEC', 'MERGE', 'IF', 'WHILE', 'BEGIN',
    'BEGIN TRANSACTION', 'COMMIT', 'ROLLBACK', 'CREATE TABLE', 'CREATE VIEW', 'CREATE PROCEDURE', 'ALTER TABLE',
    'DROP TABLE', 'TRUNCATE TABLE', 'USE', 'PRINT', 'RETURN', 'THROW', 'GO'
];
SqlAutocomplete.AFTER_SOURCE_KEYWORDS = [
    'WHERE', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'CROSS APPLY', 'OUTER APPLY', 'JOIN',
    'ON', 'AS', 'GROUP BY', 'ORDER BY', 'HAVING', 'UNION', 'UNION ALL', 'WITH (NOLOCK)', 'OPTION'
];
SqlAutocomplete.EXPRESSION_KEYWORDS = [
    'AND', 'OR', 'NOT', 'NULL', 'IS NULL', 'IS NOT NULL', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'CASE', 'WHEN', 'THEN',
    'ELSE', 'END', 'DISTINCT', 'AS', 'OVER', 'PARTITION BY'
];
SqlAutocomplete.CLAUSE_KEYWORDS = {
    select: ['FROM', 'INTO', 'TOP', 'ALL'],
    where: ['GROUP BY', 'ORDER BY', 'HAVING', 'UNION', 'UNION ALL', 'OPTION'],
    on: ['INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'WHERE', 'GROUP BY', 'ORDER BY', 'UNION'],
    groupby: ['HAVING', 'ORDER BY', 'UNION', 'WITH ROLLUP'],
    having: ['ORDER BY', 'UNION'],
    orderby: ['ASC', 'DESC', 'OFFSET', 'FETCH NEXT', 'UNION'],
    set: ['FROM', 'WHERE', 'OUTPUT'],
    output: ['INTO', 'WHERE']
};
SqlAutocomplete.FUNCTIONS = [
    'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'ISNULL', 'COALESCE', 'NULLIF', 'IIF', 'CAST', 'TRY_CAST', 'CONVERT', 'TRY_CONVERT',
    'GETDATE', 'SYSDATETIME', 'DATEADD', 'DATEDIFF', 'DATEPART', 'EOMONTH', 'YEAR', 'MONTH', 'DAY', 'LEN', 'LTRIM', 'RTRIM',
    'TRIM', 'UPPER', 'LOWER', 'SUBSTRING', 'REPLACE', 'CHARINDEX', 'STUFF', 'CONCAT', 'STRING_AGG', 'FORMAT', 'ABS', 'ROUND',
    'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NEWID', 'SCOPE_IDENTITY'
];
SqlAutocomplete.TYPE_KEYWORDS = [
    'INT', 'VARCHAR', 'NVARCHAR', 'DATETIME', 'DATE', 'BIT', 'DECIMAL', 'BIGINT', 'UNIQUEIDENTIFIER', 'VARCHAR(MAX)',
    'NVARCHAR(MAX)', 'DATETIME2', 'SMALLINT', 'TINYINT', 'NUMERIC', 'MONEY', 'FLOAT', 'REAL', 'DATETIMEOFFSET', 'TIME',
    'CHAR', 'NCHAR', 'VARBINARY', 'XML', 'TABLE'
];
SqlAutocomplete.ABBREVIATIONS = [
    { abbr: 'ssf', sql: 'SELECT * FROM $0' },
    { abbr: 'sst', sql: 'SELECT TOP 100 * FROM $0' },
    { abbr: 'sc', sql: 'SELECT COUNT(*) FROM $0' },
    { abbr: 'sw', sql: 'SELECT * FROM $0\nWHERE ' },
    { abbr: 'ii', sql: 'INSERT INTO $0 ()\nVALUES ()' },
    { abbr: 'upd', sql: 'UPDATE $0\nSET \nWHERE ' },
    { abbr: 'del', sql: 'DELETE FROM $0\nWHERE ' },
    { abbr: 'ob', sql: 'ORDER BY $0' },
    { abbr: 'gb', sql: 'GROUP BY $0' },
    { abbr: 'cte', sql: 'WITH cte AS (\n    SELECT $0\n)\nSELECT * FROM cte' },
    { abbr: 'tran', sql: 'BEGIN TRANSACTION;\n$0\nCOMMIT TRANSACTION;' },
    { abbr: 'trycatch', sql: 'BEGIN TRY\n    $0\nEND TRY\nBEGIN CATCH\n    THROW;\nEND CATCH' }
];
SqlAutocomplete.HINT_KEYWORDS = ['NOLOCK', 'READPAST', 'UPDLOCK', 'ROWLOCK', 'HOLDLOCK', 'TABLOCK', 'NOWAIT', 'READUNCOMMITTED'];

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
