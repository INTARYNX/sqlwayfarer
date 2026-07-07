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

    async generateMarkdown(database, options = {}) {
        const data = await this.collect(database, options);
        return DataDictionaryService.render(data, options);
    }

    // Multi-file variant for the full export: returns { indexName, files }.
    async generateMarkdownFiles(database, options = {}) {
        const data = await this.collect(database, options);
        return DataDictionaryService.renderPages(data, options);
    }

    // Scoped, lean per-table documentation for a given set of tables (used by the
    // Table Footprint "Tables"/"Schema" tabs so the user analyses in place without
    // opening the full Markdown export). Columns + PK/FK + descriptions only.
    async collectTablesDoc(database, tableNames) {
        const clean = (tableNames || []).map(n => (n || '').replace(/\[|\]/g, '')).filter(Boolean);
        if (clean.length === 0) return { tables: [] };

        const cm = this._connectionManager;
        // Parameterised IN list: @t0, @t1, … matched against schema.table.
        const placeholders = clean.map((_, i) => `@t${i}`).join(', ');
        const params = {};
        clean.forEach((n, i) => { params[`t${i}`] = n; });
        const filter = `o.type = 'U' AND s.name + '.' + o.name IN (${placeholders})`;

        const objectsResult = await cm.executeQueryInDatabase(database, `
            SELECT s.name AS schema_name, o.name AS object_name, CAST(ep.value AS NVARCHAR(MAX)) AS description
            FROM sys.objects o
            JOIN sys.schemas s ON s.schema_id = o.schema_id
            LEFT JOIN sys.extended_properties ep
                ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.class = 1 AND ep.name = 'MS_Description'
            WHERE ${filter}
        `, params);

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
            WHERE ${filter}
            ORDER BY s.name, o.name, c.column_id
        `, params);

        const pkResult = await cm.executeQueryInDatabase(database, `
            SELECT s.name AS schema_name, o.name AS object_name, c.name AS column_name
            FROM sys.indexes i
            JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
            JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
            JOIN sys.objects o ON o.object_id = i.object_id
            JOIN sys.schemas s ON s.schema_id = o.schema_id
            WHERE i.is_primary_key = 1 AND ${filter}
            ORDER BY s.name, o.name, ic.key_ordinal
        `, params);

        const fkResult = await cm.executeQueryInDatabase(database, `
            SELECT s.name AS schema_name, po.name AS object_name, fk.name AS fk_name, c1.name AS column_name,
                   SCHEMA_NAME(ro.schema_id) AS ref_schema, ro.name AS ref_table, c2.name AS ref_column
            FROM sys.foreign_keys fk
            JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
            JOIN sys.columns c1 ON c1.object_id = fkc.parent_object_id AND c1.column_id = fkc.parent_column_id
            JOIN sys.columns c2 ON c2.object_id = fkc.referenced_object_id AND c2.column_id = fkc.referenced_column_id
            JOIN sys.objects ro ON ro.object_id = fk.referenced_object_id
            JOIN sys.objects po ON po.object_id = fk.parent_object_id
            JOIN sys.schemas s ON s.schema_id = po.schema_id
            WHERE ${filter.replace(/\bo\./g, 'po.')}
            ORDER BY s.name, po.name, fk.name, fkc.constraint_column_id
        `, params);

        return DataDictionaryService.assembleTablesDoc({
            objects: objectsResult.recordset,
            columns: columnsResult.recordset,
            primaryKeys: pkResult.recordset,
            foreignKeys: fkResult.recordset
        });
    }

    // Pure assembly of the scoped table-doc recordsets into per-table cards.
    static assembleTablesDoc({ objects, columns, primaryKeys, foreignKeys }) {
        const byKey = {};
        const tables = [];
        for (const o of objects) {
            const qualifiedName = `${o.schema_name}.${o.object_name}`;
            const entry = { qualifiedName, description: o.description || '', columns: [], primaryKey: [], foreignKeys: [] };
            byKey[qualifiedName.toLowerCase()] = entry;
            tables.push(entry);
        }
        const find = row => byKey[`${row.schema_name}.${row.object_name}`.toLowerCase()];

        for (const pk of primaryKeys) { const e = find(pk); if (e) e.primaryKey.push(pk.column_name); }
        const fkByCol = {};
        for (const fk of foreignKeys) {
            const e = find(fk);
            if (!e) continue;
            const target = `${fk.ref_schema}.${fk.ref_table}`;
            e.foreignKeys.push({ fkName: fk.fk_name, column: fk.column_name, refTable: target, refColumn: fk.ref_column });
            (fkByCol[e.qualifiedName.toLowerCase()] = fkByCol[e.qualifiedName.toLowerCase()] || {})[fk.column_name] = target;
        }
        for (const c of columns) {
            const e = find(c);
            if (!e) continue;
            const pkSet = e.primaryKey;
            const fkMap = fkByCol[e.qualifiedName.toLowerCase()] || {};
            e.columns.push({
                name: c.column_name,
                type: DataDictionaryService.formatDataType(c.data_type, c.max_length, c.precision, c.scale)
                    + (c.is_identity ? ' · identity' : '') + (c.is_computed ? ' · computed' : ''),
                nullable: !!c.is_nullable,
                default: DataDictionaryService.cleanDefault(c.default_definition),
                description: c.description || '',
                isPk: pkSet.includes(c.column_name),
                fkRef: fkMap[c.column_name] || null
            });
        }
        tables.sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
        return { tables };
    }

    // === Collection: whole-database metadata in 5 queries + the object index ===
    // In "full" mode, four extra whole-database queries add indexes, CHECK/UNIQUE
    // constraints and triggers.

    async collect(database, options = {}) {
        const full = !!options.full;
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

        // Extra metadata for the full documentation mode. Kept in separate,
        // opt-in queries so the basic export stays as light as before.
        let indexes = [], checkConstraints = [], uniqueConstraints = [], triggers = [], tableStats = [], userTypes = [];
        if (full) {
            const indexesResult = await cm.executeQueryInDatabase(database, `
                SELECT s.name AS schema_name, o.name AS object_name, i.name AS index_name,
                       i.is_unique, i.type_desc, c.name AS column_name, ic.is_included_column
                FROM sys.indexes i
                JOIN sys.objects o ON o.object_id = i.object_id
                JOIN sys.schemas s ON s.schema_id = o.schema_id
                JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                WHERE o.type = 'U' AND o.is_ms_shipped = 0
                  AND i.is_primary_key = 0 AND i.is_unique_constraint = 0
                  AND i.type > 0 AND i.is_hypothetical = 0
                ORDER BY s.name, o.name, i.name, ic.is_included_column, ic.key_ordinal, ic.index_column_id
            `);

            const checksResult = await cm.executeQueryInDatabase(database, `
                SELECT s.name AS schema_name, o.name AS object_name, cc.name AS check_name, cc.definition
                FROM sys.check_constraints cc
                JOIN sys.objects o ON o.object_id = cc.parent_object_id
                JOIN sys.schemas s ON s.schema_id = o.schema_id
                WHERE o.is_ms_shipped = 0
                ORDER BY s.name, o.name, cc.name
            `);

            const uniquesResult = await cm.executeQueryInDatabase(database, `
                SELECT s.name AS schema_name, o.name AS object_name, kc.name AS uq_name, c.name AS column_name
                FROM sys.key_constraints kc
                JOIN sys.objects o ON o.object_id = kc.parent_object_id
                JOIN sys.schemas s ON s.schema_id = o.schema_id
                JOIN sys.indexes i ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id
                JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                WHERE kc.type = 'UQ' AND o.is_ms_shipped = 0
                ORDER BY s.name, o.name, kc.name, ic.key_ordinal
            `);

            const triggersResult = await cm.executeQueryInDatabase(database, `
                SELECT s.name AS schema_name, o.name AS object_name, tr.name AS trigger_name,
                       tr.is_disabled, tr.is_instead_of_trigger, te.type_desc AS event
                FROM sys.triggers tr
                JOIN sys.objects o ON o.object_id = tr.parent_id
                JOIN sys.schemas s ON s.schema_id = o.schema_id
                LEFT JOIN sys.trigger_events te ON te.object_id = tr.object_id
                WHERE tr.parent_class = 1 AND tr.is_ms_shipped = 0
                ORDER BY s.name, o.name, tr.name
            `);

            indexes = indexesResult.recordset;
            checkConstraints = checksResult.recordset;
            uniqueConstraints = uniquesResult.recordset;
            triggers = triggersResult.recordset;

            // Row counts / size from allocation metadata (same formulas as
            // sp_spaceused — instant even on huge tables).
            const statsResult = await cm.executeQueryInDatabase(database, `
                SELECT s.name AS schema_name, o.name AS object_name,
                       SUM(CASE WHEN ps.index_id IN (0, 1) THEN ps.row_count ELSE 0 END) AS row_count,
                       SUM(ps.reserved_page_count) * 8 AS reserved_kb
                FROM sys.dm_db_partition_stats ps
                JOIN sys.objects o ON o.object_id = ps.object_id
                JOIN sys.schemas s ON s.schema_id = o.schema_id
                WHERE o.type = 'U' AND o.is_ms_shipped = 0
                GROUP BY s.name, o.name
            `);
            tableStats = statsResult.recordset;

            const typesResult = await cm.executeQueryInDatabase(database, `
                SELECT s.name AS schema_name, t.name AS type_name,
                       TYPE_NAME(t.system_type_id) AS base_type,
                       t.max_length, t.precision, t.scale, t.is_nullable
                FROM sys.types t
                JOIN sys.schemas s ON s.schema_id = t.schema_id
                WHERE t.is_user_defined = 1 AND t.is_table_type = 0
                ORDER BY s.name, t.name
            `);
            userTypes = typesResult.recordset;
        }

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
            indexes, checkConstraints, uniqueConstraints, triggers, tableStats, userTypes,
            index
        });
    }

    // Turn the flat recordsets into the per-schema tree the renderer consumes.
    static assemble({ database, server, objects, columns, primaryKeys, foreignKeys, parameters,
                      indexes = [], checkConstraints = [], uniqueConstraints = [], triggers = [],
                      tableStats = [], userTypes = [], index }) {
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
                // Full-mode extras (stay empty in the basic export).
                entry.indexes = [];
                entry.checks = [];
                entry.uniques = [];
                entry.triggers = [];
                entry.referencedByFk = [];
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

        // Incoming foreign-key relations: for each FK, record it on the table it
        // points to (the outgoing side is already attached above).
        for (const fk of foreignKeys) {
            const refEntry = byQualifiedName[`${fk.ref_schema}.${fk.ref_table}`.toLowerCase()];
            if (refEntry && refEntry.referencedByFk) {
                refEntry.referencedByFk.push({
                    fkName: fk.fk_name,
                    fromTable: `${fk.schema_name}.${fk.object_name}`,
                    fromColumn: fk.column_name,
                    refColumn: fk.ref_column
                });
            }
        }

        // Indexes: collapse the flat (one row per column) recordset into one
        // record per index, key columns first then INCLUDE columns.
        const indexMap = {};
        for (const r of indexes) {
            const entry = find(r);
            if (!entry || !entry.indexes) continue;
            const gkey = `${r.schema_name}.${r.object_name}.${r.index_name}`.toLowerCase();
            let ix = indexMap[gkey];
            if (!ix) {
                ix = indexMap[gkey] = { name: r.index_name, unique: !!r.is_unique, type: r.type_desc, keyColumns: [], includedColumns: [] };
                entry.indexes.push(ix);
            }
            if (r.is_included_column) ix.includedColumns.push(r.column_name);
            else ix.keyColumns.push(r.column_name);
        }

        for (const cc of checkConstraints) {
            const entry = find(cc);
            if (entry && entry.checks) entry.checks.push({ name: cc.check_name, definition: cc.definition });
        }

        const uniqueMap = {};
        for (const r of uniqueConstraints) {
            const entry = find(r);
            if (!entry || !entry.uniques) continue;
            const gkey = `${r.schema_name}.${r.object_name}.${r.uq_name}`.toLowerCase();
            let u = uniqueMap[gkey];
            if (!u) { u = uniqueMap[gkey] = { name: r.uq_name, columns: [] }; entry.uniques.push(u); }
            u.columns.push(r.column_name);
        }

        // Triggers can fire on several events (INSERT/UPDATE/DELETE) → one row each.
        const triggerMap = {};
        for (const r of triggers) {
            const entry = find(r);
            if (!entry || !entry.triggers) continue;
            const gkey = `${r.schema_name}.${r.object_name}.${r.trigger_name}`.toLowerCase();
            let t = triggerMap[gkey];
            if (!t) {
                t = triggerMap[gkey] = { name: r.trigger_name, disabled: !!r.is_disabled, insteadOf: !!r.is_instead_of_trigger, events: [] };
                entry.triggers.push(t);
            }
            if (r.event && !t.events.includes(r.event)) t.events.push(r.event);
        }

        for (const st of tableStats) {
            const entry = find(st);
            if (entry) { entry.rowCount = st.row_count; entry.reservedKb = st.reserved_kb; }
        }

        // User-defined (scalar) types are database-wide, not per-schema-object.
        const userTypeList = userTypes.map(t => ({
            qualifiedName: `${t.schema_name}.${t.type_name}`,
            baseType: DataDictionaryService.formatDataType(t.base_type, t.max_length, t.precision, t.scale),
            nullable: !!t.is_nullable
        }));

        return { database, server, generatedAt: new Date(), schemas, byQualifiedName, userTypes: userTypeList };
    }

    // === Rendering (pure) ===

    // Single self-contained Markdown document. Used for the basic (no Mermaid)
    // export; the full export is split across files by renderPages() so that no
    // single document carries hundreds of Mermaid diagrams (which chokes MD
    // readers). Both paths share the per-object renderers below.
    static render(data, options = {}) {
        const full = !!options.full;
        const lines = [];
        const schemaNames = Object.keys(data.schemas).sort();
        const link = name => DataDictionaryService.sameDocLink(data, name);
        const linkList = names => names.length ? names.map(link).join(', ') : '—';
        const ctx = { full, link, linkList, byQualifiedName: data.byQualifiedName };

        DataDictionaryService.renderHeader(lines, data, options);

        // Table of contents
        lines.push('## Contents');
        lines.push('');
        for (const schemaName of schemaNames) {
            const s = data.schemas[schemaName];
            lines.push(`- [Schema ${schemaName}](#${DataDictionaryService.anchor('Schema: ' + schemaName)}) — ${DataDictionaryService.schemaCounts(s).join(', ')}`);
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
                for (const entry of entries) DataDictionaryService.renderTableEntry(lines, entry, ctx);
            }

            for (const [title, entries] of [['Procedures', s.procedures], ['Functions', s.functions]]) {
                if (entries.length === 0) continue;
                lines.push(`### ${title}`);
                lines.push('');
                for (const entry of entries) DataDictionaryService.renderRoutineEntry(lines, entry, ctx);
            }
        }

        if (full && data.userTypes && data.userTypes.length > 0) {
            DataDictionaryService.renderUserTypes(lines, data.userTypes);
        }

        DataDictionaryService.renderFooter(lines);
        return lines.join('\n');
    }

    // Multi-file full export: an index (README.md) plus one file per page of
    // objects. Tables — the only objects carrying a Mermaid ER diagram — are
    // paginated with a hard cap so no file exceeds `maxTablesPerFile` diagrams,
    // which is what keeps big single-schema databases readable. Cross-object
    // links (FKs, depends-on/referenced-by) resolve to `<file>#anchor` across
    // pages. Returns { indexName, files: [{ name, content }] }.
    static renderPages(data, options = {}) {
        const cap = Math.max(1, options.maxTablesPerFile || 40);
        const pages = DataDictionaryService.paginate(data, cap);

        // qualifiedName → page file it lives on, for cross-file link resolution.
        const fileOf = {};
        for (const p of pages) for (const e of p.entries) fileOf[e.qualifiedName.toLowerCase()] = p.name;

        const exists = name => !!data.byQualifiedName[name.toLowerCase()];
        const link = name => {
            if (!exists(name)) return name;
            const file = fileOf[name.toLowerCase()] || '';
            return `[${name}](${file}#${DataDictionaryService.anchor(name)})`;
        };
        const linkList = names => names.length ? names.map(link).join(', ') : '—';
        const ctx = { full: true, link, linkList, byQualifiedName: data.byQualifiedName };

        const files = [{ name: 'README.md', content: DataDictionaryService.renderIndex(data, options, pages) }];
        for (const page of pages) {
            files.push({ name: page.name, content: DataDictionaryService.renderPage(data, page, ctx) });
        }
        return { indexName: 'README.md', files };
    }

    // === Shared rendering blocks ===

    static renderHeader(lines, data, options) {
        const full = !!options.full;
        const stats = DataDictionaryService.computeStats(data);
        lines.push(`# Data Dictionary — ${data.database}`);
        lines.push('');
        lines.push(`Generated by SQL Wayfarer on ${data.generatedAt.toISOString().slice(0, 10)} (server: ${data.server}).`);
        lines.push('');
        lines.push(`**Contents:** ${stats.tables} tables · ${stats.views} views · ${stats.procedures} procedures · ${stats.functions} functions`);
        if (stats.tables > 0) {
            lines.push('');
            lines.push(`**Documentation coverage:** ${stats.tablesDocumentedPct}% of tables and ${stats.columnsDocumentedPct}% of columns have a description.`);
        }
        if (full) {
            const t = DataDictionaryService.computeFullTotals(data);
            lines.push('');
            lines.push(`**Model:** ${t.foreignKeys} foreign keys · ${t.indexes} indexes · ${t.checks} check constraints · ${t.uniques} unique constraints · ${t.triggers} triggers`);
            if (t.rowCount > 0) {
                lines.push('');
                lines.push(`**Volume:** ${DataDictionaryService.formatCount(t.rowCount)} rows across all tables.`);
            }
        }
        lines.push('');
    }

    static renderFooter(lines) {
        lines.push('---');
        lines.push('*Generated with [SQL Wayfarer](https://github.com/intarynx/sqlwayfarer). Descriptions come from MS_Description extended properties — edit them in the Comments tab.*');
        lines.push('');
    }

    static renderUserTypes(lines, userTypes) {
        lines.push('## User Defined Types');
        lines.push('');
        lines.push('| Type | Base type | Nullable |');
        lines.push('|------|-----------|:--------:|');
        for (const t of userTypes) {
            lines.push(`| ${DataDictionaryService.escapeCell(t.qualifiedName)} | ${DataDictionaryService.escapeCell(t.baseType)} | ${t.nullable ? '✓' : ''} |`);
        }
        lines.push('');
    }

    static schemaCounts(s) {
        const counts = [];
        if (s.tables.length) counts.push(`${s.tables.length} tables`);
        if (s.views.length) counts.push(`${s.views.length} views`);
        if (s.procedures.length) counts.push(`${s.procedures.length} procedures`);
        if (s.functions.length) counts.push(`${s.functions.length} functions`);
        return counts;
    }

    static sameDocLink(data, name) {
        return data.byQualifiedName[name.toLowerCase()]
            ? `[${name}](#${DataDictionaryService.anchor(name)})`
            : name;
    }

    // One table/view card. `ctx` = { full, link, linkList, byQualifiedName }.
    static renderTableEntry(lines, entry, ctx) {
        const { full, link, linkList, byQualifiedName } = ctx;
        lines.push(`#### ${entry.qualifiedName}`);
        lines.push('');
        if (entry.description) {
            lines.push(`> ${entry.description.replace(/\r?\n/g, ' ')}`);
            lines.push('');
        }
        if (full && entry.rowCount !== undefined && entry.rowCount !== null) {
            lines.push(`*${DataDictionaryService.formatCount(entry.rowCount)} rows · ${DataDictionaryService.formatSize(entry.reservedKb)}*`);
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

        if (full) {
            DataDictionaryService.renderTableExtras(lines, entry, link);
            DataDictionaryService.renderErNeighborhood(lines, entry, byQualifiedName);
        }

        lines.push(`**Depends on:** ${linkList(entry.dependsOn)}  `);
        lines.push(`**Referenced by:** ${linkList(entry.referencedBy)}`);
        lines.push('');
    }

    // One procedure/function card. `ctx` = { link, linkList }.
    static renderRoutineEntry(lines, entry, ctx) {
        const { linkList } = ctx;
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

    // === Multi-file pagination ===

    // Split every schema's objects into page bins. Each category is paginated
    // independently; tables are grouped by name prefix then packed under the
    // cap (see packByPrefix). Returns an ordered list of pages, each
    // { name, schema, category, part, partCount, entries }.
    static paginate(data, cap) {
        const pages = [];
        const categories = [
            { key: 'tables', label: 'Tables' },
            { key: 'views', label: 'Views' },
            { key: 'procedures', label: 'Procedures' },
            { key: 'functions', label: 'Functions' }
        ];
        for (const schemaName of Object.keys(data.schemas).sort()) {
            const s = data.schemas[schemaName];
            const schemaSlug = DataDictionaryService.slugFile(schemaName);
            for (const cat of categories) {
                const entries = s[cat.key] || [];
                if (entries.length === 0) continue;
                const bins = DataDictionaryService.packByPrefix(entries, cap);
                const multi = bins.length > 1;
                bins.forEach((bin, i) => {
                    const suffix = multi ? `-${String(i + 1).padStart(2, '0')}` : '';
                    pages.push({
                        name: `${schemaSlug}-${cat.key}${suffix}.md`,
                        schema: schemaName,
                        category: cat.label,
                        part: multi ? i + 1 : null,
                        partCount: multi ? bins.length : null,
                        entries: bin
                    });
                });
            }
        }
        return pages;
    }

    // Grouping key for an object: the segment before the first underscore, else
    // the first camelCase / leading word. Maps names like Invoice_Header and
    // InvoiceLine to a shared module bucket when a convention exists, and
    // degrades to per-name buckets (→ alphabetical packing) when it doesn't.
    static objectPrefix(name) {
        const n = name || '';
        const us = n.indexOf('_');
        if (us > 0) return n.slice(0, us);
        const m = n.match(/^[A-Za-z][a-z0-9]*/);
        return m ? m[0] : n;
    }

    // Bin-pack entries under a hard cap while keeping same-prefix objects
    // together. A prefix group larger than the cap is chunked; smaller groups
    // are merged with following groups until the cap is reached. Deterministic
    // (groups and items are ordered), so the file layout is stable across runs.
    static packByPrefix(entries, cap) {
        const groups = [];
        const byPrefix = {};
        for (const e of entries) {
            const key = DataDictionaryService.objectPrefix(e.name).toLowerCase();
            if (!byPrefix[key]) { byPrefix[key] = { key, items: [] }; groups.push(byPrefix[key]); }
            byPrefix[key].items.push(e);
        }
        groups.sort((a, b) => a.key.localeCompare(b.key));

        const bins = [];
        let cur = [];
        const flush = () => { if (cur.length) { bins.push(cur); cur = []; } };
        for (const g of groups) {
            if (g.items.length > cap) {
                flush();
                for (let i = 0; i < g.items.length; i += cap) bins.push(g.items.slice(i, i + cap));
                continue;
            }
            if (cur.length + g.items.length > cap) flush();
            cur.push(...g.items);
        }
        flush();
        return bins.length ? bins : [[]];
    }

    // The index file: header, per-schema list of page files with row ranges,
    // and (full mode) the small user-defined-types table.
    static renderIndex(data, options, pages) {
        const lines = [];
        DataDictionaryService.renderHeader(lines, data, options);

        lines.push('## Contents');
        lines.push('');
        lines.push('*This dictionary is split across several files to stay readable in any Markdown viewer.*');
        lines.push('');
        for (const schemaName of Object.keys(data.schemas).sort()) {
            const s = data.schemas[schemaName];
            lines.push(`### Schema: ${schemaName}`);
            lines.push('');
            lines.push(`${DataDictionaryService.schemaCounts(s).join(' · ')}`);
            lines.push('');
            for (const page of pages.filter(p => p.schema === schemaName)) {
                const first = page.entries[0];
                const last = page.entries[page.entries.length - 1];
                const range = page.entries.length > 1 && first && last
                    ? ` — ${first.name} … ${last.name}`
                    : (first ? ` — ${first.name}` : '');
                const part = page.partCount ? ` (part ${page.part}/${page.partCount})` : '';
                lines.push(`- [${page.category}${part}](${page.name}) · ${page.entries.length}${range}`);
            }
            lines.push('');
        }

        if (data.userTypes && data.userTypes.length > 0) {
            DataDictionaryService.renderUserTypes(lines, data.userTypes);
        }

        DataDictionaryService.renderFooter(lines);
        return lines.join('\n');
    }

    // One page file: a heading, a back-link to the index, then the object cards.
    static renderPage(data, page, ctx) {
        const lines = [];
        const part = page.partCount ? ` — part ${page.part}/${page.partCount}` : '';
        lines.push(`# ${data.database} — ${page.schema}: ${page.category}${part}`);
        lines.push('');
        lines.push('[← Index](README.md)');
        lines.push('');
        const isRoutine = page.category === 'Procedures' || page.category === 'Functions';
        for (const entry of page.entries) {
            if (isRoutine) DataDictionaryService.renderRoutineEntry(lines, entry, ctx);
            else DataDictionaryService.renderTableEntry(lines, entry, ctx);
        }
        DataDictionaryService.renderFooter(lines);
        return lines.join('\n');
    }

    // Filesystem-safe slug for a schema/database name used in file names.
    static slugFile(text) {
        return String(text).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
    }

    // === Full-mode table sections (indexes, incoming FKs, constraints, triggers) ===
    // Each block is emitted only when it has content, to keep the document readable.
    static renderTableExtras(lines, entry, link) {
        const esc = DataDictionaryService.escapeCell;

        if (entry.referencedByFk && entry.referencedByFk.length > 0) {
            lines.push('**Referenced by (foreign keys):**');
            lines.push('');
            for (const r of entry.referencedByFk) {
                lines.push(`- ${link(r.fromTable)}.${r.fromColumn} → ${r.refColumn} (\`${r.fkName}\`)`);
            }
            lines.push('');
        }

        if (entry.indexes && entry.indexes.length > 0) {
            lines.push('**Indexes:**');
            lines.push('');
            lines.push('| Index | Columns | Unique | Type |');
            lines.push('|-------|---------|:------:|------|');
            for (const ix of entry.indexes) {
                let cols = ix.keyColumns.join(', ');
                if (ix.includedColumns.length) cols += ` (incl. ${ix.includedColumns.join(', ')})`;
                lines.push(`| ${esc(ix.name)} | ${esc(cols)} | ${ix.unique ? '✓' : ''} | ${esc((ix.type || '').toLowerCase())} |`);
            }
            lines.push('');
        }

        if (entry.uniques && entry.uniques.length > 0) {
            lines.push('**Unique constraints:**');
            lines.push('');
            for (const u of entry.uniques) {
                lines.push(`- \`${u.name}\`: ${u.columns.join(', ')}`);
            }
            lines.push('');
        }

        if (entry.checks && entry.checks.length > 0) {
            lines.push('**Check constraints:**');
            lines.push('');
            for (const c of entry.checks) {
                const def = (c.definition || '').replace(/\s+/g, ' ').replace(/`/g, '').trim();
                lines.push(`- \`${c.name}\`: \`${def}\``);
            }
            lines.push('');
        }

        if (entry.triggers && entry.triggers.length > 0) {
            lines.push('**Triggers:**');
            lines.push('');
            for (const t of entry.triggers) {
                const parts = [];
                if (t.insteadOf) parts.push('INSTEAD OF');
                if (t.events.length) parts.push(t.events.join(', '));
                if (t.disabled) parts.push('disabled');
                const meta = parts.length ? ` — ${parts.join(', ')}` : '';
                lines.push(`- \`${t.name}\`${meta}`);
            }
            lines.push('');
        }
    }

    // Whole-database totals for the full-mode header (relations, indexes, etc.).
    static computeFullTotals(data) {
        const t = { foreignKeys: 0, indexes: 0, checks: 0, uniques: 0, triggers: 0, rowCount: 0 };
        for (const s of Object.values(data.schemas)) {
            for (const tbl of s.tables) {
                t.foreignKeys += (tbl.foreignKeys || []).length;
                t.indexes += (tbl.indexes || []).length;
                t.checks += (tbl.checks || []).length;
                t.uniques += (tbl.uniques || []).length;
                t.triggers += (tbl.triggers || []).length;
                t.rowCount += Number(tbl.rowCount) || 0;
            }
        }
        return t;
    }

    // Per-table "neighborhood" Mermaid ER: the table plus the tables it is
    // directly linked to by a foreign key (outgoing + incoming). Bounded by the
    // table's FK degree, not by the size of the database, so it stays small and
    // readable even on schemas with hundreds of tables — a global diagram would
    // both be unreadable and blow past Mermaid's maxTextSize limit. Attributes
    // are keys only (PK/FK); full columns are already in the table above.
    static renderErNeighborhood(lines, entry, byQualifiedName) {
        const MAX_NEIGHBORS = 12;
        const ident = s => (s || '_').toString().replace(/[^A-Za-z0-9_]/g, '_');

        // Related tables: FK targets (outgoing) and FK sources (incoming).
        const related = new Set();
        for (const fk of entry.foreignKeys || []) related.add(`${fk.ref_schema}.${fk.ref_table}`);
        for (const r of entry.referencedByFk || []) related.add(r.fromTable);
        related.delete(entry.qualifiedName); // self-links are drawn as a loop, not a neighbor

        // A lone table with no relationships makes a pointless one-box diagram.
        if (related.size === 0 && !(entry.foreignKeys || []).some(fk => `${fk.ref_schema}.${fk.ref_table}` === entry.qualifiedName)) {
            return;
        }

        const neighbors = [...related].sort();
        const shown = new Set(neighbors.slice(0, MAX_NEIGHBORS));
        const omitted = neighbors.length - shown.size;

        // keys-only attribute block for one table; bare entity if it has none.
        const emitEntity = (qn) => {
            const e = byQualifiedName[qn.toLowerCase()];
            const id = ident(qn);
            if (!e || !e.columns) { lines.push(`  ${id}`); return; }
            const pk = new Set(e.primaryKey || []);
            const fkCols = new Set((e.foreignKeys || []).map(f => f.column_name));
            const keyCols = (e.columns || []).filter(c => pk.has(c.column_name) || fkCols.has(c.column_name));
            if (keyCols.length === 0) { lines.push(`  ${id}`); return; }
            lines.push(`  ${id} {`);
            for (const c of keyCols) {
                const keys = [];
                if (pk.has(c.column_name)) keys.push('PK');
                if (fkCols.has(c.column_name)) keys.push('FK');
                lines.push(`    ${ident(c.data_type || 'unknown')} ${ident(c.column_name)} ${keys.join(', ')}`);
            }
            lines.push('  }');
        };

        lines.push('**Relationships:**');
        lines.push('');
        lines.push('```mermaid');
        lines.push('erDiagram');
        emitEntity(entry.qualifiedName);
        for (const qn of shown) emitEntity(qn);

        // Outgoing: referenced (one) ||--o{ this table (many).
        for (const fk of entry.foreignKeys || []) {
            const target = `${fk.ref_schema}.${fk.ref_table}`;
            if (target === entry.qualifiedName || shown.has(target)) {
                lines.push(`  ${ident(target)} ||--o{ ${ident(entry.qualifiedName)} : "${fk.fk_name}"`);
            }
        }
        // Incoming: this table (one) ||--o{ referencing table (many).
        for (const r of entry.referencedByFk || []) {
            if (r.fromTable === entry.qualifiedName) continue; // already drawn as outgoing self-loop
            if (shown.has(r.fromTable)) {
                lines.push(`  ${ident(entry.qualifiedName)} ||--o{ ${ident(r.fromTable)} : "${r.fkName}"`);
            }
        }
        lines.push('```');
        if (omitted > 0) lines.push(`*(+${omitted} more related table${omitted > 1 ? 's' : ''} not shown)*`);
        lines.push('');
    }

    // === Helpers ===

    static formatCount(n) {
        const v = Number(n) || 0;
        return v.toLocaleString('en-US').replace(/,/g, ' ');
    }

    static formatSize(kb) {
        const v = Number(kb);
        if (!v || v < 0) return '—';
        if (v >= 1048576) return `${(v / 1048576).toFixed(1)} GB`;
        if (v >= 1024) return `${(v / 1024).toFixed(1)} MB`;
        return `${v} KB`;
    }

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
