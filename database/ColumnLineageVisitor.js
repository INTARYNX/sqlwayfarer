'use strict';

// Column-level lineage and table-level writes of a definition.
const TSqlParser = require('./generated/TSqlParser');
const TSqlParserVisitor = require('./generated/TSqlParserVisitor');
const { cleanTableKey, firstCtx, findFirstRule, DERIVED, collectStatementScope } = require('./sqlParseHelpers');

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
        this._writes = new Map(); // table -> Set of 'insert' | 'update' | 'delete' : tables written by the statement itself
        this._scope = null;
        this._ctes = new Set();
        this._triggerTable = null;
        this._literals = []; // the statements written as a literal in EXEC('...') or sp_executesql N'...'
        // The variables that hold a statement written once as a literal and run by EXEC(@s):
        // how many times each name appears, how many of those are accounted for, and what it is given.
        this._variableTotal = new Map();
        this._variableKnown = new Map();
        this._variableValues = new Map();
        this._variableRuns = [];
        this._maybe = 0; // > 0 while visiting code that runs only on some executions (CATCH, a branch chosen by UPDATE() or inserted/deleted)
        this._sure = new Set(); // tables written at least once by code that always runs
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

    // The text of the statements written as a literal in EXEC('...') or in
    // sp_executesql N'...': they are code, and the caller analyzes them.
    getLiterals() {
        this._resolveVariables();
        return this._literals.map(literal => literal.text);
    }

    // The tree is read once for the variables before it is visited: a variable
    // is followed only when every place it appears is known.
    visit(tree) {
        const count = node => {
            if (node.symbol && node.symbol.type === TSqlParser.LOCAL_ID) {
                const name = node.getText().toLowerCase();
                this._variableTotal.set(name, (this._variableTotal.get(name) || 0) + 1);
            }
            for (let i = 0; i < node.getChildCount(); i++) count(node.getChild(i));
        };
        if (!Array.isArray(tree)) count(tree);
        return super.visit(tree);
    }

    _knowVariable(name) {
        this._variableKnown.set(name, (this._variableKnown.get(name) || 0) + 1);
    }

    // EXEC(@s) / sp_executesql @s, where @s is declared and given a literal once,
    // and appears nowhere else (not a parameter, not changed, not passed on): the
    // statement is that literal. A variable that is built, appended to or received
    // says nothing of what runs.
    _resolveVariables() {
        for (const { name, maybe } of this._variableRuns.splice(0)) {
            const values = this._variableValues.get(name) || [];
            if (values.length === 1 && this._variableTotal.get(name) === this._variableKnown.get(name)) {
                this._literals.push({ text: values[0], maybe });
            }
        }
    }

    // The text of a string literal alone ('...' or N'...'), or null.
    static _loneLiteral(ctx) {
        const match = ctx ? /^N?'((?:[^']|'')*)'$/i.exec(ctx.getText().trim()) : null;
        return match ? match[1].replace(/''/g, "'") : null;
    }

    // DECLARE @s nvarchar(max) = N'...' (or without a value).
    visitDeclare_local(ctx) {
        const id = ctx.LOCAL_ID ? ctx.LOCAL_ID() : null;
        if (id) {
            const name = id.getText().toLowerCase();
            const expression = this._first(ctx.expression ? ctx.expression() : null);
            const literal = ColumnLineageVisitor._loneLiteral(expression);
            if (!expression) this._knowVariable(name);
            else if (literal !== null) {
                this._knowVariable(name);
                this._variableValues.set(name, [...(this._variableValues.get(name) || []), literal]);
            }
        }
        this.visitChildren(ctx);
    }

    // SET @s = N'...'
    visitSet_statement(ctx) {
        const id = ctx.LOCAL_ID ? ctx.LOCAL_ID() : null;
        const expression = this._first(ctx.expression ? ctx.expression() : null);
        const literal = id && expression && ctx.EQUAL && ctx.EQUAL() && !(ctx.DOT && ctx.DOT()) ? ColumnLineageVisitor._loneLiteral(expression) : null;
        if (literal !== null) {
            const name = id.getText().toLowerCase();
            this._knowVariable(name);
            this._variableValues.set(name, [...(this._variableValues.get(name) || []), literal]);
        }
        this.visitChildren(ctx);
    }

    // The variable EXEC(@s) or sp_executesql @s runs, when that is all it does.
    static _variableOf(body) {
        const strings = [];
        const collect = node => {
            if (node.ruleIndex === TSqlParser.RULE_execute_var_string) strings.push(node.getText());
            else for (let i = 0; i < node.getChildCount(); i++) collect(node.getChild(i));
        };
        collect(body);
        if (strings.length > 0) {
            const alone = /^\((@\w+)\)(?:AS(?:LOGIN|USER)=.*)?$/i.exec(body.getText());
            return alone ? alone[1].toLowerCase() : null;
        }
        const nameCtx = firstCtx(body.func_proc_name_server_database_schema ? body.func_proc_name_server_database_schema() : null);
        const name = nameCtx ? cleanTableKey(nameCtx.getText()) : '';
        if (!/^(?:sys\.)?sp_executesql$/i.test(name)) return null;
        const params = [];
        const findParams = node => {
            if (node.ruleIndex === TSqlParser.RULE_execute_parameter) params.push(node.getText());
            else for (let i = 0; i < node.getChildCount(); i++) findParams(node.getChild(i));
        };
        findParams(body);
        return params.length > 0 && /^@\w+$/.test(params[0]) ? params[0].toLowerCase() : null;
    }

    // What the statements of another analysis (a literal) did, as if they had
    // been written here. `index` is the position of the literal in getLiterals().
    absorb(other, index = -1) {
        for (const [table, cols] of other._result.entries()) {
            for (const [col, info] of cols.entries()) this._record(table, col, { write: info.write, confident: info.confident });
        }
        // The writes are certain only when the literal is itself in code that always runs.
        const always = this._maybe === 0 && !(index >= 0 && this._literals[index].maybe);
        this._maybe++;
        for (const [table, ops] of other._writes.entries()) this._recordWrite(table, ...ops);
        this._maybe--;
        if (always) for (const table of other._sure) this._sure.add(table);
    }

    // EXEC('...') / EXEC sp_executesql N'...': the text of the literal, or null
    // when the statement is built in a variable or by concatenation - nothing
    // says what it holds then.
    static _literalOf(body) {
        const unquote = text => {
            const match = /^N?'((?:[^']|'')*)'$/i.exec((text || '').trim());
            return match ? match[1].replace(/''/g, "'") : null;
        };
        const strings = [];
        const collect = node => {
            if (node.ruleIndex === TSqlParser.RULE_execute_var_string) strings.push(node.getText());
            for (let i = 0; i < node.getChildCount(); i++) collect(node.getChild(i));
        };
        collect(body);
        // EXEC('...') holds one literal and nothing else: 'a' + @t is a text
        // built at run time, whose first piece says nothing of what runs.
        if (strings.length > 0) {
            const alone = /^\((N?'(?:[^']|'')*')\)(?:AS(?:LOGIN|USER)=.*)?$/i.exec(body.getText());
            return alone ? unquote(alone[1]) : null;
        }
        const nameCtx = firstCtx(body.func_proc_name_server_database_schema ? body.func_proc_name_server_database_schema() : null);
        const name = nameCtx ? cleanTableKey(nameCtx.getText()) : '';
        if (!/^(?:sys\.)?sp_executesql$/i.test(name)) return null;
        const params = [];
        const findParams = node => {
            if (node.ruleIndex === TSqlParser.RULE_execute_parameter) params.push(node.getText());
            else for (let i = 0; i < node.getChildCount(); i++) findParams(node.getChild(i));
        };
        findParams(body);
        return params.length > 0 ? unquote(params[0]) : null;
    }

    visitExecute_statement(ctx) {
        const body = this._first(ctx.execute_body ? ctx.execute_body() : null);
        const literal = body ? ColumnLineageVisitor._literalOf(body) : null;
        if (literal) this._literals.push({ text: literal, maybe: this._maybe > 0 });
        else if (body) {
            const name = ColumnLineageVisitor._variableOf(body);
            if (name) {
                this._knowVariable(name);
                this._variableRuns.push({ name, maybe: this._maybe > 0 });
            }
        }
        this.visitChildren(ctx);
    }

    // Tables written by the definition, whatever the columns involved.
    getWrites() {
        return [...this._writes.keys()].sort();
    }

    // What the definition does to each table it writes: { table: ['delete', 'insert', 'update'] }.
    // A trigger fires on one kind of write, not on every one.
    getWriteOps() {
        const out = {};
        for (const table of this.getWrites()) out[table] = [...this._writes.get(table)].sort();
        return out;
    }

    // The tables written only by code that runs on some executions: in a CATCH
    // block, or in the branch of a trigger chosen by UPDATE(column) or by
    // what inserted and deleted hold.
    getConditionalWrites() {
        return this.getWrites().filter(table => !this._sure.has(table));
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

    // A table written by the statement itself: the target of an UPDATE, INSERT,
    // DELETE or MERGE. Tracked at the table level because some writes have no
    // column to name - a DELETE writes no column value, an INSERT without a
    // column list writes unknown ones. The column lineage cannot express them,
    // and the write footprint needs to know the table is written to follow the
    // triggers that fire on it.
    _recordWrite(table, ...ops) {
        if (!table || table === DERIVED) return;
        if (this._ctes.has(table)) return;
        if (!this._writes.has(table)) this._writes.set(table, new Set());
        for (const op of ops) this._writes.get(table).add(op);
        if (this._maybe === 0) this._sure.add(table);
    }

    // CATCH runs only when the TRY failed.
    visitCatch_block(ctx) {
        this._maybe++;
        this.visitChildren(ctx);
        this._maybe--;
        return null;
    }

    // In a trigger, IF UPDATE(col) and a test on inserted / deleted pick the
    // part that runs for this write: the branches are then conditional.
    visitIf_statement(ctx) {
        const condition = this._first(ctx.search_condition ? ctx.search_condition() : null);
        const picksByWrite = !!this._triggerTable && !!condition && /update\(|columns_updated\(|inserted|deleted/i.test(condition.getText());
        for (let i = 0; i < ctx.getChildCount(); i++) {
            const child = ctx.getChild(i);
            const branch = picksByWrite && child.ruleIndex === TSqlParser.RULE_sql_clauses;
            if (branch) this._maybe++;
            child.accept(this);
            if (branch) this._maybe--;
        }
        return null;
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
                    this._recordWrite(resolved, 'update');
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
                // The table is written even without a column list: the written
                // columns are then unknown, but the write itself is certain.
                this._recordWrite(target, 'insert');
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
                if (resolved && resolved !== DERIVED) {
                    this._scope.tables.add(resolved);
                    // A DELETE writes the table but no column value: only the
                    // table level can carry that.
                    this._recordWrite(resolved, 'delete');
                }
            }
            this.visitChildren(ctx);
        });
    }

    // OUTPUT ... INTO target: the clause writes that table (a table variable
    // or a temp table included), with the listed columns when there is a list.
    visitOutput_clause(ctx) {
        const tableCtx = this._first(ctx.table_name ? ctx.table_name() : null);
        if (tableCtx) {
            const target = this._resolveQualifier(this._clean(tableCtx.getText()));
            if (target && target !== DERIVED) {
                this._recordWrite(target, 'insert');
                const list = this._first(ctx.column_name_list ? ctx.column_name_list() : null);
                if (list) {
                    for (const idNode of this._findAll(list, TSqlParser.RULE_id)) {
                        this._record(target, this._clean(idNode.getText()), { write: true, confident: true });
                    }
                }
            }
        }
        this.visitChildren(ctx);
    }

    // TRUNCATE TABLE writes the table (it empties it) and fires no trigger:
    // its operation is neither an insert, an update nor a delete.
    visitTruncate_table(ctx) {
        const name = this._first(ctx.table_name ? ctx.table_name() : null);
        if (name) {
            const resolved = this._resolveQualifier(this._clean(name.getText()));
            if (resolved && resolved !== DERIVED) this._recordWrite(resolved, 'truncate');
        }
        this.visitChildren(ctx);
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
                    // A MERGE always writes its target (insert, update or
                    // delete), even when the WHEN clauses name no column. The
                    // clauses say which of the three it does.
                    const clauses = ctx.getText().toUpperCase();
                    const ops = ['INSERT', 'UPDATE', 'DELETE'].filter(op => clauses.includes(`THEN${op}`)).map(op => op.toLowerCase());
                    this._recordWrite(target, ...(ops.length > 0 ? ops : ['insert', 'update', 'delete']));
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

    // SELECT ... INTO target: creates and fills that table (a temp table
    // included).
    visitQuery_specification(ctx) {
        const into = this._first(ctx.table_name ? ctx.table_name() : null);
        if (into && ctx.INTO && ctx.INTO()) {
            const target = this._resolveQualifier(this._clean(into.getText()));
            if (target && target !== DERIVED) this._recordWrite(target);
        }
        this.visitChildren(ctx);
        return null;
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

module.exports = ColumnLineageVisitor;
