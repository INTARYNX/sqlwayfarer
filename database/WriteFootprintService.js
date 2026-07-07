'use strict';

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
// The heavy lifting (analyzeFootprint) is a pure function over the cached index
// plus a trigger→parent map, so it is fully unit-testable without a database.
class WriteFootprintService {
    constructor(connectionManager, indexService) {
        this._connectionManager = connectionManager;
        this._indexService = indexService;
    }

    // Live entry point: pulls the cached index and a fresh trigger→parent map,
    // then delegates to the pure analyzer.
    async analyze(database, objectName) {
        const index = await this._indexService.getIndex(database);
        const triggers = await this._getTriggerParents(database);
        const footprint = WriteFootprintService.analyzeFootprint({ index, triggers, target: objectName });
        if (footprint.found && footprint.tables.length > 0) {
            const allFks = await this._getForeignKeys(database);
            footprint.relationships = WriteFootprintService.foreignKeysAmong(allFks, footprint.tables);
        } else {
            footprint.relationships = [];
        }
        return footprint;
    }

    // All FK edges in the database; filtered to the footprint tables in JS
    // (foreignKeysAmong) so the query stays simple and cache-friendly.
    async _getForeignKeys(database) {
        const result = await this._connectionManager.executeQueryInDatabase(database, `
            SELECT fk.name AS fk_name,
                   s1.name + '.' + t1.name AS from_table, c1.name AS from_column,
                   s2.name + '.' + t2.name AS to_table, c2.name AS to_column
            FROM sys.foreign_keys fk
            JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
            JOIN sys.tables t1 ON t1.object_id = fk.parent_object_id
            JOIN sys.schemas s1 ON s1.schema_id = t1.schema_id
            JOIN sys.columns c1 ON c1.object_id = fkc.parent_object_id AND c1.column_id = fkc.parent_column_id
            JOIN sys.tables t2 ON t2.object_id = fk.referenced_object_id
            JOIN sys.schemas s2 ON s2.schema_id = t2.schema_id
            JOIN sys.columns c2 ON c2.object_id = fkc.referenced_object_id AND c2.column_id = fkc.referenced_column_id
        `);
        return result.recordset.map(r => ({
            fkName: r.fk_name,
            fromTable: r.from_table, fromColumn: r.from_column,
            toTable: r.to_table, toColumn: r.to_column
        }));
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
            SELECT SCHEMA_NAME(o.schema_id) + '.' + tr.name AS trigger_name,
                   SCHEMA_NAME(o.schema_id) + '.' + o.name AS parent_table,
                   tr.is_disabled
            FROM sys.triggers tr
            JOIN sys.objects o ON o.object_id = tr.parent_id
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

        // Case-insensitive lookups: by qualified name, and by bare name for the
        // parser's occasionally schema-less column references (tables only).
        const byQN = {};
        const byBareTable = {};
        for (const e of Object.values(objects)) {
            const qn = WriteFootprintService._clean(e.qualifiedName);
            byQN[qn] = e;
            if (e.type === 'U') {
                const bare = qn.split('.').pop();
                if (!byBareTable[bare]) byBareTable[bare] = e;
            }
        }
        const resolve = name => byQN[WriteFootprintService._clean(name)] || null;
        const resolveTable = key => {
            const n = WriteFootprintService._clean(key);
            if (byQN[n] && byQN[n].type === 'U') return byQN[n];
            return byBareTable[n.split('.').pop()] || null;
        };

        // Trigger → parent table (only what we can resolve is kept).
        const trigByParent = {};
        for (const t of triggers) {
            const p = WriteFootprintService._clean(t.parentTable);
            (trigByParent[p] = trigByParent[p] || []).push({
                key: WriteFootprintService._clean(t.trigger),
                disabled: !!t.disabled
            });
        }

        const targetEntry = resolve(target);
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
            if (!rec) { rec = { entry, write: false, confident: false, possible: false, direct: false, viaTrigger: false }; tableAcc.set(qn, rec); }
            return rec;
        };
        // Confident read/write from the resolver + parser.
        const recordTable = (entry, isWrite, viaTrigger) => {
            const rec = ensureRec(entry);
            rec.confident = true;
            if (isWrite) rec.write = true;
            if (viaTrigger) rec.viaTrigger = true; else rec.direct = true;
        };
        // Low-confidence table mentioned only via the dynamic-SQL name scan.
        const recordPossible = (entry, viaTrigger) => {
            const rec = ensureRec(entry);
            rec.possible = true;
            if (viaTrigger) rec.viaTrigger = true; else rec.direct = true;
        };

        // BFS over code objects. An object may be reached both directly and via a
        // trigger; we expand it at most once per context so the two taints are
        // both recorded, while still terminating on cycles (trigger loops).
        const queue = [{ entry: targetEntry, viaTrigger: false, depth: 0 }];
        while (queue.length) {
            const { entry, viaTrigger, depth } = queue.shift();
            const vkey = `${WriteFootprintService._clean(entry.qualifiedName)}|${viaTrigger ? 1 : 0}`;
            if (visited.has(vkey)) continue;
            visited.add(vkey);
            if (depth > maxDepth) { truncated = true; continue; }

            // Tables classified by the parser (read vs write per column).
            const writtenTables = [];
            for (const [tableKey, cols] of Object.entries(entry.columnRefs || {})) {
                const te = resolveTable(tableKey);
                if (!te || te.type !== 'U') { unresolved.add(WriteFootprintService._clean(tableKey)); continue; }
                const isWrite = Object.values(cols || {}).some(c => c && c.write);
                recordTable(te, isWrite, viaTrigger);
                if (isWrite) writtenTables.push(te);
            }

            // Referenced entities: recurse into code, add unclassified tables as reads.
            for (const dep of entry.dependencies || []) {
                const de = resolve(dep);
                if (!de) { unresolved.add(WriteFootprintService._clean(dep)); continue; }
                if (de.type === 'U') {
                    if (!tableAcc.has(WriteFootprintService._clean(de.qualifiedName))) recordTable(de, false, viaTrigger);
                } else if (WriteFootprintService._isCodeType(de.type)) {
                    queue.push({ entry: de, viaTrigger, depth: depth + 1 });
                }
            }

            // Possible (dynamic-SQL) refs: add tables mentioned only by name. Not
            // recursed (too speculative) and never fire triggers (access unknown).
            for (const pref of entry.possibleRefs || []) {
                const pe = resolve(pref);
                if (pe && pe.type === 'U') recordPossible(pe, viaTrigger);
            }

            // Trigger cascade: writing a table fires its enabled triggers, whose
            // own footprint is tainted "via trigger".
            for (const te of writtenTables) {
                const trigs = trigByParent[WriteFootprintService._clean(te.qualifiedName)] || [];
                for (const tg of trigs) {
                    if (tg.disabled) continue;
                    const tgEntry = byQN[tg.key];
                    if (!tgEntry) { unresolved.add(tg.key); continue; }
                    triggersFired.add(tgEntry.qualifiedName);
                    queue.push({ entry: tgEntry, viaTrigger: true, depth: depth + 1 });
                }
            }
        }

        const tables = [...tableAcc.values()].map(r => ({
            qualifiedName: r.entry.qualifiedName,
            schema: r.entry.schema,
            name: r.entry.name,
            // Confident write/read wins over a mere name mention.
            access: r.write ? 'write' : (r.confident ? 'read' : 'possible'),
            viaTriggerOnly: r.confident && r.viaTrigger && !r.direct
        })).sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));

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
