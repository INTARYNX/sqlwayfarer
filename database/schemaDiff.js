'use strict';

const { normalizeDefinition } = require('./sqlHeader');

// === The difference between two schema models ===
//
// diffModels(reference, current) says what changed to go from the reference
// (the snapshot, the baseline) to the current state, the way git says it of a
// working tree: an object that is only in the current model is "added", one
// that is only in the reference is "removed". Pure: no connection, no clock.
//
// Every change is a list of small operations, each with a risk:
//   safe         cannot lose data nor fail on the data that is there
//   caution      can fail on existing data (NOT NULL, a key, a foreign key),
//                or lose something that is not data (an index, the code of a view)
//   destructive  loses data (a column, a table, a narrower type)
//   manual       cannot be done in place (the identity of a column)

const RISK = { SAFE: 'safe', CAUTION: 'caution', DESTRUCTIVE: 'destructive', MANUAL: 'manual' };
const SEVERITY = [RISK.SAFE, RISK.CAUTION, RISK.DESTRUCTIVE, RISK.MANUAL];

const worst = (...risks) => risks.reduce((a, b) => (SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a), RISK.SAFE);
const lower = text => String(text).toLowerCase();

// An expression (a default, a check, a computed column, an index filter) as
// it is compared: no blanks and no case, except inside string literals.
function normalizeExpression(text) {
    if (text === null || text === undefined) return null;
    let out = '';
    let inLiteral = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inLiteral) {
            out += ch;
            if (ch === "'") {
                if (text[i + 1] === "'") { out += "'"; i++; } else inLiteral = false;
            }
        } else if (ch === "'") {
            inLiteral = true;
            out += ch;
        } else if (!/\s/.test(ch)) {
            out += ch.toLowerCase();
        }
    }
    return out;
}

// === Types ===

const INTEGERS = ['tinyint', 'smallint', 'int', 'bigint'];
const SIZED = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'binary', 'varbinary']);
const SCALED = new Set(['datetime2', 'datetimeoffset', 'time']);

