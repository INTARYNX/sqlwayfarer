'use strict';

const fs = require('fs').promises;
const debug = require('./debugLog');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const ParserWorkerPool = require('./ParserWorkerPool');
const { IndexBuildStats, addRun } = require('./IndexStats');

// Bumped when the index entry shape changes (2 = columnRefs for column lineage,
// 3 = possibleRefs from the dynamic-SQL name scan, 4 = tableWrites for the
// table-level writes, 5 = parseErrors for the incomplete analyses, 6 = no false
// ambiguous dependencies, 7 = checksums from the ISO date, not the text a Date
// has in the local time zone, 8 = tableWriteOps: the kind of each table write, 9 = a user-defined type is not a
// dependency);
// older cached files rebuild.
const INDEX_FORMAT_VERSION = 9;

// Counts the temporary files written in this process, so that two writes
// that run at the same time - two builds of the same database, or a build
// and the statistics it records - never write the same temporary file and
// rename it over each other.
let temporaryCounter = 0;

// The name of the temporary file of an atomic write. The pid and the counter
// are part of it: two extensions running at the same time, or two writes of
// the same file in one extension, must not fight over the same name.
function temporaryPath(file) {
    temporaryCounter += 1;
    return `${file}.tmp-${process.pid}-${temporaryCounter}`;
}

class IndexService {
    // How many objects' dependency queries run concurrently during a build.
    // mssql's default pool allows up to 10 simultaneous requests; this leaves
    // some headroom for a query the user runs in the Query tab at the same time.
    static CONCURRENT_BATCH_SIZE = 8;

    constructor(connectionManager, databaseService) {
        this._connectionManager = connectionManager;
        this._databaseService = databaseService;
        this._parserPool = new ParserWorkerPool();
        this._indexDir = path.join(os.homedir(), '.vscode', 'sqlwayfarer', 'indexes');
        // database -> { promise, forced, cancelRequested, subscribers: Set<fn>, lastReportedPct, server }
        // One entry per database currently building/loading, instead of single
        // shared fields - two databases can be indexed concurrently (switching
        // database mid-build must not corrupt progress/cancel for the other one),
        // and a second caller for the SAME database joins the existing entry
        // instead of racing a duplicate build.
        this._builds = new Map();
        // index file -> { mtime, index }: the parsed index peekIndex last read.
        this._peeked = new Map();
    }

    // Ask the running indexing loop for this database to stop at the next
    // per-object checkpoint. Targeted - cancelling one database's build must
    // not affect another database indexing concurrently.
    requestCancel(database) {
        const build = this._builds.get(database);
        if (build) build.cancelRequested = true;
    }

    // Cancel every in-flight build, used when the panel itself is closing.
    requestCancelAll() {
        for (const build of this._builds.values()) build.cancelRequested = true;
    }

    isBuildInProgress(database) {
        return this._builds.has(database);
    }

    // Throttled: only posts when the integer percentage actually changes.
    // Fans out to every subscriber for this database - a getIndex call that
    // joins an in-flight forceReindex (or vice versa) has its own callback
    // alongside the original caller's, both need to see progress.
    _reportProgress(database, current, total, message) {
        const build = this._builds.get(database);
        if (!build || build.subscribers.size === 0) return;
        const progress = total === 0 ? 100 : Math.round((current / total) * 100);
        if (progress === build.lastReportedPct && current !== total) return;
        build.lastReportedPct = progress;
        for (const callback of build.subscribers) {
            try {
                callback({ progress, current, total, message });
            } catch (error) {
                console.warn('Progress callback failed:', error.message);
            }
        }
    }

    // The index as it is cached on this computer, WITHOUT ever building or
    // updating it (null when there is none): the dependency tree, column usage,
    // dictionary, write footprint... all read the index through here. Building
    // reads every definition of the database - it only happens when the user
    // asks for it (getIndex / forceReindex), never as a side effect of looking
    // at something. A build the user started is awaited, not duplicated.
    // The index may be out of date; getIndexStatus says so.
    async peekIndex(database) {
        const building = this._builds.get(database);
        if (building) {
            try { return await building.promise; } catch { return null; }
        }
        const indexFile = await this._migrateLegacyIndexFile(database);
        let mtime;
        try { mtime = (await fs.stat(indexFile)).mtimeMs; } catch { return null; }
        const cached = this._peeked.get(indexFile);
        if (cached && cached.mtime === mtime) return cached.index;
        const index = await this._loadIndex(indexFile);
        if (index) this._peeked.set(indexFile, { mtime, index });
        else this._peeked.delete(indexFile);
        return index;
    }

    // peekIndex for the features that cannot work without an index (write
    // footprint, query graph): a clear error instead of a silent build.
    async requireIndex(database) {
        const index = await this.peekIndex(database);
        if (!index) {
            const error = new Error('This needs the dependency index of the database, which has not been built. Open the Explorer and choose "Build index" first.');
            error.code = 'INDEX_NOT_BUILT';
            throw error;
        }
        return index;
    }

