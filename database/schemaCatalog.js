'use strict';

const { bracketIdentifier } = require('./sqlIdentifier');

// === The schema of a database, read from its catalog ===
//
// One round trip of a few SELECTs on sys.* (never one query per table), put in
// a plain model that can be compared, written as JSON and read back. The same
// reader serves the database being worked on and a snapshot of it.
//
// What the model holds: schemas; tables with their columns (type, nullability,
// identity, computed, default, collation), primary key, unique constraints,
// indexes (rowstore, INCLUDE, filter), foreign keys and check constraints;
// views, procedures, functions and DML triggers with their definition.
// What it does not hold is counted in notCompared, so a comparison never says
// "identical" about things it did not look at.

const FORMAT_VERSION = 1;

const INFO_QUERY = `
SELECT CAST(SERVERPROPERTY('ProductVersion') AS varchar(32)) AS version,
       CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS nvarchar(128)) AS collation`;

const SCHEMAS_QUERY = `
SELECT name FROM sys.schemas
WHERE schema_id > 4 AND schema_id < 16384
ORDER BY name`;

const COLUMNS_QUERY = `
SELECT s.name AS schema_name, t.name AS table_name, c.column_id, c.name AS column_name,
       ty.name AS type_name, ty.is_user_defined, ts.name AS type_schema,
       c.max_length, c.precision, c.scale, c.is_nullable,
       c.is_identity, CAST(ic.seed_value AS varchar(40)) AS seed, CAST(ic.increment_value AS varchar(40)) AS increment,
       c.is_computed, cc.definition AS computed_definition, cc.is_persisted,
       c.collation_name,
       dc.name AS default_name, dc.definition AS default_definition, dc.is_system_named AS default_system_named
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.columns c ON c.object_id = t.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
JOIN sys.schemas ts ON ts.schema_id = ty.schema_id
LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
WHERE t.is_ms_shipped = 0
ORDER BY s.name, t.name, c.column_id`;

const INDEXES_QUERY = `
SELECT s.name AS schema_name, t.name AS table_name, i.index_id, i.name AS index_name, i.type_desc,
       i.is_unique, i.is_primary_key, i.is_unique_constraint, i.has_filter, i.filter_definition, i.is_disabled,
       kc.is_system_named AS constraint_system_named,
       ic.key_ordinal, ic.is_descending_key, ic.is_included_column, c.name AS column_name
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.indexes i ON i.object_id = t.object_id
LEFT JOIN sys.key_constraints kc ON kc.parent_object_id = i.object_id AND kc.unique_index_id = i.index_id
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE t.is_ms_shipped = 0 AND i.type > 0
ORDER BY s.name, t.name, i.index_id, ic.is_included_column, ic.key_ordinal, ic.index_column_id`;

const FOREIGN_KEYS_QUERY = `
SELECT s.name AS schema_name, t.name AS table_name, fk.name AS fk_name, fk.is_system_named, fk.is_disabled,
       fk.delete_referential_action_desc AS on_delete, fk.update_referential_action_desc AS on_update,
       rs.name AS ref_schema, rt.name AS ref_table, pc.name AS column_name, rc.name AS ref_column
FROM sys.foreign_keys fk
JOIN sys.tables t ON t.object_id = fk.parent_object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
WHERE t.is_ms_shipped = 0
ORDER BY s.name, t.name, fk.name, fkc.constraint_column_id`;

const CHECKS_QUERY = `
SELECT s.name AS schema_name, t.name AS table_name, cc.name AS check_name, cc.definition,
       cc.is_system_named, cc.is_disabled
FROM sys.check_constraints cc
JOIN sys.tables t ON t.object_id = cc.parent_object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE t.is_ms_shipped = 0
ORDER BY s.name, t.name, cc.name`;

