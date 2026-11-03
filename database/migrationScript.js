'use strict';

const { bracketIdentifier, escapeLiteral } = require('./sqlIdentifier');
const { parseHeader } = require('./sqlHeader');
const { parseType } = require('./schemaDiff');

// === The re-entrant script of a comparison ===
//
// buildMigrationScript(diff) writes the T-SQL that brings a database that is
// in the state of the reference to the current one. "Re-entrant" is what the
// script is made for, since it is run on databases whose state nobody is sure
// of (production, a copy that was half updated):
//   - every step tests the state it is about to change, never a version number,
//     so a second run changes nothing and a run on a database that is already
//     ahead does no harm;
//   - one statement per batch, and a batch that fails stops the script (SET
//     NOEXEC), so it is fixed and run again, from the top;
//   - the steps are ordered: what blocks first (foreign keys, indexes), then
//     tables and columns, keys and indexes, checks, foreign keys, then the code.
// What loses data is left out unless it was asked for, and said.

const N = text => `N'${escapeLiteral(text)}'`;
const q = bracketIdentifier;
const tableName = (schema, name) => `${q(schema)}.${q(name)}`;
const objectId = (schema, name) => `OBJECT_ID(${N(tableName(schema, name))})`;
const columnList = columns => columns.map(c => `${q(c.name)}${c.desc ? ' DESC' : ''}`).join(', ');
const plainList = names => names.map(q).join(', ');

const PHASE = {
    SCHEMA: 0,
    DROP_FOREIGN_KEY: 10, DROP_CHECK: 11, DROP_KEY: 12, DROP_INDEX: 13, DROP_DEFAULT: 14,
    TABLE: 20,
    KEY: 30,
    INDEX: 40,
    CHECK: 50,
    FOREIGN_KEY: 60,
    MODULE: 70,
    TRIGGER: 80,
    DROP_MODULE: 90, DROP_TABLE: 95, DROP_SCHEMA: 99
};

// The first SQL Server that has CREATE OR ALTER: 2016 SP1 (13.0.4001).
function supportsCreateOrAlter(version) {
    const [major, , build] = String(version || '').split('.').map(n => parseInt(n, 10));
    return major > 13 || (major === 13 && (build || 0) >= 4001);
}

// === Columns ===

function typeMatches(type, t = 't', c = 'c') {
    const udt = /^\[(.*)\]\.\[(.*)\]$/.exec(type);
    if (udt) {
        const unescape = s => s.replace(/]]/g, ']');
        return `${t}.name = ${N(unescape(udt[2]))} AND ${t}.is_user_defined = 1 AND SCHEMA_NAME(${t}.schema_id) = ${N(unescape(udt[1]))}`;
    }
    const { name, args } = parseType(type);
    const base = `${t}.name = ${N(name)}`;
    const length = (arg, bytesPerChar) => (arg === 'max' ? -1 : Number(arg) * bytesPerChar);
    switch (name) {
        case 'char': case 'varchar': case 'binary': case 'varbinary': return `${base} AND ${c}.max_length = ${length(args[0], 1)}`;
        case 'nchar': case 'nvarchar': return `${base} AND ${c}.max_length = ${length(args[0], 2)}`;
        case 'decimal': case 'numeric': return `${base} AND ${c}.precision = ${Number(args[0])} AND ${c}.scale = ${Number(args[1])}`;
        case 'datetime2': case 'datetimeoffset': case 'time': return `${base} AND ${c}.scale = ${Number(args[0])}`;
        case 'float': return `${base} AND ${c}.precision = ${args[0] ? Number(args[0]) : 53}`;
        default: return base;
    }
}

function defaultClause(def) {
    return def.systemNamed ? `DEFAULT ${def.definition}` : `CONSTRAINT ${q(def.name)} DEFAULT ${def.definition}`;
}

// A column as it is written in a CREATE TABLE or an ADD.
function columnDefinition(column) {
    if (column.computed) return `${q(column.name)} AS ${column.computed.definition}${column.computed.persisted ? ' PERSISTED' : ''}`;
    let text = `${q(column.name)} ${column.type}`;
    if (column.collation) text += ` COLLATE ${column.collation}`;
    if (column.identity) text += ` IDENTITY(${column.identity.seed},${column.identity.increment})`;
    text += column.nullable ? ' NULL' : ' NOT NULL';
    if (column.default) text += ` ${defaultClause(column.default)}`;
    return text;
}

