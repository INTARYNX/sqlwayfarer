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
        const index = await this._indexService.requireIndex(database);
        const triggers = await this._getTriggerParents(database);
        const synonyms = await this._getSynonyms(database);
        const footprint = WriteFootprintService.analyzeFootprint({ index, triggers, synonyms, target: objectName });
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
                   tr.is_disabled,
                   tr.is_instead_of_trigger,
                   -- The writes it fires on: 1 INSERT, 2 UPDATE, 3 DELETE.
                   STUFF((SELECT ',' + CAST(te.type AS varchar(3)) FROM sys.trigger_events te
                          WHERE te.object_id = tr.object_id FOR XML PATH('')), 1, 1, '') AS events
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
            disabled: !!r.is_disabled,
            insteadOf: !!r.is_instead_of_trigger,
            events: WriteFootprintService._eventsOf(r.events)
        }));
    }

    // The synonyms of the database and what each one stands for: { 'dbo.syn': 'dbo.Target' }.
    async _getSynonyms(database) {
        const result = await this._connectionManager.executeQueryInDatabase(database, `
            SELECT SCHEMA_NAME(schema_id) + '.' + name AS synonym_name, base_object_name FROM sys.synonyms
        `);
        const out = {};
        for (const r of result.recordset) out[WriteFootprintService._clean(r.synonym_name)] = WriteFootprintService._clean(r.base_object_name);
        return out;
    }

    // What a name stands for when it is a synonym: a name without a schema is
    // looked up in the schema of the module that uses it, then in dbo. A
    // synonym of an object in another database is left alone: that database
    // is not indexed here.
    static _synonymTarget(key, schema, synonyms) {
        const name = WriteFootprintService._clean(key);
        const candidates = name.includes('.') ? [name] : [`${WriteFootprintService._clean(schema)}.${name}`, `dbo.${name}`];
        for (const candidate of candidates) {
            const base = synonyms[candidate];
            if (base && base.split('.').length <= 2) return base;
        }
        return null;
    }

    // === Pure analysis ===

    static _clean(name) {
        return (name || '').replace(/\[|\]/g, '').toLowerCase();
    }

    // '1,2' (the type codes of sys.trigger_events) -> ['insert', 'update'].
    static _eventsOf(codes) {
        const names = { 1: 'insert', 2: 'update', 3: 'delete' };
        return String(codes || '').split(',').map(code => names[code.trim()]).filter(Boolean);
    }

    // Whether a trigger fires on a write that does these kinds of things. What is not
    // known (a trigger with no events read, a write of unknown kind) counts as firing.
    static _firesOn(events, ops) {
        if (!events || events.length === 0 || !ops || ops.length === 0) return true;
        return ops.some(op => events.includes(op));
    }

    // What a name written in a module points at: { table }, { view }, or null.
    // A synonym is followed once to the object it stands for.
    static _locate(key, schema, resolver, synonyms, viaSynonym = false) {
        const found = resolver.resolveTable(key, schema);
        if (found && found.type === 'U') return { table: found };
        const code = found ? null : resolver.resolveCode(key, schema);
        if (code && code.type === 'V') return { view: code };
        if (viaSynonym) return null;
        const base = WriteFootprintService._synonymTarget(key, schema, synonyms);
        return base ? WriteFootprintService._locate(base, schema, resolver, synonyms, true) : null;
    }

    // The tables behind a view, through the views it is made of. A view over
    // several tables stands for all of them: only one can be written at a time,
    // and which one is not something the text of the statement says. (A view
    // with an INSTEAD OF trigger is handled before: the trigger is the write.)
    static _baseTables(view, resolver) {
        const bases = new Map();
        const seen = new Set();
        const walk = (entry, depth) => {
            const key = WriteFootprintService._clean(entry.qualifiedName);
            if (seen.has(key) || depth > 20) return;
            seen.add(key);
            for (const dep of entry.dependencies || []) {
                const target = resolver.resolve(dep);
                if (!target) continue;
                if (target.type === 'U') bases.set(WriteFootprintService._clean(target.qualifiedName), target);
                else if (target.type === 'V') walk(target, depth + 1);
            }
        };
        walk(view, 0);
        return [...bases.values()];
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
    static analyzeFootprint({ index, triggers = [], synonyms = {}, target, maxDepth = 50 }) {
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
                disabled: !!t.disabled,
                insteadOf: !!t.insteadOf,
                events: t.events || []
            });
        }

        const targetEntry = resolver.resolve(target);
        if (!targetEntry) {
            return { found: false, target: null, tables: [], triggersFired: [], unresolved: [], parseIssues: [], truncated: false };
        }

        const tableAcc = new Map();     // qnLower -> { entry, write, direct, viaTrigger }
        const triggersFired = new Set();
        const unresolved = new Set();
        const parseIssues = new Map();   // qualifiedName -> syntax errors
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

            // An object whose definition did not parse cleanly: its analysis
            // is partial, and the footprint built on it is partial too.
            const parseErrors = entry.parseErrors || [];
            if (parseErrors.length > 0) {
                parseIssues.set(entry.qualifiedName, parseErrors);
            }

            // Tables classified by the parser: a table is written when the
            // definition writes it (table level: the target of an UPDATE /
            // INSERT / DELETE / MERGE) or when one of its columns receives a
            // new value (column level). The table level is what catches the
            // writes that name no column - a DELETE, an INSERT without a
            // column list - which would otherwise never fire a trigger.
            const writtenTables = [];
            const writeOps = entry.tableWriteOps || {};
            const columnRefs = entry.columnRefs || {};
            const writeKeys = new Set(entry.tableWrites || []);
            for (const tableKey of new Set([...Object.keys(columnRefs), ...writeKeys])) {
                const cols = columnRefs[tableKey] || {};
                const isWrite = writeKeys.has(tableKey) || Object.values(cols).some(c => c && c.write);
                const ops = writeOps[tableKey] || [];
                // A name can be a table, a view, or a synonym of either.
                const where = WriteFootprintService._locate(tableKey, entry.schema, resolver, synonyms);
                if (where && where.table) {
                    const table = where.table;
                    const tableKeyClean = WriteFootprintService._clean(table.qualifiedName);
                    // An INSTEAD OF trigger takes over the kinds of write it is
                    // declared for: the statement does not write the table, the
                    // trigger does what it says. The writes of a table's own
                    // trigger go straight through, though.
                    const insideOwnTrigger = !!cause && WriteFootprintService._clean(cause.table) === tableKeyClean;
                    const instead = (isWrite && ops.length > 0 && !insideOwnTrigger)
                        ? (trigByParent[tableKeyClean] || []).filter(tg => tg.insteadOf && !tg.disabled && tg.events.some(event => ops.includes(event)))
                        : [];
                    if (instead.length > 0) {
                        const intercepted = ops.filter(op => instead.some(tg => tg.events.includes(op)));
                        for (const tg of instead) {
                            const tgEntry = resolver.resolve(tg.key);
                            if (!tgEntry) { unresolved.add(tg.key); continue; }
                            triggersFired.add(tgEntry.qualifiedName);
                            queue.push({ entry: tgEntry, cause: { table: table.qualifiedName, trigger: tgEntry.qualifiedName }, depth: depth + 1 });
                        }
                        const remaining = ops.filter(op => !intercepted.includes(op));
                        recordTable(table, remaining.length > 0, cause);
                        if (remaining.length > 0) writtenTables.push({ table, ops: remaining });
                        continue;
                    }
                    recordTable(table, isWrite, cause);
                    if (isWrite) writtenTables.push({ table, ops });
                    continue;
                }
                if (where && where.view) {
                    const view = where.view;
                    // A write through a view that has an INSTEAD OF trigger is
                    // what that trigger does, not a write of the tables behind:
                    // the trigger takes the write over.
                    const instead = isWrite
                        ? (trigByParent[WriteFootprintService._clean(view.qualifiedName)] || [])
                            .filter(tg => tg.insteadOf && !tg.disabled && WriteFootprintService._firesOn(tg.events, ops))
                        : [];
                    if (instead.length > 0) {
                        for (const tg of instead) {
                            const tgEntry = resolver.resolve(tg.key);
                            if (!tgEntry) { unresolved.add(tg.key); continue; }
                            triggersFired.add(tgEntry.qualifiedName);
                            queue.push({ entry: tgEntry, cause: { table: view.qualifiedName, trigger: tgEntry.qualifiedName }, depth: depth + 1 });
                        }
                        continue;
                    }
                    // Otherwise what is written (or read) through a view is the
                    // table behind it - and the triggers that fire are that table's.
                    for (const base of WriteFootprintService._baseTables(view, resolver)) {
                        recordTable(base, isWrite, cause);
                        if (isWrite) writtenTables.push({ table: base, ops });
                    }
                    continue;
                }
                unresolved.add(WriteFootprintService._clean(tableKey));
            }

            // Referenced entities: recurse into code, add unclassified tables as reads.
            for (const dep of entry.dependencies || []) {
                let de = resolver.resolve(dep);
                if (!de) {
                    // A synonym: the object it stands for is the dependency.
                    const base = WriteFootprintService._synonymTarget(dep, entry.schema, synonyms);
                    de = base ? resolver.resolve(base) : null;
                }
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
            for (const { table: te, ops } of writtenTables) {
                const trigs = trigByParent[WriteFootprintService._clean(te.qualifiedName)] || [];
                for (const tg of trigs) {
                    if (tg.disabled) continue;
                    // An INSTEAD OF trigger does not fire from its own table's trigger.
                    if (tg.insteadOf && cause && WriteFootprintService._clean(cause.table) === WriteFootprintService._clean(te.qualifiedName)) continue;
                    // An AFTER INSERT trigger does not fire on a DELETE.
                    if (!WriteFootprintService._firesOn(tg.events, ops)) continue;
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
            // The objects whose definition did not parse cleanly: their
            // analysis is partial, so the footprint is partial too.
            parseIssues: [...parseIssues.entries()].map(([object, errors]) => ({ object, errors })),
            truncated
        };
    }
}

module.exports = WriteFootprintService;
