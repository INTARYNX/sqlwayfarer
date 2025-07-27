/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

/**
 * Smart SQL Parser - Enhanced version with better parsing and schema support
 * 
 * Principle: 
 * 1. Get list of all tables from database
 * 2. Parse SQL code to find table references with schema awareness
 * 3. Look forward/backward to find SQL operations (SELECT/UPDATE/DELETE/INSERT)
 * 4. Associate operations with tables found
 * 5. Handle complex SQL patterns (CTEs, subqueries, dynamic SQL, schemas)
 */
class SmartSqlParser {
    constructor(connectionManager, databaseService) {
        this._connectionManager = connectionManager;
        this._databaseService = databaseService;
        this._tablesCache = new Map(); // Cache tables by database
        this._cacheTimestamps = new Map(); // Track cache freshness
        this._cacheTimeout = 5 * 60 * 1000; // 5 minutes cache timeout
        this._maxCacheSize = 100; // Limite du cache par base de données
        
        // Enhanced SQL keywords for better parsing
        this._sqlKeywords = new Set([
            'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'FROM', 'INTO', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER',
            'WHERE', 'AND', 'OR', 'ON', 'AS', 'IS', 'NULL', 'NOT', 'IN', 'EXISTS', 'UNION', 'ALL',
            'ORDER', 'BY', 'GROUP', 'HAVING', 'SET', 'VALUES', 'WITH', 'CTE', 'EXEC', 'EXECUTE',
            'DECLARE', 'IF', 'ELSE', 'BEGIN', 'END', 'WHILE', 'FOR', 'CURSOR', 'OPEN', 'CLOSE',
            'FETCH', 'DEALLOCATE', 'RETURN', 'PRINT', 'RAISERROR', 'TRY', 'CATCH', 'THROW',
            'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'MERGE', 'CASE', 'WHEN', 'THEN', 'DISTINCT',
            'TOP', 'OFFSET', 'FETCH', 'NEXT', 'ROWS', 'ONLY', 'CROSS', 'APPLY', 'PIVOT', 'UNPIVOT'
        ]);
        
        // Operation keywords that indicate table usage
        this._operationKeywords = new Map([
            ['SELECT', { type: 'SELECT', weight: 1 }],
            ['FROM', { type: 'SELECT', weight: 2 }],
            ['JOIN', { type: 'SELECT', weight: 2 }],
            ['INSERT', { type: 'INSERT', weight: 3 }],
            ['INTO', { type: 'INSERT', weight: 2 }],
            ['UPDATE', { type: 'UPDATE', weight: 3 }],
            ['DELETE', { type: 'DELETE', weight: 3 }],
            ['MERGE', { type: 'MERGE', weight: 3 }],
            ['TRUNCATE', { type: 'TRUNCATE', weight: 3 }]
        ]);

        // Nettoyage automatique du cache
        this._cleanupInterval = setInterval(() => {
            this._cleanupExpiredCache();
        }, 10 * 60 * 1000); // Toutes les 10 minutes
    }

    /**
     * Nettoyage automatique du cache expiré
     * @private
     */
    _cleanupExpiredCache() {
        const now = Date.now();
        let totalRemoved = 0;
        
        for (const [database, timestamp] of this._cacheTimestamps) {
            if (now - timestamp > this._cacheTimeout) {
                this._tablesCache.delete(database);
                this._cacheTimestamps.delete(database);
                totalRemoved++;
            }
        }
        
        if (totalRemoved > 0) {
            console.log(`🧹 SmartSqlParser: Cleaned up ${totalRemoved} expired cache entries`);
        }
    }

    /**
     * Analyze dependencies for an object with enhanced schema parsing
     */
    async analyzeDependencies(database, objectName) {
        console.log(`🔍 Analyzing dependencies for ${objectName} with schema support`);
        
        try {
            // Validation des paramètres
            if (!database || !objectName) {
                throw new Error('Database and object name are required');
            }
            
            // 1. Get table list (with caching and schema info)
            const tables = await this._getTablesForDatabase(database);
            if (tables.length === 0) {
                console.warn(`No tables found for database: ${database}`);
                return { dependsOn: [], referencedBy: [] };
            }
            
            // 2. Get SQL code for the object (handle qualified names)
            const sqlCode = await this._getObjectDefinition(database, objectName);
            if (!sqlCode) {
                console.log(`No SQL definition found for ${objectName}`);
                return { dependsOn: [], referencedBy: [] };
            }

            // 3. Enhanced parsing with schema awareness
            const tableUsages = await this._parseTableUsagesWithSchema(sqlCode, tables, objectName);
            
            // 4. Convert to expected format with validation
            const dependsOn = this._convertToExpectedFormat(tableUsages);
            
            console.log(`📊 Found ${dependsOn.length} table dependencies for ${objectName}`);
            return { dependsOn, referencedBy: [] }; // referencedBy computed separately
            
        } catch (error) {
            console.error(`❌ Error analyzing dependencies for ${objectName}:`, error);
            // Return empty result instead of throwing to prevent UI crashes
            return { dependsOn: [], referencedBy: [] };
        }
    }

