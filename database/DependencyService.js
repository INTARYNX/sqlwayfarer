'use strict';

const BabelfishSqlParser = require('./BabelfishSqlParser');
const parseObjectName = require('./parseObjectName');

class DependencyService {
    constructor() {
        this._indexService = null;
        this._connectionManager = null;
        this._databaseService = null;
        this._sqlParser = new BabelfishSqlParser();
    }

    setIndexService(indexService) {
        this._indexService = indexService;
    }

    setConnectionManager(connectionManager) {
        this._connectionManager = connectionManager;
        // Turns the SQL parsing on as soon as a connection is available
        this._sqlParser.setEnabled(!!connectionManager);
    }

    // Needed to resolve the type of objects living in ANOTHER database: the
    // index only knows the objects of the database being browsed.
    setDatabaseService(databaseService) {
        this._databaseService = databaseService;
    }

    // Splits a dependency name the way the index stores it.
    //   'dbo.Orders'          -> { database: null, schema: 'dbo', object: 'Orders' }
    //   'OtherDb.dbo.Orders'  -> { database: 'OtherDb', schema: 'dbo', object: 'Orders' }
    //   'OtherDb..Orders'     -> { database: 'OtherDb', schema: '', object: 'Orders' }
    // A database prefix is only read on a 3-part name: the DMV prefixes the
    // database for cross-database references only, and a local object name may
    // itself contain dots ('dbo.my.table' stays schema + object).
    static parseDependencyName(name) {
        const clean = (name || '').replace(/[\[\]]/g, '');
        const parts = clean.split('.');
        if (parts.length === 1) return { database: null, schema: 'dbo', object: parts[0] };
        if (parts.length === 2) return { database: null, schema: parts[0] || 'dbo', object: parts[1] };
        return { database: parts[0], schema: parts[1] || '', object: parts.slice(2).join('.') };
    }

    // The database a dependency points at, when it is another database than
    // the one being browsed. null for a local dependency.
    static externalTarget(name, currentDatabase) {
        const parsed = DependencyService.parseDependencyName(name);
        if (!parsed.database) return null;
        if (parsed.database.toLowerCase() === (currentDatabase || '').toLowerCase()) return null;
        return { database: parsed.database, schema: parsed.schema || 'dbo', object: parsed.object };
    }

    setSqlParsingEnabled(enabled) {
        this._sqlParser.setEnabled(enabled);
    }

