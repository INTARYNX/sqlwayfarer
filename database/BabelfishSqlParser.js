'use strict';

/**
 * BabelfishSqlParser — Analyse le code SQL d'un objet SQL Server pour
 * extraire les opérations DML (SELECT/INSERT/UPDATE/DELETE/MERGE) par table référencée.
 *
 * Utilise la grammaire ANTLR officielle de Babelfish (open-source, la plus complète
 * pour T-SQL dispo), compilée via antlr4 runtime JS.
 *
 * ⚠️ Limites connues :
 *  - Dynamic SQL (EXEC avec string dynamique) → non résolu (fail safe)
 *  - SQL exotique / bugs grammaires → retourne l'analyse partielle
 */

const antlr4 = require('antlr4');
const TSqlLexer = require('./generated/TSqlLexer');
const TSqlParser = require('./generated/TSqlParser');
const TSqlParserVisitor = require('./generated/TSqlParserVisitor');

// Conserve le schéma (voire la DB) quand il est explicite dans le SQL, pour ne pas
// confondre p.ex. dbo.Orders et sales.Orders sous une même clé "orders".
function extractFromFullObjectName(fonCtx) {
    if (!fonCtx || !fonCtx.object_name) return null;
    const parts = [fonCtx.database, fonCtx.schema, fonCtx.object_name]
        .filter(Boolean)
        .map(idCtx => idCtx.getText());
    return parts.join('.');
}

function extractFromDdlObject(ddlCtx) {
    if (!ddlCtx) return null;
    const fon = ddlCtx.full_object_name ? ddlCtx.full_object_name() : null;
    if (fon) return extractFromFullObjectName(fon);
    return null;
}

// Normalisation commune des clés de table : crochets retirés + minuscules,
// alignée avec le lookup de DependencyService. Utilisée par les deux visiteurs.
function cleanTableKey(name) {
    return name.replace(/[\[\]]/g, '').toLowerCase();
}

// Generated accessors return an array when the rule can repeat - normalize
function firstCtx(ctxOrArray) {
    return Array.isArray(ctxOrArray) ? (ctxOrArray[0] || null) : ctxOrArray;
}

function findFirstRule(node, ruleIndex) {
    if (!node || node.symbol !== undefined) return null;
    if (node.ruleIndex === ruleIndex) return node;
    const count = node.getChildCount();
    for (let i = 0; i < count; i++) {
        const found = findFirstRule(node.getChild(i), ruleIndex);
        if (found) return found;
    }
    return null;
}

// Every node of a given rule under a subtree, in document order.
function findAllRule(node, ruleIndex, out = []) {
    if (!node || node.symbol !== undefined) return out;
    if (node.ruleIndex === ruleIndex) out.push(node);
    const count = node.getChildCount();
    for (let i = 0; i < count; i++) findAllRule(node.getChild(i), ruleIndex, out);
    return out;
}

// alias -> real table name pairs from the leaf table_source_item nodes of a
// FROM clause, so aliased UPDATE/DELETE targets resolve to the real table.
function collectTableAliases(tableSources, out = new Map()) {
    if (!tableSources) return out;
    const items = tableSources.table_source_item ? tableSources.table_source_item() : [];
    for (const item of items) collectAliasesFromItem(item, out);
    return out;
}

function collectAliasesFromItem(item, out) {
    if (!item) return;
    const nested = item.table_source_item ? item.table_source_item() : [];
    if (nested && nested.length > 0) {
        for (const child of nested) collectAliasesFromItem(child, out);
        return;
    }
    const fon = firstCtx(item.full_object_name ? item.full_object_name() : null);
    const aliasCtx = firstCtx(item.as_table_alias ? item.as_table_alias() : null);
    if (!fon || !aliasCtx) return;
    const aliasNode = findFirstRule(aliasCtx, TSqlParser.RULE_table_alias);
    if (aliasNode) out.set(cleanTableKey(aliasNode.getText()), extractFromFullObjectName(fon));
}

class OpsVisitor extends TSqlParserVisitor {
    constructor() {
        super();
        this._ops = new Map(); // tableName(lowercase) -> Set<operation>
    }

    getResult() {
        const out = {};
        for (const [table, ops] of this._ops.entries()) {
            out[table] = Array.from(ops);
        }
        return out;
    }

    _addOp(tableName, operation) {
        if (!tableName) return;
        const t = cleanTableKey(tableName);
        if (!this._ops.has(t)) this._ops.set(t, new Set());
        this._ops.get(t).add(operation);
    }

    // 'UPDATE t ... FROM dbo.Task t' names the target by its alias: without
    // resolution the operation would be recorded under 't' and never match the
    // dependency names reported by SQL Server (is_updated would stay false).
    _resolveTargetAlias(table, tableSourcesCtx) {
        if (!table || table.includes('.')) return table;
        const aliases = collectTableAliases(firstCtx(tableSourcesCtx));
        return aliases.get(cleanTableKey(table)) || table;
    }

