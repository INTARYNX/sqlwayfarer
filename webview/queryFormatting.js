/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// The part of the Query tool that turns a value or a result set into text: the
// value of a cell, CSV and JSON, the comparison used to sort. Mixed into
// QueryManager (see queryManager.js); the static methods become QueryManager's.
class QueryFormattingMethods {
    // === Formatting helpers ===

    // RFC 4180-style: quote fields containing the separator, quotes or newlines.
    // Used with '\t' for clipboard (pastes into Excel) and ',' for CSV export.
    static toDelimited(set, separator) {
        // Excel/LibreOffice/Sheets treat a cell starting with one of these as a
        // formula to evaluate on open - prefix with a literal quote (Excel's own
        // "force text" convention) so a result value like "=cmd|'/C calc'!A0"
        // never executes. Quoting the field for the separator/newline rule below
        // isn't enough on its own: Excel still evaluates a quoted leading '='.
        const FORMULA_LEADING_RE = /^[=+\-@\t\r]/;
        const escapeField = (value) => {
            let text;
            if (value === null || value === undefined) text = '';
            else if (value instanceof Date) text = value.toISOString();
            else if (typeof value === 'object') text = JSON.stringify(value);
            else text = String(value);
            if (FORMULA_LEADING_RE.test(text)) text = `'${text}`;
            if (text.includes(separator) || text.includes('"') || text.includes('\n') || text.includes('\r')) {
                text = `"${text.replace(/"/g, '""')}"`;
            }
            return text;
        };

        const types = QueryManager.typesByColumn(set);
        const lines = [set.columns.map(escapeField).join(separator)];
        for (const row of set.rows) {
            lines.push(set.columns.map(col => escapeField(QueryManager.narrowTemporal(row[col], types[col]))).join(separator));
        }
        return lines.join('\r\n');
    }

    // The rows as a JSON array of objects, keys in column order (a Date becomes
    // its ISO string, as JSON.stringify does).
    static toJson(set) {
        const types = QueryManager.typesByColumn(set);
        const rows = set.rows.map(row => {
            const out = {};
            for (const col of set.columns) out[col] = row[col] === undefined ? null : QueryManager.narrowTemporal(row[col], types[col]);
            return out;
        });
        return JSON.stringify(rows, null, 2);
    }

    // Collapse to one line and cap length, for a tooltip that stays readable.
    static truncate(text, maxLength) {
        const flat = text.replace(/\s+/g, ' ').trim();
        return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
    }

    formatDuration(ms) {
        if (typeof ms !== 'number') return '?';
        return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
    }

    // { column: type } of a result set, the type being { sql, kind, nullable } as the host
    // describes it (database/columnTypes.js).
    static typesByColumn(set) {
        const byColumn = {};
        (set.columns || []).forEach((col, i) => { if (set.types && set.types[i]) byColumn[col] = set.types[i]; });
        return byColumn;
    }

    // A date column arrives as a full datetime at midnight, a time column on 1970-01-01:
    // keep what the column holds. The seconds of a time(n) follow its scale (3 at most).
    static narrowTemporal(value, type) {
        if (!type || typeof value !== 'string' || !QueryManager.JSON_DATE_RE.test(value)) return value;
        if (type.kind === 'date') return value.slice(0, 10);
        if (type.kind !== 'time') return value;
        const scale = /\((\d)\)/.exec(type.sql || '');
        const digits = scale ? Math.min(Number(scale[1]), 3) : 3;
        return digits > 0 ? `${value.slice(11, 19)}.${value.slice(20, 20 + digits)}` : value.slice(11, 19);
    }

    // The order of two values of one column. A bigint (and any number the driver sends as
    // text) is compared as a number, not as text: "9" before "10".
    static compareValues(a, b, type) {
        if (type && type.kind === 'number' && (typeof a === 'string' || typeof b === 'string')) {
            const whole = /^-?\d+$/;
            if (whole.test(String(a)) && whole.test(String(b))) {
                const x = BigInt(a);
                const y = BigInt(b);
                return x === y ? 0 : (x < y ? -1 : 1);
            }
            const x = Number(a);
            const y = Number(b);
            if (!Number.isNaN(x) && !Number.isNaN(y)) return x === y ? 0 : (x < y ? -1 : 1);
        }
        return a < b ? -1 : 1;
    }

    formatValue(value, type) {
        if (value === null || value === undefined) return 'NULL';
        value = QueryManager.narrowTemporal(value, type);
        // SSMS-style "2008-04-30 00:00:00.000" instead of ISO 8601's
        // "2008-04-30T00:00:00.000Z" - same UTC instant (tedious already
        // returns datetime/datetime2 values as the exact stored wall-clock
        // value in UTC, not shifted), just reformatted for how it reads in
        // the grid. CSV/clipboard export (toDelimited) deliberately keeps
        // the unambiguous ISO form instead, for round-tripping into other tools.
        if (value instanceof Date) return value.toISOString().replace('T', ' ').replace('Z', '');
        // The extension host and the webview talk over JSON, so a datetime
        // arrives here as a *string* (JSON.stringify's Date form), never as
        // a Date object - the branch above can therefore never fire for a
        // result set, and the raw "2008-04-30T00:00:00.000Z" is what shows
        // up in the grid. Reformat that exact shape; JSON.stringify always
        // emits milliseconds and the 'Z' suffix, so the pattern is exact.
        if (typeof value === 'string' && QueryManager.JSON_DATE_RE.test(value)) {
            return value.replace('T', ' ').replace('Z', '');
        }
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = QueryFormattingMethods;
}