    // Where the index of a database stands, for the Explorer notice:
    //   building - a build is running
    //   none     - nothing cached (or in an older format)
    //   stale    - cached, but the schema changed since (modify_date checksum)
    //   ready    - cached and current
    // Only reads: one lightweight sys.objects query, no definition is analyzed.
    async getIndexStatus(database) {
        if (this._builds.has(database)) return { state: 'building' };
        const index = await this.peekIndex(database);
        if (!index) return { state: 'none' };
        let stale = false;
        let changes = null;
        try {
            const live = await this._getLiveObjects(database);
            stale = index.schemaChecksum !== this._checksumFromObjects(live);
            if (stale) changes = this.diffAgainstSchema(index.objects || {}, live);
        } catch (error) {
            console.warn('Could not compare the index with the schema:', error.message);
        }
        const status = {
            state: stale ? 'stale' : 'ready',
            builtAt: index.lastIncrementalUpdate || index.lastFullIndex || null,
            totalObjects: index.totalObjects || 0
        };
        if (changes) status.changes = changes;
        return status;
    }

    // Which objects an update would re-analyze, by comparing the cached entries
    // with the live objects (the same rule _updateIndexIncrementally applies):
    // { modified: [qualifiedName], added: [...], removed: [...] }, sorted.
    // An entry whose last analysis was incomplete counts as modified.
    diffAgainstSchema(cachedObjects, liveObjects) {
        const modified = [];
        const added = [];
        const seen = new Set();
        for (const obj of liveObjects) {
            const key = this._removeBrackets(obj.qualified_name);
            seen.add(key);
            const cached = cachedObjects[key];
            if (!cached) added.push(key);
            else if (cached.checksum !== this._entryChecksum(obj) || cached.dependenciesIncomplete) modified.push(key);
        }
        const removed = Object.keys(cachedObjects).filter(key => !seen.has(key));
        const sort = list => list.sort((a, b) => a.localeCompare(b));
        return { modified: sort(modified), added: sort(added), removed: sort(removed) };
    }

    _entryChecksum(obj) {
        return this._calculateChecksum(`${obj.qualified_name}_${obj.type}_${IndexService._stamp(obj.modify_date)}`);
    }

    // BUILDS (or updates) the index: only for an explicit user action - the
    // Explorer's "Build index" / "Update index" buttons and Force reindex.
    // Concurrent calls for the same database share one in-flight
    // promise/build entry: without this, a second call would reset progress/
    // cancel state mid-build and could run a duplicate full rebuild.
    async getIndex(database, progressCallback = null) {
        const existing = this._builds.get(database);
        if (existing) {
            if (progressCallback) existing.subscribers.add(progressCallback);
            return existing.promise;
        }

        const build = {
            forced: false, cancelRequested: false,
            subscribers: new Set(progressCallback ? [progressCallback] : []),
            lastReportedPct: -1, server: this._getCurrentServerName()
        };
        // Only delete the map entry if it's still THIS build - two concurrent
        // callers that both missed the dedup check above (plain getIndex racing
        // forceReindex, or two forceReindex calls - see below) can each end up
        // creating their own build and overwriting the other's map entry; without
        // this guard, the first one to finish would delete the SECOND (still
        // running) build's entry, making isBuildInProgress() lie and letting a
        // third caller start yet another redundant build.
        build.promise = this._runGetIndex(database, build).finally(() => {
            if (this._builds.get(database) === build) this._builds.delete(database);
        });
        this._builds.set(database, build);
        return build.promise;
    }

    async _runGetIndex(database, build) {
        const indexFile = await this._migrateLegacyIndexFile(database, build.server);
        await this._ensureIndexDir(path.dirname(indexFile));

        const t0 = IndexBuildStats.now();
        const liveObjects = await this._getLiveObjects(database);
        const listMs = IndexBuildStats.now() - t0;
        const liveChecksum = this._checksumFromObjects(liveObjects);
        let index = await this._loadIndex(indexFile);

        if (!index || index.schemaChecksum !== liveChecksum) {
            // With a cached index, only re-analyze objects whose modify_date changed
            // (plus additions/removals) instead of rebuilding everything.
            const stats = new IndexBuildStats(index ? 'incremental' : 'full', IndexService.CONCURRENT_BATCH_SIZE);
            stats.phase('listObjectsMs', listMs);
            const before = index;
            index = index
                ? await this._updateIndexIncrementally(database, index, liveObjects, liveChecksum, build.server, stats)
                : await this._buildCompleteIndex(database, liveChecksum, liveObjects, build.server, stats);
            const saveStart = IndexBuildStats.now();
            await this._saveIndex(indexFile, index);
            stats.phase('saveMs', IndexBuildStats.now() - saveStart);
            await this._recordStats(indexFile, stats, index, before);
        }
        return index;
    }

