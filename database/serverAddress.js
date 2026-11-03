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

// A named pipe (np:\\host\pipe\..., \\host\pipe\...) is not something the driver connects to: the server comes back empty.
function parseServerAddress(text) {
    if (/^\s*(?:np:|\\\\)/i.test(String(text || ''))) return { server: '', port: '' };
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

// What the Node driver can resolve. SSMS writes the local machine as "." or
// "(local)" ("." + "\\SQLEXPRESS" for an instance), and an IPv6 address in
// brackets; the driver looks them up as host names and fails.
function serverForDriver(server) {
    const text = String(server || '').trim();
    const local = /^(?:\.|\(local\))(\\.*)?$/i.exec(text);
    if (local) return `localhost${local[1] || ''}`;
    const ipv6 = /^\[([^\]]+)\](.*)$/.exec(text);
    if (ipv6) return `${ipv6[1]}${ipv6[2]}`;
    return text;
}

module.exports = { parseServerAddress, serverForDriver };
