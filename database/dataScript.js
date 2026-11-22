'use strict';

const { bracketIdentifier } = require('./sqlIdentifier');
const { sqlLiteral } = require('./sqlLiteral');
const { keyPredicate } = require('./dataDiff');

// === The re-entrant script of a data comparison ===
//
// buildDataScript() takes the tables planDataTables() picked, each filled in
// with the rows compareTableData() found added/removed/modified, and writes
// the T-SQL that brings the reference's data to the current state - the data
// equivalent of buildMigrationScript() in migrationScript.js:
//   - added and modified rows of a table share one MERGE (insert what is
//     missing, update what differs): a chunk of rows that is run again finds
//     everything already matching and writes nothing, so it is re-entrant by
//     construction, not by testing a version;
//   - a removed row is its own DELETE by key, which finds nothing the second
//     time it runs;
//   - tables are written in the order they are given (planDataTables() puts
//     the one a foreign key points to first) for the inserts/updates, and in
//     the reverse order for the deletes, so neither trips a constraint;
//   - one statement per batch, like the schema script.
//
// tableResults: [{ schema, name, key, columns, columnTypes, identityColumn,
// added, removed, modified }], already in that foreign-key order.

const q = bracketIdentifier;
const tableName = t => `${q(t.schema)}.${q(t.name)}`;
const id = t => `${t.schema}.${t.name}`;

const MERGE_CHUNK = 200;
const DELETE_CHUNK = 500;

function* chunksOf(list, size) {
    for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size);
}

// One MERGE that inserts the rows new to the current state and updates the
// ones that changed - a chunk of at most MERGE_CHUNK rows, both kinds mixed.
function mergeStatement(table, rows) {
    const nonKey = table.columns.filter(c => !table.key.includes(c));
    const columnList = table.columns.map(q).join(', ');
    const values = rows.map(row => `(${table.columns.map(c => sqlLiteral(row[c], table.columnTypes[c])).join(', ')})`).join(', ');
    return [
        `MERGE INTO ${tableName(table)} AS tgt`,
        `USING (VALUES ${values}) AS src (${columnList})`,
        `ON ${table.key.map(c => `tgt.${q(c)} = src.${q(c)}`).join(' AND ')}`,
        `WHEN MATCHED THEN UPDATE SET ${nonKey.map(c => `tgt.${q(c)} = src.${q(c)}`).join(', ')}`,
        `WHEN NOT MATCHED BY TARGET THEN INSERT (${columnList}) VALUES (${table.columns.map(c => `src.${q(c)}`).join(', ')});`
    ].join('\n');
}

// One DELETE of exactly the given rows' keys - at most DELETE_CHUNK of them.
function deleteStatement(table, rows) {
    const keys = rows.map(row => table.key.map(c => row[c]));
    return `DELETE FROM ${tableName(table)} WHERE ${keyPredicate(table, keys)};`;
}

function upsertBlocks(table) {
    const rows = [...table.added, ...table.modified.map(m => m.after)];
    if (rows.length === 0) return { blocks: [], steps: 0 };
    const blocks = [`-- ${id(table)}: ${table.added.length} to insert, ${table.modified.length} to update`];
    let steps = 0;
    for (const chunk of chunksOf(rows, MERGE_CHUNK)) {
        if (table.identityColumn) blocks.push(`SET IDENTITY_INSERT ${tableName(table)} ON;`);
        blocks.push(mergeStatement(table, chunk));
        if (table.identityColumn) blocks.push(`SET IDENTITY_INSERT ${tableName(table)} OFF;`);
        steps++;
    }
    return { blocks, steps };
}

function deleteBlocks(table) {
    if (table.removed.length === 0) return { blocks: [], steps: 0 };
    const blocks = [`-- ${id(table)}: ${table.removed.length} to delete`];
    let steps = 0;
    for (const chunk of chunksOf(table.removed, DELETE_CHUNK)) {
        blocks.push(deleteStatement(table, chunk));
        steps++;
    }
    return { blocks, steps };
}

function buildDataScript(tableResults, options = {}) {
    const { selected = null, includeDeletes = false, now = new Date(), reference = '', current = '' } = options;
    const picked = tableResults.filter(t => !selected || selected.has(id(t)));
    const warnings = [];

    const blocks = [];
    let steps = 0;
    for (const table of picked) {
        const upsert = upsertBlocks(table);
        blocks.push(...upsert.blocks);
        steps += upsert.steps;
    }

    if (includeDeletes) {
        for (const table of [...picked].reverse()) {
            const del = deleteBlocks(table);
            blocks.push(...del.blocks);
            steps += del.steps;
        }
    } else {
        const left = picked.filter(t => t.removed.length > 0);
        if (left.length > 0) {
            warnings.push(`${left.reduce((n, t) => n + t.removed.length, 0)} removed row(s) left out of the script (include deletions to write them): ${left.map(id).join(', ')}.`);
        }
    }

    const header = [
        '-- SQL Wayfarer: the data differences between two states of a database',
        `-- From: ${reference || '(reference)'}   To: ${current || '(current)'}   Generated: ${now.toISOString()}`,
        '-- Re-entrant: a MERGE only touches the rows it lists, a DELETE only the keys it names,',
        '-- so the script can be run again without duplicating a row or failing on what is already done.',
        `-- ${steps} step(s).`
    ];
    const parts = [header.join('\n'), ...warnings.map(w => `-- ${w}`)];
    if (steps > 0) parts.push(...blocks);
    return { script: `${parts.join('\nGO\n')}\n`, steps, skipped: [], warnings };
}

module.exports = { buildDataScript };
