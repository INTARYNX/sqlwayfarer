'use strict';

// Stable key for "the same connection", used to refuse opening it in two
// tabs at once and to scope per-connection state (query history, drafts).
// Deliberately server+port+login only, not the database: switching database
// doesn't open a new physical connection (see ConnectionManager), so two
// tabs differing only by starting database are still the same connection.
// Works the same whether the connection was saved or typed ad-hoc - both
// end up as a plain {server, port, username} shaped object by the time this
// runs (a saved connection's stored config, or the raw form input).
function connectionIdentity(config) {
    const server = (config && config.server || '').trim().toLowerCase();
    if (!server) return null;
    const port = config.port ? String(config.port).trim() : 'default';
    const user = (config.username || '').trim().toLowerCase() || '(windows auth)';
    return `${server}:${port}:${user}`;
}

module.exports = { connectionIdentity };
