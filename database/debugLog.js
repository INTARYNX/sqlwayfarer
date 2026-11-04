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

// Where the messages go. The console of the extension host cannot be replaced
// by a test - its console.log is a getter that ignores the assignments - so
// the test replaces this instead.
let sink = (...args) => console.log(...args);

function debug(...args) {
    if (process.env.SQLWAYFARER_DEBUG) sink(...args);
}

// Takes the place of the console. Returns the previous sink, so the caller
// can give it back.
function setSink(fn) {
    const previous = sink;
    sink = fn;
    return previous;
}

module.exports = debug;
module.exports.setSink = setSink;
