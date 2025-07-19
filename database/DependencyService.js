'use strict';

/**
 * Handles database object dependency analysis, table usage tracking, and extended properties
 * Provides services to find object dependencies, table relationships, and MS_Description comments
 */
class DependencyService {
    constructor(connectionManager) {
        this._connectionManager = connectionManager;
    }

    /**
     * Get extended properties (MS_Description comments) for a table and its columns
     * @param {string} database - Database name
     * @param {string} tableName - Table name
     * @returns {Promise<Object>} Extended properties for table and columns
     */
    async getTableExtendedProperties(database, tableName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            const result = await this._connectionManager.executeQuery(`
                USE [${database}];
                
                -- Get table description
                SELECT 
                    'TABLE' as property_type,
                    '${tableName}' as object_name,
                    NULL as column_name,
                    CAST(ep.value AS NVARCHAR(MAX)) as description,
                    ep.name as property_name
                FROM sys.extended_properties ep
                JOIN sys.objects o ON ep.major_id = o.object_id
                WHERE o.name = '${tableName}'
                AND o.type = 'U'
                AND ep.minor_id = 0  -- Table level properties
                AND ep.name = 'MS_Description'
                
                UNION ALL
                
                -- Get column descriptions
                SELECT 
                    'COLUMN' as property_type,
                    '${tableName}' as object_name,
                    c.name as column_name,
                    CAST(ep.value AS NVARCHAR(MAX)) as description,
                    ep.name as property_name
                FROM sys.extended_properties ep
                JOIN sys.objects o ON ep.major_id = o.object_id
                JOIN sys.columns c ON ep.major_id = c.object_id AND ep.minor_id = c.column_id
                WHERE o.name = '${tableName}'
                AND o.type = 'U'
                AND ep.name = 'MS_Description'
                
                ORDER BY property_type DESC, column_name
            `);

            // Organize results
            const properties = {
                tableName: tableName,
                tableDescription: null,
                columnDescriptions: [],
                hasDescriptions: false
            };

            result.recordset.forEach(row => {
                if (row.property_type === 'TABLE') {
                    properties.tableDescription = row.description;
                    properties.hasDescriptions = true;
                } else if (row.property_type === 'COLUMN') {
                    properties.columnDescriptions.push({
                        columnName: row.column_name,
                        description: row.description
                    });
                    properties.hasDescriptions = true;
                }
            });

            // Get all columns to show which ones don't have descriptions
            const columnsResult = await this._connectionManager.executeQuery(`
                USE [${database}];
                SELECT 
                    c.name as column_name,
                    c.column_id,
                    t.name as data_type,
                    c.max_length,
                    c.is_nullable
                FROM sys.columns c
                JOIN sys.types t ON c.user_type_id = t.user_type_id
                JOIN sys.objects o ON c.object_id = o.object_id
                WHERE o.name = '${tableName}'
                AND o.type = 'U'
                ORDER BY c.column_id
            `);

            properties.allColumns = columnsResult.recordset.map(col => {
                const existingDesc = properties.columnDescriptions.find(cd => cd.columnName === col.column_name);
                return {
                    columnName: col.column_name,
                    columnId: col.column_id,
                    dataType: col.data_type,
                    maxLength: col.max_length,
                    isNullable: col.is_nullable,
                    description: existingDesc ? existingDesc.description : null,
                    hasDescription: !!existingDesc
                };
            });

            return properties;
        } catch (error) {
            console.error('Error getting table extended properties:', error);
            return {
                tableName: tableName,
                tableDescription: null,
                columnDescriptions: [],
                allColumns: [],
                hasDescriptions: false,
                error: error.message
            };
        }
    }

    /**
     * Get extended properties for any database object (view, procedure, function)
     * @param {string} database - Database name
     * @param {string} objectName - Object name
     * @param {string} objectType - Object type
     * @returns {Promise<Object>} Extended properties for the object
     */
    async getObjectExtendedProperties(database, objectName, objectType) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            const result = await this._connectionManager.executeQuery(`
                USE [${database}];
                
                SELECT 
                    '${objectType}' as object_type,
                    '${objectName}' as object_name,
                    CAST(ep.value AS NVARCHAR(MAX)) as description,
                    ep.name as property_name
                FROM sys.extended_properties ep
                JOIN sys.objects o ON ep.major_id = o.object_id
                WHERE o.name = '${objectName}'
                AND ep.minor_id = 0  -- Object level properties
                AND ep.name = 'MS_Description'
            `);

            return {
                objectName: objectName,
                objectType: objectType,
                description: result.recordset.length > 0 ? result.recordset[0].description : null,
                hasDescription: result.recordset.length > 0
            };
        } catch (error) {
            console.error('Error getting object extended properties:', error);
            return {
                objectName: objectName,
                objectType: objectType,
                description: null,
                hasDescription: false,
                error: error.message
            };
        }
    }

    /**
     * Update or add extended property (MS_Description) for a table
     * @param {string} database - Database name
     * @param {string} tableName - Table name
     * @param {string} description - Description text
     * @returns {Promise<Object>} Operation result
     */
    async updateTableDescription(database, tableName, description) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            // Check if property already exists
            const existingResult = await this._connectionManager.executeQuery(`
                USE [${database}];
                SELECT COUNT(*) as count
                FROM sys.extended_properties ep
                JOIN sys.objects o ON ep.major_id = o.object_id
                WHERE o.name = '${tableName}'
                AND o.type = 'U'
                AND ep.minor_id = 0
                AND ep.name = 'MS_Description'
            `);

            const exists = existingResult.recordset[0].count > 0;
            
            if (exists) {
                // Update existing property
                await this._connectionManager.executeQuery(`
                    USE [${database}];
                    EXEC sys.sp_updateextendedproperty 
                        @name = N'MS_Description',
                        @value = N'${description.replace(/'/g, "''")}',
                        @level0type = N'SCHEMA',
                        @level0name = N'dbo',
                        @level1type = N'TABLE',
                        @level1name = N'${tableName}'
                `);
            } else {
                // Add new property
                await this._connectionManager.executeQuery(`
                    USE [${database}];
                    EXEC sys.sp_addextendedproperty 
                        @name = N'MS_Description',
                        @value = N'${description.replace(/'/g, "''")}',
                        @level0type = N'SCHEMA',
                        @level0name = N'dbo',
                        @level1type = N'TABLE',
                        @level1name = N'${tableName}'
                `);
            }

            return {
                success: true,
                message: `Table description ${exists ? 'updated' : 'added'} successfully`
            };
        } catch (error) {
            console.error('Error updating table description:', error);
            return {
                success: false,
                message: `Failed to update table description: ${error.message}`
            };
        }
    }

    /**
     * Update or add extended property (MS_Description) for a column
     * @param {string} database - Database name
     * @param {string} tableName - Table name
     * @param {string} columnName - Column name
     * @param {string} description - Description text
     * @returns {Promise<Object>} Operation result
     */
    async updateColumnDescription(database, tableName, columnName, description) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            // Check if property already exists
            const existingResult = await this._connectionManager.executeQuery(`
                USE [${database}];
                SELECT COUNT(*) as count
                FROM sys.extended_properties ep
                JOIN sys.objects o ON ep.major_id = o.object_id
                JOIN sys.columns c ON ep.major_id = c.object_id AND ep.minor_id = c.column_id
                WHERE o.name = '${tableName}'
                AND c.name = '${columnName}'
                AND o.type = 'U'
                AND ep.name = 'MS_Description'
            `);

            const exists = existingResult.recordset[0].count > 0;
            
            if (exists) {
                // Update existing property
                await this._connectionManager.executeQuery(`
                    USE [${database}];
                    EXEC sys.sp_updateextendedproperty 
                        @name = N'MS_Description',
                        @value = N'${description.replace(/'/g, "''")}',
                        @level0type = N'SCHEMA',
                        @level0name = N'dbo',
                        @level1type = N'TABLE',
                        @level1name = N'${tableName}',
                        @level2type = N'COLUMN',
                        @level2name = N'${columnName}'
                `);
            } else {
                // Add new property
                await this._connectionManager.executeQuery(`
                    USE [${database}];
                    EXEC sys.sp_addextendedproperty 
                        @name = N'MS_Description',
                        @value = N'${description.replace(/'/g, "''")}',
                        @level0type = N'SCHEMA',
                        @level0name = N'dbo',
                        @level1type = N'TABLE',
                        @level1name = N'${tableName}',
                        @level2type = N'COLUMN',
                        @level2name = N'${columnName}'
                `);
            }

            return {
                success: true,
                message: `Column description ${exists ? 'updated' : 'added'} successfully`
            };
        } catch (error) {
            console.error('Error updating column description:', error);
            return {
                success: false,
                message: `Failed to update column description: ${error.message}`
            };
        }
    }

    /**
     * Update or add extended property (MS_Description) for any database object
     * @param {string} database - Database name
     * @param {string} objectName - Object name
     * @param {string} description - Description text
     * @returns {Promise<Object>} Operation result
     */
    async updateObjectDescription(database, objectName, description) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            // Get object type first
            const objectResult = await this._connectionManager.executeQuery(`
                USE [${database}];
                SELECT 
                    CASE 
                        WHEN type = 'V' THEN 'VIEW'
                        WHEN type = 'P' THEN 'PROCEDURE'
                        WHEN type IN ('FN', 'IF', 'TF') THEN 'FUNCTION'
                        WHEN type = 'TR' THEN 'TRIGGER'
                        ELSE 'UNKNOWN'
                    END as object_type
                FROM sys.objects 
                WHERE name = '${objectName}'
            `);

            if (objectResult.recordset.length === 0) {
                throw new Error(`Object '${objectName}' not found`);
            }

            const objectType = objectResult.recordset[0].object_type;
            
            // Check if property already exists
            const existingResult = await this._connectionManager.executeQuery(`
                USE [${database}];
                SELECT COUNT(*) as count
                FROM sys.extended_properties ep
                JOIN sys.objects o ON ep.major_id = o.object_id
                WHERE o.name = '${objectName}'
                AND ep.minor_id = 0
                AND ep.name = 'MS_Description'
            `);

            const exists = existingResult.recordset[0].count > 0;
            
            if (exists) {
                // Update existing property
                await this._connectionManager.executeQuery(`
                    USE [${database}];
                    EXEC sys.sp_updateextendedproperty 
                        @name = N'MS_Description',
                        @value = N'${description.replace(/'/g, "''")}',
                        @level0type = N'SCHEMA',
                        @level0name = N'dbo',
                        @level1type = N'${objectType}',
                        @level1name = N'${objectName}'
                `);
            } else {
                // Add new property
                await this._connectionManager.executeQuery(`
                    USE [${database}];
                    EXEC sys.sp_addextendedproperty 
                        @name = N'MS_Description',
                        @value = N'${description.replace(/'/g, "''")}',
                        @level0type = N'SCHEMA',
                        @level0name = N'dbo',
                        @level1type = N'${objectType}',
                        @level1name = N'${objectName}'
                `);
            }

            return {
                success: true,
                message: `${objectType} description ${exists ? 'updated' : 'added'} successfully`
            };
        } catch (error) {
            console.error('Error updating object description:', error);
            return {
                success: false,
                message: `Failed to update object description: ${error.message}`
            };
        }
    }

    /**
     * Delete extended property (MS_Description) for a table
     * @param {string} database - Database name
     * @param {string} tableName - Table name
     * @returns {Promise<Object>} Operation result
     */
    async deleteTableDescription(database, tableName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            await this._connectionManager.executeQuery(`
                USE [${database}];
                EXEC sys.sp_dropextendedproperty 
                    @name = N'MS_Description',
                    @level0type = N'SCHEMA',
                    @level0name = N'dbo',
                    @level1type = N'TABLE',
                    @level1name = N'${tableName}'
            `);

            return {
                success: true,
                message: 'Table description deleted successfully'
            };
        } catch (error) {
            return {
                success: false,
                message: `Failed to delete table description: ${error.message}`
            };
        }
    }

    /**
     * Delete extended property (MS_Description) for a column
     * @param {string} database - Database name
     * @param {string} tableName - Table name
     * @param {string} columnName - Column name
     * @returns {Promise<Object>} Operation result
     */
    async deleteColumnDescription(database, tableName, columnName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            await this._connectionManager.executeQuery(`
                USE [${database}];
                EXEC sys.sp_dropextendedproperty 
                    @name = N'MS_Description',
                    @level0type = N'SCHEMA',
                    @level0name = N'dbo',
                    @level1type = N'TABLE',
                    @level1name = N'${tableName}',
                    @level2type = N'COLUMN',
                    @level2name = N'${columnName}'
            `);

            return {
                success: true,
                message: 'Column description deleted successfully'
            };
        } catch (error) {
            return {
                success: false,
                message: `Failed to delete column description: ${error.message}`
            };
        }
    }

    /**
     * Get comprehensive dependencies for a database object
     * @param {string} database - Database name
     * @param {string} objectName - Object name
     * @returns {Promise<Object>} Dependencies object with dependsOn and referencedBy arrays
     */
    async getDependencies(database, objectName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            // Get objects this object depends on
            const dependsOnResult = await this._getDependsOn(database, objectName);
            
            // Get objects that reference this object
            const referencedByResult = await this._getReferencedBy(database, objectName);
            
            // Get alternative dependencies using dm_sql_referenced_entities
            const alternativeDependencies = await this._getAlternativeDependencies(database, objectName);

            // Combine and deduplicate results
            const allDependsOn = [...dependsOnResult, ...alternativeDependencies];
            const uniqueDependsOn = this._removeDuplicateDependencies(allDependsOn);
            const uniqueReferencedBy = this._removeDuplicateDependencies(referencedByResult);

            return {
                dependsOn: uniqueDependsOn,
                referencedBy: uniqueReferencedBy
            };
        } catch (error) {
            console.error('Error getting dependencies:', error);
            return {
                dependsOn: [],
                referencedBy: []
            };
        }
    }

    /**
     * Enhanced getTableUsageAnalysis method with better operation consolidation
     * @param {string} database - Database name
     * @param {string} objectName - Object name
     * @returns {Promise<Object>} Enhanced table usage analysis with consolidated operations
     */
    async getTableUsageAnalysis(database, objectName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            // Get all table references for this object with detailed operation analysis
            const tableReferences = await this._getEnhancedTableReferences(database, objectName);
            
            // Get objects that use the same tables (for reverse analysis)
            const tableNames = tableReferences.map(t => t.table_name).filter(name => name);
            const relatedObjects = await this._getEnhancedObjectsUsingTables(database, tableNames, objectName);
            
            return {
                objectName: objectName,
                tablesUsed: tableReferences,
                relatedObjects: relatedObjects,
                summary: this._generateEnhancedUsageSummary(tableReferences),
                operationBreakdown: this._generateOperationBreakdown(tableReferences, relatedObjects)
            };
        } catch (error) {
            console.error('Error getting enhanced table usage analysis:', error);
            return {
                objectName: objectName,
                tablesUsed: [],
                relatedObjects: [],
                summary: { totalTables: 0, readTables: 0, writeTables: 0, operationCounts: {} },
                operationBreakdown: { byOperation: {}, byTable: {} }
            };
        }
    }

    /**
     * Enhanced table references with comprehensive operation detection
     * @param {string} database - Database name
     * @param {string} objectName - Object name
     * @returns {Promise<Array<Object>>} Enhanced table references
     * @private
     */
    async _getEnhancedTableReferences(database, objectName) {
        let allReferences = [];
        
        // Method 1: Try sys.dm_sql_referenced_entities (most detailed)
        try {
            const detailedResult = await this._connectionManager.executeQuery(`
                USE [${database}];
                
                SELECT DISTINCT
                    r.referenced_entity_name as table_name,
                    'Table' as object_type,
                    r.referenced_class_desc as usage_type,
                    ISNULL(r.is_selected, 0) as is_selected,
                    ISNULL(r.is_updated, 0) as is_updated,
                    ISNULL(r.is_insert_all, 0) as is_insert_all,
                    ISNULL(r.is_delete, 0) as is_delete,
                    ISNULL(r.is_select_all, 0) as is_select_all,
                    r.referenced_schema_name,
                    r.referenced_database_name
                FROM sys.dm_sql_referenced_entities('dbo.${objectName}', 'OBJECT') r
                JOIN sys.objects o ON o.name = r.referenced_entity_name
                WHERE o.type = 'U'  -- Only user tables
                AND r.referenced_class_desc = 'OBJECT_OR_COLUMN'
                AND r.referenced_entity_name IS NOT NULL
            `);
            
            if (detailedResult.recordset.length > 0) {
                allReferences = detailedResult.recordset;
            }
        } catch (error) {
            console.log('sys.dm_sql_referenced_entities not available, trying fallback');
        }

        // Method 2: Fallback to sys.sql_expression_dependencies
        if (allReferences.length === 0) {
            try {
                const fallbackResult = await this._connectionManager.executeQuery(`
                    USE [${database}];
                    
                    SELECT DISTINCT
                        OBJECT_NAME(sed.referenced_id) as table_name,
                        'Table' as object_type,
                        'REFERENCE' as usage_type,
                        0 as is_selected,
                        0 as is_updated,
                        0 as is_insert_all,
                        0 as is_delete,
                        0 as is_select_all,
                        'dbo' as referenced_schema_name,
                        DB_NAME() as referenced_database_name
                    FROM sys.sql_expression_dependencies sed
                    JOIN sys.objects o ON sed.referenced_id = o.object_id
                    WHERE OBJECT_NAME(sed.referencing_id) = '${objectName}'
                    AND o.type = 'U'  -- Only user tables
                    AND sed.referenced_id > 0
                `);
                
                allReferences = fallbackResult.recordset.filter(row => row.table_name);
            } catch (error) {
                console.log('Fallback dependency detection failed');
            }
        }

        // Method 3: Enhanced definition analysis
        try {
            const definitionResult = await this._connectionManager.executeQuery(`
                USE [${database}];
                SELECT OBJECT_DEFINITION(OBJECT_ID('${objectName}')) as definition
            `);

            if (definitionResult.recordset && definitionResult.recordset.length > 0) {
                const definition = definitionResult.recordset[0].definition;
                if (definition) {
                    allReferences = this._enhanceWithAdvancedDefinitionAnalysis(allReferences, definition, database);
                }
            }
        } catch (error) {
            console.log('Definition analysis failed');
        }

        // Consolidate operations for the same table
        const consolidatedReferences = this._consolidateTableOperations(allReferences);
        
        return consolidatedReferences;
    }

    /**
     * Enhanced objects using tables with operation consolidation
     * @param {string} database - Database name
     * @param {Array<string>} tableNames - Array of table names
     * @param {string} excludeObject - Object to exclude from results
     * @returns {Promise<Array<Object>>} Enhanced objects using tables
     * @private
     */