    _extractFromFullObjectName(fonCtx) {
        return extractFromFullObjectName(fonCtx);
    }

    _extractFromDdlObject(ddlCtx) {
        return extractFromDdlObject(ddlCtx);
    }

    // table_source_item est une règle récursive à gauche (JOIN, CROSS APPLY, PIVOT, ...) :
    // un FROM avec JOIN ne donne qu'un seul item de haut niveau, il faut descendre
    // dans l'arbre pour retrouver chaque full_object_name référencé.
    _walkTableSourceItem(item, operation) {
        if (!item) return;
        const fon = item.full_object_name ? item.full_object_name() : null;
        if (fon) this._addOp(this._extractFromFullObjectName(fon), operation);

        const nested = item.table_source_item ? item.table_source_item() : [];
        for (const child of nested) {
            this._walkTableSourceItem(child, operation);
        }
    }

    _collectFromTableSources(tableSources, operation) {
        if (!tableSources) return;
        const items = tableSources.table_source_item ? tableSources.table_source_item() : [];
        for (const item of items) {
            this._walkTableSourceItem(item, operation);
        }
    }

    // === UPDATE ===
    visitUpdate_statement(ctx) {
        const ddl = ctx.ddl_object ? ctx.ddl_object() : null;
        const tableSources = ctx.table_sources ? ctx.table_sources() : null;
        const table = this._resolveTargetAlias(this._extractFromDdlObject(ddl), tableSources);
        this._addOp(table, 'UPDATE');
        // La clause FROM optionnelle (UPDATE ... FROM a JOIN b ON ...) est lue, pas écrite
        this._collectFromTableSources(tableSources, 'SELECT');
        // Visite les sous-requêtes (SELECT dans SET, WHERE, etc.)
        this.visitChildren(ctx);
    }

    // === INSERT ===
    visitInsert_statement(ctx) {
        const ddl = ctx.ddl_object ? ctx.ddl_object() : null;
        const table = this._extractFromDdlObject(ddl);
        this._addOp(table, 'INSERT');
        this.visitChildren(ctx);
    }

    // === DELETE ===
    visitDelete_statement(ctx) {
        const from = ctx.delete_statement_from ? ctx.delete_statement_from() : null;
        const ddl = from && from.ddl_object ? from.ddl_object() : null;
        const tableSources = ctx.table_sources ? ctx.table_sources() : null;
        const table = this._resolveTargetAlias(this._extractFromDdlObject(ddl), tableSources);
        this._addOp(table, 'DELETE');
        // La clause FROM optionnelle (DELETE ... FROM a JOIN b ON ...) est lue, pas écrite
        this._collectFromTableSources(tableSources, 'SELECT');
        this.visitChildren(ctx);
    }

    // === SELECT — capturé via table_sources dans la query ===
    visitQuery_specification(ctx) {
        this._collectFromTableSources(ctx.table_sources ? ctx.table_sources() : null, 'SELECT');
        // Aussi explorer les sous-requêtes, etc.
        this.visitChildren(ctx);
    }

    // === MERGE — conservateur : on note MERGE, sans détailler WHEN clauses ===
    visitMerge_statement(ctx) {
        const target = ctx.ddl_object ? ctx.ddl_object() : null;
        const table = this._extractFromDdlObject(target);
        if (table) this._addOp(table, 'MERGE');
        // USING table_sources : source lue par le MERGE
        this._collectFromTableSources(ctx.table_sources ? ctx.table_sources() : null, 'SELECT');
        this.visitChildren(ctx);
    }
}

// Sentinel for aliases that point at a derived table (subquery) instead of a
// physical table: qualified refs through them are not physical columns.
const DERIVED = Symbol('derived-table');

// Collects the tables and aliases of a statement. The leaf table_source_item
// nodes carry the reliable table/alias pairing: a joined source is ONE
// flattened ctx with nested table_source_item children, and only the leaves
// are actual sources. Shared by the column lineage and the join graph.
function collectStatementScope(node, scope, ctes) {
    if (!node || node.symbol !== undefined) return;

    if (node.ruleIndex === TSqlParser.RULE_table_source_item) {
        const nested = node.table_source_item ? node.table_source_item() : [];
        const isLeaf = !nested || nested.length === 0;
        if (isLeaf) {
            const fon = firstCtx(node.full_object_name ? node.full_object_name() : null);
            const aliasCtx = firstCtx(node.as_table_alias ? node.as_table_alias() : null);
            const table = fon ? cleanTableKey(fon.getText()) : DERIVED;
            if (fon) scope.tables.add(table);
            if (aliasCtx) {
                const aliasNode = findFirstRule(aliasCtx, TSqlParser.RULE_table_alias);
                if (aliasNode) scope.aliases.set(cleanTableKey(aliasNode.getText()), table);
            }
        }
    } else if (node.ruleIndex === TSqlParser.RULE_common_table_expression) {
        const idNode = findFirstRule(node, TSqlParser.RULE_id);
        if (idNode) ctes.add(cleanTableKey(idNode.getText()));
    }

    const count = node.getChildCount();
    for (let i = 0; i < count; i++) collectStatementScope(node.getChild(i), scope, ctes);
}

