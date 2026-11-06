'use strict';

/**
 * BabelfishSqlParser - Analyzes the SQL code of a SQL Server object to
 * extract the DML operations (SELECT/INSERT/UPDATE/DELETE/MERGE) per referenced table.
 *
 * Uses the official Babelfish ANTLR grammar (open-source, the most complete
 * one available for T-SQL), compiled with the antlr4 JS runtime.
 *
 * ⚠️ Known limits:
 *  - Dynamic SQL (EXEC with a dynamic string) → not resolved (fail safe)
 *  - Exotic SQL / grammar bugs → returns the partial analysis
 */

const antlr4 = require('antlr4');
const TSqlLexer = require('./generated/TSqlLexer');
const TSqlParser = require('./generated/TSqlParser');
const OpsVisitor = require('./OpsVisitor');
const ColumnLineageVisitor = require('./ColumnLineageVisitor');
const JoinGraphVisitor = require('./JoinGraphVisitor');
const RiskVisitor = require('./RiskVisitor');

// How many levels of EXEC('EXEC(...)') are followed.
const MAX_LITERAL_DEPTH = 2;

// Collects the syntax errors of a parse. ANTLR does not stop on them: it
// recovers, builds a tree anyway, and the visitor walks that tree - so a
// definition with a syntax error would be analyzed as if it were complete,
// and could report writes it never really performs.
class CollectingErrorListener extends antlr4.ErrorListener {
    constructor() {
        super();
        this.errors = [];
    }

    syntaxError(recognizer, offendingSymbol, line, column, msg) {
        this.errors.push({ line, column, message: String(msg).slice(0, 200) });
    }
}

class BabelfishSqlParser {
    constructor() {
        this._enabled = false;
        // Fast SLL stage first (see _parseTree); off only to compare with the full parse.
        this._fastPrediction = true;
    }

    setEnabled(enabled) {
        this._enabled = !!enabled;
    }

    isEnabled() {
        return this._enabled;
    }

    /**
     * Analyzes a SQL definition and returns a map { tableName (lowercase): [operations] }
     * @param {string} sqlDefinition
     * @returns {Object<string, string[]>|null}
     */
    analyzeOperations(sqlDefinition) {
        if (!sqlDefinition || !this._enabled) return null;

        try {
            const { tree } = this._parseTree(sqlDefinition);
            const visitor = new OpsVisitor();
            visitor.visit(tree);
            return visitor.getResult();
        } catch (err) {
            console.warn(`[BabelfishSqlParser] Failed to analyze: ${err.message.substring(0, 150)}`);
            return null;
        }
    }

    // The parse tree of a definition, shared by the analyzers: parsing is the
    // expensive part, and several analyses can run over the same tree.
    // collectErrors keeps the syntax errors instead of dropping them: they
    // are what tells a complete analysis from a partial one.
    //
    // Two stages, the usual ANTLR strategy: first SLL prediction with the first
    // syntax error as a bail-out - several times faster, and for a text it
    // accepts the tree is the one full-context prediction gives - then, only
    // when that stage fails, the full-context parse (which is also where the
    // syntax errors are collected and the partial tree built).
    _parseTree(sqlDefinition, collectErrors = false) {
        if (this._fastPrediction) {
            try {
                return this._parseOnce(sqlDefinition, collectErrors, true);
            } catch {
                // Not accepted by the fast stage: the full parse decides.
            }
        }
        return this._parseOnce(sqlDefinition, collectErrors, false);
    }

    _parseOnce(sqlDefinition, collectErrors, fast) {
        const chars = new antlr4.InputStream(sqlDefinition);
        const lexer = new TSqlLexer(chars);
        const tokens = new antlr4.CommonTokenStream(lexer);
        const parser = new TSqlParser(tokens);
        // Suppresses the error spam - we want a soft failure
        parser.removeErrorListeners();
        let errors = null;
        if (fast) {
            parser._interp.predictionMode = antlr4.PredictionMode.SLL;
            parser._errHandler = new antlr4.BailErrorStrategy();
            // Reaching the end means there was no syntax error to collect.
            if (collectErrors) errors = [];
        } else if (collectErrors) {
            const listener = new CollectingErrorListener();
            parser.addErrorListener(listener);
            errors = listener.errors;
        }
        return { tree: parser.tsql_file(), tokens, parser, errors };
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
            const { tree } = this._parseTree(sqlDefinition);
            const visitor = new ColumnLineageVisitor();
            visitor.visit(tree);
            return visitor.getResult();
        } catch (err) {
            console.warn(`[BabelfishSqlParser] Failed to analyze columns: ${err.message.substring(0, 150)}`);
            return null;
        }
    }

    /**
     * Full static analysis of a definition, from a single parse: the
     * column-level lineage, the table-level writes, and the syntax errors
     * met on the way.
     *
     * The two levels answer different questions and are both needed: the
     * columns tell WHICH columns receive a new value (column impact), the
     * table writes tell THAT a table is written - including the writes that
     * name no column at all (a DELETE, an INSERT without a column list).
     *
     * The errors matter because ANTLR recovers from them: the tree of a
     * broken definition is still walked, so the analysis is partial and
     * must be reported as such.
     *
     * @param {string} sqlDefinition
     * @returns {{columns: Object<string, Object<string, {write: boolean, confident: boolean}>>, writes: string[], writeOps: object, conditionalWrites: string[], errors: Array<{line: number, column: number, message: string}>}|null}
     *          null when parsing is disabled or fails.
     */
    // A statement written as a literal in EXEC('...') is code like the rest of
    // the definition: it is parsed, and what it reads and writes counts. A
    // literal that holds another EXEC is followed too, two levels at most.
    _followLiterals(visitor, depth) {
        if (depth >= MAX_LITERAL_DEPTH) return;
        const texts = visitor.getLiterals();
        for (let index = 0; index < texts.length; index++) {
            const text = texts[index];
            let nested;
            try {
                nested = new ColumnLineageVisitor();
                nested.visit(this._parseTree(text, true).tree);
            } catch {
                continue;
            }
            this._followLiterals(nested, depth + 1);
            visitor.absorb(nested, index);
        }
    }

    analyzeDefinition(sqlDefinition) {
        if (!sqlDefinition || !this._enabled) return null;

        try {
            const { tree, errors } = this._parseTree(sqlDefinition, true);
            const visitor = new ColumnLineageVisitor();
            visitor.visit(tree);
            this._followLiterals(visitor, 0);
            return {
                columns: visitor.getResult(),
                writes: visitor.getWrites(),
                writeOps: visitor.getWriteOps(),
                conditionalWrites: visitor.getConditionalWrites(),
                errors: errors || []
            };
        } catch (err) {
            console.warn(`[BabelfishSqlParser] Failed to analyze: ${err.message.substring(0, 150)}`);
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
            const { tree, tokens } = this._parseTree(sqlDefinition);
            const visitor = new JoinGraphVisitor();
            return visitor.analyze(tree, tokens);
        } catch (err) {
            console.warn(`[BabelfishSqlParser] Failed to analyze joins: ${err.message.substring(0, 150)}`);
            return null;
        }
    }

    /**
     * Detects the UPDATE/DELETE statements without a WHERE clause.
     * @param {string} sqlDefinition
     * @returns {Array<{type: string, table: string|null}>|null} null when the parsing is impossible or disabled
     */
    analyzeRisks(sqlDefinition) {
        if (!sqlDefinition || !this._enabled) return null;

        try {
            const { tree } = this._parseTree(sqlDefinition);
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