'use strict';

const path = require('path');
const os = require('os');
const Piscina = require('piscina');
const BabelfishSqlParser = require('./BabelfishSqlParser');

// How many consecutive pool failures (worker crash, timeout, spawn failure...)
// before we stop trying the pool for the rest of the session and parse
// in-process instead. A single flaky run shouldn't degrade a whole reindex -
// IndexService analyzes CONCURRENT_BATCH_SIZE (8) objects in parallel, so one
// transient blip can fail several calls at once; the threshold is set above
// that concurrency so a single bad batch can never trip it on its own, only
// genuinely sustained failures across more than one batch can.
const MAX_CONSECUTIVE_FAILURES = 10;

// Parses T-SQL definitions for column lineage and table-level writes across
// a small pool of worker threads, so the CPU-bound ANTLR parse doesn't
// serialize on the extension host's single main thread. Falls back to
// in-process parsing if the pool can't be used for any reason.
//
// Two costs, and they are not the same one:
//  - the FIRST parse of a process builds ANTLR's decision caches, which takes
//    about a second and a half. Every worker pays it once, on its own heap:
//    the first indexing of a database waits for it, and the caches are held
//    once per worker.
//  - a parse with the caches warm takes a few milliseconds on a small
//    definition, up to about half a second on a big one.
class ParserWorkerPool {
    constructor() {
        this._piscina = null;
        this._consecutiveFailures = 0;
        this._fallbackParser = null;
        this._disposed = false;
    }

    _ensurePool() {
        if (this._disposed) return null;
        if (this._piscina || this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return this._piscina;
        try {
            // Reserve a core for the extension host; modest cap because each
            // worker loads the generated ANTLR parser tables into its own heap.
            const threads = Math.max(1, Math.min(4, os.cpus().length - 1));
            this._piscina = new Piscina({
                filename: path.join(__dirname, 'parseColumnsWorker.js'),
                // All the workers stay alive: Piscina ends the idle ones above
                // minThreads at once, and a new worker starts cold (its parser tables
                // and caches are built again, seconds each) - the indexing hands its
                // objects over in batches, so a worker went idle between every two.
                minThreads: threads,
                maxThreads: threads
            });
        } catch (error) {
            console.warn('[ParserWorkerPool] Failed to create worker pool, falling back to in-process parsing:', error.message);
            this._consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
        }
        return this._piscina;
    }

    // How many parser threads run (0 once parsing fell back to the extension host).
    threadCount() {
        return this._piscina ? this._piscina.options.maxThreads : 0;
    }

    _parseInProcess(definition) {
        if (!this._fallbackParser) {
            this._fallbackParser = new BabelfishSqlParser();
            this._fallbackParser.setEnabled(true);
        }
        return this._fallbackParser.analyzeDefinition(definition);
    }

    // Full analysis of a definition: { columns, writes }.
    async analyzeDefinition(definition) {
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
        this._disposed = true;
        if (this._piscina) {
            await this._piscina.destroy().catch(() => {});
            this._piscina = null;
        }
    }
}

module.exports = ParserWorkerPool;
ParserWorkerPool.MAX_CONSECUTIVE_FAILURES = MAX_CONSECUTIVE_FAILURES;