/**
 * Column-level lineage: which columns of which tables does a definition touch?
 * Result: { tableKey: { columnName: { write, confident } } }, all keys lowercase.
 *
 * Scoping is flat per top-level DML statement: aliases and tables of a whole
 * statement (subqueries included) live in one scope. Qualified refs resolve
 * through the alias map; unqualified refs are attributed to the single table
 * in scope (confident) or to every table in scope (confident: false).
 * CTE names are dropped (their bodies are analyzed on their own), and inside
 * triggers the inserted/deleted pseudo-tables resolve to the trigger's target.
 */
class ColumnLineageVisitor extends TSqlParserVisitor {
    constructor() {
        super();
        this._result = new Map(); // table -> Map(column -> { write, confident })
        this._scope = null;
        this._ctes = new Set();
        this._triggerTable = null;
    }

    getResult() {
        const out = {};
        for (const [table, cols] of this._result.entries()) {
            out[table] = {};
            for (const [col, info] of cols.entries()) {
                out[table][col] = { write: info.write, confident: info.confident };
            }
        }
        return out;
    }

    _clean(name) {
        return cleanTableKey(name);
    }

    _first(ctxOrArray) {
        return firstCtx(ctxOrArray);
    }

    _record(table, column, { write = false, confident = true } = {}) {
        // Trigger pseudo-tables carry the columns of the trigger's target table
        if (table === 'inserted' || table === 'deleted') table = this._triggerTable;
        if (!table || !column || table === DERIVED) return;
        if (this._ctes.has(table)) return;
        if (!this._result.has(table)) this._result.set(table, new Map());
        const cols = this._result.get(table);
        const prev = cols.get(column);
        cols.set(column, {
            write: (prev ? prev.write : false) || write,
            confident: (prev ? prev.confident : false) || confident
        });
    }

    // inserted/deleted are NOT handled here: _record() remaps them, which also
    // covers refs that reach it through an alias (FROM inserted i -> i.col).
    _resolveQualifier(qualifier) {
        if (this._scope) {
            if (this._scope.aliases.has(qualifier)) return this._scope.aliases.get(qualifier);
        }
        if (this._ctes.has(qualifier)) return null;
        return qualifier; // direct table reference (possibly schema-qualified)
    }

    // Generic subtree walk used to pre-collect the scope of a statement
    _collectScope(node, scope) {
        collectStatementScope(node, scope, this._ctes);
    }

    _findFirst(node, ruleIndex) {
        return findFirstRule(node, ruleIndex);
    }

    _findAll(node, ruleIndex, out = []) {
        if (!node || node.symbol !== undefined) return out;
        if (node.ruleIndex === ruleIndex) out.push(node);
        const count = node.getChildCount();
        for (let i = 0; i < count; i++) this._findAll(node.getChild(i), ruleIndex, out);
        return out;
    }

    // Only the outermost DML statement opens a scope; nested statements
    // (subqueries) reuse it - the scope was collected over the whole subtree.
    _enterStatement(ctx, fn) {
        const isRoot = !this._scope;
        if (isRoot) {
            this._scope = { aliases: new Map(), tables: new Set(), writeTarget: null };
            this._collectScope(ctx, this._scope);
        }
        fn();
        if (isRoot) this._scope = null;
    }

    _recordColumnRef(fcnCtx, { write = false, defaultTable = null } = {}) {
        const parts = this._clean(fcnCtx.getText()).split('.').filter(Boolean);
        const column = parts.pop();
        if (!column) return;

        if (parts.length === 0) {
            if (defaultTable) {
                this._record(defaultTable, column, { write, confident: true });
                return;
            }
            const tables = this._scope ? [...this._scope.tables].filter(t => t !== DERIVED && !this._ctes.has(t)) : [];
            if (tables.length === 1) {
                this._record(tables[0], column, { write, confident: true });
            } else {
                for (const t of tables) this._record(t, column, { write, confident: false });
            }
            return;
        }

        const resolved = this._resolveQualifier(parts.join('.'));
        this._record(resolved, column, { write, confident: true });
    }

    // === Visitor hooks ===

    visitFull_column_name(ctx) {
        this._recordColumnRef(ctx);
        return null;
    }

