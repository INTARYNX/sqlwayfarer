'use strict';

const parseObjectName = require('./parseObjectName');
const DataDictionaryService = require('./DataDictionaryService');

// Generates ready-to-edit SQL scripts for the Explorer "Script" button:
// SELECT / INSERT / UPDATE / CREATE for tables, SELECT / CREATE for views,
// EXEC / CREATE for procedures, SELECT / CREATE for functions.
// Table DDL is rebuilt from metadata; code objects reuse OBJECT_DEFINITION.
class ScriptGeneratorService {
    constructor(connectionManager, databaseService) {
        this._connectionManager = connectionManager;
        this._databaseService = databaseService;
    }

    async generateScript(database, objectName, objectType, scriptType) {
        const { schema, objectName: name } = parseObjectName(objectName);
        const bracketed = `${ScriptGeneratorService.bracket(schema)}.${ScriptGeneratorService.bracket(name)}`;

        switch (`${objectType}:${scriptType}`) {
            // All table-shaped scripts start from the same metadata fetch
            case 'Table:select':
            case 'View:select':
            case 'Table:insert':
            case 'Table:update':
            case 'Table:create': {
                const details = await this._databaseService.getTableDetails(database, objectName);
                switch (scriptType) {
                    case 'select': return ScriptGeneratorService.buildSelect(bracketed, details.columns);
                    case 'insert': return ScriptGeneratorService.buildInsert(bracketed, details.columns);
                    case 'update': return ScriptGeneratorService.buildUpdate(bracketed, details.columns, details.indexes);
                    default:       return ScriptGeneratorService.buildCreateTable(bracketed, details);
                }
            }
            case 'Procedure:exec': {
                const params = await this._getParameters(database, `${schema}.${name}`);
                return ScriptGeneratorService.buildExec(bracketed, params);
            }
            case 'Function:select': {
                const params = await this._getParameters(database, `${schema}.${name}`);
                const isScalar = await this._isScalarFunction(database, `${schema}.${name}`);
                return ScriptGeneratorService.buildFunctionSelect(bracketed, params, isScalar);
            }
            case 'View:create':
            case 'Procedure:create':
            case 'Function:create': {
                const definition = await this._databaseService.getObjectDefinition(database, `${schema}.${name}`);
                if (!definition) {
                    throw new Error(`No definition available for ${objectName} (the object may be encrypted).`);
                }
                return definition.trim();
            }
            default:
                throw new Error(`Unsupported script type '${scriptType}' for object type '${objectType}'.`);
        }
    }

    async _getParameters(database, qualifiedName) {
        const result = await this._connectionManager.executeQueryInDatabase(database, `
            SELECT p.name, TYPE_NAME(p.user_type_id) AS data_type,
                   p.max_length, p.precision, p.scale, p.is_output
            FROM sys.parameters p
            WHERE p.object_id = OBJECT_ID(@qualifiedName) AND p.parameter_id > 0
            ORDER BY p.parameter_id
        `, { qualifiedName });
        return result.recordset;
    }

    async _isScalarFunction(database, qualifiedName) {
        const result = await this._connectionManager.executeQueryInDatabase(database, `
            SELECT o.type FROM sys.objects o WHERE o.object_id = OBJECT_ID(@qualifiedName)
        `, { qualifiedName });
        return result.recordset[0]?.type?.trim() === 'FN';
    }

    // === Pure builders (unit-testable without a connection) ===

    // ']' inside an identifier must be doubled inside brackets: [Foo]]Bar]
    static bracket(name) {
        return `[${String(name).replace(/]/g, ']]')}]`;
    }

    // Type label from an INFORMATION_SCHEMA.COLUMNS row (lengths in characters)
    static formatColumnType(col) {
        const t = (col.DATA_TYPE || '').toLowerCase();
        if (['varchar', 'char', 'nvarchar', 'nchar', 'binary', 'varbinary'].includes(t)) {
            const len = col.CHARACTER_MAXIMUM_LENGTH;
            return `${t}(${len === -1 ? 'MAX' : len})`;
        }
        if (['decimal', 'numeric'].includes(t)) return `${t}(${col.NUMERIC_PRECISION},${col.NUMERIC_SCALE})`;
        if (['datetime2', 'time', 'datetimeoffset'].includes(t)) return `${t}(${col.DATETIME_PRECISION})`;
        return t;
    }

    // Type label from a sys.parameters row (max_length in bytes) - same
    // byte-based rules as the data dictionary, so reuse its formatter.
    static formatParamType(param) {
        return DataDictionaryService.formatDataType(param.data_type, param.max_length, param.precision, param.scale);
    }

