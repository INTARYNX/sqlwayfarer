'use strict';

const { bracketIdentifier, escapeLiteral } = require('./sqlIdentifier');

// === What was touched in a database lately ===
//
// From the dates the server keeps on every object (sys.objects.create_date and
// modify_date): no snapshot needed, nothing to have thought of beforehand. What
// the dates cannot say: what was dropped, and what happened to the data. A
// change to a table's structure, constraints or indexes moves the date of the
// table (checked on SQL Server 2022); constraints also have a date of their own.
// The ages are worked out by the server, so the clock and the time zone of the
// machine that reads do not matter.

const MAX_ITEMS = 5000;
const MAX_MINUTES = 60 * 24 * 365;

const KINDS = {
    U: 'table', V: 'view', P: 'procedure', FN: 'function', IF: 'function', TF: 'function', TR: 'trigger',
    PK: 'constraint', UQ: 'constraint', F: 'constraint', C: 'constraint', D: 'constraint', SN: 'synonym', SO: 'sequence'
};
const TYPE_CODES = Object.keys(KINDS).map(code => `'${code}'`).join(', ');

// `since` is the start of the period, as the SQL that gives it: the last
// minutes, or the moment a snapshot of the database was taken (read from the
// server itself, so its clock and its time zone are the ones of the dates compared).
function sinceMinutes(minutes) {
    return `DATEADD(MINUTE, -${minutes}, GETDATE())`;
}

function sinceSnapshot(database, snapshot) {
    const literal = text => `N'${String(text).replace(/'/g, "''")}'`;
    return `(SELECT create_date FROM sys.databases WHERE name = ${literal(snapshot)} AND source_database_id = DB_ID(${literal(database)}))`;
}

function query(since) {
    return `DECLARE @since datetime = ${since};
IF @since IS NULL THROW 50000, N'That snapshot is not there any more.', 1;
SELECT TOP (${MAX_ITEMS + 1}) s.name AS schema_name, o.name AS object_name, o.type AS type_code,
       CONVERT(varchar(19), o.create_date, 120) AS created, CONVERT(varchar(19), o.modify_date, 120) AS modified,
       DATEDIFF(SECOND, o.create_date, GETDATE()) AS created_age, DATEDIFF(SECOND, o.modify_date, GETDATE()) AS modified_age,
       CASE WHEN o.modify_date > o.create_date THEN 1 ELSE 0 END AS is_altered,
       CASE WHEN o.create_date >= @since THEN 1 ELSE 0 END AS created_in_period,
       ps.name AS parent_schema, po.name AS parent_name
FROM sys.objects o
JOIN sys.schemas s ON s.schema_id = o.schema_id
LEFT JOIN sys.objects po ON po.object_id = o.parent_object_id
LEFT JOIN sys.schemas ps ON ps.schema_id = po.schema_id
WHERE o.is_ms_shipped = 0 AND o.type IN (${TYPE_CODES}) AND (o.modify_date >= @since OR o.create_date >= @since)
ORDER BY o.modify_date DESC, o.name;
SELECT CONVERT(varchar(19), GETDATE(), 120) AS server_time, CONVERT(varchar(19), @since, 120) AS since`;
}

// The objects created or altered in a period, the newest first.
function buildItems(rows) {
    return rows.filter(r => KINDS[String(r.type_code).trim()]).map(r => ({
        kind: KINDS[String(r.type_code).trim()],
        schema: r.schema_name,
        name: r.object_name,
        // Never altered since it was created, or altered (the date of an object that is created is its creation date).
        status: Number(r.is_altered) === 1 ? 'altered' : 'new',
        createdInPeriod: Number(r.created_in_period) === 1,
        created: r.created,
        modified: r.modified,
        createdAge: Number(r.created_age),
        modifiedAge: Number(r.modified_age),
        parent: r.parent_name ? `${r.parent_schema}.${r.parent_name}` : null
    }));
}

// The period is the last `minutes`, or, with a `snapshot` of the database, what
// came after it was taken.
async function readRecentChanges(connectionManager, database, minutes, snapshot = null) {
    let since;
    let span = null;
    if (snapshot) {
        since = sinceSnapshot(database, snapshot);
    } else {
        span = Math.floor(Number(minutes));
        if (!Number.isFinite(span) || span < 1 || span > MAX_MINUTES) throw new Error('The period is not valid.');
        since = sinceMinutes(span);
    }
    // A connection of its own, put back in master: a pooled connection stays in the database it was used in.
    const conn = await connectionManager.acquireConnection();
    try {
        const sets = (await conn.createRequest().batch(`USE ${bracketIdentifier(database)};\n${query(since)}`)).recordsets;
        const rows = sets[0];
        return {
            database, minutes: span, snapshot: snapshot || null,
            serverTime: sets[1] && sets[1][0] ? sets[1][0].server_time : null,
            since: sets[1] && sets[1][0] ? sets[1][0].since : null,
            items: buildItems(rows.slice(0, MAX_ITEMS)),
            truncated: rows.length > MAX_ITEMS
        };
    } finally {
        try { await conn.createRequest().batch('USE [master]'); } catch { /* the connection is gone, or USE is not allowed there */ }
        conn.release();
    }
}

// The code of a view, procedure, function or trigger; null for anything else, and
// for what is encrypted or cannot be read.
async function readDefinition(connectionManager, database, schema, name) {
    const conn = await connectionManager.acquireConnection();
    try {
        const qualified = `${bracketIdentifier(schema)}.${bracketIdentifier(name)}`;
        const sets = (await conn.createRequest().batch(`USE ${bracketIdentifier(database)};\nSELECT OBJECT_DEFINITION(OBJECT_ID(N'${escapeLiteral(qualified)}')) AS definition`)).recordsets;
        const definition = sets[0] && sets[0][0] ? sets[0][0].definition : null;
        return definition === undefined ? null : definition;
    } finally {
        try { await conn.createRequest().batch('USE [master]'); } catch { /* the connection is gone */ }
        conn.release();
    }
}

module.exports = { readRecentChanges, readDefinition, buildItems, KINDS, MAX_ITEMS };