    // SET target: written column, attributed to the statement's write target
    // when unqualified. visitChildren re-records it as a read - harmless merge.
    visitUpdate_elem(ctx) {
        const target = this._first(ctx.full_column_name ? ctx.full_column_name() : null);
        if (target) {
            this._recordColumnRef(target, { write: true, defaultTable: this._scope ? this._scope.writeTarget : null });
        }
        this.visitChildren(ctx);
    }

    visitUpdate_statement(ctx) {
        this._enterStatement(ctx, () => {
            const ddl = this._first(ctx.ddl_object ? ctx.ddl_object() : null);
            if (ddl) {
                // UPDATE t ... FROM Task t: the target may be an alias.
                // Also register the target as an in-scope table so unqualified
                // WHERE columns of a FROM-less UPDATE are attributed to it.
                const resolved = this._resolveQualifier(this._clean(ddl.getText()));
                if (resolved && resolved !== DERIVED) {
                    this._scope.writeTarget = resolved;
                    this._scope.tables.add(resolved);
                }
            }
            this.visitChildren(ctx);
        });
    }

    visitInsert_statement(ctx) {
        this._enterStatement(ctx, () => {
            const ddl = this._first(ctx.ddl_object ? ctx.ddl_object() : null);
            const target = ddl ? this._resolveQualifier(this._clean(ddl.getText())) : null;
            if (target && target !== DERIVED) {
                this._scope.writeTarget = target;
                const list = this._first(ctx.insert_column_name_list ? ctx.insert_column_name_list() : null);
                if (list) {
                    // Some grammar paths expose plain ids instead of insert_column_id
                    let idNodes = this._findAll(list, TSqlParser.RULE_insert_column_id);
                    if (idNodes.length === 0) idNodes = this._findAll(list, TSqlParser.RULE_id);
                    for (const idNode of idNodes) {
                        this._record(target, this._clean(idNode.getText()), { write: true, confident: true });
                    }
                }
            }
            this.visitChildren(ctx);
        });
    }

    visitDelete_statement(ctx) {
        this._enterStatement(ctx, () => {
            // Register the delete target as an in-scope table so unqualified
            // WHERE columns of a plain 'DELETE FROM t WHERE ...' are attributed
            const from = this._first(ctx.delete_statement_from ? ctx.delete_statement_from() : null);
            const ddl = from ? this._first(from.ddl_object ? from.ddl_object() : null) : null;
            if (ddl) {
                const resolved = this._resolveQualifier(this._clean(ddl.getText()));
                if (resolved && resolved !== DERIVED) this._scope.tables.add(resolved);
            }
            this.visitChildren(ctx);
        });
    }

    visitMerge_statement(ctx) {
        this._enterStatement(ctx, () => {
            const ddl = this._first(ctx.ddl_object ? ctx.ddl_object() : null);
            let target = null;
            if (ddl) {
                target = this._resolveQualifier(this._clean(ddl.getText()));
                if (target && target !== DERIVED) {
                    this._scope.writeTarget = target;
                    this._scope.tables.add(target);
                }
            }

            // MERGE dbo.Target AS tgt: the target alias is a direct child of the
            // statement (the USING source aliases live inside table_sources)
            const aliasCtx = this._first(ctx.as_table_alias ? ctx.as_table_alias() : null);
            if (aliasCtx && target && target !== DERIVED) {
                const aliasNode = this._findFirst(aliasCtx, TSqlParser.RULE_table_alias);
                if (aliasNode) this._scope.aliases.set(this._clean(aliasNode.getText()), target);
            }

            // WHEN NOT MATCHED THEN INSERT (col, ...): written columns of the target
            if (target && target !== DERIVED) {
                for (const notMatched of this._findAll(ctx, TSqlParser.RULE_merge_not_matched)) {
                    const list = this._findFirst(notMatched, TSqlParser.RULE_column_name_list);
                    if (!list) continue;
                    for (const idNode of this._findAll(list, TSqlParser.RULE_id)) {
                        this._record(target, this._clean(idNode.getText()), { write: true, confident: true });
                    }
                }
            }

            this.visitChildren(ctx);
        });
    }

    // WHEN MATCHED THEN UPDATE SET x = ...: same semantics as update_elem
    visitUpdate_elem_merge(ctx) {
        const target = this._first(ctx.full_column_name ? ctx.full_column_name() : null);
        if (target) {
            this._recordColumnRef(target, { write: true, defaultTable: this._scope ? this._scope.writeTarget : null });
        }
        this.visitChildren(ctx);
    }

    visitSelect_statement_standalone(ctx) {
        return this.visitSelect_statement(ctx);
    }

    visitSelect_statement(ctx) {
        this._enterStatement(ctx, () => this.visitChildren(ctx));
        return null;
    }

