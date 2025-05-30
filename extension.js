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

            this._panel.webview.postMessage({
                command: 'tableDetailsLoaded',
                tableName: tableName,
                columns: columnsResult.recordset,
                indexes: indexesResult.recordset,
                foreignKeys: fkResult.recordset
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'error',
                message: `Failed to get table details: ${error.message}`
            });
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