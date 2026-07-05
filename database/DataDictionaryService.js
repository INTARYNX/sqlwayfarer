'use strict';

// Builds a Markdown "data dictionary" of a whole database: every table, view,
// procedure and function with columns, keys, parameters, dependencies and the
// MS_Description extended properties maintained in the Comments tab.
// Collection uses a handful of database-wide queries (not per-object calls);
// rendering is a pure static function so it can be unit-tested with fixtures.
class DataDictionaryService {
    constructor(connectionManager, indexService) {
        this._connectionManager = connectionManager;
        this._indexService = indexService;
    }

    async generateMarkdown(database) {
        const data = await this.collect(database);
        return DataDictionaryService.render(data);
    }

    // === Collection: whole-database metadata in 5 queries + the object index ===

    async collect(database) {
        const cm = this._connectionManager;

        const objectsResult = await cm.executeQueryInDatabase(database, `
            SELECT s.name AS schema_name, o.name AS object_name, RTRIM(o.type) AS type_code,
                   CAST(ep.value AS NVARCHAR(MAX)) AS description
            FROM sys.objects o
            JOIN sys.schemas s ON s.schema_id = o.schema_id
            LEFT JOIN sys.extended_properties ep
                ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.class = 1 AND ep.name = 'MS_Description'
            WHERE o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF') AND o.is_ms_shipped = 0
            ORDER BY s.name, o.name
        `);

        const columnsResult = await cm.executeQueryInDatabase(database, `
            SELECT s.name AS schema_name, o.name AS object_name, c.name AS column_name,
                   TYPE_NAME(c.user_type_id) AS data_type, c.max_length, c.precision, c.scale,
                   c.is_nullable, c.is_identity, c.is_computed,
                   dc.definition AS default_definition,
                   CAST(ep.value AS NVARCHAR(MAX)) AS description
            FROM sys.columns c
            JOIN sys.objects o ON o.object_id = c.object_id
            JOIN sys.schemas s ON s.schema_id = o.schema_id
            LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
            LEFT JOIN sys.extended_properties ep
                ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.class = 1 AND ep.name = 'MS_Description'
            WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
            ORDER BY s.name, o.name, c.column_id
        `);

        const pkResult = await cm.executeQueryInDatabase(database, `
            SELECT s.name AS schema_name, o.name AS object_name, c.name AS column_name
            FROM sys.indexes i
            JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
            JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
            JOIN sys.objects o ON o.object_id = i.object_id
            JOIN sys.schemas s ON s.schema_id = o.schema_id
            WHERE i.is_primary_key = 1
            ORDER BY s.name, o.name, ic.key_ordinal
        `);

        const fkResult = await cm.executeQueryInDatabase(database, `
            SELECT s.name AS schema_name, po.name AS object_name, fk.name AS fk_name,
                   c1.name AS column_name,
                   SCHEMA_NAME(ro.schema_id) AS ref_schema, ro.name AS ref_table, c2.name AS ref_column
            FROM sys.foreign_keys fk
            JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
            JOIN sys.columns c1 ON c1.object_id = fkc.parent_object_id AND c1.column_id = fkc.parent_column_id
            JOIN sys.columns c2 ON c2.object_id = fkc.referenced_object_id AND c2.column_id = fkc.referenced_column_id
            JOIN sys.objects ro ON ro.object_id = fk.referenced_object_id
            JOIN sys.objects po ON po.object_id = fk.parent_object_id
            JOIN sys.schemas s ON s.schema_id = po.schema_id
            ORDER BY s.name, po.name, fk.name, fkc.constraint_column_id
        `);

        const paramsResult = await cm.executeQueryInDatabase(database, `
            SELECT s.name AS schema_name, o.name AS object_name, p.name AS param_name,
                   TYPE_NAME(p.user_type_id) AS data_type, p.max_length, p.precision, p.scale, p.is_output
            FROM sys.parameters p
            JOIN sys.objects o ON o.object_id = p.object_id
            JOIN sys.schemas s ON s.schema_id = o.schema_id
            WHERE o.type IN ('P', 'FN', 'IF', 'TF') AND o.is_ms_shipped = 0 AND p.parameter_id > 0
            ORDER BY s.name, o.name, p.parameter_id
        `);

        // Dependencies come from the explorer index; the dictionary still works without them.
        let index = null;
        try {
            index = await this._indexService.getIndex(database);
        } catch (error) {
            console.warn('Data dictionary: index unavailable, skipping dependencies:', error.message);
        }

        return DataDictionaryService.assemble({
            database,
            server: cm.getServerName(),
            objects: objectsResult.recordset,
            columns: columnsResult.recordset,
            primaryKeys: pkResult.recordset,
            foreignKeys: fkResult.recordset,
            parameters: paramsResult.recordset,
            index
        });
    }

