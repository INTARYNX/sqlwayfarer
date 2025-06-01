'use strict';

/**
 * Manages secure storage and retrieval of database connections
 * Uses VS Code's secrets API for secure password storage
 */
class ConnectionStorage {
    /**
     * @param {vscode.ExtensionContext} context 
     */
    constructor(context) {
        this._context = context;
        this._savedConnections = new Map();
    }

    /**
     * Initialize and load saved connections from storage
     */
    async initialize() {
        await this._loadSavedConnections();
    }

    /**
     * Load saved connections from VS Code secrets storage
     * @private
     */
    async _loadSavedConnections() {
        try {
            const savedConnectionsJson = await this._context.secrets.get('sqlwayfarer.connections');
            if (savedConnectionsJson) {
                const connections = JSON.parse(savedConnectionsJson);
                this._savedConnections = new Map(Object.entries(connections));
            }
        } catch (error) {
            console.error('Error loading saved connections:', error);
            throw new Error(`Failed to load saved connections: ${error.message}`);
        }
    }

    /**
     * Save a connection configuration securely
     * @param {Object} connectionConfig - Connection configuration object
     * @param {string} connectionConfig.name - Connection name
     * @param {string} connectionConfig.password - Connection password
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async saveConnection(connectionConfig) {
        try {
            const connectionName = connectionConfig.name;
            const password = connectionConfig.password;
            
            if (!connectionName) {
                throw new Error('Connection name is required');
            }

            // Save password securely in VS Code secrets storage
            if (password) {
                await this._context.secrets.store(`sqlwayfarer.password.${connectionName}`, password);
            }
            
            // Save connection config without password
            const connectionConfigWithoutPassword = {
                ...connectionConfig,
                password: undefined // Remove password from stored config
            };
            
            this._savedConnections.set(connectionName, connectionConfigWithoutPassword);
            
            // Save connections map to secrets storage
            const connectionsObj = Object.fromEntries(this._savedConnections);
            await this._context.secrets.store('sqlwayfarer.connections', JSON.stringify(connectionsObj));
            
            return {
                success: true,
                message: `Connection '${connectionName}' saved successfully!`
            };
            
        } catch (error) {
            return {
                success: false,
                message: `Failed to save connection: ${error.message}`
            };
        }
    }

    /**
     * Delete a saved connection
     * @param {string} connectionName - Name of the connection to delete
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async deleteConnection(connectionName) {
        try {
            if (!connectionName) {
                throw new Error('Connection name is required');
            }

            // Delete password from secrets storage
            await this._context.secrets.delete(`sqlwayfarer.password.${connectionName}`);
            
            // Remove from connections map
            const deleted = this._savedConnections.delete(connectionName);
            
            if (!deleted) {
                throw new Error(`Connection '${connectionName}' not found`);
            }
            
            // Update stored connections
            const connectionsObj = Object.fromEntries(this._savedConnections);
            await this._context.secrets.store('sqlwayfarer.connections', JSON.stringify(connectionsObj));
            
            return {
                success: true,
                message: `Connection '${connectionName}' deleted successfully!`
            };
            
        } catch (error) {
            return {
                success: false,
                message: `Failed to delete connection: ${error.message}`
            };
        }
    }

    /**
     * Get all saved connections (without passwords)
     * @returns {Array<Object>} Array of connection configurations
     */
    getSavedConnections() {
        return Array.from(this._savedConnections.entries()).map(([name, config]) => ({
            name,
            ...config
        }));
    }

    /**
     * Get a specific connection by name
     * @param {string} connectionName - Name of the connection
     * @returns {Object|null} Connection configuration or null if not found
     */
    getConnection(connectionName) {
        const config = this._savedConnections.get(connectionName);
        if (!config) {
            return null;
        }
        
        return {
            name: connectionName,
            ...config
        };
    }

    /**
     * Get the password for a saved connection
     * @param {string} connectionName - Name of the connection
     * @returns {Promise<string|null>} Password or null if not found
     */
    async getConnectionPassword(connectionName) {
        try {
            return await this._context.secrets.get(`sqlwayfarer.password.${connectionName}`);
        } catch (error) {
            console.error(`Error retrieving password for connection '${connectionName}':`, error);
            return null;
        }
    }

    /**
     * Check if a connection exists
     * @param {string} connectionName - Name of the connection
     * @returns {boolean} True if connection exists
     */
    hasConnection(connectionName) {
        return this._savedConnections.has(connectionName);
    }

    /**
     * Get the number of saved connections
     * @returns {number} Number of saved connections
     */
    getConnectionCount() {
        return this._savedConnections.size;
    }

    /**
     * Clear all saved connections (for testing or reset purposes)
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async clearAllConnections() {
        try {
            // Delete all passwords from secrets storage
            const connectionNames = Array.from(this._savedConnections.keys());
            for (const name of connectionNames) {
                await this._context.secrets.delete(`sqlwayfarer.password.${name}`);
            }
            
            // Clear the connections map
            this._savedConnections.clear();
            
            // Update stored connections
            await this._context.secrets.store('sqlwayfarer.connections', JSON.stringify({}));
            
            return {
                success: true,
                message: 'All connections cleared successfully!'
            };
            
        } catch (error) {
            return {
                success: false,
                message: `Failed to clear connections: ${error.message}`
            };
        }
    }
}

module.exports = ConnectionStorage;