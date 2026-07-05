'use strict';

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

class IndexService {
    constructor(connectionManager, databaseService) {
        this._connectionManager = connectionManager;
        this._databaseService = databaseService;
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

    async getIndex(database, progressCallback = null) {
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
            dependencies: []
        };
    }

    async _buildCompleteIndex(database, schemaChecksum, objects) {
        console.log(`Building full index for database: ${database} (${objects.length} objects)`);

        const index = {
            database, server: this._currentServer,
            lastFullIndex: new Date().toISOString(),
            schemaChecksum,
            totalObjects: 0, objectsByType: {}, objects: {}
        };

        objects.forEach(obj => {
            index.objects[this._removeBrackets(obj.qualified_name)] = this._makeIndexEntry(obj);
            index.objectsByType[obj.type] = (index.objectsByType[obj.type] || 0) + 1;
        });

        this._attachDependencies(index.objects, await this._analyzeDependencies(database, objects));

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

        this._attachDependencies(objects, await this._analyzeDependencies(database, changed));

        return {
            database, server: this._currentServer,
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

    // One dm_sql_referenced_entities call per object, driven from Node instead of
    // a single server-side cursor batch: this gives a real per-object progress
    // bar and a cancellation checkpoint between every object.
    async _analyzeDependencies(database, objects) {
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
            try {
                const result = await this._connectionManager.executeQueryInDatabase(database, `
                    SELECT DISTINCT
                        ISNULL(referenced_database_name + '.', '') + referenced_schema_name + '.' + referenced_entity_name AS dependency,
                        ISNULL(referenced_database_name, DB_NAME()) AS dependency_database
                    FROM sys.dm_sql_referenced_entities(@objectName, N'OBJECT')
                    WHERE referenced_entity_name IS NOT NULL
                      AND referenced_schema_name IS NOT NULL AND referenced_schema_name != ''
                      AND referenced_entity_name != '' AND referenced_minor_id = 0
                `, { objectName: qualifiedName });

                for (const row of result.recordset) {
                    dependencies.push({
                        object_name: qualifiedName, dependency: row.dependency,
                        type: obj.type, dependency_database: row.dependency_database
                    });
                }
            } catch {
                // Same tolerance as the old server-side BEGIN CATCH: objects with
                // broken or unresolvable references get no dependencies recorded.
            }

            this._reportProgress(i + 1, total, `${obj.schema_name}.${obj.name}`);
        }

        return dependencies;
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
