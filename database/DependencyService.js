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

   // ===== MÉTHODES POUR LES EXTENDED PROPERTIES (Comments) =====
   
   /**
    * Get table extended properties with schema support
    */
   async getTableExtendedProperties(database, tableName) {
       try {
           if (!this._connectionManager.isConnected()) {
               throw new Error('No active connection');
           }

           console.log(`Getting extended properties for table: ${tableName}`);

           // Parse table name to handle schema
           const { schema, objectName } = this._parseObjectName(tableName);
           const qualifiedTableName = `${schema}.${objectName}`;

           // Get table description
           const tableDescResult = await this._connectionManager.executeQuery(`
               USE [${database}];
               SELECT 
                   ep.value as table_description
               FROM sys.extended_properties ep
               INNER JOIN sys.objects o ON ep.major_id = o.object_id
               INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
               WHERE ep.class = 1 
               AND ep.minor_id = 0 
               AND ep.name = 'MS_Description'
               AND s.name = '${schema}'
               AND o.name = '${objectName}'
           `);

           const tableDescription = tableDescResult.recordset.length > 0 ? 
               tableDescResult.recordset[0].table_description : null;

           // Get all columns with their descriptions
           const columnsResult = await this._connectionManager.executeQuery(`
               USE [${database}];
               SELECT 
                   c.COLUMN_NAME as columnName,
                   c.DATA_TYPE as dataType,
                   c.IS_NULLABLE as isNullable,
                   c.CHARACTER_MAXIMUM_LENGTH as maxLength,
                   c.ORDINAL_POSITION as ordinalPosition,
                   ep.value as description,
                   CASE WHEN ep.value IS NOT NULL THEN 1 ELSE 0 END as hasDescription
               FROM INFORMATION_SCHEMA.COLUMNS c
               LEFT JOIN sys.extended_properties ep ON ep.major_id = OBJECT_ID('${qualifiedTableName}')
                   AND ep.minor_id = c.ORDINAL_POSITION
                   AND ep.class = 1
                   AND ep.name = 'MS_Description'
               WHERE c.TABLE_SCHEMA = '${schema}' 
               AND c.TABLE_NAME = '${objectName}'
               ORDER BY c.ORDINAL_POSITION
           `);

           // Get column descriptions separately for better mapping
           const columnDescriptions = [];
           columnsResult.recordset.forEach(column => {
               columnDescriptions.push({
                   columnName: column.columnName,
                   dataType: column.dataType,
                   isNullable: column.isNullable === 'YES',
                   maxLength: column.maxLength,
                   ordinalPosition: column.ordinalPosition,
                   description: column.description,
                   hasDescription: column.hasDescription === 1
               });
           });

           const result = {
               tableName: tableName,
               qualifiedName: qualifiedTableName,
               schema: schema,
               objectName: objectName,
               tableDescription: tableDescription,
               columnDescriptions: columnDescriptions,
               allColumns: columnDescriptions, // For compatibility
               hasDescriptions: tableDescription !== null || columnDescriptions.some(c => c.hasDescription)
           };

           console.log(`Extended properties result:`, result);
           return result;

       } catch (error) {
           console.error(`Error getting table extended properties for ${tableName}:`, error);
           return {
               tableName: tableName,
               tableDescription: null,
               columnDescriptions: [],
               allColumns: [],
               hasDescriptions: false
           };
       }
   }

   /**
    * Get object extended properties with schema support
    */
   async getObjectExtendedProperties(database, objectName, objectType) {
       try {
           if (!this._connectionManager.isConnected()) {
               throw new Error('No active connection');
           }

           console.log(`Getting extended properties for ${objectType}: ${objectName}`);

           // Parse object name to handle schema
           const { schema, objectName: parsedObjectName } = this._parseObjectName(objectName);
           const qualifiedObjectName = `${schema}.${parsedObjectName}`;

           // Get object description
           const descResult = await this._connectionManager.executeQuery(`
               USE [${database}];
               SELECT 
                   ep.value as description
               FROM sys.extended_properties ep
               INNER JOIN sys.objects o ON ep.major_id = o.object_id
               INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
               WHERE ep.class = 1 
               AND ep.minor_id = 0 
               AND ep.name = 'MS_Description'
               AND s.name = '${schema}'
               AND o.name = '${parsedObjectName}'
           `);

           const description = descResult.recordset.length > 0 ? 
               descResult.recordset[0].description : null;

           return {
               objectName: objectName,
               objectType: objectType,
               description: description,
               hasDescription: description !== null
           };

       } catch (error) {
           console.error(`Error getting object extended properties for ${objectName}:`, error);
           return {
               objectName: objectName,
               objectType: objectType,
               description: null,
               hasDescription: false
           };
       }
   }

   /**
    * Update table description with schema support
    */
   async updateTableDescription(database, tableName, description) {
       try {
           if (!this._connectionManager.isConnected()) {
               throw new Error('No active connection');
           }

           const { schema, objectName } = this._parseObjectName(tableName);
           const qualifiedTableName = `${schema}.${objectName}`;

           if (description && description.trim() !== '') {
               // Add or update description
               const sql = `
                   USE [${database}];
                   IF EXISTS (
                       SELECT 1 FROM sys.extended_properties ep
                       INNER JOIN sys.objects o ON ep.major_id = o.object_id
                       INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                       WHERE ep.class = 1 AND ep.minor_id = 0 AND ep.name = 'MS_Description'
                       AND s.name = '${schema}' AND o.name = '${objectName}'
                   )
                   BEGIN
                       EXEC sys.sp_updateextendedproperty 
                           @name = N'MS_Description',
                           @value = N'${description.replace(/'/g, "''")}',
                           @level0type = N'SCHEMA', @level0name = N'${schema}',
                           @level1type = N'TABLE', @level1name = N'${objectName}';
                   END
                   ELSE
                   BEGIN
                       EXEC sys.sp_addextendedproperty 
                           @name = N'MS_Description',
                           @value = N'${description.replace(/'/g, "''")}',
                           @level0type = N'SCHEMA', @level0name = N'${schema}',
                           @level1type = N'TABLE', @level1name = N'${objectName}';
                   END
               `;
               
               await this._connectionManager.executeQuery(sql);
           } else {
               // Delete description
               const sql = `
                   USE [${database}];
                   IF EXISTS (
                       SELECT 1 FROM sys.extended_properties ep
                       INNER JOIN sys.objects o ON ep.major_id = o.object_id
                       INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                       WHERE ep.class = 1 AND ep.minor_id = 0 AND ep.name = 'MS_Description'
                       AND s.name = '${schema}' AND o.name = '${objectName}'
                   )
                   BEGIN
                       EXEC sys.sp_dropextendedproperty 
                           @name = N'MS_Description',
                           @level0type = N'SCHEMA', @level0name = N'${schema}',
                           @level1type = N'TABLE', @level1name = N'${objectName}';
                   END
               `;
               
               await this._connectionManager.executeQuery(sql);
           }

           return {
               success: true,
               message: 'Table description updated successfully'
           };

       } catch (error) {
           console.error(`Error updating table description for ${tableName}:`, error);
           return {
               success: false,
               message: `Failed to update table description: ${error.message}`
           };
       }
   }

   /**
    * Update column description with schema support
    */
   async updateColumnDescription(database, tableName, columnName, description) {
       try {
           if (!this._connectionManager.isConnected()) {
               throw new Error('No active connection');
           }

           const { schema, objectName } = this._parseObjectName(tableName);

           if (description && description.trim() !== '') {
               // Add or update description
               const sql = `
                   USE [${database}];
                   IF EXISTS (
                       SELECT 1 FROM sys.extended_properties ep
                       INNER JOIN sys.objects o ON ep.major_id = o.object_id
                       INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                       INNER JOIN sys.columns c ON ep.major_id = c.object_id AND ep.minor_id = c.column_id
                       WHERE ep.class = 1 AND ep.name = 'MS_Description'
                       AND s.name = '${schema}' AND o.name = '${objectName}' AND c.name = '${columnName}'
                   )
                   BEGIN
                       EXEC sys.sp_updateextendedproperty 
                           @name = N'MS_Description',
                           @value = N'${description.replace(/'/g, "''")}',
                           @level0type = N'SCHEMA', @level0name = N'${schema}',
                           @level1type = N'TABLE', @level1name = N'${objectName}',
                           @level2type = N'COLUMN', @level2name = N'${columnName}';
                   END
                   ELSE
                   BEGIN
                       EXEC sys.sp_addextendedproperty 
                           @name = N'MS_Description',
                           @value = N'${description.replace(/'/g, "''")}',
                           @level0type = N'SCHEMA', @level0name = N'${schema}',
                           @level1type = N'TABLE', @level1name = N'${objectName}',
                           @level2type = N'COLUMN', @level2name = N'${columnName}';
                   END
               `;
               
               await this._connectionManager.executeQuery(sql);
           } else {
               // Delete description
               const sql = `
                   USE [${database}];
                   IF EXISTS (
                       SELECT 1 FROM sys.extended_properties ep
                       INNER JOIN sys.objects o ON ep.major_id = o.object_id
                       INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                       INNER JOIN sys.columns c ON ep.major_id = c.object_id AND ep.minor_id = c.column_id
                       WHERE ep.class = 1 AND ep.name = 'MS_Description'
                       AND s.name = '${schema}' AND o.name = '${objectName}' AND c.name = '${columnName}'
                   )
                   BEGIN
                       EXEC sys.sp_dropextendedproperty 
                           @name = N'MS_Description',
                           @level0type = N'SCHEMA', @level0name = N'${schema}',
                           @level1type = N'TABLE', @level1name = N'${objectName}',
                           @level2type = N'COLUMN', @level2name = N'${columnName}';
                   END
               `;
               
               await this._connectionManager.executeQuery(sql);
           }

           return {
               success: true,
               message: 'Column description updated successfully'
           };

       } catch (error) {
           console.error(`Error updating column description for ${tableName}.${columnName}:`, error);
           return {
               success: false,
               message: `Failed to update column description: ${error.message}`
           };
       }
   }

   /**
    * Update object description with schema support
    */
   async updateObjectDescription(database, objectName, description) {
       try {
           if (!this._connectionManager.isConnected()) {
               throw new Error('No active connection');
           }

           const { schema, objectName: parsedObjectName } = this._parseObjectName(objectName);

           // Get object type for proper stored procedure call
           const objectInfo = await this._databaseService.getObjectInfo(database, objectName);
           if (!objectInfo) {
               throw new Error(`Object ${objectName} not found`);
           }

           let level1Type = 'TABLE';
           switch (objectInfo.object_type) {
               case 'View':
                   level1Type = 'VIEW';
                   break;
               case 'Procedure':
                   level1Type = 'PROCEDURE';
                   break;
               case 'Function':
                   level1Type = 'FUNCTION';
                   break;
               default:
                   level1Type = 'TABLE';
           }

           if (description && description.trim() !== '') {
               // Add or update description
               const sql = `
                   USE [${database}];
                   IF EXISTS (
                       SELECT 1 FROM sys.extended_properties ep
                       INNER JOIN sys.objects o ON ep.major_id = o.object_id
                       INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                       WHERE ep.class = 1 AND ep.minor_id = 0 AND ep.name = 'MS_Description'
                       AND s.name = '${schema}' AND o.name = '${parsedObjectName}'
                   )
                   BEGIN
                       EXEC sys.sp_updateextendedproperty 
                           @name = N'MS_Description',
                           @value = N'${description.replace(/'/g, "''")}',
                           @level0type = N'SCHEMA', @level0name = N'${schema}',
                           @level1type = N'${level1Type}', @level1name = N'${parsedObjectName}';
                   END
                   ELSE
                   BEGIN
                       EXEC sys.sp_addextendedproperty 
                           @name = N'MS_Description',
                           @value = N'${description.replace(/'/g, "''")}',
                           @level0type = N'SCHEMA', @level0name = N'${schema}',
                           @level1type = N'${level1Type}', @level1name = N'${parsedObjectName}';
                   END
               `;
               
               await this._connectionManager.executeQuery(sql);
           } else {
               // Delete description
               const sql = `
                   USE [${database}];
                   IF EXISTS (
                       SELECT 1 FROM sys.extended_properties ep
                       INNER JOIN sys.objects o ON ep.major_id = o.object_id
                       INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                       WHERE ep.class = 1 AND ep.minor_id = 0 AND ep.name = 'MS_Description'
                       AND s.name = '${schema}' AND o.name = '${parsedObjectName}'
                   )
                   BEGIN
                       EXEC sys.sp_dropextendedproperty 
                           @name = N'MS_Description',
                           @level0type = N'SCHEMA', @level0name = N'${schema}',
                           @level1type = N'${level1Type}', @level1name = N'${parsedObjectName}';
                   END
               `;
               
               await this._connectionManager.executeQuery(sql);
           }

           return {
               success: true,
               message: 'Object description updated successfully'
           };

       } catch (error) {
           console.error(`Error updating object description for ${objectName}:`, error);
           return {
               success: false,
               message: `Failed to update object description: ${error.message}`
           };
       }
   }

   async deleteTableDescription(database, tableName) {
       return await this.updateTableDescription(database, tableName, '');
   }

   async deleteColumnDescription(database, tableName, columnName) {
       return await this.updateColumnDescription(database, tableName, columnName, '');
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
}

module.exports = DependencyService;