    // Sensible literal for a template value slot, based on the base type
    static placeholderFor(dataType, nullable) {
        if (nullable) return 'NULL';
        const t = (dataType || '').toLowerCase();
        if (['nvarchar', 'nchar', 'ntext'].includes(t)) return "N''";
        if (['varchar', 'char', 'text', 'xml'].includes(t)) return "''";
        if (['datetime', 'datetime2', 'smalldatetime', 'date', 'datetimeoffset'].includes(t)) return 'GETDATE()';
        if (t === 'time') return "'00:00:00'";
        if (t === 'uniqueidentifier') return 'NEWID()';
        if (['binary', 'varbinary', 'image'].includes(t)) return '0x';
        if (t === 'bit') return '0';
        if (['decimal', 'numeric', 'money', 'smallmoney', 'float', 'real'].includes(t)) return '0.0';
        return '0';
    }

    // Columns that cannot receive a value in INSERT/UPDATE
    static isWritable(col) {
        const t = (col.DATA_TYPE || '').toLowerCase();
        return !col.IS_IDENTITY && !col.IS_COMPUTED && t !== 'timestamp' && t !== 'rowversion';
    }

    static buildSelect(bracketed, columns) {
        const cols = columns.map(c => `    ${ScriptGeneratorService.bracket(c.COLUMN_NAME)}`).join(',\n');
        return `SELECT\n${cols}\nFROM ${bracketed};`;
    }

    static buildInsert(bracketed, columns) {
        const writable = columns.filter(ScriptGeneratorService.isWritable);
        if (writable.length === 0) return `-- ${bracketed} has no insertable column.`;

        const names = writable.map(c => `    ${ScriptGeneratorService.bracket(c.COLUMN_NAME)}`).join(',\n');
        const values = writable.map(c => {
            const nullable = c.IS_NULLABLE === 'YES';
            const placeholder = ScriptGeneratorService.placeholderFor(c.DATA_TYPE, nullable);
            const type = ScriptGeneratorService.formatColumnType(c);
            return `    ${placeholder} -- ${c.COLUMN_NAME} ${type}${nullable ? '' : ' NOT NULL'}`;
        }).join(',\n');

        return `INSERT INTO ${bracketed} (\n${names}\n) VALUES (\n${values}\n);`;
    }

    static buildUpdate(bracketed, columns, indexes) {
        const writable = columns.filter(ScriptGeneratorService.isWritable);
        if (writable.length === 0) return `-- ${bracketed} has no updatable column.`;

        const sets = writable.map((c, i) => {
            const nullable = c.IS_NULLABLE === 'YES';
            const placeholder = ScriptGeneratorService.placeholderFor(c.DATA_TYPE, nullable);
            const prefix = i === 0 ? 'SET ' : '    ';
            const type = ScriptGeneratorService.formatColumnType(c);
            return `${prefix}${ScriptGeneratorService.bracket(c.COLUMN_NAME)} = ${placeholder}${i < writable.length - 1 ? ',' : ''} -- ${type}`;
        }).join('\n');

        // WHERE on the primary key so the template is safe to run once filled in
        const pk = (indexes || []).find(ix => ix.is_primary_key);
        let where;
        if (pk && pk.columns) {
            const byName = new Map(columns.map(c => [c.COLUMN_NAME, c]));
            where = 'WHERE ' + pk.columns.split(',').map(raw => {
                const colName = raw.trim();
                const col = byName.get(colName);
                const placeholder = ScriptGeneratorService.placeholderFor(col ? col.DATA_TYPE : null, false);
                return `${ScriptGeneratorService.bracket(colName)} = ${placeholder}`;
            }).join('\n  AND ') + ';';
        } else {
            where = 'WHERE /* no primary key - write your own condition */;';
        }

        return `UPDATE ${bracketed}\n${sets}\n${where}`;
    }

