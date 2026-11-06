'use strict';

// The DML operations (SELECT, INSERT, UPDATE, DELETE, MERGE) a definition does on each table.
const TSqlParserVisitor = require('./generated/TSqlParserVisitor');
const { extractFromFullObjectName, extractFromDdlObject, cleanTableKey, firstCtx, collectTableAliases } = require('./sqlParseHelpers');

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

    // table_source_item is a left-recursive rule (JOIN, CROSS APPLY, PIVOT, ...):
    // a FROM with a JOIN yields a single top-level item, so the tree has to be
    // walked down to find every referenced full_object_name.
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
        // The optional FROM clause (UPDATE ... FROM a JOIN b ON ...) is read, not written
        this._collectFromTableSources(tableSources, 'SELECT');
        // Visits the subqueries (SELECT in SET, WHERE, etc.)
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
        // The optional FROM clause (DELETE ... FROM a JOIN b ON ...) is read, not written
        this._collectFromTableSources(tableSources, 'SELECT');
        this.visitChildren(ctx);
    }

    // === SELECT - captured via the table_sources of the query ===
    visitQuery_specification(ctx) {
        this._collectFromTableSources(ctx.table_sources ? ctx.table_sources() : null, 'SELECT');
        // Also explores the subqueries, etc.
        this.visitChildren(ctx);
    }

    // === MERGE - conservative: MERGE is noted, without detailing the WHEN clauses ===
    visitMerge_statement(ctx) {
        const target = ctx.ddl_object ? ctx.ddl_object() : null;
        const table = this._extractFromDdlObject(target);
        if (table) this._addOp(table, 'MERGE');
        // USING table_sources: the source read by the MERGE
        this._collectFromTableSources(ctx.table_sources ? ctx.table_sources() : null, 'SELECT');
        this.visitChildren(ctx);
    }
}

module.exports = OpsVisitor;
