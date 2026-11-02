/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

const { parseServerAddress } = require('./serverAddress');

// === Reading a Central Management Server ===
//
// A CMS is a SQL Server whose msdb keeps the registered servers and their
// groups. Reading them takes two queries (the ServerGroupReaderRole role of
// msdb is enough); the groups form a tree through parent_id, whose built-in
// roots (DatabaseEngineServerGroup...) are not part of a group's name.

const GROUPS_SQL = `SELECT server_group_id, parent_id, name, is_system_object
FROM msdb.dbo.sysmanagement_shared_server_groups
WHERE server_type = 0`;

const SERVERS_SQL = `SELECT server_group_id, name, server_name, description
FROM msdb.dbo.sysmanagement_shared_registered_servers
WHERE server_type = 0`;

const MAX_DEPTH = 64;

// Pure: the rows of both queries to [{ name, server, port, group, description }].
function buildCmsEntries(groupRows, serverRows) {
    const byId = new Map(groupRows.map(g => [g.server_group_id, g]));
    const pathOf = id => {
        const names = [];
        let group = byId.get(id);
        for (let depth = 0; group && depth < MAX_DEPTH; depth++) {
            if (!group.is_system_object) names.unshift(group.name);
            group = byId.get(group.parent_id);
        }
        return names.join('/');
    };
    const entries = [];
    for (const row of serverRows) {
        const address = parseServerAddress(row.server_name);
        if (!address.server) continue;
        entries.push({
            name: (row.name || '').trim() || address.server,
            server: address.server,
            port: address.port,
            group: pathOf(row.server_group_id),
            description: row.description || ''
        });
    }
    return entries;
}

// manager: a connected ConnectionManager (or anything with executeQuery).
async function readCmsServers(manager) {
    const groups = (await manager.executeQuery(GROUPS_SQL)).recordset || [];
    const servers = (await manager.executeQuery(SERVERS_SQL)).recordset || [];
    return buildCmsEntries(groups, servers);
}

module.exports = { readCmsServers, buildCmsEntries, GROUPS_SQL, SERVERS_SQL };
