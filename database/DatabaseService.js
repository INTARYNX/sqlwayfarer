'use strict';

const parseObjectName = require('./parseObjectName');
const { bracketIdentifier } = require('./sqlIdentifier');

class DatabaseService {
    constructor(connectionManager) {
        this._connectionManager = connectionManager;
    }

    async getDatabases() {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');

        const result = await this._connectionManager.executeQuery(`
            SELECT name FROM sys.databases
            WHERE name NOT IN ('master', 'tempdb', 'model', 'msdb')
            ORDER BY name
        `);
        return result.recordset.map(row => row.name);
    }

    async getObjects(database) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');

        const result = await this._connectionManager.executeQueryInDatabase(database, `
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
                CASE WHEN s.name = 'dbo' THEN o.name ELSE s.name + '.' + o.name END as display_name,
                s.name + '.' + o.name as qualified_name,
                o.create_date,
                o.modify_date,
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
            name: row.display_name,             // shown in UI
            object_name: row.object_name,       // bare name without schema
            qualified_name: row.qualified_name, // schema.object used for backend queries
            object_type: row.object_type,
            schema_name: row.schema_name,
            create_date: row.create_date,
            modify_date: row.modify_date,
            is_encrypted: row.is_encrypted
        }));
    }

    // LIKE treats [, % and _ as wildcards; wrap them in brackets so user input
    // is matched literally.
    static escapeLikePattern(text) {
        return String(text).replace(/[[%_]/g, ch => `[${ch}]`);
    }

    // Full-text search inside object definitions (views, procedures, functions,
    // triggers - tables have no sys.sql_modules entry).
    async searchInDefinitions(database, searchText) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');

        const pattern = `%${DatabaseService.escapeLikePattern(searchText)}%`;
        const result = await this._connectionManager.executeQueryInDatabase(database, `
            SELECT
                o.name as object_name,
                s.name as schema_name,
                s.name + '.' + o.name as qualified_name,
                CASE
                    WHEN o.type = 'V' THEN 'View'
                    WHEN o.type = 'P' THEN 'Procedure'
                    WHEN o.type IN ('FN', 'IF', 'TF') THEN 'Function'
                    ELSE o.type_desc
                END as object_type
            FROM sys.objects o
            INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
            INNER JOIN sys.sql_modules m ON m.object_id = o.object_id
            WHERE m.definition LIKE @pattern
            ORDER BY s.name, o.name
        `, { pattern });

        return result.recordset.map(row => ({
            object_name: row.object_name,
            schema_name: row.schema_name,
            qualified_name: row.qualified_name,
            object_type: row.object_type
        }));
    }

    // Every FK edge in the database, one row per column (multi-column FKs span
    // several rows sharing fk_name). Cheap enough to call on every database
    // switch - used by the write footprint graph and by join-condition
    // autocompletion, so it lives here rather than duplicated in each caller.
    async getForeignKeys(database) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');

        const result = await this._connectionManager.executeQueryInDatabase(database, `
            SELECT fk.name AS fk_name,
                   s1.name + '.' + t1.name AS from_table, c1.name AS from_column,
                   s2.name + '.' + t2.name AS to_table, c2.name AS to_column
            FROM sys.foreign_keys fk
            JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
            JOIN sys.tables t1 ON t1.object_id = fk.parent_object_id
            JOIN sys.schemas s1 ON s1.schema_id = t1.schema_id
            JOIN sys.columns c1 ON c1.object_id = fkc.parent_object_id AND c1.column_id = fkc.parent_column_id
            JOIN sys.tables t2 ON t2.object_id = fk.referenced_object_id
            JOIN sys.schemas s2 ON s2.schema_id = t2.schema_id
            JOIN sys.columns c2 ON c2.object_id = fkc.referenced_object_id AND c2.column_id = fkc.referenced_column_id
        `);
        return result.recordset.map(r => ({
            fkName: r.fk_name,
            fromTable: r.from_table, fromColumn: r.from_column,
            toTable: r.to_table, toColumn: r.to_column
        }));
    }

    // Lightweight column list for query autocompletion - getTableDetails is far
    // too heavy (indexes, FKs, dependencies) to call on every completion request.
    async getObjectColumns(database, objectName) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');

        const result = await this._connectionManager.executeQueryInDatabase(database, `
            SELECT c.name AS column_name, TYPE_NAME(c.user_type_id) AS data_type
            FROM sys.columns c
            WHERE c.object_id = OBJECT_ID(@objectName)
            ORDER BY c.column_id
        `, { objectName });

        return result.recordset.map(row => ({ name: row.column_name, type: row.data_type }));
    }

    async getTableDetails(database, tableName) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');

        const { schema, objectName } = this._parseObjectName(tableName);
        const qualifiedTableName = `${schema}.${objectName}`;
        const objectIdExpr = "OBJECT_ID(QUOTENAME(@schema) + '.' + QUOTENAME(@objectName))";

        const columnsResult = await this._connectionManager.executeQueryInDatabase(database, `
            SELECT
                c.COLUMN_NAME,
                c.DATA_TYPE,
                c.IS_NULLABLE,
                c.COLUMN_DEFAULT,
                c.CHARACTER_MAXIMUM_LENGTH,
                c.ORDINAL_POSITION,
                c.NUMERIC_PRECISION,
                c.NUMERIC_SCALE,
                c.DATETIME_PRECISION,
                CASE WHEN ic.column_id IS NOT NULL THEN 1 ELSE 0 END as IS_IDENTITY,
                CASE WHEN cc.column_id IS NOT NULL THEN 1 ELSE 0 END as IS_COMPUTED,
                TRY_CONVERT(bigint, ic.seed_value) as IDENTITY_SEED,
                TRY_CONVERT(bigint, ic.increment_value) as IDENTITY_INCREMENT,
                cc.definition as COMPUTED_DEFINITION
            FROM INFORMATION_SCHEMA.COLUMNS c
            LEFT JOIN sys.identity_columns ic
                ON ic.object_id = ${objectIdExpr} AND ic.name = c.COLUMN_NAME
            LEFT JOIN sys.computed_columns cc
                ON cc.object_id = ${objectIdExpr} AND cc.name = c.COLUMN_NAME
            WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @objectName
            ORDER BY c.ORDINAL_POSITION
        `, { schema, objectName });

        const indexesResult = await this._connectionManager.executeQueryInDatabase(database, `
            SELECT
                i.name as index_name,
                i.type_desc,
                i.is_unique,
                i.is_primary_key,
                i.is_unique_constraint,
                -- Both STRING_AGGs must share the same ORDER BY - SQL Server
                -- rejects "mutually incompatible orderings" for two ordered
                -- aggregates in the same scope. index_column_id works for both:
                -- verified live that it matches key_ordinal's order for key
                -- columns, then continues in INCLUDE-clause order for the rest.
                STRING_AGG(CASE WHEN ic.is_included_column = 0 THEN c.name END, ', ')
                    WITHIN GROUP (ORDER BY ic.index_column_id) as columns,
                STRING_AGG(CASE WHEN ic.is_included_column = 1 THEN c.name END, ', ')
                    WITHIN GROUP (ORDER BY ic.index_column_id) as included_columns,
                i.fill_factor,
                i.has_filter,
                i.filter_definition
            FROM sys.indexes i
            JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
            JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
            WHERE i.object_id = ${objectIdExpr}
            AND i.type > 0  -- exclude heaps
            GROUP BY i.name, i.type_desc, i.is_unique, i.is_primary_key, i.is_unique_constraint,
                    i.fill_factor, i.has_filter, i.filter_definition
            ORDER BY i.is_primary_key DESC, i.is_unique DESC, i.name
        `, { schema, objectName });

        const fkResult = await this._connectionManager.executeQueryInDatabase(database, `
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
            WHERE fk.parent_object_id = ${objectIdExpr}
            ORDER BY fk.name, fkc.constraint_column_id
        `, { schema, objectName });

        return {
            tableName, qualifiedName: qualifiedTableName, schema, objectName,
            columns: columnsResult.recordset,
            indexes: indexesResult.recordset,
            foreignKeys: fkResult.recordset
        };
    }

    async getObjectDefinition(database, objectName) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');

        try {
            const { schema, objectName: parsedName } = this._parseObjectName(objectName);

            let result = await this._connectionManager.executeQueryInDatabase(database, `
                SELECT OBJECT_DEFINITION(OBJECT_ID(QUOTENAME(@schema) + '.' + QUOTENAME(@objectName))) as definition
            `, { schema, objectName: parsedName });

            let definition = result.recordset[0]?.definition;
            if (definition && definition.trim()) return definition;

            // Fall back to probing common schemas when no schema was specified
            if (!objectName.includes('.')) {
                for (const s of ['dbo', 'hr', 'sales', 'production', 'purchasing', 'person']) {
                    try {
                        result = await this._connectionManager.executeQueryInDatabase(database, `
                            SELECT OBJECT_DEFINITION(OBJECT_ID(QUOTENAME(@schema) + '.' + QUOTENAME(@objectName))) as definition
                        `, { schema: s, objectName: parsedName });
                        definition = result.recordset[0]?.definition;
                        if (definition && definition.trim()) return definition;
                    } catch { continue; }
                }
            }

            return null;
        } catch (error) {
            console.error(`Error getting definition for ${objectName}:`, error);
            return null;
        }
    }

    async getObjectInfo(database, objectName) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');

        const { schema, objectName: parsedName } = this._parseObjectName(objectName);

        const result = await this._connectionManager.executeQueryInDatabase(database, `
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
            WHERE o.object_id = OBJECT_ID(QUOTENAME(@schema) + '.' + QUOTENAME(@objectName))
               OR (SCHEMA_NAME(o.schema_id) = @schema AND o.name = @objectName)
        `, { schema, objectName: parsedName });

        return result.recordset[0] || null;
    }

    async searchObjects(database, searchPattern, objectTypes = ['U', 'V', 'P', 'FN']) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');

        // Whitelist instead of interpolating caller-supplied strings directly into the IN(...) list.
        const VALID_OBJECT_TYPES = ['U', 'V', 'P', 'FN', 'IF', 'TF'];
        const safeTypes = objectTypes.filter(t => VALID_OBJECT_TYPES.includes(t));
        const typeFilter = (safeTypes.length ? safeTypes : ['U', 'V', 'P', 'FN']).map(t => `'${t}'`).join(',');

        const result = await this._connectionManager.executeQueryInDatabase(database, `
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
                CASE WHEN s.name = 'dbo' THEN o.name ELSE s.name + '.' + o.name END as display_name,
                s.name + '.' + o.name as qualified_name
            FROM sys.objects o
            INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
            WHERE (o.name LIKE @pattern OR (s.name + '.' + o.name) LIKE @pattern)
            AND o.type IN (${typeFilter})
            ORDER BY s.name, o.type, o.name
        `, { pattern: searchPattern });

        return result.recordset.map(row => ({
            name: row.display_name,
            object_name: row.object_name,
            qualified_name: row.qualified_name,
            object_type: row.object_type,
            schema_name: row.schema_name
        }));
    }

    // Row count + reserved size for every table in one query, for the Explorer
    // list badges. Needs VIEW DATABASE STATE - callers must treat it as
    // best-effort.
    async getAllTableStats(database) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');

        const result = await this._connectionManager.executeQueryInDatabase(database, `
            SELECT
                s.name + '.' + o.name AS qualified_name,
                SUM(CASE WHEN ps.index_id IN (0, 1) THEN ps.row_count ELSE 0 END) AS row_count,
                SUM(ps.reserved_page_count) * 8 AS reserved_kb
            FROM sys.dm_db_partition_stats ps
            INNER JOIN sys.objects o ON o.object_id = ps.object_id
            INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
            WHERE o.type = 'U'
            GROUP BY s.name, o.name
        `);

        return result.recordset.map(row => ({
            qualified_name: row.qualified_name,
            row_count: row.row_count,
            reserved_kb: row.reserved_kb
        }));
    }

    // Row count and disk usage from allocation metadata (same formulas as
    // sp_spaceused) - instant even on huge tables, unlike COUNT(*) which scans.
    async getTableStats(database, tableName) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');

        const { schema, objectName } = this._parseObjectName(tableName);
        const result = await this._connectionManager.executeQueryInDatabase(database, `
            SELECT
                (SELECT SUM(p2.rows) FROM sys.partitions p2
                 WHERE p2.object_id = OBJECT_ID(@objectName) AND p2.index_id IN (0, 1)) AS row_count,
                SUM(a.total_pages) * 8 AS reserved_kb,
                SUM(a.used_pages) * 8 AS used_kb,
                SUM(CASE
                    WHEN a.type <> 1 THEN a.used_pages          -- LOB / row-overflow
                    WHEN p.index_id IN (0, 1) THEN a.data_pages -- heap / clustered index
                    ELSE 0
                END) * 8 AS data_kb
            FROM sys.partitions p
            JOIN sys.allocation_units a ON a.container_id = p.partition_id
            WHERE p.object_id = OBJECT_ID(@objectName)
        `, { objectName: `${schema}.${objectName}` });

        const row = result.recordset[0];
        if (!row || row.row_count === null) return null;

        const usedKb = row.used_kb || 0;
        const dataKb = row.data_kb || 0;
        return {
            rowCount: row.row_count,
            reservedKb: row.reserved_kb || 0,
            dataKb,
            indexKb: Math.max(0, usedKb - dataKb)
        };
    }

    async getTableRowCount(database, tableName) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');

        const { schema, objectName } = this._parseObjectName(tableName);
        const bracketed = `${bracketIdentifier(schema)}.${bracketIdentifier(objectName)}`;
        const result = await this._connectionManager.executeQueryInDatabase(database, `
            SELECT COUNT(*) as row_count FROM ${bracketed}
        `);
        return result.recordset[0]?.row_count || 0;
    }

    async getTableSampleData(database, tableName, limit = 100) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');

        const { schema, objectName } = this._parseObjectName(tableName);
        const bracketed = `${bracketIdentifier(schema)}.${bracketIdentifier(objectName)}`;
        // TOP's row count can't be a query parameter - clamp to a safe integer instead.
        const safeLimit = Math.min(Math.max(1, Number(limit) || 100), 10000);
        const result = await this._connectionManager.executeQueryInDatabase(database, `
            SELECT TOP ${safeLimit} * FROM ${bracketed}
        `);
        return result.recordset;
    }

    _parseObjectName(objectName) { return parseObjectName(objectName); }
}

module.exports = DatabaseService;