    async forceReindex(database, progressCallback = null) {
        const existing = this._builds.get(database);
        if (existing) {
            if (existing.forced) {
                // Already force-rebuilding this database - join it instead of
                // redoing the work (e.g. a rapid double confirm, or a retry
                // landing while the first force reindex is still running).
                if (progressCallback) existing.subscribers.add(progressCallback);
                return existing.promise;
            }
            // Let the in-flight plain build finish before clearing the cache
            // out from under it; its own result/errors don't matter here.
            await existing.promise.catch(() => {});
        }

        debug(`Force reindexing database: ${database}`);
        const build = {
            forced: true, cancelRequested: false,
            subscribers: new Set(progressCallback ? [progressCallback] : []),
            lastReportedPct: -1, server: this._getCurrentServerName()
        };
        build.promise = this._runForceReindex(database, build).finally(() => {
            if (this._builds.get(database) === build) this._builds.delete(database);
        });
        this._builds.set(database, build);
        return build.promise;
    }

    async _runForceReindex(database, build) {
        const indexFile = this._getIndexFilePath(database, build.server);
        await this._ensureIndexDir(path.dirname(indexFile));
        // The index that exists stays until the new one replaces it: a build that
        // is cancelled or fails must not leave the user without any.

        const stats = new IndexBuildStats('force', IndexService.CONCURRENT_BATCH_SIZE);
        const t0 = IndexBuildStats.now();
        const liveObjects = await this._getLiveObjects(database);
        stats.phase('listObjectsMs', IndexBuildStats.now() - t0);
        const index = await this._buildCompleteIndex(database, this._checksumFromObjects(liveObjects), liveObjects, build.server, stats);
        const saveStart = IndexBuildStats.now();
        await this._saveIndex(indexFile, index);
        this._peeked.delete(indexFile);
        stats.phase('saveMs', IndexBuildStats.now() - saveStart);
        await this._recordStats(indexFile, stats, index, null);
        debug(`Force reindex complete for ${database}`);
        return index;
    }

    // Cancels every in-flight build and tears down the parser worker pool -
    // called when the panel closes.
    async dispose() {
        this.requestCancelAll();
        await this._parserPool.dispose();
    }

    async clearIndex(database) {
        const indexFile = this._getIndexFilePath(database);
        // The legacy file too: it would be migrated back on the next index
        // build, and the user asked for the index to be gone.
        const legacyFile = this._legacyIndexFilePath(database);
        this._peeked.delete(indexFile);
        for (const file of [indexFile, legacyFile]) {
            try {
                await fs.unlink(file);
                debug(`Cleared index for ${database}`);
            } catch (error) {
                if (error.code !== 'ENOENT') console.warn(`Failed to clear index for ${database}:`, error.message);
            }
        }
    }

    async getIndexStats(database) {
        const indexFile = await this._migrateLegacyIndexFile(database);
        try {
            const stats = await fs.stat(indexFile);
            const index = await this._loadIndex(indexFile);
            if (index) {
                const objectsWithDeps = Object.values(index.objects).filter(o => o.dependencies?.length > 0).length;
                return {
                    exists: true,
                    lastModified: stats.mtime,
                    totalObjects: index.totalObjects || 0,
                    objectsByType: index.objectsByType || {},
                    objectsWithDependencies: objectsWithDeps,
                    lastFullIndex: index.lastFullIndex
                };
            }
        } catch { /* file may not exist yet */ }

        return { exists: false, totalObjects: 0, objectsByType: {}, objectsWithDependencies: 0, lastFullIndex: null };
    }

    async getObjectDependencies(database, objectName) {
        const index = await this.peekIndex(database);
        if (!index) return [];
        const obj = index.objects[this._removeBrackets(objectName)];
        return obj?.dependencies || [];
    }

    async findDependents(database, targetObject) {
        const index = await this.peekIndex(database);
        if (!index) return [];
        const normalizedTarget = this._removeBrackets(targetObject);
        const dependents = [];
        for (const [, obj] of Object.entries(index.objects)) {
            if (obj.dependencies?.some(dep => this._removeBrackets(dep) === normalizedTarget)) {
                dependents.push({ name: obj.qualifiedName, type: obj.type, schema: obj.schema });
            }
        }
        return dependents;
    }

    // Current object list of the database, shared by full and incremental indexing.
    async _getLiveObjects(database) {
        const result = await this._connectionManager.executeQueryInDatabase(database, `
            SELECT
                o.object_id, o.name,
                s.name AS schema_name,
                s.name + '.' + o.name AS qualified_name,
                RTRIM(o.type) AS type, o.type_desc, o.create_date, o.modify_date,
                DB_NAME() as database_name
            FROM sys.objects o
            INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
            WHERE o.is_ms_shipped = 0 AND o.type IN ('U', 'P', 'FN', 'IF', 'TF', 'TR', 'V')
            ORDER BY o.type, s.name, o.name;
        `);

        return result.recordset.map(row => ({
            object_id: row.object_id, name: row.name, schema_name: row.schema_name,
            qualified_name: row.qualified_name, type: (row.type || '').trim(),
            type_desc: row.type_desc, create_date: row.create_date,
            modify_date: row.modify_date, database_name: row.database_name
        }));
    }

