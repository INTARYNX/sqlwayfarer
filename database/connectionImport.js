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
    const config = {
        name,
        useConnectionString: false,
        authType: entry.authType || 'windows',
        server: entry.server,
        port: entry.port || '',
        database: entry.database || '',
        username: entry.authType === 'sql' ? entry.username || '' : '',
        encrypt: entry.encrypt !== undefined ? entry.encrypt : entry.authType === 'entra',
        trustServerCertificate: entry.trustServerCertificate !== undefined ? entry.trustServerCertificate : true
    };
    if (entry.group) config.group = entry.group;
    return config;
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
        const config = toSavedConnection(entry, names[index]);
        const sameName = byName.get(config.name.toLowerCase()) || null;
        if (sameName) config.name = sameName.name;
        const twin = existing.find(c => sameTarget(c, config)) || null;
        return { entry, config, sameName: sameName ? sameName.name : null, sameTarget: !sameName && twin ? twin.name : null };
    });
}

module.exports = { planConnectionImport, toSavedConnection, uniqueNames, sameTarget };
