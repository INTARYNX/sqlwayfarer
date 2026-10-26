'use strict';

const IndexResolver = require('./IndexResolver');

// Builds the graph of the objects a QUERY touches: the tables it reads, the
// way they are joined together, and the tables reached through the procedures
// and functions the query calls.
//
// It is the counterpart of the write footprint, which starts from a stored
// object; here the entry point is the SQL text of the editor. The heavy
// lifting (buildGraph) is a pure function over the cached index, so it is
// fully unit-testable without a database.
//
// Static analysis limits (surfaced to the caller, never hidden):
//   - Dynamic SQL (EXEC / sp_executesql) is invisible to the parser, so
//     anything built as a string is NOT followed. The result is a *static*
//     graph of what the text says it reads.
//   - A table referenced without its schema is resolved against the schema of
//     the module the reference was written in, and only when its bare name is
//     unique in the database. An ambiguous name is reported as unresolved
//     rather than resolved to a same-named table in another schema.
const BabelfishSqlParser = require('./BabelfishSqlParser');
const WriteFootprintService = require('./WriteFootprintService');

class QueryGraphService {
    constructor(connectionManager, indexService, databaseService) {
        this._connectionManager = connectionManager;
        this._indexService = indexService;
        this._databaseService = databaseService;
        this._sqlParser = new BabelfishSqlParser();
        this._sqlParser.setEnabled(!!connectionManager);
    }

    // Live entry point: parses the text, resolves it against the cached
    // index, then adds the FK edges between the tables of the graph.
    async analyze(database, sql) {
        if (!sql || !sql.trim()) {
            return QueryGraphService.emptyGraph();
        }
        const index = await this._indexService.getIndex(database);
        const parsed = this._sqlParser.analyzeJoins(sql);
        if (!parsed) {
            return { ...QueryGraphService.emptyGraph(), parseFailed: true };
        }

        const graph = QueryGraphService.buildGraph({ index, parsed });

        // The FK edges are the relational context (the Schema tab); the join
        // edges are what the query actually writes.
        if (graph.tables.length > 0) {
            const allFks = await this._databaseService.getForeignKeys(database);
            // foreignKeysAmong expects the table objects, not their names.
            graph.relationships = WriteFootprintService.foreignKeysAmong(allFks, graph.tables);
        }
        return graph;
    }

    static emptyGraph() {
        return { tables: [], joins: [], relationships: [], unresolved: [], truncated: false };
    }

    static _clean(name) {
        return (name || '').replace(/\[|\]/g, '').toLowerCase();
    }

    static _isCodeType(type) {
        return ['P', 'FN', 'IF', 'TF', 'V', 'TR'].includes(type);
    }

    static _isDataType(type) {
        return type === 'U' || type === 'V';
    }

