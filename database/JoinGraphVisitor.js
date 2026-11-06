'use strict';

// The join graph of a SQL text.
const TSqlParser = require('./generated/TSqlParser');
const { cleanTableKey, firstCtx, findFirstRule, findAllRule, DERIVED, collectStatementScope, collectDerivedSources } = require('./sqlParseHelpers');

/**
 * Join graph of a SQL text: which sources are joined to which, and on which
 * columns. Complements analyzeColumns (what a statement reads) with the
 * relational structure (which source is joined to which).
 *
 * Result: { tables, functions, joins }
 *  - `tables`: the physical tables read by the text (lowercase, schema kept
 *    when the SQL spells it out)
 *  - `functions`: the schema-qualified functions called by the text, and the
 *    procedures it EXECs - they are code objects, not tables: their own tables
 *    are followed elsewhere
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
        // The calls whose name looks like a system procedure (sp_..., xp_...):
        // they are usually one, but the user may have created one too.
        this._possibleSystemCalls = new Set();
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
        return {
            tables: [...this._tables],
            functions: [...this._functions],
            possibleSystemCalls: [...this._possibleSystemCalls],
            joins: this._joins
        };
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

        if (node.ruleIndex === TSqlParser.RULE_execute_body) this._collectExecuted(node);

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

    // The procedure an EXEC runs. Unlike a function call, a bare name is a procedure
    // (EXEC uspClose); the system ones (sp_help, xp_cmdshell) are left out.
    _collectExecuted(body) {
        const nameCtx = firstCtx(body.func_proc_name_server_database_schema ? body.func_proc_name_server_database_schema() : null);
        const name = nameCtx ? cleanTableKey(nameCtx.getText()) : null;
        if (!name) return;
        if (name.includes('.')) { this._functions.add(name); return; }
        // A bare name that looks like a system procedure (sp_..., xp_...) is
        // usually one - but the user may have created one too, and it would
        // then be followed as any other procedure. It is not dropped: the
        // caller resolves it against the catalog, and a system procedure that
        // is not there is simply left alone.
        if (/^(?:sp|xp)_/i.test(name)) { this._possibleSystemCalls.add(name); return; }
        this._functions.add(name);
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
            this._recordCommaJoins(node, scopes);
        }

        const count = node.getChildCount();
        for (let i = 0; i < count; i++) this._collectJoins(node.getChild(i), scopes, ctes, false);
    }

    // FROM a, b, c: comma joins have no condition, the partner is the order.
    _recordCommaJoins(node, scopes) {
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
            } catch { /* fall back to the concatenated text */ }
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
            try { token = this._tokens.get(i); } catch { token = null; }
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

module.exports = JoinGraphVisitor;