    // Triggers: remember the ON table so inserted/deleted refs resolve to it
    // (the trigger name itself is a simple_name, the target a table_name)
    visitCreate_or_alter_dml_trigger(ctx) {
        const tableName = this._findFirst(ctx, TSqlParser.RULE_table_name);
        if (tableName) this._triggerTable = this._clean(tableName.getText());
        this.visitChildren(ctx);
    }
}

// The physical tables of a statement body (a derived table or a CTE body).
function statementTables(node, ctes) {
    const scope = { aliases: new Map(), tables: new Set(), derived: new Map() };
    collectStatementScope(node, scope, ctes);
    return [...scope.tables].filter(t => t !== DERIVED && !ctes.has(t));
}

// Collects the alias -> base tables mapping of the derived tables (subqueries)
// and CTEs of a statement: a source that has no name of its own is shown
// through the tables it selects from.
function collectDerivedSources(node, scope, ctes) {
    if (!node || node.symbol !== undefined) return;

    if (node.ruleIndex === TSqlParser.RULE_table_source_item) {
        const nested = node.table_source_item ? node.table_source_item() : [];
        if (!nested || nested.length === 0) {
            const aliasCtx = firstCtx(node.as_table_alias ? node.as_table_alias() : null);
            const aliasNode = aliasCtx ? findFirstRule(aliasCtx, TSqlParser.RULE_table_alias) : null;
            const alias = aliasNode ? cleanTableKey(aliasNode.getText()) : null;
            const inner = firstCtx(node.derived_table ? node.derived_table() : null)
                || firstCtx(node.subquery ? node.subquery() : null);
            if (alias && inner) {
                const innerSelect = findFirstRule(inner, TSqlParser.RULE_select_statement);
                if (innerSelect) {
                    const tables = statementTables(innerSelect, ctes);
                    if (tables.length) scope.derived.set(alias, tables);
                }
            }
        }
    } else if (node.ruleIndex === TSqlParser.RULE_common_table_expression) {
        const idNode = findFirstRule(node, TSqlParser.RULE_id);
        const name = idNode ? cleanTableKey(idNode.getText()) : null;
        const innerSelect = findFirstRule(node, TSqlParser.RULE_select_statement);
        if (name && innerSelect) {
            const tables = statementTables(innerSelect, ctes);
            if (tables.length) scope.derived.set(name, tables);
        }
    }

    const count = node.getChildCount();
    for (let i = 0; i < count; i++) collectDerivedSources(node.getChild(i), scope, ctes);
}

/**
 * Join graph of a SQL text: which sources are joined to which, and on which
 * columns. Complements analyzeColumns (what a statement reads) with the
 * relational structure (which source is joined to which).
 *
 * Result: { tables, functions, joins }
 *  - `tables`: the physical tables read by the text (lowercase, schema kept
 *    when the SQL spells it out)
 *  - `functions`: the schema-qualified functions called by the text - they
 *    are code objects, not tables: their own tables are followed elsewhere
 *  - `joins`: [{ from, to, condition, columns, confident, kind }]
 *    `columns` maps each side of the join to the columns its condition uses
 *    `confident` is false when the condition does not qualify its columns:
 *    the partner is then taken from the join order, not from the condition
 *
 * The tree is walked directly rather than through the visitor mechanism, so
 * the traversal (and the statement scoping) is fully under our control.
 */
class JoinGraphVisitor {
    constructor() {
        this._tables = new Set();
        this._functions = new Set();
        this._joins = [];
        this._seen = new Set();
        this._ctes = new Set();
        this._tokens = null;
    }

    analyze(tree, tokens) {
        this._tokens = tokens;
        this._walk(tree, [], this._ctes);
        return this.getResult();
    }

    getResult() {
        return { tables: [...this._tables], functions: [...this._functions], joins: this._joins };
    }

    _isStatement(ruleIndex) {
        return ruleIndex === TSqlParser.RULE_select_statement
            || ruleIndex === TSqlParser.RULE_select_statement_standalone
            || ruleIndex === TSqlParser.RULE_insert_statement
            || ruleIndex === TSqlParser.RULE_update_statement
            || ruleIndex === TSqlParser.RULE_delete_statement
            || ruleIndex === TSqlParser.RULE_merge_statement;
    }

    // Walks the parse tree. A DML statement opens a scope of its own - a
    // subquery then resolves its aliases against its own sources first, and
    // only then against the enclosing statement (correlated references).
    _walk(node, scopes, ctes) {
        if (!node || node.symbol !== undefined) return;

        if (this._isStatement(node.ruleIndex)) {
            const scope = { aliases: new Map(), tables: new Set(), derived: new Map() };
            collectStatementScope(node, scope, ctes);
            collectDerivedSources(node, scope, ctes);
            scopes.push(scope);
            for (const t of scope.tables) {
                if (t !== DERIVED && !ctes.has(t)) this._tables.add(t);
            }
            this._collectFunctions(node);
            this._collectJoins(node, scopes, ctes, true);
            const count = node.getChildCount();
            for (let i = 0; i < count; i++) this._walk(node.getChild(i), scopes, ctes);
            scopes.pop();
            return;
        }

        const count = node.getChildCount();
        for (let i = 0; i < count; i++) this._walk(node.getChild(i), scopes, ctes);
    }