    // Turn the flat recordsets into the per-schema tree the renderer consumes.
    static assemble({ database, server, objects, columns, primaryKeys, foreignKeys, parameters, index }) {
        const categoryOf = { U: 'tables', V: 'views', P: 'procedures', FN: 'functions', IF: 'functions', TF: 'functions' };

        const dependsOn = {};
        const referencedBy = {};
        if (index && index.objects) {
            for (const obj of Object.values(index.objects)) {
                const key = obj.qualifiedName.toLowerCase();
                dependsOn[key] = obj.dependencies || [];
                for (const dep of obj.dependencies || []) {
                    const depKey = dep.toLowerCase();
                    (referencedBy[depKey] = referencedBy[depKey] || []).push(obj.qualifiedName);
                }
            }
        }

        const schemas = {};
        const byQualifiedName = {};

        for (const o of objects) {
            const category = categoryOf[o.type_code];
            if (!category) continue;
            const qualifiedName = `${o.schema_name}.${o.object_name}`;
            const key = qualifiedName.toLowerCase();
            // Sorted so the generated document is deterministic (stable git diffs).
            const entry = {
                name: o.object_name,
                qualifiedName,
                description: o.description || '',
                dependsOn: [...(dependsOn[key] || [])].sort(),
                referencedBy: [...(referencedBy[key] || [])].sort()
            };
            if (category === 'tables' || category === 'views') {
                entry.columns = [];
                entry.primaryKey = [];
                entry.foreignKeys = [];
            } else {
                entry.parameters = [];
            }
            const schema = schemas[o.schema_name] = schemas[o.schema_name] || { tables: [], views: [], procedures: [], functions: [] };
            schema[category].push(entry);
            byQualifiedName[key] = entry;
        }

        const find = row => byQualifiedName[`${row.schema_name}.${row.object_name}`.toLowerCase()];

        for (const c of columns) {
            const entry = find(c);
            if (entry && entry.columns) entry.columns.push(c);
        }
        for (const pk of primaryKeys) {
            const entry = find(pk);
            if (entry && entry.primaryKey) entry.primaryKey.push(pk.column_name);
        }
        for (const fk of foreignKeys) {
            const entry = find(fk);
            if (entry && entry.foreignKeys) entry.foreignKeys.push(fk);
        }
        for (const p of parameters) {
            const entry = find(p);
            if (entry && entry.parameters) entry.parameters.push(p);
        }

        return { database, server, generatedAt: new Date(), schemas, byQualifiedName };
    }

    // === Rendering (pure) ===

    static render(data) {
        const lines = [];
        const schemaNames = Object.keys(data.schemas).sort();
        const stats = DataDictionaryService.computeStats(data);
        const exists = name => !!data.byQualifiedName[name.toLowerCase()];
        const link = name => exists(name) ? `[${name}](#${DataDictionaryService.anchor(name)})` : name;
        const linkList = names => names.length ? names.map(link).join(', ') : '—';

        lines.push(`# Data Dictionary — ${data.database}`);
        lines.push('');
        lines.push(`Generated by SQL Wayfarer on ${data.generatedAt.toISOString().slice(0, 10)} (server: ${data.server}).`);
        lines.push('');
        lines.push(`**Contents:** ${stats.tables} tables · ${stats.views} views · ${stats.procedures} procedures · ${stats.functions} functions`);
        if (stats.tables > 0) {
            lines.push('');
            lines.push(`**Documentation coverage:** ${stats.tablesDocumentedPct}% of tables and ${stats.columnsDocumentedPct}% of columns have a description.`);
        }
        lines.push('');

        // Table of contents
        lines.push('## Contents');
        lines.push('');
        for (const schemaName of schemaNames) {
            const s = data.schemas[schemaName];
            const counts = [];
            if (s.tables.length) counts.push(`${s.tables.length} tables`);
            if (s.views.length) counts.push(`${s.views.length} views`);
            if (s.procedures.length) counts.push(`${s.procedures.length} procedures`);
            if (s.functions.length) counts.push(`${s.functions.length} functions`);
            lines.push(`- [Schema ${schemaName}](#${DataDictionaryService.anchor('Schema: ' + schemaName)}) — ${counts.join(', ')}`);
        }
        lines.push('');

        for (const schemaName of schemaNames) {
            const s = data.schemas[schemaName];
            lines.push(`## Schema: ${schemaName}`);
            lines.push('');

            for (const [title, entries] of [['Tables', s.tables], ['Views', s.views]]) {
                if (entries.length === 0) continue;
                lines.push(`### ${title}`);
                lines.push('');
                for (const entry of entries) {
                    lines.push(`#### ${entry.qualifiedName}`);
                    lines.push('');
                    if (entry.description) {
                        lines.push(`> ${entry.description.replace(/\r?\n/g, ' ')}`);
                        lines.push('');
                    }
                    lines.push('| Column | Type | Nullable | Default | Description |');
                    lines.push('|--------|------|:--------:|---------|-------------|');
                    for (const col of entry.columns) {
                        const isPk = entry.primaryKey.includes(col.column_name);
                        const nameCell = `${isPk ? '🔑 ' : ''}**${col.column_name}**`;
                        let type = DataDictionaryService.formatDataType(col.data_type, col.max_length, col.precision, col.scale);
                        if (col.is_identity) type += ' · identity';
                        if (col.is_computed) type += ' · computed';
                        const cells = [
                            nameCell,
                            type,
                            col.is_nullable ? '✓' : '',
                            DataDictionaryService.cleanDefault(col.default_definition),
                            col.description || ''
                        ];
                        lines.push(`| ${cells.map(DataDictionaryService.escapeCell).join(' | ')} |`);
                    }
                    lines.push('');

                    if (entry.foreignKeys.length > 0) {
                        lines.push('**Foreign keys:**');
                        lines.push('');
                        for (const fk of entry.foreignKeys) {
                            const target = `${fk.ref_schema}.${fk.ref_table}`;
                            lines.push(`- \`${fk.fk_name}\`: ${fk.column_name} → ${link(target)} (${fk.ref_column})`);
                        }
                        lines.push('');
                    }

                    lines.push(`**Depends on:** ${linkList(entry.dependsOn)}  `);
                    lines.push(`**Referenced by:** ${linkList(entry.referencedBy)}`);
                    lines.push('');
                }
            }

            for (const [title, entries] of [['Procedures', s.procedures], ['Functions', s.functions]]) {
                if (entries.length === 0) continue;
                lines.push(`### ${title}`);
                lines.push('');
                for (const entry of entries) {
                    lines.push(`#### ${entry.qualifiedName}`);
                    lines.push('');
                    if (entry.description) {
                        lines.push(`> ${entry.description.replace(/\r?\n/g, ' ')}`);
                        lines.push('');
                    }
                    if (entry.parameters.length > 0) {
                        lines.push('| Parameter | Type | Direction |');
                        lines.push('|-----------|------|-----------|');
                        for (const p of entry.parameters) {
                            const type = DataDictionaryService.formatDataType(p.data_type, p.max_length, p.precision, p.scale);
                            lines.push(`| ${DataDictionaryService.escapeCell(p.param_name)} | ${type} | ${p.is_output ? 'out' : 'in'} |`);
                        }
                        lines.push('');
                    }
                    lines.push(`**Depends on:** ${linkList(entry.dependsOn)}  `);
                    lines.push(`**Referenced by:** ${linkList(entry.referencedBy)}`);
                    lines.push('');
                }
            }
        }

        lines.push('---');
        lines.push('*Generated with [SQL Wayfarer](https://github.com/intarynx/sqlwayfarer). Descriptions come from MS_Description extended properties — edit them in the Comments tab.*');
        lines.push('');
        return lines.join('\n');
    }