    // The date of a modification as text. A Date is written in UTC, to the
    // millisecond: its own toString depends on the time zone of the machine
    // (and drops the milliseconds), so a change of zone made every index stale.
    static _stamp(modifyDate) {
        return modifyDate instanceof Date ? modifyDate.toISOString() : String(modifyDate);
    }

    _checksumFromObjects(objects) {
        const raw = [...objects]
            .sort((a, b) => a.object_id - b.object_id)
            .map(o => `${o.object_id}:${IndexService._stamp(o.modify_date)}`)
            .join('|');
        return crypto.createHash('md5').update(raw).digest('hex');
    }

    _makeIndexEntry(obj) {
        return {
            name: obj.name,
            schema: obj.schema_name,
            qualifiedName: this._removeBrackets(obj.qualified_name),
            type: obj.type,
            objectId: obj.object_id,
            createDate: obj.create_date,
            modifyDate: obj.modify_date,
            checksum: this._entryChecksum(obj),
            dependencies: [],
            // { tableKey: { columnName: { write, confident } } } from the parser
            columnRefs: {},
            // Tables the definition writes, whatever the columns involved:
            // the target of an UPDATE / INSERT / DELETE / MERGE. A write that
            // names no column (a DELETE, an INSERT without a column list) is
            // only visible at this level.
            tableWrites: [],
            // Syntax errors met while parsing the definition: ANTLR recovers
            // from them and the analysis goes on, so the analysis of such an
            // object is partial and must be reported as such.
            parseErrors: [],
            // Qualified names of known objects mentioned in the module text but not
            // resolved confidently — best-effort dynamic-SQL usage (low confidence).
            possibleRefs: []
        };
    }

    async _buildCompleteIndex(database, schemaChecksum, objects, server = this._getCurrentServerName(), stats = null) {
        debug(`Building full index for database: ${database} (${objects.length} objects)`);

        const index = {
            database, server,
            formatVersion: INDEX_FORMAT_VERSION,
            lastFullIndex: new Date().toISOString(),
            schemaChecksum,
            totalObjects: 0, objectsByType: {}, objects: {}
        };

        objects.forEach(obj => {
            index.objects[this._removeBrackets(obj.qualified_name)] = this._makeIndexEntry(obj);
            index.objectsByType[obj.type] = (index.objectsByType[obj.type] || 0) + 1;
        });

        const columnRefs = {};
        const tableWrites = {};
        const possibleRefs = {};
        const parseErrors = {};
        const nameMap = this._buildNameMap(objects);
        const analysisStart = IndexBuildStats.now();
        const { dependencies, failedKeys } = await this._analyzeDependencies(database, objects, columnRefs, nameMap, possibleRefs, tableWrites, parseErrors, stats);
        if (stats) stats.phase('analysisMs', IndexBuildStats.now() - analysisStart);
        this._attachDependencies(index.objects, dependencies);
        this._attachColumnRefs(index.objects, columnRefs);
        this._attachTableWrites(index.objects, tableWrites);
        this._attachParseErrors(index.objects, parseErrors);
        this._attachPossibleRefs(index.objects, possibleRefs);
        this._markIncompleteDependencies(index.objects, failedKeys);

        index.totalObjects = Object.keys(index.objects).length;
        debug(`Index complete: ${index.totalObjects} objects`);
        return index;
    }