    // The functions called by a statement. Only schema-qualified ones are
    // kept: a bare name is a built-in (LEN, ISNULL...) more often than not.
    _collectFunctions(node) {
        for (const fc of findAllRule(node, TSqlParser.RULE_function_call)) {
            const name = this._functionName(fc);
            if (name && name.includes('.')) this._functions.add(name);
        }
    }

    _functionName(fc) {
        const nameCtx = firstCtx(fc.func_proc_name_server_database_schema ? fc.func_proc_name_server_database_schema() : null);
        return nameCtx ? cleanTableKey(nameCtx.getText()) : null;
    }

    // Finds the join structures of a statement: a table_source_item holding
    // two nested table_source_item is a JOIN (the right one is the joined
    // source, the left one the accumulated sources).
    _collectJoins(node, scopes, ctes, isRoot) {
        if (!node || node.symbol !== undefined) return;
        // A nested statement has its own joins - they are collected there.
        if (!isRoot && this._isStatement(node.ruleIndex)) return;

        if (node.ruleIndex === TSqlParser.RULE_table_source_item) {
            const nested = node.table_source_item ? node.table_source_item() : [];
            if (nested.length === 2) this._recordJoin(node, nested, scopes, ctes);
        } else if (node.ruleIndex === TSqlParser.RULE_table_sources) {
            this._recordCommaJoins(node, scopes, ctes);
        }

        const count = node.getChildCount();
        for (let i = 0; i < count; i++) this._collectJoins(node.getChild(i), scopes, ctes, false);
    }

    // FROM a, b, c: comma joins have no condition, the partner is the order.
    _recordCommaJoins(node, scopes, ctes) {
        const items = node.table_source_item ? node.table_source_item() : [];
        if (items.length < 2) return;
        const left = this._sources(items[0], scopes);
        for (let i = 1; i < items.length; i++) {
            for (const rt of this._sources(items[i], scopes)) {
                for (const lt of left) this._addJoin(lt, rt, '', {}, false, 'comma');
            }
        }
    }

    _recordJoin(node, nested, scopes, ctes) {
        const rightTables = this._sources(nested[1], scopes);
        const leftTables = this._sources(nested[0], scopes);
        if (rightTables.length === 0) return;

        const conditionCtx = firstCtx(node.search_condition ? node.search_condition() : null);
        const condition = conditionCtx ? this._text(conditionCtx) : '';
        const kind = this._joinKind(node);
        const refs = conditionCtx ? this._conditionRefs(conditionCtx, scopes, ctes) : [];

        for (const rt of rightTables) {
            const columns = {};
            const partners = new Set();
            let confident = true;

            for (const ref of refs) {
                if (ref.table) {
                    if (!columns[ref.table]) columns[ref.table] = [];
                    columns[ref.table].push(ref.column);
                    if (ref.table !== rt) partners.add(ref.table);
                } else {
                    // Unqualified column: which side it belongs to is unknown.
                    confident = false;
                    if (!columns[rt]) columns[rt] = [];
                    columns[rt].push(ref.column);
                }
            }

            if (partners.size === 0) {
                // No qualified partner in the condition: fall back to the join
                // order, but the edge is no longer certain.
                for (const lt of leftTables) if (lt !== rt) partners.add(lt);
                confident = false;
            }

            for (const pt of partners) this._addJoin(pt, rt, condition, columns, confident, kind);
        }
    }

    // The columns of a join condition, resolved to the table they belong to.
    _conditionRefs(conditionCtx, scopes, ctes) {
        const refs = [];
        for (const fcn of findAllRule(conditionCtx, TSqlParser.RULE_full_column_name)) {
            const parts = cleanTableKey(fcn.getText()).split('.').filter(Boolean);
            const column = parts.pop();
            if (!column) continue;
            const qualifier = parts.join('.');
            let table = null;
            if (qualifier) {
                // Innermost scope first, then the enclosing statements.
                let resolved = null;
                for (let i = scopes.length - 1; i >= 0; i--) {
                    const alias = scopes[i].aliases.get(qualifier);
                    if (alias) { resolved = alias; break; }
                }
                // Not an alias: a direct table reference (maybe schema-qualified).
                if (!resolved) resolved = qualifier;
                if (resolved === DERIVED) {
                    // A derived table: the columns belong to its base tables.
                    const base = this._expandAlias(qualifier, scopes);
                    resolved = base.length ? base[0] : null;
                } else {
                    const base = this._expandAlias(resolved, scopes);
                    resolved = base.length ? base[0] : resolved;
                }
                if (resolved && ctes.has(resolved)) resolved = null;
                table = resolved;
            }
            refs.push({ table, column });
        }
        return refs;
    }