    // === Helpers ===

    static computeStats(data) {
        const stats = { tables: 0, views: 0, procedures: 0, functions: 0, tablesDocumented: 0, columnsTotal: 0, columnsDocumented: 0 };
        for (const s of Object.values(data.schemas)) {
            stats.tables += s.tables.length;
            stats.views += s.views.length;
            stats.procedures += s.procedures.length;
            stats.functions += s.functions.length;
            for (const t of s.tables) {
                if (t.description) stats.tablesDocumented++;
                stats.columnsTotal += t.columns.length;
                stats.columnsDocumented += t.columns.filter(c => c.description).length;
            }
        }
        const pct = (part, total) => total === 0 ? 0 : Math.round((part / total) * 100);
        stats.tablesDocumentedPct = pct(stats.tablesDocumented, stats.tables);
        stats.columnsDocumentedPct = pct(stats.columnsDocumented, stats.columnsTotal);
        return stats;
    }

    static formatDataType(dataType, maxLength, precision, scale) {
        if (!dataType) return '';
        const t = dataType.toLowerCase();
        if (['varchar', 'char', 'binary', 'varbinary'].includes(t)) {
            return `${t}(${maxLength === -1 ? 'MAX' : maxLength})`;
        }
        if (['nvarchar', 'nchar'].includes(t)) {
            // sys.columns stores nchar lengths in bytes (2 bytes per character)
            return `${t}(${maxLength === -1 ? 'MAX' : maxLength / 2})`;
        }
        if (['decimal', 'numeric'].includes(t)) return `${t}(${precision},${scale})`;
        if (['datetime2', 'time', 'datetimeoffset'].includes(t)) return `${t}(${scale})`;
        return t;
    }

    // SQL Server wraps defaults in parens, often twice: ((0)) -> 0
    static cleanDefault(definition) {
        if (!definition) return '';
        let d = definition;
        while (d.startsWith('(') && d.endsWith(')')) d = d.slice(1, -1);
        return d;
    }

    // GitHub-style heading anchor: lowercase, drop punctuation, spaces to dashes
    static anchor(text) {
        return text.toLowerCase().replace(/[^\w\- ]/g, '').replace(/ /g, '-');
    }

    // Markdown table cells cannot contain raw pipes or line breaks
    static escapeCell(text) {
        if (text === null || text === undefined) return '';
        return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
    }
}

module.exports = DataDictionaryService;
