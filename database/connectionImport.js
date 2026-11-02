/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// === Importing connections ===
//
// Turns what a CMS or a registered servers file lists into saved connections,
// and says beforehand which ones are already saved. A CMS lists no login: SSMS
// connects to its servers with the Windows account, so does the import unless
// the entry says otherwise. No password is ever imported.

// A group path: the names joined with '/'. A '/' inside a name would pass for
// a level, so it becomes the look-alike '∕'.
function groupPath(names) {
    return names.map(name => String(name).replace(/\//g, '∕')).join('/');
}

// Azure hosts only take encrypted connections, with a certificate that is valid.
const AZURE_HOST = /\.(?:database\.windows\.net|database\.usgovcloudapi\.net|database\.chinacloudapi\.cn|database\.cloudapi\.de|sql\.azuresynapse\.net)$/i;

// The name a saved connection gets. Two entries with one name (the same name
// in two groups) are told apart by their group, then by a number.
function uniqueNames(entries) {
    const taken = new Set();
    const counts = new Map();
    for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) || 0) + 1);
    return entries.map(entry => {
        let name = entry.name;
        if (counts.get(entry.name) > 1 && entry.group) name = `${entry.name} (${entry.group})`;
        let candidate = name;
        for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} (${n})`;
        taken.add(candidate.toLowerCase());
        return candidate;
    });
}

// The saved-connection shape of an entry.
function toSavedConnection(entry, name) {
    const azure = AZURE_HOST.test(String(entry.server).split(/[\\,]/)[0]);
    const config = {
        name,
        useConnectionString: false,
        authType: entry.authType || 'windows',
        server: entry.server,
        port: entry.port || '',
        database: entry.database || '',
        username: entry.authType === 'sql' ? entry.username || '' : '',
        // Not said: what the form starts with, except for hosts that require encryption.
        encrypt: entry.encrypt !== undefined ? entry.encrypt : entry.authType === 'entra' || azure,
        trustServerCertificate: entry.trustServerCertificate !== undefined ? entry.trustServerCertificate : !azure
    };
    if (entry.group) config.group = entry.group;
    return config;
}

// An entry over a connection of the same name: the server, the port and the
// group are the entry's; what it does not say (login, database, encryption, the
// way of signing in) stays as the user saved it, and so does the password.
function mergeIntoExisting(existing, entry) {
    const merged = Object.assign({}, existing);
    delete merged.password;
    if (entry.group) merged.group = entry.group;
    if (existing.useConnectionString) return merged;
    merged.server = entry.server;
    merged.port = entry.port || '';
    if (entry.authType) {
        merged.authType = entry.authType;
        merged.username = entry.authType === 'sql' ? entry.username || existing.username || '' : '';
    }
    if (entry.database) merged.database = entry.database;
    if (entry.encrypt !== undefined) merged.encrypt = entry.encrypt;
    if (entry.trustServerCertificate !== undefined) merged.trustServerCertificate = entry.trustServerCertificate;
    return merged;
}

const sameTarget = (a, b) => (a.server || '').toLowerCase() === (b.server || '').toLowerCase()
    && String(a.port || '') === String(b.port || '')
    && (a.database || '').toLowerCase() === (b.database || '').toLowerCase()
    && (a.authType || 'sql') === (b.authType || 'sql');

// Each entry with the connection it would save, and whether that is already
// there: `sameName` (it would overwrite) or `sameTarget` (another connection
// already reaches that server the same way).
function planConnectionImport(existing, entries) {
    const names = uniqueNames(entries);
    const byName = new Map(existing.map(c => [c.name.toLowerCase(), c]));
    return entries.map((entry, index) => {
        let config = toSavedConnection(entry, names[index]);
        const sameName = byName.get(config.name.toLowerCase()) || null;
        if (sameName) config = mergeIntoExisting(sameName, entry);
        const twin = existing.find(c => sameTarget(c, config)) || null;
        return { entry, config, sameName: sameName ? sameName.name : null, sameTarget: !sameName && twin ? twin.name : null };
    });
}

module.exports = { planConnectionImport, toSavedConnection, mergeIntoExisting, groupPath, uniqueNames, sameTarget };
