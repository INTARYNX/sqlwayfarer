'use strict';

const WriteFootprintService = require('./WriteFootprintService');

// Finds tables related to a given set (a query's or a footprint's tables),
// for the Schema tab's "Expand" action and the per-table "Add adjacent
// tables" context-menu item - never shown by default, only on request. Two
// signals:
//   - FK neighbors: an actual foreign key to/from a table not yet in the
//     set. This is real adjacency, so it alone is followed hop by hop, up
//     to a chosen depth (see expand).
//   - Usage neighbors: tables other stored procedures/views/functions
//     commonly touch alongside the set's tables, mined from the already-
//     cached dependency index (sys.sql_expression_dependencies) - the same
//     data DependencyService's own referencedBy already reads, so no new
//     parsing and no new round trip. This is the signal that matters most
//     in a legacy, FK-less database: the real relationship only exists in
//     how the code actually uses the tables together. It is not a
//     relationship between exactly two tables the way an FK is, so it is
//     found once, relative to the tables asked about, never chased hop by
//     hop, and never drawn as an edge on the Schema tab - only the table
//     itself shows, with its own "used together" style.
//
// Both are best-effort: a dependency behind dynamic SQL is invisible to
// sys.sql_expression_dependencies, same limit the rest of the dependency
// analysis already has.
class RelatedTablesService {
    constructor(indexService, databaseService) {
        this._indexService = indexService;
        this._databaseService = databaseService;
    }

    // Live entry point: pulls the cached index (no reindex) and the
    // whole-database FK list, then delegates to the pure analysis.
    async relatedTables(database, tableNames, depth = 1) {
        const index = await this._indexService.peekIndex(database);
        const allFks = await this._databaseService.getForeignKeys(database);
        const fkNeighbors = RelatedTablesService.expand(allFks, tableNames, depth);
        const usageNeighbors = index ? RelatedTablesService.usageNeighbors(index, tableNames) : [];
        return RelatedTablesService.merge(fkNeighbors, usageNeighbors);
    }

    // BFS over foreignKeyNeighbors only - real adjacency, so it alone makes
    // sense to chase hop by hop: hop 1 is the direct FK neighbors of
    // `tableNames`, hop 2 the FK neighbors of whatever hop 1 found that
    // isn't already in the set, and so on up to `depth` hops. Stops early
    // once a hop finds nothing new.
    static expand(foreignKeys, tableNames, depth) {
        const clean = RelatedTablesService._clean;
        const seen = new Set((tableNames || []).map(clean));
        let frontier = tableNames || [];
        const found = [];
        for (let hop = 0; hop < Math.max(1, depth || 1) && frontier.length; hop++) {
            const neighbors = RelatedTablesService.foreignKeyNeighbors(foreignKeys, frontier)
                .filter(n => !seen.has(clean(n.qualifiedName)));
            if (neighbors.length === 0) break;
            for (const n of neighbors) seen.add(clean(n.qualifiedName));
            found.push(...neighbors);
            frontier = neighbors.map(n => n.qualifiedName);
        }
        return found;
    }

    // Every FK edge whose both ends are in `tableNames`, whatever the roles
    // of those tables (seed, FK neighbor, usage neighbor, manually added) -
    // for the Schema tab to redraw the full, exact set of FK edges among
    // whatever it currently shows, once a table was added by hand (see
    // "Add table" - adding one can reveal an FK to *any* table already on
    // screen, not just to the query's own tables).
    async relationshipsAmong(database, tableNames) {
        const allFks = await this._databaseService.getForeignKeys(database);
        return WriteFootprintService.foreignKeysAmong(allFks, (tableNames || []).map(qualifiedName => ({ qualifiedName })));
    }

    static _clean(name) {
        return (name || '').replace(/\[|\]/g, '').toLowerCase();
    }