// === Constraints and indexes: how the server's own names are dealt with ===
//
// A constraint with a name the server made up (PK__T__3213E83F) has another
// name in every database, so it is found by what it does, and the script gives
// it no name when it creates it.

const keyColumnsMatch = (alias, columns) => `(SELECT COUNT(*) FROM sys.index_columns ic WHERE ic.object_id = ${alias}.object_id AND ic.index_id = ${alias}.index_id AND ic.is_included_column = 0) = ${columns.length}`
    + columns.map((c, i) => ` AND EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id WHERE ic.object_id = ${alias}.object_id AND ic.index_id = ${alias}.index_id AND ic.key_ordinal = ${i + 1} AND col.name = ${N(c.name)})`).join('');

const uniqueMatch = unique => (unique.systemNamed
    ? `i.is_unique_constraint = 1 AND ${keyColumnsMatch('i', unique.columns)}`
    : `i.is_unique_constraint = 1 AND i.name = ${N(unique.name)}`);

const foreignKeyMatch = fk => (fk.systemNamed
    ? `fk.referenced_object_id = ${objectId(fk.refSchema, fk.refTable)} AND (SELECT COUNT(*) FROM sys.foreign_key_columns k WHERE k.constraint_object_id = fk.object_id) = ${fk.columns.length}`
        + fk.columns.map((c, i) => ` AND EXISTS (SELECT 1 FROM sys.foreign_key_columns k JOIN sys.columns pc ON pc.object_id = k.parent_object_id AND pc.column_id = k.parent_column_id JOIN sys.columns rc ON rc.object_id = k.referenced_object_id AND rc.column_id = k.referenced_column_id WHERE k.constraint_object_id = fk.object_id AND pc.name = ${N(c)} AND rc.name = ${N(fk.refColumns[i])})`).join('')
    : `fk.name = ${N(fk.name)}`);

const checkMatch = check => (check.systemNamed ? `cc.definition = ${N(check.definition)}` : `cc.name = ${N(check.name)}`);

// Drops the constraint that is found by a condition, whatever its name is.
function dropFound(schema, name, view, alias, parentColumn, condition) {
    return `DECLARE @n sysname = (SELECT TOP 1 ${alias}.name FROM ${view} ${alias} WHERE ${alias}.${parentColumn} = ${objectId(schema, name)} AND ${condition});\n`
        + `DECLARE @sql nvarchar(max) = N'ALTER TABLE ${escapeLiteral(tableName(schema, name))} DROP CONSTRAINT ' + QUOTENAME(@n);\n`
        + 'IF @n IS NOT NULL EXEC (@sql);';
}

const defaultOnColumn = (schema, name, column) => `dc.parent_column_id = COLUMNPROPERTY(${objectId(schema, name)}, ${N(column)}, 'ColumnId')`;

function referentialClause(fk) {
    const action = value => String(value).replace(/_/g, ' ');
    return `${fk.onDelete && fk.onDelete !== 'NO_ACTION' ? ` ON DELETE ${action(fk.onDelete)}` : ''}${fk.onUpdate && fk.onUpdate !== 'NO_ACTION' ? ` ON UPDATE ${action(fk.onUpdate)}` : ''}`;
}

// === The statements of each operation ===
// Each returns the batches of a step: { sql, first } where first means the
// batch has to start with its own statement (CREATE OR ALTER does).

const batch = sql => ({ sql });

const guarded = (condition, statement) => `IF ${condition}\n    ${statement}`;

