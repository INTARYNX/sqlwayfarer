'use strict';

const { bracketIdentifier, escapeLiteral } = require('./sqlIdentifier');

// === SQL Server database snapshots, as the reference of a comparison ===
//
// A snapshot is a read-only, point-in-time copy of a database on the same
// instance (copy-on-write: it only grows as the source changes). Its catalog
// is the schema as it was when it was taken, so it is read with the same
// queries as any database. Nothing here takes a snapshot by itself: planSnapshot
// says what would be run, and the caller shows it before createSnapshot.

const MAX_NAME_LENGTH = 128;
const SYSTEM_DATABASE_MAX_ID = 4;

// The engine editions that are Azure SQL Database, Synapse and Managed Instance.
const NO_SNAPSHOT_ENGINES = { 5: 'Azure SQL Database', 6: 'Azure Synapse', 8: 'Azure SQL Managed Instance' };

const pad = (n, width = 2) => String(n).padStart(width, '0');

// <database>_ref_<yyyymmdd>_<hhmmss>, cut in the database part when it would be too long.
function snapshotName(database, now, taken = new Set()) {
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const suffix = `_ref_${stamp}`;
    const base = String(database).slice(0, MAX_NAME_LENGTH - suffix.length - 4);
    const lowerTaken = new Set([...taken].map(n => n.toLowerCase()));
    let name = `${base}${suffix}`;
    for (let i = 2; lowerTaken.has(name.toLowerCase()); i++) name = `${base}${suffix}_${i}`;
    return name;
}

// Where the sparse file of a data file goes: next to it, named after the snapshot.
function sparsePath(physicalName, name, logicalName) {
    const separator = physicalName.includes('\\') ? '\\' : '/';
    const directory = physicalName.slice(0, physicalName.lastIndexOf(separator) + 1);
    const file = `${name}_${logicalName}`.replace(/[\\/:*?"<>|]/g, '_');
    return `${directory}${file}.ss`;
}

function buildCreateSnapshot(name, source, files) {
    const list = files.map(f => `    (NAME = N'${escapeLiteral(f.logicalName)}', FILENAME = N'${escapeLiteral(f.path)}')`).join(',\n');
    return `CREATE DATABASE ${bracketIdentifier(name)} ON\n${list}\nAS SNAPSHOT OF ${bracketIdentifier(source)};`;
}

// Whether a snapshot of this database can be taken, and if not, why. The server
// has the last word: this is to say it in plain words before it fails.
function evaluateSupport(row) {
    if (!row || row.database_id === undefined || row.database_id === null) return { supported: false, reason: 'The database does not exist.' };
    if (NO_SNAPSHOT_ENGINES[row.engine]) return { supported: false, reason: `${NO_SNAPSHOT_ENGINES[row.engine]} does not have database snapshots.` };
    if (row.database_id <= SYSTEM_DATABASE_MAX_ID) return { supported: false, reason: 'A snapshot cannot be taken of a system database.' };
    if (row.source_database_id !== null && row.source_database_id !== undefined) return { supported: false, reason: 'This database is a snapshot already.' };
    if (row.state_desc !== 'ONLINE') return { supported: false, reason: `The database is ${String(row.state_desc).toLowerCase()}; it has to be online.` };
    if (Number(row.filestream_files) > 0) return { supported: false, reason: 'A database with FILESTREAM or memory-optimized data cannot have a snapshot.' };
    const major = parseInt(String(row.version).split('.')[0], 10);
    // Enterprise, Developer and Evaluation (engine 3) always; the other editions since SQL Server 2016 SP1.
    if (row.engine !== 3 && major < 13) return { supported: false, reason: 'Before SQL Server 2016 SP1, snapshots need the Enterprise edition.' };
    return { supported: true };
}

async function getSnapshotSupport(connectionManager, database) {
    const result = await connectionManager.executeQueryInDatabase('master', `
        SELECT CAST(SERVERPROPERTY('EngineEdition') AS int) AS engine,
               CAST(SERVERPROPERTY('ProductVersion') AS varchar(32)) AS version,
               d.database_id, d.source_database_id, d.state_desc,
               (SELECT COUNT(*) FROM sys.master_files f WHERE f.database_id = d.database_id AND f.type = 2) AS filestream_files
        FROM sys.databases d WHERE d.name = @name`, { name: database });
    const row = result.recordset[0];
    return evaluateSupport(row ? row : { engine: 0 });
}

// The snapshots, newest first - of one database, or of all.
async function listSnapshots(connectionManager, sourceDatabase = null) {
    const result = await connectionManager.executeQueryInDatabase('master', `
        SELECT d.name, src.name AS source, d.create_date, d.state_desc
        FROM sys.databases d
        JOIN sys.databases src ON src.database_id = d.source_database_id
        WHERE d.source_database_id IS NOT NULL AND (@source IS NULL OR src.name = @source)
        ORDER BY d.create_date DESC, d.name`, { source: sourceDatabase });
    return result.recordset.map(r => ({ name: r.name, source: r.source, createDate: r.create_date, state: r.state_desc }));
}

// The databases a comparison can take as its reference: the user databases that are not snapshots.
async function listComparableDatabases(connectionManager, exclude = null) {
    const result = await connectionManager.executeQueryInDatabase('master', `
        SELECT name FROM sys.databases
        WHERE database_id > ${SYSTEM_DATABASE_MAX_ID} AND source_database_id IS NULL AND state_desc = 'ONLINE' AND (@exclude IS NULL OR name <> @exclude)
        ORDER BY name`, { exclude });
    return result.recordset.map(r => r.name);
}

// What taking a snapshot would run: its name, its files, the statement.
async function planSnapshot(connectionManager, database, now = new Date()) {
    const support = await getSnapshotSupport(connectionManager, database);
    if (!support.supported) throw new Error(support.reason);

    const taken = (await connectionManager.executeQueryInDatabase('master', 'SELECT name FROM sys.databases')).recordset.map(r => r.name);
    const name = snapshotName(database, now, new Set(taken));
    const rows = (await connectionManager.executeQueryInDatabase('master', `
        SELECT f.name, f.physical_name FROM sys.master_files f
        WHERE f.database_id = DB_ID(@name) AND f.type = 0 ORDER BY f.file_id`, { name: database })).recordset;
    if (rows.length === 0) throw new Error('The data files of the database could not be read.');

    const files = rows.map(r => ({ logicalName: r.name, path: sparsePath(r.physical_name, name, r.name) }));
    return { database, name, files, sql: buildCreateSnapshot(name, database, files) };
}

async function createSnapshot(connectionManager, plan) {
    await connectionManager.executeQueryInDatabase('master', plan.sql);
    return plan.name;
}

// Drops a snapshot - and nothing else: a database that is not a snapshot is refused.
async function dropSnapshot(connectionManager, name) {
    const found = (await listSnapshots(connectionManager)).find(s => s.name.toLowerCase() === String(name).toLowerCase());
    if (!found) throw new Error(`${name} is not a database snapshot, it is not dropped.`);
    try {
        await connectionManager.executeQueryInDatabase('master', `DROP DATABASE ${bracketIdentifier(found.name)}`);
    } catch (error) {
        // 3702: a session is still in it.
        if (error && error.number === 3702) throw new Error(`${found.name} is in use by a connection; close it, then drop the snapshot again.`);
        throw error;
    }
}

module.exports = { listComparableDatabases, snapshotName, sparsePath, buildCreateSnapshot, evaluateSupport, getSnapshotSupport, listSnapshots, planSnapshot, createSnapshot, dropSnapshot };