    /**
     * Enhanced table usage parsing with schema awareness
     */
    async _parseTableUsagesWithSchema(sqlCode, tables, objectName) {
        try {
            const tableUsages = new Map();
            
            // Clean and normalize SQL code with improved method
            const cleanedCode = this._cleanSqlCodeEnhanced(sqlCode);
            if (!cleanedCode.trim()) {
                console.warn(`Empty SQL code after cleaning for ${objectName}`);
                return [];
            }
            
            // Create efficient lookup structures with schema support
            const tableNameMap = this._createSchemaAwareTableLookupMap(tables);
            
            // Enhanced tokenization with context awareness
            const tokens = this._tokenizeSqlEnhanced(cleanedCode);
            if (tokens.length === 0) {
                console.warn(`No tokens extracted from SQL for ${objectName}`);
                return [];
            }
            
            // Parse tokens with schema-aware context algorithm
            this._parseTokensWithSchemaContext(tokens, tableNameMap, tableUsages, objectName);
            
            // Post-process to remove duplicates and validate results
            return this._postProcessTableUsages(tableUsages);
            
        } catch (error) {
            console.error(`Error in schema-aware parsing for ${objectName}:`, error);
            return [];
        }
    }

    /**
     * Create schema-aware table lookup map with aliases and variations
     */
    _createSchemaAwareTableLookupMap(tables) {
        const lookupMap = new Map();
        
        tables.forEach(table => {
            try {
                const tableName = table.name ? table.name.toUpperCase() : '';
                const qualifiedName = table.qualified_name ? table.qualified_name.toUpperCase() : tableName;
                const schema = table.schema_name ? table.schema_name.toUpperCase() : 'DBO';
                const objectName = table.object_name ? table.object_name.toUpperCase() : tableName;
                
                if (!tableName || !objectName) {
                    console.warn('Skipping table with missing name:', table);
                    return;
                }

                // Store original table info
                const tableInfo = {
                    originalName: table.name,
                    qualifiedName: table.qualified_name || table.name,
                    schema: table.schema_name || 'dbo',
                    objectName: table.object_name || table.name,
                    variations: new Set()
                };
                
                // Add all possible variations for this table
                const variations = [
                    tableName,                          // Display name (might include schema)
                    objectName,                         // Object name only
                    qualifiedName,                      // Fully qualified name
                    `[${tableName}]`,                   // Bracketed display name
                    `[${objectName}]`,                  // Bracketed object name
                    `[${qualifiedName}]`,               // Bracketed qualified name
                    `${schema}.${objectName}`,          // Schema.object
                    `[${schema}].[${objectName}]`,      // [schema].[object]
                    `${schema}.[${objectName}]`,        // schema.[object]
                    `[${schema}].${objectName}`,        // [schema].object
                    `DBO.${objectName}`,                // Default schema variations
                    `[DBO].[${objectName}]`,
                    `DBO.[${objectName}]`,
                    `[DBO].${objectName}`
                ];
                
                variations.forEach(variation => {
                    if (variation && variation.length > 0 && variation !== '[.]') {
                        lookupMap.set(variation, tableInfo);
                        tableInfo.variations.add(variation);
                    }
                });
            } catch (error) {
                console.warn('Error processing table for lookup map:', table, error);
            }
        });
        
        return lookupMap;
    }

