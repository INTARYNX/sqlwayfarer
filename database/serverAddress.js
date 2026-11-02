/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// === Server addresses as SSMS writes them ===
//
// A registered server is "host", "host\instance", "host,1433" or
// "tcp:host,1433". The extension keeps the port apart (the driver also takes
// "host\instance" as it is), so the address is split here.

function parseServerAddress(text) {
    let value = String(text || '').trim().replace(/^(?:tcp|np|lpc):/i, '');
    let port = '';
    const comma = value.lastIndexOf(',');
    if (comma !== -1) {
        const candidate = value.slice(comma + 1).trim();
        if (/^\d{1,5}$/.test(candidate)) {
            port = candidate;
            value = value.slice(0, comma).trim();
        }
    }
    return { server: value, port };
}

module.exports = { parseServerAddress };
