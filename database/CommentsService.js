/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

const parseObjectName = require('./parseObjectName');

/**
 * CommentsService - Manages MS_Description extended properties on SQL Server objects
 */
class CommentsService {
    constructor(connectionManager) {
        this._connectionManager = connectionManager;
    }

    async getTableExtendedProperties(database, tableName) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');

        const { schema, objectName } = parseObjectName(tableName);
        const qualifiedTableName = `${schema}.${objectName}`;

        const tableDescResult = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT ep.value as table_description
            FROM sys.extended_properties ep
            INNER JOIN sys.objects o ON ep.major_id = o.object_id
            INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
            WHERE ep.minor_id = 0 AND ep.name = 'MS_Description'
            AND s.name = '${schema}' AND o.name = '${objectName}'
        `);

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
            WHERE c.TABLE_SCHEMA = '${schema}' AND c.TABLE_NAME = '${objectName}'
            ORDER BY c.ORDINAL_POSITION
        `);

        const tableDescription = tableDescResult.recordset[0]?.table_description || null;
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

        return {
            tableName,
            tableDescription,
            columnDescriptions: allColumns.filter(c => c.hasDescription),
            allColumns,
            hasDescriptions: tableDescription !== null || allColumns.some(c => c.hasDescription)
        };
    }

    async getObjectExtendedProperties(database, objectName, objectType) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');

        const { schema, objectName: parsedName } = parseObjectName(objectName);

        const result = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT ep.value as description
            FROM sys.extended_properties ep
            INNER JOIN sys.objects o ON ep.major_id = o.object_id
            INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
            WHERE ep.minor_id = 0 AND ep.name = 'MS_Description'
            AND s.name = '${schema}' AND o.name = '${parsedName}'
        `);

        const description = result.recordset[0]?.description || null;
        return { objectName, objectType, description, hasDescription: description !== null };
    }

    async updateTableDescription(database, tableName, description) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');

        const { schema, objectName } = parseObjectName(tableName);
        await this._upsertOrDeleteExtendedProperty(database, schema, objectName, 'TABLE', null, description);
        return { success: true, message: description?.trim() ? 'Table description updated successfully' : 'Table description deleted successfully' };
    }

    async updateColumnDescription(database, tableName, columnName, description) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');

        const { schema, objectName } = parseObjectName(tableName);
        await this._upsertOrDeleteExtendedProperty(database, schema, objectName, 'TABLE', columnName, description);
        return { success: true, message: description?.trim() ? 'Column description updated successfully' : 'Column description deleted successfully' };
    }

    async updateObjectDescription(database, objectName, objectType, description) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');

        const { schema, objectName: parsedName } = parseObjectName(objectName);
        const level1type = this._mapObjectTypeToLevel1(objectType);
        await this._upsertOrDeleteExtendedProperty(database, schema, parsedName, level1type, null, description);
        return { success: true, message: description?.trim() ? 'Object description updated successfully' : 'Object description deleted successfully' };
    }

    async deleteTableDescription(database, tableName) {
        return this.updateTableDescription(database, tableName, '');
    }

    async deleteColumnDescription(database, tableName, columnName) {
        return this.updateColumnDescription(database, tableName, columnName, '');
    }

    // PRIVATE HELPERS

    async _upsertOrDeleteExtendedProperty(database, schema, objectName, level1type, columnName, description) {
        const escaped = (description || '').replace(/'/g, "''");
        const hasDescription = description && description.trim() !== '';

        const existsCheck = columnName
            ? `EXISTS (
                SELECT 1 FROM sys.extended_properties ep
                INNER JOIN sys.objects o ON ep.major_id = o.object_id
                INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                INNER JOIN INFORMATION_SCHEMA.COLUMNS c ON c.TABLE_SCHEMA = s.name
                    AND c.TABLE_NAME = o.name AND c.COLUMN_NAME = '${columnName}'
                    AND ep.minor_id = c.ORDINAL_POSITION
                WHERE ep.name = 'MS_Description' AND s.name = '${schema}' AND o.name = '${objectName}'
            )`
            : `EXISTS (
                SELECT 1 FROM sys.extended_properties ep
                INNER JOIN sys.objects o ON ep.major_id = o.object_id
                INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                WHERE ep.minor_id = 0 AND ep.name = 'MS_Description'
                AND s.name = '${schema}' AND o.name = '${objectName}'
            )`;

        const level2clause = columnName
            ? `@level2type = N'COLUMN', @level2name = N'${columnName}'`
            : '';

        const commonParams = `
            @name = N'MS_Description',
            @level0type = N'SCHEMA', @level0name = N'${schema}',
            @level1type = N'${level1type}', @level1name = N'${objectName}'
            ${columnName ? ', ' + level2clause : ''}
        `;

        let sql;
        if (hasDescription) {
            sql = `
                USE [${database}];
                IF ${existsCheck}
                    EXEC sp_updateextendedproperty ${commonParams}, @value = N'${escaped}'
                ELSE
                    EXEC sp_addextendedproperty ${commonParams}, @value = N'${escaped}'
            `;
        } else {
            sql = `
                USE [${database}];
                IF ${existsCheck}
                    EXEC sp_dropextendedproperty ${commonParams}
            `;
        }

        await this._connectionManager.executeQuery(sql);
    }

    _mapObjectTypeToLevel1(objectType) {
        const map = {
            'Table':     'TABLE',
            'View':      'VIEW',
            'Procedure': 'PROCEDURE',
            'Function':  'FUNCTION',
            'Trigger':   'TRIGGER'
        };
        return map[objectType] || 'PROCEDURE';
    }
}

module.exports = CommentsService;
