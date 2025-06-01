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
        SqlWayfarerPanel.createOrShow(context.extensionUri, context);
    });

    context.subscriptions.push(helloWorldDisposable);
    context.subscriptions.push(sqlWayfarerDisposable);
    console.log('sqlwayfarer extension with SQL Wayfarer activated successfully');
}

class SqlWayfarerPanel {
    /**
     * @param {vscode.Uri} extensionUri
     * @param {vscode.ExtensionContext} context
     */
    constructor(panel, extensionUri, context) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._context = context;
        this._disposables = [];
        this._connection = null;
        this._savedConnections = new Map();

        this._loadSavedConnections();
        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'connect':
                        this._connect(message.connectionConfig);
                        return;
                    case 'saveConnection':
                        this._saveConnection(message.connectionConfig);
                        return;
                    case 'deleteConnection':
                        this._deleteConnection(message.connectionName);
                        return;
                    case 'loadConnections':
                        this._sendSavedConnections();
                        return;
                    case 'testConnection':
                        this._testConnection(message.connectionConfig);
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

    static createOrShow(extensionUri, context) {
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

        SqlWayfarerPanel.currentPanel = new SqlWayfarerPanel(panel, extensionUri, context);
    }

    async _loadSavedConnections() {
        try {
            // Load connections from VS Code secrets storage
            const savedConnectionsJson = await this._context.secrets.get('sqlwayfarer.connections');
            if (savedConnectionsJson) {
                const connections = JSON.parse(savedConnectionsJson);
                this._savedConnections = new Map(Object.entries(connections));
            }
        } catch (error) {
            console.error('Error loading saved connections:', error);
        }
    }

    async _saveConnection(connectionConfig) {
        try {
            // Store password securely in VS Code secrets
            const connectionName = connectionConfig.name;
            const password = connectionConfig.password;
            
            // Save password in secrets storage
            await this._context.secrets.store(`sqlwayfarer.password.${connectionName}`, password);
            
            // Save connection config without password
            const connectionConfigWithoutPassword = {
                ...connectionConfig,
                password: undefined // Remove password from stored config
            };
            
            this._savedConnections.set(connectionName, connectionConfigWithoutPassword);
            
            // Save connections map to secrets storage
            const connectionsObj = Object.fromEntries(this._savedConnections);
            await this._context.secrets.store('sqlwayfarer.connections', JSON.stringify(connectionsObj));
            
            this._panel.webview.postMessage({
                command: 'connectionSaved',
                success: true,
                message: `Connection '${connectionName}' saved successfully!`
            });
            
            // Send updated connections list
            this._sendSavedConnections();
            
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'connectionSaved',
                success: false,
                message: `Failed to save connection: ${error.message}`
            });
        }
    }

    async _deleteConnection(connectionName) {
        try {
            // Delete password from secrets storage
            await this._context.secrets.delete(`sqlwayfarer.password.${connectionName}`);
            
            // Remove from connections map
            this._savedConnections.delete(connectionName);
            
            // Update stored connections
            const connectionsObj = Object.fromEntries(this._savedConnections);
            await this._context.secrets.store('sqlwayfarer.connections', JSON.stringify(connectionsObj));
            
            this._panel.webview.postMessage({
                command: 'connectionDeleted',
                success: true,
                message: `Connection '${connectionName}' deleted successfully!`
            });
            
            // Send updated connections list
            this._sendSavedConnections();
            
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'connectionDeleted',
                success: false,
                message: `Failed to delete connection: ${error.message}`
            });
        }
    }

    async _sendSavedConnections() {
        const connections = Array.from(this._savedConnections.entries()).map(([name, config]) => ({
            name,
            ...config
        }));
        
        this._panel.webview.postMessage({
            command: 'savedConnectionsLoaded',
            connections: connections
        });
    }

    async _buildConnectionString(connectionConfig) {
        let connectionString = '';
        
        if (connectionConfig.useConnectionString) {
            connectionString = connectionConfig.connectionString;
        } else {
            // Get password from secure storage if it's a saved connection
            let password = connectionConfig.password;
            if (connectionConfig.name && !password) {
                password = await this._context.secrets.get(`sqlwayfarer.password.${connectionConfig.name}`);
            }
            
            // Build connection string from individual fields
            connectionString = `Server=${connectionConfig.server}`;
            
            if (connectionConfig.port) {
                connectionString += `,${connectionConfig.port}`;
            }
            
            if (connectionConfig.database) {
                connectionString += `;Database=${connectionConfig.database}`;
            }
            
            if (connectionConfig.username && password) {
                connectionString += `;User Id=${connectionConfig.username};Password=${password}`;
            } else {
                connectionString += ';Integrated Security=true';
            }
            
            if (connectionConfig.encrypt !== undefined) {
                connectionString += `;Encrypt=${connectionConfig.encrypt}`;
            }
            
            if (connectionConfig.trustServerCertificate !== undefined) {
                connectionString += `;TrustServerCertificate=${connectionConfig.trustServerCertificate}`;
            }
        }
        
        return connectionString;
    }

    async _testConnection(connectionConfig) {
        try {
            const connectionString = await this._buildConnectionString(connectionConfig);
            const testConnection = await sql.connect(connectionString);
            await testConnection.close();
            
            this._panel.webview.postMessage({
                command: 'testConnectionResult',
                success: true,
                message: 'Connection test successful!'
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'testConnectionResult',
                success: false,
                message: `Connection test failed: ${error.message}`
            });
        }
    }

    async _connect(connectionConfig) {
        try {
            if (this._connection) {
                await this._connection.close();
            }
            
            const connectionString = await this._buildConnectionString(connectionConfig);
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
                console.log('Alternative dependency method not available:', e.message);
            }

            // Combine results and remove duplicates
            const allDependsOn = [...dependsOnResult.recordset, ...alternativeDependsOn];
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