function parseType(type) {
    const match = /^([^(]+?)(?:\((.*)\))?$/.exec(type);
    const args = match && match[2] !== undefined ? match[2].split(',').map(a => a.trim()) : [];
    return { name: match ? match[1].toLowerCase() : type.toLowerCase(), args };
}

const toNumber = arg => (arg === 'max' ? Infinity : Number(arg));

// How risky it is to change a column from one type to another.
function typeChangeRisk(from, to) {
    const a = parseType(from);
    const b = parseType(to);
    if (a.name === b.name) {
        if (SIZED.has(a.name)) return toNumber(b.args[0]) >= toNumber(a.args[0]) ? RISK.SAFE : RISK.DESTRUCTIVE;
        if (a.name === 'decimal' || a.name === 'numeric') {
            const [pa, sa] = a.args.map(Number);
            const [pb, sb] = b.args.map(Number);
            return pb >= pa && sb >= sa && (pb - sb) >= (pa - sa) ? RISK.SAFE : RISK.DESTRUCTIVE;
        }
        if (SCALED.has(a.name)) return Number(b.args[0]) >= Number(a.args[0]) ? RISK.SAFE : RISK.DESTRUCTIVE;
        if (a.name === 'float') return Number(b.args[0] || 53) >= Number(a.args[0] || 53) ? RISK.SAFE : RISK.DESTRUCTIVE;
        return RISK.CAUTION;
    }
    const ia = INTEGERS.indexOf(a.name);
    const ib = INTEGERS.indexOf(b.name);
    if (ia !== -1 && ib !== -1) return ib > ia ? RISK.SAFE : RISK.DESTRUCTIVE;
    return RISK.CAUTION;
}

// === Matching ===

// Pairs the items of the two sides that are the same thing. The items that
// are only on one side come out as added / removed, the pairs as both.
function pair(referenceItems, currentItems, keyOf) {
    const currentByKey = new Map(currentItems.map(item => [keyOf(item), item]));
    const referenceKeys = new Set();
    const removed = [];
    const both = [];
    for (const item of referenceItems) {
        const key = keyOf(item);
        referenceKeys.add(key);
        if (currentByKey.has(key)) both.push([item, currentByKey.get(key)]);
        else removed.push(item);
    }
    const added = currentItems.filter(item => !referenceKeys.has(keyOf(item)));
    return { added, removed, both };
}

const columnList = columns => columns.map(c => `${lower(c.name)}${c.desc ? ' desc' : ''}`).join(',');

// A constraint or index the server named itself has a name that means nothing
// (PK__T__3213E83F, DF__T__c__1A2B): it is told by what it does.
function keyedByNameOrDefinition(item, signature) {
    return item.systemNamed ? `definition:${signature(item)}` : `name:${lower(item.name)}`;
}

// === Tables ===

function diffColumn(reference, current) {
    const ops = [];
    const changes = [];
    let risk = RISK.SAFE;

    if (reference.type !== current.type) {
        changes.push('type');
        risk = worst(risk, typeChangeRisk(reference.type, current.type));
    }
    if (reference.nullable !== current.nullable) {
        changes.push('nullable');
        risk = worst(risk, current.nullable ? RISK.SAFE : RISK.CAUTION);
    }
    if ((reference.collation || null) !== (current.collation || null)) {
        changes.push('collation');
        risk = worst(risk, RISK.CAUTION);
    }
    if (JSON.stringify(reference.identity) !== JSON.stringify(current.identity)) {
        changes.push('identity');
        risk = worst(risk, RISK.MANUAL);
    }
    const refComputed = reference.computed ? `${normalizeExpression(reference.computed.definition)}|${reference.computed.persisted}` : null;
    const curComputed = current.computed ? `${normalizeExpression(current.computed.definition)}|${current.computed.persisted}` : null;
    if (refComputed !== curComputed) {
        changes.push('computed');
        // A column that becomes computed loses what it held; the other ways are a rebuild of the column.
        risk = worst(risk, !reference.computed && current.computed ? RISK.DESTRUCTIVE : RISK.CAUTION);
    }
    if (changes.length > 0) ops.push({ op: 'alterColumn', name: current.name, from: reference, to: current, changes, risk });

    const refDefault = reference.default;
    const curDefault = current.default;
    if (!refDefault && curDefault) ops.push({ op: 'addDefault', column: current.name, default: curDefault, risk: RISK.SAFE });
    else if (refDefault && !curDefault) ops.push({ op: 'dropDefault', column: reference.name, default: refDefault, risk: RISK.SAFE });
    else if (refDefault && curDefault) {
        const sameName = (refDefault.systemNamed && curDefault.systemNamed) || lower(refDefault.name) === lower(curDefault.name);
        if (!sameName || normalizeExpression(refDefault.definition) !== normalizeExpression(curDefault.definition)) {
            ops.push({ op: 'alterDefault', column: current.name, from: refDefault, to: curDefault, risk: RISK.SAFE });
        }
    }
    return ops;
}

const sameKey = (a, b) => a.clustered === b.clustered && columnList(a.columns) === columnList(b.columns);
const keySignature = key => `${key.clustered ? 'c' : 'n'}:${columnList(key.columns)}`;

function diffTable(reference, current) {
    const ops = [];

    const columns = pair(reference.columns, current.columns, c => lower(c.name));
    for (const column of columns.removed) ops.push({ op: 'dropColumn', column, risk: RISK.DESTRUCTIVE });
    for (const column of columns.added) {
        const fillsItself = column.nullable || column.identity || column.computed || column.default;
        ops.push({ op: 'addColumn', column, risk: fillsItself ? RISK.SAFE : RISK.CAUTION, needsDefault: !fillsItself });
    }
    for (const [before, after] of columns.both) ops.push(...diffColumn(before, after));

    const refPk = reference.primaryKey;
    const curPk = current.primaryKey;
    if (!refPk && curPk) ops.push({ op: 'addPrimaryKey', primaryKey: curPk, risk: RISK.CAUTION });
    else if (refPk && !curPk) ops.push({ op: 'dropPrimaryKey', primaryKey: refPk, risk: RISK.CAUTION });
    else if (refPk && curPk) {
        const sameName = (refPk.systemNamed && curPk.systemNamed) || lower(refPk.name) === lower(curPk.name);
        if (!sameName || !sameKey(refPk, curPk)) ops.push({ op: 'alterPrimaryKey', from: refPk, to: curPk, risk: RISK.CAUTION });
    }

    const uniques = pair(reference.uniques, current.uniques, u => keyedByNameOrDefinition(u, keySignature));
    for (const unique of uniques.removed) ops.push({ op: 'dropUnique', unique, risk: RISK.SAFE });
    for (const unique of uniques.added) ops.push({ op: 'addUnique', unique, risk: RISK.CAUTION });
    for (const [before, after] of uniques.both) {
        if (!sameKey(before, after)) ops.push({ op: 'alterUnique', from: before, to: after, risk: RISK.CAUTION });
    }

    const indexSignature = ix => [ix.unique, ix.clustered, columnList(ix.columns), [...ix.included].map(lower).sort().join(','), normalizeExpression(ix.filter), ix.disabled].join('|');
    const indexes = pair(reference.indexes, current.indexes, ix => lower(ix.name));
    for (const index of indexes.removed) ops.push({ op: 'dropIndex', index, risk: RISK.SAFE });
    for (const index of indexes.added) ops.push({ op: 'addIndex', index, risk: index.unique ? RISK.CAUTION : RISK.SAFE });
    for (const [before, after] of indexes.both) {
        if (indexSignature(before) !== indexSignature(after)) ops.push({ op: 'alterIndex', from: before, to: after, risk: after.unique ? RISK.CAUTION : RISK.SAFE });
    }

    const foreignKeySignature = fk => [fk.columns.map(lower).join(','), lower(`${fk.refSchema}.${fk.refTable}`), fk.refColumns.map(lower).join(','), fk.onDelete, fk.onUpdate].join('|');
    const foreignKeys = pair(reference.foreignKeys, current.foreignKeys, fk => keyedByNameOrDefinition(fk, foreignKeySignature));
    for (const foreignKey of foreignKeys.removed) ops.push({ op: 'dropForeignKey', foreignKey, risk: RISK.SAFE });
    for (const foreignKey of foreignKeys.added) ops.push({ op: 'addForeignKey', foreignKey, risk: RISK.CAUTION });
    for (const [before, after] of foreignKeys.both) {
        if (foreignKeySignature(before) !== foreignKeySignature(after) || before.disabled !== after.disabled) {
            ops.push({ op: 'alterForeignKey', from: before, to: after, risk: RISK.CAUTION });
        }
    }

    const checkSignature = ck => normalizeExpression(ck.definition);
    const checks = pair(reference.checks, current.checks, ck => keyedByNameOrDefinition(ck, checkSignature));
    for (const check of checks.removed) ops.push({ op: 'dropCheck', check, risk: RISK.SAFE });
    for (const check of checks.added) ops.push({ op: 'addCheck', check, risk: RISK.CAUTION });
    for (const [before, after] of checks.both) {
        if (checkSignature(before) !== checkSignature(after) || before.disabled !== after.disabled) {
            ops.push({ op: 'alterCheck', from: before, to: after, risk: RISK.CAUTION });
        }
    }
    return ops;
}

// === Code objects ===

// What differs in a module that exists on both sides; undefined when the
// definition cannot be read on one side (encrypted, or not enough rights).
function diffModule(reference, current, skipped, name) {
    const what = [];
    let recreate = false;
    if (reference.definition === null || current.definition === null) {
        skipped.push({ name, kind: current.type, reason: 'The definition cannot be read (encrypted, or VIEW DEFINITION is missing).' });
    } else if (normalizeDefinition(reference.definition) !== normalizeDefinition(current.definition)) {
        what.push('definition');
    }
    if (reference.ansiNulls !== current.ansiNulls || reference.quotedIdentifier !== current.quotedIdentifier) what.push('options');
    if (current.type === 'trigger') {
        if (reference.disabled !== current.disabled) what.push('disabled');
        if (lower(reference.parent || '') !== lower(current.parent || '')) { what.push('parent'); recreate = true; }
    }
    return what.length === 0 ? [] : [{ op: recreate ? 'recreate' : 'alter', what, risk: recreate ? RISK.CAUTION : RISK.SAFE }];
}

// === The whole comparison ===

const KIND_ORDER = ['schema', 'table', 'view', 'function', 'procedure', 'trigger'];

function diffModels(reference, current) {
    const changes = [];
    const skipped = [];

    const schemas = pair(reference.schemas.map(name => ({ name })), current.schemas.map(name => ({ name })), s => lower(s.name));
    for (const schema of schemas.removed) changes.push({ kind: 'schema', name: schema.name, status: 'removed', ops: [{ op: 'dropSchema', risk: RISK.CAUTION }] });
    for (const schema of schemas.added) changes.push({ kind: 'schema', name: schema.name, status: 'added', ops: [{ op: 'createSchema', risk: RISK.SAFE }] });

    const tables = pair(Object.values(reference.tables), Object.values(current.tables), t => lower(`${t.schema}.${t.name}`));
    for (const table of tables.removed) changes.push({ kind: 'table', name: `${table.schema}.${table.name}`, status: 'removed', reference: table, ops: [{ op: 'dropTable', risk: RISK.DESTRUCTIVE }] });
    for (const table of tables.added) changes.push({ kind: 'table', name: `${table.schema}.${table.name}`, status: 'added', current: table, ops: [{ op: 'createTable', risk: RISK.SAFE }] });
    for (const [before, after] of tables.both) {
        const ops = diffTable(before, after);
        if (ops.length > 0) changes.push({ kind: 'table', name: `${after.schema}.${after.name}`, status: 'modified', reference: before, current: after, ops });
    }

    // A module of another kind under the same name is one removed and one added.
    const moduleKey = m => `${lower(`${m.schema}.${m.name}`)}|${m.type}`;
    const modules = pair(Object.values(reference.modules), Object.values(current.modules), moduleKey);
    for (const module of modules.removed) changes.push({ kind: module.type, name: `${module.schema}.${module.name}`, status: 'removed', reference: module, ops: [{ op: 'dropModule', risk: RISK.CAUTION }] });
    for (const module of modules.added) changes.push({ kind: module.type, name: `${module.schema}.${module.name}`, status: 'added', current: module, ops: [{ op: 'createModule', risk: RISK.SAFE }] });
    for (const [before, after] of modules.both) {
        const name = `${after.schema}.${after.name}`;
        const ops = diffModule(before, after, skipped, name);
        if (ops.length > 0) changes.push({ kind: after.type, name, status: 'modified', reference: before, current: after, ops });
    }

    changes.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name));

    const summary = { added: 0, removed: 0, modified: 0, risks: { safe: 0, caution: 0, destructive: 0, manual: 0 } };
    for (const change of changes) {
        summary[change.status]++;
        for (const op of change.ops) summary.risks[op.risk]++;
    }
    return {
        identical: changes.length === 0,
        changes,
        summary,
        skipped,
        notCompared: { reference: reference.notCompared || {}, current: current.notCompared || {} }
    };
}

module.exports = { diffModels, normalizeExpression, typeChangeRisk, parseType, RISK };
