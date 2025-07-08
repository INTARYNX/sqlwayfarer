'use strict';

/**
 * Handles database object dependency analysis and table usage tracking
 * Provides services to find object dependencies and table relationships
 */
class DependencyService {
    constructor(connectionManager) {
        this._connectionManager = connectionManager;
    }

    /**
     * Get comprehensive dependencies for a database object
     * @param {string} database - Database name
     * @param {string} objectName - Object name
     * @returns {Promise<Object>} Dependencies object with dependsOn and referencedBy arrays
     */
    async getDependencies(database, objectName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            // Get objects this object depends on
            const dependsOnResult = await this._getDependsOn(database, objectName);
            
            // Get objects that reference this object
            const referencedByResult = await this._getReferencedBy(database, objectName);
            
            // Get alternative dependencies using dm_sql_referenced_entities
            const alternativeDependencies = await this._getAlternativeDependencies(database, objectName);

            // Combine and deduplicate results
            const allDependsOn = [...dependsOnResult, ...alternativeDependencies];
            const uniqueDependsOn = this._removeDuplicateDependencies(allDependsOn);
            const uniqueReferencedBy = this._removeDuplicateDependencies(referencedByResult);

            return {
                dependsOn: uniqueDependsOn,
                referencedBy: uniqueReferencedBy
            };
        } catch (error) {
            console.error('Error getting dependencies:', error);
            return {
                dependsOn: [],
                referencedBy: []
            };
        }
    }

    /**
     * Get comprehensive table usage analysis for a database object
     * @param {string} database - Database name
     * @param {string} objectName - Object name (procedure, function, trigger, view)
     * @returns {Promise<Object>} Table usage analysis with read/write operations
     */
    async getTableUsageAnalysis(database, objectName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            // Get all table references for this object
            const tableReferences = await this._getTableReferences(database, objectName);
            
            // Get objects that use the same tables (for reverse analysis)
            const relatedObjects = await this._getObjectsUsingTables(database, tableReferences.map(t => t.table_name));
            
            return {
                objectName: objectName,
                tablesUsed: tableReferences,
                relatedObjects: relatedObjects,
                summary: this._generateUsageSummary(tableReferences)
            };
        } catch (error) {
            console.error('Error getting table usage analysis:', error);
            return {
                objectName: objectName,
                tablesUsed: [],
                relatedObjects: [],
                summary: { totalTables: 0, readTables: 0, writeTables: 0 }
            };
        }
    }

    /**
     * Get all tables referenced by a specific object
     * @param {string} database - Database name
     * @param {string} objectName - Object name
     * @returns {Promise<Array<Object>>} Array of table references with usage type
     * @private
     */
    async _getTableReferences(database, objectName) {
        // Try the more advanced method first, fall back to basic if it fails
        try {
            const result = await this._connectionManager.executeQuery(`
                USE [${database}];
                
                -- Try dm_sql_referenced_entities first (SQL Server 2008+)
                SELECT DISTINCT
                    r.referenced_entity_name as table_name,
                    'Table' as object_type,
                    'Reference' as usage_type,
                    'REFERENCE' as operation_type,
                    0 as is_select_all,
                    0 as is_updated,
                    0 as is_insert_all,
                    0 as is_delete
                FROM sys.dm_sql_referenced_entities('dbo.${objectName}', 'OBJECT') r
                JOIN sys.objects o ON o.name = r.referenced_entity_name
                WHERE o.type = 'U'  -- Only user tables
                AND r.referenced_class_desc = 'OBJECT_OR_COLUMN'
                AND r.referenced_entity_name IS NOT NULL
                
                ORDER BY table_name
            `);
            
            if (result.recordset.length > 0) {
                return result.recordset.filter(row => row.table_name);
            }
        } catch (error) {
            console.log('dm_sql_referenced_entities not available, trying basic method');
        }

        // Fallback to basic sys.sql_expression_dependencies (without is_select_all)
        try {
            const result = await this._connectionManager.executeQuery(`
                USE [${database}];
                
                -- Basic table references from sys.sql_expression_dependencies
                SELECT DISTINCT
                    OBJECT_NAME(sed.referenced_id) as table_name,
                    'Table' as object_type,
                    'Reference' as usage_type,
                    'SELECT' as operation_type,
                    0 as is_select_all,
                    0 as is_updated,
                    0 as is_insert_all,
                    0 as is_delete
                FROM sys.sql_expression_dependencies sed
                JOIN sys.objects o ON sed.referenced_id = o.object_id
                WHERE OBJECT_NAME(sed.referencing_id) = '${objectName}'
                AND o.type = 'U'  -- Only user tables
                AND sed.referenced_id > 0
                
                ORDER BY table_name
            `);
            
            return result.recordset.filter(row => row.table_name);
        } catch (error) {
            console.log('sys.sql_expression_dependencies failed, trying most basic method');
        }

        // Most basic fallback - just look for any dependencies
        const result = await this._connectionManager.executeQuery(`
            USE [${database}];
            
            -- Most basic dependency detection
            SELECT DISTINCT
                OBJECT_NAME(d.object_id) as table_name,
                'Table' as object_type,
                'Reference' as usage_type,
                'UNKNOWN' as operation_type,
                0 as is_select_all,
                0 as is_updated,
                0 as is_insert_all,
                0 as is_delete
            FROM sys.sql_dependencies d
            JOIN sys.objects o ON d.object_id = o.object_id
            WHERE OBJECT_NAME(d.referenced_major_id) = '${objectName}'
            AND o.type = 'U'  -- Only user tables
            
            ORDER BY table_name
        `);

        return result.recordset.filter(row => row.table_name);
    }

    /**
     * Get all objects that use specific tables
     * @param {string} database - Database name
     * @param {Array<string>} tableNames - Array of table names
     * @returns {Promise<Array<Object>>} Array of objects using these tables
     * @private
     */
    async _getObjectsUsingTables(database, tableNames) {
        if (!tableNames || tableNames.length === 0) {
            return [];
        }

        const tableList = tableNames.map(name => `'${name}'`).join(',');
        
        // Try modern method first
        try {
            const result = await this._connectionManager.executeQuery(`
                USE [${database}];
                
                SELECT DISTINCT
                    OBJECT_NAME(sed.referencing_id) as object_name,
                    CASE 
                        WHEN o.type = 'P' THEN 'Procedure'
                        WHEN o.type = 'V' THEN 'View'
                        WHEN o.type IN ('FN', 'IF', 'TF') THEN 'Function'
                        WHEN o.type = 'TR' THEN 'Trigger'
                        ELSE o.type_desc
                    END as object_type,
                    OBJECT_NAME(sed.referenced_id) as table_name,
                    'SELECT' as operation_type
                FROM sys.sql_expression_dependencies sed
                JOIN sys.objects o ON sed.referencing_id = o.object_id
                WHERE OBJECT_NAME(sed.referenced_id) IN (${tableList})
                AND o.type IN ('P', 'V', 'FN', 'IF', 'TF', 'TR')  -- Procedures, Views, Functions, Triggers
                AND OBJECT_NAME(sed.referencing_id) IS NOT NULL
                
                ORDER BY object_name, table_name
            `);
            
            return result.recordset;
        } catch (error) {
            console.log('sys.sql_expression_dependencies failed for objects using tables, trying fallback');
        }

        // Basic fallback method
        try {
            const result = await this._connectionManager.executeQuery(`
                USE [${database}];
                
                SELECT DISTINCT
                    OBJECT_NAME(d.referenced_major_id) as object_name,
                    CASE 
                        WHEN o.type = 'P' THEN 'Procedure'
                        WHEN o.type = 'V' THEN 'View'
                        WHEN o.type IN ('FN', 'IF', 'TF') THEN 'Function'
                        WHEN o.type = 'TR' THEN 'Trigger'
                        ELSE o.type_desc
                    END as object_type,
                    OBJECT_NAME(d.object_id) as table_name,
                    'REFERENCE' as operation_type
                FROM sys.sql_dependencies d
                JOIN sys.objects o ON d.referenced_major_id = o.object_id
                WHERE OBJECT_NAME(d.object_id) IN (${tableList})
                AND o.type IN ('P', 'V', 'FN', 'IF', 'TF', 'TR')
                AND OBJECT_NAME(d.referenced_major_id) IS NOT NULL
                
                ORDER BY object_name, table_name
            `);
            
            return result.recordset;
        } catch (error) {
            console.log('All dependency detection methods failed');
            return [];
        }
    }

    /**
     * Get detailed trigger analysis
     * @param {string} database - Database name
     * @returns {Promise<Array<Object>>} Array of triggers with their table associations
     */
    async getTriggerAnalysis(database) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

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
    }

    /**
     * Get table-centric view: for a specific table, show all objects that use it
     * @param {string} database - Database name
     * @param {string} tableName - Table name
     * @returns {Promise<Object>} Complete analysis of what uses this table
     */
    async getTableUsageByObjects(database, tableName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            // Get all objects that reference this table
            const objectReferences = await this._getObjectsUsingTables(database, [tableName]);
            
            // Get triggers on this table
            const triggers = await this._connectionManager.executeQuery(`
                USE [${database}];
                SELECT 
                    t.name as object_name,
                    'Trigger' as object_type,
                    '${tableName}' as table_name,
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
                    END as operation_type
                FROM sys.triggers t
                WHERE OBJECT_NAME(t.parent_id) = '${tableName}'
                AND t.parent_class = 1
            `);

            // Get foreign key relationships
            const foreignKeys = await this._connectionManager.executeQuery(`
                USE [${database}];
                SELECT 
                    OBJECT_NAME(fk.parent_object_id) as object_name,
                    'Table' as object_type,
                    '${tableName}' as table_name,
                    'FOREIGN KEY' as operation_type
                FROM sys.foreign_keys fk
                WHERE OBJECT_NAME(fk.referenced_object_id) = '${tableName}'
                
                UNION ALL
                
                SELECT 
                    '${tableName}' as object_name,
                    'Table' as object_type,
                    OBJECT_NAME(fk.referenced_object_id) as table_name,
                    'REFERENCES' as operation_type
                FROM sys.foreign_keys fk
                WHERE OBJECT_NAME(fk.parent_object_id) = '${tableName}'
            `);

            // Combine all results
            const allReferences = [
                ...objectReferences,
                ...triggers.recordset,
                ...foreignKeys.recordset
            ];

            return {
                tableName: tableName,
                usedByObjects: allReferences,
                summary: this._generateTableUsageSummary(allReferences)
            };
        } catch (error) {
            console.error('Error getting table usage by objects:', error);
            return {
                tableName: tableName,
                usedByObjects: [],
                summary: { totalObjects: 0, procedures: 0, views: 0, functions: 0, triggers: 0, tables: 0 }
            };
        }
    }

    /**
     * Get objects that this object depends on
     * @param {string} database - Database name
     * @param {string} objectName - Object name
     * @returns {Promise<Array<Object>>} Array of dependency objects
     * @private
     */
    async _getDependsOn(database, objectName) {
        const result = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT DISTINCT
                OBJECT_NAME(sed.referenced_id) as referenced_object,
                CASE 
                    WHEN o.type = 'U' THEN 'Table'
                    WHEN o.type = 'V' THEN 'View'
                    WHEN o.type = 'P' THEN 'Procedure'
                    WHEN o.type IN ('FN', 'IF', 'TF') THEN 'Function'
                    ELSE o.type_desc
                END as referenced_object_type,
                'Expression' as dependency_type
            FROM sys.sql_expression_dependencies sed
            JOIN sys.objects o ON sed.referenced_id = o.object_id
            WHERE OBJECT_NAME(sed.referencing_id) = '${objectName}'
            AND sed.referenced_id > 0
            AND OBJECT_NAME(sed.referenced_id) IS NOT NULL
            
            UNION ALL
            
            -- Foreign Key dependencies for tables
            SELECT DISTINCT
                OBJECT_NAME(fk.referenced_object_id) as referenced_object,
                'Table' as referenced_object_type,
                'Foreign Key' as dependency_type
            FROM sys.foreign_keys fk
            WHERE OBJECT_NAME(fk.parent_object_id) = '${objectName}'
            
            ORDER BY referenced_object
        `);

        return result.recordset.filter(row => row.referenced_object);
    }

    /**
     * Get objects that reference this object
     * @param {string} database - Database name
     * @param {string} objectName - Object name
     * @returns {Promise<Array<Object>>} Array of referencing objects
     * @private
     */
    async _getReferencedBy(database, objectName) {
        const result = await this._connectionManager.executeQuery(`
            USE [${database}];
            SELECT DISTINCT
                OBJECT_NAME(sed.referencing_id) as referencing_object,
                CASE 
                    WHEN o.type = 'U' THEN 'Table'
                    WHEN o.type = 'V' THEN 'View'
                    WHEN o.type = 'P' THEN 'Procedure'
                    WHEN o.type IN ('FN', 'IF', 'TF') THEN 'Function'
                    ELSE o.type_desc
                END as referencing_object_type,
                'Expression' as dependency_type
            FROM sys.sql_expression_dependencies sed
            JOIN sys.objects o ON sed.referencing_id = o.object_id
            WHERE OBJECT_NAME(sed.referenced_id) = '${objectName}'
            AND OBJECT_NAME(sed.referencing_id) IS NOT NULL
            
            UNION ALL
            
            -- Tables that reference this table via foreign keys
            SELECT DISTINCT
                OBJECT_NAME(fk.parent_object_id) as referencing_object,
                'Table' as referencing_object_type,
                'Foreign Key' as dependency_type
            FROM sys.foreign_keys fk
            WHERE OBJECT_NAME(fk.referenced_object_id) = '${objectName}'
            
            ORDER BY referencing_object
        `);

        return result.recordset.filter(row => row.referencing_object);
    }

    /**
     * Get alternative dependencies using sys.dm_sql_referenced_entities
     * @param {string} database - Database name
     * @param {string} objectName - Object name
     * @returns {Promise<Array<Object>>} Array of dependency objects
     * @private
     */
    async _getAlternativeDependencies(database, objectName) {
        try {
            const result = await this._connectionManager.executeQuery(`
                USE [${database}];
                SELECT DISTINCT
                    referenced_entity_name as referenced_object,
                    CASE 
                        WHEN referenced_class_desc = 'OBJECT_OR_COLUMN' THEN 
                            CASE 
                                WHEN o.type = 'U' THEN 'Table'
                                WHEN o.type = 'V' THEN 'View'
                                WHEN o.type = 'P' THEN 'Procedure'
                                WHEN o.type IN ('FN', 'IF', 'TF') THEN 'Function'
                                ELSE 'Object'
                            END
                        ELSE referenced_class_desc
                    END as referenced_object_type,
                    'Reference' as dependency_type
                FROM sys.dm_sql_referenced_entities('dbo.${objectName}', 'OBJECT') r
                LEFT JOIN sys.objects o ON o.name = r.referenced_entity_name
                WHERE referenced_entity_name IS NOT NULL
                AND referenced_schema_name IS NOT NULL
            `);
            
            return result.recordset.filter(row => row.referenced_object);
        } catch (error) {
            console.log('Alternative dependency method not available:', error.message);
            return [];
        }
    }

    /**
     * Remove duplicate dependencies based on object name
     * @param {Array<Object>} dependencies - Array of dependency objects
     * @returns {Array<Object>} Deduplicated array
     * @private
     */
    _removeDuplicateDependencies(dependencies) {
        const seen = new Set();
        return dependencies.filter(dep => {
            const key = dep.referenced_object || dep.referencing_object;
            if (!key || seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }

    /**
     * Get dependency tree for an object (multi-level dependencies)
     * @param {string} database - Database name
     * @param {string} objectName - Object name
     * @param {number} maxDepth - Maximum depth to traverse (default: 3)
     * @returns {Promise<Object>} Dependency tree
     */
    async getDependencyTree(database, objectName, maxDepth = 3) {
        const visited = new Set();
        const tree = {
            name: objectName,
            dependencies: [],
            level: 0
        };

        await this._buildDependencyTree(database, objectName, tree, visited, maxDepth, 0);
        return tree;
    }

    /**
     * Recursively build dependency tree
     * @param {string} database - Database name
     * @param {string} objectName - Object name
     * @param {Object} node - Current tree node
     * @param {Set} visited - Set of visited objects
     * @param {number} maxDepth - Maximum depth
     * @param {number} currentDepth - Current depth
     * @private
     */
    async _buildDependencyTree(database, objectName, node, visited, maxDepth, currentDepth) {
        if (currentDepth >= maxDepth || visited.has(objectName)) {
            return;
        }

        visited.add(objectName);
        const dependencies = await this.getDependencies(database, objectName);

        for (const dep of dependencies.dependsOn) {
            const childNode = {
                name: dep.referenced_object,
                type: dep.referenced_object_type,
                dependency_type: dep.dependency_type,
                dependencies: [],
                level: currentDepth + 1
            };

            node.dependencies.push(childNode);

            // Recursively get dependencies for this object
            await this._buildDependencyTree(
                database, 
                dep.referenced_object, 
                childNode, 
                visited, 
                maxDepth, 
                currentDepth + 1
            );
        }
    }

    /**
     * Find circular dependencies in the database
     * @param {string} database - Database name
     * @returns {Promise<Array<Array<string>>>} Array of circular dependency chains
     */
    async findCircularDependencies(database) {
        // This is a complex operation that would require graph analysis
        // For now, return empty array - can be implemented later if needed
        console.log(`Circular dependency detection for database ${database} not implemented yet`);
        return [];
    }

    /**
     * Get impact analysis for an object (what would be affected if this object changes)
     * @param {string} database - Database name
     * @param {string} objectName - Object name
     * @returns {Promise<Array<Object>>} Array of impacted objects
     */
    async getImpactAnalysis(database, objectName) {
        const dependencies = await this.getDependencies(database, objectName);
        
        // Objects that would be impacted are those that reference this object
        return dependencies.referencedBy.map(dep => ({
            object: dep.referencing_object,
            type: dep.referencing_object_type,
            impact_type: dep.dependency_type,
            severity: this._calculateImpactSeverity(dep.referencing_object_type)
        }));
    }

    /**
     * Calculate impact severity based on object type
     * @param {string} objectType - Type of the impacted object
     * @returns {string} Severity level
     * @private
     */
    _calculateImpactSeverity(objectType) {
        switch (objectType) {
            case 'Table':
                return 'High'; // Tables are critical
            case 'View':
                return 'Medium'; // Views can usually be recreated
            case 'Procedure':
                return 'Medium'; // Procedures contain business logic
            case 'Function':
                return 'Low'; // Functions are usually more isolated
            default:
                return 'Unknown';
        }
    }

    /**
     * Generate usage summary for an object's table usage
     * @param {Array<Object>} tableReferences - Array of table references
     * @returns {Object} Usage summary
     * @private
     */
    _generateUsageSummary(tableReferences) {
        const summary = {
            totalTables: tableReferences.length,
            readTables: 0,
            writeTables: 0,
            operationTypes: {}
        };

        tableReferences.forEach(ref => {
            const opType = ref.operation_type || 'UNKNOWN';
            summary.operationTypes[opType] = (summary.operationTypes[opType] || 0) + 1;

            if (opType === 'SELECT' || opType === 'SELECT *' || opType === 'REFERENCE') {
                summary.readTables++;
            } else if (opType === 'UPDATE' || opType === 'INSERT' || opType === 'DELETE') {
                summary.writeTables++;
            }
        });

        return summary;
    }

    /**
     * Generate table usage summary for a specific table
     * @param {Array<Object>} objectReferences - Array of object references
     * @returns {Object} Usage summary
     * @private
     */
    _generateTableUsageSummary(objectReferences) {
        const summary = {
            totalObjects: objectReferences.length,
            procedures: 0,
            views: 0,
            functions: 0,
            triggers: 0,
            tables: 0
        };

        objectReferences.forEach(ref => {
            const objType = ref.object_type || 'Unknown';
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
}

module.exports = DependencyService;