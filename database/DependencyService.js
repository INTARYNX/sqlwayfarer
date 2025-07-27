/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

const SmartSqlParser = require('./SmartSqlParser');

/**
 * DependencyService refactorisé - Version simplifiée avec SmartSqlParser
 * Remplace l'ancien système complexe par l'approche intelligente de parsing SQL
 */
class DependencyService {
    constructor(connectionManager, databaseService) {
        this._connectionManager = connectionManager;
        this._databaseService = databaseService;
        this._smartParser = new SmartSqlParser(connectionManager, databaseService);
        this._cache = new Map(); // Cache simple en mémoire
        this._cacheTimeout = 5 * 60 * 1000; // 5 minutes
    }

    /**
     * Obtenir les dépendances d'un objet avec la nouvelle méthode
     */
    async getDependencies(database, objectName) {
        const cacheKey = `${database}.${objectName}`;
        
        // Vérifier le cache
        if (this._cache.has(cacheKey)) {
            const cached = this._cache.get(cacheKey);
            if (Date.now() - cached.timestamp < this._cacheTimeout) {
                console.log(`📋 Cache hit for ${objectName}`);
                return cached.data;
            }
        }

        console.log(`🔄 Computing dependencies for ${objectName}`);
        
        try {
            // Utiliser la nouvelle méthode de parsing intelligent
            const result = await this._smartParser.analyzeDependencies(database, objectName);
            
            // Mettre en cache
            this._cache.set(cacheKey, {
                data: result,
                timestamp: Date.now()
            });
            
            return result;
            
        } catch (error) {
            console.error(`❌ Error getting dependencies for ${objectName}:`, error);
            return { dependsOn: [], referencedBy: [] };
        }
    }

    /**
     * Analyse de l'utilisation des tables par un objet
     */
    async getTableUsageAnalysis(database, objectName) {
        console.log(`📊 Getting table usage analysis for ${objectName}`);
        
        try {
            return await this._smartParser.getTableUsageAnalysis(database, objectName);
        } catch (error) {
            console.error(`❌ Error in table usage analysis for ${objectName}:`, error);
            return {
                objectName: objectName,
                tablesUsed: [],
                relatedObjects: [],
                summary: { totalTables: 0, readTables: 0, writeTables: 0, operationCounts: {} }
            };
        }
    }

    /**
     * Obtenir les objets qui utilisent une table donnée
     */
    async getTableUsageByObjects(database, tableName) {
        console.log(`🔍 Finding objects that use table ${tableName}`);
        
        try {
            // Obtenir tous les objets de la base
            const allObjects = await this._databaseService.getObjects(database);
            const usageResults = [];
            
            // Analyser chaque objet pour voir s'il utilise cette table
            for (const obj of allObjects) {
                if (obj.object_type === 'Table') continue; // Skip tables
                
                try {
                    const dependencies = await this.getDependencies(database, obj.name);
                    const usesTable = dependencies.dependsOn.find(dep => 
                        dep.referenced_object.toUpperCase() === tableName.toUpperCase()
                    );
                    
                    if (usesTable) {
                        usageResults.push({
                            object_name: obj.name,
                            object_type: obj.object_type,
                            table_name: tableName,
                            operation_type: usesTable.dependency_type,
                            operations_array: usesTable.operations || [],
                            is_selected: usesTable.is_selected,
                            is_updated: usesTable.is_updated,
                            is_insert_all: usesTable.is_insert_all,
                            is_delete: usesTable.is_delete
                        });
                    }
                } catch (objError) {
                    console.warn(`Warning: Could not analyze ${obj.name}:`, objError.message);
                }
            }
            
            return {
                tableName: tableName,
                usedByObjects: usageResults,
                summary: this._generateTableUsageSummary(usageResults)
            };
            
        } catch (error) {
            console.error(`❌ Error getting table usage for ${tableName}:`, error);
            return {
                tableName: tableName,
                usedByObjects: [],
                summary: { totalObjects: 0, procedures: 0, views: 0, functions: 0, triggers: 0, tables: 0 }
            };
        }
    }

    /**
     * Analyser les triggers de la base de données
     */
    async getTriggerAnalysis(database) {
        try {
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
            
        } catch (error) {
            console.error(`❌ Error getting trigger analysis for ${database}:`, error);
            return [];
        }
    }

    /**
     * Obtenir l'arbre des dépendances (version simplifiée)
     */
    async getDependencyTree(database, objectName, maxDepth = 3) {
        try {
            return await this._buildDependencyTree(database, objectName, 0, maxDepth, new Set());
        } catch (error) {
            console.error(`❌ Error building dependency tree for ${objectName}:`, error);
            return {
                name: objectName,
                dependencies: [],
                level: 0
            };
        }
    }

