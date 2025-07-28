/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

/**
 * Smart SQL Parser - Enhanced version with robust parsing and proper error handling
 * 
 * Features:
 * - Real SQL parsing with grammar awareness
 * - Proper error handling and recovery
 * - Schema-aware table detection
 * - CTE and subquery support
 * - Dynamic SQL analysis
 * - Comprehensive logging and metrics
 */
class SmartSqlParser {
    constructor(connectionManager, databaseService) {
        this._connectionManager = connectionManager;
        this._databaseService = databaseService;
        
        // Cache management
        this._tablesCache = new Map();
        this._cacheTimestamps = new Map();
        this._cacheTimeout = 5 * 60 * 1000; // 5 minutes
        this._maxCacheSize = 100;
        
        // Parsing state
        this._temporaryTables = new Map();
        this._aliases = new Map();
        
        // Server compatibility
        this._serverVersion = null;
        this._isLegacyServer = false;
        
        // Error tracking and metrics
        this._errorStats = {
            totalParses: 0,
            successfulParses: 0,
            partialParses: 0,
            failedParses: 0,
            errorTypes: {}
        };
        
        // SQL grammar definitions
        this._initializeGrammar();
        
        // Cleanup timer
        this._cleanupInterval = setInterval(() => {
            this._cleanupExpiredCache();
        }, 10 * 60 * 1000);
    }

