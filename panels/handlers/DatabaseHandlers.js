'use strict';

class DatabaseHandlers {
    constructor(postMessage, databaseService, dependencyService, indexService, getCurrentDatabase) {
        this._post = postMessage;
        this._databaseService = databaseService;
        this._dependencyService = dependencyService;
        this._indexService = indexService;
        this._getCurrentDatabase = getCurrentDatabase;
    }

    async handleGetDatabases() {
        try {
            const databases = await this._databaseService.getDatabases();
            this._post({ command: 'databasesLoaded', databases });

            // Ne PAS effacer l'index de la base courante ici : getDatabases est
            // appelé à chaque (re)connexion, et _currentSelectedDatabase reste
            // renseigné après une déconnexion. Effacer relançait une
            // réindexation complète d'une grosse base pourtant déjà en cache.
            // La péremption est déjà gérée par getIndex via le checksum de schéma
            // (mise à jour incrémentale), le cache persistant n'a jamais besoin
            // d'être jeté simplement parce qu'on liste les bases.
            this._post({ command: 'requestCurrentDatabase' });
        } catch (error) {
            this._post({ command: 'error', message: `Failed to get databases: ${error.message}` });
        }
    }

    async handleGetObjects(database) {
        try {
            console.log(`Getting objects for database: ${database}`);
            const objects = await this._databaseService.getObjects(database);
            this._post({ command: 'objectsLoaded', objects });
            console.log(`Loaded ${objects.length} objects for database: ${database}`);

            // Best-effort follow-up: sys.dm_db_partition_stats needs VIEW
            // DATABASE STATE - without it the list simply shows no badges.
            try {
                const stats = await this._databaseService.getAllTableStats(database);
                this._post({ command: 'tableStatsLoaded', database, stats });
            } catch (statsError) {
                console.warn('Failed to get table stats:', statsError.message);
            }
        } catch (error) {
            console.error('Error getting objects:', error);
            this._post({ command: 'error', message: `Failed to get objects: ${error.message}` });
        }
    }

    // Full-text search in object definitions for the Explorer "in code" scope
    async handleSearchDefinitions(database, searchText) {
        try {
            const objects = await this._databaseService.searchInDefinitions(database, searchText);
            this._post({ command: 'definitionSearchResult', searchText, objects });
        } catch (error) {
            console.error('Definition search failed:', error);
            this._post({ command: 'definitionSearchResult', searchText, objects: [] });
        }
    }

    // Column list for the query tool autocompletion. Best-effort: on failure we
    // return an empty list instead of surfacing an error popup mid-typing.
    async handleGetObjectColumns(database, objectName) {
        try {
            const columns = await this._databaseService.getObjectColumns(database, objectName);
            this._post({ command: 'objectColumnsLoaded', objectName, columns });
        } catch (error) {
            console.warn('Failed to get columns for autocomplete:', error.message);
            this._post({ command: 'objectColumnsLoaded', objectName, columns: [] });
        }
    }

    async handleGetTableDetails(database, tableName) {
        try {
            // Independent reads run in parallel: the mssql pool serves each
            // request on its own connection with its own USE prefix. Stats are
            // best-effort (allocation metadata may need missing permissions).
            const [tableDetails, dependencies, stats] = await Promise.all([
                this._databaseService.getTableDetails(database, tableName),
                this._dependencyService.getDependencies(database, tableName),
                this._databaseService.getTableStats(database, tableName).catch(statsError => {
                    console.warn(`Failed to get table stats for ${tableName}:`, statsError.message);
                    return null;
                })
            ]);

            this._post({
                command: 'tableDetailsLoaded',
                tableName,
                columns: tableDetails.columns,
                indexes: tableDetails.indexes,
                foreignKeys: tableDetails.foreignKeys,
                dependencies,
                stats
            });
        } catch (error) {
            this._post({ command: 'error', message: `Failed to get table details: ${error.message}` });
        }
    }

    async handleGetObjectDetails(database, objectName, objectType) {
        try {
            const objectInfo = await this._databaseService.getObjectInfo(database, objectName);
            const dependencies = await this._dependencyService.getDependencies(database, objectName);
            let definition = null;
            if (objectType !== 'Table') {
                definition = await this._databaseService.getObjectDefinition(database, objectName);
            }
            this._post({ command: 'objectDetailsLoaded', objectName, objectType, objectInfo, dependencies, definition });
        } catch (error) {
            this._post({ command: 'error', message: `Failed to get object details: ${error.message}` });
        }
    }

    async handleSearchObjects(database, searchPattern, objectTypes) {
        try {
            const objects = await this._databaseService.searchObjects(database, searchPattern, objectTypes);
            this._post({ command: 'searchObjectsResult', objects });
        } catch (error) {
            this._post({ command: 'error', message: `Failed to search objects: ${error.message}` });
        }
    }

    async handleGetTableRowCount(database, tableName) {
        try {
            const rowCount = await this._databaseService.getTableRowCount(database, tableName);
            this._post({ command: 'tableRowCountResult', tableName, rowCount });
        } catch (error) {
            this._post({ command: 'error', message: `Failed to get table row count: ${error.message}` });
        }
    }

    async handleGetTableSampleData(database, tableName, limit = 100) {
        try {
            const sampleData = await this._databaseService.getTableSampleData(database, tableName, limit);
            this._post({ command: 'tableSampleDataResult', tableName, sampleData });
        } catch (error) {
            this._post({ command: 'error', message: `Failed to get table sample data: ${error.message}` });
        }
    }

    // Column lineage from the in-memory index. If indexing is in flight the
    // lookup awaits it (getIndex dedups concurrent calls). usage: null means
    // "unavailable" so the UI can distinguish it from "no references".
    async handleGetColumnUsage(database, tableName) {
        try {
            const usage = await this._indexService.getColumnUsage(database, tableName);
            this._post({ command: 'columnUsageResult', tableName, usage });
        } catch (error) {
            console.warn('Column usage lookup failed:', error.message);
            this._post({ command: 'columnUsageResult', tableName, usage: null });
        }
    }

    async handleGetDependencyTree(database, objectName, maxDepth = 3) {
        try {
            const dependencyTree = await this._dependencyService.getDependencyTree(database, objectName, maxDepth);
            this._post({ command: 'dependencyTreeResult', objectName, dependencyTree });
        } catch (error) {
            this._post({ command: 'error', message: `Failed to get dependency tree: ${error.message}` });
        }
    }

    async handleGetImpactAnalysis(database, objectName) {
        try {
            const impactAnalysis = await this._dependencyService.getImpactAnalysis(database, objectName);
            this._post({ command: 'impactAnalysisResult', objectName, impactAnalysis });
        } catch (error) {
            this._post({ command: 'error', message: `Failed to get impact analysis: ${error.message}` });
        }
    }
}

module.exports = DatabaseHandlers;
