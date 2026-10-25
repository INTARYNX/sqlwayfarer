'use strict';

// Removes line/block comments and single-quoted string literals so the
// regex-based scans below never match text that isn't actually executable SQL
// (a comment mentioning "DROP TABLE", or a string literal containing "where").
// Replaces each stripped span with spaces rather than deleting it, so every
// remaining character's offset is unchanged - not load-bearing today, but
// cheap insurance against a future caller that wants positions back.
function stripCommentsAndStrings(sql) {
    let result = '';
    let i = 0;
    const n = sql.length;
    while (i < n) {
        if (sql[i] === '-' && sql[i + 1] === '-') {
            const end = sql.indexOf('\n', i);
            const stop = end === -1 ? n : end;
            result += ' '.repeat(stop - i);
            i = stop;
            continue;
        }
        if (sql[i] === '/' && sql[i + 1] === '*') {
            const end = sql.indexOf('*/', i + 2);
            const stop = end === -1 ? n : end + 2;
            result += ' '.repeat(stop - i);
            i = stop;
            continue;
        }
        if (sql[i] === "'") {
            let j = i + 1;
            while (j < n) {
                if (sql[j] === "'") {
                    if (sql[j + 1] === "'") { j += 2; continue; }
                    j += 1;
                    break;
                }
                j++;
            }
            result += ' '.repeat(j - i);
            i = j;
            continue;
        }
        result += sql[i];
        i++;
    }
    return result;
}

// Best-effort: finds the statement's real leading DML verb, skipping a
// leading WITH-CTE block (if any) by tracking paren depth. Same tradeoff as
// the rest of this fallback path - not a real parser, just enough to catch
// the common "WITH cte AS (...) UPDATE/DELETE ..." shape.
function leadingDmlVerb(statement) {
    const trimmed = statement.replace(/^\s+/, '');
    const direct = trimmed.match(/^(update|delete)\b/i);
    if (direct) return direct[1].toLowerCase();
    if (!/^with\b/i.test(trimmed)) return null;

    let depth = 0;
    for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if (depth === 0) {
            const m = trimmed.slice(i).match(/^(update|delete)\b/i);
            if (m) return m[1].toLowerCase();
        }
    }
    return null;
}

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
        const cleaned = stripCommentsAndStrings(sql);

        const parsed = this._sqlParser ? this._sqlParser.analyzeRisks(sql) : null;
        if (parsed) {
            for (const risk of parsed) {
                risks.push(risk.table
                    ? `${risk.type} without WHERE on ${risk.table}`
                    : `${risk.type} without WHERE`);
            }
        } else {
            // Parser unavailable or SQL unparseable: coarse per-statement heuristic.
            for (const statement of cleaned.split(/;|^\s*GO\s*$/im)) {
                const verb = leadingDmlVerb(statement);
                if (verb && !/\bwhere\b/i.test(statement)) {
                    risks.push(`${verb.toUpperCase()} without WHERE`);
                }
            }
        }

        for (const truncate of cleaned.match(/\btruncate\s+table\s+[^\s;]+/gi) || []) {
            risks.push(truncate.replace(/\s+/g, ' ').trim());
        }
        for (const drop of cleaned.match(/\bdrop\s+(?:table|view|procedure|proc|function|trigger|index|database)\s+[^\s;]+/gi) || []) {
            risks.push(drop.replace(/\s+/g, ' ').trim());
        }

        return risks;
    }
}

module.exports = QueryRiskAnalyzer;
QueryRiskAnalyzer.stripCommentsAndStrings = stripCommentsAndStrings;
