'use strict';

const sql = require('mssql');

class ConnectionManager {
    constructor(connectionStorage) {
        this._connectionStorage = connectionStorage;
        this._activeConnection = null;
        this._activeConfig = null;
    }

    // Objet de config natif mssql plutôt qu'une connection string concaténée à la main —
    // un mot de passe contenant ';' ou '=' pourrait sinon injecter des paramètres de connexion.
    async buildConnectionConfig(connectionConfig) {
        let password = connectionConfig.password;
        if (!password && connectionConfig.name) {
            password = await this._connectionStorage.getConnectionPassword(connectionConfig.name);
            if (connectionConfig.isLoadedConnection && !password) {
                throw new Error('Password not found in secure storage');
            }
        }

        const options = {};
        if (connectionConfig.encrypt !== undefined) options.encrypt = connectionConfig.encrypt;
        if (connectionConfig.trustServerCertificate !== undefined) options.trustServerCertificate = connectionConfig.trustServerCertificate;

        // Le défaut mssql/tedious de 15s tue les requêtes longues (indexation d'une
        // grosse base, requêtes utilisateur) ; les timeouts applicatifs (annulation à
        // 5 min dans QueryHandlers, bouton Cancel de l'indexation) restent les garde-fous.
        const config = { server: connectionConfig.server, options, requestTimeout: 300000 };
        if (connectionConfig.port) config.port = Number(connectionConfig.port);
        if (connectionConfig.database) config.database = connectionConfig.database;
        if (connectionConfig.username && password) {
            // 'DOMAIN\user' doit devenir { domain, user } : tedious ne passe en NTLM
            // (compte Windows) que si config.domain est défini, comme le faisait
            // le parser de connection string de mssql avant le passage à l'objet natif.
            const domainUser = /^(.*)\\(.*)$/.exec(connectionConfig.username);
            if (domainUser && domainUser[1]) {
                config.domain = domainUser[1];
                config.user = domainUser[2];
            } else {
                config.user = connectionConfig.username;
            }
            config.password = password;
        }

        return config;
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
        const conn = await sql.connect(await this.buildConnectionConfig(connectionConfig));
        await conn.close();
    }

    async connect(connectionConfig) {
        if (this._activeConnection) {
            await this._activeConnection.close();
            this._activeConnection = null;
        }
        this._activeConnection = await sql.connect(await this.buildConnectionConfig(connectionConfig));
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

    // Expose a raw request so callers can stream results or cancel a long query.
    createRequest() {
        if (!this._activeConnection) throw new Error('No active connection');
        return this._activeConnection.request();
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

    // Centralise le `USE [database];` répété identiquement dans presque tous les services
    // pour éviter qu'une requête l'oublie et interroge la mauvaise base.
    async executeQueryInDatabase(database, query, params = null) {
        return this.executeQuery(`USE [${database}];\n${query}`, params);
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
