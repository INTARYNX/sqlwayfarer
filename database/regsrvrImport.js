/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

const { parseXml, childText } = require('./miniXml');
const { parseServerAddress } = require('./serverAddress');

// === Reading a registered servers export (.regsrvr) ===
//
// SSMS exports its local Registered Servers as XML: nested server groups, each
// holding registered servers with a name, an address and a connection string.
// The names are read whatever their namespace prefix; the passwords the file
// may carry are encrypted for the machine that exported it and are ignored.

const DATABASE_ENGINE_ROOT = /^DatabaseEngineServerGroup$/i;
const OTHER_ROOT = /^(?:AnalysisServices|ReportingServices|IntegrationServices|SqlServerCompactEdition)ServerGroup$/i;

// "data source=a;integrated security=True" -> { 'data source': 'a', ... } (keys lower-cased).
function parseConnectionString(text) {
    const out = {};
    const re = /\s*([^=;]+?)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]*))\s*(?:;|$)/g;
    let match;
    while ((match = re.exec(text || ''))) {
        const value = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : (match[4] || '').trim();
        out[match[1].trim().toLowerCase()] = value;
    }
    return out;
}

const isTrue = value => /^(?:true|yes|sspi|mandatory|strict)$/i.test(String(value).trim());
const isFalse = value => /^(?:false|no|optional)$/i.test(String(value).trim());

// What the connection string says about signing in, in the extension's terms.
function authFromConnectionString(parts) {
    const authentication = (parts.authentication || '').replace(/\s+/g, '').toLowerCase();
    if (authentication.startsWith('activedirectory')) return { authType: 'entra' };
    if (authentication === 'sqlpassword') return { authType: 'sql', username: parts['user id'] || parts.uid || parts.user || '' };
    if (isTrue(parts['integrated security'] || parts['trusted_connection'] || '')) return { authType: 'windows' };
    const username = parts['user id'] || parts.uid || parts.user || '';
    if (username) return { authType: 'sql', username };
    return { authType: 'windows' };
}

function entryOf(server, groupPath) {
    const name = childText(server, 'Name');
    const parts = parseConnectionString(childText(server, 'ConnectionStringWithEncryptedPassword'));
    const address = parseServerAddress(childText(server, 'ServerName') || parts['data source'] || parts.server || parts.address || parts.addr || parts['network address'] || '');
    if (!address.server) return null;
    const entry = Object.assign({
        name: name || address.server,
        server: address.server,
        port: address.port,
        database: parts['initial catalog'] || parts.database || '',
        group: groupPath.join('/'),
        description: childText(server, 'Description')
    }, authFromConnectionString(parts));
    if (isTrue(parts.encrypt || '')) entry.encrypt = true;
    else if (isFalse(parts.encrypt || '')) entry.encrypt = false;
    if (isTrue(parts.trustservercertificate || '')) entry.trustServerCertificate = true;
    else if (isFalse(parts.trustservercertificate || '')) entry.trustServerCertificate = false;
    return entry;
}

function walk(node, groupPath, out) {
    const name = node.name.toLowerCase();
    if (name === 'servergroup') {
        const groupName = childText(node, 'Name');
        if (OTHER_ROOT.test(groupName)) return;
        const path = groupName && !DATABASE_ENGINE_ROOT.test(groupName) ? [...groupPath, groupName] : groupPath;
        for (const child of node.children) walk(child, path, out);
        return;
    }
    if (name === 'registeredserver') {
        const type = childText(node, 'ServerType');
        if (!type || /^(?:DatabaseEngine|0)$/i.test(type)) {
            const entry = entryOf(node, groupPath);
            if (entry) out.push(entry);
        }
        return;
    }
    for (const child of node.children) walk(child, groupPath, out);
}

// { entries: [{ name, server, port, database, group, description, authType, username?, encrypt?, trustServerCertificate? }], errors: [message] }
function parseRegisteredServersFile(text) {
    const result = { entries: [], errors: [] };
    let root;
    try {
        root = parseXml(text);
    } catch (error) {
        result.errors.push(`Not a registered servers file: ${error.message}`);
        return result;
    }
    walk(root, [], result.entries);
    if (result.entries.length === 0) result.errors.push('No registered server found in the file.');
    return result;
}

module.exports = { parseRegisteredServersFile, parseConnectionString };