const sql = {
    createSchema: schema => batch(`IF SCHEMA_ID(${N(schema)}) IS NULL EXEC (N'CREATE SCHEMA ${escapeLiteral(q(schema))}');`),
    dropSchema: schema => batch(`IF SCHEMA_ID(${N(schema)}) IS NOT NULL EXEC (N'DROP SCHEMA ${escapeLiteral(q(schema))}');`),

    createTable(table) {
        const lines = table.columns.map(c => `    ${columnDefinition(c)}`);
        if (table.primaryKey) lines.push(`    ${table.primaryKey.systemNamed ? '' : `CONSTRAINT ${q(table.primaryKey.name)} `}PRIMARY KEY ${table.primaryKey.clustered ? 'CLUSTERED' : 'NONCLUSTERED'} (${columnList(table.primaryKey.columns)})`);
        for (const u of table.uniques) lines.push(`    ${u.systemNamed ? '' : `CONSTRAINT ${q(u.name)} `}UNIQUE ${u.clustered ? 'CLUSTERED' : 'NONCLUSTERED'} (${columnList(u.columns)})`);
        return batch(`IF OBJECT_ID(${N(tableName(table.schema, table.name))}, N'U') IS NULL\nBEGIN\n    CREATE TABLE ${tableName(table.schema, table.name)} (\n${lines.join(',\n')}\n    );\nEND`);
    },
    dropTable: (schema, name) => batch(`IF OBJECT_ID(${N(tableName(schema, name))}, N'U') IS NOT NULL\n    DROP TABLE ${tableName(schema, name)};`),

    addColumn: (schema, name, column) => batch(guarded(`COL_LENGTH(${N(tableName(schema, name))}, ${N(column.name)}) IS NULL`, `ALTER TABLE ${tableName(schema, name)} ADD ${columnDefinition(column)};`)),
    dropColumn: (schema, name, column) => batch(guarded(`COL_LENGTH(${N(tableName(schema, name))}, ${N(column.name)}) IS NOT NULL`, `ALTER TABLE ${tableName(schema, name)} DROP COLUMN ${q(column.name)};`)),
    alterColumn(schema, name, to) {
        const mismatch = [`NOT (${typeMatches(to.type)} AND c.is_nullable = ${to.nullable ? 1 : 0}${to.collation ? ` AND ISNULL(c.collation_name, N'') = ${N(to.collation)}` : ''})`];
        const exists = `EXISTS (SELECT 1 FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id WHERE c.object_id = ${objectId(schema, name)} AND c.name = ${N(to.name)} AND ${mismatch[0]})`;
        return batch(guarded(exists, `ALTER TABLE ${tableName(schema, name)} ALTER COLUMN ${q(to.name)} ${to.type}${to.collation ? ` COLLATE ${to.collation}` : ''}${to.nullable ? ' NULL' : ' NOT NULL'};`));
    },

    addDefault: (schema, name, column, def) => batch(guarded(`NOT EXISTS (SELECT 1 FROM sys.default_constraints dc WHERE dc.parent_object_id = ${objectId(schema, name)} AND ${defaultOnColumn(schema, name, column)})`,
        `ALTER TABLE ${tableName(schema, name)} ADD ${defaultClause(def)} FOR ${q(column)};`)),
    dropDefault: (schema, name, column) => batch(dropFound(schema, name, 'sys.default_constraints', 'dc', 'parent_object_id', defaultOnColumn(schema, name, column))),

    addPrimaryKey: (schema, name, pk) => batch(guarded(`NOT EXISTS (SELECT 1 FROM sys.key_constraints kc WHERE kc.parent_object_id = ${objectId(schema, name)} AND kc.type = 'PK')`,
        `ALTER TABLE ${tableName(schema, name)} ADD ${pk.systemNamed ? '' : `CONSTRAINT ${q(pk.name)} `}PRIMARY KEY ${pk.clustered ? 'CLUSTERED' : 'NONCLUSTERED'} (${columnList(pk.columns)});`)),
    dropPrimaryKey: (schema, name) => batch(dropFound(schema, name, 'sys.key_constraints', 'kc', 'parent_object_id', "kc.type = 'PK'")),

    addUnique: (schema, name, u) => batch(guarded(`NOT EXISTS (SELECT 1 FROM sys.indexes i WHERE i.object_id = ${objectId(schema, name)} AND ${uniqueMatch(u)})`,
        `ALTER TABLE ${tableName(schema, name)} ADD ${u.systemNamed ? '' : `CONSTRAINT ${q(u.name)} `}UNIQUE ${u.clustered ? 'CLUSTERED' : 'NONCLUSTERED'} (${columnList(u.columns)});`)),
    dropUnique: (schema, name, u) => batch(dropFound(schema, name, 'sys.indexes', 'i', 'object_id', uniqueMatch(u))),

    addIndex(schema, name, ix) {
        const include = ix.included.length > 0 ? ` INCLUDE (${plainList(ix.included)})` : '';
        const filter = ix.filter ? ` WHERE ${ix.filter}` : '';
        const create = guarded(`NOT EXISTS (SELECT 1 FROM sys.indexes i WHERE i.object_id = ${objectId(schema, name)} AND i.name = ${N(ix.name)})`,
            `CREATE ${ix.unique ? 'UNIQUE ' : ''}${ix.clustered ? 'CLUSTERED' : 'NONCLUSTERED'} INDEX ${q(ix.name)} ON ${tableName(schema, name)} (${columnList(ix.columns)})${include}${filter};`);
        return ix.disabled
            ? [batch(create), batch(guarded(`EXISTS (SELECT 1 FROM sys.indexes i WHERE i.object_id = ${objectId(schema, name)} AND i.name = ${N(ix.name)} AND i.is_disabled = 0)`, `ALTER INDEX ${q(ix.name)} ON ${tableName(schema, name)} DISABLE;`))]
            : batch(create);
    },
    dropIndex: (schema, name, ix) => batch(guarded(`EXISTS (SELECT 1 FROM sys.indexes i WHERE i.object_id = ${objectId(schema, name)} AND i.name = ${N(ix.name)})`, `DROP INDEX ${q(ix.name)} ON ${tableName(schema, name)};`)),

    addCheck: (schema, name, ck) => batch(guarded(`NOT EXISTS (SELECT 1 FROM sys.check_constraints cc WHERE cc.parent_object_id = ${objectId(schema, name)} AND ${checkMatch(ck)})`,
        `ALTER TABLE ${tableName(schema, name)} WITH CHECK ADD ${ck.systemNamed ? '' : `CONSTRAINT ${q(ck.name)} `}CHECK ${ck.definition};`)),
    dropCheck: (schema, name, ck) => batch(dropFound(schema, name, 'sys.check_constraints', 'cc', 'parent_object_id', checkMatch(ck))),

    addForeignKey: (schema, name, fk) => batch(guarded(`NOT EXISTS (SELECT 1 FROM sys.foreign_keys fk WHERE fk.parent_object_id = ${objectId(schema, name)} AND ${foreignKeyMatch(fk)})`,
        `ALTER TABLE ${tableName(schema, name)} WITH CHECK ADD ${fk.systemNamed ? '' : `CONSTRAINT ${q(fk.name)} `}FOREIGN KEY (${plainList(fk.columns)}) REFERENCES ${tableName(fk.refSchema, fk.refTable)} (${plainList(fk.refColumns)})${referentialClause(fk)};`)),
    dropForeignKey: (schema, name, fk) => batch(dropFound(schema, name, 'sys.foreign_keys', 'fk', 'parent_object_id', foreignKeyMatch(fk)))
};

