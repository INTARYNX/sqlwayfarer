'use strict';

const IndexResolver = require('./IndexResolver');

// Computes the *effective write footprint* of a programmable object (stored
// procedure, function, view, trigger): every table it reads or writes, followed
// transitively through called procedures/functions/views AND through the DML
// triggers that fire when a table is written. The trigger cascade is the whole
// point — a proc that writes one table can silently touch a dozen more through
// triggers, and nobody sees it by reading the proc.
//
// Static analysis limits (surfaced to the caller, never hidden):
//   - Dynamic SQL (EXEC / sp_executesql) is invisible to both
//     sys.dm_sql_referenced_entities and the parser, so anything built as a
//     string is NOT followed. The result is a *static* footprint.
//   - A write the parser missed is recorded as a read, so its triggers are not
//     followed. Confidence, not completeness.
//
// The writes come from the parser's table-level analysis (the target of an
// UPDATE / INSERT / DELETE / MERGE), completed by the column-level lineage:
// a DELETE writes a table without writing any named column.
//
// The heavy lifting (analyzeFootprint) is a pure function over the cached index
// plus a trigger→parent map, so it is fully unit-testable without a database.
class WriteFootprintService {
    constructor(connectionManager, indexService, databaseService) {
        this._connectionManager = connectionManager;
        this._indexService = indexService;
        this._databaseService = databaseService;
    }

    // Live entry point: pulls the cached index and a fresh trigger→parent map,
    // then delegates to the pure analyzer.
    async analyze(database, objectName) {
        const index = await this._indexService.getIndex(database);
        const triggers = await this._getTriggerParents(database);
        const footprint = WriteFootprintService.analyzeFootprint({ index, triggers, target: objectName });
        if (footprint.found && footprint.tables.length > 0) {
            const allFks = await this._databaseService.getForeignKeys(database);
            footprint.relationships = WriteFootprintService.foreignKeysAmong(allFks, footprint.tables);
        } else {
            footprint.relationships = [];
        }
        return footprint;
    }

