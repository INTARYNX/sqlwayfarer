/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

/**
 * Smart SQL Parser - Nouvelle approche de détection des dépendances
 * 
 * Principe : 
 * 1. Obtenir la liste de toutes les tables
 * 2. Parser le code SQL pour trouver les tables
 * 3. Chercher vers l'avant pour trouver l'opération (SELECT/UPDATE/DELETE/INSERT)
 * 4. Associer l'opération à la dernière table trouvée
 */
class SmartSqlParser {
    constructor(connectionManager, databaseService) {
        this._connectionManager = connectionManager;
        this._databaseService = databaseService;
        this._tablesCache = new Map(); // Cache des tables par database
    }

    /**
     * Analyser les dépendances d'un objet avec la nouvelle méthode
     */
    async analyzeDependencies(database, objectName) {
        console.log(`🔍 Analyzing dependencies for ${objectName} using smart parsing`);
        
        try {
            // 1. Obtenir la liste des tables
            const tables = await this._getTablesForDatabase(database);
            
            // 2. Obtenir le code SQL de l'objet
            const sqlCode = await this._getObjectDefinition(database, objectName);
            if (!sqlCode) {
                return { dependsOn: [], referencedBy: [] };
            }

            // 3. Parser le code avec la nouvelle méthode
            const tableUsages = this._parseTableUsages(sqlCode, tables);
            
            // 4. Convertir au format attendu
            const dependsOn = tableUsages.map(usage => ({
                referenced_object: usage.tableName,
                referenced_object_type: 'Table',
                dependency_type: usage.operations.join(', '),
                operations: usage.operations,
                is_selected: usage.operations.includes('SELECT') ? 1 : 0,
                is_updated: usage.operations.includes('UPDATE') ? 1 : 0,
                is_insert_all: usage.operations.includes('INSERT') ? 1 : 0,
                is_delete: usage.operations.includes('DELETE') ? 1 : 0
            }));

            console.log(`📊 Found ${dependsOn.length} table dependencies`);
            return { dependsOn, referencedBy: [] }; // referencedBy sera calculé séparément
            
        } catch (error) {
            console.error(`❌ Error analyzing dependencies for ${objectName}:`, error);
            return { dependsOn: [], referencedBy: [] };
        }
    }

    /**
     * Parser le code SQL pour détecter les usages de tables
     */
    _parseTableUsages(sqlCode, tables) {
        const tableUsages = new Map();
        
        // Nettoyer le code SQL
        const cleanedCode = this._cleanSqlCode(sqlCode);
        
        // Créer un set des noms de tables pour une recherche rapide
        const tableNames = new Set(tables.map(t => t.name.toUpperCase()));
        
        // Tokenizer simple mais efficace
        const tokens = this._tokenizeSql(cleanedCode);
        
        // Parser les tokens pour trouver les patterns table → opération
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            
            // Vérifier si ce token est un nom de table
            if (this._isTableName(token, tableNames)) {
                // Chercher vers l'avant pour trouver l'opération
                const operation = this._findForwardOperation(tokens, i);
                
                if (operation) {
                    const tableName = token.toUpperCase();
                    
                    if (!tableUsages.has(tableName)) {
                        tableUsages.set(tableName, {
                            tableName: tableName,
                            operations: new Set()
                        });
                    }
                    
                    tableUsages.get(tableName).operations.add(operation);
                    
                    console.log(`🎯 Found: ${tableName} → ${operation}`);
                }
            }
        }
        
