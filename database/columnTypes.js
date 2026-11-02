/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// === The type of a result column, as T-SQL ===
//
// The driver describes each column of a result set (type, length, precision,
// scale, nullability). That becomes what a CREATE TABLE needs: the declaration
// ("nvarchar(50)") and a `kind` that says how a value is written as a literal.
// Types a literal cannot carry (geography, hierarchyid, sql_variant...) come
// out as nvarchar(max) of kind 'unsupported': their values are scripted as NULL.

const PLAIN_NUMBERS = new Set(['int', 'bigint', 'smallint', 'tinyint', 'float', 'real', 'money', 'smallmoney']);
const MAX_LENGTH = 8000; // beyond it (the driver says 65535 or 2^31 for MAX), the column is (max)

function sized(name, length, max = MAX_LENGTH) {
    return length > 0 && length <= max ? `${name}(${length})` : `${name}(max)`;
}

// column: one entry of the driver's recordset metadata. The mssql driver gives
// the type as an object (`declaration`, plus length, precision and scale); the
// Windows authentication helper (database/SspiPool.js) gives its name only. A
// size that is not known is written in the way that cannot lose data:
// varchar(max) for text and binary, decimal(38,10).
function describeColumn(column) {
    const raw = column && column.type;
    const type = String((raw && raw.declaration) || (typeof raw === 'string' ? raw : '')).toLowerCase();
    const nullable = !column || column.nullable !== false;
    const out = sql => ({ sql, kind: kindOf(type), nullable });
    const fixed = (variable, length) => (length > 0 && length <= MAX_LENGTH ? `${type}(${length})` : `${variable}(max)`);
    if (PLAIN_NUMBERS.has(type)) return out(type);
    switch (type) {
        case 'decimal':
        case 'numeric':
            return out(column.precision ? `${type}(${column.precision},${column.scale || 0})` : `${type}(38,10)`);
        case 'bit': return out('bit');
        case 'char': return out(fixed('varchar', column.length));
        case 'varchar': return out(sized(type, column.length));
        // The driver reports the length of n-types in bytes.
        case 'nchar': return out(fixed('nvarchar', Math.floor(column.length / 2) <= MAX_LENGTH / 2 ? Math.floor(column.length / 2) : 0));
        case 'nvarchar': return out(sized(type, Math.floor(column.length / 2), MAX_LENGTH / 2));
        case 'sysname': return { sql: 'nvarchar(128)', kind: 'string', nullable };
        case 'text': return out('varchar(max)');
        case 'ntext': return out('nvarchar(max)');
        case 'xml': return out('xml');
        case 'uniqueidentifier': return out('uniqueidentifier');
        case 'datetime': case 'smalldatetime': case 'date': return out(type);
        case 'datetime2': case 'time': case 'datetimeoffset': return out(column.scale !== undefined ? `${type}(${column.scale})` : type);
        case 'binary': return out(fixed('varbinary', column.length));
        case 'varbinary': return out(sized(type, column.length));
        case 'image': return out('varbinary(max)');
        default: return { sql: 'nvarchar(max)', kind: 'unsupported', nullable: true };
    }
}

function kindOf(type) {
    if (PLAIN_NUMBERS.has(type) || type === 'decimal' || type === 'numeric') return 'number';
    switch (type) {
        case 'bit': return 'bit';
        case 'char': case 'varchar': case 'nchar': case 'nvarchar': case 'sysname': case 'text': case 'ntext': case 'xml': return 'string';
        case 'uniqueidentifier': return 'guid';
        case 'datetime': case 'smalldatetime': case 'datetime2': return 'datetime';
        case 'date': return 'date';
        case 'time': return 'time';
        case 'datetimeoffset': return 'datetimeoffset';
        case 'binary': case 'varbinary': case 'image': return 'binary';
        default: return 'unsupported';
    }
}

module.exports = { describeColumn };