    static buildCreateTable(bracketed, details) {
        const lines = [];

        for (const c of details.columns) {
            if (c.IS_COMPUTED) {
                lines.push(`    ${ScriptGeneratorService.bracket(c.COLUMN_NAME)} AS ${c.COMPUTED_DEFINITION || '/* computed */'}`);
                continue;
            }
            let line = `    ${ScriptGeneratorService.bracket(c.COLUMN_NAME)} ${ScriptGeneratorService.formatColumnType(c)}`;
            if (c.IS_IDENTITY) line += ` IDENTITY(${c.IDENTITY_SEED ?? 1},${c.IDENTITY_INCREMENT ?? 1})`;
            line += c.IS_NULLABLE === 'YES' ? ' NULL' : ' NOT NULL';
            if (c.COLUMN_DEFAULT) line += ` DEFAULT ${c.COLUMN_DEFAULT}`;
            lines.push(line);
        }

        const pk = (details.indexes || []).find(ix => ix.is_primary_key);
        if (pk) {
            const cols = pk.columns.split(',').map(c => ScriptGeneratorService.bracket(c.trim())).join(', ');
            lines.push(`    CONSTRAINT ${ScriptGeneratorService.bracket(pk.index_name)} PRIMARY KEY ${pk.type_desc} (${cols})`);
        }

        const statements = [`CREATE TABLE ${bracketed} (\n${lines.join(',\n')}\n);`];

        for (const ix of details.indexes || []) {
            if (ix.is_primary_key) continue;
            const cols = ix.columns.split(',').map(c => ScriptGeneratorService.bracket(c.trim())).join(', ');
            if (ix.is_unique_constraint) {
                statements.push(`ALTER TABLE ${bracketed} ADD CONSTRAINT ${ScriptGeneratorService.bracket(ix.index_name)} UNIQUE ${ix.type_desc} (${cols});`);
            } else {
                const unique = ix.is_unique ? 'UNIQUE ' : '';
                const filter = ix.has_filter && ix.filter_definition ? ` WHERE ${ix.filter_definition}` : '';
                statements.push(`CREATE ${unique}${ix.type_desc} INDEX ${ScriptGeneratorService.bracket(ix.index_name)} ON ${bracketed} (${cols})${filter};`);
            }
        }

        // FK rows are per-column: group them to emit one constraint each
        const fks = new Map();
        for (const fk of details.foreignKeys || []) {
            if (!fks.has(fk.fk_name)) {
                fks.set(fk.fk_name, { referenced_table: fk.referenced_table, columns: [], refColumns: [], onDelete: fk.delete_referential_action_desc, onUpdate: fk.update_referential_action_desc });
            }
            const entry = fks.get(fk.fk_name);
            entry.columns.push(fk.column_name);
            entry.refColumns.push(fk.referenced_column);
        }
        for (const [fkName, fk] of fks) {
            const cols = fk.columns.map(c => ScriptGeneratorService.bracket(c)).join(', ');
            const refCols = fk.refColumns.map(c => ScriptGeneratorService.bracket(c)).join(', ');
            const refTable = fk.referenced_table.split('.').map(p => ScriptGeneratorService.bracket(p)).join('.');
            let stmt = `ALTER TABLE ${bracketed} ADD CONSTRAINT ${ScriptGeneratorService.bracket(fkName)} FOREIGN KEY (${cols}) REFERENCES ${refTable} (${refCols})`;
            if (fk.onDelete && fk.onDelete !== 'NO_ACTION') stmt += ` ON DELETE ${fk.onDelete.replace(/_/g, ' ')}`;
            if (fk.onUpdate && fk.onUpdate !== 'NO_ACTION') stmt += ` ON UPDATE ${fk.onUpdate.replace(/_/g, ' ')}`;
            statements.push(stmt + ';');
        }

        return statements.join('\nGO\n\n');
    }

    static buildExec(bracketed, params) {
        const outputs = params.filter(p => p.is_output);
        const lines = [];

        for (const p of outputs) {
            lines.push(`DECLARE ${p.name} ${ScriptGeneratorService.formatParamType(p)};`);
        }
        if (outputs.length > 0) lines.push('');

        if (params.length === 0) {
            lines.push(`EXEC ${bracketed};`);
        } else {
            lines.push(`EXEC ${bracketed}`);
            params.forEach((p, i) => {
                const last = i === params.length - 1;
                const value = p.is_output
                    ? `${p.name} OUTPUT`
                    : ScriptGeneratorService.placeholderFor(p.data_type, false);
                lines.push(`    ${p.name} = ${value}${last ? ';' : ','} -- ${ScriptGeneratorService.formatParamType(p)}`);
            });
        }

        if (outputs.length > 0) {
            lines.push('');
            lines.push(`SELECT ${outputs.map(p => `${p.name} AS ${ScriptGeneratorService.bracket(p.name.replace('@', ''))}`).join(', ')};`);
        }

        return lines.join('\n');
    }

    static buildFunctionSelect(bracketed, params, isScalar) {
        const args = params
            .filter(p => !p.is_output)
            .map(p => `${ScriptGeneratorService.placeholderFor(p.data_type, false)} /* ${p.name} ${ScriptGeneratorService.formatParamType(p)} */`)
            .join(', ');

        return isScalar
            ? `SELECT ${bracketed}(${args}) AS result;`
            : `SELECT *\nFROM ${bracketed}(${args});`;
    }
}

module.exports = ScriptGeneratorService;