        // Convertir en format final
        return Array.from(tableUsages.values()).map(usage => ({
            tableName: usage.tableName,
            operations: Array.from(usage.operations)
        }));
    }

    /**
     * Nettoyer le code SQL (supprimer commentaires, strings, etc.)
     */
    _cleanSqlCode(sqlCode) {
        if (!sqlCode) return '';
        
        let cleaned = sqlCode;
        
        // Supprimer les commentaires sur une ligne (-- comment)
        cleaned = cleaned.replace(/--.*$/gm, '');
        
        // Supprimer les commentaires multi-lignes (/* comment */)
        cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
        
        // Supprimer les chaînes de caractères entre quotes simples
        cleaned = cleaned.replace(/'(?:[^'\\]|\\.)*'/g, "''");
        
        // Supprimer les chaînes de caractères entre quotes doubles  
        cleaned = cleaned.replace(/"(?:[^"\\]|\\.)*"/g, '""');
        
        // Normaliser les espaces et retours à la ligne
        cleaned = cleaned.replace(/\s+/g, ' ').trim();
        
        return cleaned.toUpperCase();
    }

    /**
     * Tokenizer SQL simple mais efficace
     */
    _tokenizeSql(sqlCode) {
        // Séparer par espaces, virgules, parenthèses, etc.
        const tokens = sqlCode.split(/[\s,\(\)\[\];=<>!+\-\*\/]+/)
            .filter(token => token.length > 0)
            .map(token => token.trim())
            .filter(token => token.length > 0);
        
        return tokens;
    }

    /**
     * Vérifier si un token est un nom de table
     */
    _isTableName(token, tableNames) {
        if (!token || token.length < 2) return false;
        
        // Nettoyer le token (supprimer les brackets, etc.)
        const cleanToken = token.replace(/[\[\]]/g, '');
        
        return tableNames.has(cleanToken.toUpperCase());
    }

    /**
     * Chercher vers l'avant pour trouver l'opération SQL
     */
    _findForwardOperation(tokens, startIndex) {
        // Opérations SQL principales
        const operations = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'FROM', 'JOIN'];
        
        // Chercher dans les 20 prochains tokens (pour éviter les boucles infinies)
        const searchLimit = Math.min(startIndex + 20, tokens.length);
        
        for (let i = startIndex + 1; i < searchLimit; i++) {
            const token = tokens[i];
            
            // Si on trouve une opération, la retourner
            if (operations.includes(token)) {
                return this._mapToMainOperation(token);
            }
            
            // Si on trouve un autre nom de table, arrêter la recherche
            // (l'opération s'applique probablement à cette nouvelle table)
            if (this._isLikelyTableOrColumn(token)) {
                break;
            }
        }
        
        // Chercher vers l'arrière aussi (pour les cas comme "UPDATE table SET...")
        for (let i = startIndex - 1; i >= Math.max(0, startIndex - 10); i--) {
            const token = tokens[i];
            
            if (operations.includes(token)) {
                return this._mapToMainOperation(token);
            }
        }
        
        return null;
    }

    /**
     * Mapper les opérations aux types principaux
     */
    _mapToMainOperation(operation) {
        switch (operation) {
            case 'SELECT':
            case 'FROM':
                return 'SELECT';
            case 'INSERT':
                return 'INSERT';
            case 'UPDATE':
                return 'UPDATE';
            case 'DELETE':
                return 'DELETE';
            case 'JOIN':
                return 'SELECT'; // JOIN implique généralement SELECT
            default:
                return 'REFERENCE';
        }
    }

    /**
     * Vérifier si un token ressemble à un nom de table/colonne
     */
    _isLikelyTableOrColumn(token) {
        // Exclure les mots-clés SQL communs
        const sqlKeywords = [
            'WHERE', 'AND', 'OR', 'ON', 'AS', 'IS', 'NULL', 'NOT', 'IN', 'EXISTS',
            'ORDER', 'BY', 'GROUP', 'HAVING', 'SET', 'VALUES', 'INTO', 'FROM'
        ];
        
        return !sqlKeywords.includes(token) && 
               /^[A-Z][A-Z0-9_]*$/.test(token) && 
               token.length > 1;
    }

    /**
     * Obtenir la liste des tables pour une base de données (avec cache)
     */
    async _getTablesForDatabase(database) {
        if (this._tablesCache.has(database)) {
            return this._tablesCache.get(database);
        }
        
        try {
            const objects = await this._databaseService.getObjects(database);
            const tables = objects.filter(obj => obj.object_type === 'Table');
            
            this._tablesCache.set(database, tables);
            return tables;
            
        } catch (error) {
            console.error(`Error getting tables for ${database}:`, error);
            return [];
        }
    }

    /**
     * Obtenir la définition d'un objet
     */
    async _getObjectDefinition(database, objectName) {
        try {
            // Pour les tables, pas de définition
            const objectInfo = await this._databaseService.getObjectInfo(database, objectName);
            if (!objectInfo || objectInfo.object_type === 'Table') {
                return null;
            }
            
            return await this._databaseService.getObjectDefinition(database, objectName);
            
        } catch (error) {
            console.error(`Error getting definition for ${objectName}:`, error);
            return null;
        }
    }

    /**
     * Nettoyer le cache (à appeler quand la structure de la DB change)
     */
    clearCache(database = null) {
        if (database) {
            this._tablesCache.delete(database);
        } else {
            this._tablesCache.clear();
        }
    }

    /**
     * Analyser l'utilisation des tables par un objet (version complète)
     */
    async getTableUsageAnalysis(database, objectName) {
        const dependencies = await this.analyzeDependencies(database, objectName);
        
        return {
            objectName: objectName,
            tablesUsed: dependencies.dependsOn,
            relatedObjects: [], // Sera implémenté séparément
            summary: this._generateSummary(dependencies.dependsOn)
        };
    }

    /**
     * Générer un résumé des usages
     */
    _generateSummary(tablesUsed) {
        const summary = {
            totalTables: tablesUsed.length,
            readTables: tablesUsed.filter(t => t.is_selected).length,
            writeTables: tablesUsed.filter(t => t.is_updated || t.is_insert_all || t.is_delete).length,
            operationCounts: {}
        };

        tablesUsed.forEach(table => {
            table.operations.forEach(op => {
                summary.operationCounts[op] = (summary.operationCounts[op] || 0) + 1;
            });
        });

        return summary;
    }
}

module.exports = SmartSqlParser;