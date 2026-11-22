'use strict';

const { buildDataScript } = require('./dataScript');

// === The export of a data comparison: the picked tables, as files in a zip ===
//
//   README.txt       which file is which
//   changes.csv      one line per picked table: how many rows added/modified/removed
//   data_script.sql  the MERGE/DELETE script of those tables (as "Script to editor" writes it)
//
// Pure: no connection, no disk - buildDataExportFiles() only builds the file
// list and content; zipFiles() (compareExport.js) turns it into a zip Buffer.

const csvCell = text => (/[",\r\n]/.test(text) ? `"${String(text).replace(/"/g, '""')}"` : String(text));

function buildDataExportFiles(tableResults, { ids, includeDeletes = false, now = new Date(), reference = '', current = '' } = {}) {
    const selected = new Set(Array.isArray(ids) ? ids : []);
    const picked = tableResults.filter(t => selected.has(`${t.schema}.${t.name}`));
    const script = buildDataScript(tableResults, { selected, includeDeletes, now, reference, current });

    const rows = [['table', 'added', 'modified', 'removed']];
    for (const table of picked) rows.push([`${table.schema}.${table.name}`, table.added.length, table.modified.length, table.removed.length]);

    const readme = [
        'SQL Wayfarer: the data differences picked in a comparison',
        '',
        `Reference: ${reference || '(reference)'}   Current: ${current || '(current)'}`,
        'changes.csv      one line per table: how many rows added, modified, removed',
        'data_script.sql  the MERGE/DELETE script of those tables, re-entrant'
    ].join('\r\n');

    return {
        files: [
            { path: 'README.txt', content: `${readme}\r\n` },
            { path: 'changes.csv', content: `﻿${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n` },
            { path: 'data_script.sql', content: script.script }
        ],
        count: picked.length, steps: script.steps, warnings: script.warnings
    };
}

module.exports = { buildDataExportFiles };
