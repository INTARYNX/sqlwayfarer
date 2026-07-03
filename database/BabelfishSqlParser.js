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
        const t = tableName.toLowerCase();
        if (!this._ops.has(t)) this._ops.set(t, new Set());
        this._ops.get(t).add(operation);
    }

    _extractFromFullObjectName(fonCtx) {
        if (!fonCtx) return null;
        const ids = fonCtx.id ? fonCtx.id() : [];
        if (ids.length === 0) return null;
        return ids[ids.length - 1].getText();
    }

    _extractFromDdlObject(ddlCtx) {
        if (!ddlCtx) return null;
        const fon = ddlCtx.full_object_name ? ddlCtx.full_object_name() : null;
        if (fon) return this._extractFromFullObjectName(fon);
        return null;
    }

    // === UPDATE ===
    visitUpdate_statement(ctx) {
        const ddl = ctx.ddl_object ? ctx.ddl_object() : null;
        const table = this._extractFromDdlObject(ddl);
        this._addOp(table, 'UPDATE');
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
        const table = this._extractFromDdlObject(ddl);
        this._addOp(table, 'DELETE');
        this.visitChildren(ctx);
    }

    // === SELECT — capturé via table_sources dans la query ===
    visitQuery_specification(ctx) {
        const tableSources = ctx.table_sources ? ctx.table_sources() : null;
        if (tableSources) {
            const items = tableSources.table_source_item ? tableSources.table_source_item() : [];
            for (const item of items) {
                const fon = item.full_object_name ? item.full_object_name() : null;
                const table = this._extractFromFullObjectName(fon);
                this._addOp(table, 'SELECT');
            }
        }
        // Aussi explorer les JOINs, etc.
        this.visitChildren(ctx);
    }

    // === MERGE — conservateur : on note MERGE, sans détailler WHEN clauses ===
    visitMerge_statement(ctx) {
        const target = ctx.dml_object ? ctx.dml_object() : (ctx.ddl_object ? ctx.ddl_object() : null);
        const table = this._extractFromDdlObject(target);
        if (table) this._addOp(table, 'MERGE');
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
}

module.exports = BabelfishSqlParser;