    // Reuse cached entries whose per-object checksum (name + type + modify_date)
    // is unchanged; only additions and modified objects get re-analyzed, and
    // entries for dropped objects are discarded.
    async _updateIndexIncrementally(database, cachedIndex, liveObjects, liveChecksum, server = this._getCurrentServerName(), stats = null) {
        const objects = {};
        const objectsByType = {};
        const changed = [];

        for (const obj of liveObjects) {
            const key = this._removeBrackets(obj.qualified_name);
            const cached = cachedIndex.objects[key];
            const checksum = this._entryChecksum(obj);
            // A previous run's dm_sql_referenced_entities call can fail because
            // it referenced an object that didn't exist YET (e.g. a stored
            // procedure created before a table it SELECTs from). Creating that
            // table later never changes the procedure's own modify_date, so
            // without this flag the empty, cached "no dependencies" result would
            // be reused forever - re-analyze flagged entries on every incremental
            // update until a run actually succeeds.
            if (cached && cached.checksum === checksum && !cached.dependenciesIncomplete) {
                objects[key] = cached;
            } else {
                objects[key] = this._makeIndexEntry(obj);
                changed.push(obj);
            }
            objectsByType[obj.type] = (objectsByType[obj.type] || 0) + 1;
        }

        const removed = Object.keys(cachedIndex.objects).filter(key => !objects[key]).length;
        debug(`Incremental index update for ${database}: ${changed.length} changed/new, ${removed} removed, ${liveObjects.length - changed.length} reused`);

        const columnRefs = {};
        const tableWrites = {};
        const possibleRefs = {};
        const parseErrors = {};
        // Name map spans ALL live objects so mentions of unchanged tables are caught.
        const nameMap = this._buildNameMap(liveObjects);
        const analysisStart = IndexBuildStats.now();
        const { dependencies, failedKeys } = await this._analyzeDependencies(database, changed, columnRefs, nameMap, possibleRefs, tableWrites, parseErrors, stats);
        if (stats) stats.phase('analysisMs', IndexBuildStats.now() - analysisStart);
        this._attachDependencies(objects, dependencies);
        this._attachColumnRefs(objects, columnRefs);
        this._attachTableWrites(objects, tableWrites);
        this._attachParseErrors(objects, parseErrors);
        this._attachPossibleRefs(objects, possibleRefs);
        this._markIncompleteDependencies(objects, failedKeys);

        return {
            database, server,
            formatVersion: INDEX_FORMAT_VERSION,
            lastFullIndex: cachedIndex.lastFullIndex,
            lastIncrementalUpdate: new Date().toISOString(),
            schemaChecksum: liveChecksum,
            totalObjects: Object.keys(objects).length,
            objectsByType,
            objects
        };
    }

    _attachDependencies(indexObjects, dependencies) {
        for (const dep of dependencies) {
            const key = this._removeBrackets(dep.object_name);
            if (indexObjects[key]) {
                indexObjects[key].dependencies.push(this._removeBrackets(dep.dependency));
            }
        }
    }

    _attachColumnRefs(indexObjects, columnRefsByKey) {
        for (const [key, refs] of Object.entries(columnRefsByKey)) {
            if (indexObjects[key]) indexObjects[key].columnRefs = refs;
        }
    }

    _attachTableWrites(indexObjects, tableWritesByKey) {
        for (const [key, writes] of Object.entries(tableWritesByKey)) {
            if (!indexObjects[key]) continue;
            indexObjects[key].tableWrites = writes.tables;
            // What is done to each table (insert, update, delete): a trigger fires on one kind.
            indexObjects[key].tableWriteOps = writes.ops;
        }
    }

    _attachParseErrors(indexObjects, parseErrorsByKey) {
        for (const [key, errors] of Object.entries(parseErrorsByKey)) {
            if (indexObjects[key]) indexObjects[key].parseErrors = errors;
        }
    }

    _attachPossibleRefs(indexObjects, possibleRefsByKey) {
        for (const [key, refs] of Object.entries(possibleRefsByKey)) {
            if (indexObjects[key]) indexObjects[key].possibleRefs = refs;
        }
    }

    // Flags entries whose dependency analysis failed this run, so the next
    // incremental update retries them instead of trusting their (empty) cached
    // dependencies forever - see the comment in _updateIndexIncrementally.
    _markIncompleteDependencies(indexObjects, failedKeys) {
        for (const key of failedKeys) {
            if (indexObjects[key]) indexObjects[key].dependenciesIncomplete = true;
        }
    }

    // lower(qualified name) -> canonical qualified name, for the possible-ref scan.
    _buildNameMap(objects) {
        const map = new Map();
        for (const o of objects) {
            const canonical = this._removeBrackets(o.qualified_name);
            if (canonical) map.set(canonical.toLowerCase(), canonical);
        }
        return map;
    }

    // One dm_sql_referenced_entities call per object - round-trip latency, not
    // server CPU, dominates this, so CONCURRENT_BATCH_SIZE objects are in
    // flight at once (the mssql pool already supports it: each call gets its
    // own Request) instead of one at a time. Progress/cancellation checkpoints
    // move from per-object to per-batch - coarser, but still frequent.
    // The same batch also returns OBJECT_DEFINITION, parsed into per-column
    // lineage (columnRefsOut, keyed by clean qualified name), table-level
    // writes (tableWritesOut) and syntax errors (parseErrorsOut) for code objects.
    async _analyzeDependencies(database, objects, columnRefsOut = null, nameMap = null, possibleRefsOut = null, tableWritesOut = null, parseErrorsOut = null, stats = null) {
        const dependencies = [];
        const failedKeys = new Set();
        const total = objects.length;
        this._reportProgress(database, 0, total, 'Analyzing dependencies...');

        for (let i = 0; i < total; i += IndexService.CONCURRENT_BATCH_SIZE) {
            if (this._builds.get(database)?.cancelRequested) {
                throw Object.assign(new Error('Indexing cancelled'), { code: 'INDEXING_CANCELLED' });
            }

            const batch = objects.slice(i, i + IndexService.CONCURRENT_BATCH_SIZE);
            const batchResults = await Promise.all(
                batch.map(obj => this._analyzeOneObject(database, obj, columnRefsOut, nameMap, possibleRefsOut, tableWritesOut, parseErrorsOut, stats))
            );
            batch.forEach((obj, idx) => {
                const { dependencies: objDependencies, depsFailed } = batchResults[idx];
                dependencies.push(...objDependencies);
                if (depsFailed) failedKeys.add(this._removeBrackets(obj.qualified_name));
            });

            const last = batch[batch.length - 1];
            this._reportProgress(database, i + batch.length, total, `${last.schema_name}.${last.name}`);
        }

        return { dependencies, failedKeys };
    }

