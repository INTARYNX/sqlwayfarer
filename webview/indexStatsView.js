/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// The "Stats" view of the Index window: what the last builds of the index
// cost, where the time went, and which objects were the slowest. Pure: it
// turns the recorded history (see database/IndexStats.js) into HTML.
class IndexStatsView {
    static escape(value) {
        return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // 12 345 ms -> "12.3 s"; below a second, in ms.
    static duration(ms) {
        if (ms >= 60000) return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
        if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s`;
        return `${Math.round(ms)} ms`;
    }

    static number(n) {
        return Number(n).toLocaleString('en-US').replace(/,/g, ' ');
    }

    // A share of a whole as a horizontal bar, with its label.
    static bar(label, value, whole, detail) {
        const pct = whole > 0 ? Math.max(0, Math.min(100, (value / whole) * 100)) : 0;
        return `<div class="stats-bar-row"><span class="stats-bar-label">${IndexStatsView.escape(label)}</span>`
            + `<span class="stats-bar"><span class="stats-bar-fill" style="width:${pct.toFixed(1)}%"></span></span>`
            + `<span class="stats-bar-value">${IndexStatsView.escape(detail)} <small>${pct.toFixed(0)}%</small></span></div>`;
    }

    static html(history) {
        const runs = (history && history.runs) || [];
        if (runs.length === 0) {
            return '<p class="placeholder-text">No build recorded yet. The cost of every build or update of the index is recorded here, so you can see where the time goes.</p>';
        }
        const e = IndexStatsView.escape;
        const d = IndexStatsView.duration;
        const n = IndexStatsView.number;
        const run = runs[0];
        const modeLabel = { full: 'Full build', incremental: 'Update (changed objects only)', force: 'Force reindex' }[run.mode] || run.mode;

        const card = (label, value, hint) => `<div class="stats-card"><div class="stats-card-value">${e(value)}</div>`
            + `<div class="stats-card-label">${e(label)}</div>${hint ? `<div class="stats-card-hint">${e(hint)}</div>` : ''}</div>`;

        let html = '<div class="stats-toolbar">'
            + `<span class="stats-when">Last build: ${e(new Date(run.at).toLocaleString())} — ${e(modeLabel)}</span>`
            + '<button data-index-stats-action="copy" title="Copy a Markdown report of the last build"><i class="codicon codicon-copy"></i> Copy report</button></div>';

        html += '<div class="stats-cards">'
            + card('Duration', d(run.durationMs))
            + card('Objects analyzed', `${n(run.analyzedObjects)} / ${n(run.totalObjects)}`, run.reusedObjects ? `${n(run.reusedObjects)} reused` : '')
            + card('Throughput', `${run.objectsPerSecond} obj/s`, `${run.concurrency} at a time`)
            + card('Per object', `${run.perObjectMs.p50} ms`, `p95 ${run.perObjectMs.p95} ms · max ${run.perObjectMs.max} ms`)
            + '</div>';

        // Where the time went.
        const phases = run.phases || {};
        const phaseRows = [['Reading the object list', phases.listObjectsMs], ['Analyzing the objects', phases.analysisMs], ['Saving the index', phases.saveMs]]
            .filter(([, ms]) => ms !== undefined);
        html += '<h4>Where the time went</h4><div class="stats-bars">'
            + phaseRows.map(([label, ms]) => IndexStatsView.bar(label, ms, run.durationMs, d(ms))).join('') + '</div>';

        const cum = run.cumulative || {};
        const cumTotal = (cum.queryMs || 0) + (cum.parseMs || 0) + (cum.queueMs || 0) + (cum.scanMs || 0);
        html += '<h4>Inside the analysis</h4><p class="stats-note">Summed over all objects (several are analyzed at once, so these add up to more than the duration).</p><div class="stats-bars">'
            + IndexStatsView.bar('Server (dependencies + definition)', cum.queryMs || 0, cumTotal, d(cum.queryMs || 0))
            + IndexStatsView.bar('T-SQL parser', cum.parseMs || 0, cumTotal, d(cum.parseMs || 0))
            + IndexStatsView.bar('Waiting for a parser thread', cum.queueMs || 0, cumTotal, d(cum.queueMs || 0))
            + IndexStatsView.bar('Text scan (dynamic SQL names)', cum.scanMs || 0, cumTotal, d(cum.scanMs || 0))
            + `</div><p class="stats-note">${n(cum.definitionChars || 0)} characters of T-SQL parsed${run.parserThreads ? `, on ${run.parserThreads} parser thread(s)` : ''}.</p>`;

        if (run.problems && (run.problems.dependencyQueryFailed || run.problems.objectsWithParseErrors)) {
            html += `<p class="stats-problems"><i class="codicon codicon-warning"></i> ${n(run.problems.objectsWithParseErrors)} object(s) with syntax the parser could not fully read, ${n(run.problems.dependencyQueryFailed)} object(s) whose dependencies the server could not report.</p>`;
        }

        // By type.
        if (run.byType && run.byType.length) {
            html += '<h4>By type</h4><table class="stats-table"><thead><tr><th>Type</th><th>Objects</th><th>Total</th><th>Average</th><th>Max</th></tr></thead><tbody>'
                + run.byType.map(t => `<tr><td>${e(t.type)}</td><td>${n(t.count)}</td><td>${d(t.totalMs)}</td><td>${t.avgMs} ms</td><td>${t.maxMs} ms</td></tr>`).join('')
                + '</tbody></table>';
        }

        // Slowest.
        if (run.slowest && run.slowest.length) {
            html += '<h4>Slowest objects</h4><table class="stats-table"><thead><tr><th>Object</th><th>Type</th><th>Total</th><th>Server</th><th>Parser</th><th>Queue</th><th>Scan</th><th>Size</th></tr></thead><tbody>'
                + run.slowest.map(o => `<tr><td>${e(o.name)}</td><td>${e(o.type)}</td><td>${o.totalMs} ms</td><td>${o.queryMs} ms</td><td>${o.parseMs} ms</td><td>${o.queueMs || 0} ms</td><td>${o.scanMs} ms</td>`
                    + `<td>${o.definitionChars ? `${n(o.definitionChars)} chars` : ''}</td></tr>`).join('')
                + '</tbody></table>';
        }

        // History.
        if (runs.length > 1) {
            html += '<h4>Previous builds</h4><table class="stats-table"><thead><tr><th>Date</th><th>Mode</th><th>Duration</th><th>Analyzed</th><th>Objects/s</th></tr></thead><tbody>'
                + runs.map(r => `<tr><td>${e(new Date(r.at).toLocaleString())}</td><td>${e(r.mode)}</td><td>${d(r.durationMs)}</td><td>${n(r.analyzedObjects)} / ${n(r.totalObjects)}</td><td>${r.objectsPerSecond}</td></tr>`).join('')
                + '</tbody></table>';
        }
        return html;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = IndexStatsView;
}
