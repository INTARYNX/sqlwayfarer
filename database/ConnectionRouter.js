/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// === Where the schema comes from ===
//
// A tab runs its queries on one connection (the "run" target, say a
// production server). The services that read the schema - objects, columns,
// the dependency index, comments, the dictionary, the footprint - go through
// this router instead, and can be pointed at ANOTHER connection (say a
// development copy of the same database) without any of them noticing: they
// keep calling the same methods, the router forwards to whichever connection
// is current. With no other source set, it is the run connection itself.

const FORWARDED = ['isConnected', 'getServerName', 'executeQuery', 'executeQueryInDatabase', 'acquireConnection', 'createRequest', 'getPool'];

class ConnectionRouter {
    constructor(primary) {
        this._primary = primary;
        this._source = null;
    }

    // Point the schema services at `manager` (null: back to the run connection).
    use(manager) {
        this._source = manager || null;
    }

    // Is the schema read from another connection than the one queries run on?
    isRouted() {
        return this._source !== null;
    }

    get current() {
        return this._source || this._primary;
    }
}

for (const name of FORWARDED) {
    ConnectionRouter.prototype[name] = function (...args) {
        return this.current[name](...args);
    };
}

module.exports = ConnectionRouter;