    // One object's worth of the old per-object loop body - independent of any
    // other object's processing, so callable concurrently. Writes into the
    // shared columnRefsOut/possibleRefsOut maps under this object's own
    // (unique) key, and returns its dependency rows for the caller to merge.
    async _analyzeOneObject(database, obj, columnRefsOut, nameMap, possibleRefsOut, tableWritesOut, parseErrorsOut, stats = null) {
        const dependencies = [];
        const qualifiedName = `[${obj.schema_name}].[${obj.name}]`;
        const cleanQN = this._removeBrackets(obj.qualified_name);
        // Tables have no SQL module: skip the definition fetch entirely
        const wantsDefinition = !!columnRefsOut && obj.type !== 'U';
        let definition = null;
        // Set when dm_sql_referenced_entities itself fails (e.g. a reference to
        // an object that doesn't exist yet) - as opposed to the object simply
        // having no dependencies, which is a normal, cacheable result.
        let depsFailed = false;
        // Names this object references confidently (resolver + parser); excluded
        // from the possible-ref scan so we only flag the *extra* text mentions.
        const confidentSet = new Set();
        const measured = { name: cleanQN, type: obj.type, queryMs: 0, parseMs: 0, queueMs: 0, scanMs: 0, definitionChars: 0, parseErrors: 0, depsFailed: false };
        let queryStart = IndexBuildStats.now();
        try {
            const result = await this._connectionManager.executeQueryInDatabase(database, `
                SELECT DISTINCT
                    ISNULL(referenced_database_name + '.', '') + referenced_schema_name + '.' + referenced_entity_name AS dependency,
                    ISNULL(referenced_database_name, DB_NAME()) AS dependency_database
                FROM sys.dm_sql_referenced_entities(@objectName, N'OBJECT')
                WHERE referenced_entity_name IS NOT NULL
                  AND referenced_schema_name IS NOT NULL AND referenced_schema_name != ''
                  AND referenced_entity_name != '' AND referenced_minor_id = 0
                  -- Objects only: a user-defined type (6) or an XML schema collection (10)
                  -- that a parameter or a column uses is not code or a table to follow.
                  AND referenced_class = 1
                  -- An ambiguous reference the server could not resolve is a method call
                  -- (xml.value(), hierarchyid.GetAncestor()...), not an object.
                  AND NOT (is_ambiguous = 1 AND referenced_id IS NULL);
                ${wantsDefinition ? "SELECT OBJECT_DEFINITION(OBJECT_ID(@objectName)) AS definition;" : ''}
            `, { objectName: qualifiedName });

            for (const row of result.recordset) {
                dependencies.push({
                    object_name: qualifiedName, dependency: row.dependency,
                    type: obj.type, dependency_database: row.dependency_database
                });
                confidentSet.add(this._removeBrackets(row.dependency).toLowerCase());
            }
            definition = result.recordsets?.[1]?.[0]?.definition || null;
            measured.queryMs = IndexBuildStats.now() - queryStart;
        } catch {
            measured.queryMs = IndexBuildStats.now() - queryStart;
            // Same tolerance as the old server-side BEGIN CATCH: objects with
            // broken or unresolvable references get no dependencies recorded.
            // The definition is still worth parsing (dm_sql_referenced_entities
            // fails on broken references, the parser does not).
            depsFailed = true;
            measured.depsFailed = true;
            if (wantsDefinition) {
                queryStart = IndexBuildStats.now();
                try {
                    const fallback = await this._connectionManager.executeQueryInDatabase(database, `
                        SELECT OBJECT_DEFINITION(OBJECT_ID(@objectName)) AS definition;
                    `, { objectName: qualifiedName });
                    definition = fallback.recordset?.[0]?.definition || null;
                } catch { /* encrypted or gone - no lineage */ }
                measured.queryMs += IndexBuildStats.now() - queryStart;
            }
        }

        if (wantsDefinition && definition) {
            measured.definitionChars = definition.length;
            let analysis = null;
            const parseStart = IndexBuildStats.now();
            try {
                analysis = await this._parserPool.analyzeDefinition(definition);
            } catch (error) {
                console.warn(`[IndexService] Column parse failed for ${cleanQN}:`, error.message);
            }
            // The wait includes the time in the worker queue: the parse itself
            // is what the worker measured (not available in-process).
            const waited = IndexBuildStats.now() - parseStart;
            const parsed = analysis && typeof analysis.parseTimeMs === 'number' ? Math.min(analysis.parseTimeMs, waited) : waited;
            measured.parseMs = parsed;
            measured.queueMs = waited - parsed;
            if (analysis) {
                const refs = analysis.columns;
                const writes = analysis.writes || [];
                const errors = analysis.errors || [];
                if (refs && Object.keys(refs).length > 0) {
                    columnRefsOut[cleanQN] = refs;
                    for (const k of Object.keys(refs)) confidentSet.add(this._removeBrackets(k).toLowerCase());
                }
                // The table-level writes travel with the column lineage: a
                // DELETE or an INSERT without a column list writes a table
                // without writing any named column.
                if (writes.length > 0 && tableWritesOut) tableWritesOut[cleanQN] = { tables: writes, ops: analysis.writeOps || {} };
                // The syntax errors make the analysis partial: the tree was
                // still walked, but not everything in it could be understood.
                if (errors.length > 0 && parseErrorsOut) parseErrorsOut[cleanQN] = errors;
                measured.parseErrors = errors.length;
            }
            // Best-effort dynamic-SQL scan: qualified names of known objects in
            // the text that weren't resolved confidently above.
            if (nameMap && possibleRefsOut) {
                const scanStart = IndexBuildStats.now();
                const possible = this._scanPossibleRefs(definition, nameMap, cleanQN.toLowerCase(), confidentSet);
                if (possible.length) possibleRefsOut[cleanQN] = possible;
                measured.scanMs = IndexBuildStats.now() - scanStart;
            }
        }

        if (stats) stats.recordObject(measured);
        return { dependencies, depsFailed };
    }