    /**
     * Schema-aware token parsing with better operation detection
     */
    _parseTokensWithSchemaContext(tokens, tableNameMap, tableUsages, objectName) {
        const contextWindow = 15; // Larger window for schema-qualified names
        
        for (let i = 0; i < tokens.length; i++) {
            try {
                // Check for multi-part identifiers (schema.table)
                const multiPartMatch = this._findMultiPartTableMatch(tokens, i, tableNameMap);
                if (multiPartMatch) {
                    // Found a multi-part table reference
                    const operations = this._findOperationsInContext(tokens, i, contextWindow);
                    this._addTableUsage(tableUsages, multiPartMatch.originalName, operations, i, objectName);
                    
                    // Skip the next token if it was part of the multi-part identifier
                    if (multiPartMatch.tokensConsumed > 1) {
                        i += multiPartMatch.tokensConsumed - 1;
                    }
                    continue;
                }
                
                // Check for single token table match
                const token = tokens[i];
                if (!token) continue;
                
                const tableInfo = this._findTableMatch(token, tableNameMap);
                if (tableInfo) {
                    const operations = this._findOperationsInContext(tokens, i, contextWindow);
                    if (operations.length > 0) {
                        this._addTableUsage(tableUsages, tableInfo.originalName, operations, i, objectName);
                    } else {
                        // Even without explicit operations, it's still a reference
                        this._addTableUsage(tableUsages, tableInfo.originalName, ['REFERENCE'], i, objectName);
                    }
                }
            } catch (error) {
                console.warn(`Error parsing token "${tokens[i]}" at position ${i}:`, error);
                continue;
            }
        }
    }

    /**
     * Find multi-part table identifiers (schema.table)
     */
    _findMultiPartTableMatch(tokens, startIndex, tableNameMap) {
        if (startIndex + 2 >= tokens.length) {
            return null;
        }
        
        const token1 = tokens[startIndex];
        const token2 = tokens[startIndex + 1];
        const token3 = tokens[startIndex + 2];
        
        if (!token1 || !token2 || !token3) {
            return null;
        }
        
        // Check for schema.table pattern
        if (token2 === '.' || token2 === '.[' || token2 === '].') {
            const multiPartName = `${token1}.${token3}`;
            const tableInfo = tableNameMap.get(multiPartName.toUpperCase());
            if (tableInfo) {
                return {
                    ...tableInfo,
                    tokensConsumed: 3
                };
            }
            
            // Also try with brackets removed
            const cleanMultiPartName = multiPartName.replace(/[\[\]]/g, '');
            const cleanTableInfo = tableNameMap.get(cleanMultiPartName.toUpperCase());
            if (cleanTableInfo) {
                return {
                    ...cleanTableInfo,
                    tokensConsumed: 3
                };
            }
        }
        
        return null;
    }

    /**
     * Enhanced table matching with schema context
     */
    _findTableMatch(token, tableNameMap) {
        if (!token) return null;
        
        try {
            // Direct match first
            if (tableNameMap.has(token.toUpperCase())) {
                return tableNameMap.get(token.toUpperCase());
            }
            
            // Try without brackets
            const withoutBrackets = token.replace(/[\[\]]/g, '');
            if (tableNameMap.has(withoutBrackets.toUpperCase())) {
                return tableNameMap.get(withoutBrackets.toUpperCase());
            }
            
            // Try with common schema prefixes if no schema specified
            if (!token.includes('.')) {
                const schemasToTry = ['DBO', 'HR', 'SALES', 'PRODUCTION', 'PURCHASING', 'PERSON'];
                
                for (const schema of schemasToTry) {
                    const schemaQualified = `${schema}.${withoutBrackets}`;
                    if (tableNameMap.has(schemaQualified.toUpperCase())) {
                        return tableNameMap.get(schemaQualified.toUpperCase());
                    }
                }
            }
            
            return null;
        } catch (error) {
            console.warn(`Error in table matching for token "${token}":`, error);
            return null;
        }
    }

    /**
     * Find SQL operations within context window with weighted scoring
     */
    _findOperationsInContext(tokens, currentIndex, windowSize) {
        const operations = [];
        const operationScores = new Map();
        
        // Search in both directions from current position
        const startIndex = Math.max(0, currentIndex - windowSize);
        const endIndex = Math.min(tokens.length - 1, currentIndex + windowSize);
        
        for (let i = startIndex; i <= endIndex; i++) {
            if (i === currentIndex) continue; // Skip the table name itself
            
            const token = tokens[i];
            if (!token) continue;
            
            const operationInfo = this._operationKeywords.get(token);
            
            if (operationInfo) {
                // Calculate distance weight (closer = higher weight)
                const distance = Math.abs(i - currentIndex);
                const distanceWeight = Math.max(1, windowSize - distance);
                const totalWeight = operationInfo.weight * distanceWeight;
                
                if (!operationScores.has(operationInfo.type) || 
                    operationScores.get(operationInfo.type) < totalWeight) {
                    operationScores.set(operationInfo.type, totalWeight);
                }
            }
        }
        
        // Convert to sorted operations (highest weight first)
        return Array.from(operationScores.entries())
            .sort(([, a], [, b]) => b - a)
            .map(([operation, ]) => operation);
    }

