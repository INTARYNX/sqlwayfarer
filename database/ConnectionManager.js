'use strict';

const sql = require('mssql');

/**
 * Manages SQL Server database connections
 * Handles connection string building, testing, and active connection management
 */
class ConnectionManager {
    constructor(connectionStorage) {
        this._connectionStorage = connectionStorage;
        this._activeConnection = null;
    }

    /**
     * Build connection string from configuration
     * @param {Object} connectionConfig - Connection configuration
     * @returns {Promise<string>} Connection string
     */
    async buildConnectionString(connectionConfig) {
        let connectionString = '';
        
        if (connectionConfig.useConnectionString) {
            connectionString = connectionConfig.connectionString;
        } else {
            // Get password from secure storage if it's a saved connection
            let password = connectionConfig.password;
            if (connectionConfig.name && !password) {
                password = await this._connectionStorage.getConnectionPassword(connectionConfig.name);
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

    /**
     * Test a connection without storing it as active
     * @param {Object} connectionConfig - Connection configuration to test
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async testConnection(connectionConfig) {
        try {
            const connectionString = await this.buildConnectionString(connectionConfig);
            const testConnection = await sql.connect(connectionString);
            await testConnection.close();
            
            return {
                success: true,
                message: 'Connection test successful!'
            };
        } catch (error) {
            return {
                success: false,
                message: `Connection test failed: ${error.message}`
            };
        }
    }

    /**
     * Connect to database and store as active connection
     * @param {Object} connectionConfig - Connection configuration
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async connect(connectionConfig) {
        try {
            // Close existing connection if any
            if (this._activeConnection) {
                await this._activeConnection.close();
                this._activeConnection = null;
            }
            
            const connectionString = await this.buildConnectionString(connectionConfig);
            this._activeConnection = await sql.connect(connectionString);
            
            return {
                success: true,
                message: 'Connected successfully!'
            };
        } catch (error) {
            this._activeConnection = null;
            return {
                success: false,
                message: `Connection failed: ${error.message}`
            };
        }
    }

    /**
     * Disconnect from current database
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async disconnect() {
        try {
            if (this._activeConnection) {
                await this._activeConnection.close();
                this._activeConnection = null;
            }
            
            return {
                success: true,
                message: 'Disconnected successfully!'
            };
        } catch (error) {
            return {
                success: false,
                message: `Disconnect failed: ${error.message}`
            };
        }
    }

    /**
     * Get the active connection
     * @returns {Object|null} Active SQL connection or null
     */
    getActiveConnection() {
        return this._activeConnection;
    }

    /**
     * Check if there's an active connection
     * @returns {boolean} True if connected
     */
    isConnected() {
        return this._activeConnection !== null;
    }

    /**
     * Execute a query on the active connection
     * @param {string} query - SQL query to execute
     * @returns {Promise<Object>} Query result
     * @throws {Error} If no active connection
     */
    async executeQuery(query) {
        if (!this._activeConnection) {
            throw new Error('No active connection');
        }
        
        return await this._activeConnection.request().query(query);
    }

    /**
     * Execute a prepared statement on the active connection
     * @param {string} query - SQL query with parameters
     * @param {Object} parameters - Query parameters
     * @returns {Promise<Object>} Query result
     * @throws {Error} If no active connection
     */
    async executePreparedQuery(query, parameters = {}) {
        if (!this._activeConnection) {
            throw new Error('No active connection');
        }
        
        const request = this._activeConnection.request();
        
        // Add parameters to request
        for (const [key, value] of Object.entries(parameters)) {
            request.input(key, value);
        }
        
        return await request.query(query);
    }

    /**
     * Cleanup resources when disposing
     */
    async dispose() {
        if (this._activeConnection) {
            try {
                await this._activeConnection.close();
            } catch (error) {
                console.error('Error closing connection during dispose:', error);
            }
            this._activeConnection = null;
        }
    }
}

module.exports = ConnectionManager;