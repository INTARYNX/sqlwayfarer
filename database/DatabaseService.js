/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

/**
 * Provides database-related services and queries
 * Handles retrieval of databases, objects, and their details
 * ENHANCED: Better schema support and qualified names
 */
class DatabaseService {
    constructor(connectionManager) {
        this._connectionManager = connectionManager;
    }

    /**
     * Get list of user databases (excludes system databases)
     * @returns {Promise<Array<string>>} Array of database names
     */
    async getDatabases() {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        const result = await this._connectionManager.executeQuery(`
            SELECT name FROM sys.databases 
            WHERE name NOT IN ('master', 'tempdb', 'model', 'msdb')
            ORDER BY name
        `);

        return result.recordset.map(row => row.name);
    }

    /**
     * Get database objects (tables, views, procedures, functions) with schema information
     * ENHANCED: Better schema handling and qualified names
     * @param {string} database - Database name
     * @returns {Promise<Array<Object>>} Array of database objects with schema info
     */
    async getObjects(database) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        const result = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT 
                o.name as object_name,
                o.type_desc,
                CASE 
                    WHEN o.type = 'U' THEN 'Table'
                    WHEN o.type = 'V' THEN 'View'
                    WHEN o.type = 'P' THEN 'Procedure'
                    WHEN o.type IN ('FN', 'IF', 'TF') THEN 'Function'
                    ELSE o.type_desc
                END as object_type,
                s.name as schema_name,
                -- Create display name with schema when not dbo
                CASE 
                    WHEN s.name = 'dbo' THEN o.name
                    ELSE s.name + '.' + o.name
                END as display_name,
                -- Always create qualified name for backend operations
                s.name + '.' + o.name as qualified_name,
                -- Object creation info
                o.create_date,
                o.modify_date,
                -- Check if object is encrypted (for procedures/functions)
                CASE 
                    WHEN o.type IN ('P', 'FN', 'IF', 'TF') THEN 
                        CASE WHEN OBJECTPROPERTY(o.object_id, 'IsEncrypted') = 1 THEN 1 ELSE 0 END
                    ELSE 0
                END as is_encrypted
            FROM sys.objects o
            INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
            WHERE o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF')
            ORDER BY s.name, o.type, o.name
        `);

        return result.recordset.map(row => ({
            name: row.display_name,           // What user sees in UI
            object_name: row.object_name,     // Object name without schema
            qualified_name: row.qualified_name, // Always schema.object for backend
            object_type: row.object_type,
            schema_name: row.schema_name,
            create_date: row.create_date,
            modify_date: row.modify_date,
            is_encrypted: row.is_encrypted
        }));
    }

    /**
     * Get detailed information about a table with enhanced schema support
     * @param {string} database - Database name
     * @param {string} tableName - Table name (can be qualified with schema)
     * @returns {Promise<Object>} Table details including columns, indexes, and foreign keys
     */
    async getTableDetails(database, tableName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        // Parse table name to handle schema
        const { schema, objectName } = this._parseObjectName(tableName);
        const qualifiedTableName = `${schema}.${objectName}`;

        // Get columns with enhanced schema handling
        const columnsResult = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT 
                c.COLUMN_NAME,
                c.DATA_TYPE,
                c.IS_NULLABLE,
                c.COLUMN_DEFAULT,
                c.CHARACTER_MAXIMUM_LENGTH,
                c.ORDINAL_POSITION,
                c.NUMERIC_PRECISION,
                c.NUMERIC_SCALE,
                -- Check for identity columns
                CASE WHEN ic.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END as IS_IDENTITY,
                -- Check for computed columns
                CASE WHEN cc.column_id IS NOT NULL THEN 1 ELSE 0 END as IS_COMPUTED
            FROM INFORMATION_SCHEMA.COLUMNS c
            LEFT JOIN INFORMATION_SCHEMA.IDENTITY_COLUMNS ic 
                ON c.TABLE_CATALOG = ic.TABLE_CATALOG 
                AND c.TABLE_SCHEMA = ic.TABLE_SCHEMA 
                AND c.TABLE_NAME = ic.TABLE_NAME 
                AND c.COLUMN_NAME = ic.COLUMN_NAME
            LEFT JOIN sys.computed_columns cc 
                ON cc.object_id = OBJECT_ID('${qualifiedTableName}')
                AND cc.name = c.COLUMN_NAME
            WHERE c.TABLE_SCHEMA = '${schema}' 
            AND c.TABLE_NAME = '${objectName}'
            ORDER BY c.ORDINAL_POSITION
        `);

        // Get indexes with enhanced schema handling
        const indexesResult = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT 
                i.name as index_name,
                i.type_desc,
                i.is_unique,
                i.is_primary_key,
                i.is_unique_constraint,
                STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) as columns,
                i.fill_factor,
                i.has_filter,
                i.filter_definition
            FROM sys.indexes i
            JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
            JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
            WHERE i.object_id = OBJECT_ID('${qualifiedTableName}')
            AND i.type > 0  -- Exclude heaps
            GROUP BY i.name, i.type_desc, i.is_unique, i.is_primary_key, i.is_unique_constraint, 
                     i.fill_factor, i.has_filter, i.filter_definition
            ORDER BY i.is_primary_key DESC, i.is_unique DESC, i.name
        `);

        // Get foreign keys with enhanced schema handling
        const fkResult = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT 
                fk.name as fk_name,
                SCHEMA_NAME(fk.schema_id) + '.' + OBJECT_NAME(fk.parent_object_id) as table_name,
                c1.name as column_name,
                SCHEMA_NAME(ref_obj.schema_id) + '.' + OBJECT_NAME(fk.referenced_object_id) as referenced_table,
                c2.name as referenced_column,
                fk.delete_referential_action_desc,
                fk.update_referential_action_desc
            FROM sys.foreign_keys fk
            JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
            JOIN sys.columns c1 ON fkc.parent_object_id = c1.object_id AND fkc.parent_column_id = c1.column_id
            JOIN sys.columns c2 ON fkc.referenced_object_id = c2.object_id AND fkc.referenced_column_id = c2.column_id
            JOIN sys.objects ref_obj ON fk.referenced_object_id = ref_obj.object_id
            WHERE fk.parent_object_id = OBJECT_ID('${qualifiedTableName}')
            ORDER BY fk.name, fkc.constraint_column_id
        `);

        return {
            tableName: tableName,
            qualifiedName: qualifiedTableName,
            schema: schema,
            objectName: objectName,
            columns: columnsResult.recordset,
            indexes: indexesResult.recordset,
            foreignKeys: fkResult.recordset
        };
    }

    /**
     * Get object definition with enhanced schema awareness
     * @param {string} database - Database name
     * @param {string} objectName - Object name (can be qualified with schema)
     * @returns {Promise<string|null>} Object definition or null if not available
     */
    async getObjectDefinition(database, objectName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            // Parse object name to handle schema
            const { schema, objectName: parsedObjectName } = this._parseObjectName(objectName);
            const qualifiedObjectName = `${schema}.${parsedObjectName}`;

            console.log(`Getting definition for: ${qualifiedObjectName}`);

            // Try with the qualified name first
            let result = await this._connectionManager.executeQuery(`
                USE [${database}];
                SELECT OBJECT_DEFINITION(OBJECT_ID('${qualifiedObjectName}')) as definition
            `);

            let definition = result.recordset[0]?.definition;
            if (definition && definition.trim() !== '') {
                return definition;
            }

            // If no schema was provided in original name, try common schemas
            if (!objectName.includes('.')) {
                const schemasToTry = ['dbo', 'hr', 'sales', 'production', 'purchasing', 'person'];
                
                for (const schemaToTry of schemasToTry) {
                    try {
                        result = await this._connectionManager.executeQuery(`
                            USE [${database}];
                            SELECT OBJECT_DEFINITION(OBJECT_ID('${schemaToTry}.${parsedObjectName}')) as definition
                        `);
                        
                        definition = result.recordset[0]?.definition;
                        if (definition && definition.trim() !== '') {
                            console.log(`Found ${parsedObjectName} in schema ${schemaToTry}`);
                            return definition;
                        }
                    } catch (error) {
                        continue; // Try next schema
                    }
                }
            }

            return null;
            
        } catch (error) {
            console.error(`Error getting definition for ${objectName}:`, error);
            return null;
        }
    }

    /**
     * Get basic information about any database object with schema support
     * @param {string} database - Database name
     * @param {string} objectName - Object name (can be qualified with schema)
     * @returns {Promise<Object|null>} Object information or null if not found
     */
    async getObjectInfo(database, objectName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        const { schema, objectName: parsedObjectName } = this._parseObjectName(objectName);
        const qualifiedObjectName = `${schema}.${parsedObjectName}`;

        const result = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT 
                o.name,
                o.type_desc,
                CASE 
                    WHEN o.type = 'U' THEN 'Table'
                    WHEN o.type = 'V' THEN 'View'
                    WHEN o.type = 'P' THEN 'Procedure'
                    WHEN o.type IN ('FN', 'IF', 'TF') THEN 'Function'
                    ELSE o.type_desc
                END as object_type,
                o.create_date,
                o.modify_date,
                SCHEMA_NAME(o.schema_id) as schema_name,
                CASE WHEN OBJECTPROPERTY(o.object_id, 'IsEncrypted') = 1 THEN 1 ELSE 0 END as is_encrypted
            FROM sys.objects o
            WHERE o.object_id = OBJECT_ID('${qualifiedObjectName}')
               OR (SCHEMA_NAME(o.schema_id) = '${schema}' AND o.name = '${parsedObjectName}')
        `);

        return result.recordset[0] || null;
    }

    /**
     * Search for objects by name pattern with schema support
     * @param {string} database - Database name
     * @param {string} searchPattern - Search pattern (supports SQL LIKE wildcards)
     * @param {Array<string>} objectTypes - Object types to include (optional)
     * @returns {Promise<Array<Object>>} Array of matching objects
     */
    async searchObjects(database, searchPattern, objectTypes = ['U', 'V', 'P', 'FN']) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        const typeFilter = objectTypes.map(t => `'${t}'`).join(',');
        
        const result = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT 
                o.name as object_name,
                o.type_desc,
                CASE 
                    WHEN o.type = 'U' THEN 'Table'
                    WHEN o.type = 'V' THEN 'View'
                    WHEN o.type = 'P' THEN 'Procedure'
                    WHEN o.type IN ('FN', 'IF', 'TF') THEN 'Function'
                    ELSE o.type_desc
                END as object_type,
                s.name as schema_name,
                CASE 
                    WHEN s.name = 'dbo' THEN o.name
                    ELSE s.name + '.' + o.name
                END as display_name,
                s.name + '.' + o.name as qualified_name
            FROM sys.objects o
            INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
            WHERE (o.name LIKE '${searchPattern}' 
                   OR (s.name + '.' + o.name) LIKE '${searchPattern}')
            AND o.type IN (${typeFilter})
            ORDER BY s.name, o.type, o.name
        `);

        return result.recordset.map(row => ({
            name: row.display_name,
            object_name: row.object_name,
            qualified_name: row.qualified_name,
            object_type: row.object_type,
            schema_name: row.schema_name
        }));
    }

    /**
     * Get table row count with schema support
     * @param {string} database - Database name
     * @param {string} tableName - Table name (can be qualified with schema)
     * @returns {Promise<number>} Row count
     */
    async getTableRowCount(database, tableName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        const { schema, objectName } = this._parseObjectName(tableName);
        const qualifiedTableName = `[${schema}].[${objectName}]`;

        const result = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT COUNT(*) as row_count FROM ${qualifiedTableName}
        `);

        return result.recordset[0]?.row_count || 0;
    }

    /**
     * Get table sample data with schema support
     * @param {string} database - Database name
     * @param {string} tableName - Table name (can be qualified with schema)
     * @param {number} limit - Number of rows to return (default: 100)
     * @returns {Promise<Array<Object>>} Array of sample rows
     */
    async getTableSampleData(database, tableName, limit = 100) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        const { schema, objectName } = this._parseObjectName(tableName);
        const qualifiedTableName = `[${schema}].[${objectName}]`;

        const result = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT TOP ${limit} * FROM ${qualifiedTableName}
        `);

        return result.recordset;
    }

    /**
     * Parse object name to extract schema and object name
     * @param {string} objectName - Object name (can be qualified with schema)
     * @returns {Object} Object with schema and objectName properties
     * @private
     */
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

    /**
     * Get all schemas in the database
     * @param {string} database - Database name
     * @returns {Promise<Array<string>>} Array of schema names
     */
    async getSchemas(database) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        const result = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT 
                s.name as schema_name,
                p.name as principal_name,
                s.schema_id
            FROM sys.schemas s
            LEFT JOIN sys.database_principals p ON s.principal_id = p.principal_id
            WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA')
            ORDER BY s.name
        `);

        return result.recordset.map(row => ({
            name: row.schema_name,
            principal: row.principal_name,
            schema_id: row.schema_id
        }));
    }
}

module.exports = DatabaseService;