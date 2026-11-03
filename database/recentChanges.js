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

function query(minutes) {
    return `DECLARE @since datetime = DATEADD(MINUTE, -${minutes}, GETDATE());
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
SELECT CONVERT(varchar(19), GETDATE(), 120) AS server_time`;
}

// The objects created or altered in the last `minutes`, the newest first.
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

async function readRecentChanges(connectionManager, database, minutes) {
    const span = Math.floor(Number(minutes));
    if (!Number.isFinite(span) || span < 1 || span > MAX_MINUTES) throw new Error('The period is not valid.');
    // A connection of its own, put back in master: a pooled connection stays in the database it was used in.
    const conn = await connectionManager.acquireConnection();
    try {
        const sets = (await conn.createRequest().batch(`USE ${bracketIdentifier(database)};\n${query(span)}`)).recordsets;
        const rows = sets[0];
        return {
            database, minutes: span,
            serverTime: sets[1] && sets[1][0] ? sets[1][0].server_time : null,
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