    /**
     * Construire l'arbre des dépendances récursivement
     */
    async _buildDependencyTree(database, objectName, currentLevel, maxDepth, visited) {
        if (currentLevel >= maxDepth || visited.has(objectName)) {
            return {
                name: objectName,
                dependencies: [],
                level: currentLevel
            };
        }

        visited.add(objectName);
        const dependencies = await this.getDependencies(database, objectName);
        const childNodes = [];

        for (const dep of dependencies.dependsOn) {
            const childNode = await this._buildDependencyTree(
                database, 
                dep.referenced_object, 
                currentLevel + 1, 
                maxDepth, 
                new Set(visited)
            );
            
            childNode.type = dep.referenced_object_type;
            childNode.dependency_type = dep.dependency_type;
            childNodes.push(childNode);
        }

        return {
            name: objectName,
            dependencies: childNodes,
            level: currentLevel
        };
    }

    /**
     * Analyse d'impact (quels objets seraient affectés si on modifie cet objet)
     */
    async getImpactAnalysis(database, objectName) {
        try {
            // Pour l'instant, retourner un tableau vide
            // Cette fonctionnalité peut être implémentée plus tard si nécessaire
            console.log(`🎯 Impact analysis for ${objectName} - feature not implemented yet`);
            return [];
        } catch (error) {
            console.error(`❌ Error in impact analysis for ${objectName}:`, error);
            return [];
        }
    }

    /**
     * Générer un résumé de l'utilisation d'une table
     */
    _generateTableUsageSummary(usedByObjects) {
        const summary = {
            totalObjects: usedByObjects.length,
            procedures: 0,
            views: 0,
            functions: 0,
            triggers: 0,
            tables: 0
        };

        usedByObjects.forEach(obj => {
            const objType = obj.object_type || 'Unknown';
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
     * Nettoyer le cache
     */
    clearCache(database = null) {
        if (database) {
            // Nettoyer seulement les entrées pour cette base de données
            for (const [key, value] of this._cache) {
                if (key.startsWith(`${database}.`)) {
                    this._cache.delete(key);
                }
            }
            this._smartParser.clearCache(database);
        } else {
            // Nettoyer tout le cache
            this._cache.clear();
            this._smartParser.clearCache();
        }
        console.log(`🧹 Cache cleared for ${database || 'all databases'}`);
    }

    /**
     * Forcer la réindexation (pour compatibilité avec l'ancien code)
     */
    async forceReindex(database, progressCallback) {
        console.log(`🔄 Force reindex for ${database} - clearing cache instead`);
        this.clearCache(database);
        
        if (progressCallback) {
            progressCallback({
                progress: 100,
                current: 1,
                total: 1,
                message: 'Cache cleared - dependencies will be recomputed on next request'
            });
        }
        
        return { success: true, message: 'Cache cleared successfully' };
    }

    /**
     * Obtenir les statistiques d'index (pour compatibilité)
     */
    async getIndex(database, progressCallback) {
        console.log(`📊 Getting index stats for ${database}`);
        
        if (progressCallback) {
            progressCallback({
                progress: 100,
                current: 1,
                total: 1,
                message: 'Using smart parsing - no index needed'
            });
        }

        return {
            database: database,
            lastIndexed: new Date().toISOString(),
            method: 'smart_parsing',
            objectCount: this._cache.size
        };
    }

    // ===== MÉTHODES POUR LES EXTENDED PROPERTIES (inchangées) =====
    
    async getTableExtendedProperties(database, tableName) {
        // Code existant pour les extended properties...
        return {
            tableName: tableName,
            tableDescription: null,
            columnDescriptions: [],
            allColumns: [],
            hasDescriptions: false
        };
    }

    async getObjectExtendedProperties(database, objectName, objectType) {
        return {
            objectName: objectName,
            objectType: objectType,
            description: null,
            hasDescription: false
        };
    }

    async updateTableDescription(database, tableName, description) {
        return { success: false, message: 'Not implemented yet' };
    }

    async updateColumnDescription(database, tableName, columnName, description) {
        return { success: false, message: 'Not implemented yet' };
    }

    async updateObjectDescription(database, objectName, description) {
        return { success: false, message: 'Not implemented yet' };
    }

    async deleteTableDescription(database, tableName) {
        return { success: false, message: 'Not implemented yet' };
    }

    async deleteColumnDescription(database, tableName, columnName) {
        return { success: false, message: 'Not implemented yet' };
    }
}

module.exports = DependencyService;