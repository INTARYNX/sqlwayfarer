'use strict';

const parseObjectName = require('./parseObjectName');

class DependencyService {
    constructor(connectionManager, databaseService) {
        this._connectionManager = connectionManager;
        this._databaseService = databaseService;
        this._indexService = null;
    }

    setIndexService(indexService) {
        this._indexService = indexService;
    }

    async getDependencies(database, objectName) {
        try {
            if (!this._indexService) {
                return { dependsOn: [], referencedBy: [] };
            }

            const index = await this._indexService.getIndex(database);
            if (!index || !index.objects) {
                return { dependsOn: [], referencedBy: [] };
            }

            // Find the object - try different variations
            let objectData = null;
            const cleanName = objectName.replace(/[\[\]]/g, '');

            // Try exact match
            if (index.objects[cleanName]) {
                objectData = index.objects[cleanName];
            } else {
                // Try case insensitive
                for (const [key, obj] of Object.entries(index.objects)) {
                    if (key.toLowerCase() === cleanName.toLowerCase() ||
                        obj.name === cleanName ||
                        obj.qualifiedName === cleanName) {
                        objectData = obj;
                        break;
                    }
                }
            }

            if (!objectData) {
                return { dependsOn: [], referencedBy: [] };
            }

            // Convert dependencies to expected format
            const dependsOn = (objectData.dependencies || []).map(dep => ({
                referenced_object: dep,
                referenced_object_type: 'Table', // You might want to look this up in the index
                dependency_type: 'REFERENCE',
                operations: ['REFERENCE'],
                is_selected: 1,
                is_updated: 0,
                is_insert_all: 0,
                is_delete: 0
            }));

            // Find reverse dependencies - FIXED
            const referencedBy = [];
            for (const [key, obj] of Object.entries(index.objects)) {
                if (obj.dependencies && obj.dependencies.length > 0) {
                    // Check if any of this object's dependencies match our target object
                    const matchesDependency = obj.dependencies.some(dep => {
                        const cleanDep = dep.replace(/[\[\]]/g, '');
                        return cleanDep === cleanName ||
                            cleanDep.toLowerCase() === cleanName.toLowerCase() ||
                            dep === objectName ||
                            dep === cleanName;
                    });

                    if (matchesDependency) {
                        referencedBy.push({
                            referencing_object: obj.name || key,
                            referencing_object_type: this._getTypeFromCode(obj.type),
                            dependency_type: 'REFERENCE'
                        });
                    }
                }
            }

            return { dependsOn, referencedBy };

        } catch (error) {
            console.error('Error getting dependencies:', error);
            return { dependsOn: [], referencedBy: [] };
        }
    }

    _getTypeFromCode(typeCode) {
        const types = {
            'U': 'Table',
            'V': 'View',
            'P': 'Procedure',
            'FN': 'Function',
            'IF': 'Function',
            'TF': 'Function',
            'TR': 'Trigger'
        };
        return types[typeCode] || 'Object';
    }

    async getTableUsageAnalysis(database, objectName) {
        const deps = await this.getDependencies(database, objectName);
        return {
            objectName: objectName,
            tablesUsed: deps.dependsOn,
            relatedObjects: [],
            summary: {
                totalTables: deps.dependsOn.length,
                readTables: deps.dependsOn.length,
                writeTables: 0,
                operationCounts: { 'REFERENCE': deps.dependsOn.length }
            }
        };
    }

    async getTableUsageByObjects(database, tableName) {
        try {
            if (!this._indexService) {
                return { tableName, usedByObjects: [], summary: { totalObjects: 0 } };
            }

            const index = await this._indexService.getIndex(database);
            if (!index || !index.objects) {
                return { tableName, usedByObjects: [], summary: { totalObjects: 0 } };
            }

            const usedByObjects = [];
            const cleanTableName = tableName.replace(/[\[\]]/g, '');

            for (const [key, obj] of Object.entries(index.objects)) {
                if (obj.dependencies && obj.dependencies.some(dep =>
                    dep.toLowerCase().includes(cleanTableName.toLowerCase()))) {
                    usedByObjects.push({
                        object_name: obj.name || key,
                        object_type: this._getTypeFromCode(obj.type),
                        operation_type: 'REFERENCE'
                    });
                }
            }

            return {
                tableName,
                usedByObjects,
                summary: { totalObjects: usedByObjects.length }
            };

        } catch (error) {
            return { tableName, usedByObjects: [], summary: { totalObjects: 0 } };
        }
    }

    async getTriggerAnalysis(database) {
        try {
            const result = await this._connectionManager.executeQuery(`
                USE [${database}];
                SELECT 
                    t.name as trigger_name,
                    OBJECT_NAME(t.parent_id) as table_name,
                    t.is_disabled,
                    'TRIGGER' as trigger_event,
                    'AFTER' as trigger_timing,
                    t.create_date,
                    t.modify_date
                FROM sys.triggers t
                WHERE t.parent_class = 1
                ORDER BY OBJECT_NAME(t.parent_id), t.name
            `);
            return result.recordset;
        } catch (error) {
            return [];
        }
    }

    // In DependencyService.js - replace the existing method
    async getDependencyTree(database, objectName, maxDepth = 3) {
        try {
            if (!this._indexService) {
                return { name: objectName, dependencies: [] };
            }

            const index = await this._indexService.getIndex(database);
            if (!index || !index.objects) {
                return { name: objectName, dependencies: [] };
            }

            const visited = new Set();

            const buildTree = (objName, level) => {
                if (level >= maxDepth || visited.has(objName)) {
                    return { name: objName, dependencies: [] };
                }

                visited.add(objName);

                const cleanName = objName.replace(/[\[\]]/g, '');
                const objectData = index.objects[cleanName];

                if (!objectData || !objectData.dependencies) {
                    visited.delete(objName);
                    return { name: objName, dependencies: [] };
                }

                const children = objectData.dependencies.map(dep =>
                    buildTree(dep, level + 1)
                );

                visited.delete(objName);
                return { name: objName, dependencies: children };
            };

            return buildTree(objectName, 0);

        } catch (error) {
            console.error('Tree error:', error);
            return { name: objectName, dependencies: [] };
        }
    }

    async getImpactAnalysis(database, objectName) {
        const deps = await this.getDependencies(database, objectName);
        return deps.referencedBy || [];
    }

    _parseObjectName(objectName) { return parseObjectName(objectName); }

    dispose() {}
}

module.exports = DependencyService;