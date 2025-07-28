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
 * 
 * Enhanced Features:
 * - CTE/Subquery parsing with proper nesting
 * - Dynamic SQL string analysis
 * - Temporary table tracking
 * - Complexity scoring
 * - SQL Server version compatibility (2017+ support)
 */
class SmartSqlParser {
    constructor(connectionManager, databaseService) {
        this._connectionManager = connectionManager;
        this._databaseService = databaseService;
        this._tablesCache = new Map(); // Cache tables by database
        this._cacheTimestamps = new Map(); // Track cache freshness
        this._cacheTimeout = 5 * 60 * 1000; // 5 minutes cache timeout
        this._maxCacheSize = 100; // Limite du cache par base de données
        this._temporaryTables = new Map(); // Track CTEs and temp tables
        
        // Version compatibility
        this._serverVersion = null;
        this._isLegacyServer = false;
        
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
     * Check SQL Server version for compatibility
     */
    async _checkServerVersion(database) {
        if (this._serverVersion === null) {
            try {
                // Try to get version info
                if (typeof this._databaseService.getServerVersion === 'function') {
                    this._serverVersion = await this._databaseService.getServerVersion(database);
                } else {
                    // Fallback: assume legacy for safety
                    this._serverVersion = '14.0.0';
                }
                
                const majorVersion = parseInt(this._serverVersion.split('.')[0]);
                this._isLegacyServer = majorVersion < 15; // Before SQL Server 2019
                
                console.log(`SQL Server version: ${this._serverVersion} (Legacy mode: ${this._isLegacyServer})`);
            } catch (error) {
                console.warn('Could not detect SQL Server version, using legacy mode:', error);
                this._isLegacyServer = true;
            }
        }
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
        
        // Clean up temporary tables older than 1 hour
        for (const [name, table] of this._temporaryTables) {
            if (now - table.created > 60 * 60 * 1000) {
                this._temporaryTables.delete(name);
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
        console.log(`🔍 Analyzing dependencies for ${objectName} with enhanced parsing`);
        
        try {
            // Check server version first
            await this._checkServerVersion(database);
            
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

            // 3. Enhanced parsing with schema awareness and new capabilities
            const tableUsages = await this._parseTableUsagesWithEnhancements(sqlCode, tables, objectName);
            
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
     * Enhanced table usage parsing with CTE, subquery, and dynamic SQL support
     */
    async _parseTableUsagesWithEnhancements(sqlCode, tables, objectName) {
        try {
            const tableUsages = new Map();
            
            // Clean and normalize SQL code - use simpler method for legacy servers
            const cleanedCode = this._isLegacyServer 
                ? this._cleanSqlCodeLegacy(sqlCode)
                : this._cleanSqlCodeEnhanced(sqlCode);
                
            if (!cleanedCode.trim()) {
                console.warn(`Empty SQL code after cleaning for ${objectName}`);
                return [];
            }
            
            // Create efficient lookup structures with schema support
            const tableNameMap = this._createSchemaAwareTableLookupMap(tables);
            
            // 1. Parse main SQL structure
            const tokens = this._isLegacyServer 
                ? this._tokenizeSqlBasic(cleanedCode)
                : this._tokenizeSqlEnhanced(cleanedCode);
                
            if (tokens.length === 0) {
                console.warn(`No tokens extracted from SQL for ${objectName}`);
                return [];
            }
            
            // Parse tokens with schema-aware context algorithm
            this._parseTokensWithSchemaContext(tokens, tableNameMap, tableUsages, objectName);
            
            // 2. Parse complex structures (CTEs and Subqueries) - only for modern servers
            if (!this._isLegacyServer) {
                this._parseComplexStructures(cleanedCode, tableNameMap, tableUsages, objectName);
                // 3. Analyze dynamic SQL - only for modern servers
                this._analyzeDynamicSQL(cleanedCode, tableNameMap, tableUsages, objectName);
            } else {
                // Basic CTE parsing for legacy servers
                this._parseBasicCTEs(cleanedCode, tableNameMap, tableUsages, objectName);
            }
            
            // Post-process to remove duplicates and validate results
            return this._postProcessTableUsages(tableUsages);
            
        } catch (error) {
            console.error(`Error in enhanced parsing for ${objectName}:`, error);
            return [];
        }
    }

    /**
     * Basic CTE parsing for legacy servers
     */
    _parseBasicCTEs(sqlCode, tableNameMap, tableUsages, objectName) {
        try {
            const cteRegex = /WITH\s+(\w+)\s+AS\s*\(\s*([^)]+)\s*\)/gi;
            let match;
            
            while ((match = cteRegex.exec(sqlCode)) !== null) {
                const cteName = match[1];
                const cteContent = match[2];
                
                console.log(`🔍 Found basic CTE: ${cteName}`);
                
                const cteTokens = this._tokenizeSqlBasic(cteContent);
                this._parseTokensWithSchemaContext(cteTokens, tableNameMap, tableUsages, objectName);
                this._trackTemporaryTable(cteName, 'CTE', objectName);
            }
        } catch (error) {
            console.warn('Error in basic CTE parsing:', error);
        }
    }

    /**
     * Legacy SQL code cleaning (simpler approach)
     */
    _cleanSqlCodeLegacy(sqlCode) {
        if (!sqlCode || typeof sqlCode !== 'string') {
            return '';
        }
        
        try {
            let cleaned = sqlCode;
            
            // Simple comment removal
            cleaned = cleaned.replace(/--.*$/gm, ' ');
            cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, ' ');
            
            // Simple string literal removal
            cleaned = cleaned.replace(/'[^']*'/g, "''");
            cleaned = cleaned.replace(/"[^"]*"/g, '""');
            
            // Basic normalization
            cleaned = cleaned.replace(/\s+/g, ' ').trim().toUpperCase();
            
            return cleaned;
        } catch (error) {
            console.error('Error in legacy SQL cleaning:', error);
            return sqlCode.toUpperCase();
        }
    }

    /**
     * Basic tokenization for legacy compatibility
     */
    _tokenizeSqlBasic(sqlCode) {
        try {
            if (!sqlCode) return [];
            
            let processedCode = sqlCode;
            processedCode = processedCode.replace(/\./g, ' . ');
            processedCode = processedCode.replace(/\[/g, ' [ ');
            processedCode = processedCode.replace(/\]/g, ' ] ');
            
            return processedCode.split(/[\s,\(\);=<>!+\-\*\/\n\r\t]+/)
                .map(token => token.trim())
                .filter(token => token.length > 0);
        } catch (error) {
            console.error('Error in basic tokenization:', error);
            return [];
        }
    }

    /**
     * Enhanced CTE and subquery parsing with better nesting support
     */
    _parseComplexStructures(sqlCode, tableNameMap, tableUsages, objectName) {
        try {
            // Find and parse CTEs first
            const cteMatches = this._findCTEStructures(sqlCode);
            cteMatches.forEach(cte => {
                this._parseCTEContent(cte, tableNameMap, tableUsages, objectName);
            });
            
            // Find and parse subqueries
            const subqueryMatches = this._findSubqueryStructures(sqlCode);
            subqueryMatches.forEach(subquery => {
                this._parseSubqueryContent(subquery, tableNameMap, tableUsages, objectName);
            });
        } catch (error) {
            console.warn(`Error parsing complex structures:`, error);
        }
    }

    /**
     * Find CTE structures with proper nesting handling
     */
    _findCTEStructures(sqlCode) {
        const cteRegex = /WITH\s+([^(]+)\s*AS\s*\(\s*((?:[^()]|\([^)]*\))*)\s*\)/gi;
        const ctes = [];
        let match;
        
        while ((match = cteRegex.exec(sqlCode)) !== null) {
            const cteName = match[1].trim();
            const cteContent = match[2];
            const startPos = match.index;
            const endPos = match.index + match[0].length;
            
            ctes.push({
                name: cteName,
                content: cteContent,
                startPos: startPos,
                endPos: endPos,
                fullMatch: match[0]
            });
        }
        
        return ctes;
    }

    /**
     * Find subquery structures with balanced parentheses
     */
    _findSubqueryStructures(sqlCode) {
        const subqueries = [];
        let depth = 0;
        let start = -1;
        let inString = false;
        let stringChar = '';
        
        for (let i = 0; i < sqlCode.length; i++) {
            const char = sqlCode[i];
            const prevChar = i > 0 ? sqlCode[i - 1] : '';
            
            // Handle string literals
            if ((char === "'" || char === '"') && prevChar !== '\\') {
                if (!inString) {
                    inString = true;
                    stringChar = char;
                } else if (char === stringChar) {
                    inString = false;
                    stringChar = '';
                }
                continue;
            }
            
            if (inString) continue;
            
            if (char === '(') {
                if (depth === 0) {
                    // Check if this might be a subquery
                    const preceding = sqlCode.substring(Math.max(0, i - 20), i).trim().toUpperCase();
                    if (this._isLikelySubquery(preceding)) {
                        start = i;
                    }
                }
                depth++;
            } else if (char === ')') {
                depth--;
                if (depth === 0 && start !== -1) {
                    const content = sqlCode.substring(start + 1, i);
                    if (this._containsSelectStatement(content)) {
                        subqueries.push({
                            content: content,
                            startPos: start,
                            endPos: i + 1,
                            fullMatch: sqlCode.substring(start, i + 1)
                        });
                    }
                    start = -1;
                }
            }
        }
        
        return subqueries;
    }

    /**
     * Check if parentheses likely contain a subquery
     */
    _isLikelySubquery(preceding) {
        const subqueryIndicators = [
            'SELECT', 'FROM', 'WHERE', 'IN', 'EXISTS', 'NOT EXISTS',
            'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'OUTER JOIN',
            'UNION', 'INTERSECT', 'EXCEPT', 'WITH'
        ];
        
        return subqueryIndicators.some(indicator => 
            preceding.includes(indicator)
        );
    }

    /**
     * Check if content contains SELECT statement
     */
    _containsSelectStatement(content) {
        const trimmed = content.trim().toUpperCase();
        return trimmed.startsWith('SELECT') || trimmed.includes(' SELECT ');
    }

    /**
     * Parse CTE content for table references
     */
    _parseCTEContent(cte, tableNameMap, tableUsages, objectName) {
        console.log(`🔍 Parsing CTE: ${cte.name}`);
        
        try {
            const tokens = this._tokenizeSqlEnhanced(cte.content);
            this._parseTokensWithSchemaContext(tokens, tableNameMap, tableUsages, objectName);
            
            // Track CTE as a temporary table for subsequent references
            this._trackTemporaryTable(cte.name, 'CTE', objectName);
            
            // Mark tables found in CTE with CTE operation
            for (const [tableName, usage] of tableUsages) {
                usage.operations.add('CTE');
            }
            
        } catch (error) {
            console.warn(`Error parsing CTE ${cte.name}:`, error);
        }
    }

    /**
     * Parse subquery content for table references
     */
    _parseSubqueryContent(subquery, tableNameMap, tableUsages, objectName) {
        console.log(`🔍 Parsing subquery at position ${subquery.startPos}`);
        
        try {
            const tokens = this._tokenizeSqlEnhanced(subquery.content);
            this._parseTokensWithSchemaContext(tokens, tableNameMap, tableUsages, objectName);
            
            // Mark tables found in subquery
            for (const [tableName, usage] of tableUsages) {
                usage.operations.add('SUBQUERY');
            }
            
        } catch (error) {
            console.warn(`Error parsing subquery at ${subquery.startPos}:`, error);
        }
    }

    /**
     * Enhanced dynamic SQL detection and analysis
     */
    _analyzeDynamicSQL(sqlCode, tableNameMap, tableUsages, objectName) {
        try {
            // Find EXEC/EXECUTE statements with string concatenation
            const execMatches = this._findDynamicExecStatements(sqlCode);
            execMatches.forEach(exec => {
                this._parseDynamicExecContent(exec, tableNameMap, tableUsages, objectName);
            });
            
            // Find sp_executesql calls
            const spExecMatches = this._findSpExecuteSqlCalls(sqlCode);
            spExecMatches.forEach(spExec => {
                this._parseSpExecuteSqlContent(spExec, tableNameMap, tableUsages, objectName);
            });
            
            // Find string concatenation patterns that might contain SQL
            const stringConcatMatches = this._findSqlStringConcatenation(sqlCode);
            stringConcatMatches.forEach(concat => {
                this._parseStringConcatenationContent(concat, tableNameMap, tableUsages, objectName);
            });
        } catch (error) {
            console.warn(`Error analyzing dynamic SQL:`, error);
        }
    }

    /**
     * Find EXEC/EXECUTE statements with dynamic SQL
     */
    _findDynamicExecStatements(sqlCode) {
        const execRegex = /EXEC(?:UTE)?\s*\(\s*([^)]+)\s*\)|EXEC(?:UTE)?\s+(@\w+|'[^']*'|\w+)/gi;
        const matches = [];
        let match;
        
        while ((match = execRegex.exec(sqlCode)) !== null) {
            const content = match[1] || match[2];
            if (content && (content.includes('@') || content.includes('+'))) {
                matches.push({
                    fullMatch: match[0],
                    content: content,
                    startPos: match.index,
                    endPos: match.index + match[0].length,
                    type: 'EXEC'
                });
            }
        }
        
        return matches;
    }

    /**
     * Find sp_executesql calls
     */
    _findSpExecuteSqlCalls(sqlCode) {
        const spExecRegex = /sp_executesql\s*\(\s*([^,)]+)(?:,\s*([^,)]+))?(?:,\s*([^)]+))?\s*\)/gi;
        const matches = [];
        let match;
        
