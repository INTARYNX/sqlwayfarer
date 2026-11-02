/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

const { format } = require('sql-formatter');

// === Formatting a T-SQL script ===
//
// sql-formatter knows T-SQL but not SSMS's GO separator (not real T-SQL): the
// script is cut on the lone GO lines, each batch is formatted on its own, and
// the GO lines are put back untouched.

const GO_LINE_RE = /^[ \t]*go[ \t]*(\d+)?[ \t]*(--.*)?\r?$/i;

// Returns the formatted text, or null when a batch cannot be parsed (the
// caller leaves the text as it is).
function formatSqlScript(text, options = {}) {
    const lines = String(text).split('\n');
    const out = [];
    let batch = [];
    const flush = () => {
        const source = batch.join('\n');
        batch = [];
        if (source.trim() === '') { out.push(source); return true; }
        try {
            out.push(format(source, {
                language: 'tsql',
                tabWidth: options.tabWidth || 4,
                keywordCase: options.keywordCase || 'upper',
                linesBetweenQueries: 1
            }));
            return true;
        } catch {
            return false;
        }
    };
    for (const line of lines) {
        if (GO_LINE_RE.test(line)) {
            if (!flush()) return null;
            out.push(line.replace(/\r$/, ''));
        } else {
            batch.push(line);
        }
    }
    if (!flush()) return null;
    return out.join('\n');
}

module.exports = { formatSqlScript };