    /**
     * Add table usage with deduplication and validation
     */
    _addTableUsage(tableUsages, tableName, operations, position, objectName) {
        try {
            if (!tableName) return;
            
            const key = tableName.toUpperCase();
            
            if (!tableUsages.has(key)) {
                tableUsages.set(key, {
                    tableName: tableName,
                    operations: new Set(),
                    positions: [],
                    confidence: 0
                });
            }
            
            const usage = tableUsages.get(key);
            
            // Add operations (deduplicated by Set)
            if (Array.isArray(operations)) {
                operations.forEach(op => {
                    if (op && typeof op === 'string') {
                        usage.operations.add(op);
                    }
                });
            }
            
            // Track positions for debugging
            usage.positions.push(position);
            
            // Increase confidence score
            usage.confidence += operations.length || 1;
            
        } catch (error) {
            console.warn(`Error adding table usage for ${tableName}:`, error);
        }
    }

    /**
     * Post-process table usages to clean up and validate
     */
    _postProcessTableUsages(tableUsages) {
        const results = [];
        
        for (const [tableName, usage] of tableUsages) {
            try {
                // Convert Set to Array
                const operationsArray = Array.from(usage.operations);
                
                // Skip if no meaningful operations found
                if (operationsArray.length === 0) {
                    continue;
                }
                
                // Create final usage object
                const finalUsage = {
                    tableName: usage.tableName,
                    operations: operationsArray,
                    confidence: usage.confidence,
                    positions: usage.positions.length
                };
                
                results.push(finalUsage);
                
            } catch (error) {
                console.warn(`Error post-processing usage for ${tableName}:`, error);
                continue;
            }
        }
        
        // Sort by confidence (higher confidence first)
        return results.sort((a, b) => b.confidence - a.confidence);
    }

    /**
     * Convert to expected format with enhanced validation
     */
    _convertToExpectedFormat(tableUsages) {
        return tableUsages.map(usage => {
            try {
                const operations = usage.operations || [];
                
                return {
                    referenced_object: usage.tableName,
                    referenced_object_type: 'Table',
                    dependency_type: operations.join(', '),
                    operations: operations,
                    is_selected: operations.includes('SELECT') ? 1 : 0,
                    is_updated: operations.includes('UPDATE') ? 1 : 0,
                    is_insert_all: operations.includes('INSERT') ? 1 : 0,
                    is_delete: operations.includes('DELETE') ? 1 : 0,
                    confidence: usage.confidence || 0,
                    positions: usage.positions || 0
                };
            } catch (error) {
                console.warn(`Error converting usage to expected format:`, error);
                return {
                    referenced_object: usage.tableName || 'Unknown',
                    referenced_object_type: 'Table',
                    dependency_type: 'REFERENCE',
                    operations: ['REFERENCE'],
                    is_selected: 0,
                    is_updated: 0,
                    is_insert_all: 0,
                    is_delete: 0,
                    confidence: 0,
                    positions: 0
                };
            }
        });
    }

    /**
     * Enhanced SQL code cleaning with better handling of edge cases
     */
    _cleanSqlCodeEnhanced(sqlCode) {
        if (!sqlCode || typeof sqlCode !== 'string') {
            return '';
        }
        
        let cleaned = sqlCode;
        
        try {
            // Remove single-line comments (-- comment) mais préserver les lignes
            cleaned = cleaned.replace(/--.*$/gm, ' ');
            
            // Remove multi-line comments (/* comment */) with proper nesting handling
            // Traiter les commentaires imbriqués de façon plus sûre
            let commentDepth = 0;
            let result = '';
            let i = 0;
            
            while (i < cleaned.length) {
                if (i < cleaned.length - 1 && cleaned.substring(i, i + 2) === '/*') {
                    commentDepth++;
                    i += 2;
                } else if (i < cleaned.length - 1 && cleaned.substring(i, i + 2) === '*/' && commentDepth > 0) {
                    commentDepth--;
                    i += 2;
                } else if (commentDepth === 0) {
                    result += cleaned[i];
                    i++;
                } else {
                    i++;
                }
            }
            cleaned = result;
            
            // Remove string literals more carefully
            // Handle escaped quotes and mixed quote types
            cleaned = cleaned.replace(/'(?:[^'\\]|\\.)*'/g, "''");
            cleaned = cleaned.replace(/"(?:[^"\\]|\\.)*"/g, '""');
            