    async getDependencies(database, objectName) {
        try {
            if (!this._indexService) return { dependsOn: [], referencedBy: [] };

            const index = await this._indexService.getIndex(database);
            if (!index || !index.objects) return { dependsOn: [], referencedBy: [] };

            const cleanName = objectName.replace(/[\[\]]/g, '');
            let objectData = index.objects[cleanName];

            if (!objectData) {
                for (const [key, obj] of Object.entries(index.objects)) {
                    if (key.toLowerCase() === cleanName.toLowerCase() ||
                        obj.name === cleanName || obj.qualifiedName === cleanName) {
                        objectData = obj;
                        break;
                    }
                }
            }

            if (!objectData) return { dependsOn: [], referencedBy: [] };

            // Optional SQL analysis: when enabled, the code of the object is
            // parsed to know the real operations it performs
            let opsMap = null;
            if (this._sqlParser.isEnabled() && this._connectionManager) {
                opsMap = await this._getOperationsFromSql(database, cleanName, objectData.type);
            }

            // sys.dm_sql_referenced_entities reports a dependency's name using the
            // casing from the SOURCE TEXT that referenced it (e.g. "DBO.orders"),
            // not the catalog's actual casing ("dbo.Orders") that index.objects is
            // keyed by - so a case-sensitive lookup here would silently resolve to
            // "Object" instead of the real type. Build a case-insensitive lookup
            // once instead of per-dependency.
            const lowerIndex = new Map(Object.entries(index.objects).map(([k, v]) => [k.toLowerCase(), v]));

            const dependsOn = (objectData.dependencies || []).map(dep => {
                const depClean = dep.replace(/[\[\]]/g, '').toLowerCase();
                // The SQL parser qualifies its keys (schema.table, or even
                // db.schema.table) when the source SQL gives the schema - so
                // the full name is matched first, to avoid confusing e.g.
                // dbo.Orders and sales.Orders. When the source SQL references
                // the table without a schema (implicit resolution), the parser
                // only knows the bare name: the last segment is matched then,
                // with the cross-schema collision risk that implies.
                const operations = opsMap?.[depClean] || opsMap?.[depClean.split('.').pop()] || ['REFERENCE'];

                // A dependency can point at ANOTHER database: a view of this one
                // selecting from OtherDb.dbo.Orders. The DMV prefixes such a
                // reference with the database name, so the raw name carries
                // enough to spot it. The local index knows nothing about that
                // other database, so the type is resolved there (below).
                const parsed = DependencyService.parseDependencyName(dep);
                const external = DependencyService.externalTarget(dep, database);
                // Local lookup: the raw name first (a local object may itself
                // contain dots, 'dbo.my.table'), then the schema-qualified form
                // for a self-qualified name ('MyDb.dbo.Orders' in MyDb).
                const localName = parsed.database ? `${parsed.schema || 'dbo'}.${parsed.object}` : dep;
                const localHit = index.objects[dep] || lowerIndex.get(depClean);
                const depObj = localHit
                    || index.objects[localName] || lowerIndex.get(localName.toLowerCase());
                // The index only holds the objects of the database being
                // browsed: a name that matches it as-is is a local object,
                // even when it has enough parts to look database-qualified.
                const isExternal = !!external && !localHit;

                return {
                    referenced_object: dep,
                    referenced_object_type: this._getTypeFromCode(depObj?.type),
                    dependency_type: 'REFERENCE',
                    operations: operations,
                    is_selected: operations.includes('SELECT') || operations.includes('MERGE') ? 1 : 0,
                    is_updated: operations.includes('UPDATE') || operations.includes('MERGE') ? 1 : 0,
                    is_insert_all: operations.includes('INSERT') || operations.includes('MERGE') ? 1 : 0,
                    is_delete: operations.includes('DELETE') || operations.includes('MERGE') ? 1 : 0,
                    // Cross-database marker: the UI turns those into links that
                    // open the object in its own database.
                    is_external: isExternal,
                    external_database: isExternal ? external.database : null,
                    schema_name: parsed.schema || 'dbo',
                    object_name: parsed.object
                };
            });

            // The type of a cross-database dependency is unknown until it is
            // asked for in the database that owns it.
            await this._resolveExternalTypes(dependsOn);

            // If the caller passed an unqualified name (e.g. 'Orders' instead of
            // 'dbo.Orders'), every dependency string below is fully qualified and
            // would never equal it - fall back to matching on the last segment,
            // same tradeoff getColumnUsage/DependencyService's ops lookup already make.
            const bareTarget = cleanName.includes('.') ? null : cleanName.toLowerCase();

            const referencedBy = [];
            for (const [key, obj] of Object.entries(index.objects)) {
                if (!obj.dependencies?.length) continue;
                const matches = obj.dependencies.some(dep => {
                    const clean = dep.replace(/[\[\]]/g, '');
                    const cleanLower = clean.toLowerCase();
                    // A dependency qualified by ANOTHER database refers to that
                    // database's object, not to this one - even when both carry
                    // the same name.
                    if (DependencyService.externalTarget(clean, database)) return false;
                    return clean === cleanName || cleanLower === cleanName.toLowerCase() ||
                        dep === objectName || dep === cleanName ||
                        (bareTarget !== null && cleanLower.split('.').pop() === bareTarget);
                });
                if (matches) {
                    referencedBy.push({
                        referencing_object: obj.name || key,
                        referencing_object_type: this._getTypeFromCode(obj.type),
                        dependency_type: 'REFERENCE'
                    });
                }
            }

            return { dependsOn, referencedBy };
        } catch (error) {
            console.error('Error getting dependencies:', error);
            return { dependsOn: [], referencedBy: [] };
        }
    }

