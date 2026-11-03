'use strict';

// Removes line/block comments and single-quoted string literals so the
// regex-based scans below never match text that isn't actually executable SQL
// (a comment mentioning "DROP TABLE", or a string literal containing "where").
// Replaces each stripped span with spaces rather than deleting it, so every
// remaining character's offset is unchanged - not load-bearing today, but
// cheap insurance against a future caller that wants positions back.
function stripCommentsAndStrings(sql, keepStrings = false) {
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
            result += keepStrings ? sql.slice(i, j) : ' '.repeat(j - i);
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

// The target of an UPDATE / DELETE, to tell a temporary table or a table
// variable (nothing to lose) from a real table.
function dmlTarget(statement) {
    const m = statement.replace(/^\s+/, '').match(/^(?:update|delete)\s+(?:top\s*\([^)]*\)\s*(?:percent\s+)?)?(?:from\s+)?([^\s(;]+)/i);
    return m ? m[1] : null;
}

const isScratchTarget = name => !!name && /^[#@]/.test(name.replace(/^\[/, ''));

// The verbs of the statements that change data or schema, in the order of
// appearance and without repeats; a statement aimed at a temporary table or a
// table variable does not count.
function productionWrites(cleaned) {
    const verbs = [];
    for (const m of cleaned.matchAll(/(?:^|;)[ \t]*(insert|update|delete|merge|create|alter|drop|truncate)\b([^\n;]*)/gim)) {
        if (/^\s*(?:(?:into|from|table|unique|clustered|nonclustered)\s+)*[#@]/i.test(m[2])) continue;
        const verb = m[1].toUpperCase();
        if (!verbs.includes(verb)) verbs.push(verb);
    }
    return verbs;
}

// Object kinds a DROP is flagged for.
const DROP_KINDS = 'table|view|procedure|proc|function|trigger|index|database|schema|synonym|user|login|role|type|sequence|assembly';

// A dynamic statement is only checked when it is written as a literal
// (EXEC('...') / sp_executesql N'...'); one built in a variable is not visible.
const DYNAMIC_LITERAL = /\b(?:exec(?:ute)?\s*\(\s*|sp_executesql\s+)N?'((?:[^']|'')*)'/gi;
const MAX_DYNAMIC_DEPTH = 2;

// Flags destructive statements in a query before execution:
// - UPDATE / DELETE without WHERE, or with a WHERE that is always true
//   (via the T-SQL parser; regex heuristic as fallback). A temporary table or
//   a table variable is not flagged.
// - TRUNCATE TABLE, DROP <object>, ALTER TABLE ... DROP/ALTER COLUMN, MERGE ...
//   THEN DELETE, ALTER DATABASE ... SET SINGLE_USER/OFFLINE/EMERGENCY and
//   xp_cmdshell (regex: keywords are unambiguous)
// - the same checks inside a dynamic statement written as a literal
// - on a production connection (options.production), every statement that
//   changes data or schema, whatever its WHERE
// Returns human-readable risk descriptions; an empty array means "safe to run".
class QueryRiskAnalyzer {
    constructor(sqlParser = null) {
        this._sqlParser = sqlParser;
    }

    analyze(sql, { production = false } = {}) {
        const risks = this._analyze(sql, 0);
        if (production) {
            const writes = productionWrites(stripCommentsAndStrings(sql || ''));
            if (writes.length > 0) risks.push(`Changes data or schema (${writes.join(', ')}) on a production connection`);
        }
        return risks;
    }

    _analyze(sql, depth) {
        if (!sql) return [];
        const risks = [];
        const cleaned = stripCommentsAndStrings(sql);

        const parsed = this._sqlParser ? this._sqlParser.analyzeRisks(sql) : null;
        if (parsed) {
            // The parser gives no table for a table variable: count, per verb, the
            // statements the text shows aimed at a temporary table or a variable.
            const scratch = { UPDATE: 0, DELETE: 0 };
            for (const statement of cleaned.split(/;|^\s*GO\s*$/im)) {
                const verb = leadingDmlVerb(statement);
                if (verb && !/\bwhere\b/i.test(statement) && isScratchTarget(dmlTarget(statement))) scratch[verb.toUpperCase()]++;
            }
            for (const risk of parsed) {
                if (isScratchTarget(risk.table)) continue;
                if (!risk.table && scratch[risk.type] > 0) { scratch[risk.type]--; continue; }
                risks.push(risk.table
                    ? `${risk.type} without WHERE on ${risk.table}`
                    : `${risk.type} without WHERE`);
            }
        } else {
            // Parser unavailable or SQL unparseable: coarse per-statement heuristic.
            for (const statement of cleaned.split(/;|^\s*GO\s*$/im)) {
                const verb = leadingDmlVerb(statement);
                if (verb && !/\bwhere\b/i.test(statement) && !isScratchTarget(dmlTarget(statement))) {
                    risks.push(`${verb.toUpperCase()} without WHERE`);
                }
            }
        }

        for (const statement of cleaned.split(/;|^\s*GO\s*$/im)) {
            const verb = leadingDmlVerb(statement);
            if (verb && /\bwhere\s+\(*\s*(\d+)\s*=\s*\1\s*\)*\s*$/i.test(statement) && !isScratchTarget(dmlTarget(statement))) {
                risks.push(`${verb.toUpperCase()} with an always-true WHERE`);
            }
        }

        for (const truncate of cleaned.match(/\btruncate\s+table\s+[^\s;]+/gi) || []) {
            const flagged = truncate.replace(/\s+/g, ' ').trim();
            if (!isScratchTarget(flagged.split(' ').pop())) risks.push(flagged);
        }
        const drop = new RegExp(`\\bdrop\\s+(${DROP_KINDS})\\s+(?:if\\s+exists\\s+)?([^\\s;]+)`, 'gi');
        for (const m of cleaned.matchAll(drop)) if (!isScratchTarget(m[2])) risks.push(`DROP ${m[1].toUpperCase()} ${m[2]}`);
        for (const m of cleaned.matchAll(/\balter\s+table\s+([^\s;]+)\s+(drop\s+column|alter\s+column)\b/gi)) {
            risks.push(`ALTER TABLE ${m[1]} ${m[2].replace(/\s+/g, ' ').toUpperCase()}`);
        }
        for (const m of cleaned.matchAll(/\balter\s+database\s+([^\s;]+)\s+set\s+(single_user|offline|emergency)\b/gi)) {
            risks.push(`ALTER DATABASE ${m[1]} SET ${m[2].toUpperCase()}`);
        }
        if (/\bthen\s+delete\b/i.test(cleaned)) risks.push('MERGE deleting rows');
        if (/\bxp_cmdshell\b/i.test(cleaned)) risks.push('xp_cmdshell (runs a command on the server)');

        if (depth < MAX_DYNAMIC_DEPTH) {
            const withLiterals = stripCommentsAndStrings(sql, true);
            for (const m of withLiterals.matchAll(DYNAMIC_LITERAL)) {
                for (const risk of this._analyze(m[1].replace(/''/g, "'"), depth + 1)) risks.push(`In dynamic SQL: ${risk}`);
            }
        }

        return risks;
    }
}

module.exports = QueryRiskAnalyzer;
QueryRiskAnalyzer.stripCommentsAndStrings = stripCommentsAndStrings;
