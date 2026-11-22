'use strict';

// === Data compare: which tables, with what key, and in what order ===
//
// planDataTables(reference, current) looks at the two schema models already
// read by schemaCatalog.readSchemaModel() and says, for every table that
// exists on both sides, the key its rows are matched by and the columns
// whose value is actually compared - pure, no connection, like diffModels()
// in schemaDiff.js. compareTableData() (next commit) does the actual
// reading, row by row, for one table that came out of this plan.

const lower = text => String(text).toLowerCase();
const fullName = t => `${t.schema}.${t.name}`;

// Types a row is never meaningfully compared on: always changing
// (rowversion/timestamp), or not writable back as a plain literal (spatial,
// XML, sql_variant, CLR). Computed columns are a view of other columns, not
// data of their own.
const EXCLUDED_TYPES = new Set(['timestamp', 'rowversion', 'xml', 'geometry', 'geography', 'hierarchyid', 'sql_variant']);

function baseTypeName(type) {
    const match = /^[a-z_]+/i.exec(String(type).trim());
    return (match ? match[0] : String(type)).toLowerCase();
}

// The primary key if there is one, else the first unique constraint whose
// columns are all NOT NULL (a nullable unique column can hold several NULLs,
// so it cannot tell rows apart on its own).
function keyOf(table) {
    if (table.primaryKey) return table.primaryKey;
    return table.uniques.find(unique => unique.columns.every(keyColumn => {
        const column = table.columns.find(c => lower(c.name) === lower(keyColumn.name));
        return column && !column.nullable;
    })) || null;
}

// Tables in an order where a table another one points to with a foreign key
// comes first, so writing rows in this order (and deleting in the reverse)
// never trips a constraint. A cycle breaks arbitrarily, in the order the
// tables came - same shape as orderModules() in migrationScript.js.
function orderByForeignKey(tables) {
    const indexOf = new Map(tables.map((t, i) => [lower(fullName(t)), i]));
    const waitingFor = tables.map((table, i) => {
        const found = new Set();
        for (const fk of table.foreignKeys || []) {
            const j = indexOf.get(lower(`${fk.refSchema}.${fk.refTable}`));
            if (j !== undefined && j !== i) found.add(j);
        }
        return found;
    });
    const dependents = tables.map(() => []);
    waitingFor.forEach((set, i) => set.forEach(j => dependents[j].push(i)));
    const missing = waitingFor.map(set => set.size);

    const ordered = [];
    const queued = new Array(tables.length).fill(false);
    const queue = [];
    const push = i => { queued[i] = true; queue.push(i); };
    missing.forEach((count, i) => { if (count === 0) push(i); });
    for (let head = 0; ordered.length < tables.length;) {
        if (head >= queue.length) push(queued.indexOf(false));
        const i = queue[head++];
        ordered.push(tables[i]);
        for (const dependent of dependents[i]) {
            if (!queued[dependent] && --missing[dependent] === 0) push(dependent);
        }
    }
    return ordered;
}

// Why a column of a table that is otherwise comparable is left out of the
// comparison - said, never silently dropped.
function excludeReason(column, { onOtherSide, isKey }) {
    if (!onOtherSide) return 'Not on both sides of the comparison.';
    if (column.computed) return 'Computed column: a view of other columns, not data of its own.';
    if (column.identity && !isKey) return 'Identity column outside the key: a new value is assigned by the server.';
    const type = baseTypeName(column.type);
    if (EXCLUDED_TYPES.has(type)) return `Type ${type} is not compared.`;
    return null;
}

