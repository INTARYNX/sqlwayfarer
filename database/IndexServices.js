'use strict';

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const ParserWorkerPool = require('./ParserWorkerPool');

// Bumped when the index entry shape changes (2 = columnRefs for column lineage,
// 3 = possibleRefs from the dynamic-SQL name scan); older cached files rebuild.
const INDEX_FORMAT_VERSION = 3;

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

    // Concurrent calls for the same database (background indexing + a details
    // click asking for dependencies or column usage) share one in-flight
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
        const indexFile = this._getIndexFilePath(database, build.server);
        await this._ensureIndexDir(path.dirname(indexFile));

        const liveObjects = await this._getLiveObjects(database);
        const liveChecksum = this._checksumFromObjects(liveObjects);
        let index = await this._loadIndex(indexFile);

        if (!index || index.schemaChecksum !== liveChecksum) {
            // With a cached index, only re-analyze objects whose modify_date changed
            // (plus additions/removals) instead of rebuilding everything.
            index = index
                ? await this._updateIndexIncrementally(database, index, liveObjects, liveChecksum, build.server)
                : await this._buildCompleteIndex(database, liveChecksum, liveObjects, build.server);
            await this._saveIndex(indexFile, index);
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

        console.log(`Force reindexing database: ${database}`);
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
        try { await fs.unlink(indexFile); } catch { /* file may not exist yet */ }

        const liveObjects = await this._getLiveObjects(database);
        const index = await this._buildCompleteIndex(database, this._checksumFromObjects(liveObjects), liveObjects, build.server);
        await this._saveIndex(indexFile, index);
        console.log(`Force reindex complete for ${database}`);
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
        try {
            await fs.unlink(indexFile);
            console.log(`Cleared index for ${database}`);
        } catch (error) {
            if (error.code !== 'ENOENT') console.warn(`Failed to clear index for ${database}:`, error.message);
        }
    }

    async getIndexStats(database) {
        const indexFile = this._getIndexFilePath(database);
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
        const index = await this.getIndex(database);
        const obj = index.objects[this._removeBrackets(objectName)];
        return obj?.dependencies || [];
    }

    async findDependents(database, targetObject) {
        const index = await this.getIndex(database);
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

    // Same formula as the historical checksum query (sorted by object_id) so
    // indexes cached by previous versions stay valid after the upgrade.
    _checksumFromObjects(objects) {
        const raw = [...objects]
            .sort((a, b) => a.object_id - b.object_id)
            .map(o => `${o.object_id}:${o.modify_date}`)
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
            checksum: this._calculateChecksum(`${obj.qualified_name}_${obj.type}_${obj.modify_date}`),
            dependencies: [],
            // { tableKey: { columnName: { write, confident } } } from the parser
            columnRefs: {},
            // Qualified names of known objects mentioned in the module text but not
            // resolved confidently — best-effort dynamic-SQL usage (low confidence).
            possibleRefs: []
        };
    }

    async _buildCompleteIndex(database, schemaChecksum, objects, server = this._getCurrentServerName()) {
        console.log(`Building full index for database: ${database} (${objects.length} objects)`);

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
        const possibleRefs = {};
        const nameMap = this._buildNameMap(objects);
        const { dependencies, failedKeys } = await this._analyzeDependencies(database, objects, columnRefs, nameMap, possibleRefs);
        this._attachDependencies(index.objects, dependencies);
        this._attachColumnRefs(index.objects, columnRefs);
        this._attachPossibleRefs(index.objects, possibleRefs);
        this._markIncompleteDependencies(index.objects, failedKeys);

        index.totalObjects = Object.keys(index.objects).length;
        console.log(`Index complete: ${index.totalObjects} objects`);
        return index;
    }

    // Reuse cached entries whose per-object checksum (name + type + modify_date)
    // is unchanged; only additions and modified objects get re-analyzed, and
    // entries for dropped objects are discarded.
    async _updateIndexIncrementally(database, cachedIndex, liveObjects, liveChecksum, server = this._getCurrentServerName()) {
        const objects = {};
        const objectsByType = {};
        const changed = [];

        for (const obj of liveObjects) {
            const key = this._removeBrackets(obj.qualified_name);
            const cached = cachedIndex.objects[key];
            const checksum = this._calculateChecksum(`${obj.qualified_name}_${obj.type}_${obj.modify_date}`);
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
        console.log(`Incremental index update for ${database}: ${changed.length} changed/new, ${removed} removed, ${liveObjects.length - changed.length} reused`);

        const columnRefs = {};
        const possibleRefs = {};
        // Name map spans ALL live objects so mentions of unchanged tables are caught.
        const nameMap = this._buildNameMap(liveObjects);
        const { dependencies, failedKeys } = await this._analyzeDependencies(database, changed, columnRefs, nameMap, possibleRefs);
        this._attachDependencies(objects, dependencies);
        this._attachColumnRefs(objects, columnRefs);
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
    // lineage (columnRefsOut, keyed by clean qualified name) for code objects.
    async _analyzeDependencies(database, objects, columnRefsOut = null, nameMap = null, possibleRefsOut = null) {
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
                batch.map(obj => this._analyzeOneObject(database, obj, columnRefsOut, nameMap, possibleRefsOut))
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
    async _analyzeOneObject(database, obj, columnRefsOut, nameMap, possibleRefsOut) {
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
        try {
            const result = await this._connectionManager.executeQueryInDatabase(database, `
                SELECT DISTINCT
                    ISNULL(referenced_database_name + '.', '') + referenced_schema_name + '.' + referenced_entity_name AS dependency,
                    ISNULL(referenced_database_name, DB_NAME()) AS dependency_database
                FROM sys.dm_sql_referenced_entities(@objectName, N'OBJECT')
                WHERE referenced_entity_name IS NOT NULL
                  AND referenced_schema_name IS NOT NULL AND referenced_schema_name != ''
                  AND referenced_entity_name != '' AND referenced_minor_id = 0;
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
        } catch {
            // Same tolerance as the old server-side BEGIN CATCH: objects with
            // broken or unresolvable references get no dependencies recorded.
            // The definition is still worth parsing (dm_sql_referenced_entities
            // fails on broken references, the parser does not).
            depsFailed = true;
            if (wantsDefinition) {
                try {
                    const fallback = await this._connectionManager.executeQueryInDatabase(database, `
                        SELECT OBJECT_DEFINITION(OBJECT_ID(@objectName)) AS definition;
                    `, { objectName: qualifiedName });
                    definition = fallback.recordset?.[0]?.definition || null;
                } catch { /* encrypted or gone - no lineage */ }
            }
        }

        if (wantsDefinition && definition) {
            let refs = null;
            try {
                refs = await this._parserPool.analyzeColumns(definition);
            } catch (error) {
                console.warn(`[IndexService] Column parse failed for ${cleanQN}:`, error.message);
            }
            if (refs && Object.keys(refs).length > 0) {
                columnRefsOut[cleanQN] = refs;
                for (const k of Object.keys(refs)) confidentSet.add(this._removeBrackets(k).toLowerCase());
            }
            // Best-effort dynamic-SQL scan: qualified names of known objects in
            // the text that weren't resolved confidently above.
            if (nameMap && possibleRefsOut) {
                const possible = this._scanPossibleRefs(definition, nameMap, cleanQN.toLowerCase(), confidentSet);
                if (possible.length) possibleRefsOut[cleanQN] = possible;
            }
        }

        return { dependencies, depsFailed };
    }

    /**
     * Column-level impact: which indexed objects reference the columns of a
     * table? Pure in-memory scan of the parser lineage stored in the index.
     * Returns { columnName: [{ object, type, write, confident }] } (lowercase keys).
     */
    async getColumnUsage(database, tableName) {
        const index = await this.getIndex(database);
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
    _getIndexFilePath(database, server = this._getCurrentServerName()) {
        const slug = name => (name || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
        return path.join(this._indexDir, slug(server), `${slug(database)}.json`);
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
                console.log(`Index format ${data.formatVersion || 1} != ${INDEX_FORMAT_VERSION} for ${data.database}, ignoring cached file`);
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
            console.log(`Loaded existing index for ${data.database}: ${Object.keys(data.objects || {}).length} objects`);
            return data;
        } catch (error) {
            if (error.code !== 'ENOENT') console.warn('Failed to load index:', error.message);
            return null;
        }
    }

    async _saveIndex(indexFile, index) {
        try {
            await fs.writeFile(indexFile, JSON.stringify(index, null, 2), 'utf8');
            console.log(`Saved index for ${index.database}: ${Object.keys(index.objects || {}).length} objects`);
        } catch (error) {
            console.error('Failed to save index:', error.message);
            throw error;
        }
    }


}

module.exports = IndexService;