    /**
     * Builds the graph of a parsed query over the cached index.
     * @param {object}   index   the cached index (index.objects map)
     * @param {object}   parsed  { tables, functions, joins } from analyzeJoins
     * @param {number}   maxDepth  safety bound on the traversal depth
     * @returns {{tables: Array, joins: Array, unresolved: Array, truncated: boolean}}
     */
    static buildGraph({ index, parsed, maxDepth = 50 }) {
        const objects = (index && index.objects) ? index.objects : {};
        // Same resolution rule as the write footprint: a qualified name is
        // authoritative, an unqualified one is resolved against the schema of
        // the module it was written in, and an ambiguous name stays
        // unresolved instead of picking one of the candidates.
        const resolver = new IndexResolver(objects, type => QueryGraphService._isDataType(type));
        const resolve = name => resolver.resolve(name);

        const unresolved = new Set();
        const nodes = new Map();   // qn -> { entry, access, via }
        const queue = [];

        // === the tables the query reads directly ===
        // The query is typed by a user, so there is no module schema to
        // resolve an unqualified name against.
        for (const tableKey of (parsed && parsed.tables) || []) {
            const entry = resolver.resolveTable(tableKey, null);
            if (!entry) { unresolved.add(QueryGraphService._clean(tableKey)); continue; }
            const qn = QueryGraphService._clean(entry.qualifiedName);
            if (!nodes.has(qn)) nodes.set(qn, { entry, access: 'direct', via: [] });
            // A view is read as a table but hides the tables behind it: those
            // are reached through the view.
            if (QueryGraphService._isCodeType(entry.type)) {
                queue.push({ entry, via: [entry.qualifiedName], depth: 0 });
            }
        }

        // === the tables reached through the called procedures/functions ===
        for (const fnName of (parsed && parsed.functions) || []) {
            const entry = resolve(fnName);
            if (!entry) { unresolved.add(QueryGraphService._clean(fnName)); continue; }
            if (!QueryGraphService._isCodeType(entry.type)) continue;
            queue.push({ entry, via: [entry.qualifiedName], depth: 0 });
        }

        let truncated = false;
        const visited = new Set();
        while (queue.length) {
            const { entry, via, depth } = queue.shift();
            const vkey = QueryGraphService._clean(entry.qualifiedName);
            if (visited.has(vkey)) continue;
            visited.add(vkey);
            if (depth > maxDepth) { truncated = true; continue; }

            // Tables the parser found in the body of the object: the ones it reads
            // (column lineage) and the ones it writes (table-level writes).
            const bodyTables = new Set([
                ...Object.keys(entry.columnRefs || {}),
                ...(entry.tableWrites || [])
            ]);
            for (const tableKey of bodyTables) {
                const te = resolver.resolveTable(tableKey, entry.schema);
                if (!te) { unresolved.add(QueryGraphService._clean(tableKey)); continue; }
                const qn = QueryGraphService._clean(te.qualifiedName);
                if (!nodes.has(qn)) nodes.set(qn, { entry: te, access: 'via-code', via });
            }

            // Objects it depends on (the DMV view).
            for (const dep of entry.dependencies || []) {
                const de = resolve(dep);
                if (!de) { unresolved.add(QueryGraphService._clean(dep)); continue; }
                if (QueryGraphService._isDataType(de.type)) {
                    const qn = QueryGraphService._clean(de.qualifiedName);
                    if (!nodes.has(qn)) nodes.set(qn, { entry: de, access: 'via-code', via });
                } else if (QueryGraphService._isCodeType(de.type)) {
                    queue.push({ entry: de, via: [...via, de.qualifiedName], depth: depth + 1 });
                }
            }
        }

        // === the join edges, between the nodes of the graph ===
        const joins = [];
        const seenJoins = new Set();
        for (const join of (parsed && parsed.joins) || []) {
            const fromEntry = resolver.resolveTable(join.from, null);
            const toEntry = resolver.resolveTable(join.to, null);
            if (!fromEntry || !toEntry) {
                if (!fromEntry) unresolved.add(QueryGraphService._clean(join.from));
                if (!toEntry) unresolved.add(QueryGraphService._clean(join.to));
                continue;
            }
            const from = fromEntry.qualifiedName;
            const to = toEntry.qualifiedName;
            const key = `${from}|${to}|${join.condition}`;
            if (seenJoins.has(key)) continue;
            seenJoins.add(key);

            // The columns of the condition, keyed by the resolved table name.
            const columns = {};
            for (const [tableKey, cols] of Object.entries(join.columns || {})) {
                const te = resolver.resolveTable(tableKey, null);
                const name = te ? te.qualifiedName : tableKey;
                columns[name] = cols;
            }
            joins.push({
                from, to,
                condition: join.condition,
                columns,
                confident: join.confident !== false,
                kind: join.kind || 'join'
            });
        }

        const tables = [...nodes.values()].map(n => ({
            qualifiedName: n.entry.qualifiedName,
            schema: n.entry.schema,
            name: n.entry.name,
            type: n.entry.type,
            // 'direct': read by the query itself, 'via-code': reached through
            // a procedure or a function the query calls.
            access: n.access,
            via: n.via
        })).sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));

        return { tables, joins, relationships: [], unresolved: [...unresolved].sort(), truncated };
    }
}

module.exports = QueryGraphService;
