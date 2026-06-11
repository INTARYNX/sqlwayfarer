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

            const currentDb = this._getCurrentDatabase();
            if (currentDb) {
                try {
                    await this._indexService.clearIndex(currentDb);
                } catch (clearError) {
                    console.warn('Error clearing index on database change:', clearError);
                }
            }

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
        } catch (error) {
            console.error('Error getting objects:', error);
            this._post({ command: 'error', message: `Failed to get objects: ${error.message}` });
        }
    }

    async handleGetTableDetails(database, tableName) {
        try {
            const tableDetails = await this._databaseService.getTableDetails(database, tableName);
            const dependencies = await this._dependencyService.getDependencies(database, tableName);
            this._post({
                command: 'tableDetailsLoaded',
                tableName,
                columns: tableDetails.columns,
                indexes: tableDetails.indexes,
                foreignKeys: tableDetails.foreignKeys,
                dependencies
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
