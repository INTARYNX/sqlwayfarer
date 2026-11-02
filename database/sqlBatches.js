/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// === GO batches ===
//
// SSMS/sqlcmd's "GO" batch separator - not real T-SQL, so it must never
// reach the server as part of a batch's text. A line counts as a separator
// only when it contains nothing but "GO" (optionally a repeat count, "GO 3",
// and/or a trailing line comment), outside comments, string literals and
// bracketed identifiers - same tokenizing rigor as splitTopLevelStatements.
const GO_LINE_RE = /^[ \t]*go[ \t]*(\d+)?[ \t]*(--.*)?\r?$/i;

// Splits a script into separate batches on standalone GO lines. Unlike a
// semicolon (which only separates statements WITHIN one batch/request), each
// GO-delimited batch is sent to the server as its own, separate round trip -
// variables and SET options from one batch don't carry over to the next,
// exactly as in SSMS. Returns [{ sql, repeat, startLine }]: repeat is the
// count after "GO N" (defaulting to 1, meaning run this batch that many times
// in a row), and startLine is the batch's 1-indexed line number in the
// ORIGINAL script - needed to translate a server-reported error line (always
// relative to just that one batch's own text) back into the line the user
// actually sees in the editor, the same correction SSMS itself makes.
function splitBatches(sql) {
    const batches = [];
    let current = '';
    let currentStartLine = 1;
    let lineBuffer = '';
    let lineNo = 1;
    let i = 0;
    const n = sql.length;

    const countNewlines = (text) => (text.match(/\n/g) || []).length;

    const flushLine = (newlineChar) => {
        const match = GO_LINE_RE.exec(lineBuffer);
        if (match) {
            const repeat = match[1] ? Math.max(1, parseInt(match[1], 10)) : 1;
            if (current.trim()) batches.push({ sql: current, repeat, startLine: currentStartLine });
            current = '';
            currentStartLine = lineNo + 1;
        } else {
            current += lineBuffer + (newlineChar || '');
        }
        lineBuffer = '';
    };

    while (i < n) {
        const ch = sql[i];

        if (ch === '-' && sql[i + 1] === '-') {
            const end = sql.indexOf('\n', i);
            const stop = end === -1 ? n : end;
            lineBuffer += sql.slice(i, stop);
            i = stop;
            continue;
        }
        if (ch === '/' && sql[i + 1] === '*') {
            const end = sql.indexOf('*/', i + 2);
            const stop = end === -1 ? n : end + 2;
            lineNo += countNewlines(sql.slice(i, stop));
            lineBuffer += sql.slice(i, stop);
            i = stop;
            continue;
        }
        if (ch === "'") {
            let j = i + 1;
            while (j < n) {
                if (sql[j] === "'") {
                    if (sql[j + 1] === "'") { j += 2; continue; }
                    j += 1;
                    break;
                }
                j++;
            }
            lineNo += countNewlines(sql.slice(i, j));
            lineBuffer += sql.slice(i, j);
            i = j;
            continue;
        }
        if (ch === '[') {
            const end = sql.indexOf(']', i + 1);
            const stop = end === -1 ? n : end + 1;
            lineNo += countNewlines(sql.slice(i, stop));
            lineBuffer += sql.slice(i, stop);
            i = stop;
            continue;
        }
        if (ch === '\n') {
            flushLine('\n');
            lineNo++;
            i++;
            continue;
        }
        lineBuffer += ch;
        i++;
    }
    flushLine('');
    if (current.trim()) batches.push({ sql: current, repeat: 1, startLine: currentStartLine });

    return batches;
}

module.exports = { splitBatches, GO_LINE_RE };