// === Code objects ===

const KIND_KEYWORD = { view: 'VIEW', procedure: 'PROCEDURE', function: 'FUNCTION', trigger: 'TRIGGER' };

function moduleExists(module) {
    const id = tableName(module.schema, module.name);
    switch (module.type) {
        case 'view': return `OBJECT_ID(${N(id)}, N'V') IS NOT NULL`;
        case 'procedure': return `OBJECT_ID(${N(id)}, N'P') IS NOT NULL`;
        case 'trigger': return `OBJECT_ID(${N(id)}, N'TR') IS NOT NULL`;
        default: return `(OBJECT_ID(${N(id)}, N'FN') IS NOT NULL OR OBJECT_ID(${N(id)}, N'IF') IS NOT NULL OR OBJECT_ID(${N(id)}, N'TF') IS NOT NULL)`;
    }
}

function dropModule(module) {
    return batch(`IF ${moduleExists(module)}\n    DROP ${KIND_KEYWORD[module.type]} ${tableName(module.schema, module.name)};`);
}

// The SET options the module was made with, before it; "pre" batches check the
// script is still running and note the time, the module is checked after.
function setOptions(module) {
    return { sql: `SET ANSI_NULLS ${module.ansiNulls ? 'ON' : 'OFF'};\nSET QUOTED_IDENTIFIER ${module.quotedIdentifier ? 'ON' : 'OFF'};`, pre: true };
}

// Done when the module was written since the "pre" batch noted the time.
function verified(module) {
    return { verify: `IF EXISTS (SELECT 1 FROM sys.objects o CROSS JOIN #wf w WHERE o.object_id = OBJECT_ID(${N(tableName(module.schema, module.name))}) AND o.modify_date >= w.t)\n    UPDATE #wf SET n = {n};` };
}

// The definition with another header: CREATE OR ALTER, ALTER or CREATE.
function withHeader(definition, keyword) {
    const header = parseHeader(definition);
    if (!header) return null;
    return `${definition.slice(0, header.start)}${keyword}${definition.slice(header.end)}`;
}

