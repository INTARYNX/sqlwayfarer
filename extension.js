'use strict';

const vscode = require('vscode');
const sql = require('mssql');
const path = require('path');
const fs = require('fs');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('Congratulations, your extension "sqlwayfarer" is now active!');

    // Original Hello World command
    const helloWorldDisposable = vscode.commands.registerCommand('sqlwayfarer.helloWorld', function () {
        vscode.window.showInformationMessage('Hello World from sqlwayfarer!');
    });

    // SQL Wayfarer command
    const sqlWayfarerDisposable = vscode.commands.registerCommand('sqlwayfarer.sqlwayfarer', function () {
        console.log('sqlwayfarer.sqlwayfarer command executed');
        SqlWayfarerPanel.createOrShow(context.extensionUri);
    });

    context.subscriptions.push(helloWorldDisposable);
    context.subscriptions.push(sqlWayfarerDisposable);
    console.log('sqlwayfarer extension with SQL Wayfarer activated successfully');
}

class SqlWayfarerPanel {
    /**
     * @param {vscode.Uri} extensionUri
     */
    constructor(panel, extensionUri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._disposables = [];
        this._connection = null;

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'connect':
                        this._connect(message.connectionString);
                        return;
                    case 'getDatabases':
                        this._getDatabases();
                        return;
                    case 'getObjects':
                        this._getObjects(message.database);
                        return;
                    case 'getTableDetails':
                        this._getTableDetails(message.database, message.table);
                        return;
                    case 'getObjectDetails':
                        this._getObjectDetails(message.database, message.objectName, message.objectType);
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    static createOrShow(extensionUri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (SqlWayfarerPanel.currentPanel) {
            SqlWayfarerPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'sqlwayfarer-sqlwayfarer',
            'SQL Wayfarer',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri]
            }
        );

