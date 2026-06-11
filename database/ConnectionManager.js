'use strict';

const sql = require('mssql');

class ConnectionManager {
    constructor(connectionStorage) {
        this._connectionStorage = connectionStorage;
        this._activeConnection = null;
        this._activeConfig = null;
    }

    async buildConnectionString(connectionConfig) {
        let password = connectionConfig.password;
        if (!password && connectionConfig.name) {
            password = await this._connectionStorage.getConnectionPassword(connectionConfig.name);
            if (connectionConfig.isLoadedConnection && !password) {
                throw new Error('Password not found in secure storage');
            }
        }

        let cs = `Server=${connectionConfig.server}`;
        if (connectionConfig.port)               cs += `,${connectionConfig.port}`;
        if (connectionConfig.database)           cs += `;Database=${connectionConfig.database}`;
        if (connectionConfig.username && password)
            cs += `;User Id=${connectionConfig.username};Password=${password}`;
        else
            cs += ';Integrated Security=true';
        if (connectionConfig.encrypt !== undefined)               cs += `;Encrypt=${connectionConfig.encrypt}`;
        if (connectionConfig.trustServerCertificate !== undefined) cs += `;TrustServerCertificate=${connectionConfig.trustServerCertificate}`;

        return cs;
    }

    async getConnectionForDisplay(connectionName) {
        try {
            const connection = this._connectionStorage.getConnection(connectionName);
            if (!connection) return null;
            const display = { ...connection };
            delete display.password;
            return display;
        } catch (error) {
            console.error('Error getting connection for display:', error);
            return null;
        }
    }

    async testConnection(connectionConfig) {
        const conn = await sql.connect(await this.buildConnectionString(connectionConfig));
        await conn.close();
    }

    async connect(connectionConfig) {
        if (this._activeConnection) {
            await this._activeConnection.close();
            this._activeConnection = null;
        }
        this._activeConnection = await sql.connect(await this.buildConnectionString(connectionConfig));
        this._activeConfig = connectionConfig;
    }

    async connectWithSaved(connectionName) {
        const savedConnection = this._connectionStorage.getConnection(connectionName);
        if (!savedConnection) throw new Error(`Connection '${connectionName}' not found`);

        const password = await this._connectionStorage.getConnectionPassword(connectionName);
        if (!password) throw new Error(`Password not found for connection '${connectionName}'`);

        await this.connect({ ...savedConnection, password, isLoadedConnection: true });
    }

    isConnected() {
        return this._activeConnection !== null;
    }

    getServerName() {
        return this._activeConfig?.server || 'unknown';
    }

    async executeQuery(query, params = null) {
        if (!this._activeConnection) throw new Error('No active connection');
        const request = this._activeConnection.request();
        if (params) {
            for (const [name, value] of Object.entries(params)) {
                request.input(name, value);
            }
        }
        return await request.query(query);
    }

    async dispose() {
        if (this._activeConnection) {
            try { await this._activeConnection.close(); } catch (error) {
                console.error('Error closing connection during dispose:', error);
            }
            this._activeConnection = null;
            this._activeConfig = null;
        }
    }
}

module.exports = ConnectionManager;