// The batches that create or change a module. With CREATE OR ALTER it is
// one; before 2016 SP1 a procedure or a view gets an empty stand-in first and
// is altered (which keeps its permissions), a function or a trigger is dropped
// and created again.
function moduleBatches(module, createOrAlter) {
    const text = createOrAlter ? withHeader(module.definition, 'CREATE OR ALTER') : null;
    if (createOrAlter) return text ? [setOptions(module), { sql: text, first: true }, verified(module)] : null;

    if (module.type === 'procedure' || module.type === 'view') {
        const alter = withHeader(module.definition, 'ALTER');
        if (!alter) return null;
        const stub = module.type === 'procedure' ? 'CREATE PROCEDURE ' + tableName(module.schema, module.name) + ' AS RETURN 0' : 'CREATE VIEW ' + tableName(module.schema, module.name) + ' AS SELECT 1 AS stub';
        return [setOptions(module), batch(`IF NOT ${moduleExists(module)}\n    EXEC (N'${escapeLiteral(stub)}');`), { sql: alter, first: true }, verified(module)];
    }
    const create = withHeader(module.definition, 'CREATE');
    return create ? [setOptions(module), dropModule(module), { sql: create, first: true }, verified(module)] : null;
}

// What the code of a module mentions of the other modules that change in the
// same script, so that a view is created after the views it reads. The words of
// each definition are looked up in an index of the names: one pass over the
// text, not one search per pair of modules.
function orderModules(modules) {
    const byName = new Map();
    modules.forEach((module, i) => {
        const key = module.name.toLowerCase();
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(i);
    });
    const waitingFor = modules.map((module, i) => {
        const found = new Set();
        for (const word of String(module.definition || '').toLowerCase().match(/[\w@#$]+/g) || []) {
            const hits = byName.get(word);
            if (hits) for (const j of hits) if (j !== i) found.add(j);
        }
        return found;
    });
    const dependents = modules.map(() => []);
    waitingFor.forEach((set, i) => set.forEach(j => dependents[j].push(i)));
    const missing = waitingFor.map(set => set.size);

    const ordered = [];
    const queued = new Array(modules.length).fill(false);
    const queue = [];
    const push = i => { queued[i] = true; queue.push(i); };
    missing.forEach((count, i) => { if (count === 0) push(i); });
    for (let head = 0; ordered.length < modules.length;) {
        if (head >= queue.length) {
            // A cycle: the first of what is left goes, in the order it came.
            push(queued.indexOf(false));
        }
        const i = queue[head++];
        ordered.push(modules[i]);
        for (const dependent of dependents[i]) {
            if (!queued[dependent] && --missing[dependent] === 0) push(dependent);
        }
    }
    return ordered;
}

// === The script ===

const KIND_ORDER = { view: 0, function: 1, procedure: 2, trigger: 0 };

// The key a change is picked by in the interface.
const changeId = change => `${change.kind}:${change.name}`;

function buildMigrationScript(diff, options = {}) {
    const { selected = null, allowDestructive = false, createOrAlter = true, reference = '', current = '', now = new Date() } = options;
    const steps = [];
    const skipped = [];
    const warnings = [];
    const included = [];

    // A column of a user-defined type needs the type on the target: types are not part of the comparison.
    const warnedTypes = new Set();
    const noteTypes = (columns, owner) => {
        for (const column of columns) {
            if (column.computed || !String(column.type).startsWith('[')) continue;
            const key = `${owner}.${column.name}`;
            if (warnedTypes.has(key)) continue;
            warnedTypes.add(key);
            warnings.push(`${key}: the type ${column.type} has to exist on the target (user-defined types are not part of the comparison).`);
        }
    };

    const add = (phase, change, op, batches, label) => {
        for (const item of [op.foreignKey, op.check, op.to, op.index]) {
            if (item && item.disabled === true && (op.op === 'addForeignKey' || op.op === 'addCheck' || op.op === 'alterForeignKey' || op.op === 'alterCheck')) warnings.push(`${label}: it is disabled in the current state; the script creates it enabled.`);
        }
        if (op.risk === 'manual') { skipped.push({ change: changeId(change), op: op.op, label, reason: 'It cannot be done in place: it needs the column to be rebuilt by hand.' }); return; }
        if (op.risk === 'destructive' && !allowDestructive) { skipped.push({ change: changeId(change), op: op.op, label, reason: 'It loses data, and destructive changes were not asked for.' }); return; }
        steps.push({ phase, change: changeId(change), risk: op.risk, label, batches: [].concat(batches) });
    };

    const picked = diff.changes.filter(change => !selected || selected.has(changeId(change)));
    const moduleChanges = [];

    for (const change of picked) {
        included.push(changeId(change));
        if (change.kind === 'schema') {
            if (change.status === 'added') add(PHASE.SCHEMA, change, change.ops[0], sql.createSchema(change.name), `create schema ${change.name}`);
            else add(PHASE.DROP_SCHEMA, change, change.ops[0], sql.dropSchema(change.name), `drop schema ${change.name}`);
        } else if (change.kind === 'table') {
            tableSteps(change, add, warnings, noteTypes);
        } else {
            moduleChanges.push(change);
        }
    }

    // Code: views, then functions, then procedures, then triggers, each group after what it reads.
    const rewritten = moduleChanges.filter(c => c.status === 'added' || (c.status === 'modified' && c.ops[0].what.some(w => w !== 'disabled')));
    for (const kind of ['view', 'function', 'procedure', 'trigger']) {
        const ofKind = rewritten.filter(c => c.kind === kind);
        const changeOf = new Map(ofKind.map(c => [c.current, c]));
        const ordered = orderModules(ofKind.map(c => c.current)).map(m => changeOf.get(m));
        for (const change of ordered) {
            const op = change.ops[0];
            const batches = moduleBatches(change.current, createOrAlter);
            if (!batches) { skipped.push({ change: changeId(change), op: op.op, label: `${change.kind} ${change.name}`, reason: 'Its definition cannot be read (encrypted, or VIEW DEFINITION is missing).' }); continue; }
            // A trigger that moved to another table is dropped before it is created again.
            if (op.what && op.what.includes('parent')) add(PHASE.TRIGGER - 0.5, change, op, dropModule(change.reference), `drop trigger ${change.name} (it moves to another table)`);
            add(PHASE[kind === 'trigger' ? 'TRIGGER' : 'MODULE'] + (KIND_ORDER[kind] || 0) / 10, change, op, batches, `${change.status === 'added' ? 'create' : 'alter'} ${change.kind} ${change.name}`);
        }
    }
    // Enabled or disabled, as the trigger is in the current state.
    for (const change of moduleChanges.filter(c => c.kind === 'trigger' && c.status !== 'removed')) {
        const module = change.current;
        const op = change.ops[0];
        const changed = change.status === 'added' ? module.disabled : op.what.includes('disabled');
        if (!changed || !module.parent) continue;
        const parent = module.parent.split('.');
        const guard = `EXISTS (SELECT 1 FROM sys.triggers tr WHERE tr.object_id = OBJECT_ID(${N(tableName(module.schema, module.name))}) AND tr.is_disabled = ${module.disabled ? 0 : 1})`;
        add(PHASE.TRIGGER + 1, change, op, batch(guarded(guard, `${module.disabled ? 'DISABLE' : 'ENABLE'} TRIGGER ${tableName(module.schema, module.name)} ON ${tableName(parent[0], parent.slice(1).join('.'))};`)), `${module.disabled ? 'disable' : 'enable'} trigger ${change.name}`);
    }
    for (const change of moduleChanges.filter(c => c.status === 'removed')) {
        add(PHASE.DROP_MODULE, change, change.ops[0], dropModule(change.reference), `drop ${change.kind} ${change.name}`);
    }

    steps.sort((a, b) => a.phase - b.phase);

    // One batch per statement. A batch runs only if the one before it finished
    // (#wf holds the number of the last that did), so a batch that fails, at
    // run time or already when it is compiled, stops the ones after it.
    const blocks = [];
    let lastLabel = null;
    let done = 0;
    const requires = n => `IF NOT EXISTS (SELECT 1 FROM #wf WHERE n = ${n}) SET NOEXEC ON;`;
    for (const step of steps) {
        if (step.label !== lastLabel) { blocks.push(`-- ${step.label}${step.risk === 'caution' ? '   (caution: can fail on the data that is there)' : ''}`); lastLabel = step.label; }
        for (const b of step.batches) {
            if (b.first) blocks.push(b.sql);
            else if (b.pre) blocks.push(`${requires(done)}\n${b.sql}\nUPDATE #wf SET t = GETDATE();`);
            else if (b.verify) { done++; blocks.push(`${requires(done - 1)}\n${b.verify.replace('{n}', String(done))}`); }
            else { done++; blocks.push(`${requires(done - 1)}\n${b.sql}\nIF @@ERROR = 0 UPDATE #wf SET n = ${done};`); }
        }
    }

    const header = [
        '-- SQL Wayfarer: the changes between two states of a database',
        `-- From: ${reference || '(reference)'}   To: ${current || '(current)'}   Generated: ${now.toISOString()}`,
        '-- Re-entrant: every step tests the state it changes, so the script can be run again,',
        '-- on a database that is already up to date or half way. It stops at the first error.',
        `-- ${steps.length} step(s)${skipped.length > 0 ? `, ${skipped.length} left out (see below)` : ''}.`
    ];
    const leftOut = skipped.map(s => `-- Left out: ${s.label}. ${s.reason}`);
    const parts = [header.join('\n')];
    if (leftOut.length > 0) parts.push(leftOut.join('\n'));
    if (steps.length > 0) {
        parts.push('SET NOEXEC OFF;');
        parts.push("SET NOCOUNT ON;\nIF OBJECT_ID(N'tempdb..#wf') IS NOT NULL DROP TABLE #wf;\nCREATE TABLE #wf (n int NOT NULL, t datetime NULL);\nINSERT #wf (n) VALUES (0);");
        parts.push(...blocks);
        // The session goes back to its defaults: a module can have been created with an option off.
        parts.push('SET NOEXEC OFF;');
        parts.push('IF OBJECT_ID(N\'tempdb..#wf\') IS NOT NULL DROP TABLE #wf;\nSET ANSI_NULLS ON;\nSET QUOTED_IDENTIFIER ON;');
    }
    return {
        script: `${parts.join('\nGO\n')}\n`,
        steps: steps.length,
        included,
        skipped,
        warnings
    };
}

// The steps of the operations of one table.
function tableSteps(change, add, warnings, noteTypes) {
    const label = `table ${change.name}`;
    if (change.status === 'added') {
        const table = change.current;
        noteTypes(table.columns, change.name);
        add(PHASE.TABLE, change, change.ops[0], sql.createTable(table), `create ${label}`);
        for (const ix of table.indexes) add(PHASE.INDEX, change, { op: 'addIndex', risk: 'safe' }, sql.addIndex(table.schema, table.name, ix), `create index ${ix.name} on ${change.name}`);
        for (const ck of table.checks) add(PHASE.CHECK, change, { op: 'addCheck', risk: 'safe' }, sql.addCheck(table.schema, table.name, ck), `add check on ${change.name}`);
        for (const fk of table.foreignKeys) add(PHASE.FOREIGN_KEY, change, { op: 'addForeignKey', risk: 'safe' }, sql.addForeignKey(table.schema, table.name, fk), `add foreign key on ${change.name}`);
        return;
    }
    if (change.status === 'removed') {
        const table = change.reference;
        add(PHASE.DROP_TABLE, change, change.ops[0], sql.dropTable(table.schema, table.name), `drop ${label}`);
        return;
    }
    const { schema, name } = change.current;
    for (const op of change.ops) {
        switch (op.op) {
            case 'dropColumn':
                add(PHASE.TABLE - 1, change, op, [sql.dropDefault(schema, name, op.column.name), sql.dropColumn(schema, name, op.column)], `drop column ${op.column.name} of ${change.name}`);
                break;
            case 'addColumn':
                if (op.needsDefault) warnings.push(`${change.name}.${op.column.name}: NOT NULL without a default fails when the table has rows.`);
                noteTypes([op.column], change.name);
                add(PHASE.TABLE, change, op, sql.addColumn(schema, name, op.column), `add column ${op.column.name} to ${change.name}`);
                break;
            case 'alterColumn': {
                const rebuild = op.changes.filter(c => c !== 'type' && c !== 'nullable' && c !== 'collation');
                if (rebuild.length > 0) {
                    add(PHASE.TABLE, change, Object.assign({}, op, { risk: 'manual' }), [], `change ${rebuild.join(' and ')} of column ${op.name} of ${change.name}`);
                    break;
                }
                const steps = [];
                noteTypes([op.to], change.name);
                // A default has to be out of the way for the type to change, then comes back.
                if (op.to.default && op.changes.includes('type')) steps.push(sql.dropDefault(schema, name, op.name));
                steps.push(sql.alterColumn(schema, name, op.to));
                if (op.to.default && op.changes.includes('type')) steps.push(sql.addDefault(schema, name, op.name, op.to.default));
                add(PHASE.TABLE, change, op, steps, `alter column ${op.name} of ${change.name}`);
                break;
            }
            case 'addDefault': add(PHASE.TABLE + 0.5, change, op, sql.addDefault(schema, name, op.column, op.default), `add default on ${change.name}.${op.column}`); break;
            case 'dropDefault': add(PHASE.DROP_DEFAULT, change, op, sql.dropDefault(schema, name, op.column), `drop default on ${change.name}.${op.column}`); break;
            case 'alterDefault':
                add(PHASE.TABLE + 0.5, change, op, [sql.dropDefault(schema, name, op.column), sql.addDefault(schema, name, op.column, op.to)], `change default on ${change.name}.${op.column}`);
                break;
            case 'addPrimaryKey': add(PHASE.KEY, change, op, sql.addPrimaryKey(schema, name, op.primaryKey), `add primary key on ${change.name}`); break;
            case 'dropPrimaryKey': add(PHASE.DROP_KEY, change, op, sql.dropPrimaryKey(schema, name), `drop primary key of ${change.name}`); break;
            case 'alterPrimaryKey':
                add(PHASE.DROP_KEY, change, op, sql.dropPrimaryKey(schema, name), `drop primary key of ${change.name}`);
                add(PHASE.KEY, change, op, sql.addPrimaryKey(schema, name, op.to), `add primary key on ${change.name}`);
                break;
            case 'addUnique': add(PHASE.KEY, change, op, sql.addUnique(schema, name, op.unique), `add unique on ${change.name}`); break;
            case 'dropUnique': add(PHASE.DROP_KEY, change, op, sql.dropUnique(schema, name, op.unique), `drop unique of ${change.name}`); break;
            case 'alterUnique':
                add(PHASE.DROP_KEY, change, op, sql.dropUnique(schema, name, op.from), `drop unique of ${change.name}`);
                add(PHASE.KEY, change, op, sql.addUnique(schema, name, op.to), `add unique on ${change.name}`);
                break;
            case 'addIndex': add(PHASE.INDEX, change, op, sql.addIndex(schema, name, op.index), `create index ${op.index.name} on ${change.name}`); break;
            case 'dropIndex': add(PHASE.DROP_INDEX, change, op, sql.dropIndex(schema, name, op.index), `drop index ${op.index.name} on ${change.name}`); break;
            case 'alterIndex':
                add(PHASE.DROP_INDEX, change, op, sql.dropIndex(schema, name, op.from), `drop index ${op.from.name} on ${change.name}`);
                add(PHASE.INDEX, change, op, sql.addIndex(schema, name, op.to), `create index ${op.to.name} on ${change.name}`);
                break;
            case 'addCheck': add(PHASE.CHECK, change, op, sql.addCheck(schema, name, op.check), `add check on ${change.name}`); break;
            case 'dropCheck': add(PHASE.DROP_CHECK, change, op, sql.dropCheck(schema, name, op.check), `drop check of ${change.name}`); break;
            case 'alterCheck':
                add(PHASE.DROP_CHECK, change, op, sql.dropCheck(schema, name, op.from), `drop check of ${change.name}`);
                add(PHASE.CHECK, change, op, sql.addCheck(schema, name, op.to), `add check on ${change.name}`);
                break;
            case 'addForeignKey': add(PHASE.FOREIGN_KEY, change, op, sql.addForeignKey(schema, name, op.foreignKey), `add foreign key on ${change.name}`); break;
            case 'dropForeignKey': add(PHASE.DROP_FOREIGN_KEY, change, op, sql.dropForeignKey(schema, name, op.foreignKey), `drop foreign key of ${change.name}`); break;
            case 'alterForeignKey':
                add(PHASE.DROP_FOREIGN_KEY, change, op, sql.dropForeignKey(schema, name, op.from), `drop foreign key of ${change.name}`);
                add(PHASE.FOREIGN_KEY, change, op, sql.addForeignKey(schema, name, op.to), `add foreign key on ${change.name}`);
                break;
            default: break;
        }
    }
}

module.exports = { buildMigrationScript, changeId, supportsCreateOrAlter, withHeader, orderModules, typeMatches };
