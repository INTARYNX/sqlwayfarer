/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// === Progress messages for whoever debugs the extension ===
//
// What the extension host says while it works (an index built, a database
// read) is of use to a developer, not to a user: it prints only when the
// SQLWAYFARER_DEBUG environment variable is set. Warnings and errors still go
// to console.warn / console.error.

function debug(...args) {
    if (process.env.SQLWAYFARER_DEBUG) console.log(...args);
}

module.exports = debug;