const MODULES_QUERY = `
SELECT s.name AS schema_name, o.name AS object_name, o.type AS type_code,
       m.definition, m.uses_ansi_nulls, m.uses_quoted_identifier,
       ps.name AS parent_schema, po.name AS parent_name, tr.is_disabled
FROM sys.objects o
JOIN sys.schemas s ON s.schema_id = o.schema_id
LEFT JOIN sys.sql_modules m ON m.object_id = o.object_id
LEFT JOIN sys.objects po ON po.object_id = o.parent_object_id
LEFT JOIN sys.schemas ps ON ps.schema_id = po.schema_id
LEFT JOIN sys.triggers tr ON tr.object_id = o.object_id
WHERE o.is_ms_shipped = 0 AND o.type IN ('V', 'P', 'FN', 'IF', 'TF', 'TR')
ORDER BY s.name, o.name`;

// What the model does not hold, counted.
const NOT_COMPARED_QUERY = `
SELECT 'synonyms' AS kind, COUNT(*) AS n FROM sys.synonyms
UNION ALL SELECT 'clrObjects', COUNT(*) FROM sys.objects WHERE type IN ('PC', 'FS', 'FT', 'AF', 'TA') AND is_ms_shipped = 0
UNION ALL SELECT 'ddlTriggers', COUNT(*) FROM sys.triggers WHERE parent_class = 0
UNION ALL SELECT 'userTypes', COUNT(*) FROM sys.types WHERE is_user_defined = 1
UNION ALL SELECT 'otherIndexes', COUNT(*) FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id WHERE t.is_ms_shipped = 0 AND i.type NOT IN (0, 1, 2)
UNION ALL SELECT 'partitionedTables', COUNT(DISTINCT p.object_id) FROM sys.partitions p JOIN sys.tables t ON t.object_id = p.object_id WHERE t.is_ms_shipped = 0 AND p.index_id IN (0, 1) AND p.partition_number > 1`;

// What only exists from a given version is asked only where it exists, so the
// reader works on the old servers as well.
function versionedNotCompared(major) {
    return major >= 11 ? "SELECT 'sequences' AS kind, COUNT(*) AS n FROM sys.sequences" : '';
}

// The tables a CREATE TABLE written from the catalog would not rebuild (the
// period of a temporal table, memory-optimized storage, a graph or file table):
// they are left out of the model, and counted.
function versionedSpecialTables(major) {
    const from = 'FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE';
    const parts = [];
    if (major >= 11) parts.push(`SELECT 'fileTables' AS kind, s.name AS schema_name, t.name AS table_name ${from} t.is_filetable = 1`);
    if (major >= 12) parts.push(`SELECT 'memoryOptimizedTables', s.name, t.name ${from} t.is_memory_optimized = 1`);
    if (major >= 13) parts.push(`SELECT 'temporalTables', s.name, t.name ${from} t.temporal_type <> 0`);
    if (major >= 14) parts.push(`SELECT 'graphTables', s.name, t.name ${from} (t.is_node = 1 OR t.is_edge = 1)`);
    return parts.join('\nUNION ALL ');
}

const MODULE_TYPES = { V: 'view', P: 'procedure', FN: 'function', IF: 'function', TF: 'function', TR: 'trigger' };
const ROWSTORE_INDEX_TYPES = new Set(['CLUSTERED', 'NONCLUSTERED']);

// "nvarchar(50)", "decimal(10,2)", "[dbo].[MyType]" - the type of a column as
// it would be written in a CREATE TABLE.
function formatColumnType(row) {
    const name = row.type_name;
    if (row.is_user_defined) return `${bracketIdentifier(row.type_schema)}.${bracketIdentifier(name)}`;
    switch (name) {
        case 'char': case 'varchar': case 'binary': case 'varbinary':
            return `${name}(${row.max_length === -1 ? 'max' : row.max_length})`;
        case 'nchar': case 'nvarchar':
            return `${name}(${row.max_length === -1 ? 'max' : row.max_length / 2})`;
        case 'decimal': case 'numeric':
            return `${name}(${row.precision},${row.scale})`;
        case 'datetime2': case 'datetimeoffset': case 'time':
            return `${name}(${row.scale})`;
        case 'float':
            return row.precision === 53 ? 'float' : `float(${row.precision})`;
        default:
            return name;
    }
}

const tableKey = (schema, name) => `${schema}.${name}`;
const flag = value => value === true || value === 1;