    // The physical tables of a source: the leaves of its table_source_item
    // tree (a derived table or a subquery has no name of its own, its base
    // tables are used instead).
    _sources(node, scopes) {
        const out = [];
        for (const table of this._leafTables(node)) {
            // A CTE or a derived table is shown through the tables it selects
            // from; a plain table is itself.
            const expanded = this._expandAlias(table, scopes);
            for (const t of (expanded.length ? expanded : [table])) {
                if (!out.includes(t)) out.push(t);
            }
        }
        if (out.length === 0) {
            // A derived table on the right of a join: use the tables of its body.
            const alias = this._aliasOf(node);
            if (alias) {
                for (const expanded of this._expandAlias(alias, scopes)) {
                    if (!out.includes(expanded)) out.push(expanded);
                }
            }
        }
        return out;
    }

    _leafTables(node, out = []) {
        if (!node || node.symbol !== undefined) return out;
        if (node.ruleIndex === TSqlParser.RULE_table_source_item) {
            const nested = node.table_source_item ? node.table_source_item() : [];
            if (!nested || nested.length === 0) {
                const fon = firstCtx(node.full_object_name ? node.full_object_name() : null);
                if (fon) {
                    const table = cleanTableKey(fon.getText());
                    if (!out.includes(table)) out.push(table);
                }
                return out;
            }
        }
        const count = node.getChildCount();
        for (let i = 0; i < count; i++) this._leafTables(node.getChild(i), out);
        return out;
    }

    _aliasOf(node) {
        if (!node || node.symbol !== undefined) return null;
        if (node.ruleIndex === TSqlParser.RULE_table_source_item) {
            const aliasCtx = firstCtx(node.as_table_alias ? node.as_table_alias() : null);
            const aliasNode = aliasCtx ? findFirstRule(aliasCtx, TSqlParser.RULE_table_alias) : null;
            if (aliasNode) return cleanTableKey(aliasNode.getText());
        }
        const count = node.getChildCount();
        for (let i = 0; i < count; i++) {
            const alias = this._aliasOf(node.getChild(i));
            if (alias) return alias;
        }
        return null;
    }

    // The tables a derived table (or a CTE) selects from, when known.
    _expandAlias(name, scopes) {
        if (!name) return [];
        for (let i = scopes.length - 1; i >= 0; i--) {
            const derived = scopes[i].derived.get(name);
            if (derived) return derived;
        }
        return [];
    }

    // The original text of a node, whitespace included: ctx.getText() drops
    // the hidden-channel tokens and glues the words together.
    _text(ctx) {
        if (this._tokens && ctx.start && ctx.stop) {
            try {
                return this._tokens.getText({ start: ctx.start.tokenIndex, stop: ctx.stop.tokenIndex }).trim();
            } catch (e) { /* fall back to the concatenated text */ }
        }
        return ctx.getText();
    }

    // The kind of join, read from the keyword tokens around the JOIN/APPLY
    // token: the grammar labels them (ij/oj/cj/lj) but the JS runtime does not
    // keep those labels on the context.
    _joinKind(node) {
        if (!this._tokens) return 'join';

        let keyword = null;
        for (let i = 0; i < node.getChildCount(); i++) {
            const child = node.getChild(i);
            if (child.symbol === undefined) continue;
            const text = String(child.getText() || '').toUpperCase();
            if (text === 'JOIN' || text === 'APPLY') { keyword = { text, index: child.symbol.tokenIndex }; break; }
        }
        if (!keyword) return 'join';
        if (keyword.text === 'APPLY') return 'apply';

        const before = [];
        for (let i = keyword.index - 1; i >= keyword.index - 3 && i >= 0; i--) {
            let token = null;
            try { token = this._tokens.get(i); } catch (e) { token = null; }
            if (!token) continue;
            const text = String(token.text || '').toUpperCase();
            if (text === 'OUTER') continue;
            before.push(text);
        }
        for (const kind of ['LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS']) {
            if (before.includes(kind)) return kind.toLowerCase();
        }
        return 'join';
    }

    _addJoin(from, to, condition, columns, confident, kind) {
        const key = `${from}|${to}|${condition}`;
        if (this._seen.has(key)) return;
        this._seen.add(key);
        this._joins.push({ from, to, condition, columns, confident, kind });
    }
}

// Flags UPDATE/DELETE statements that have no WHERE clause. `ctx.WHERE()` returns
// null when the clause is absent (and also covers WHERE CURRENT OF, which is fine:
// a positioned cursor update is not a mass write).
class RiskVisitor extends TSqlParserVisitor {
    constructor() {
        super();
        this.risks = []; // { type: 'UPDATE'|'DELETE', table: string|null }
    }