    // One-hop FK neighbors of `tableNames` - a table with exactly one end of
    // the FK in the set (both ends in the set is already shown as a normal
    // relationship; neither end in the set is unrelated).
    static foreignKeyNeighbors(foreignKeys, tableNames) {
        const clean = RelatedTablesService._clean;
        const inSet = new Set((tableNames || []).map(clean));
        const seen = new Set();
        const neighbors = [];
        for (const fk of foreignKeys || []) {
            const fromIn = inSet.has(clean(fk.fromTable));
            const toIn = inSet.has(clean(fk.toTable));
            if (fromIn === toIn) continue;
            const neighborName = fromIn ? fk.toTable : fk.fromTable;
            const key = clean(neighborName);
            if (seen.has(key)) continue;
            seen.add(key);
            // Our table holds the FK (fromIn): the neighbor is the referenced
            // parent. Our table is referenced (toIn): the neighbor holds its
            // own FK pointing at us, so it is the child. anchorTable is which
            // of our own tables this FK touches, for the client to draw the edge.
            neighbors.push({
                qualifiedName: neighborName, via: 'fk', fkName: fk.fkName,
                direction: fromIn ? 'parent' : 'child', anchorTable: fromIn ? fk.fromTable : fk.toTable
            });
        }
        return neighbors;
    }

    // Tables other objects (procedures/views/functions/triggers) commonly
    // touch alongside `tableNames`, ranked by how many distinct objects do.
    static usageNeighbors(index, tableNames) {
        if (!index || !index.objects) return [];
        const clean = RelatedTablesService._clean;
        // Resolves a dependency string back to one of our own `tableNames`
        // (qualified, then bare-name fallback), or null if it isn't one.
        const seedByClean = new Map((tableNames || []).map(n => [clean(n), n]));
        const seedByBare = new Map((tableNames || []).map(n => [clean(n).split('.').pop(), n]));
        const matchSeed = (dep) => {
            const c = clean(dep);
            return seedByClean.get(c) || seedByBare.get(c.split('.').pop()) || null;
        };

        // A dependency is just a name string (see IndexService's index entry
        // shape); resolve it back to the object it names, the same
        // qualified-then-bare fallback DependencyService's own lookup uses.
        const byClean = new Map();
        for (const obj of Object.values(index.objects)) byClean.set(clean(obj.qualifiedName), obj);
        const resolve = (dep) => byClean.get(clean(dep)) || byClean.get(clean(dep).split('.').pop());

        // qualifiedName(lower) -> { qualifiedName, objects: Set, anchorCounts: Map(seedTable -> count) }
        const counts = new Map();
        for (const obj of Object.values(index.objects)) {
            const deps = obj.dependencies || [];
            // Which of our own tables does this object actually touch? A
            // neighbor found here is "used together" with one of these, not
            // with an arbitrary table of the whole input set.
            const touchedSeeds = new Set();
            for (const dep of deps) { const seed = matchSeed(dep); if (seed) touchedSeeds.add(seed); }
            if (touchedSeeds.size === 0) continue;
            for (const dep of deps) {
                if (matchSeed(dep)) continue; // the set's own tables, not a neighbor
                const target = resolve(dep);
                if (!target || target.type !== 'U') continue; // tables only
                const key = clean(target.qualifiedName);
                if (!counts.has(key)) counts.set(key, { qualifiedName: target.qualifiedName, objects: new Set(), anchorCounts: new Map() });
                const entry = counts.get(key);
                entry.objects.add(obj.qualifiedName || obj.name);
                for (const seed of touchedSeeds) entry.anchorCounts.set(seed, (entry.anchorCounts.get(seed) || 0) + 1);
            }
        }
        return [...counts.values()]
            .map(e => {
                // Anchor on whichever of our tables co-occurs with this
                // neighbor the most often - the one the "used together"
                // relationship is actually about. Informational only: no
                // edge is ever drawn for a usage neighbor (see
                // footprintManager.js's _renderSchema).
                let anchorTable = null, best = -1;
                for (const [seed, n] of e.anchorCounts) { if (n > best) { best = n; anchorTable = seed; } }
                return { qualifiedName: e.qualifiedName, via: 'usage', procCount: e.objects.size, procedures: [...e.objects].sort(), anchorTable };
            })
            .sort((a, b) => b.procCount - a.procCount);
    }

    // FK-confirmed wins for a table both signals agree on, carrying the usage
    // count along as a bonus detail rather than listing it twice.
    static merge(fkNeighbors, usageNeighbors) {
        const clean = RelatedTablesService._clean;
        const usageByKey = new Map(usageNeighbors.map(u => [clean(u.qualifiedName), u]));
        const merged = fkNeighbors.map(fk => {
            const key = clean(fk.qualifiedName);
            const usage = usageByKey.get(key);
            usageByKey.delete(key);
            return usage ? { ...fk, procCount: usage.procCount, procedures: usage.procedures } : fk;
        });
        return [...merged, ...usageByKey.values()];
    }
}

module.exports = RelatedTablesService;
