'use strict';

// piscina task file: runs in a worker thread. One parser instance per worker,
// reused across jobs — analyzeDefinition is a pure function of its input, so
// this is safe (see BabelfishSqlParser.js), and reuse avoids rebuilding the
// ANTLR lexer/parser classes' shared DFA caches on every call.
//
// The worker returns the full analysis of a definition in one parse: the
// column-level lineage AND the table-level writes.
const BabelfishSqlParser = require('./BabelfishSqlParser');

const parser = new BabelfishSqlParser();
parser.setEnabled(true);

// The time the parse itself took in this worker (parseTimeMs): the caller
// only sees the total wait, which also holds the time spent in the queue.
module.exports = function parseDefinition(definition) {
    const start = process.hrtime.bigint();
    const analysis = parser.analyzeDefinition(definition);
    if (analysis) analysis.parseTimeMs = Number(process.hrtime.bigint() - start) / 1e6;
    return analysis;
};
