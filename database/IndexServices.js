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
    }

    async getIndex(database, progressCallback = null) {
        this._progressCallback = progressCallback;
        this._currentServer = this._getCurrentServerName();
        await this._ensureIndexDir();

        const indexFile = this._getIndexFilePath(database);
        let index = await this._loadIndex(indexFile);
        if (!index) {
            index = await this._buildCompleteIndex(database);
            await this._saveIndex(indexFile, index);
        }
        return index;
    }

    async forceReindex(database, progressCallback = null) {
        console.log(`Force reindexing database: ${database}`);
        this._progressCallback = progressCallback;
        this._currentServer = this._getCurrentServerName();
        await this._ensureIndexDir();

        const indexFile = this._getIndexFilePath(database);
        try { await fs.unlink(indexFile); } catch { /* file may not exist yet */ }

        const index = await this._buildCompleteIndex(database);
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

    async _buildCompleteIndex(database) {
        console.log(`Building index for database: ${database}`);

        const index = {
            database, server: this._currentServer,
            lastFullIndex: new Date().toISOString(),
            totalObjects: 0, objectsByType: {}, objects: {}
        };

        const result = await this._getObjectsAndDependencies(database);
        console.log(`Found ${result.objects.length} objects, ${result.dependencies.length} dependencies`);

        result.objects.forEach(obj => {
            const key = this._removeBrackets(obj.qualified_name);
            index.objects[key] = {
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
            index.objectsByType[obj.type] = (index.objectsByType[obj.type] || 0) + 1;
        });

        result.dependencies.forEach(dep => {
            const key = this._removeBrackets(dep.object_name);
            if (index.objects[key]) {
                index.objects[key].dependencies.push(this._removeBrackets(dep.dependency));
            }
        });

        let objectsWithDeps = 0;
        Object.entries(index.objects).forEach(([key, obj]) => {
            if (obj.dependencies?.length > 0) {
                objectsWithDeps++;
                if (objectsWithDeps <= 5) console.log(`${key} depends on: ${obj.dependencies.join(', ')}`);
            }
        });
        if (objectsWithDeps > 5) console.log(`... and ${objectsWithDeps - 5} more objects with dependencies`);

        index.totalObjects = Object.keys(index.objects).length;
        console.log(`Index complete: ${index.totalObjects} objects, ${objectsWithDeps} with dependencies`);
        return index;
    }

    async _getObjectsAndDependencies(database) {
        const objectsResult = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT
                o.object_id, o.name,
                s.name AS schema_name,
                s.name + '.' + o.name AS qualified_name,
                o.type, o.type_desc, o.create_date, o.modify_date,
                DB_NAME() as database_name
            FROM sys.objects o
            INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
            WHERE o.is_ms_shipped = 0 AND o.type IN ('U', 'P', 'FN', 'IF', 'TF', 'TR', 'V')
            ORDER BY o.type, s.name, o.name;
        `);

        const dependenciesResult = await this._connectionManager.executeQuery(`
            USE [${database}];
            CREATE TABLE #Dependencies (object_name SYSNAME, dependency SYSNAME, type SYSNAME, dependency_database SYSNAME);
            DECLARE @schema_name SYSNAME, @object_name SYSNAME, @type SYSNAME, @qualified_name NVARCHAR(512), @sql NVARCHAR(MAX);
            DECLARE object_cursor CURSOR FOR
                SELECT s.name, o.name, o.type FROM sys.objects o
                JOIN sys.schemas s ON o.schema_id = s.schema_id
                WHERE o.is_ms_shipped = 0 AND o.type IN ('U', 'P', 'FN', 'IF', 'TF', 'TR', 'V');
            OPEN object_cursor;
            FETCH NEXT FROM object_cursor INTO @schema_name, @object_name, @type;
            WHILE @@FETCH_STATUS = 0
            BEGIN
                SET @qualified_name = QUOTENAME(@schema_name) + '.' + QUOTENAME(@object_name);
                SET @sql = '
                INSERT INTO #Dependencies (object_name, dependency, type, dependency_database)
                SELECT ''' + @qualified_name + ''',
                       ISNULL(referenced_database_name + ''.'', '''') + referenced_schema_name + ''.'' + referenced_entity_name,
                       ''' + @type + ''',
                       ISNULL(referenced_database_name, DB_NAME())
                FROM sys.dm_sql_referenced_entities(N''' + @qualified_name + ''', N''OBJECT'')
                WHERE referenced_entity_name IS NOT NULL
                  AND referenced_schema_name IS NOT NULL AND referenced_schema_name != ''''
                  AND referenced_entity_name != '''' AND referenced_minor_id = 0;';
                BEGIN TRY EXEC sp_executesql @sql; END TRY
                BEGIN CATCH END CATCH
                FETCH NEXT FROM object_cursor INTO @schema_name, @object_name, @type;
            END
            CLOSE object_cursor; DEALLOCATE object_cursor;
            SELECT DISTINCT object_name, type, dependency, dependency_database FROM #Dependencies
            ORDER BY type, object_name, dependency;
            DROP TABLE #Dependencies;
        `);

        return {
            objects: objectsResult.recordset.map(row => ({
                object_id: row.object_id, name: row.name, schema_name: row.schema_name,
                qualified_name: row.qualified_name, type: (row.type || '').trim(),
                type_desc: row.type_desc, create_date: row.create_date,
                modify_date: row.modify_date, database_name: row.database_name
            })),
            dependencies: dependenciesResult.recordset.map(row => ({
                object_name: row.object_name, dependency: row.dependency,
                type: row.type, dependency_database: row.dependency_database
            }))
        };
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
        return path.join(this._indexDir, `${this._currentServer}_${database}.json`);
    }

    async _ensureIndexDir() {
        try { await fs.mkdir(this._indexDir, { recursive: true }); } catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
    }

    async _loadIndex(indexFile) {
        try {
            const data = JSON.parse(await fs.readFile(indexFile, 'utf8'));
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
