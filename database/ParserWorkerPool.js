'use strict';

const path = require('path');
const os = require('os');
const Piscina = require('piscina');
const BabelfishSqlParser = require('./BabelfishSqlParser');

// How many consecutive pool failures (worker crash, timeout, spawn failure...)
// before we stop trying the pool for the rest of the session and parse
// in-process instead. A single flaky run shouldn't degrade a whole reindex.
const MAX_CONSECUTIVE_FAILURES = 3;

// Parses T-SQL definitions for column lineage across a small pool of worker
// threads, so the CPU-bound ANTLR parse (40-550ms per object) doesn't
// serialize on the extension host's single main thread. Falls back to
// in-process parsing if the pool can't be used for any reason.
class ParserWorkerPool {
    constructor() {
        this._piscina = null;
        this._consecutiveFailures = 0;
        this._fallbackParser = null;
    }

    _ensurePool() {
        if (this._piscina || this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return this._piscina;
        try {
            this._piscina = new Piscina({
                filename: path.join(__dirname, 'parseColumnsWorker.js'),
                // Reserve a core for the extension host; modest cap because each
                // worker loads the generated ANTLR parser tables into its own heap.
                maxThreads: Math.max(1, Math.min(4, os.cpus().length - 1))
            });
        } catch (error) {
            console.warn('[ParserWorkerPool] Failed to create worker pool, falling back to in-process parsing:', error.message);
            this._consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
        }
        return this._piscina;
    }

    _parseInProcess(definition) {
        if (!this._fallbackParser) {
            this._fallbackParser = new BabelfishSqlParser();
            this._fallbackParser.setEnabled(true);
        }
        return this._fallbackParser.analyzeColumns(definition);
    }

    async analyzeColumns(definition) {
        const pool = this._ensurePool();
        if (!pool) return this._parseInProcess(definition);

        try {
            const result = await pool.run(definition);
            this._consecutiveFailures = 0;
            return result;
        } catch (error) {
            this._consecutiveFailures++;
            console.warn(`[ParserWorkerPool] Worker parse failed (${this._consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, error.message);
            if (this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                console.warn('[ParserWorkerPool] Too many failures, disabling the pool for this session; parsing in-process from now on.');
                await pool.destroy().catch(() => {});
                this._piscina = null;
            }
            return this._parseInProcess(definition);
        }
    }

    async dispose() {
        if (this._piscina) {
            await this._piscina.destroy().catch(() => {});
            this._piscina = null;
        }
    }
}

module.exports = ParserWorkerPool;
