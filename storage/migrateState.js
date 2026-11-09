'use strict';

// Reads `key` from `state`. When it has no value there, the one `legacy` holds
// (where the key used to live) is moved over to `state`, once: the query
// history and the drafts used to be kept per folder (workspaceState) and are
// now kept globally.
function readMigrating(state, legacy, key, fallback) {
    const value = state.get(key);
    if (value !== undefined) return value;
    const old = legacy ? legacy.get(key) : undefined;
    if (old === undefined) return fallback;
    Promise.resolve(state.update(key, old))
        .then(() => legacy.update(key, undefined))
        .catch(() => {});
    return old;
}

module.exports = { readMigrating };