function groupBy(rows, keyOf) {
    const groups = new Map();
    for (const row of rows) {
        const key = keyOf(row);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    return groups;
}

function buildTables(columns, indexes, foreignKeys, checks, databaseCollation) {
    const tables = {};
    const table = (schema, name) => {
        const key = tableKey(schema, name);
        if (!tables[key]) tables[key] = { schema, name, columns: [], primaryKey: null, uniques: [], indexes: [], foreignKeys: [], checks: [] };
        return tables[key];
    };

    for (const row of columns) {
        const column = {
            name: row.column_name,
            type: formatColumnType(row),
            nullable: flag(row.is_nullable),
            identity: flag(row.is_identity) ? { seed: String(row.seed), increment: String(row.increment) } : null,
            computed: flag(row.is_computed) ? { definition: row.computed_definition, persisted: flag(row.is_persisted) } : null,
            default: row.default_name ? { name: row.default_name, definition: row.default_definition, systemNamed: flag(row.default_system_named) } : null,
            // Only when it is not the one of the database: the same table in two databases
            // of another collation is not a difference of the table.
            collation: row.collation_name && row.collation_name !== databaseCollation ? row.collation_name : null
        };
        table(row.schema_name, row.table_name).columns.push(column);
    }

    // The rows of an index come one per column.
    const byIndex = groupBy(indexes, r => `${tableKey(r.schema_name, r.table_name)}\u0000${r.index_id}`);
    for (const rows of byIndex.values()) {
        const first = rows[0];
        if (!ROWSTORE_INDEX_TYPES.has(first.type_desc)) continue;
        const target = table(first.schema_name, first.table_name);
        const keys = rows.filter(r => !flag(r.is_included_column)).map(r => ({ name: r.column_name, desc: flag(r.is_descending_key) }));
        const clustered = first.type_desc === 'CLUSTERED';
        if (flag(first.is_primary_key)) {
            target.primaryKey = { name: first.index_name, systemNamed: flag(first.constraint_system_named), clustered, columns: keys };
        } else if (flag(first.is_unique_constraint)) {
            target.uniques.push({ name: first.index_name, systemNamed: flag(first.constraint_system_named), clustered, columns: keys });
        } else {
            target.indexes.push({
                name: first.index_name,
                unique: flag(first.is_unique),
                clustered,
                columns: keys,
                included: rows.filter(r => flag(r.is_included_column)).map(r => r.column_name),
                filter: flag(first.has_filter) ? first.filter_definition : null,
                disabled: flag(first.is_disabled)
            });
        }
    }

    const byForeignKey = groupBy(foreignKeys, r => `${tableKey(r.schema_name, r.table_name)}\u0000${r.fk_name}`);
    for (const rows of byForeignKey.values()) {
        const first = rows[0];
        table(first.schema_name, first.table_name).foreignKeys.push({
            name: first.fk_name,
            systemNamed: flag(first.is_system_named),
            columns: rows.map(r => r.column_name),
            refSchema: first.ref_schema,
            refTable: first.ref_table,
            refColumns: rows.map(r => r.ref_column),
            onDelete: first.on_delete,
            onUpdate: first.on_update,
            disabled: flag(first.is_disabled)
        });
    }

    for (const row of checks) {
        table(row.schema_name, row.table_name).checks.push({
            name: row.check_name,
            systemNamed: flag(row.is_system_named),
            definition: row.definition,
            disabled: flag(row.is_disabled)
        });
    }

    // Whatever order the server answered in, the model comes out the same.
    for (const t of Object.values(tables)) {
        t.uniques.sort((a, b) => a.name.localeCompare(b.name));
        t.indexes.sort((a, b) => a.name.localeCompare(b.name));
        t.foreignKeys.sort((a, b) => a.name.localeCompare(b.name));
        t.checks.sort((a, b) => a.name.localeCompare(b.name));
    }
    return Object.fromEntries(Object.entries(tables).sort(([a], [b]) => a.localeCompare(b)));
}

function buildModules(rows) {
    const modules = {};
    for (const row of rows) {
        const type = MODULE_TYPES[String(row.type_code).trim()];
        if (!type) continue;
        const module = {
            schema: row.schema_name,
            name: row.object_name,
            type,
            // null: encrypted, or not readable with the rights of the login.
            definition: row.definition === null || row.definition === undefined ? null : row.definition,
            ansiNulls: flag(row.uses_ansi_nulls),
            quotedIdentifier: flag(row.uses_quoted_identifier)
        };
        if (type === 'trigger') {
            module.parent = row.parent_name ? tableKey(row.parent_schema, row.parent_name) : null;
            module.disabled = flag(row.is_disabled);
        }
        modules[tableKey(row.schema_name, row.object_name)] = module;
    }
    return Object.fromEntries(Object.entries(modules).sort(([a], [b]) => a.localeCompare(b)));
}

function buildNotCompared(rows) {
    const counts = {};
    for (const row of rows) if (Number(row.n) > 0) counts[row.kind] = Number(row.n);
    return counts;
}

// The model, from the answers of the queries above (in that order); special
// are the tables left out (see versionedSpecialTables), as { kind, schema_name, table_name }.
function buildModel(database, info, schemas, columns, indexes, foreignKeys, checks, modules, notCompared, special = []) {
    if (special.length > 0) {
        const left = new Set(special.map(r => tableKey(r.schema_name, r.table_name)));
        const own = row => left.has(tableKey(row.schema_name, row.table_name));
        columns = columns.filter(r => !own(r));
        indexes = indexes.filter(r => !own(r));
        foreignKeys = foreignKeys.filter(r => !own(r));
        checks = checks.filter(r => !own(r));
        modules = modules.filter(r => !(r.parent_name && left.has(tableKey(r.parent_schema, r.parent_name))));
        const counts = {};
        for (const row of special) counts[row.kind] = (counts[row.kind] || 0) + 1;
        notCompared = notCompared.concat(Object.entries(counts).map(([kind, n]) => ({ kind, n })));
    }
    return {
        formatVersion: FORMAT_VERSION,
        database,
        serverVersion: info.version,
        collation: info.collation,
        schemas: schemas.map(r => r.name).sort((a, b) => a.localeCompare(b)),
        tables: buildTables(columns, indexes, foreignKeys, checks, info.collation),
        modules: buildModules(modules),
        notCompared: buildNotCompared(notCompared)
    };
}

function majorVersion(version) {
    const major = parseInt(String(version || '').split('.')[0], 10);
    return Number.isFinite(major) ? major : 0;
}

// Reads the schema of one database. A connection of its own is taken for the
// reading and put back in master, so that the pooled connection does not stay
// in the database (a snapshot cannot be dropped while a session is in it).
async function readSchemaModel(connectionManager, database) {
    const conn = await connectionManager.acquireConnection();
    try {
        const run = async text => (await conn.createRequest().batch(text)).recordsets;
        const sets = await run(`USE ${bracketIdentifier(database)};\n${[
            INFO_QUERY, SCHEMAS_QUERY, COLUMNS_QUERY, INDEXES_QUERY, FOREIGN_KEYS_QUERY, CHECKS_QUERY, MODULES_QUERY, NOT_COMPARED_QUERY
        ].join(';\n')}`);
        const [info, schemas, columns, indexes, foreignKeys, checks, modules, notCompared] = sets;

        const major = majorVersion(info[0].version);
        const wanted = [versionedNotCompared(major), versionedSpecialTables(major)];
        const answers = wanted.some(Boolean) ? await run(wanted.filter(Boolean).join(';\n')) : [];
        const counts = wanted[0] ? answers.shift() : [];
        const special = wanted[1] ? answers.shift() : [];
        return buildModel(database, info[0], schemas, columns, indexes, foreignKeys, checks, modules, notCompared.concat(counts), special);
    } finally {
        try { await conn.createRequest().batch('USE [master]'); } catch { /* the connection is gone, or USE is not allowed there */ }
        conn.release();
    }
}

module.exports = { FORMAT_VERSION, readSchemaModel, buildModel, formatColumnType, majorVersion, versionedNotCompared, versionedSpecialTables };
