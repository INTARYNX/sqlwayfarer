'use strict';

const { escapeLiteral } = require('./sqlIdentifier');

// === A JS value (as the `mssql` driver returns it) as a T-SQL literal ===
//
// Used by the data-compare script builder (dataScript.js) to write the
// VALUES of a MERGE and the key predicate of a DELETE. sqlType is the
// column's T-SQL type name (its length/precision, if any, is ignored: only
// the base name decides how the value is written).
//
// Dates: the `mssql` driver returns a plain JS Date, which only has
// millisecond resolution - a datetime2(7)/datetimeoffset(7) column that
// truly uses its 100ns precision loses it here. CONVERT(..., 127) is used so
// the literal round-trips exactly what the Date holds, whatever the column's
// own scale.

const N = text => `N'${escapeLiteral(text)}'`;

function baseType(sqlType) {
    const match = /^[a-z_]+[0-9]*/i.exec(String(sqlType).trim());
    return (match ? match[0] : String(sqlType)).toLowerCase();
}

// Style 127 (ISO 8601) is accepted by CONVERT for all of these; datetimeoffset
// needs the offset suffix, the others don't (and have none to give).
const DATETIME_TYPES = new Set(['date', 'time', 'smalldatetime', 'datetime', 'datetime2', 'datetimeoffset']);

function dateLiteral(value, type) {
    const iso = value.toISOString(); // e.g. 2024-01-01T13:30:05.123Z
    const text = type === 'datetimeoffset' ? `${iso.slice(0, -1)}+00:00` : iso.slice(0, -1);
    return `CONVERT(${type}, ${N(text)}, 127)`;
}

function sqlLiteral(value, sqlType) {
    if (value === null || value === undefined) return 'NULL';
    if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
    if (value instanceof Date) {
        const type = baseType(sqlType);
        return dateLiteral(value, DATETIME_TYPES.has(type) ? type : 'datetime2');
    }
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
    return N(String(value));
}

module.exports = { sqlLiteral };