    visitUpdate_statement(ctx) {
        if (!ctx.WHERE()) {
            this.risks.push({ type: 'UPDATE', table: extractFromDdlObject(ctx.ddl_object ? ctx.ddl_object() : null) });
        }
        this.visitChildren(ctx);
    }

    visitDelete_statement(ctx) {
        if (!ctx.WHERE()) {
            const from = ctx.delete_statement_from ? ctx.delete_statement_from() : null;
            const ddl = from && from.ddl_object ? from.ddl_object() : null;
            this.risks.push({ type: 'DELETE', table: extractFromDdlObject(ddl) });
        }
        this.visitChildren(ctx);
    }
}

class BabelfishSqlParser {
    constructor() {
        this._enabled = false;
    }

    setEnabled(enabled) {
        this._enabled = !!enabled;
    }

    isEnabled() {
        return this._enabled;
    }

    /**
     * Analyse une définition SQL et retourne un map { tableName (lowercase): [operations] }
     * @param {string} sqlDefinition
     * @returns {Object<string, string[]>|null}
     */
    analyzeOperations(sqlDefinition) {
        if (!sqlDefinition || !this._enabled) return null;

        try {
            const chars = new antlr4.InputStream(sqlDefinition);
            const lexer = new TSqlLexer(chars);
            const tokens = new antlr4.CommonTokenStream(lexer);
            const parser = new TSqlParser(tokens);
            // Suppress error spam — on veut un fail soft
            parser.removeErrorListeners();

            const tree = parser.tsql_file();
            const visitor = new OpsVisitor();
            visitor.visit(tree);
            return visitor.getResult();
        } catch (err) {
            console.warn(`[BabelfishSqlParser] Failed to analyze: ${err.message.substring(0, 150)}`);
            return null;
        }
    }

    /**
     * Column-level lineage of a definition.
     * @param {string} sqlDefinition
     * @returns {Object<string, Object<string, {write: boolean, confident: boolean}>>|null}
     *          { tableKey: { columnName: { write, confident } } }, keys lowercase;
     *          null when parsing is disabled or fails.
     */
    analyzeColumns(sqlDefinition) {
        if (!sqlDefinition || !this._enabled) return null;

        try {
            const chars = new antlr4.InputStream(sqlDefinition);
            const lexer = new TSqlLexer(chars);
            const tokens = new antlr4.CommonTokenStream(lexer);
            const parser = new TSqlParser(tokens);
            parser.removeErrorListeners();

            const tree = parser.tsql_file();
            const visitor = new ColumnLineageVisitor();
            visitor.visit(tree);
            return visitor.getResult();
        } catch (err) {
            console.warn(`[BabelfishSqlParser] Failed to analyze columns: ${err.message.substring(0, 150)}`);
            return null;
        }
    }

    /**
     * Join graph of a SQL text: the sources it reads and the way they are
     * joined together.
     * @param {string} sqlDefinition
     * @returns {{tables: string[], joins: Array<{from: string, to: string, condition: string, columns: Object, confident: boolean, kind: string}>}|null}
     *          null when parsing is disabled or fails.
     */
    analyzeJoins(sqlDefinition) {
        if (!sqlDefinition || !this._enabled) return null;

        try {
            const chars = new antlr4.InputStream(sqlDefinition);
            const lexer = new TSqlLexer(chars);
            const tokens = new antlr4.CommonTokenStream(lexer);
            const parser = new TSqlParser(tokens);
            parser.removeErrorListeners();

            const tree = parser.tsql_file();
            const visitor = new JoinGraphVisitor();
            return visitor.analyze(tree, tokens);
        } catch (err) {
            console.warn(`[BabelfishSqlParser] Failed to analyze joins: ${err.message.substring(0, 150)}`);
            return null;
        }
    }

    /**
     * Détecte les UPDATE/DELETE sans clause WHERE.
     * @param {string} sqlDefinition
     * @returns {Array<{type: string, table: string|null}>|null} null si parse impossible/désactivé
     */
    analyzeRisks(sqlDefinition) {
        if (!sqlDefinition || !this._enabled) return null;

        try {
            const chars = new antlr4.InputStream(sqlDefinition);
            const lexer = new TSqlLexer(chars);
            const tokens = new antlr4.CommonTokenStream(lexer);
            const parser = new TSqlParser(tokens);
            parser.removeErrorListeners();

            const tree = parser.tsql_file();
            const visitor = new RiskVisitor();
            visitor.visit(tree);
            return visitor.risks;
        } catch (err) {
            console.warn(`[BabelfishSqlParser] Failed to analyze risks: ${err.message.substring(0, 150)}`);
            return null;
        }
    }
}

module.exports = BabelfishSqlParser;