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

module.exports = { planDataTables, supportsDataCompare, keyOf, baseTypeName };