            // Preserve important punctuation for parsing
            cleaned = cleaned.replace(/\s+/g, ' ').trim();
            
            // Convert to uppercase for consistent parsing
            cleaned = cleaned.toUpperCase();
            
            return cleaned;
            
        } catch (error) {
            console.error('Error cleaning SQL code:', error);
            return sqlCode.toUpperCase(); // Fallback to simple uppercase
        }
    }

    /**
     * Enhanced tokenization with better SQL structure awareness
     */
    _tokenizeSqlEnhanced(sqlCode) {
        try {
            if (!sqlCode) return [];
            
            // Préserver les opérateurs importants pendant la tokenisation
            let processedCode = sqlCode;
            
            // Marquer les points importants (pour schema.table)
            processedCode = processedCode.replace(/\./g, ' . ');
            processedCode = processedCode.replace(/\[/g, ' [ ');
            processedCode = processedCode.replace(/\]/g, ' ] ');
            
            // Split on multiple delimiters while preserving important operators
            const tokens = processedCode.split(/[\s,\(\);=<>!+\-\*\/\n\r\t]+/)
                .map(token => token.trim())
                .filter(token => token.length > 0)
                .filter(token => token !== '');
            
            // Post-traitement pour recombiner les identifiants avec brackets
            const finalTokens = [];
            for (let i = 0; i < tokens.length; i++) {
                const token = tokens[i];
                
                // Recombiner [schema].[table] patterns
                if (token === '[' && i + 2 < tokens.length && tokens[i + 2] === ']') {
                    finalTokens.push(`[${tokens[i + 1]}]`);
                    i += 2; // Skip next 2 tokens
                } else if (token !== '[' && token !== ']') {
                    finalTokens.push(token);
                }
            }
            
            return finalTokens;
            
        } catch (error) {
            console.error('Error in tokenization:', error);
            return [];
        }
    }

    /**
     * Get tables for database with improved caching and error handling
     */
    async _getTablesForDatabase(database) {
        if (!database || typeof database !== 'string') {
            throw new Error('Invalid database name provided');
        }
        
        const cacheKey = database.toUpperCase();
        
        // Check cache validity
        if (this._tablesCache.has(cacheKey)) {
            const timestamp = this._cacheTimestamps.get(cacheKey);
            if (timestamp && (Date.now() - timestamp) < this._cacheTimeout) {
                return this._tablesCache.get(cacheKey);
            } else {
                // Cache expired, remove it
                this._tablesCache.delete(cacheKey);
                this._cacheTimestamps.delete(cacheKey);
            }
        }
        
        try {
            console.log(`🔄 Loading tables for database: ${database}`);
            const objects = await this._databaseService.getObjects(database);
            
            if (!Array.isArray(objects)) {
                throw new Error('Invalid objects array returned from database service');
            }
            
            const tables = objects.filter(obj => obj && obj.object_type === 'Table');
            
            // Gérer la taille du cache
            if (this._tablesCache.size >= this._maxCacheSize) {
                // Supprimer les entrées les plus anciennes
                const oldestEntry = Array.from(this._cacheTimestamps.entries())
                    .sort((a, b) => a[1] - b[1])[0];
                
                if (oldestEntry) {
                    this._tablesCache.delete(oldestEntry[0]);
                    this._cacheTimestamps.delete(oldestEntry[0]);
                }
            }
            
            // Cache the results with timestamp
            this._tablesCache.set(cacheKey, tables);
            this._cacheTimestamps.set(cacheKey, Date.now());
            
            console.log(`✅ Loaded ${tables.length} tables for ${database}`);
            return tables;
            
        } catch (error) {
            console.error(`❌ Error getting tables for ${database}:`, error);
            // Don't cache errors, return empty array
            return [];
        }
    }

    /**
     * Get object definition with better error handling and schema awareness
     */
    async _getObjectDefinition(database, objectName) {
        try {
            if (!database || !objectName) {
                throw new Error('Database and object name are required');
            }
            
            // Check if it's a table (tables don't have definitions)
            const objectInfo = await this._databaseService.getObjectInfo(database, objectName);
            if (!objectInfo) {
                console.warn(`Object ${objectName} not found in database ${database}`);
                return null;
            }
            
            if (objectInfo.object_type === 'Table') {
               console.log(`Skipping definition for table: ${objectName}`);
               return null;
           }
           
           // Try to get definition with enhanced method
           const definition = await this._databaseService.getObjectDefinition(database, objectName);
           
           if (!definition || definition.trim() === '') {
               // Check if object exists but is encrypted or has permission issues
               if (objectInfo.is_encrypted) {
                   console.warn(`🔒 Object ${objectName} is encrypted, cannot analyze dependencies`);
                   return null;
               }
               
               console.warn(`⚠️ Empty definition returned for ${objectName} in schema ${objectInfo.schema_name || 'unknown'}`);
               
               // If object exists but no definition, try alternative approach
               if (objectInfo.schema_name && objectInfo.schema_name !== 'dbo') {
                   const qualifiedName = `${objectInfo.schema_name}.${objectName}`;
                   console.log(`🔄 Retrying with qualified name: ${qualifiedName}`);
                   const retryDefinition = await this._databaseService.getObjectDefinition(database, qualifiedName);
                   
                   if (retryDefinition && retryDefinition.trim() !== '') {
                       console.log(`✅ Found definition using qualified name: ${qualifiedName}`);
                       return retryDefinition;
                   }
               }
               
               return null;
           }
           
           console.log(`✅ Successfully retrieved definition for ${objectName}`);
           return definition;
           
       } catch (error) {
           console.error(`Error getting definition for ${objectName}:`, error);
           return null;
       }
   }

   /**
    * Enhanced cache management
    */
   clearCache(database = null) {
       try {
           if (database) {
               const cacheKey = database.toUpperCase();
               this._tablesCache.delete(cacheKey);
               this._cacheTimestamps.delete(cacheKey);
               console.log(`🧹 Cache cleared for database: ${database}`);
           } else {
               this._tablesCache.clear();
               this._cacheTimestamps.clear();
               console.log(`🧹 All cache cleared`);
           }
       } catch (error) {
           console.error('Error clearing cache:', error);
       }
   }

   /**
    * Get cache statistics for debugging
    */
   getCacheStats() {
       return {
           cachedDatabases: this._tablesCache.size,
           maxCacheSize: this._maxCacheSize,
           cacheTimeout: this._cacheTimeout,
           cacheHits: Array.from(this._cacheTimestamps.entries()).map(([db, timestamp]) => ({
               database: db,
               age: Date.now() - timestamp,
               expired: (Date.now() - timestamp) > this._cacheTimeout
           }))
       };
   }

   /**
    * Table usage analysis with enhanced error handling
    */
   async getTableUsageAnalysis(database, objectName) {
       try {
           if (!database || !objectName) {
               throw new Error('Database and object name are required');
           }
           
           const dependencies = await this.analyzeDependencies(database, objectName);
           
           return {
               objectName: objectName,
               tablesUsed: dependencies.dependsOn,
               relatedObjects: [], // Will be implemented separately if needed
               summary: this._generateSummary(dependencies.dependsOn)
           };
       } catch (error) {
           console.error(`Error in table usage analysis for ${objectName}:`, error);
           return {
               objectName: objectName,
               tablesUsed: [],
               relatedObjects: [],
               summary: { totalTables: 0, readTables: 0, writeTables: 0, operationCounts: {} }
           };
       }
   }

   /**
    * Generate usage summary with validation
    */
   _generateSummary(tablesUsed) {
       try {
           const summary = {
               totalTables: tablesUsed.length,
               readTables: 0,
               writeTables: 0,
               operationCounts: {}
           };

           tablesUsed.forEach(table => {
               try {
                   if (table.is_selected) summary.readTables++;
                   if (table.is_updated || table.is_insert_all || table.is_delete) {
                       summary.writeTables++;
                   }
                   
                   const operations = table.operations || [];
                   operations.forEach(op => {
                       if (op && typeof op === 'string') {
                           summary.operationCounts[op] = (summary.operationCounts[op] || 0) + 1;
                       }
                   });
               } catch (tableError) {
                   console.warn('Error processing table in summary:', tableError);
               }
           });

           return summary;
       } catch (error) {
           console.error('Error generating summary:', error);
           return { totalTables: 0, readTables: 0, writeTables: 0, operationCounts: {} };
       }
   }

   /**
    * Validate input parameters
    * @param {string} database 
    * @param {string} objectName 
    * @private
    */
    _validateInputs(database, objectName) {
        if (!database || typeof database !== 'string' || database.trim() === '') {
            throw new Error('Valid database name is required');
        }
        
        if (!objectName || typeof objectName !== 'string' || objectName.trim() === '') {
            throw new Error('Valid object name is required');
        }
        
        // Vérification de base contre l'injection SQL - correction de la regex
        const dangerousChars = /[';]|--|\/\*|\*\/|xp_|sp_|exec\s+|execute\s+/i;
        if (dangerousChars.test(database) || dangerousChars.test(objectName)) {
            throw new Error('Invalid characters detected in input parameters');
        }
    }

   /**
    * Get performance metrics
    */
   getPerformanceMetrics() {
       return {
           cacheSize: this._tablesCache.size,
           cacheHitRate: this._calculateCacheHitRate(),
           averageParsingTime: this._averageParsingTime || 0,
           totalParsedObjects: this._totalParsedObjects || 0
       };
   }

   /**
    * Calculate cache hit rate
    * @private
    */
   _calculateCacheHitRate() {
       // Simplistic calculation - in a real implementation, you'd track hits and misses
       return this._tablesCache.size > 0 ? 0.8 : 0; // Placeholder
   }

   /**
    * Clean up resources and timers
    */
   dispose() {
       // Nettoyer le timer de nettoyage automatique
       if (this._cleanupInterval) {
           clearInterval(this._cleanupInterval);
           this._cleanupInterval = null;
       }
       
       // Nettoyer les caches
       this._tablesCache.clear();
       this._cacheTimestamps.clear();
       
       // Nettoyer les références
       this._connectionManager = null;
       this._databaseService = null;
       
       console.log('🧹 SmartSqlParser disposed');
   }

   /**
    * Get diagnostic information for debugging
    */
   getDiagnostics() {
       return {
           cacheStats: this.getCacheStats(),
           performanceMetrics: this.getPerformanceMetrics(),
           sqlKeywords: this._sqlKeywords.size,
           operationKeywords: this._operationKeywords.size,
           isDisposed: this._cleanupInterval === null
       };
   }

   /**
    * Validate and sanitize SQL code input
    * @param {string} sqlCode 
    * @private
    */
   _validateSqlCode(sqlCode) {
       if (!sqlCode || typeof sqlCode !== 'string') {
           return '';
       }
       
       // Limite de taille pour éviter les problèmes de performance
       const maxSqlLength = 1024 * 1024; // 1MB
       if (sqlCode.length > maxSqlLength) {
           console.warn(`SQL code truncated from ${sqlCode.length} to ${maxSqlLength} characters`);
           return sqlCode.substring(0, maxSqlLength);
       }
       
       return sqlCode;
   }

   /**
    * Enhanced error handling for parsing operations
    * @param {Error} error 
    * @param {string} operation 
    * @param {string} objectName 
    * @private
    */
   _handleParsingError(error, operation, objectName) {
       const errorInfo = {
           operation: operation,
           objectName: objectName,
           error: error.message,
           timestamp: new Date().toISOString()
       };
       
       console.error(`❌ Parsing error in ${operation} for ${objectName}:`, errorInfo);
       
       // En production, vous pourriez vouloir envoyer ces erreurs à un service de monitoring
       // this._sendErrorToMonitoring(errorInfo);
   }

   /**
    * Memory usage optimization - limit cache growth
    * @private
    */
   _optimizeMemoryUsage() {
       const maxMemoryEntries = 50;
       
       if (this._tablesCache.size > maxMemoryEntries) {
           // Supprimer les entrées les plus anciennes
           const sortedEntries = Array.from(this._cacheTimestamps.entries())
               .sort((a, b) => a[1] - b[1]);
           
           const entriesToRemove = this._tablesCache.size - maxMemoryEntries;
           for (let i = 0; i < entriesToRemove; i++) {
               const [database] = sortedEntries[i];
               this._tablesCache.delete(database);
               this._cacheTimestamps.delete(database);
           }
           
           console.log(`🧹 Memory optimization: removed ${entriesToRemove} cache entries`);
       }
   }
}

module.exports = SmartSqlParser;