async _getEnhancedObjectsUsingTables(database, tableNames, excludeObject = null) {
    if (!tableNames || tableNames.length === 0) {
        return [];
    }

    const tableList = tableNames.map(name => `'${name}'`).join(',');
    let allResults = [];

    try {
        // Get all objects that reference these tables
        const objectsResult = await this._connectionManager.executeQuery(`
            USE [${database}];
            
            SELECT DISTINCT
                OBJECT_NAME(sed.referencing_id) as object_name,
                CASE 
                    WHEN o.type = 'P' THEN 'Procedure'
                    WHEN o.type = 'V' THEN 'View'
                    WHEN o.type IN ('FN', 'IF', 'TF') THEN 'Function'
                    WHEN o.type = 'TR' THEN 'Trigger'
                    ELSE o.type_desc
                END as object_type,
                OBJECT_NAME(sed.referenced_id) as table_name
            FROM sys.sql_expression_dependencies sed
            JOIN sys.objects o ON sed.referencing_id = o.object_id
            WHERE OBJECT_NAME(sed.referenced_id) IN (${tableList})
            AND o.type IN ('P', 'V', 'FN', 'IF', 'TF', 'TR')
            AND OBJECT_NAME(sed.referencing_id) IS NOT NULL
            ${excludeObject ? `AND OBJECT_NAME(sed.referencing_id) != '${excludeObject}'` : ''}
        `);

        // For each object, get the SQL definition and parse operations
        for (const obj of objectsResult.recordset) {
            try {
                // Get object definition
                const defResult = await this._connectionManager.executeQuery(`
                    USE [${database}];
                    SELECT OBJECT_DEFINITION(OBJECT_ID('${obj.object_name}')) as definition
                `);

                const definition = defResult.recordset[0]?.definition || '';
                const operations = this._parseOperationsFromDefinition(definition, obj.table_name, obj.object_type);

                allResults.push({
                    object_name: obj.object_name,
                    object_type: obj.object_type,
                    table_name: obj.table_name,
                    operation_type: operations.join(', '),
                    operations_array: operations,
                    is_selected: operations.includes('SELECT') ? 1 : 0,
                    is_updated: operations.includes('UPDATE') ? 1 : 0,
                    is_insert_all: operations.includes('INSERT') ? 1 : 0,
                    is_delete: operations.includes('DELETE') ? 1 : 0
                });

            } catch (error) {
                // Fallback for objects without definitions
                const defaultOps = this._getDefaultOperations(obj.object_type);
                allResults.push({
                    object_name: obj.object_name,
                    object_type: obj.object_type,
                    table_name: obj.table_name,
                    operation_type: defaultOps.join(', '),
                    operations_array: defaultOps,
                    is_selected: defaultOps.includes('SELECT') ? 1 : 0,
                    is_updated: defaultOps.includes('UPDATE') ? 1 : 0,
                    is_insert_all: defaultOps.includes('INSERT') ? 1 : 0,
                    is_delete: defaultOps.includes('DELETE') ? 1 : 0
                });
            }
        }

    } catch (error) {
        console.error('Error in _getEnhancedObjectsUsingTables:', error);
    }

        return allResults;
    }

    /**
     * Parse SQL definition to detect operations
     */
    _parseOperationsFromDefinition(definition, tableName, objectType) {
        const operations = new Set();
        
        if (!definition) {
            return this._getDefaultOperations(objectType);
        }

        const upperDef = definition.toUpperCase();
        const tablePattern = new RegExp(`\\b${tableName.toUpperCase()}\\b`, 'g');
        
        if (!tablePattern.test(upperDef)) {
            return this._getDefaultOperations(objectType);
        }

        // Check for different operation types
        if (/\bSELECT\b.*\bFROM\b/.test(upperDef) || /\bJOIN\b/.test(upperDef)) {
            operations.add('SELECT');
        }
        
        if (new RegExp(`\\bINSERT\\s+INTO\\s+.*\\b${tableName.toUpperCase()}\\b`, 'i').test(definition)) {
            operations.add('INSERT');
        }
        
        if (new RegExp(`\\bUPDATE\\s+.*\\b${tableName.toUpperCase()}\\b`, 'i').test(definition)) {
            operations.add('UPDATE');
        }
        
        if (new RegExp(`\\bDELETE\\s+FROM\\s+.*\\b${tableName.toUpperCase()}\\b`, 'i').test(definition)) {
            operations.add('DELETE');
        }

        // If no operations detected, use defaults
        if (operations.size === 0) {
            return this._getDefaultOperations(objectType);
        }

        return Array.from(operations);
    }

    /**
     * Get default operations based on object type
     */
    _getDefaultOperations(objectType) {
        switch (objectType) {
            case 'View':
                return ['SELECT'];
            case 'Function':
                return ['SELECT'];
            case 'Procedure':
                return ['SELECT', 'INSERT', 'UPDATE'];
            case 'Trigger':
                return ['INSERT', 'UPDATE', 'DELETE'];
            default:
                return ['REFERENCE'];
        }
    }

    /**
     * Advanced definition analysis with better SQL parsing
     * @param {Array} references - Existing references
     * @param {string} definition - Object definition
     * @param {string} database - Database name
     * @returns {Array} Enhanced references
     * @private
     */
    _enhanceWithAdvancedDefinitionAnalysis(references, definition, database) {
        if (!definition) return references;

        // Enhanced SQL patterns with better table name detection
        const patterns = {
            SELECT: [
                /SELECT\s+.*?\s+FROM\s+(?:\[?(\w+)\]?\.)?(?:\[?(\w+)\]?\.)?(\[?\w+\]?)/gi,
                /JOIN\s+(?:\[?(\w+)\]?\.)?(?:\[?(\w+)\]?\.)?(\[?\w+\]?)/gi,
                /INNER\s+JOIN\s+(?:\[?(\w+)\]?\.)?(?:\[?(\w+)\]?\.)?(\[?\w+\]?)/gi,
                /LEFT\s+(?:OUTER\s+)?JOIN\s+(?:\[?(\w+)\]?\.)?(?:\[?(\w+)\]?\.)?(\[?\w+\]?)/gi,
                /RIGHT\s+(?:OUTER\s+)?JOIN\s+(?:\[?(\w+)\]?\.)?(?:\[?(\w+)\]?\.)?(\[?\w+\]?)/gi
            ],
            INSERT: [
                /INSERT\s+(?:INTO\s+)?(?:\[?(\w+)\]?\.)?(?:\[?(\w+)\]?\.)?(\[?\w+\]?)/gi
            ],
            UPDATE: [
                /UPDATE\s+(?:\[?(\w+)\]?\.)?(?:\[?(\w+)\]?\.)?(\[?\w+\]?)/gi
            ],
            DELETE: [
                /DELETE\s+(?:FROM\s+)?(?:\[?(\w+)\]?\.)?(?:\[?(\w+)\]?\.)?(\[?\w+\]?)/gi
            ]
        };

        // Track detected operations by table
        const operationsByTable = {};

        // Analyze definition for each operation type
        Object.entries(patterns).forEach(([operation, patternArray]) => {
            patternArray.forEach(pattern => {
                let match;
                while ((match = pattern.exec(definition)) !== null) {
                    // Extract table name (last capture group is table name)
                    const tableName = match[match.length - 1].replace(/[\[\]]/g, '');
                    
                    // Skip system tables and common SQL keywords
                    if (this._isValidTableName(tableName)) {
                        if (!operationsByTable[tableName]) {
                            operationsByTable[tableName] = new Set();
                        }
                        operationsByTable[tableName].add(operation);
                    }
                }
            });
        });

        // Create a map for easy lookup of existing references
        const existingReferencesMap = new Map();
        references.forEach(ref => {
            existingReferencesMap.set(ref.table_name, ref);
        });

        // Enhance existing references and add new ones
        Object.entries(operationsByTable).forEach(([tableName, operations]) => {
            const operationsArray = Array.from(operations);
            
            if (existingReferencesMap.has(tableName)) {
                // Enhance existing reference
                const ref = existingReferencesMap.get(tableName);
                ref.detected_operations = operationsArray;
                ref.operation_type = operationsArray.join(', ');
                
                // Update individual flags
                ref.is_selected = operationsArray.includes('SELECT') ? 1 : ref.is_selected;
                ref.is_updated = operationsArray.includes('UPDATE') ? 1 : ref.is_updated;
                ref.is_insert_all = operationsArray.includes('INSERT') ? 1 : ref.is_insert_all;
                ref.is_delete = operationsArray.includes('DELETE') ? 1 : ref.is_delete;
            } else {
                // Add new reference detected from definition
                references.push({
                    table_name: tableName,
                    object_type: 'Table',
                    usage_type: 'DEFINITION_DETECTED',
                    operation_type: operationsArray.join(', '),
                    detected_operations: operationsArray,
                    is_selected: operationsArray.includes('SELECT') ? 1 : 0,
                    is_updated: operationsArray.includes('UPDATE') ? 1 : 0,
                    is_insert_all: operationsArray.includes('INSERT') ? 1 : 0,
                    is_delete: operationsArray.includes('DELETE') ? 1 : 0,
                    is_select_all: 0,
                    referenced_schema_name: 'dbo',
                    referenced_database_name: database
                });
            }
        });

        return references;
    }

    /**
     * Consolidate operations for the same table
     * @param {Array} references - Table references
     * @returns {Array} Consolidated references
     * @private
     */
    _consolidateTableOperations(references) {
        const consolidatedMap = new Map();

        references.forEach(ref => {
            if (!consolidatedMap.has(ref.table_name)) {
                consolidatedMap.set(ref.table_name, {
                    table_name: ref.table_name,
                    object_type: ref.object_type,
                    operations: new Set(),
                    is_selected: 0,
                    is_updated: 0,
                    is_insert_all: 0,
                    is_delete: 0,
                    is_select_all: 0,
                    usage_details: new Set(),
                    sources: new Set()
                });
            }

            const consolidated = consolidatedMap.get(ref.table_name);
            
            // Add operations from operation_type
            if (ref.operation_type) {
                ref.operation_type.split(',').forEach(op => {
                    consolidated.operations.add(op.trim());
                });
            }
            
            // Add operations from detected_operations
            if (ref.detected_operations) {
                ref.detected_operations.forEach(op => {
                    consolidated.operations.add(op);
                });
            }
            
            // Consolidate flags
            consolidated.is_selected = Math.max(consolidated.is_selected, ref.is_selected || 0);
            consolidated.is_updated = Math.max(consolidated.is_updated, ref.is_updated || 0);
            consolidated.is_insert_all = Math.max(consolidated.is_insert_all, ref.is_insert_all || 0);
            consolidated.is_delete = Math.max(consolidated.is_delete, ref.is_delete || 0);
            consolidated.is_select_all = Math.max(consolidated.is_select_all, ref.is_select_all || 0);
            
            // Track sources of information
            consolidated.sources.add(ref.usage_type || 'UNKNOWN');
        });

        // Convert back to array format
        return Array.from(consolidatedMap.values()).map(consolidated => {
            // Generate operation_type from consolidated operations
            const operations = Array.from(consolidated.operations);
            if (operations.length === 0) {
                operations.push('REFERENCE');
                consolidated.operations.add('REFERENCE');
            }
            
            return {
                table_name: consolidated.table_name,
                object_type: consolidated.object_type,
                operation_type: operations.join(', '),
                operations_array: operations,
                is_selected: consolidated.is_selected,
                is_updated: consolidated.is_updated,
                is_insert_all: consolidated.is_insert_all,
                is_delete: consolidated.is_delete,
                is_select_all: consolidated.is_select_all,
                sources: Array.from(consolidated.sources),
                usage_details: this._generateUsageDetails(consolidated)
            };
        });
    }

    /**
     * Check if a string is a valid table name (not a SQL keyword)
     * @param {string} tableName - Table name to check
     * @returns {boolean} True if valid table name
     * @private
     */
    _isValidTableName(tableName) {
        if (!tableName || tableName.length === 0) return false;
        
        const sqlKeywords = [
            'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER',
            'INSERT', 'UPDATE', 'DELETE', 'INTO', 'VALUES', 'SET', 'ON', 'AS',
            'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'EXISTS', 'BETWEEN', 'LIKE',
            'ORDER', 'BY', 'GROUP', 'HAVING', 'DISTINCT', 'TOP', 'UNION', 'ALL'
        ];
        
        return !sqlKeywords.includes(tableName.toUpperCase()) && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(tableName);
    }

    /**
     * Generate enhanced usage summary with operation breakdown
     * @param {Array} tableReferences - Table references
     * @returns {Object} Enhanced summary
     * @private
     */
    _generateEnhancedUsageSummary(tableReferences) {
        const summary = {
            totalTables: tableReferences.length,
            readTables: 0,
            writeTables: 0,
            operationCounts: {},
            operationTypes: {}
        };

        tableReferences.forEach(ref => {
            const operations = ref.operations_array || [];
            
            operations.forEach(op => {
                summary.operationCounts[op] = (summary.operationCounts[op] || 0) + 1;
                summary.operationTypes[op] = (summary.operationTypes[op] || 0) + 1;
            });

            if (operations.includes('SELECT')) {
                summary.readTables++;
            }
            if (operations.some(op => ['UPDATE', 'INSERT', 'DELETE'].includes(op))) {
                summary.writeTables++;
            }
        });

        return summary;
    }

    /**
     * Generate operation breakdown for analysis
     * @param {Array} tableReferences - Table references  
     * @param {Array} relatedObjects - Related objects
     * @returns {Object} Operation breakdown
     * @private
     */
    _generateOperationBreakdown(tableReferences, relatedObjects) {
        const breakdown = {
            byOperation: {},
            byTable: {},
            relatedObjectOperations: {}
        };

        // Analyze table references
        tableReferences.forEach(ref => {
            const operations = ref.operations_array || [];
            
            operations.forEach(op => {
                if (!breakdown.byOperation[op]) {
                    breakdown.byOperation[op] = { count: 0, tables: [] };
                }
                breakdown.byOperation[op].count++;
                breakdown.byOperation[op].tables.push(ref.table_name);
            });

            breakdown.byTable[ref.table_name] = {
                operations: operations,
                operationCount: operations.length
            };
        });

        // Analyze related objects
        relatedObjects.forEach(obj => {
            const operations = obj.operations_array || [];
            if (!breakdown.relatedObjectOperations[obj.object_name]) {
                breakdown.relatedObjectOperations[obj.object_name] = {
                    type: obj.object_type,
                    operations: new Set()
                };
            }
            operations.forEach(op => {
                breakdown.relatedObjectOperations[obj.object_name].operations.add(op);
            });
        });

        // Convert sets to arrays
        Object.values(breakdown.relatedObjectOperations).forEach(obj => {
            obj.operations = Array.from(obj.operations);
        });

        return breakdown;
    }

    /**
     * Generate usage details for a consolidated table reference
     * @param {Object} consolidated - Consolidated table reference
     * @returns {string} Usage details
     * @private
     */
    _generateUsageDetails(consolidated) {
        const details = [];
        
        if (consolidated.is_select_all > 0) {
            details.push('SELECT *');
        } else if (consolidated.is_selected > 0) {
            details.push('SELECT');
        }
        
        if (consolidated.is_updated > 0) {
            details.push('UPDATE');
        }
        
        if (consolidated.is_insert_all > 0) {
            details.push('INSERT');
        }
        
        if (consolidated.is_delete > 0) {
            details.push('DELETE');
        }
        
        return details.length > 0 ? details.join(', ') : 'Reference';
    }

    /**
     * Get comprehensive table usage by objects for a specific table
     * @param {string} database - Database name
     * @param {string} tableName - Table name
     * @returns {Promise<Object>} Complete analysis of what uses this table
     */
    async getTableUsageByObjects(database, tableName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            // Get all objects that reference this table
            const objectReferences = await this._getEnhancedObjectsUsingTables(database, [tableName]);
            
            // Get triggers on this table
            const triggers = await this._connectionManager.executeQuery(`
                USE [${database}];
                SELECT 
                    t.name as object_name,
                    'Trigger' as object_type,
                    '${tableName}' as table_name,
                    CASE 
                        WHEN OBJECTPROPERTY(t.object_id, 'ExecIsInsertTrigger') = 1 
                             AND OBJECTPROPERTY(t.object_id, 'ExecIsUpdateTrigger') = 1 
                             AND OBJECTPROPERTY(t.object_id, 'ExecIsDeleteTrigger') = 1 THEN 'INSERT, UPDATE, DELETE'
                        WHEN OBJECTPROPERTY(t.object_id, 'ExecIsInsertTrigger') = 1 
                             AND OBJECTPROPERTY(t.object_id, 'ExecIsUpdateTrigger') = 1 THEN 'INSERT, UPDATE'
                        WHEN OBJECTPROPERTY(t.object_id, 'ExecIsInsertTrigger') = 1 
                             AND OBJECTPROPERTY(t.object_id, 'ExecIsDeleteTrigger') = 1 THEN 'INSERT, DELETE'
                        WHEN OBJECTPROPERTY(t.object_id, 'ExecIsUpdateTrigger') = 1 
                             AND OBJECTPROPERTY(t.object_id, 'ExecIsDeleteTrigger') = 1 THEN 'UPDATE, DELETE'
                        WHEN OBJECTPROPERTY(t.object_id, 'ExecIsInsertTrigger') = 1 THEN 'INSERT'
                        WHEN OBJECTPROPERTY(t.object_id, 'ExecIsUpdateTrigger') = 1 THEN 'UPDATE'
                        WHEN OBJECTPROPERTY(t.object_id, 'ExecIsDeleteTrigger') = 1 THEN 'DELETE'
                        ELSE 'UNKNOWN'
                    END as operation_type
                FROM sys.triggers t
                WHERE OBJECT_NAME(t.parent_id) = '${tableName}'
                AND t.parent_class = 1
            `);

            // Get foreign key relationships
            const foreignKeys = await this._connectionManager.executeQuery(`
                USE [${database}];
                SELECT 
                    OBJECT_NAME(fk.parent_object_id) as object_name,
                    'Table' as object_type,
                    '${tableName}' as table_name,
                    'FOREIGN KEY' as operation_type
                FROM sys.foreign_keys fk
                WHERE OBJECT_NAME(fk.referenced_object_id) = '${tableName}'
                
                UNION ALL
                
                SELECT 
                    '${tableName}' as object_name,
                    'Table' as object_type,
                    OBJECT_NAME(fk.referenced_object_id) as table_name,
                    'REFERENCES' as operation_type
                FROM sys.foreign_keys fk
                WHERE OBJECT_NAME(fk.parent_object_id) = '${tableName}'
            `);

            // Combine all results
            const allReferences = [
                ...objectReferences,
                ...triggers.recordset,
                ...foreignKeys.recordset
            ];

            return {
                tableName: tableName,
                usedByObjects: allReferences,
                summary: this._generateTableUsageSummary(allReferences)
            };
        } catch (error) {
            console.error('Error getting table usage by objects:', error);
            return {
                tableName: tableName,
                usedByObjects: [],
                summary: { totalObjects: 0, procedures: 0, views: 0, functions: 0, triggers: 0, tables: 0 }
            };
        }
    }

    /**
     * Get detailed trigger analysis
     * @param {string} database - Database name
     * @returns {Promise<Array<Object>>} Array of triggers with their table associations
     */
    async getTriggerAnalysis(database) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        const result = await this._connectionManager.executeQuery(`
            USE [${database}];
            
            SELECT 
                t.name as trigger_name,
                OBJECT_NAME(t.parent_id) as table_name,
                t.type_desc,
                t.is_disabled,
                CASE 
                    WHEN OBJECTPROPERTY(t.object_id, 'ExecIsInsertTrigger') = 1 
                         AND OBJECTPROPERTY(t.object_id, 'ExecIsUpdateTrigger') = 1 
                         AND OBJECTPROPERTY(t.object_id, 'ExecIsDeleteTrigger') = 1 THEN 'INSERT, UPDATE, DELETE'
                    WHEN OBJECTPROPERTY(t.object_id, 'ExecIsInsertTrigger') = 1 
                         AND OBJECTPROPERTY(t.object_id, 'ExecIsUpdateTrigger') = 1 THEN 'INSERT, UPDATE'
                    WHEN OBJECTPROPERTY(t.object_id, 'ExecIsInsertTrigger') = 1 
                         AND OBJECTPROPERTY(t.object_id, 'ExecIsDeleteTrigger') = 1 THEN 'INSERT, DELETE'
                    WHEN OBJECTPROPERTY(t.object_id, 'ExecIsUpdateTrigger') = 1 
                         AND OBJECTPROPERTY(t.object_id, 'ExecIsDeleteTrigger') = 1 THEN 'UPDATE, DELETE'
                    WHEN OBJECTPROPERTY(t.object_id, 'ExecIsInsertTrigger') = 1 THEN 'INSERT'
                    WHEN OBJECTPROPERTY(t.object_id, 'ExecIsUpdateTrigger') = 1 THEN 'UPDATE'
                    WHEN OBJECTPROPERTY(t.object_id, 'ExecIsDeleteTrigger') = 1 THEN 'DELETE'
                    ELSE 'UNKNOWN'
                END as trigger_event,
                CASE 
                    WHEN OBJECTPROPERTY(t.object_id, 'ExecIsAfterTrigger') = 1 THEN 'AFTER'
                    WHEN OBJECTPROPERTY(t.object_id, 'ExecIsInsteadOfTrigger') = 1 THEN 'INSTEAD OF'
                    ELSE 'UNKNOWN'
                END as trigger_timing,
                t.create_date,
                t.modify_date
            FROM sys.triggers t
            WHERE t.parent_class = 1  -- Table triggers only
            ORDER BY OBJECT_NAME(t.parent_id), t.name
        `);

        return result.recordset;
    }

    /**
     * Get objects that this object depends on
     * @param {string} database - Database name
     * @param {string} objectName - Object name
     * @returns {Promise<Array<Object>>} Array of dependency objects
     * @private
     */
    async _getDependsOn(database, objectName) {
        const result = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT DISTINCT
                OBJECT_NAME(sed.referenced_id) as referenced_object,
                CASE 
                    WHEN o.type = 'U' THEN 'Table'
                    WHEN o.type = 'V' THEN 'View'
                    WHEN o.type = 'P' THEN 'Procedure'
                    WHEN o.type IN ('FN', 'IF', 'TF') THEN 'Function'
                    ELSE o.type_desc
                END as referenced_object_type,
                'Expression' as dependency_type
            FROM sys.sql_expression_dependencies sed
            JOIN sys.objects o ON sed.referenced_id = o.object_id
            WHERE OBJECT_NAME(sed.referencing_id) = '${objectName}'
            AND sed.referenced_id > 0
            AND OBJECT_NAME(sed.referenced_id) IS NOT NULL
            
            UNION ALL
            
            -- Foreign Key dependencies for tables
            SELECT DISTINCT
                OBJECT_NAME(fk.referenced_object_id) as referenced_object,
                'Table' as referenced_object_type,
                'Foreign Key' as dependency_type
            FROM sys.foreign_keys fk
            WHERE OBJECT_NAME(fk.parent_object_id) = '${objectName}'
            
            ORDER BY referenced_object
        `);

        return result.recordset.filter(row => row.referenced_object);
    }

    /**
     * Get objects that reference this object
     * @param {string} database - Database name
     * @param {string} objectName - Object name
     * @returns {Promise<Array<Object>>} Array of referencing objects
     * @private
     */
    async _getReferencedBy(database, objectName) {
        const result = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT DISTINCT
                OBJECT_NAME(sed.referencing_id) as referencing_object,
                CASE 
                    WHEN o.type = 'U' THEN 'Table'
                    WHEN o.type = 'V' THEN 'View'
                    WHEN o.type = 'P' THEN 'Procedure'
                    WHEN o.type IN ('FN', 'IF', 'TF') THEN 'Function'
                    ELSE o.type_desc
                END as referencing_object_type,
                'Expression' as dependency_type
            FROM sys.sql_expression_dependencies sed
            JOIN sys.objects o ON sed.referencing_id = o.object_id
            WHERE OBJECT_NAME(sed.referenced_id) = '${objectName}'
            AND OBJECT_NAME(sed.referencing_id) IS NOT NULL
            
            UNION ALL
            
            -- Tables that reference this table via foreign keys
            SELECT DISTINCT
                OBJECT_NAME(fk.parent_object_id) as referencing_object,
                'Table' as referencing_object_type,
                'Foreign Key' as dependency_type
            FROM sys.foreign_keys fk
            WHERE OBJECT_NAME(fk.referenced_object_id) = '${objectName}'
            
            ORDER BY referencing_object
        `);

        return result.recordset.filter(row => row.referencing_object);
    }

    /**
     * Get alternative dependencies using sys.dm_sql_referenced_entities
     * @param {string} database - Database name
     * @param {string} objectName - Object name
     * @returns {Promise<Array<Object>>} Array of dependency objects
     * @private
     */
    async _getAlternativeDependencies(database, objectName) {
        try {
            const result = await this._connectionManager.executeQuery(`
                USE [${database}];
                SELECT DISTINCT
                    referenced_entity_name as referenced_object,
                    CASE 
                        WHEN referenced_class_desc = 'OBJECT_OR_COLUMN' THEN 
                            CASE 
                                WHEN o.type = 'U' THEN 'Table'
                                WHEN o.type = 'V' THEN 'View'
                                WHEN o.type = 'P' THEN 'Procedure'
                                WHEN o.type IN ('FN', 'IF', 'TF') THEN 'Function'
                                ELSE 'Object'
                            END
                        ELSE referenced_class_desc
                    END as referenced_object_type,
                    'Reference' as dependency_type
                FROM sys.dm_sql_referenced_entities('dbo.${objectName}', 'OBJECT') r
                LEFT JOIN sys.objects o ON o.name = r.referenced_entity_name
                WHERE referenced_entity_name IS NOT NULL
                AND referenced_schema_name IS NOT NULL
            `);
            
            return result.recordset.filter(row => row.referenced_object);
        } catch (error) {
            console.log('Alternative dependency method not available:', error.message);
            return [];
        }
    }

    /**
     * Remove duplicate dependencies based on object name
     * @param {Array<Object>} dependencies - Array of dependency objects
     * @returns {Array<Object>} Deduplicated array
     * @private
     */
    _removeDuplicateDependencies(dependencies) {
        const seen = new Set();
        return dependencies.filter(dep => {
            const key = dep.referenced_object || dep.referencing_object;
            if (!key || seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }

    /**
     * Generate table usage summary for a specific table
     * @param {Array<Object>} objectReferences - Array of object references
     * @returns {Object} Usage summary
     * @private
     */
    _generateTableUsageSummary(objectReferences) {
        const summary = {
            totalObjects: objectReferences.length,
            procedures: 0,
            views: 0,
            functions: 0,
            triggers: 0,
            tables: 0
        };

        objectReferences.forEach(ref => {
            const objType = ref.object_type || 'Unknown';
            switch (objType) {
                case 'Procedure':
                    summary.procedures++;
                    break;
                case 'View':
                    summary.views++;
                    break;
                case 'Function':
                    summary.functions++;
                    break;
                case 'Trigger':
                    summary.triggers++;
                    break;
                case 'Table':
                    summary.tables++;
                    break;
            }
        });

        return summary;
    }

    /**
     * Get dependency tree for an object (multi-level dependencies)
     * @param {string} database - Database name
     * @param {string} objectName - Object name
     * @param {number} maxDepth - Maximum depth to traverse (default: 3)
     * @returns {Promise<Object>} Dependency tree
     */
    async getDependencyTree(database, objectName, maxDepth = 3) {
        const visited = new Set();
        const tree = {
            name: objectName,
            dependencies: [],
            level: 0
        };

        await this._buildDependencyTree(database, objectName, tree, visited, maxDepth, 0);
        return tree;
    }

    /**
     * Recursively build dependency tree
     * @param {string} database - Database name
     * @param {string} objectName - Object name
     * @param {Object} node - Current tree node
     * @param {Set} visited - Set of visited objects
     * @param {number} maxDepth - Maximum depth
     * @param {number} currentDepth - Current depth
     * @private
     */
    async _buildDependencyTree(database, objectName, node, visited, maxDepth, currentDepth) {
        if (currentDepth >= maxDepth || visited.has(objectName)) {
            return;
        }

        visited.add(objectName);
        const dependencies = await this.getDependencies(database, objectName);

        for (const dep of dependencies.dependsOn) {
            const childNode = {
                name: dep.referenced_object,
                type: dep.referenced_object_type,
                dependency_type: dep.dependency_type,
                dependencies: [],
                level: currentDepth + 1
            };

            node.dependencies.push(childNode);

            // Recursively get dependencies for this object
            await this._buildDependencyTree(
                database, 
                dep.referenced_object, 
                childNode, 
                visited, 
                maxDepth, 
                currentDepth + 1
            );
        }
    }

    /**
     * Get impact analysis for an object (what would be affected if this object changes)
     * @param {string} database - Database name
     * @param {string} objectName - Object name
     * @returns {Promise<Array<Object>>} Array of impacted objects
     */
    async getImpactAnalysis(database, objectName) {
        const dependencies = await this.getDependencies(database, objectName);
        
        // Objects that would be impacted are those that reference this object
        return dependencies.referencedBy.map(dep => ({
            object: dep.referencing_object,
            type: dep.referencing_object_type,
            impact_type: dep.dependency_type,
            severity: this._calculateImpactSeverity(dep.referencing_object_type)
        }));
    }

    /**
     * Calculate impact severity based on object type
     * @param {string} objectType - Type of the impacted object
     * @returns {string} Severity level
     * @private
     */
    _calculateImpactSeverity(objectType) {
        switch (objectType) {
            case 'Table':
                return 'High'; // Tables are critical
            case 'View':
                return 'Medium'; // Views can usually be recreated
            case 'Procedure':
                return 'Medium'; // Procedures contain business logic
            case 'Function':
                return 'Low'; // Functions are usually more isolated
            default:
                return 'Unknown';
        }
    }
}

module.exports = DependencyService;