function planTable(refTable, curTable) {
    const name = fullName(curTable);
    const tableKey = keyOf(curTable);
    if (!tableKey) return { notComparable: { schema: curTable.schema, name: curTable.name, reason: 'No primary key, and no unique key whose columns are all NOT NULL.' } };

    const refColumns = new Map(refTable.columns.map(c => [lower(c.name), c]));
    const keyNames = new Set(tableKey.columns.map(c => lower(c.name)));
    const columns = [];
    const excludedColumns = [];
    for (const column of curTable.columns) {
        const isKey = keyNames.has(lower(column.name));
        const reason = excludeReason(column, { onOtherSide: refColumns.has(lower(column.name)), isKey });
        if (reason) excludedColumns.push({ name: column.name, reason });
        else columns.push(column.name);
    }
    for (const column of refTable.columns) {
        if (!curTable.columns.some(c => lower(c.name) === lower(column.name))) excludedColumns.push({ name: column.name, reason: 'Not on both sides of the comparison.' });
    }
    if (columns.length <= keyNames.size) return { notComparable: { schema: curTable.schema, name: curTable.name, reason: 'No column besides the key can be compared.' } };

    return {
        comparable: {
            schema: curTable.schema, name: curTable.name,
            key: tableKey.columns.map(c => c.name),
            columns, excludedColumns,
            columnTypes: Object.fromEntries(columns.map(name => [name, curTable.columns.find(c => c.name === name).type])),
            identityColumn: (curTable.columns.find(c => c.identity && columns.includes(c.name)) || {}).name || null
        }
    };
}

function planDataTables(reference, current) {
    const refByKey = new Map(Object.values(reference.tables).map(t => [lower(fullName(t)), t]));
    const curByKey = new Map(Object.values(current.tables).map(t => [lower(fullName(t)), t]));

    const onlyInReference = [...refByKey.keys()].filter(key => !curByKey.has(key)).map(key => fullName(refByKey.get(key))).sort();
    const onlyInCurrent = [...curByKey.keys()].filter(key => !refByKey.has(key)).map(key => fullName(curByKey.get(key))).sort();

    const common = orderByForeignKey([...curByKey.values()].filter(t => refByKey.has(lower(fullName(t)))));
    const comparable = [];
    const notComparable = [];
    for (const curTable of common) {
        const { comparable: ok, notComparable: bad } = planTable(refByKey.get(lower(fullName(curTable))), curTable);
        if (ok) comparable.push(ok);
        else notComparable.push(bad);
    }
    notComparable.sort((a, b) => fullName(a).localeCompare(fullName(b)));

    return { comparable, notComparable, onlyInReference, onlyInCurrent };
}

// The first SQL Server with FOR JSON, which the row-hash query needs: 2016 RTM.
function supportsDataCompare(version) {
    const [major, , build] = String(version || '').split('.').map(n => parseInt(n, 10));
    return major > 13 || (major === 13 && (build || 0) >= 1601);
}

// === Reading the rows of one table, on both sides ===
//
// compareTableData() does the hashing pass (one row per table on each side:
// its key and a hash of its other columns, from FOR JSON so no type needs
// its own handling) then, only for the keys that differ, a second pass that
// reads the full row. A table with a huge number of differences is capped
// (MAX_DIFF_ROWS_PER_TABLE): the counts stay exact, the rows fetched do not.

const { bracketIdentifier } = require('./sqlIdentifier');
const { sqlLiteral } = require('./sqlLiteral');

const FETCH_CHUNK = 500;
const MAX_DIFF_ROWS_PER_TABLE = 5000;
const q = bracketIdentifier;
const keyString = values => JSON.stringify(values);

function isEqualValue(a, b) {
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
    return a === b;
}

async function hashRows(conn, database, table) {
    const nonKey = table.columns.filter(c => !table.key.includes(c));
    const sql = `USE ${q(database)};\n`
        + `SELECT ${table.key.map(c => q(c)).join(', ')}, `
        + `HASHBYTES('SHA2_256', CAST((SELECT ${nonKey.map(c => `t.${q(c)}`).join(', ')} FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES) AS NVARCHAR(MAX))) AS [__hash]\n`
        + `FROM ${q(table.schema)}.${q(table.name)} AS t;`;
    const { recordsets } = await conn.createRequest().batch(sql);
    const hashes = new Map();
    for (const row of recordsets[0]) {
        const key = table.key.map(c => row[c]);
        hashes.set(keyString(key), { key, hash: row.__hash ? row.__hash.toString('hex') : '' });
    }
    return hashes;
}

