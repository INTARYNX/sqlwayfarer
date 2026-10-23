'use strict';

// piscina task file: runs in a worker thread. One parser instance per worker,
// reused across jobs — analyzeColumns is a pure function of its input, so this
// is safe (see BabelfishSqlParser.js), and reuse avoids rebuilding the ANTLR
// lexer/parser classes' shared DFA caches on every call.
const BabelfishSqlParser = require('./BabelfishSqlParser');

const parser = new BabelfishSqlParser();
parser.setEnabled(true);

module.exports = function parseColumns(definition) {
    return parser.analyzeColumns(definition);
};
