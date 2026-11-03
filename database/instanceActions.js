'use strict';

const { bracketIdentifier, escapeLiteral } = require('./sqlIdentifier');

// What the instance tree can do to an object: the exact SQL of each action,
// built here so it can be shown to the user before it runs.

const DROP_KEYWORD = { Table: 'TABLE', View: 'VIEW', Procedure: 'PROCEDURE', Function: 'FUNCTION' };

function isActionableType(objectType) {
    return Object.prototype.hasOwnProperty.call(DROP_KEYWORD, objectType);
}

function qualified(schema, name) {
    return `${bracketIdentifier(schema)}.${bracketIdentifier(name)}`;
}

function buildDrop(objectType, schema, name) {
    if (!isActionableType(objectType)) throw new Error(`Unsupported object type '${objectType}'.`);
    return `DROP ${DROP_KEYWORD[objectType]} ${qualified(schema, name)};`;
}

// sp_rename takes the old name as a (bracketed) string and the new one bare:
// the schema is not part of it.
function buildRename(objectType, schema, name, newName) {
    if (!isActionableType(objectType)) throw new Error(`Unsupported object type '${objectType}'.`);
    return `EXEC sp_rename N'${escapeLiteral(qualified(schema, name))}', N'${escapeLiteral(newName)}', N'OBJECT';`;
}

// null when the name is acceptable, otherwise what is wrong with it.
function validateNewName(newName, currentName) {
    const name = String(newName == null ? '' : newName);
    if (name.trim() === '') return 'The name cannot be empty.';
    if (name !== name.trim()) return 'The name cannot start or end with a space.';
    if (name.length > 128) return 'The name is limited to 128 characters.';
    if (name.includes('.')) return 'The schema cannot be changed here, and a name cannot contain a dot.';
    if (name === currentName) return 'This is already the name.';
    return null;
}

// The objects of the same database that refer to this one. Cross-database
// references are not listed by SQL Server.
async function getDependents(connectionManager, database, schema, name) {
    const result = await connectionManager.executeQueryInDatabase(database, `
        SELECT referencing_schema_name + '.' + referencing_entity_name AS name
        FROM sys.dm_sql_referencing_entities(@name, 'OBJECT')
        ORDER BY 1`, { name: qualified(schema, name) });
    return result.recordset.map(row => row.name);
}

module.exports = { isActionableType, buildDrop, buildRename, validateNewName, getDependents };
