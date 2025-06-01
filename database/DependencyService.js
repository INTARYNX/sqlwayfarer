'use strict';

/**
 * Handles database object dependency analysis
 * Provides services to find object dependencies and relationships
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
}

module.exports = DependencyService;