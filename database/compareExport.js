'use strict';

const yazl = require('yazl');
const { buildMigrationScript } = require('./migrationScript');

// === The export of a comparison: the picked changes, as files, in a zip ===
//
//   changes.csv           one line per picked change: kind, name, status, risk, files
//   script.sql            the migration script of those changes (as "Script to editor" writes it)
//   before/<kind>/<name>.sql   the whole code of the object in the reference
//   after/<kind>/<name>.sql    the whole code of the object in the current database
//
// A side that does not exist (before of an added object, after of a removed one)
// has no file. A table has no code: its file is the CREATE TABLE script (with its
// indexes and constraints) of that side. Pure: no connection, no disk.

const RISKS = ['safe', 'caution', 'destructive', 'manual'];
const worstRisk = ops => ops.reduce((worst, op) => (RISKS.indexOf(op.risk) > RISKS.indexOf(worst) ? op.risk : worst), 'safe');

// A name as a file name: the characters Windows refuses become underscores.
const fileName = name => String(name).replace(/[\\/:*?"<>|]/g, '_');

const csvCell = text => (/[",\r\n]/.test(text) ? `"${String(text).replace(/"/g, '""')}"` : String(text));

// The CREATE script of a table as it is on one side: the migration script of "this table was added".
function tableText(table) {
    const change = { kind: 'table', name: `${table.schema}.${table.name}`, status: 'added', current: table, ops: [{ op: 'createTable', risk: 'safe' }] };
    const { script } = buildMigrationScript({ changes: [change] }, { createOrAlter: true });
    // Only the statements: not the header, which speaks of a comparison, nor the labels and the closing SET lines.
    const statements = script.split('\nGO\n').slice(1).filter(part => !/^(--.*\n?|SET \w+ ON;\n?)+$/.test(part));
    return `${statements.join('\nGO\n').trim()}\n`;
}

// The text of one side of a change, or null when there is none.
function sideText(change, side) {
    const object = change[side === 'before' ? 'reference' : 'current'];
    if (change.kind === 'schema') {
        const exists = side === 'before' ? change.status !== 'added' : change.status !== 'removed';
        return exists ? `CREATE SCHEMA [${change.name}];\n` : null;
    }
    if (!object) return null;
    if (change.kind === 'table') return tableText(object);
    if (object.definition === null || object.definition === undefined) return '-- The definition cannot be read (encrypted, or VIEW DEFINITION is missing).\n';
    return /\n$/.test(object.definition) ? object.definition : `${object.definition}\n`;
}

// The files of the zip, as [{ path, content }].
function buildExportFiles(last, { ids, allowDestructive = false, legacy = false, now = new Date() }) {
    const { database, reference, diff, createOrAlter } = last;
    const selected = new Set(Array.isArray(ids) ? ids : []);
    const picked = diff.changes.filter(change => selected.has(`${change.kind}:${change.name}`));
    const files = [];
    const rows = [['kind', 'name', 'status', 'risk', 'before', 'after']];
    for (const change of picked) {
        const paths = {};
        for (const side of ['before', 'after']) {
            const text = sideText(change, side);
            if (text === null) continue;
            paths[side] = `${side}/${change.kind}/${fileName(change.name)}.sql`;
            files.push({ path: paths[side], content: text });
        }
        rows.push([change.kind, change.name, change.status, worstRisk(change.ops), paths.before || '', paths.after || '']);
    }
    const script = buildMigrationScript(diff, {
        selected, allowDestructive: allowDestructive === true, createOrAlter: legacy === true ? false : createOrAlter,
        reference, current: database, now
    });
    files.unshift(
        { path: 'changes.csv', content: `﻿${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n` },
        { path: 'script.sql', content: script.script }
    );
    return { files, count: picked.length, steps: script.steps, skipped: script.skipped };
}

// The zip, as a Buffer.
function zipFiles(files, now = new Date()) {
    return new Promise((resolve, reject) => {
        const zip = new yazl.ZipFile();
        const chunks = [];
        zip.outputStream.on('data', chunk => chunks.push(chunk));
        zip.outputStream.on('error', reject);
        zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
        for (const file of files) zip.addBuffer(Buffer.from(file.content, 'utf8'), file.path, { mtime: now });
        zip.end();
    });
}

module.exports = { buildExportFiles, zipFiles, sideText, fileName };