    // Keep only FK edges whose both endpoints are in the footprint (pure).
    static foreignKeysAmong(foreignKeys, tables) {
        const inSet = new Set(tables.map(t => WriteFootprintService._clean(t.qualifiedName)));
        const seen = new Set();
        const edges = [];
        for (const fk of foreignKeys || []) {
            const from = WriteFootprintService._clean(fk.fromTable);
            const to = WriteFootprintService._clean(fk.toTable);
            if (!inSet.has(from) || !inSet.has(to)) continue;
            // Collapse multi-column FKs to a single edge per constraint.
            const key = `${fk.fkName}|${from}|${to}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({ fkName: fk.fkName, fromTable: fk.fromTable, toTable: fk.toTable });
        }
        return edges;
    }

    // One whole-database query: which table each DML trigger is attached to,
    // and whether it is currently enabled (disabled triggers never fire).
    async _getTriggerParents(database) {
        const result = await this._connectionManager.executeQueryInDatabase(database, `
            SELECT SCHEMA_NAME(trObj.schema_id) + '.' + tr.name AS trigger_name,
                   SCHEMA_NAME(o.schema_id) + '.' + o.name AS parent_table,
                   tr.is_disabled
            FROM sys.triggers tr
            JOIN sys.objects o ON o.object_id = tr.parent_id
            -- The trigger's own schema can differ from its parent table's (a
            -- trigger is created as schema.trigger_name, independently of the
            -- table it's attached to) - sys.triggers itself has no schema_id,
            -- so resolve it through the trigger's own sys.objects row instead.
            JOIN sys.objects trObj ON trObj.object_id = tr.object_id
            WHERE tr.parent_class = 1 AND tr.is_ms_shipped = 0
        `);
        return result.recordset.map(r => ({
            trigger: r.trigger_name,
            parentTable: r.parent_table,
            disabled: !!r.is_disabled
        }));
    }

    // === Pure analysis ===

    static _clean(name) {
        return (name || '').replace(/\[|\]/g, '').toLowerCase();
    }

    static _isCodeType(type) {
        return ['P', 'FN', 'IF', 'TF', 'V', 'TR'].includes(type);
    }

    /**
     * @param {object}   index     the cached index (index.objects map)
     * @param {Array}    triggers  [{ trigger, parentTable, disabled }]
     * @param {string}   target    qualified name of the object to analyze
     * @param {number}   maxDepth  safety bound on the traversal depth
     * @returns {{ found, target, tables, triggersFired, unresolved, truncated }}
     */
    static analyzeFootprint({ index, triggers = [], target, maxDepth = 50 }) {
        const objects = (index && index.objects) ? index.objects : {};

        // Name resolution: a qualified name is authoritative, an unqualified
        // one is resolved the way SQL Server resolves it inside a module (the
        // schema of the module first). An ambiguous name stays unresolved
        // instead of picking one of the candidates - a wrong table means the
        // wrong triggers fire.
        const resolver = new IndexResolver(objects, type => type === 'U');

        // Trigger → parent table (only what we can resolve is kept).
        const trigByParent = {};
        for (const t of triggers) {
            const p = WriteFootprintService._clean(t.parentTable);
            (trigByParent[p] = trigByParent[p] || []).push({
                key: WriteFootprintService._clean(t.trigger),
                disabled: !!t.disabled
            });
        }

        const targetEntry = resolver.resolve(target);
        if (!targetEntry) {
            return { found: false, target: null, tables: [], triggersFired: [], unresolved: [], truncated: false };
        }

        const tableAcc = new Map();     // qnLower -> { entry, write, direct, viaTrigger }
        const triggersFired = new Set();
        const unresolved = new Set();
        const visited = new Set();      // `${objectKey}|${viaTrigger?1:0}`
        let truncated = false;

        const ensureRec = (entry) => {
            const qn = WriteFootprintService._clean(entry.qualifiedName);
            let rec = tableAcc.get(qn);
            if (!rec) { rec = { entry, write: false, confident: false, possible: false, direct: false, viaTrigger: false, viaCause: null }; tableAcc.set(qn, rec); }
            return rec;
        };
        // cause is null for a direct reference, or { table, trigger } naming the
        // write + trigger that led here - first attribution wins when a table is
        // reachable through more than one trigger path.
        const recordTable = (entry, isWrite, cause) => {
            const rec = ensureRec(entry);
            rec.confident = true;
            if (isWrite) rec.write = true;
            if (cause) { rec.viaTrigger = true; if (!rec.viaCause) rec.viaCause = cause; } else rec.direct = true;
        };
        // Low-confidence table mentioned only via the dynamic-SQL name scan.
        const recordPossible = (entry, cause) => {
            const rec = ensureRec(entry);
            rec.possible = true;
            if (cause) { rec.viaTrigger = true; if (!rec.viaCause) rec.viaCause = cause; } else rec.direct = true;
        };

        // BFS over code objects. An object may be reached both directly and via a
        // trigger; we expand it at most once per context so the two taints are
        // both recorded, while still terminating on cycles (trigger loops).
        const queue = [{ entry: targetEntry, cause: null, depth: 0 }];
        while (queue.length) {
            const { entry, cause, depth } = queue.shift();
            const vkey = `${WriteFootprintService._clean(entry.qualifiedName)}|${cause ? 1 : 0}`;
            if (visited.has(vkey)) continue;
            visited.add(vkey);
            if (depth > maxDepth) { truncated = true; continue; }

            // Tables classified by the parser: a table is written when the
            // definition writes it (table level: the target of an UPDATE /
            // INSERT / DELETE / MERGE) or when one of its columns receives a
            // new value (column level). The table level is what catches the
            // writes that name no column - a DELETE, an INSERT without a
            // column list - which would otherwise never fire a trigger.
            const writtenTables = [];
            const columnRefs = entry.columnRefs || {};
            const writeKeys = new Set(entry.tableWrites || []);
            for (const tableKey of new Set([...Object.keys(columnRefs), ...writeKeys])) {
                const cols = columnRefs[tableKey] || {};
                // The reference was written inside this object: an unqualified
                // name resolves against the schema of that object.
                const te = resolver.resolveTable(tableKey, entry.schema);
                if (!te || te.type !== 'U') { unresolved.add(WriteFootprintService._clean(tableKey)); continue; }
                const isWrite = writeKeys.has(tableKey) || Object.values(cols).some(c => c && c.write);
                recordTable(te, isWrite, cause);
                if (isWrite) writtenTables.push(te);
            }

            // Referenced entities: recurse into code, add unclassified tables as reads.
            for (const dep of entry.dependencies || []) {
                const de = resolver.resolve(dep);
                if (!de) { unresolved.add(WriteFootprintService._clean(dep)); continue; }
                if (de.type === 'U') {
                    if (!tableAcc.has(WriteFootprintService._clean(de.qualifiedName))) recordTable(de, false, cause);
                } else if (WriteFootprintService._isCodeType(de.type)) {
                    queue.push({ entry: de, cause, depth: depth + 1 });
                }
            }

            // Possible (dynamic-SQL) refs: add tables mentioned only by name. Not
            // recursed (too speculative) and never fire triggers (access unknown).
            for (const pref of entry.possibleRefs || []) {
                const pe = resolver.resolve(pref);
                if (pe && pe.type === 'U') recordPossible(pe, cause);
            }

            // Trigger cascade: writing a table fires its enabled triggers, whose
            // own footprint is tainted "via trigger" - attributed to this table
            // and this trigger specifically, even if we're already inside another
            // trigger's cascade (nested cascades blame the innermost cause).
            for (const te of writtenTables) {
                const trigs = trigByParent[WriteFootprintService._clean(te.qualifiedName)] || [];
                for (const tg of trigs) {
                    if (tg.disabled) continue;
                    const tgEntry = resolver.resolve(tg.key);
                    if (!tgEntry) { unresolved.add(tg.key); continue; }
                    triggersFired.add(tgEntry.qualifiedName);
                    queue.push({ entry: tgEntry, cause: { table: te.qualifiedName, trigger: tgEntry.qualifiedName }, depth: depth + 1 });
                }
            }
        }

        const tables = [...tableAcc.values()].map(r => {
            const viaTriggerOnly = r.confident && r.viaTrigger && !r.direct;
            return {
                qualifiedName: r.entry.qualifiedName,
                schema: r.entry.schema,
                name: r.entry.name,
                // Confident write/read wins over a mere name mention.
                access: r.write ? 'write' : (r.confident ? 'read' : 'possible'),
                viaTriggerOnly,
                // Which table's write fired which trigger to reach this one -
                // only meaningful (and only ever set) when viaTriggerOnly is true.
                viaTriggerFrom: viaTriggerOnly ? r.viaCause : null
            };
        }).sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));

        return {
            found: true,
            target: { qualifiedName: targetEntry.qualifiedName, type: targetEntry.type },
            tables,
            triggersFired: [...triggersFired].sort(),
            unresolved: [...unresolved].sort(),
            truncated
        };
    }
}

module.exports = WriteFootprintService;
