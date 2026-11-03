/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// === The columns of a result set ===
//
// A result set read by position can have a column with no name
// (SELECT COUNT(*)) or two columns of the same name (a.id, b.id). The grid
// reads its rows by column key, so each column gets a key of its own: the name
// as the server gives it, "(No column name)" for none (as SSMS says it), and a
// " (2)", " (3)"... suffix on a name already taken.

const NO_NAME = '(No column name)';

function uniqueColumnKeys(columns) {
    const taken = new Set();
    return columns.map(column => {
        const base = column.name === '' || column.name === undefined || column.name === null ? NO_NAME : String(column.name);
        let key = base;
        for (let n = 2; taken.has(key); n++) key = `${base} (${n})`;
        taken.add(key);
        return key;
    });
}

module.exports = { uniqueColumnKeys, NO_NAME };
