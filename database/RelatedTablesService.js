'use strict';

const WriteFootprintService = require('./WriteFootprintService');

// Finds tables related to a given set (a query's or a footprint's tables),
// for the Schema tab's "Expand" action - never shown by default, only on
// request. Two signals, merged:
//   - FK neighbors: a one-hop foreign key to/from a table not yet in the set.
//   - Usage neighbors: tables other stored procedures/views/functions commonly
//     touch alongside the set's tables, mined from the already-cached
//     dependency index (sys.sql_expression_dependencies) - the same data
//     DependencyService's own referencedBy already reads, so no new parsing
//     and no new round trip. This is the signal that matters most in a legacy,
//     FK-less database: the real relationships only exist in how the code
//     actually uses the tables together.
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
    async relatedTables(database, tableNames) {
        const index = await this._indexService.peekIndex(database);
        const allFks = await this._databaseService.getForeignKeys(database);
        const fkNeighbors = RelatedTablesService.foreignKeyNeighbors(allFks, tableNames);
        const usageNeighbors = index ? RelatedTablesService.usageNeighbors(index, tableNames) : [];
        return RelatedTablesService.merge(fkNeighbors, usageNeighbors);
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
        const inSet = new Set((tableNames || []).map(clean));
        const bareInSet = new Set([...inSet].map(n => n.split('.').pop()));
        const matchesSet = (dep) => {
            const c = clean(dep);
            return inSet.has(c) || bareInSet.has(c.split('.').pop());
        };

        // A dependency is just a name string (see IndexService's index entry
        // shape); resolve it back to the object it names, the same
        // qualified-then-bare fallback DependencyService's own lookup uses.
        const byClean = new Map();
        for (const obj of Object.values(index.objects)) byClean.set(clean(obj.qualifiedName), obj);
        const resolve = (dep) => byClean.get(clean(dep)) || byClean.get(clean(dep).split('.').pop());

        const counts = new Map(); // qualifiedName(lower) -> { qualifiedName, objects: Set }
        for (const obj of Object.values(index.objects)) {
            const deps = obj.dependencies || [];
            if (!deps.some(matchesSet)) continue;
            for (const dep of deps) {
                if (matchesSet(dep)) continue; // the set's own tables, not a neighbor
                const target = resolve(dep);
                if (!target || target.type !== 'U') continue; // tables only
                const key = clean(target.qualifiedName);
                if (!counts.has(key)) counts.set(key, { qualifiedName: target.qualifiedName, objects: new Set() });
                counts.get(key).objects.add(obj.qualifiedName || obj.name);
            }
        }
        // The edge drawn for a usage neighbor has to anchor on one specific
        // table of the set; the first one given is as good a pick as any -
        // the ranking itself (procCount) does not depend on it.
        const anchorTable = (tableNames || [])[0] || null;
        return [...counts.values()]
            .map(e => ({ qualifiedName: e.qualifiedName, via: 'usage', procCount: e.objects.size, procedures: [...e.objects].sort(), anchorTable }))
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
