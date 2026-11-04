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
//
// A statement can also be wrapped in BEGIN...END, in a TRY...CATCH or in an
// ELSE branch: the verb is not always at the very beginning either.
//
// Returns the verb and the text that follows it, or null.
function leadingDml(statement) {
    let text = statement.replace(/^\s+/, '');
    // The keywords that open a block or a branch come before the verb.
    let match;
    while ((match = text.match(/^(?:begin|end|else|then|try|catch|do)\b\s*/i))) {
        text = text.slice(match[0].length);
    }
    const direct = text.match(/^(update|delete)\b/i);
    if (direct) return { verb: direct[1].toLowerCase(), body: text.slice(direct[0].length) };
    if (!/^(?:with|if|while)\b/i.test(text)) return null;

    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if (depth === 0) {
            const m = text.slice(i).match(/^(update|delete)\b/i);
            if (m) return { verb: m[1].toLowerCase(), body: text.slice(i + m[0].length) };
        }
    }
    return null;
}

// The target of an UPDATE / DELETE, to tell a temporary table or a table
// variable (nothing to lose) from a real table. The text is what follows the
// verb.
function dmlTarget(body) {
    const m = body.match(/^\s*(?:top\s*(?:\(\s*\d+\s*\)|\d+)\s*(?:percent\s+)?)?(?:from\s+)?([^\s(;]+)/i);
    return m ? m[1] : null;
}

const isScratchTarget = name => !!name && /^[#@]/.test(name.replace(/^\[/, ''));

// Whether the word at `index` is a statement verb and not a name (a column
// called [Update], t.Delete, @insert) or a permission (GRANT UPDATE) or a
// clause (ON DELETE CASCADE, AFTER INSERT).
function isStatementVerb(text, index) {
    const before = text.slice(Math.max(0, index - 20), index);
    if (/[.@\[]\s*$/.test(before)) return false;
    return !/\b(?:grant|deny|revoke|on|after|for|of|instead)\s+$|,\s*$/i.test(before);
}

// The verbs of the statements that change data or schema, in the order of
// appearance and without repeats; a statement aimed at a temporary table or a
// table variable does not count.
//
// The verb is looked for wherever it stands: a write wrapped in an IF, in an
// ELSE, in a BEGIN...END or behind a WITH-CTE is still a write.
const WRITE_TARGETS = {
    insert: /^\s*(?:into\s+)?([^\s(;]+)/i,
    update: /^\s*(?:top\s*(?:\(\s*\d+\s*\)|\d+)\s*(?:percent\s+)?)?(?:from\s+)?([^\s(;]+)/i,
    delete: /^\s*(?:top\s*(?:\(\s*\d+\s*\)|\d+)\s*(?:percent\s+)?)?(?:from\s+)?([^\s(;]+)/i,
    merge: /^\s*(?:into\s+)?([^\s(;]+)/i,
    truncate: /^\s*table\s+([^\s(;]+)/i,
    create: /^\s*(?:table|view|procedure|proc|function|schema|database|type|sequence|synonym)\s+(?:if\s+exists\s+)?([^\s(;]+)/i,
    alter: /^\s*(?:table|view|procedure|proc|function|schema|database|type|sequence|synonym)\s+([^\s(;]+)/i,
    drop: /^\s*(?:table|view|procedure|proc|function|schema|database|type|sequence|synonym)\s+(?:if\s+exists\s+)?([^\s(;]+)/i
};

// An index is built on a table: it is that table that is touched.
const INDEX_TARGET = /^\s*(?:unique\s+|clustered\s+|nonclustered\s+)?index\s+([^\s(;]+)(?:\s+on\s+([^\s(;]+))?/i;

// A procedure called with EXEC may write anything - the text does not say.
const EXEC_PROCEDURE = /\bexec(?:ute)?\s+((?:\[?[\w$#]+\]?\s*\.\s*)?\[?[\w$#]+\]?)/gi;

// A dynamic statement is only checked when it is written as a literal
// (EXEC('...') / sp_executesql N'...'); one built in a variable is not visible.
const DYNAMIC_LITERAL = /\b(?:exec(?:ute)?\s*\(\s*|sp_executesql\s+)N?'((?:[^']|'')*)'/gi;
const MAX_DYNAMIC_DEPTH = 2;

function productionWrites(sql, depth = 0) {
    const verbs = [];
    const add = verb => { if (!verbs.includes(verb)) verbs.push(verb); };
    const cleaned = stripCommentsAndStrings(sql);
    // Where the statement being handled ends: the clauses that follow are
    // part of it.
    let skipUntil = -1;

    for (const m of cleaned.matchAll(/\b(insert|update|delete|merge|create|alter|drop|truncate)\b/gi)) {
        // Inside a statement already handled (the clauses of a MERGE).
        if (m.index < skipUntil) continue;
        if (!isStatementVerb(cleaned, m.index)) continue;
        const verb = m[1].toLowerCase();
        const rest = cleaned.slice(m.index + m[0].length);
        let target = null;
        if (verb === 'create' || verb === 'alter' || verb === 'drop') {
            const index = INDEX_TARGET.exec(rest);
            if (index) target = index[2] || null;
        }
        if (target === null) {
            const pattern = WRITE_TARGETS[verb];
            target = pattern ? (pattern.exec(rest) || [])[1] || null : null;
        }
        if (verb === 'merge') {
            // The clauses of a MERGE ("WHEN MATCHED THEN UPDATE...") write
            // into the table the MERGE targets, not into a table of their
            // own: the MERGE itself is the write.
            const end = cleaned.indexOf(';', m.index);
            skipUntil = end === -1 ? cleaned.length : end;
            if (target && isScratchTarget(target)) continue;
            add('MERGE');
            continue;
        }
        // A temporary table or a table variable: nothing to lose.
        if (target && isScratchTarget(target)) continue;
        add(verb.toUpperCase());
    }

    // SELECT ... INTO creates a table: it is a write. One pass over the text
    // (a pattern per SELECT would walk the rest of the script each time, and
    // a script of thousands of them takes seconds).
    let selecting = false;
    for (const m of cleaned.matchAll(/\b(select|insert|update|delete|merge)\b|\binto\s+([^\s(;]+)|;/gi)) {
        if (m[2] !== undefined) {
            if (selecting && !isScratchTarget(m[2])) add('INSERT');
            selecting = false;
        } else {
            selecting = !!m[1] && m[1].toLowerCase() === 'select';
        }
    }

    // A procedure called with EXEC may write anything. A system procedure
    // (sp_..., xp_...) without a schema is left out: it only reads.
    for (const m of cleaned.matchAll(EXEC_PROCEDURE)) {
        const name = m[1].replace(/[\[\]\s]/g, '');
        if (!name.includes('.') && /^(?:sp|xp)_/i.test(name)) continue;
        add('EXEC (a procedure may write)');
        break;
    }

    // The same writes inside a dynamic statement written as a literal.
    if (depth < MAX_DYNAMIC_DEPTH) {
        const withLiterals = stripCommentsAndStrings(sql, true);
        for (const m of withLiterals.matchAll(DYNAMIC_LITERAL)) {
            for (const verb of productionWrites(m[1].replace(/''/g, "'"), depth + 1)) add(verb);
        }
    }

    return verbs;
}

// Object kinds a DROP is flagged for.
const DROP_KINDS = 'table|view|procedure|proc|function|trigger|index|database|schema|synonym|user|login|role|type|sequence|assembly';

// "WHERE 1=1" is always true. "WHERE 1=1 AND x = 5" is not: only what comes
// after the comparison decides - nothing (the clause IS the comparison), or an
// OR, which makes the whole clause true whatever follows it.
//
// The statement may end without a ";": what follows is then the next one.
const NEXT_STATEMENT = 'select|insert|update|delete|merge|declare|set|if|else|while|exec|execute|print|begin|end|with|truncate|drop|create|alter|return|use|option';
const ALWAYS_TRUE_WHERE = new RegExp(`\\bwhere\\s+\\(*\\s*(\\d+)\\s*=\\s*\\1\\s*\\)*\\s*(?:$|\\bor\\b|(?=\\b(?:${NEXT_STATEMENT})\\b))`, 'i');

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
            const writes = productionWrites(sql || '');
            if (writes.length > 0) risks.push(`Changes data or schema (${writes.join(', ')}) on a production connection`);
        }
        return risks;
    }

    _analyze(sql, depth) {
        if (!sql) return [];
        const risks = [];
        const cleaned = stripCommentsAndStrings(sql);

        // The parser only has a say on UPDATE and DELETE, and it takes from a tenth of a
        // second to several (it runs in the host, before the query): no need for a SELECT.
        const mayWrite = /\b(?:update|delete)\b/i.test(cleaned);
        const parsed = this._sqlParser && mayWrite ? this._sqlParser.analyzeRisks(sql) : null;
        if (parsed) {
            // The parser gives no table for a table variable: count, per verb, the
            // statements the text shows aimed at a temporary table or a variable.
            const scratch = { UPDATE: 0, DELETE: 0 };
            for (const statement of cleaned.split(/;|^\s*GO\s*$/im)) {
                const dml = leadingDml(statement);
                if (dml && !/\bwhere\b/i.test(dml.body) && isScratchTarget(dmlTarget(dml.body))) scratch[dml.verb.toUpperCase()]++;
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
                const dml = leadingDml(statement);
                if (dml && !/\bwhere\b/i.test(dml.body) && !isScratchTarget(dmlTarget(dml.body))) {
                    risks.push(`${dml.verb.toUpperCase()} without WHERE`);
                }
            }
        }

        for (const statement of cleaned.split(/;|^\s*GO\s*$/im)) {
            const dml = leadingDml(statement);
            if (dml && ALWAYS_TRUE_WHERE.test(dml.body) && !isScratchTarget(dmlTarget(dml.body))) {
                risks.push(`${dml.verb.toUpperCase()} with an always-true WHERE`);
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
