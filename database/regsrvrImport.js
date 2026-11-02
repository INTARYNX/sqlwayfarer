/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

const { parseXml, childText, descendantText } = require('./miniXml');
const { parseServerAddress } = require('./serverAddress');
const { groupPath } = require('./connectionImport');

// === Reading a registered servers export (.regsrvr) ===
//
// SSMS exports its Registered Servers as an SML-IF document: one <document>
// per server and per group, flat, each server pointing at its group through a
// <Parent> reference whose URI is the path of the group:
//   /RegisteredServersStore/ServerGroup/DatabaseEngineServerGroup/ServerGroup/Production/ServerGroup/Europe
// (names percent-encoded). The elements are read whatever their namespace
// prefix; the password a connection string may carry is encrypted for the
// machine that exported it and is ignored.

const DATABASE_ENGINE_ROOT = /^DatabaseEngineServerGroup$/i;

// "data source=a;integrated security=True" -> { datasource: 'a', integratedsecurity: 'True' }.
// Keys are lower-cased with their spaces removed ("Trust Server Certificate" and
// "TrustServerCertificate" are one key).
function parseConnectionString(text) {
    const out = {};
    const re = /\s*([^=;]+?)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]*))\s*(?:;|$)/g;
    let match;
    while ((match = re.exec(text || ''))) {
        const value = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : (match[4] || '').trim();
        out[match[1].replace(/[\s_]+/g, '').toLowerCase()] = value;
    }
    return out;
}

const isTrue = value => /^(?:true|yes|sspi|mandatory|strict)$/i.test(String(value).trim());
const isFalse = value => /^(?:false|no|optional)$/i.test(String(value).trim());
const firstOf = (parts, ...keys) => { for (const key of keys) if (parts[key]) return parts[key]; return ''; };

// What the connection string (and the AuthenticationType SSMS keeps next to it:
// 0 Windows, 1 SQL login, above that Microsoft Entra ID) says about signing in.
function authFromConnectionString(parts, authenticationType) {
    const authentication = (parts.authentication || '').replace(/\s+/g, '').toLowerCase();
    const username = firstOf(parts, 'userid', 'uid', 'user');
    if (authentication.startsWith('activedirectory')) return { authType: 'entra' };
    if (authentication === 'sqlpassword') return { authType: 'sql', username };
    if (isTrue(firstOf(parts, 'integratedsecurity', 'trustedconnection'))) return { authType: 'windows' };
    if (username || authenticationType === 1) return { authType: 'sql', username };
    if (authenticationType >= 2) return { authType: 'entra' };
    return { authType: 'windows' };
}

// The group of a server from its <Parent> reference: ['Production', 'Europe'],
// [] for the root, null when the server is not a Database Engine one (Analysis
// Services, the "recent connections" group...).
function groupOfParent(server) {
    const uri = descendantText(server, 'Uri');
    if (!uri) return undefined;
    const segments = uri.split('/').filter(Boolean).map(part => { try { return decodeURIComponent(part); } catch { return part; } });
    const names = [];
    for (let i = 1; segments[i] === 'ServerGroup' && i + 1 < segments.length; i += 2) names.push(segments[i + 1]);
    if (names.length === 0) return undefined;
    return DATABASE_ENGINE_ROOT.test(names[0]) ? names.slice(1) : null;
}

function entryOf(server, path) {
    const parts = parseConnectionString(childText(server, 'ConnectionStringWithEncryptedPassword'));
    const rawAddress = childText(server, 'ServerName') || firstOf(parts, 'datasource', 'server', 'address', 'addr', 'networkaddress');
    const address = parseServerAddress(rawAddress);
    if (!address.server) return rawAddress ? { skipped: { name: childText(server, 'Name') || rawAddress, reason: `address '${rawAddress}' cannot be used` } } : null;
    const entry = Object.assign({
        name: childText(server, 'Name') || address.server,
        server: address.server,
        port: address.port,
        database: firstOf(parts, 'initialcatalog', 'database'),
        group: groupPath(path),
        description: childText(server, 'Description')
    }, authFromConnectionString(parts, Number(childText(server, 'AuthenticationType')) || 0));
    if (isTrue(parts.encrypt || '')) entry.encrypt = true;
    else if (isFalse(parts.encrypt || '')) entry.encrypt = false;
    if (isTrue(parts.trustservercertificate || '')) entry.trustServerCertificate = true;
    else if (isFalse(parts.trustservercertificate || '')) entry.trustServerCertificate = false;
    return entry;
}

// Built-in groups that are not the user's own Database Engine servers.
const OTHER_ROOT = /^(?:AnalysisServices|ReportingServices|IntegrationServices|SqlServerCompactEdition)ServerGroup$|^MruSqlConnectionsGroup$/i;

// Servers are found wherever they are: in the flat export each one carries its
// group in <Parent>; a file that nests them in their group is read that way.
function walk(node, path, out) {
    const name = node.name.toLowerCase();
    if (name === 'servergroup') {
        const groupName = childText(node, 'Name');
        if (OTHER_ROOT.test(groupName)) return;
        const inner = groupName && !DATABASE_ENGINE_ROOT.test(groupName) ? [...path, groupName] : path;
        for (const child of node.children) walk(child, inner, out);
        return;
    }
    if (name === 'registeredserver') {
        const type = childText(node, 'ServerType');
        const own = groupOfParent(node);
        if (own !== null && (!type || /^(?:DatabaseEngine|0)$/i.test(type))) {
            const entry = entryOf(node, own || path);
            if (entry && entry.skipped) out.skipped.push(entry.skipped);
            else if (entry) out.entries.push(entry);
        }
        return;
    }
    for (const child of node.children) walk(child, path, out);
}

// { entries: [{ name, server, port, database, group, description, authType, username?, encrypt?, trustServerCertificate? }],
//   skipped: [{ name, reason }] (an address that cannot be used), errors: [message] }
function parseRegisteredServersFile(text) {
    const result = { entries: [], errors: [], skipped: [] };
    let root;
    try {
        root = parseXml(text);
    } catch (error) {
        result.errors.push(`Not a registered servers file: ${error.message}`);
        return result;
    }
    walk(root, [], result);
    if (result.entries.length === 0 && result.skipped.length === 0) result.errors.push('No registered server found in the file.');
    return result;
}

module.exports = { parseRegisteredServersFile, parseConnectionString };
