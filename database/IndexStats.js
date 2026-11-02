/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// === Indexing statistics ===
//
// What an index build costs, measured, so that what is slow can be found and
// so that real figures (not guesses) can be given to people who wonder what
// building the index of a big database will cost them.
//
// A collector watches one build; finish() turns it into a plain, JSON-ready
// summary that is stored next to the index (see IndexService.getBuildStats).

const SLOWEST_COUNT = 10;
const MAX_RUNS = 20;

const now = () => Number(process.hrtime.bigint()) / 1e6;

function percentile(sortedValues, p) {
    if (sortedValues.length === 0) return 0;
    const rank = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
    return sortedValues[Math.max(0, rank)];
}

const round = value => Math.round(value * 10) / 10;

class IndexBuildStats {
    // mode: 'full' (no index yet), 'incremental' (only the changed objects) or
    // 'force' (the index was thrown away first).
    constructor(mode, concurrency) {
        this.mode = mode;
        this.concurrency = concurrency;
        this.startedAt = new Date().toISOString();
        this._t0 = now();
        this._phases = {};
        this._objects = [];
    }

    static now() { return now(); }

    // Time spent in a named phase of the build (listing, analysis, saving...).
    phase(name, ms) {
        this._phases[name] = round((this._phases[name] || 0) + ms);
    }

    // One analyzed object: the server round trip (dependencies + definition),
    // the parse of its definition (and the time it waited for a parser worker),
    // the scan of its text for dynamic-SQL names.
    recordObject(entry) {
        this._objects.push(entry);
    }

    finish({ totalObjects, reusedObjects = 0, removedObjects = 0 }) {
        const durationMs = round(now() - this._t0);
        const objects = this._objects;
        const totalMs = o => (o.queryMs || 0) + (o.parseMs || 0) + (o.queueMs || 0) + (o.scanMs || 0);
        const sum = key => round(objects.reduce((n, o) => n + (o[key] || 0), 0));
        const times = objects.map(totalMs).sort((a, b) => a - b);

        const byType = new Map();
        for (const o of objects) {
            const entry = byType.get(o.type) || { type: o.type, count: 0, totalMs: 0, maxMs: 0, chars: 0 };
            entry.count++;
            entry.totalMs += totalMs(o);
            entry.maxMs = Math.max(entry.maxMs, totalMs(o));
            entry.chars += o.definitionChars || 0;
            byType.set(o.type, entry);
        }

        const slowest = [...objects]
            .sort((a, b) => totalMs(b) - totalMs(a))
            .slice(0, SLOWEST_COUNT)
            .map(o => ({
                name: o.name, type: o.type, totalMs: round(totalMs(o)), queryMs: round(o.queryMs || 0),
                parseMs: round(o.parseMs || 0), queueMs: round(o.queueMs || 0), scanMs: round(o.scanMs || 0), definitionChars: o.definitionChars || 0,
                parseErrors: o.parseErrors || 0, depsFailed: !!o.depsFailed
            }));

        return {
            at: this.startedAt,
            mode: this.mode,
            durationMs,
            totalObjects,
            analyzedObjects: objects.length,
            reusedObjects,
            removedObjects,
            objectsPerSecond: durationMs > 0 ? round(objects.length / (durationMs / 1000)) : 0,
            concurrency: this.concurrency,
            phases: this._phases,
            // Sums over every object: with several objects in flight at once
            // they add up to more than the wall-clock duration.
            cumulative: { queryMs: sum('queryMs'), parseMs: sum('parseMs'), queueMs: sum('queueMs'), scanMs: sum('scanMs'), definitionChars: sum('definitionChars') },
            perObjectMs: { p50: round(percentile(times, 50)), p95: round(percentile(times, 95)), max: round(times.length ? times[times.length - 1] : 0) },
            byType: [...byType.values()]
                .map(t => ({ type: t.type, count: t.count, totalMs: round(t.totalMs), avgMs: round(t.totalMs / t.count), maxMs: round(t.maxMs), definitionChars: t.chars }))
                .sort((a, b) => b.totalMs - a.totalMs),
            slowest,
            problems: {
                dependencyQueryFailed: objects.filter(o => o.depsFailed).length,
                objectsWithParseErrors: objects.filter(o => o.parseErrors > 0).length
            }
        };
    }
}

// The stored history: the latest runs first, capped.
function addRun(history, run) {
    const runs = [run, ...((history && history.runs) || [])].slice(0, MAX_RUNS);
    return { runs };
}

// A Markdown report of a run, to paste in an issue or a README.
function toMarkdown(run, database) {
    if (!run) return '';
    const seconds = ms => `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s`;
    const lines = [];
    lines.push(`### SQL Wayfarer index build${database ? ` - ${database}` : ''}`);
    lines.push('');
    lines.push(`- Date: ${run.at}`);
    lines.push(`- Mode: ${run.mode}`);
    lines.push(`- Duration: ${seconds(run.durationMs)} for ${run.analyzedObjects} object(s) analyzed (${run.totalObjects} in the database, ${run.reusedObjects} reused), ${run.objectsPerSecond} objects/s`);
    lines.push(`- Concurrency: ${run.concurrency}`);
    lines.push(`- Per object: median ${run.perObjectMs.p50} ms, p95 ${run.perObjectMs.p95} ms, max ${run.perObjectMs.max} ms`);
    lines.push(`- Parser threads: ${run.parserThreads === undefined ? 'unknown' : run.parserThreads}`);
    lines.push(`- Cumulative: server ${seconds(run.cumulative.queryMs)}, parse ${seconds(run.cumulative.parseMs)}, waiting for a parser ${seconds(run.cumulative.queueMs || 0)}, text scan ${seconds(run.cumulative.scanMs)}, ${run.cumulative.definitionChars} characters of T-SQL`);
    lines.push('');
    lines.push('| Type | Objects | Total ms | Average ms | Max ms |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const t of run.byType) lines.push(`| ${t.type} | ${t.count} | ${t.totalMs} | ${t.avgMs} | ${t.maxMs} |`);
    return lines.join('\n');
}

module.exports = { IndexBuildStats, addRun, toMarkdown, MAX_RUNS };