        while ((match = spExecRegex.exec(sqlCode)) !== null) {
            matches.push({
                fullMatch: match[0],
                sqlParameter: match[1],
                paramDefinition: match[2],
                parameters: match[3],
                startPos: match.index,
                endPos: match.index + match[0].length,
                type: 'sp_executesql'
            });
        }
        
        return matches;
    }

    /**
     * Find SQL string concatenation patterns
     */
    _findSqlStringConcatenation(sqlCode) {
        // Look for patterns like: SET @sql = 'SELECT * FROM ' + @tableName + ' WHERE...'
        const concatRegex = /@\w+\s*[+]=\s*['"][^'"]*(?:SELECT|INSERT|UPDATE|DELETE)[^'"]*['"](?:\s*\+\s*@?\w+)*/gi;
        const matches = [];
        let match;
        
        while ((match = concatRegex.exec(sqlCode)) !== null) {
            matches.push({
                fullMatch: match[0],
                startPos: match.index,
                endPos: match.index + match[0].length,
                type: 'string_concatenation'
            });
        }
        
        return matches;
    }

    /**
     * Parse dynamic EXEC content
     */
    _parseDynamicExecContent(exec, tableNameMap, tableUsages, objectName) {
        console.log(`🔍 Analyzing dynamic EXEC: ${exec.content}`);
        
        try {
            // Try to extract static table names from dynamic SQL patterns
            const staticTableNames = this._extractStaticTableNames(exec.content);
            
            staticTableNames.forEach(tableName => {
                const tableInfo = this._findTableMatch(tableName, tableNameMap);
                if (tableInfo) {
                    this._addTableUsage(tableUsages, tableInfo.originalName, ['DYNAMIC_SQL'], exec.startPos, objectName);
                }
            });
            
        } catch (error) {
            console.warn(`Error parsing dynamic EXEC:`, error);
        }
    }

    /**
     * Parse sp_executesql content
     */
    _parseSpExecuteSqlContent(spExec, tableNameMap, tableUsages, objectName) {
        console.log(`🔍 Analyzing sp_executesql call`);
        
        try {
            // Extract SQL from the first parameter
            let sqlContent = spExec.sqlParameter.trim();
            
            // Remove variable name if it's a variable reference
            if (sqlContent.startsWith('@')) {
                // This is a variable - we'd need variable tracking to resolve it
                // For now, mark as dynamic SQL usage
                this._addTableUsage(tableUsages, 'DYNAMIC_TABLE_REFERENCE', ['DYNAMIC_SQL'], spExec.startPos, objectName);
                return;
            }
            
            // Remove quotes if it's a string literal
            if ((sqlContent.startsWith("'") && sqlContent.endsWith("'")) ||
                (sqlContent.startsWith('"') && sqlContent.endsWith('"'))) {
                sqlContent = sqlContent.slice(1, -1);
            }
            
            // Parse the SQL content
            if (sqlContent.length > 0) {
                const tokens = this._tokenizeSqlEnhanced(sqlContent);
                this._parseTokensWithSchemaContext(tokens, tableNameMap, tableUsages, objectName);
            }
            
        } catch (error) {
            console.warn(`Error parsing sp_executesql:`, error);
        }
    }

    /**
     * Parse string concatenation content
     */
    _parseStringConcatenationContent(concat, tableNameMap, tableUsages, objectName) {
        console.log(`🔍 Analyzing SQL string concatenation`);
        
        try {
            // Extract static parts from concatenation
            const staticParts = this._extractStaticPartsFromConcatenation(concat.fullMatch);
            
            staticParts.forEach(part => {
                const tokens = this._tokenizeSqlEnhanced(part);
                this._parseTokensWithSchemaContext(tokens, tableNameMap, tableUsages, objectName);
            });
            
            // Mark as dynamic SQL
            this._addTableUsage(tableUsages, 'DYNAMIC_SQL_DETECTED', ['DYNAMIC_SQL'], concat.startPos, objectName);
            
        } catch (error) {
            console.warn(`Error parsing string concatenation:`, error);
        }
    }

    /**
     * Extract static table names from dynamic SQL patterns
     */
    _extractStaticTableNames(content) {
        const tableNames = [];
        
        // Look for patterns like 'FROM tableName' or 'JOIN tableName'
        const tablePatterns = [
            /FROM\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)/gi,
            /JOIN\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)/gi,
            /UPDATE\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)/gi,
            /INSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)/gi
        ];
        
        tablePatterns.forEach(pattern => {
            let match;
            while ((match = pattern.exec(content)) !== null) {
                tableNames.push(match[1]);
            }
        });
        
        return [...new Set(tableNames)]; // Remove duplicates
    }

    /**
     * Extract static parts from string concatenation
     */
    _extractStaticPartsFromConcatenation(concatenation) {
        const staticParts = [];
        
        // Extract quoted strings
        const stringRegex = /['"]([^'"]*)['"]/g;
        let match;
        
        while ((match = stringRegex.exec(concatenation)) !== null) {
            const content = match[1];
            if (content.length > 0 && this._looksLikeSql(content)) {
                staticParts.push(content);
            }
        }
        
        return staticParts;
    }

    /**
     * Check if string content looks like SQL
     */
    _looksLikeSql(content) {
        const sqlKeywords = ['SELECT', 'FROM', 'WHERE', 'JOIN', 'INSERT', 'UPDATE', 'DELETE'];
        const upperContent = content.toUpperCase();
        
        return sqlKeywords.some(keyword => upperContent.includes(keyword));
    }

    /**
     * Track temporary tables (CTEs, temp tables)
     */
    _trackTemporaryTable(name, type, objectName) {
        if (!this._temporaryTables) {
            this._temporaryTables = new Map();
        }
        
        this._temporaryTables.set(name.toUpperCase(), {
            name: name,
            type: type,
            sourceObject: objectName,
            created: Date.now()
        });
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
        const contextWindow = this._isLegacyServer ? 10 : 15; // Smaller window for legacy
        
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
           if (!token.includes('.') && !this._isLegacyServer) {
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
                  positions: usage.positions || 0,
                  // Enhanced metadata (only for modern servers)
                  has_cte: !this._isLegacyServer && operations.includes('CTE') ? 1 : 0,
                  has_subquery: !this._isLegacyServer && operations.includes('SUBQUERY') ? 1 : 0,
                  has_dynamic_sql: !this._isLegacyServer && operations.includes('DYNAMIC_SQL') ? 1 : 0
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
                  positions: 0,
                  has_cte: 0,
                  has_subquery: 0,
                  has_dynamic_sql: 0
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
             this._temporaryTables.clear();
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
         temporaryTables: this._temporaryTables.size,
         serverVersion: this._serverVersion,
         isLegacyServer: this._isLegacyServer,
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
             summary: this._generateEnhancedSummary(dependencies.dependsOn)
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
  * Generate enhanced analysis summary with new parsing capabilities
  */
 _generateEnhancedSummary(tablesUsed) {
     try {
         const summary = {
             totalTables: tablesUsed.length,
             readTables: 0,
             writeTables: 0,
             operationCounts: {},
             // Enhanced metrics (only for modern servers)
             cteReferences: 0,
             subqueryReferences: 0,
             dynamicSqlReferences: 0,
             temporaryTables: this._temporaryTables ? this._temporaryTables.size : 0,
             complexityScore: 0,
             serverVersion: this._serverVersion,
             legacyMode: this._isLegacyServer
         };

         tablesUsed.forEach(table => {
             try {
                 if (table.is_selected) summary.readTables++;
                 if (table.is_updated || table.is_insert_all || table.is_delete) {
                     summary.writeTables++;
                 }
                 
                 // Count enhanced features (only for modern servers)
                 if (!this._isLegacyServer) {
                     if (table.has_cte) summary.cteReferences++;
                     if (table.has_subquery) summary.subqueryReferences++;
                     if (table.has_dynamic_sql) summary.dynamicSqlReferences++;
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

         // Calculate complexity score
         summary.complexityScore = this._calculateComplexityScore(tablesUsed);

         return summary;
     } catch (error) {
         console.error('Error generating enhanced summary:', error);
         return { 
             totalTables: 0, 
             readTables: 0, 
             writeTables: 0, 
             operationCounts: {},
             cteReferences: 0,
             subqueryReferences: 0,
             dynamicSqlReferences: 0,
             temporaryTables: 0,
             complexityScore: 0,
             serverVersion: this._serverVersion || 'Unknown',
             legacyMode: this._isLegacyServer
         };
     }
 }

 /**
  * Calculate SQL complexity score based on parsing results
  */
 _calculateComplexityScore(tablesUsed) {
     let score = 0;
     
     tablesUsed.forEach(table => {
         try {
             score += table.operations ? table.operations.length : 0;
             if (!this._isLegacyServer) {
                 if (table.has_cte) score += 2;
                 if (table.has_subquery) score += 1;
                 if (table.has_dynamic_sql) score += 3;
             }
             score += (table.confidence || 0) * 0.1;
         } catch (error) {
             console.warn('Error calculating complexity for table:', error);
         }
     });
     
     return Math.min(score, 100); // Cap at 100
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
     this._temporaryTables.clear();
     
     // Nettoyer les références
     this._connectionManager = null;
     this._databaseService = null;
     
     console.log('🧹 SmartSqlParser disposed');
 }
}

module.exports = SmartSqlParser;