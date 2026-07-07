'use strict';

const BabelfishSqlParser = require('./BabelfishSqlParser');
const parseObjectName = require('./parseObjectName');

class DependencyService {
    constructor() {
        this._indexService = null;
        this._connectionManager = null;
        this._sqlParser = new BabelfishSqlParser();
    }

    setIndexService(indexService) {
        this._indexService = indexService;
    }

    setConnectionManager(connectionManager) {
        this._connectionManager = connectionManager;
        // Active le parsing SQL dès qu'une connexion est dispo
        this._sqlParser.setEnabled(!!connectionManager);
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

            // Analyse SQL optionnelle : si activée, on parse le code pour avoir les vraies opérations
            let opsMap = null;
            if (this._sqlParser.isEnabled() && this._connectionManager) {
                opsMap = await this._getOperationsFromSql(database, cleanName, objectData.type);
            }

            const dependsOn = (objectData.dependencies || []).map(dep => {
                const depClean = dep.replace(/[\[\]]/g, '').toLowerCase();
                // Le parser SQL qualifie ses clés (schema.table, voire db.schema.table) quand le SQL
                // source précise le schéma — on matche donc d'abord sur le nom complet pour ne pas
                // confondre p.ex. dbo.Orders et sales.Orders. Si le SQL source référence la table
                // sans schéma (résolution implicite), le parser n'a que le nom nu : on retombe alors
                // sur un match par dernier segment, avec le risque de collision inter-schéma que ça implique.
                const operations = opsMap?.[depClean] || opsMap?.[depClean.split('.').pop()] || ['REFERENCE'];
                return {
                    referenced_object: dep,
                    referenced_object_type: this._getTypeFromCode(index.objects[dep]?.type),
                    dependency_type: 'REFERENCE',
                    operations: operations,
                    is_selected: operations.includes('SELECT') || operations.includes('MERGE') ? 1 : 0,
                    is_updated: operations.includes('UPDATE') || operations.includes('MERGE') ? 1 : 0,
                    is_insert_all: operations.includes('INSERT') || operations.includes('MERGE') ? 1 : 0,
                    is_delete: operations.includes('DELETE') || operations.includes('MERGE') ? 1 : 0
                };
            });

            const referencedBy = [];
            for (const [key, obj] of Object.entries(index.objects)) {
                if (!obj.dependencies?.length) continue;
                const matches = obj.dependencies.some(dep => {
                    const clean = dep.replace(/[\[\]]/g, '');
                    return clean === cleanName || clean.toLowerCase() === cleanName.toLowerCase() ||
                        dep === objectName || dep === cleanName;
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
     * Récupère la définition SQL de l'objet et extrait les opérations par table.
     */
    async _getOperationsFromSql(database, objectName, objectType) {
        try {
            // Tables n'ont pas de "définition" utile pour le parsing — toujours SELECT/INSERT/UPDATE/DELETE possibles
            if (objectType === 'U') return null;

            // Il faut quoter schéma et nom séparément, sinon QUOTENAME() sur le nom complet
            // produit un seul identifiant avec un point littéral (ex: [schema.object]) que
            // OBJECT_ID ne peut jamais résoudre.
            const { schema, objectName: namePart } = parseObjectName(objectName);
            const schemaPart = schema.replace(/'/g, "''");
            const namePartEscaped = namePart.replace(/'/g, "''");

            const result = await this._connectionManager.executeQueryInDatabase(database, `
                SELECT OBJECT_DEFINITION(OBJECT_ID(QUOTENAME('${schemaPart}') + '.' + QUOTENAME('${namePartEscaped}'))) AS definition;
            `);

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
                return { name: objName, dependencies: children };
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