    /**
     * Resolves the real type of the dependencies that live in ANOTHER database.
     * One query per target database, whatever the number of objects: the
     * Explorer index only covers the database being browsed, so the type of a
     * cross-database object is unknown until it is asked for in its own home.
     *
     * Best-effort: an unreadable database (permissions, offline) leaves the
     * generic "Object" type - the dependency stays clickable. On the other
     * hand, if the database can be read and the object is not in it, the
     * prefix was a false positive (a local schema named like a database):
     * the dependency becomes local again.
     */
    async _resolveExternalTypes(entries) {
        const externals = (entries || []).filter(e => e.is_external && e.external_database);
        if (externals.length === 0) return;
        if (!this._databaseService) return;

        const byDatabase = new Map();
        for (const entry of externals) {
            const key = entry.external_database.toLowerCase();
            if (!byDatabase.has(key)) {
                byDatabase.set(key, { database: entry.external_database, names: new Set() });
            }
            byDatabase.get(key).names.add(`${entry.schema_name}.${entry.object_name}`.toLowerCase());
        }

        for (const { database, names } of byDatabase.values()) {
            let types = null;
            try {
                types = await this._databaseService.getObjectTypes(database, [...names]);
            } catch (error) {
                console.warn(`[DependencyService] Failed to resolve object types in ${database}:`, error.message);
                continue; // unreadable database: keep "Object", the link stays valid
            }
            for (const entry of externals) {
                if (entry.external_database.toLowerCase() !== database.toLowerCase()) continue;
                const key = `${entry.schema_name}.${entry.object_name}`.toLowerCase();
                if (types[key]) {
                    entry.referenced_object_type = types[key];
                } else {
                    // The database was read and the object is not in it: the
                    // database prefix was a false positive, the object is local.
                    entry.is_external = false;
                    entry.external_database = null;
                }
            }
        }
    }

    /**
     * Fetches the SQL definition of the object and extracts the operations
     * per table.
     */
    async _getOperationsFromSql(database, objectName, objectType) {
        try {
            // Tables have no useful "definition" for the parsing - SELECT,
            // INSERT, UPDATE and DELETE are all possible.
            if (objectType === 'U') return null;

            // The schema and the name must be quoted separately, otherwise
            // QUOTENAME() on the full name produces a single identifier with a
            // literal dot (e.g. [schema.object]) that OBJECT_ID can never
            // resolve.
            const { schema, objectName: namePart } = parseObjectName(objectName);
            const result = await this._connectionManager.executeQueryInDatabase(database, `
                SELECT OBJECT_DEFINITION(OBJECT_ID(QUOTENAME(@schema) + '.' + QUOTENAME(@objectName))) AS definition;
            `, { schema, objectName: namePart });

            const definition = result.recordset?.[0]?.definition;
            if (!definition) return null;

            return this._sqlParser.analyzeOperations(definition);
        } catch (err) {
            console.warn(`[DependencyService] Failed to fetch SQL definition for ${objectName}: ${err.message}`);
            return null;
        }
    }

    async getDependencyTree(database, objectName, maxDepth = 3) {
        try {
            if (!this._indexService) return { name: objectName, dependencies: [] };

            const index = await this._indexService.getIndex(database);
            if (!index || !index.objects) return { name: objectName, dependencies: [] };

            const visited = new Set();

            const buildTree = (objName, level) => {
                if (level >= maxDepth || visited.has(objName)) return { name: objName, dependencies: [] };
                visited.add(objName);

                const data = index.objects[objName.replace(/[\[\]]/g, '')];
                if (!data?.dependencies) { visited.delete(objName); return { name: objName, dependencies: [] }; }

                const children = data.dependencies.map(dep => buildTree(dep, level + 1));
                visited.delete(objName);
                // A node living in another database is flagged so the UI can
                // turn it into a link (the tree carries no type information).
                const external = DependencyService.externalTarget(objName, database);
                return {
                    name: objName,
                    dependencies: children,
                    external: external ? { database: external.database, schema: external.schema, object: external.object } : null
                };
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

    _getTypeFromCode(typeCode) {
        const types = { 'U': 'Table', 'V': 'View', 'P': 'Procedure', 'FN': 'Function', 'IF': 'Function', 'TF': 'Function', 'TR': 'Trigger' };
        return types[(typeCode || '').trim()] || 'Object';
    }

    dispose() {}
}

module.exports = DependencyService;
