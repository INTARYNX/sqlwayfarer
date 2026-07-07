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
        if (!node || node.symbol !== undefined) return;

        if (node.ruleIndex === TSqlParser.RULE_table_source_item) {
            // Joined sources are one flattened ctx with nested table_source_item
            // children; only leaf items carry a reliable table/alias pairing.
            const nested = node.table_source_item ? node.table_source_item() : [];
            const isLeaf = !nested || nested.length === 0;
            if (isLeaf) {
                const fon = this._first(node.full_object_name ? node.full_object_name() : null);
                const aliasCtx = this._first(node.as_table_alias ? node.as_table_alias() : null);
                const table = fon ? this._clean(fon.getText()) : DERIVED;
                if (fon) scope.tables.add(table);
                if (aliasCtx) {
                    const aliasNode = this._findFirst(aliasCtx, TSqlParser.RULE_table_alias);
                    if (aliasNode) scope.aliases.set(this._clean(aliasNode.getText()), table);
                }
            }
        } else if (node.ruleIndex === TSqlParser.RULE_common_table_expression) {
            const idNode = this._findFirst(node, TSqlParser.RULE_id);
            if (idNode) this._ctes.add(this._clean(idNode.getText()));
        }

        const count = node.getChildCount();
        for (let i = 0; i < count; i++) this._collectScope(node.getChild(i), scope);
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