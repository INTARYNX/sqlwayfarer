'use strict';

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const BabelfishSqlParser = require('./BabelfishSqlParser');

// Bumped when the index entry shape changes (2 = columnRefs for column lineage,
// 3 = possibleRefs from the dynamic-SQL name scan); older cached files rebuild.
const INDEX_FORMAT_VERSION = 3;

class IndexService {
    constructor(connectionManager, databaseService) {
        this._connectionManager = connectionManager;
        this._databaseService = databaseService;
        this._sqlParser = new BabelfishSqlParser();
        this._sqlParser.setEnabled(true);
        this._indexDir = path.join(os.homedir(), '.vscode', 'sqlwayfarer', 'indexes');
        this._currentServer = null;
        this._progressCallback = null;
        this._cancelRequested = false;
        this._lastReportedPct = -1;
    }

    // Ask the running indexing loop to stop at the next per-object checkpoint.
    requestCancel() {
        this._cancelRequested = true;
    }

    // Throttled: only posts when the integer percentage actually changes.
    _reportProgress(current, total, message) {
        if (!this._progressCallback) return;
        const progress = total === 0 ? 100 : Math.round((current / total) * 100);
        if (progress === this._lastReportedPct && current !== total) return;
        this._lastReportedPct = progress;
        try {
            this._progressCallback({ progress, current, total, message });
        } catch (error) {
            console.warn('Progress callback failed:', error.message);
        }
    }

    // Concurrent calls for the same database (background indexing + a details
    // click asking for dependencies or column usage) share one in-flight
    // promise: without this, a second call would reset _progressCallback /
    // _cancelRequested mid-build and could run a duplicate full rebuild.
    async getIndex(database, progressCallback = null) {
        if (this._inFlight && this._inFlightDatabase === database) {
            return this._inFlight;
        }

        this._inFlightDatabase = database;
        this._inFlight = this._getIndexInternal(database, progressCallback);
        try {
            return await this._inFlight;
        } finally {
            this._inFlight = null;
            this._inFlightDatabase = null;
        }
    }

    async _getIndexInternal(database, progressCallback) {
        this._progressCallback = progressCallback;
        this._cancelRequested = false;
        this._currentServer = this._getCurrentServerName();
        await this._ensureIndexDir();

        const indexFile = this._getIndexFilePath(database);
        const liveObjects = await this._getLiveObjects(database);
        const liveChecksum = this._checksumFromObjects(liveObjects);
        let index = await this._loadIndex(indexFile);

        if (!index || index.schemaChecksum !== liveChecksum) {
            // With a cached index, only re-analyze objects whose modify_date changed
            // (plus additions/removals) instead of rebuilding everything.
            index = index
                ? await this._updateIndexIncrementally(database, index, liveObjects, liveChecksum)
                : await this._buildCompleteIndex(database, liveChecksum, liveObjects);
            await this._saveIndex(indexFile, index);
        }
        return index;
    }

    async forceReindex(database, progressCallback = null) {
        console.log(`Force reindexing database: ${database}`);
        this._progressCallback = progressCallback;
        this._cancelRequested = false;
        this._currentServer = this._getCurrentServerName();
        await this._ensureIndexDir();

        const indexFile = this._getIndexFilePath(database);
        try { await fs.unlink(indexFile); } catch { /* file may not exist yet */ }

        const liveObjects = await this._getLiveObjects(database);
        const index = await this._buildCompleteIndex(database, this._checksumFromObjects(liveObjects), liveObjects);
        await this._saveIndex(indexFile, index);
        console.log(`Force reindex complete for ${database}`);
        return index;
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

    async _buildCompleteIndex(database, schemaChecksum, objects) {
        console.log(`Building full index for database: ${database} (${objects.length} objects)`);

        const index = {
            database, server: this._currentServer,
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
        this._attachDependencies(index.objects, await this._analyzeDependencies(database, objects, columnRefs, nameMap, possibleRefs));
        this._attachColumnRefs(index.objects, columnRefs);
        this._attachPossibleRefs(index.objects, possibleRefs);

        index.totalObjects = Object.keys(index.objects).length;
        console.log(`Index complete: ${index.totalObjects} objects`);
        return index;
    }

    // Reuse cached entries whose per-object checksum (name + type + modify_date)
    // is unchanged; only additions and modified objects get re-analyzed, and
    // entries for dropped objects are discarded.
    async _updateIndexIncrementally(database, cachedIndex, liveObjects, liveChecksum) {
        const objects = {};
        const objectsByType = {};
        const changed = [];

        for (const obj of liveObjects) {
            const key = this._removeBrackets(obj.qualified_name);
            const cached = cachedIndex.objects[key];
            const checksum = this._calculateChecksum(`${obj.qualified_name}_${obj.type}_${obj.modify_date}`);
            if (cached && cached.checksum === checksum) {
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
        this._attachDependencies(objects, await this._analyzeDependencies(database, changed, columnRefs, nameMap, possibleRefs));
        this._attachColumnRefs(objects, columnRefs);
        this._attachPossibleRefs(objects, possibleRefs);

        return {
            database, server: this._currentServer,
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

    // lower(qualified name) -> canonical qualified name, for the possible-ref scan.
    _buildNameMap(objects) {
        const map = new Map();
        for (const o of objects) {
            const canonical = this._removeBrackets(o.qualified_name);
            if (canonical) map.set(canonical.toLowerCase(), canonical);
        }
        return map;
    }

    // One dm_sql_referenced_entities call per object, driven from Node instead of
    // a single server-side cursor batch: this gives a real per-object progress
    // bar and a cancellation checkpoint between every object.
    // The same batch also returns OBJECT_DEFINITION, parsed into per-column
    // lineage (columnRefsOut, keyed by clean qualified name) for code objects.
    async _analyzeDependencies(database, objects, columnRefsOut = null, nameMap = null, possibleRefsOut = null) {
        const dependencies = [];
        const total = objects.length;
        this._lastReportedPct = -1;
        this._reportProgress(0, total, 'Analyzing dependencies...');

        for (let i = 0; i < total; i++) {
            if (this._cancelRequested) {
                throw Object.assign(new Error('Indexing cancelled'), { code: 'INDEXING_CANCELLED' });
            }

            const obj = objects[i];
            const qualifiedName = `[${obj.schema_name}].[${obj.name}]`;
            const cleanQN = this._removeBrackets(obj.qualified_name);
            // Tables have no SQL module: skip the definition fetch entirely
            const wantsDefinition = !!columnRefsOut && obj.type !== 'U';
            let definition = null;
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
                const refs = this._sqlParser.analyzeColumns(definition);
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

            this._reportProgress(i + 1, total, `${obj.schema_name}.${obj.name}`);
        }

        return dependencies;
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

    _getIndexFilePath(database) {
        const slug = name => (name || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
        return path.join(this._indexDir, `${slug(this._currentServer)}_${slug(database)}.json`);
    }

    async _ensureIndexDir() {
        try { await fs.mkdir(this._indexDir, { recursive: true }); } catch (error) {
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
