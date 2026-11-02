/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// === A result set as a temp table ===
//
// Scripts what the grid shows as CREATE TABLE #Results + INSERT ... VALUES, so
// a result can be kept, joined or edited. The column types come from the
// extension (see database/columnTypes.js: `types`, one { sql, kind, nullable }
// per column); the values arrive as the grid has them, which is JSON, so a
// datetime is an ISO string and a binary is { type: 'Buffer', data: [...] }.
// The pure logic is static so it can be unit-tested without a page.

class TempTableScript {
    // SQL Server takes at most 1000 rows in one VALUES list.
    static ROWS_PER_INSERT = 1000;

    static bracket(name) {
        return `[${String(name).replace(/\]/g, ']]')}]`;
    }

    static quote(text) {
        return `'${String(text).replace(/'/g, "''")}'`;
    }

    // One value as a T-SQL literal of the column kind. What does not look like
    // its kind is written as text, which SQL Server converts or refuses by itself.
    static literal(value, kind) {
        if (value === null || value === undefined || kind === 'unsupported') return 'NULL';
        if (kind === 'bit') return value === true || value === 1 || value === '1' || value === 'true' ? '1' : '0';
        if (kind === 'number') {
            if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
            if (/^-?\d+(\.\d+)?$/.test(String(value))) return String(value); // bigint arrives as a string
        }
        if (kind === 'binary') {
            if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
                return '0x' + value.data.map(b => (b & 255).toString(16).padStart(2, '0')).join('');
            }
        }
        if (typeof value === 'string') {
            // JSON.stringify's Date form: the exact stored value, in UTC.
            const iso = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z$/.exec(value);
            if (iso) {
                if (kind === 'date') return TempTableScript.quote(iso[1]);
                if (kind === 'time') return TempTableScript.quote(iso[2]);
                if (kind === 'datetime') return TempTableScript.quote(`${iso[1]}T${iso[2]}`);
                if (kind === 'datetimeoffset') return TempTableScript.quote(`${iso[1]}T${iso[2]}+00:00`);
            }
            return kind === 'guid' ? TempTableScript.quote(value) : 'N' + TempTableScript.quote(value);
        }
        return 'N' + TempTableScript.quote(typeof value === 'object' ? JSON.stringify(value) : value);
    }

    // set: { columns, rows, totalRows, types? }. A column without a type (an old
    // result) is typed from its values.
    static build(set, tableName = '#Results') {
        const columns = set.columns || [];
        const types = columns.map((col, i) => (set.types && set.types[i]) || TempTableScript.inferType(set.rows || [], col));
        const names = columns.map((col, i) => col === '' ? `Column${i + 1}` : col);
        const unsupported = names.filter((n, i) => types[i].kind === 'unsupported');

        const lines = [`-- Result set scripted as a temp table (${(set.rows || []).length} row(s)).`];
        if ((set.rows || []).length < set.totalRows) lines.push(`-- Only the first ${set.rows.length} of ${set.totalRows} rows were fetched (Max rows).`);
        if (unsupported.length) lines.push(`-- Not scripted, NULL instead: ${unsupported.map(TempTableScript.bracket).join(', ')} (type that has no literal).`);
        lines.push(`IF OBJECT_ID('tempdb..${tableName}') IS NOT NULL DROP TABLE ${tableName};`);
        lines.push(`CREATE TABLE ${tableName} (`);
        lines.push(names.map((n, i) => `    ${TempTableScript.bracket(n)} ${types[i].sql} ${types[i].nullable === false ? 'NOT NULL' : 'NULL'}`).join(',\n'));
        lines.push(');');

        const rows = set.rows || [];
        const list = names.map(TempTableScript.bracket).join(', ');
        // Own batches: in one batch with the DROP, SQL Server resolves the INSERT
        // against a #Results left by the previous run - with other columns it fails.
        lines.push('GO');
        for (let start = 0; start < rows.length; start += TempTableScript.ROWS_PER_INSERT) {
            lines.push('');
            lines.push(`INSERT INTO ${tableName} (${list}) VALUES`);
            const chunk = rows.slice(start, start + TempTableScript.ROWS_PER_INSERT);
            lines.push(chunk.map((row, r) => '(' + columns.map((col, i) => TempTableScript.literal(row[col], types[i].kind)).join(', ') + ')' + (r === chunk.length - 1 ? ';' : ',')).join('\n'));
        }
        lines.push('');
        lines.push('GO');
        lines.push(`SELECT * FROM ${tableName};`);
        return lines.join('\n') + '\n';
    }

    // Without metadata: what the values themselves say.
    static inferType(rows, column) {
        const values = rows.map(row => row[column]).filter(v => v !== null && v !== undefined);
        if (values.length && values.every(v => typeof v === 'boolean')) return { sql: 'bit', kind: 'bit', nullable: true };
        if (values.length && values.every(v => typeof v === 'number')) {
            return values.every(Number.isInteger) ? { sql: 'bigint', kind: 'number', nullable: true } : { sql: 'float', kind: 'number', nullable: true };
        }
        return { sql: 'nvarchar(max)', kind: 'string', nullable: true };
    }

    // The name of the temp table for the n-th result set (0-based).
    static tableName(index) {
        return index === 0 ? '#Results' : `#Results${index + 1}`;
    }
}

// Allow unit tests to require() this file; in the webview `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TempTableScript;
}
