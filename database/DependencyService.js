'use strict';

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

    async getDependencyTree(database, objectName, maxDepth = 3) {
        const deps = await this.getDependencies(database, objectName);
        return {
            name: objectName,
            dependencies: deps.dependsOn.map(dep => ({
                name: dep.referenced_object,
                type: dep.referenced_object_type,
                dependencies: [],
                level: 1
            })),
            level: 0
        };
    }

    async getImpactAnalysis(database, objectName) {
        const deps = await this.getDependencies(database, objectName);
        return deps.referencedBy || [];
    }

    // EXTENDED PROPERTIES (COMMENTS) IMPLEMENTATION
    async getTableExtendedProperties(database, tableName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            const { schema, objectName } = this._parseObjectName(tableName);
            const qualifiedTableName = `${schema}.${objectName}`;

            console.log(`Getting extended properties for table: ${qualifiedTableName} (schema: ${schema}, object: ${objectName})`);

            // Get table description
            const tableDescResult = await this._connectionManager.executeQuery(`
                USE [${database}];
                SELECT 
                    ep.value as table_description
                FROM sys.extended_properties ep
                INNER JOIN sys.objects o ON ep.major_id = o.object_id
                INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                WHERE ep.minor_id = 0 
                AND ep.name = 'MS_Description'
                AND s.name = '${schema}'
                AND o.name = '${objectName}'
            `);

            const tableDescription = tableDescResult.recordset[0]?.table_description || null;

            // Get all columns with their descriptions
            const columnsResult = await this._connectionManager.executeQuery(`
                USE [${database}];
                SELECT 
                    c.COLUMN_NAME as columnName,
                    c.DATA_TYPE as dataType,
                    c.IS_NULLABLE as isNullable,
                    c.CHARACTER_MAXIMUM_LENGTH as maxLength,
                    c.NUMERIC_PRECISION as numericPrecision,
                    c.NUMERIC_SCALE as numericScale,
                    c.ORDINAL_POSITION as ordinalPosition,
                    ep.value as description,
                    CASE WHEN ep.value IS NOT NULL THEN 1 ELSE 0 END as hasDescription
                FROM INFORMATION_SCHEMA.COLUMNS c
                LEFT JOIN sys.extended_properties ep 
                    ON ep.major_id = OBJECT_ID('${qualifiedTableName}')
                    AND ep.minor_id = c.ORDINAL_POSITION
                    AND ep.name = 'MS_Description'
                WHERE c.TABLE_SCHEMA = '${schema}' 
                AND c.TABLE_NAME = '${objectName}'
                ORDER BY c.ORDINAL_POSITION
            `);

            const allColumns = columnsResult.recordset.map(row => ({
                columnName: row.columnName,
                dataType: row.dataType,
                isNullable: row.isNullable === 'YES',
                maxLength: row.maxLength,
                numericPrecision: row.numericPrecision,
                numericScale: row.numericScale,
                ordinalPosition: row.ordinalPosition,
                description: row.description,
                hasDescription: row.hasDescription === 1
            }));

            const columnDescriptions = allColumns.filter(col => col.hasDescription);

            console.log(`Found table description: ${tableDescription ? 'Yes' : 'No'}, Column descriptions: ${columnDescriptions.length}/${allColumns.length}`);

            return {
                tableName: tableName,
                tableDescription: tableDescription,
                columnDescriptions: columnDescriptions,
                allColumns: allColumns,
                hasDescriptions: tableDescription !== null || columnDescriptions.length > 0
            };

        } catch (error) {
            console.error('Error getting table extended properties:', error);
            throw error;
        }
    }

    async getObjectExtendedProperties(database, objectName, objectType) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            const { schema, objectName: parsedObjectName } = this._parseObjectName(objectName);

            console.log(`Getting extended properties for object: ${schema}.${parsedObjectName} (${objectType})`);

            const result = await this._connectionManager.executeQuery(`
                USE [${database}];
                SELECT 
                    ep.value as description
                FROM sys.extended_properties ep
                INNER JOIN sys.objects o ON ep.major_id = o.object_id
                INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                WHERE ep.minor_id = 0 
                AND ep.name = 'MS_Description'
                AND s.name = '${schema}'
                AND o.name = '${parsedObjectName}'
            `);

            const description = result.recordset[0]?.description || null;

            console.log(`Found object description: ${description ? 'Yes' : 'No'}`);

            return {
                objectName: objectName,
                objectType: objectType,
                description: description,
                hasDescription: description !== null
            };

        } catch (error) {
            console.error('Error getting object extended properties:', error);
            throw error;
        }
    }

    async updateTableDescription(database, tableName, description) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            const { schema, objectName } = this._parseObjectName(tableName);
            
            console.log(`Updating table description for: ${schema}.${objectName}`);

            if (description && description.trim() !== '') {
                // Add or update description
                const escapedDescription = description.replace(/'/g, "''");
                
                await this._connectionManager.executeQuery(`
                    USE [${database}];
                    
                    IF EXISTS (
                        SELECT 1 FROM sys.extended_properties ep
                        INNER JOIN sys.objects o ON ep.major_id = o.object_id
                        INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                        WHERE ep.minor_id = 0 AND ep.name = 'MS_Description'
                        AND s.name = '${schema}' AND o.name = '${objectName}'
                    )
                    BEGIN
                        EXEC sp_updateextendedproperty 
                            @name = N'MS_Description',
                            @value = N'${escapedDescription}',
                            @level0type = N'SCHEMA',
                            @level0name = N'${schema}',
                            @level1type = N'TABLE',
                            @level1name = N'${objectName}'
                    END
                    ELSE
                    BEGIN
                        EXEC sp_addextendedproperty 
                            @name = N'MS_Description',
                            @value = N'${escapedDescription}',
                            @level0type = N'SCHEMA',
                            @level0name = N'${schema}',
                            @level1type = N'TABLE',
                            @level1name = N'${objectName}'
                    END
                `);
            } else {
                // Delete description
                await this._connectionManager.executeQuery(`
                    USE [${database}];
                    
                    IF EXISTS (
                        SELECT 1 FROM sys.extended_properties ep
                        INNER JOIN sys.objects o ON ep.major_id = o.object_id
                        INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                        WHERE ep.minor_id = 0 AND ep.name = 'MS_Description'
                        AND s.name = '${schema}' AND o.name = '${objectName}'
                    )
                    BEGIN
                        EXEC sp_dropextendedproperty 
                            @name = N'MS_Description',
                            @level0type = N'SCHEMA',
                            @level0name = N'${schema}',
                            @level1type = N'TABLE',
                            @level1name = N'${objectName}'
                    END
                `);
            }

            return {
                success: true,
                message: description && description.trim() !== '' ? 'Table description updated successfully' : 'Table description deleted successfully'
            };

        } catch (error) {
            console.error('Error updating table description:', error);
            return {
                success: false,
                message: `Failed to update table description: ${error.message}`
            };
        }
    }

    async updateColumnDescription(database, tableName, columnName, description) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            const { schema, objectName } = this._parseObjectName(tableName);
            
            console.log(`Updating column description for: ${schema}.${objectName}.${columnName}`);

            if (description && description.trim() !== '') {
                // Add or update description
                const escapedDescription = description.replace(/'/g, "''");
                
                await this._connectionManager.executeQuery(`
                    USE [${database}];
                    
                    IF EXISTS (
                        SELECT 1 FROM sys.extended_properties ep
                        INNER JOIN sys.objects o ON ep.major_id = o.object_id
                        INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                        INNER JOIN INFORMATION_SCHEMA.COLUMNS c ON c.TABLE_SCHEMA = s.name 
                            AND c.TABLE_NAME = o.name AND c.COLUMN_NAME = '${columnName}'
                            AND ep.minor_id = c.ORDINAL_POSITION
                        WHERE ep.name = 'MS_Description'
                        AND s.name = '${schema}' AND o.name = '${objectName}'
                    )
                    BEGIN
                        EXEC sp_updateextendedproperty 
                            @name = N'MS_Description',
                            @value = N'${escapedDescription}',
                            @level0type = N'SCHEMA',
                            @level0name = N'${schema}',
                            @level1type = N'TABLE',
                            @level1name = N'${objectName}',
                            @level2type = N'COLUMN',
                            @level2name = N'${columnName}'
                    END
                    ELSE
                    BEGIN
                        EXEC sp_addextendedproperty 
                            @name = N'MS_Description',
                            @value = N'${escapedDescription}',
                            @level0type = N'SCHEMA',
                            @level0name = N'${schema}',
                            @level1type = N'TABLE',
                            @level1name = N'${objectName}',
                            @level2type = N'COLUMN',
                            @level2name = N'${columnName}'
                    END
                `);
            } else {
                // Delete description
                await this._connectionManager.executeQuery(`
                    USE [${database}];
                    
                    IF EXISTS (
                        SELECT 1 FROM sys.extended_properties ep
                        INNER JOIN sys.objects o ON ep.major_id = o.object_id
                        INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                        INNER JOIN INFORMATION_SCHEMA.COLUMNS c ON c.TABLE_SCHEMA = s.name 
                            AND c.TABLE_NAME = o.name AND c.COLUMN_NAME = '${columnName}'
                            AND ep.minor_id = c.ORDINAL_POSITION
                        WHERE ep.name = 'MS_Description'
                        AND s.name = '${schema}' AND o.name = '${objectName}'
                    )
                    BEGIN
                        EXEC sp_dropextendedproperty 
                            @name = N'MS_Description',
                            @level0type = N'SCHEMA',
                            @level0name = N'${schema}',
                            @level1type = N'TABLE',
                            @level1name = N'${objectName}',
                            @level2type = N'COLUMN',
                            @level2name = N'${columnName}'
                    END
                `);
            }

            return {
                success: true,
                message: description && description.trim() !== '' ? 'Column description updated successfully' : 'Column description deleted successfully'
            };

        } catch (error) {
            console.error('Error updating column description:', error);
            return {
                success: false,
                message: `Failed to update column description: ${error.message}`
            };
        }
    }

    async updateObjectDescription(database, objectName, description) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            const { schema, objectName: parsedObjectName } = this._parseObjectName(objectName);
            
            console.log(`Updating object description for: ${schema}.${parsedObjectName}`);

            if (description && description.trim() !== '') {
                // Add or update description
                const escapedDescription = description.replace(/'/g, "''");
                
                await this._connectionManager.executeQuery(`
                    USE [${database}];
                    
                    IF EXISTS (
                        SELECT 1 FROM sys.extended_properties ep
                        INNER JOIN sys.objects o ON ep.major_id = o.object_id
                        INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                        WHERE ep.minor_id = 0 AND ep.name = 'MS_Description'
                        AND s.name = '${schema}' AND o.name = '${parsedObjectName}'
                    )
                    BEGIN
                        EXEC sp_updateextendedproperty 
                            @name = N'MS_Description',
                            @value = N'${escapedDescription}',
                            @level0type = N'SCHEMA',
                            @level0name = N'${schema}',
                            @level1type = N'${this._getLevel1TypeFromObjectName(parsedObjectName)}',
                            @level1name = N'${parsedObjectName}'
                    END
                    ELSE
                    BEGIN
                        EXEC sp_addextendedproperty 
                            @name = N'MS_Description',
                            @value = N'${escapedDescription}',
                            @level0type = N'SCHEMA',
                            @level0name = N'${schema}',
                            @level1type = N'${this._getLevel1TypeFromObjectName(parsedObjectName)}',
                            @level1name = N'${parsedObjectName}'
                    END
                `);
            } else {
                // Delete description
                await this._connectionManager.executeQuery(`
                    USE [${database}];
                    
                    IF EXISTS (
                        SELECT 1 FROM sys.extended_properties ep
                        INNER JOIN sys.objects o ON ep.major_id = o.object_id
                        INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                        WHERE ep.minor_id = 0 AND ep.name = 'MS_Description'
                        AND s.name = '${schema}' AND o.name = '${parsedObjectName}'
                    )
                    BEGIN
                        EXEC sp_dropextendedproperty 
                            @name = N'MS_Description',
                            @level0type = N'SCHEMA',
                            @level0name = N'${schema}',
                            @level1type = N'${this._getLevel1TypeFromObjectName(parsedObjectName)}',
                            @level1name = N'${parsedObjectName}'
                    END
                `);
            }

            return {
                success: true,
                message: description && description.trim() !== '' ? 'Object description updated successfully' : 'Object description deleted successfully'
            };

        } catch (error) {
            console.error('Error updating object description:', error);
            return {
                success: false,
                message: `Failed to update object description: ${error.message}`
            };
        }
    }

    async deleteTableDescription(database, tableName) {
        return await this.updateTableDescription(database, tableName, '');
    }

    async deleteColumnDescription(database, tableName, columnName) {
        return await this.updateColumnDescription(database, tableName, columnName, '');
    }

    // HELPER METHODS
    _parseObjectName(objectName) {
        if (!objectName) {
            return { schema: 'dbo', objectName: '' };
        }

        // Remove brackets if present
        let cleanName = objectName.replace(/[\[\]]/g, '');
        
        // Split on the last dot to handle cases like [database].[schema].[object]
        const parts = cleanName.split('.');
        
        if (parts.length >= 2) {
            // Take the last part as object name and second-to-last as schema
            const objName = parts[parts.length - 1];
            const schema = parts[parts.length - 2];
            return { schema: schema || 'dbo', objectName: objName };
        } else {
            // No schema specified, default to dbo
            return { schema: 'dbo', objectName: cleanName };
        }
    }

    _getLevel1TypeFromObjectName(objectName) {
        // For extended properties, we need to determine the object type
        // This is a simplified approach - in practice you might want to query sys.objects
        // to get the actual type, but for most cases these work:
        if (objectName.toLowerCase().startsWith('v_') || objectName.toLowerCase().includes('view')) {
            return 'VIEW';
        }
        if (objectName.toLowerCase().startsWith('sp_') || objectName.toLowerCase().startsWith('usp_')) {
            return 'PROCEDURE';
        }
        if (objectName.toLowerCase().startsWith('fn_') || objectName.toLowerCase().startsWith('ufn_')) {
            return 'FUNCTION';
        }
        
        // Default assumption - you might want to improve this logic
        return 'PROCEDURE';
    }

    // Keep the other utility methods
    clearCache() {
        // Nothing to clear in this implementation
    }

    async forceReindex(database, progressCallback) {
        if (progressCallback) {
            progressCallback({ progress: 100, current: 1, total: 1, message: 'Done' });
        }
        return { success: true, message: 'Cache cleared' };
    }

    async getIndex(database, progressCallback) {
        if (this._indexService) {
            return await this._indexService.getIndex(database, progressCallback);
        }
        
        if (progressCallback) {
            progressCallback({ progress: 100, current: 1, total: 1, message: 'Done' });
        }
        return { database, lastIndexed: new Date().toISOString(), method: 'simple' };
    }

    dispose() {
        // Nothing to dispose
    }
}

module.exports = DependencyService;