    /**
     * Initialize SQL grammar patterns and keywords
     * @private
     */
    _initializeGrammar() {
        // SQL keywords by category
        this._sqlKeywords = {
            dml: new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE']),
            ddl: new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE']),
            clauses: new Set(['FROM', 'WHERE', 'JOIN', 'ON', 'GROUP', 'HAVING', 'ORDER', 'UNION']),
            joinTypes: new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS']),
            operators: new Set(['AND', 'OR', 'NOT', 'IN', 'EXISTS', 'LIKE', 'BETWEEN']),
            functions: new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE'])
        };

        // Table reference patterns (more sophisticated)
        this._tablePatterns = {
            // FROM clause patterns
            fromClause: /FROM\s+([^WHERE|GROUP|ORDER|HAVING|UNION|;]+?)(?:\s+WHERE|\s+GROUP|\s+ORDER|\s+HAVING|\s+UNION|;|$)/gi,
            
            // JOIN patterns with proper alias handling
            joinClause: /((?:INNER|LEFT|RIGHT|FULL|CROSS)?\s*JOIN)\s+([^\s]+)(?:\s+(?:AS\s+)?([^\s]+))?\s+ON/gi,
            
            // UPDATE patterns
            updateTable: /UPDATE\s+([^\s]+)(?:\s+(?:AS\s+)?([^\s]+))?\s+SET/gi,
            
            // INSERT patterns
            insertTable: /INSERT\s+(?:INTO\s+)?([^\s(]+)/gi,
            
            // DELETE patterns
            deleteTable: /DELETE\s+(?:FROM\s+)?([^\s]+)/gi
        };

        // SQL structure patterns
        this._structurePatterns = {
            // CTE detection
            cte: /WITH\s+(\w+)\s*(?:\([^)]+\))?\s*AS\s*\(\s*([^)]+(?:\([^)]*\)[^)]*)*)\s*\)/gi,
            
            // Subquery detection (basic)
            subquery: /\(\s*SELECT\s+[^)]+\)/gi,
            
            // Dynamic SQL patterns
            dynamicExec: /EXEC(?:UTE)?\s*\(\s*([^)]+)\s*\)/gi,
            spExecuteSql: /sp_executesql\s*\(\s*([^,)]+)/gi,
            
            // String concatenation
            stringConcat: /@\w+\s*[+=]\s*['"][^'"]*(?:SELECT|INSERT|UPDATE|DELETE)[^'"]*['"]/gi
        };
    }

    /**
     * Main dependency analysis method with enhanced error handling
     */
    async analyzeDependencies(database, objectName) {
        const parseId = this._generateParseId();
        
        try {
            console.log(`[${parseId}] Starting dependency analysis for ${objectName}`);
            this._errorStats.totalParses++;
            
            // Input validation
            if (!database || !objectName) {
                throw new ParseError('INVALID_INPUT', 'Database and object name are required');
            }
            
            // Check server version for compatibility
            await this._checkServerVersion(database);
            
            // Get table definitions with caching
            const tables = await this._getTablesForDatabase(database);
            if (tables.length === 0) {
                console.warn(`[${parseId}] No tables found for database: ${database}`);
                return this._createEmptyResult();
            }
            
            // Get SQL definition
            const sqlCode = await this._getObjectDefinition(database, objectName);
            if (!sqlCode) {
                console.log(`[${parseId}] No SQL definition found for ${objectName}`);
                return this._createEmptyResult();
            }

            // Parse with error recovery
            const parseResult = await this._parseWithRecovery(sqlCode, tables, objectName, parseId);
            
            // Convert to expected format
            const dependsOn = this._convertToExpectedFormat(parseResult.tables, parseResult.confidence);
            
            // Update success metrics
            if (parseResult.confidence >= 0.8) {
                this._errorStats.successfulParses++;
            } else if (parseResult.confidence >= 0.5) {
                this._errorStats.partialParses++;
            } else {
                this._errorStats.failedParses++;
            }
            
            console.log(`[${parseId}] Analysis complete: ${dependsOn.length} dependencies found (confidence: ${parseResult.confidence})`);
            
            return { 
                dependsOn, 
                referencedBy: [], // Computed separately
                metadata: {
                    parseId,
                    confidence: parseResult.confidence,
                    method: parseResult.method,
                    errors: parseResult.errors
                }
            };
            
        } catch (error) {
            return this._handleParseError(error, objectName, parseId);
        }
    }

    /**
     * Parse SQL with error recovery and fallback strategies
     * @private
     */
    async _parseWithRecovery(sqlCode, tables, objectName, parseId) {
        const result = {
            tables: [],
            confidence: 0,
            errors: [],
            method: 'unknown'
        };

        // Strategy 1: Full enhanced parsing
        try {
            console.log(`[${parseId}] Attempting full enhanced parsing`);
            result.tables = await this._parseTableUsagesEnhanced(sqlCode, tables, objectName);
            result.confidence = 1.0;
            result.method = 'enhanced';
            return result;
        } catch (error) {
            console.warn(`[${parseId}] Enhanced parsing failed:`, error.message);
            result.errors.push({ type: 'enhanced_parse_failed', message: error.message });
        }

        // Strategy 2: Basic regex parsing
        try {
            console.log(`[${parseId}] Falling back to basic parsing`);
            result.tables = await this._parseTableUsagesBasic(sqlCode, tables, objectName);
            result.confidence = 0.7;
            result.method = 'basic';
            return result;
        } catch (error) {
            console.warn(`[${parseId}] Basic parsing failed:`, error.message);
            result.errors.push({ type: 'basic_parse_failed', message: error.message });
        }

        // Strategy 3: Simple keyword matching (last resort)
        try {
            console.log(`[${parseId}] Using simple keyword matching`);
            result.tables = await this._parseTableUsagesSimple(sqlCode, tables, objectName);
            result.confidence = 0.3;
            result.method = 'simple';
            return result;
        } catch (error) {
            console.error(`[${parseId}] All parsing strategies failed:`, error.message);
            result.errors.push({ type: 'all_strategies_failed', message: error.message });
            result.confidence = 0;
            result.method = 'failed';
            return result;
        }
    }

    /**
     * Enhanced table usage parsing with real SQL structure awareness
     * @private
     */
    async _parseTableUsagesEnhanced(sqlCode, tables, objectName) {
        try {
            const tableUsages = new Map();
            
            // Step 1: Clean and normalize SQL
            const cleanedCode = this._cleanSqlCodeRobust(sqlCode);
            if (!cleanedCode.trim()) {
                throw new ParseError('EMPTY_CODE', 'SQL code is empty after cleaning');
            }
            
            // Step 2: Create table lookup map with schema awareness
            const tableNameMap = this._createSchemaAwareTableLookupMap(tables);
            
            // Step 3: Parse SQL structure
            const sqlStructure = this._parseSqlStructure(cleanedCode);
            
            // Step 4: Extract table references from each part
            this._extractTableReferencesFromStructure(sqlStructure, tableNameMap, tableUsages, objectName);
            
            // Step 5: Post-process and validate
            return this._postProcessTableUsages(tableUsages);
            
        } catch (error) {
            throw new ParseError('ENHANCED_PARSE_ERROR', `Enhanced parsing failed: ${error.message}`, error);
        }
    }

    /**
     * Parse SQL structure into meaningful components
     * @private
     */
    _parseSqlStructure(sqlCode) {
        const structure = {
            statements: [],
            ctes: [],
            subqueries: [],
            dynamicSql: []
        };

        try {
            // Parse statements (separated by semicolons at root level)
            const statements = this._splitStatements(sqlCode);
            
            statements.forEach((statement, index) => {
                const statementInfo = {
                    index,
                    content: statement,
                    type: this._identifyStatementType(statement),
                    clauses: this._parseClauses(statement)
                };
                
                structure.statements.push(statementInfo);
            });

            // Parse CTEs
            structure.ctes = this._parseCTEs(sqlCode);
            
            // Parse subqueries
            structure.subqueries = this._parseSubqueries(sqlCode);
            
            // Parse dynamic SQL
            structure.dynamicSql = this._parseDynamicSql(sqlCode);
            
            return structure;
            
        } catch (error) {
            throw new ParseError('STRUCTURE_PARSE_ERROR', `Failed to parse SQL structure: ${error.message}`);
        }
    }

    /**
     * Split SQL into statements while respecting string literals and comments
     * @private
     */
    _splitStatements(sqlCode) {
        const statements = [];
        let currentStatement = '';
        let inString = false;
        let stringChar = '';
        let inComment = false;
        let commentType = '';
        
        for (let i = 0; i < sqlCode.length; i++) {
            const char = sqlCode[i];
            const nextChar = i < sqlCode.length - 1 ? sqlCode[i + 1] : '';
            const prevChar = i > 0 ? sqlCode[i - 1] : '';
            
            // Handle string literals
            if (!inComment && (char === "'" || char === '"') && prevChar !== '\\') {
                if (!inString) {
                    inString = true;
                    stringChar = char;
                } else if (char === stringChar) {
                    inString = false;
                    stringChar = '';
                }
            }
            
            // Handle comments
            if (!inString) {
                if (!inComment && char === '-' && nextChar === '-') {
                    inComment = true;
                    commentType = 'line';
                    i++; // Skip next char
                    continue;
                } else if (!inComment && char === '/' && nextChar === '*') {
                    inComment = true;
                    commentType = 'block';
                    i++; // Skip next char
                    continue;
                } else if (inComment) {
                    if (commentType === 'line' && (char === '\n' || char === '\r')) {
                        inComment = false;
                        commentType = '';
                    } else if (commentType === 'block' && char === '*' && nextChar === '/') {
                        inComment = false;
                        commentType = '';
                        i++; // Skip next char
                        continue;
                    }
                }
            }
            
            // Split on semicolon if not in string or comment
            if (!inString && !inComment && char === ';') {
                if (currentStatement.trim()) {
                    statements.push(currentStatement.trim());
                    currentStatement = '';
                }
            } else {
                currentStatement += char;
            }
        }
        
        // Add final statement if exists
        if (currentStatement.trim()) {
            statements.push(currentStatement.trim());
        }
        
        return statements;
    }

    /**
     * Identify the type of SQL statement
     * @private
     */
    _identifyStatementType(statement) {
        const trimmed = statement.trim().toUpperCase();
        
        if (trimmed.startsWith('SELECT')) return 'SELECT';
        if (trimmed.startsWith('INSERT')) return 'INSERT';
        if (trimmed.startsWith('UPDATE')) return 'UPDATE';
        if (trimmed.startsWith('DELETE')) return 'DELETE';
        if (trimmed.startsWith('MERGE')) return 'MERGE';
        if (trimmed.startsWith('WITH')) return 'CTE_SELECT';
        if (trimmed.startsWith('EXEC')) return 'EXECUTE';
        if (trimmed.startsWith('DECLARE')) return 'DECLARE';
        if (trimmed.startsWith('IF')) return 'CONDITIONAL';
        
        return 'UNKNOWN';
    }

    /**
     * Parse clauses within a statement
     * @private
     */
    _parseClauses(statement) {
        const clauses = {};
        const clauseKeywords = ['SELECT', 'FROM', 'WHERE', 'JOIN', 'GROUP BY', 'HAVING', 'ORDER BY', 'INTO', 'SET', 'VALUES'];
        
        let currentClause = null;
        let currentContent = '';
        const words = statement.split(/\s+/);
        
        for (let i = 0; i < words.length; i++) {
            const word = words[i].toUpperCase();
            const nextWord = i < words.length - 1 ? words[i + 1].toUpperCase() : '';
            
            // Check for clause keywords
            let foundClause = null;
            if (clauseKeywords.includes(word)) {
                foundClause = word;
            } else if (word === 'GROUP' && nextWord === 'BY') {
                foundClause = 'GROUP BY';
                i++; // Skip next word
            } else if (word === 'ORDER' && nextWord === 'BY') {
                foundClause = 'ORDER BY';
                i++; // Skip next word
            }
            
            if (foundClause) {
                // Save previous clause
                if (currentClause && currentContent.trim()) {
                    clauses[currentClause] = currentContent.trim();
                }
                currentClause = foundClause;
                currentContent = '';
            } else if (currentClause) {
                currentContent += ' ' + words[i];
            }
        }
        
        // Save final clause
        if (currentClause && currentContent.trim()) {
            clauses[currentClause] = currentContent.trim();
        }
        
        return clauses;
    }

    /**
     * Enhanced CTE parsing with proper nesting
     * @private
     */
    _parseCTEs(sqlCode) {
        const ctes = [];
        let match;
        
        // Reset regex
        this._structurePatterns.cte.lastIndex = 0;
        
        while ((match = this._structurePatterns.cte.exec(sqlCode)) !== null) {
            const cteName = match[1];
            const cteContent = match[2];
            
            ctes.push({
                name: cteName,
                content: cteContent,
                startPos: match.index,
                endPos: match.index + match[0].length
            });
            
            // Track as temporary table
            this._trackTemporaryTable(cteName, 'CTE', 'current_object');
        }
        
        return ctes;
    }

    /**
     * Enhanced subquery parsing with balanced parentheses
     * @private
     */
    _parseSubqueries(sqlCode) {
        const subqueries = [];
        const stack = [];
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
                // Look ahead to see if this might be a subquery
                const following = sqlCode.substring(i + 1, i + 50).trim().toUpperCase();
                if (following.startsWith('SELECT') || following.startsWith('WITH')) {
                    stack.push({ start: i, type: 'subquery' });
                } else {
                    stack.push({ start: i, type: 'parentheses' });
                }
            } else if (char === ')' && stack.length > 0) {
                const frame = stack.pop();
                if (frame.type === 'subquery') {
                    const content = sqlCode.substring(frame.start + 1, i);
                    subqueries.push({
                        content: content,
                        startPos: frame.start,
                        endPos: i + 1
                    });
                }
            }
        }
        
        return subqueries;
    }

    /**
     * Enhanced dynamic SQL parsing
     * @private
     */
    _parseDynamicSql(sqlCode) {
        const dynamicSql = [];
        
        // Parse EXEC statements
        let match;
        this._structurePatterns.dynamicExec.lastIndex = 0;
        while ((match = this._structurePatterns.dynamicExec.exec(sqlCode)) !== null) {
            dynamicSql.push({
                type: 'EXEC',
                content: match[1],
                startPos: match.index,
                endPos: match.index + match[0].length
            });
        }
        
        // Parse sp_executesql calls
        this._structurePatterns.spExecuteSql.lastIndex = 0;
        while ((match = this._structurePatterns.spExecuteSql.exec(sqlCode)) !== null) {
            dynamicSql.push({
                type: 'sp_executesql',
                content: match[1],
                startPos: match.index,
                endPos: match.index + match[0].length
            });
        }
        
        return dynamicSql;
    }

    /**
     * Extract table references from parsed SQL structure
     * @private
     */
    _extractTableReferencesFromStructure(structure, tableNameMap, tableUsages, objectName) {
        // Process main statements
        structure.statements.forEach(statement => {
            this._extractTableReferencesFromStatement(statement, tableNameMap, tableUsages, objectName);
        });
        
        // Process CTEs
        structure.ctes.forEach(cte => {
            this._extractTableReferencesFromCTE(cte, tableNameMap, tableUsages, objectName);
        });
        
        // Process subqueries
        structure.subqueries.forEach(subquery => {
            this._extractTableReferencesFromSubquery(subquery, tableNameMap, tableUsages, objectName);
        });
        
        // Process dynamic SQL
        structure.dynamicSql.forEach(dynamic => {
            this._extractTableReferencesFromDynamic(dynamic, tableNameMap, tableUsages, objectName);
        });
    }

    /**
     * Extract table references from a single statement
     * @private
     */
    _extractTableReferencesFromStatement(statement, tableNameMap, tableUsages, objectName) {
        const clauses = statement.clauses;
        
        // Process FROM clause
        if (clauses.FROM) {
            this._extractTableReferencesFromClause(clauses.FROM, 'FROM', tableNameMap, tableUsages, objectName);
        }
        
        // Process JOIN clauses
        Object.keys(clauses).forEach(clauseKey => {
            if (clauseKey.includes('JOIN')) {
                this._extractTableReferencesFromClause(clauses[clauseKey], 'JOIN', tableNameMap, tableUsages, objectName);
            }
        });
        
        // Process UPDATE clause
        if (clauses.SET && statement.type === 'UPDATE') {
            // Extract table from UPDATE statement beginning
            const updateMatch = statement.content.match(this._tablePatterns.updateTable);
            if (updateMatch) {
                this._processTableMatch(updateMatch[1], 'UPDATE', tableNameMap, tableUsages, objectName);
            }
        }
        
        // Process INSERT clause
        if (statement.type === 'INSERT') {
            const insertMatch = statement.content.match(this._tablePatterns.insertTable);
            if (insertMatch) {
                this._processTableMatch(insertMatch[1], 'INSERT', tableNameMap, tableUsages, objectName);
            }
        }
        
        // Process DELETE clause
        if (statement.type === 'DELETE') {
            const deleteMatch = statement.content.match(this._tablePatterns.deleteTable);
            if (deleteMatch) {
                this._processTableMatch(deleteMatch[1], 'DELETE', tableNameMap, tableUsages, objectName);
            }
        }
    }

    /**
     * Extract table references from a clause with proper alias handling
     * @private
     */
    _extractTableReferencesFromClause(clauseContent, clauseType, tableNameMap, tableUsages, objectName) {
        // Handle comma-separated tables in FROM clause
        if (clauseType === 'FROM') {
            const tables = clauseContent.split(',');
            tables.forEach(table => {
                const cleanTable = table.trim();
                const parts = cleanTable.split(/\s+/);
                if (parts.length > 0) {
                    const tableName = parts[0];
                    const alias = parts.length > 1 ? parts[parts.length - 1] : null;
                    
                    this._processTableMatch(tableName, 'SELECT', tableNameMap, tableUsages, objectName);
                    
                    // Track alias
                    if (alias && alias.toUpperCase() !== 'AS') {
                        this._aliases.set(alias.toUpperCase(), tableName);
                    }
                }
            });
        }
        
        // Handle JOIN clauses
        if (clauseType === 'JOIN') {
            const joinMatch = clauseContent.match(/^(\S+)(?:\s+(?:AS\s+)?(\S+))?\s+ON/i);
            if (joinMatch) {
                const tableName = joinMatch[1];
                const alias = joinMatch[2];
                
                this._processTableMatch(tableName, 'SELECT', tableNameMap, tableUsages, objectName);
                
                // Track alias
                if (alias) {
                    this._aliases.set(alias.toUpperCase(), tableName);
                }
            }
        }
    }

    /**
     * Process a potential table match with comprehensive validation
     * @private
     */
    _processTableMatch(tableName, operation, tableNameMap, tableUsages, objectName) {
        if (!tableName) return;
        
        // Clean table name
        const cleanedName = tableName.replace(/[\[\]]/g, '').trim();
        if (!cleanedName) return;
        
        // Check if it's an alias first
        const aliasResolved = this._aliases.get(cleanedName.toUpperCase());
        if (aliasResolved) {
            return this._processTableMatch(aliasResolved, operation, tableNameMap, tableUsages, objectName);
        }
        
        // Check if it's a temporary table
        if (this._temporaryTables.has(cleanedName.toUpperCase())) {
            return; // Skip temporary tables
        }
        
        // Look up in table map
        const tableInfo = this._findTableMatch(cleanedName, tableNameMap);
        if (tableInfo) {
            this._addTableUsage(tableUsages, tableInfo.originalName, [operation], 0, objectName);
        }
    }

    /**
     * Basic parsing fallback method
     * @private
     */
    async _parseTableUsagesBasic(sqlCode, tables, objectName) {
        const tableUsages = new Map();
        const tableNameMap = this._createSchemaAwareTableLookupMap(tables);
        
        // Use regex patterns for basic detection
        Object.entries(this._tablePatterns).forEach(([patternName, pattern]) => {
            pattern.lastIndex = 0; // Reset regex
            let match;
            
            while ((match = pattern.exec(sqlCode)) !== null) {
                const tableName = match[1];
                if (tableName) {
                    const operation = this._getOperationFromPattern(patternName);
                    this._processTableMatch(tableName, operation, tableNameMap, tableUsages, objectName);
                }
            }
        });
        
        return this._postProcessTableUsages(tableUsages);
    }

    /**
     * Simple parsing fallback (last resort)
     * @private
     */
    async _parseTableUsagesSimple(sqlCode, tables, objectName) {
        const tableUsages = new Map();
        const upperCode = sqlCode.toUpperCase();
        
        // Simple keyword-based detection
        tables.forEach(table => {
            const tableName = table.name.toUpperCase();
            const qualifiedName = (table.qualified_name || table.name).toUpperCase();
            
            if (upperCode.includes(tableName) || upperCode.includes(qualifiedName)) {
                this._addTableUsage(tableUsages, table.name, ['REFERENCE'], 0, objectName);
            }
        });
        
        return this._postProcessTableUsages(tableUsages);
    }

    /**
     * Robust SQL code cleaning
     * @private
     */
    _cleanSqlCodeRobust(sqlCode) {
        if (!sqlCode || typeof sqlCode !== 'string') {
            return '';
        }
        
        try {
            let cleaned = sqlCode;
            
            // Remove comments while preserving structure
            cleaned = this._removeComments(cleaned);
            
            // Remove string literals while preserving structure
            cleaned = this._removeStringLiterals(cleaned);
            
            // Normalize whitespace
            cleaned = cleaned.replace(/\s+/g, ' ').trim();
            
            // Convert to uppercase for consistent parsing
            cleaned = cleaned.toUpperCase();
            
            return cleaned;
            
        } catch (error) {
            console.warn('Error cleaning SQL code:', error);
            return sqlCode.toUpperCase();
        }
    }

    /**
     * Remove comments while preserving line structure
     * @private
     */
    _removeComments(sqlCode) {
        let result = '';
        let inLineComment = false;
        let inBlockComment = false;
        
        for (let i = 0; i < sqlCode.length; i++) {
            const char = sqlCode[i];
            const nextChar = i < sqlCode.length - 1 ? sqlCode[i + 1] : '';
            
            if (!inLineComment && !inBlockComment) {
                if (char === '-' && nextChar === '-') {
                    inLineComment = true;
                    i++; // Skip next char
                    result += ' '; // Replace with space
                } else if (char === '/' && nextChar === '*') {
                    inBlockComment = true;
                    i++; // Skip next char
                    result += ' '; // Replace with space
                } else {
                    result += char;
                }
            } else if (inLineComment) {
                if (char === '\n' || char === '\r') {
                    inLineComment = false;
                    result += char; // Preserve line breaks
                } else {
                    result += ' '; // Replace comment content with space
                }
            } else if (inBlockComment) {
                if (char === '*' && nextChar === '/') {
                    inBlockComment = false;
                    i++; // Skip next char
                    result += ' '; // Replace with space
                } else {
                    result += ' '; // Replace comment content with space
                }
            }
        }
        
        return result;
    }

    /**
     * Remove string literals while preserving structure
     * @private
     */
    _removeStringLiterals(sqlCode) {
        let result = '';
        let inString = false;
        let stringChar = '';
        
        for (let i = 0; i < sqlCode.length; i++) {
            const char = sqlCode[i];
            const prevChar = i > 0 ? sqlCode[i - 1] : '';
            
            if (!inString && (char === "'" || char === '"')) {
                inString = true;
                stringChar = char;
                result += char; // Keep opening quote
            } else if (inString && char === stringChar && prevChar !== '\\') {
                inString = false;
                stringChar = '';
                result += char; // Keep closing quote
            } else if (inString) {
                result += ' '; // Replace string content with space
            } else {
                result += char;
            }
        }
        
        return result;
    }

    /**
     * Handle parsing errors with proper classification
     * @private
     */
    _handleParseError(error, objectName, parseId) {
        this._errorStats.failedParses++;
        
        // Classify error type
        const errorType = error instanceof ParseError ? error.type : 'UNKNOWN_ERROR';
        this._errorStats.errorTypes[errorType] = (this._errorStats.errorTypes[errorType] || 0) + 1;
        
        console.error(`[${parseId}] Parse error for ${objectName}:`, error);
        
        return {
            dependsOn: [],
            referencedBy: [],
            metadata: {
                parseId,
                confidence: 0,
                method: 'failed',
                errors: [{
                    type: errorType,
                    message: error.message,
                    stack: error.stack
                }]
            }
        };
    }
    /**
    * Generate unique parse ID for tracking
    * @private
    */
   _generateParseId() {
       return `parse_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
   }

   /**
    * Create empty result structure
    * @private
    */
   _createEmptyResult() {
       return {
           dependsOn: [],
           referencedBy: [],
           metadata: {
               confidence: 1.0,
               method: 'empty',
               errors: []
           }
       };
   }

   /**
    * Get operation type from pattern name
    * @private
    */
   _getOperationFromPattern(patternName) {
       const operationMap = {
           fromClause: 'SELECT',
           joinClause: 'SELECT',
           updateTable: 'UPDATE',
           insertTable: 'INSERT',
           deleteTable: 'DELETE'
       };
       return operationMap[patternName] || 'REFERENCE';
   }

   /**
    * Enhanced table usage analysis with confidence scoring
    */
   async getTableUsageAnalysis(database, objectName) {
       try {
           if (!database || !objectName) {
               throw new Error('Database and object name are required');
           }
           
           const dependencies = await this.analyzeDependencies(database, objectName);
           
           // Calculate enhanced metrics
           const metrics = this._calculateEnhancedMetrics(dependencies.dependsOn);
           
           return {
               objectName: objectName,
               tablesUsed: dependencies.dependsOn,
               relatedObjects: [], // Computed separately if needed
               summary: {
                   totalTables: dependencies.dependsOn.length,
                   readTables: dependencies.dependsOn.filter(d => d.is_selected).length,
                   writeTables: dependencies.dependsOn.filter(d => d.is_updated || d.is_insert_all || d.is_delete).length,
                   operationCounts: metrics.operationCounts,
                   complexityScore: metrics.complexityScore,
                   confidenceScore: dependencies.metadata?.confidence || 0,
                   parseMethod: dependencies.metadata?.method || 'unknown',
                   serverVersion: this._serverVersion,
                   legacyMode: this._isLegacyServer
               }
           };
       } catch (error) {
           console.error(`Error in table usage analysis for ${objectName}:`, error);
           return {
               objectName: objectName,
               tablesUsed: [],
               relatedObjects: [],
               summary: { 
                   totalTables: 0, 
                   readTables: 0, 
                   writeTables: 0, 
                   operationCounts: {},
                   complexityScore: 0,
                   confidenceScore: 0,
                   parseMethod: 'error'
               }
           };
       }
   }

   /**
    * Calculate enhanced metrics for analysis
    * @private
    */
   _calculateEnhancedMetrics(tablesUsed) {
       const metrics = {
           operationCounts: {},
           complexityScore: 0
       };

       tablesUsed.forEach(table => {
           try {
               const operations = table.operations || [];
               operations.forEach(op => {
                   metrics.operationCounts[op] = (metrics.operationCounts[op] || 0) + 1;
               });
               
               // Calculate complexity score
               metrics.complexityScore += operations.length;
               if (table.has_cte) metrics.complexityScore += 2;
               if (table.has_subquery) metrics.complexityScore += 1;
               if (table.has_dynamic_sql) metrics.complexityScore += 3;
               metrics.complexityScore += (table.confidence || 0) * 0.1;
           } catch (error) {
               console.warn('Error calculating metrics for table:', error);
           }
       });
       
       return metrics;
   }

   /**
    * Check SQL Server version for compatibility
    * @private
    */
   async _checkServerVersion(database) {
       if (this._serverVersion === null) {
           try {
               // Try to detect version through available methods
               const result = await this._connectionManager.executeQuery('SELECT @@VERSION as version');
               if (result.recordset && result.recordset[0]) {
                   this._serverVersion = result.recordset[0].version;
                   // Parse major version
                   const versionMatch = this._serverVersion.match(/SQL Server (\d+)/);
                   const majorVersion = versionMatch ? parseInt(versionMatch[1]) : 14;
                   this._isLegacyServer = majorVersion < 15; // Before SQL Server 2019
               } else {
                   this._serverVersion = 'Unknown';
                   this._isLegacyServer = true; // Assume legacy for safety
               }
               
               console.log(`SQL Server version detected: ${this._serverVersion} (Legacy mode: ${this._isLegacyServer})`);
           } catch (error) {
               console.warn('Could not detect SQL Server version, using legacy mode:', error);
               this._serverVersion = 'Unknown';
               this._isLegacyServer = true;
           }
       }
   }

   /**
    * Get tables for database with improved caching and error handling
    * @private
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
           console.log(`Loading tables for database: ${database}`);
           const objects = await this._databaseService.getObjects(database);
           
           if (!Array.isArray(objects)) {
               throw new Error('Invalid objects array returned from database service');
           }
           
           const tables = objects.filter(obj => obj && obj.object_type === 'Table');
           
           // Manage cache size
           if (this._tablesCache.size >= this._maxCacheSize) {
               // Remove oldest entry
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
           
           console.log(`Loaded ${tables.length} tables for ${database}`);
           return tables;
           
       } catch (error) {
           console.error(`Error getting tables for ${database}:`, error);
           throw new Error(`Failed to load tables for database ${database}: ${error.message}`);
       }
   }

   /**
    * Get object definition with better error handling
    * @private
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
           
           // Get definition
           const definition = await this._databaseService.getObjectDefinition(database, objectName);
           
           if (!definition || definition.trim() === '') {
               if (objectInfo.is_encrypted) {
                   console.warn(`Object ${objectName} is encrypted, cannot analyze dependencies`);
                   return null;
               }
               
               console.warn(`Empty definition returned for ${objectName}`);
               return null;
           }
           
           console.log(`Successfully retrieved definition for ${objectName}`);
           return definition;
           
       } catch (error) {
           console.error(`Error getting definition for ${objectName}:`, error);
           return null;
       }
   }

   /**
    * Create schema-aware table lookup map
    * @private
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

               const tableInfo = {
                   originalName: table.name,
                   qualifiedName: table.qualified_name || table.name,
                   schema: table.schema_name || 'dbo',
                   objectName: table.object_name || table.name,
                   variations: new Set()
               };
               
               // Add all possible variations
               const variations = [
                   tableName,
                   objectName, 
                   qualifiedName,
                   `[${tableName}]`,
                   `[${objectName}]`,
                   `[${qualifiedName}]`,
                   `${schema}.${objectName}`,
                   `[${schema}].[${objectName}]`,
                   `${schema}.[${objectName}]`,
                   `[${schema}].${objectName}`,
                   `DBO.${objectName}`,
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
    * Find table match with enhanced lookup
    * @private
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
    * Add table usage with validation
    * @private
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
    * @private
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
    * @private
    */
   _convertToExpectedFormat(tableUsages, confidence = 1.0) {
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
                   // Enhanced metadata
                   has_cte: operations.includes('CTE') ? 1 : 0,
                   has_subquery: operations.includes('SUBQUERY') ? 1 : 0,
                   has_dynamic_sql: operations.includes('DYNAMIC_SQL') ? 1 : 0,
                   parse_confidence: confidence
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
                   has_dynamic_sql: 0,
                   parse_confidence: 0
               };
           }
       });
   }

   /**
    * Track temporary tables (CTEs, temp tables)
    * @private
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
    * Extract table references from CTE
    * @private
    */
   _extractTableReferencesFromCTE(cte, tableNameMap, tableUsages, objectName) {
       console.log(`Parsing CTE: ${cte.name}`);
       
       try {
           // Parse CTE content as a mini SQL statement
           const cteStructure = this._parseSqlStructure(cte.content);
           this._extractTableReferencesFromStructure(cteStructure, tableNameMap, tableUsages, objectName);
           
           // Track CTE as a temporary table
           this._trackTemporaryTable(cte.name, 'CTE', objectName);
           
       } catch (error) {
           console.warn(`Error parsing CTE ${cte.name}:`, error);
       }
   }

   /**
    * Extract table references from subquery
    * @private
    */
   _extractTableReferencesFromSubquery(subquery, tableNameMap, tableUsages, objectName) {
       console.log(`Parsing subquery at position ${subquery.startPos}`);
       
       try {
           const subqueryStructure = this._parseSqlStructure(subquery.content);
           this._extractTableReferencesFromStructure(subqueryStructure, tableNameMap, tableUsages, objectName);
           
       } catch (error) {
           console.warn(`Error parsing subquery at ${subquery.startPos}:`, error);
       }
   }

   /**
    * Extract table references from dynamic SQL
    * @private
    */
   _extractTableReferencesFromDynamic(dynamic, tableNameMap, tableUsages, objectName) {
       console.log(`Analyzing dynamic SQL: ${dynamic.type}`);
       
       try {
           // Try to extract static table names from dynamic SQL patterns
           const staticTableNames = this._extractStaticTableNames(dynamic.content);
           
           staticTableNames.forEach(tableName => {
               const tableInfo = this._findTableMatch(tableName, tableNameMap);
               if (tableInfo) {
                   this._addTableUsage(tableUsages, tableInfo.originalName, ['DYNAMIC_SQL'], dynamic.startPos, objectName);
               }
           });
           
       } catch (error) {
           console.warn(`Error parsing dynamic SQL:`, error);
       }
   }

   /**
    * Extract static table names from dynamic SQL patterns
    * @private
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
           pattern.lastIndex = 0;
           while ((match = pattern.exec(content)) !== null) {
               tableNames.push(match[1]);
           }
       });
       
       return [...new Set(tableNames)]; // Remove duplicates
   }

   /**
    * Clean up expired cache entries
    * @private
    */
   _cleanupExpiredCache() {
       const now = Date.now();
       let removed = 0;
       
       for (const [key, value] of this._cacheTimestamps) {
           if (now - value > this._cacheTimeout) {
               this._tablesCache.delete(key);
               this._cacheTimestamps.delete(key);
               removed++;
           }
       }
       
       // Clean up temporary tables older than 1 hour
       for (const [name, table] of this._temporaryTables) {
           if (now - table.created > 60 * 60 * 1000) {
               this._temporaryTables.delete(name);
           }
       }
       
       if (removed > 0) {
           console.log(`Cleaned up ${removed} expired cache entries`);
       }
   }

   /**
    * Clear cache for database or all
    */
   clearCache(database = null) {
       try {
           if (database) {
               const cacheKey = database.toUpperCase();
               this._tablesCache.delete(cacheKey);
               this._cacheTimestamps.delete(cacheKey);
               console.log(`Cache cleared for database: ${database}`);
           } else {
               this._tablesCache.clear();
               this._cacheTimestamps.clear();
               this._temporaryTables.clear();
               this._aliases.clear();
               console.log(`All cache cleared`);
           }
       } catch (error) {
           console.error('Error clearing cache:', error);
       }
   }

   /**
    * Get cache statistics and parsing metrics
    */
   getCacheStats() {
       const stats = {
           // Cache stats
           cachedDatabases: this._tablesCache.size,
           maxCacheSize: this._maxCacheSize,
           cacheTimeout: this._cacheTimeout,
           temporaryTables: this._temporaryTables.size,
           
           // Server info
           serverVersion: this._serverVersion,
           isLegacyServer: this._isLegacyServer,
           
           // Parsing statistics
           parsingStats: { ...this._errorStats },
           
           // Success rate
           successRate: this._errorStats.totalParses > 0 
               ? (this._errorStats.successfulParses / this._errorStats.totalParses * 100).toFixed(2) + '%'
               : '0%',
               
           // Cache details
           cacheEntries: Array.from(this._cacheTimestamps.entries()).map(([db, timestamp]) => ({
               database: db,
               age: Date.now() - timestamp,
               expired: (Date.now() - timestamp) > this._cacheTimeout
           }))
       };
       
       return stats;
   }

   /**
    * Clean up resources and timers
    */
   dispose() {
       // Clean up timer
       if (this._cleanupInterval) {
           clearInterval(this._cleanupInterval);
           this._cleanupInterval = null;
       }
       
       // Clear caches
       this._tablesCache.clear();
       this._cacheTimestamps.clear();
       this._temporaryTables.clear();
       this._aliases.clear();
       
       // Clear references
       this._connectionManager = null;
       this._databaseService = null;
       
       console.log('SmartSqlParser disposed');
   }
}

/**
* Custom error class for parsing errors
*/
class ParseError extends Error {
   constructor(type, message, originalError = null) {
       super(message);
       this.name = 'ParseError';
       this.type = type;
       this.originalError = originalError;
       this.timestamp = new Date().toISOString();
   }
}

module.exports = SmartSqlParser;