    /**
     * Column-level impact: which indexed objects reference the columns of a
     * table? Pure in-memory scan of the parser lineage stored in the index.
     * Returns { columnName: [{ object, type, write, confident }] } (lowercase keys).
     */
    async getColumnUsage(database, tableName) {
        const index = await this.peekIndex(database);
        if (!index) return null; // not built: unavailable, which is not "no references"
        const clean = this._removeBrackets(tableName).toLowerCase();
        const bare = clean.split('.').pop();

        const usage = {};
        for (const obj of Object.values(index.objects || {})) {
            if (!obj.columnRefs) continue;
            for (const [refTable, cols] of Object.entries(obj.columnRefs)) {
                // Qualified refs must match exactly; bare refs (implicit schema
                // in the source SQL) match on the last segment, same tradeoff
                // as the operations lookup in DependencyService.
                const matches = refTable === clean || (!refTable.includes('.') && refTable === bare);
                if (!matches) continue;
                for (const [column, info] of Object.entries(cols)) {
                    if (!usage[column]) usage[column] = [];
                    usage[column].push({
                        object: obj.qualifiedName,
                        type: obj.type,
                        write: !!info.write,
                        confident: !!info.confident
                    });
                }
            }
        }
        return usage;
    }

    // Scan raw module text for qualified (schema.name) mentions of known objects
    // that were not resolved confidently — catches names that only appear inside
    // dynamic-SQL strings. Bracket-insensitive; qualified-only to limit false
    // positives (a bare word collides with columns/aliases/variables).
    _scanPossibleRefs(definition, nameMap, selfKey, confidentSet) {
        const text = definition.replace(/[[\]]/g, '');
        const re = /[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*/g;
        const found = new Set();
        let m;
        while ((m = re.exec(text)) !== null) {
            const key = m[0].toLowerCase();
            if (key === selfKey || confidentSet.has(key)) continue;
            const canonical = nameMap.get(key);
            if (canonical) found.add(canonical);
        }
        return [...found];
    }

    _removeBrackets(name) {
        if (!name) return name;
        return name.replace(/\[|\]/g, '');
    }

    _calculateChecksum(content) {
        if (!content) return null;
        return crypto.createHash('md5').update(content).digest('hex');
    }

    _getCurrentServerName() { return this._connectionManager.getServerName(); }

    // Server and database are separate path segments (not concatenated into
    // one filename) so e.g. server "SERVER\INSTANCE" + db "MyDb" can never
    // collide with server "SERVER" + db "INSTANCE_MyDb" - slug() alone can't
    // tell those apart once joined into a single string.
    //
    // A segment that is made of dots only (".." or ".") is turned into "_":
    // it would otherwise walk out of the cache folder.
    _getIndexFilePath(database, server = this._getCurrentServerName()) {
        return path.join(this._indexDir, IndexService._pathSegment(server), `${IndexService._pathSegment(database)}.json`);
    }

    // Where the index files were written before the server became its own
    // path segment: one file per server+database, named "<server>_<db>.json".
    _legacyIndexFilePath(database, server = this._getCurrentServerName()) {
        const slug = name => (name || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
        return path.join(this._indexDir, `${slug(server)}_${slug(database)}.json`);
    }

    // A name that is safe as one segment of a path.
    static _pathSegment(name) {
        return (name || '').replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/^\.+$/, '_');
    }

    // Moves an index cached under the old file name to its new place, the
    // first time it is used. Without it every index written before the path
    // change became invisible at the update, and the extension silently
    // rebuilt all of them - which on a big database means minutes of
    // indexing the user never asked for.
    async _migrateLegacyIndexFile(database, server = this._getCurrentServerName()) {
        const indexFile = this._getIndexFilePath(database, server);
        const legacyFile = this._legacyIndexFilePath(database, server);
        if (indexFile === legacyFile) return indexFile;

        try {
            await fs.access(indexFile);
            return indexFile; // already at the new place
        } catch { /* not there yet */ }

        try {
            await fs.access(legacyFile);
        } catch {
            return indexFile; // nothing to migrate
        }

        try {
            await this._ensureIndexDir(path.dirname(indexFile));
            await fs.rename(legacyFile, indexFile);
            debug(`Migrated index cache ${legacyFile} -> ${indexFile}`);
        } catch (error) {
            // Not fatal: the index is simply rebuilt from scratch.
            console.warn(`Could not migrate the index cache ${legacyFile}: ${error.message}`);
        }
        return indexFile;
    }

    async _ensureIndexDir(dir = this._indexDir) {
        try { await fs.mkdir(dir, { recursive: true }); } catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
    }

    async _loadIndex(indexFile) {
        try {
            const data = JSON.parse(await fs.readFile(indexFile, 'utf8'));
            // Older formats lack per-object columnRefs: treat as no index so
            // every read path (getIndex, getIndexStats) triggers/report rebuild
            if (data.formatVersion !== INDEX_FORMAT_VERSION) {
                debug(`Index format ${data.formatVersion || 1} != ${INDEX_FORMAT_VERSION} for ${data.database}, ignoring cached file`);
                return null;
            }
            let dirty = false;
            for (const obj of Object.values(data.objects || {})) {
                if (obj.type && obj.type !== obj.type.trim()) {
                    obj.type = obj.type.trim();
                    dirty = true;
                }
            }
            if (dirty) await this._saveIndex(indexFile, data);
            debug(`Loaded existing index for ${data.database}: ${Object.keys(data.objects || {}).length} objects`);
            return data;
        } catch (error) {
            if (error.code !== 'ENOENT') console.warn('Failed to load index:', error.message);
            return null;
        }
    }

    _statsFilePath(indexFile) {
        // Its own folder: no database name can collide with it.
        return path.join(path.dirname(indexFile), '_stats', path.basename(indexFile));
    }

    // Keeps the figures of this build next to the index. Never fails the build.
    async _recordStats(indexFile, stats, index, before) {
        try {
            const total = Object.keys(index.objects || {}).length;
            const cachedBefore = before && before.objects ? before.objects : {};
            const removed = Object.keys(cachedBefore).filter(key => !(index.objects || {})[key]).length;
            const run = stats.finish({ totalObjects: total, reusedObjects: Math.max(0, total - stats._objects.length), removedObjects: removed });
            run.parserThreads = this._parserPool.threadCount ? this._parserPool.threadCount() : 0;
            const file = this._statsFilePath(indexFile);
            await fs.mkdir(path.dirname(file), { recursive: true });
            let history = null;
            try { history = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* first run */ }
            // Atomic too: the history of the builds must not be truncated by
            // an interrupted write.
            const temporary = temporaryPath(file);
            try {
                await fs.writeFile(temporary, JSON.stringify(addRun(history, run), null, 2), 'utf8');
                await fs.rename(temporary, file);
            } catch (error) {
                // The temporary file must not be left behind.
                await fs.unlink(temporary).catch(() => {});
                throw error;
            }
        } catch (error) {
            console.warn('Could not record the index statistics:', error.message);
        }
    }

    // The recorded builds of a database, latest first: { runs: [...] }.
    // Reads only.
    async getBuildStats(database) {
        const file = this._statsFilePath(this._getIndexFilePath(database));
        try {
            return JSON.parse(await fs.readFile(file, 'utf8'));
        } catch {
            return { runs: [] };
        }
    }

    async _saveIndex(indexFile, index) {
        try {
            // Written to a temporary file and renamed: a rename is atomic on
            // the same file system, so an interrupted write never leaves a
            // half-written index behind (which would only be read back as a
            // cache to rebuild - minutes of indexing the user never asked
            // for).
            const temporary = temporaryPath(indexFile);
            try {
                await fs.writeFile(temporary, JSON.stringify(index, null, 2), 'utf8');
                await fs.rename(temporary, indexFile);
                debug(`Saved index for ${index.database}: ${Object.keys(index.objects || {}).length} objects`);
            } catch (error) {
                // The temporary file must not be left behind.
                await fs.unlink(temporary).catch(() => {});
                throw error;
            }
        } catch (error) {
            console.error('Failed to save index:', error.message);
            throw error;
        }
    }


}

module.exports = IndexService;
