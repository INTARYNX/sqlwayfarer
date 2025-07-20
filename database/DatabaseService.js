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
     * Get database objects (tables, views, procedures, functions)
     * @param {string} database - Database name
     * @returns {Promise<Array<Object>>} Array of database objects
     */
    async getObjects(database) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        const result = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT 
                name,
                type_desc,
                CASE 
                    WHEN type = 'U' THEN 'Table'
                    WHEN type = 'V' THEN 'View'
                    WHEN type = 'P' THEN 'Procedure'
                    WHEN type = 'FN' THEN 'Function'
                    ELSE type_desc
                END as object_type
            FROM sys.objects 
            WHERE type IN ('U', 'V', 'P', 'FN')
            ORDER BY type, name
        `);

        return result.recordset;
    }

    /**
     * Get detailed information about a table
     * @param {string} database - Database name
     * @param {string} tableName - Table name
     * @returns {Promise<Object>} Table details including columns, indexes, and foreign keys
     */
    async getTableDetails(database, tableName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        // Get columns
        const columnsResult = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT 
                COLUMN_NAME,
                DATA_TYPE,
                IS_NULLABLE,
                COLUMN_DEFAULT,
                CHARACTER_MAXIMUM_LENGTH
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = '${tableName}'
            ORDER BY ORDINAL_POSITION
        `);

        // Get indexes
        const indexesResult = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT 
                i.name as index_name,
                i.type_desc,
                i.is_unique,
                i.is_primary_key,
                STRING_AGG(c.name, ', ') as columns
            FROM sys.indexes i
            JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
            JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
            WHERE i.object_id = OBJECT_ID('${tableName}')
            AND i.type > 0
            GROUP BY i.name, i.type_desc, i.is_unique, i.is_primary_key
            ORDER BY i.is_primary_key DESC, i.name
        `);

        // Get foreign keys
        const fkResult = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT 
                fk.name as fk_name,
                OBJECT_NAME(fk.parent_object_id) as table_name,
                c1.name as column_name,
                OBJECT_NAME(fk.referenced_object_id) as referenced_table,
                c2.name as referenced_column
            FROM sys.foreign_keys fk
            JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
            JOIN sys.columns c1 ON fkc.parent_object_id = c1.object_id AND fkc.parent_column_id = c1.column_id
            JOIN sys.columns c2 ON fkc.referenced_object_id = c2.object_id AND fkc.referenced_column_id = c2.column_id
            WHERE OBJECT_NAME(fk.parent_object_id) = '${tableName}'
        `);

        return {
            tableName: tableName,
            columns: columnsResult.recordset,
            indexes: indexesResult.recordset,
            foreignKeys: fkResult.recordset
        };
    }

    /**
     * Get object definition for views, procedures, and functions
     * @param {string} database - Database name
     * @param {string} objectName - Object name
     * @returns {Promise<string|null>} Object definition or null if not available
     */
    async getObjectDefinition(database, objectName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        const result = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT OBJECT_DEFINITION(OBJECT_ID('${objectName}')) as definition
        `);

        return result.recordset[0]?.definition || null;
    }

    /**
     * Get basic information about any database object
     * @param {string} database - Database name
     * @param {string} objectName - Object name
     * @returns {Promise<Object|null>} Object information or null if not found
     */
    async getObjectInfo(database, objectName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        const result = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT 
                name,
                type_desc,
                CASE 
                    WHEN type = 'U' THEN 'Table'
                    WHEN type = 'V' THEN 'View'
                    WHEN type = 'P' THEN 'Procedure'
                    WHEN type IN ('FN', 'IF', 'TF') THEN 'Function'
                    ELSE type_desc
                END as object_type,
                create_date,
                modify_date
            FROM sys.objects 
            WHERE name = '${objectName}'
        `);

        return result.recordset[0] || null;
    }

    /**
     * Search for objects by name pattern
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
                name,
                type_desc,
                CASE 
                    WHEN type = 'U' THEN 'Table'
                    WHEN type = 'V' THEN 'View'
                    WHEN type = 'P' THEN 'Procedure'
                    WHEN type IN ('FN', 'IF', 'TF') THEN 'Function'
                    ELSE type_desc
                END as object_type
            FROM sys.objects 
            WHERE name LIKE '${searchPattern}'
            AND type IN (${typeFilter})
            ORDER BY type, name
        `);

        return result.recordset;
    }

    /**
     * Get table row count
     * @param {string} database - Database name
     * @param {string} tableName - Table name
     * @returns {Promise<number>} Row count
     */
    async getTableRowCount(database, tableName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        const result = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT COUNT(*) as row_count FROM [${tableName}]
        `);

        return result.recordset[0]?.row_count || 0;
    }

    /**
     * Get table sample data
     * @param {string} database - Database name
     * @param {string} tableName - Table name
     * @param {number} limit - Number of rows to return (default: 100)
     * @returns {Promise<Array<Object>>} Sample rows
     */
    async getTableSampleData(database, tableName, limit = 100) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        const result = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT TOP ${limit} * FROM [${tableName}]
        `);

        return result.recordset;
    }
}

module.exports = DatabaseService;