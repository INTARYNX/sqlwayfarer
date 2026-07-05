'use strict';

// Flags destructive statements in a query before execution:
// - UPDATE / DELETE without WHERE (via the T-SQL parser; regex heuristic as fallback)
// - TRUNCATE TABLE and DROP <object> (regex: keywords are unambiguous)
// Returns human-readable risk descriptions; an empty array means "safe to run".
class QueryRiskAnalyzer {
    constructor(sqlParser = null) {
        this._sqlParser = sqlParser;
    }

    analyze(sql) {
        if (!sql) return [];
        const risks = [];

        const parsed = this._sqlParser ? this._sqlParser.analyzeRisks(sql) : null;
        if (parsed) {
            for (const risk of parsed) {
                risks.push(risk.table
                    ? `${risk.type} without WHERE on ${risk.table}`
                    : `${risk.type} without WHERE`);
            }
        } else {
            // Parser unavailable or SQL unparseable: coarse per-statement heuristic.
            for (const statement of sql.split(/;|^\s*GO\s*$/im)) {
                const match = statement.match(/^\s*(update|delete)\b/i);
                if (match && !/\bwhere\b/i.test(statement)) {
                    risks.push(`${match[1].toUpperCase()} without WHERE`);
                }
            }
        }

        for (const truncate of sql.match(/\btruncate\s+table\s+[^\s;]+/gi) || []) {
            risks.push(truncate.replace(/\s+/g, ' ').trim());
        }
        for (const drop of sql.match(/\bdrop\s+(?:table|view|procedure|proc|function|trigger|index|database)\s+[^\s;]+/gi) || []) {
            risks.push(drop.replace(/\s+/g, ' ').trim());
        }

        return risks;
    }
}

module.exports = QueryRiskAnalyzer;