// The predicate that finds exactly the given keys - IN(...) for a single
// column, OR'd tuples for a composite one. keys: an array of key-value
// arrays, in table.key order.
function keyPredicate(table, keys) {
    if (table.key.length === 1) {
        const [col] = table.key;
        return `${q(col)} IN (${keys.map(k => sqlLiteral(k[0], table.columnTypes[col])).join(', ')})`;
    }
    return keys.map(k => `(${table.key.map((col, i) => `${q(col)} = ${sqlLiteral(k[i], table.columnTypes[col])}`).join(' AND ')})`).join(' OR ');
}

async function fetchRows(conn, database, table, keys) {
    const rows = new Map();
    const selectList = table.columns.map(q).join(', ');
    for (let i = 0; i < keys.length; i += FETCH_CHUNK) {
        const chunk = keys.slice(i, i + FETCH_CHUNK);
        const sql = `USE ${q(database)};\nSELECT ${selectList} FROM ${q(table.schema)}.${q(table.name)} WHERE ${keyPredicate(table, chunk)};`;
        const { recordsets } = await conn.createRequest().batch(sql);
        for (const row of recordsets[0]) rows.set(keyString(table.key.map(c => row[c])), row);
    }
    return rows;
}

// Keeps only the first `max` keys overall, counting added before modified
// before removed - what gets left out when a table has too many differences.
function capAt(buckets, max) {
    let remaining = max;
    const capped = {};
    for (const [name, keys] of Object.entries(buckets)) {
        capped[name] = keys.slice(0, remaining);
        remaining = Math.max(0, remaining - keys.length);
    }
    return capped;
}

async function compareTableData(connectionManager, { reference, database, table }) {
    const conn = await connectionManager.acquireConnection();
    try {
        const refHashes = await hashRows(conn, reference, table);
        const curHashes = await hashRows(conn, database, table);

        const added = [];
        const modified = [];
        for (const [key, cur] of curHashes) {
            const ref = refHashes.get(key);
            if (!ref) added.push(cur.key);
            else if (ref.hash !== cur.hash) modified.push(cur.key);
        }
        const removed = [...refHashes.keys()].filter(key => !curHashes.has(key)).map(key => refHashes.get(key).key);

        const counts = { added: added.length, modified: modified.length, removed: removed.length, same: curHashes.size - added.length - modified.length };
        const truncated = (added.length + modified.length + removed.length) > MAX_DIFF_ROWS_PER_TABLE;
        const capped = capAt({ added, modified, removed }, MAX_DIFF_ROWS_PER_TABLE);

        const afterRows = await fetchRows(conn, database, table, [...capped.added, ...capped.modified]);
        const beforeRows = await fetchRows(conn, reference, table, [...capped.removed, ...capped.modified]);

        return {
            schema: table.schema, name: table.name, counts, truncated,
            added: capped.added.map(key => afterRows.get(keyString(key))).filter(Boolean),
            removed: capped.removed.map(key => beforeRows.get(keyString(key))).filter(Boolean),
            modified: capped.modified.map(key => {
                const before = beforeRows.get(keyString(key));
                const after = afterRows.get(keyString(key));
                if (!before || !after) return null;
                return { key, before, after, changedColumns: table.columns.filter(c => !isEqualValue(before[c], after[c])) };
            }).filter(Boolean)
        };
    } finally {
        try { await conn.createRequest().batch('USE [master];'); } catch { /* the connection is gone */ }
        conn.release();
    }
}

module.exports = { planDataTables, supportsDataCompare, compareTableData, keyOf, baseTypeName, keyPredicate };
