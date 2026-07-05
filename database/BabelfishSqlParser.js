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
        // Aligné avec DependencyService qui nettoie les crochets ([dbo].[Table]) avant lookup
        const t = tableName.replace(/[\[\]]/g, '').toLowerCase();
        if (!this._ops.has(t)) this._ops.set(t, new Set());
        this._ops.get(t).add(operation);
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
        const table = this._extractFromDdlObject(ddl);
        this._addOp(table, 'UPDATE');
        // La clause FROM optionnelle (UPDATE ... FROM a JOIN b ON ...) est lue, pas écrite
        this._collectFromTableSources(ctx.table_sources ? ctx.table_sources() : null, 'SELECT');
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
        // La clause FROM optionnelle (DELETE ... FROM a JOIN b ON ...) est lue, pas écrite
        this._collectFromTableSources(ctx.table_sources ? ctx.table_sources() : null, 'SELECT');
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