        SqlWayfarerPanel.currentPanel = new SqlWayfarerPanel(panel, extensionUri);
    }

    async _connect(connectionString) {
        try {
            if (this._connection) {
                await this._connection.close();
            }
            
            this._connection = await sql.connect(connectionString);
            
            this._panel.webview.postMessage({
                command: 'connectionStatus',
                success: true,
                message: 'Connected successfully!'
            });
            
            // Automatically get databases after connection
            this._getDatabases();
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'connectionStatus',
                success: false,
                message: `Connection failed: ${error.message}`
            });
        }
    }

    async _getDatabases() {
        try {
            if (!this._connection) {
                throw new Error('No active connection');
            }

            const result = await this._connection.request().query(`
                SELECT name FROM sys.databases 
                WHERE name NOT IN ('master', 'tempdb', 'model', 'msdb')
                ORDER BY name
            `);

            this._panel.webview.postMessage({
                command: 'databasesLoaded',
                databases: result.recordset.map(row => row.name)
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'error',
                message: `Failed to get databases: ${error.message}`
            });
        }
    }

    async _getObjects(database) {
        try {
            if (!this._connection) {
                throw new Error('No active connection');
            }

            const result = await this._connection.request().query(`
                USE [${database}];
                SELECT 
                    name,
                    type_desc,
                    CASE 
                        WHEN type = 'U' THEN 'Table'
                        WHEN type = 'V' THEN 'View'
                        WHEN type = 'P' THEN 'Procedure'
                        WHEN type = 'FN' THEN 'Function'
                        ELSE type_desc
                    END as object_type
                FROM sys.objects 
                WHERE type IN ('U', 'V', 'P', 'FN')
                ORDER BY type, name
            `);

            this._panel.webview.postMessage({
                command: 'objectsLoaded',
                objects: result.recordset
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'error',
                message: `Failed to get objects: ${error.message}`
            });
        }
    }

    async _getTableDetails(database, tableName) {
        try {
            if (!this._connection) {
                throw new Error('No active connection');
            }

            // Get columns
            const columnsResult = await this._connection.request().query(`
                USE [${database}];
                SELECT 
                    COLUMN_NAME,
                    DATA_TYPE,
                    IS_NULLABLE,
                    COLUMN_DEFAULT,
                    CHARACTER_MAXIMUM_LENGTH
                FROM INFORMATION_SCHEMA.COLUMNS 
                WHERE TABLE_NAME = '${tableName}'
                ORDER BY ORDINAL_POSITION
            `);

            // Get indexes
            const indexesResult = await this._connection.request().query(`
                USE [${database}];
                SELECT 
                    i.name as index_name,
                    i.type_desc,
                    i.is_unique,
                    i.is_primary_key,
                    STRING_AGG(c.name, ', ') as columns
                FROM sys.indexes i
                JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
                WHERE i.object_id = OBJECT_ID('${tableName}')
                AND i.type > 0
                GROUP BY i.name, i.type_desc, i.is_unique, i.is_primary_key
                ORDER BY i.is_primary_key DESC, i.name
            `);

            // Get foreign keys
            const fkResult = await this._connection.request().query(`
                USE [${database}];
                SELECT 
                    fk.name as fk_name,
                    OBJECT_NAME(fk.parent_object_id) as table_name,
                    c1.name as column_name,
                    OBJECT_NAME(fk.referenced_object_id) as referenced_table,
                    c2.name as referenced_column
                FROM sys.foreign_keys fk
                JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
                JOIN sys.columns c1 ON fkc.parent_object_id = c1.object_id AND fkc.parent_column_id = c1.column_id
                JOIN sys.columns c2 ON fkc.referenced_object_id = c2.object_id AND fkc.referenced_column_id = c2.column_id
                WHERE OBJECT_NAME(fk.parent_object_id) = '${tableName}'
            `);

            // Get dependencies for table
            const dependenciesResult = await this._getDependencies(database, tableName);

            this._panel.webview.postMessage({
                command: 'tableDetailsLoaded',
                tableName: tableName,
                columns: columnsResult.recordset,
                indexes: indexesResult.recordset,
                foreignKeys: fkResult.recordset,
                dependencies: dependenciesResult
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'error',
                message: `Failed to get table details: ${error.message}`
            });
        }
    }

    async _getObjectDetails(database, objectName, objectType) {
        try {
            if (!this._connection) {
                throw new Error('No active connection');
            }

            // Get dependencies for any object type
            const dependenciesResult = await this._getDependencies(database, objectName);

            // Get object definition for views, procedures, functions
            let definition = null;
            if (objectType !== 'Table') {
                const definitionResult = await this._connection.request().query(`
                    USE [${database}];
                    SELECT OBJECT_DEFINITION(OBJECT_ID('${objectName}')) as definition
                `);
                definition = definitionResult.recordset[0]?.definition;
            }

            this._panel.webview.postMessage({
                command: 'objectDetailsLoaded',
                objectName: objectName,
                objectType: objectType,
                dependencies: dependenciesResult,
                definition: definition
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'error',
                message: `Failed to get object details: ${error.message}`
            });
        }
    }

    async _getDependencies(database, objectName) {
        try {
            // Method 1: sys.sql_expression_dependencies (corrected for SQL Server 2022)
            const dependsOnResult = await this._connection.request().query(`
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
                
                -- Method 2: Foreign Key dependencies for tables
                SELECT DISTINCT
                    OBJECT_NAME(fk.referenced_object_id) as referenced_object,
                    'Table' as referenced_object_type,
                    'Foreign Key' as dependency_type
                FROM sys.foreign_keys fk
                WHERE OBJECT_NAME(fk.parent_object_id) = '${objectName}'
                
                ORDER BY referenced_object
            `);

            const referencedByResult = await this._connection.request().query(`
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
                
                -- Tables referenced by foreign keys
                SELECT DISTINCT
                    OBJECT_NAME(fk.parent_object_id) as referencing_object,
                    'Table' as referencing_object_type,
                    'Foreign Key' as dependency_type
                FROM sys.foreign_keys fk
                WHERE OBJECT_NAME(fk.referenced_object_id) = '${objectName}'
                
                ORDER BY referencing_object
            `);

            // Method 3: Alternative approach using sys.dm_sql_referenced_entities
            let alternativeDependsOn = [];
            
            try {
                const altDependsResult = await this._connection.request().query(`
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
                alternativeDependsOn = altDependsResult.recordset;
            } catch (e) {
                // sys.dm_sql_referenced_entities might not be available or object might not exist
                console.log('Alternative dependency method not available:', e.message);
            }

            // Method 4: Additional approach for comprehensive dependency tracking
            let additionalDependencies = [];
            try {
                const additionalResult = await this._connection.request().query(`
                    USE [${database}];
                    -- Get dependencies from sys.sql_modules for procedures, functions, views
                    SELECT DISTINCT
                        d.referenced_entity_name as referenced_object,
                        CASE 
                            WHEN o.type = 'U' THEN 'Table'
                            WHEN o.type = 'V' THEN 'View'
                            WHEN o.type = 'P' THEN 'Procedure'
                            WHEN o.type IN ('FN', 'IF', 'TF') THEN 'Function'
                            ELSE 'Object'
                        END as referenced_object_type,
                        'Module Reference' as dependency_type
                    FROM sys.objects parent
                    CROSS APPLY sys.dm_sql_referenced_entities(SCHEMA_NAME(parent.schema_id) + '.' + parent.name, 'OBJECT') d
                    LEFT JOIN sys.objects o ON o.name = d.referenced_entity_name
                    WHERE parent.name = '${objectName}'
                    AND d.referenced_entity_name IS NOT NULL
                    AND parent.type IN ('P', 'V', 'FN', 'IF', 'TF')
                `);
                additionalDependencies = additionalResult.recordset;
            } catch (e) {
                console.log('Additional dependency method not available:', e.message);
            }

            // Combine results and remove duplicates
            const allDependsOn = [...dependsOnResult.recordset, ...alternativeDependsOn, ...additionalDependencies];
            const allReferencedBy = [...referencedByResult.recordset];

            // Remove duplicates based on object name
            const uniqueDependsOn = allDependsOn.filter((item, index, self) => 
                item.referenced_object && 
                index === self.findIndex(t => t.referenced_object === item.referenced_object)
            );
            
            const uniqueReferencedBy = allReferencedBy.filter((item, index, self) => 
                item.referencing_object &&
                index === self.findIndex(t => t.referencing_object === item.referencing_object)
            );

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

    _update() {
        this._panel.title = 'SQL Wayfarer';
        this._panel.webview.html = this._getHtmlForWebview();
    }

    _getHtmlForWebview() {
        // Get file URIs
        const stylesUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'webview', 'styles.css')
        );
        
        const scriptUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'webview', 'script.js')
        );

        // Read the HTML template
        const htmlPath = path.join(this._extensionUri.fsPath, 'webview', 'index.html');
        let html = fs.readFileSync(htmlPath, 'utf8');
        
        // Replace placeholders with actual URIs
        html = html.replace('{{STYLES_URI}}', stylesUri.toString());
        html = html.replace('{{SCRIPT_URI}}', scriptUri.toString());
        
        return html;
    }

    dispose() {
        SqlWayfarerPanel.currentPanel = undefined;

        this._panel.dispose();

        if (this._connection) {
            this._connection.close();
        }

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}

// Initialize static property
SqlWayfarerPanel.currentPanel = undefined;

function deactivate() {}

module.exports = {
    activate,
    deactivate
};