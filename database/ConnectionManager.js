'use strict';

const sql = require('mssql');
const { bracketIdentifier } = require('./sqlIdentifier');

class ConnectionManager {
    constructor(connectionStorage) {
        this._connectionStorage = connectionStorage;
        this._activeConnection = null;
        this._activeConfig = null;
        // Survives disconnect (unlike _activeConfig, cleared on dispose) so
        // getServerName() stays correct for whoever's mid-reconnect instead of
        // falling back to 'unknown' - see IndexService._getIndexFilePath, which
        // keys the on-disk cache by server name.
        this._lastKnownServer = null;
    }

    // Native mssql config object instead of a hand-concatenated connection
    // string - a password containing ';' or '=' would otherwise inject
    // connection parameters.
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

        // The 15s mssql/tedious default kills the long queries (indexing a
        // large database, user queries); the application timeouts (5 min
        // cancellation in QueryHandlers, Cancel button of the indexing) remain
        // the real safeguards.
        const config = { server: connectionConfig.server, options, requestTimeout: 300000 };
        if (connectionConfig.port) config.port = Number(connectionConfig.port);
        if (connectionConfig.database) config.database = connectionConfig.database;
        if (connectionConfig.username && password) {
            // 'DOMAIN\user' must become { domain, user }: tedious only switches
            // to NTLM (Windows account) when config.domain is set, the way the
            // mssql connection string parser did before the move to the native
            // object.
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
        // Connect the new one first - if it fails (bad password, unreachable
        // server), the old connection stays usable instead of leaving the
        // extension with none at all.
        const newConnection = await sql.connect(await this.buildConnectionConfig(connectionConfig));

        if (this._activeConnection) {
            await this._activeConnection.close().catch(() => { /* already gone */ });
        }
        this._activeConnection = newConnection;
        this._activeConfig = connectionConfig;
        this._lastKnownServer = connectionConfig.server;
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
        return this._activeConfig?.server || this._lastKnownServer || 'unknown';
    }

    // Expose a raw request so callers can stream results or cancel a long query.
    createRequest() {
        if (!this._activeConnection) throw new Error('No active connection');
        return this._activeConnection.request();
    }

    // Expose the pool itself for callers that need several requests pinned to
    // the exact same physical connection (e.g. a Transaction), not just any
    // connection the pool happens to hand out per-request.
    getPool() {
        if (!this._activeConnection) throw new Error('No active connection');
        return this._activeConnection;
    }

    // Pins one physical connection out of the pool and returns a factory for
    // Requests bound to it, so a caller running several statements in
    // sequence (e.g. a GO-separated multi-batch script, or SET SHOWPLAN_XML
    // ON/plan/OFF) sees them land on the exact same session - a `USE`, SET
    // option or #temp table from an earlier statement stays visible to a
    // later one, instead of silently vanishing if the pool happened to hand
    // out a different physical connection per request.
    async acquireConnection() {
        const pool = this.getPool();
        const connection = await pool.acquire();
        // Minimal shape sql.Request's parent needs: acquire/release - always
        // hands back this one already-acquired connection instead of letting
        // the pool pick a different one per request - plus the handful of
        // properties mssql's Request reads directly off the parent outside
        // the acquire callback (this.stream/arrayRowMode via parent.config, a
        // parent.connected guard, parent.collation for parameterized queries).
        const pinned = {
            config: pool.config,
            connected: true,
            collation: pool.collation,
            acquire: (requester, cb) => cb(null, connection, pool.config),
            release: () => {}
        };
        return {
            createRequest: () => new sql.Request(pinned),
            release: () => pool.release(connection)
        };
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

    // Centralises the `USE [database];` repeated identically in almost every
    // service, so that no query forgets it and hits the wrong database.
    async executeQueryInDatabase(database, query, params = null) {
        // Doubled ']' to close the bracketed identifier properly when the name
        // contains one.
        return this.executeQuery(`USE ${bracketIdentifier(database)};\n${query}`, params);
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
