'use strict';

// Recognises, from the text of an error, that the connection to the server is
// gone (as opposed to the server refusing a statement). Drivers do not agree on
// a shape for it - tedious (mssql), System.Data.SqlClient (the Windows
// authentication helper) and Node's sockets each say it their own way - so the
// text is what there is. Deliberately conservative: a false alarm shows a
// "Reconnect" bar for nothing, and an ordinary SQL error must never do that.
const LOSS_PATTERNS = [
    /\bECONNRESET\b/i,
    /\bECONNCLOSED\b/i,
    /\bESOCKET\b/i,
    /\bEPIPE\b/i,
    /\bENOTOPEN\b/i,
    /connection (?:is |was |has been )?(?:closed|lost|reset|terminated|broken)/i,
    /socket (?:hang up|closed|was closed)/i,
    // tedious, once its connection died
    /requests can only be made in the \w+ state/i,
    // System.Data.SqlClient
    /transport-level error/i,
    /connection is broken and recovery is not possible/i,
    /a network-related or instance-specific error/i,
    // the Windows authentication helper (database/SspiPool.js)
    /authentication helper (?:stopped unexpectedly|is not running)/i
];

function isConnectionLostMessage(text) {
    if (typeof text !== 'string' || text === '') return false;
    return LOSS_PATTERNS.some(pattern => pattern.test(text));
}

module.exports = { isConnectionLostMessage };
