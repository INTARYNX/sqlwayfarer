/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

/**
 * Extended Events Service - Manages SQL Server Extended Events sessions
 * Handles creation, management and monitoring of XE sessions for execution flow analysis
 */
class ExtendedEventsService {
    constructor(connectionManager) {
        this._connectionManager = connectionManager;
        this.activeSessions = new Map(); // Track active sessions
    }

    /**
     * Create an Extended Events session for stored procedure profiling
     * @param {string} database - Database name
     * @param {string} sessionName - Unique session name
     * @param {Object} config - Configuration options
     * @returns {Promise<Object>} Creation result
     */
    async createExecutionFlowSession(database, sessionName, config = {}) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            // Validate session name (prevent SQL injection)
            if (!this._isValidSessionName(sessionName)) {
                throw new Error('Invalid session name. Use only alphanumeric characters and underscores.');
            }

            // Check if session already exists
            const existingSession = await this._checkSessionExists(database, sessionName);
            if (existingSession) {
                throw new Error(`Session '${sessionName}' already exists`);
            }

            // Choose template based on config
            const sessionSQL = this._generateSessionSQL(sessionName, config);
            
            // Execute session creation
            await this._connectionManager.executeQuery(sessionSQL);
            
            // Track the session
            this.activeSessions.set(sessionName, {
                database: database,
                config: config,
                status: 'stopped',
                created: new Date()
            });

            return {
                success: true,
                message: `Extended Events session '${sessionName}' created successfully`,
                sessionName: sessionName
            };

        } catch (error) {
            return {
                success: false,
                message: `Failed to create session: ${error.message}`
            };
        }
    }

    /**
     * Start an Extended Events session
     * @param {string} sessionName - Session name to start
     * @returns {Promise<Object>} Start result
     */
    async startSession(sessionName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            if (!this._isValidSessionName(sessionName)) {
                throw new Error('Invalid session name');
            }

            const sql = `ALTER EVENT SESSION [${sessionName}] ON SERVER STATE = START;`;
            await this._connectionManager.executeQuery(sql);
            
            // Update tracking
            if (this.activeSessions.has(sessionName)) {
                this.activeSessions.get(sessionName).status = 'running';
                this.activeSessions.get(sessionName).started = new Date();
            }

            return {
                success: true,
                message: `Session '${sessionName}' started successfully`
            };

        } catch (error) {
            return {
                success: false,
                message: `Failed to start session: ${error.message}`
            };
        }
    }

    /**
     * Stop an Extended Events session
     * @param {string} sessionName - Session name to stop
     * @returns {Promise<Object>} Stop result
     */
    async stopSession(sessionName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            if (!this._isValidSessionName(sessionName)) {
                throw new Error('Invalid session name');
            }

            const sql = `ALTER EVENT SESSION [${sessionName}] ON SERVER STATE = STOP;`;
            await this._connectionManager.executeQuery(sql);
            
            // Update tracking
            if (this.activeSessions.has(sessionName)) {
                this.activeSessions.get(sessionName).status = 'stopped';
                this.activeSessions.get(sessionName).stopped = new Date();
            }

            return {
                success: true,
                message: `Session '${sessionName}' stopped successfully`
            };

        } catch (error) {
            return {
                success: false,
                message: `Failed to stop session: ${error.message}`
            };
        }
    }

    /**
     * Delete an Extended Events session
     * @param {string} sessionName - Session name to delete
     * @returns {Promise<Object>} Delete result
     */
    async deleteSession(sessionName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            if (!this._isValidSessionName(sessionName)) {
                throw new Error('Invalid session name');
            }

            // Stop session first if it's running
            await this.stopSession(sessionName);
            
            // Delete the session
            const sql = `DROP EVENT SESSION [${sessionName}] ON SERVER;`;
            await this._connectionManager.executeQuery(sql);
            
            // Remove from tracking
            this.activeSessions.delete(sessionName);

            return {
                success: true,
                message: `Session '${sessionName}' deleted successfully`
            };

        } catch (error) {
            return {
                success: false,
                message: `Failed to delete session: ${error.message}`
            };
        }
    }

    /**
     * Get session status and info
     * @param {string} sessionName - Session name
     * @returns {Promise<Object>} Session info
     */
    async getSessionInfo(sessionName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            const sql = `
                SELECT 
                    s.name,
                    s.event_session_id,
                    CASE WHEN s.create_time IS NOT NULL THEN 1 ELSE 0 END as exists,
                    CASE 
                        WHEN r.event_session_address IS NOT NULL THEN 'running'
                        ELSE 'stopped'
                    END as status,
                    s.create_time,
                    COUNT(e.event_session_id) as event_count
                FROM sys.server_event_sessions s
                LEFT JOIN sys.dm_xe_sessions r ON s.name = r.name
                LEFT JOIN sys.server_event_session_events e ON s.event_session_id = e.event_session_id
                WHERE s.name = '${sessionName}'
                GROUP BY s.name, s.event_session_id, s.create_time, r.event_session_address
            `;

            const result = await this._connectionManager.executeQuery(sql);
            
            if (result.recordset.length === 0) {
                return {
                    exists: false,
                    status: 'not_found'
                };
            }

            const sessionData = result.recordset[0];
            return {
                exists: true,
                status: sessionData.status,
                eventCount: sessionData.event_count,
                createTime: sessionData.create_time,
                localInfo: this.activeSessions.get(sessionName) || null
            };

        } catch (error) {
            throw new Error(`Failed to get session info: ${error.message}`);
        }
    }

    /**
     * List all Extended Events sessions
     * @returns {Promise<Array>} List of sessions
     */
    async listSessions() {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            const sql = `
                SELECT 
                    s.name,
                    s.event_session_id,
                    CASE 
                        WHEN r.event_session_address IS NOT NULL THEN 'running'
                        ELSE 'stopped'
                    END as status,
                    s.create_time,
                    COUNT(e.event_session_id) as event_count
                FROM sys.server_event_sessions s
                LEFT JOIN sys.dm_xe_sessions r ON s.name = r.name
                LEFT JOIN sys.server_event_session_events e ON s.event_session_id = e.event_session_id
                WHERE s.name LIKE 'XE_SQLWayfarer_%'
                GROUP BY s.name, s.event_session_id, s.create_time, r.event_session_address
                ORDER BY s.create_time DESC
            `;

            const result = await this._connectionManager.executeQuery(sql);
            return result.recordset;

        } catch (error) {
            throw new Error(`Failed to list sessions: ${error.message}`);
        }
    }

    /**
     * Generate session SQL based on configuration
     * @param {string} sessionName - Session name
     * @param {Object} config - Configuration options
     * @returns {string} SQL CREATE EVENT SESSION statement
     * @private
     */
    _generateSessionSQL(sessionName, config) {
        const {
            mode = 'stored_procedure_flow',
            targetObjects = [],
            includeDynamicSQL = true,
            includeSystemObjects = false,
            maxFileSize = '100MB',
            maxFiles = 5
        } = config;

    // Base session with file target for data collection
    //let sql = `CREATE EVENT SESSION [${sessionName}] ON SERVER\n`;

    //const eventsSQL = this._getEventsForMode(mode, config).trim();

    // Enlever la virgule finale dans eventsSQL s’il y en a une (important)
    //const eventsSQLWithoutTrailingComma = eventsSQL.replace(/,\s*$/, '');

    //sql += eventsSQLWithoutTrailingComma + '\n';

    let sql = `
CREATE EVENT SESSION [${sessionName}] ON SERVER
ADD EVENT sqlserver.sql_batch_completed(
    ACTION(sqlserver.sql_text)
)
ADD TARGET package0.event_file(
    SET filename=N'C:\\temp\\${sessionName}',
        max_file_size = ${this._parseFileSize(maxFileSize)},
        max_rollover_files = ${maxFiles}
)
WITH (
    MAX_MEMORY = 4096 KB,
    EVENT_RETENTION_MODE = ALLOW_SINGLE_EVENT_LOSS,
    MAX_DISPATCH_LATENCY = 30 SECONDS,
    TRACK_CAUSALITY = ON,
    STARTUP_STATE = OFF
);
`;

   /* 
    sql += `
ADD TARGET package0.event_file
(
    SET filename = N'C:\\temp\\${sessionName}.xel',
        max_file_size = ${this._parseFileSize(maxFileSize)},
        max_rollover_files = ${maxFiles}
)
WITH (
    MAX_MEMORY = 4096 KB,
    EVENT_RETENTION_MODE = ALLOW_SINGLE_EVENT_LOSS,
    MAX_DISPATCH_LATENCY = 30 SECONDS,
    MAX_EVENT_SIZE = 0 KB,
    MEMORY_PARTITION_MODE = NONE,
    TRACK_CAUSALITY = ON,
    STARTUP_STATE = OFF
);`;
*/


        return sql;
    }

    /**
     * Get events configuration based on analysis mode
     * @param {string} mode - Analysis mode
     * @param {Object} config - Additional configuration
     * @returns {string} Events SQL fragment
     * @private
     */
    _getEventsForMode(mode, config) {
        const { includeSystemObjects = false, targetObjects = [] } = config;
        
        // Base filter to exclude system activities
        let baseFilter = '';
        if (!includeSystemObjects) {
            baseFilter = 'WHERE sqlserver.is_system = 0';
        }
        
        // Object-specific filter
        let objectFilter = '';
        if (targetObjects.length > 0) {
            const objectList = targetObjects.map(obj => `'${obj}'`).join(',');
            if (baseFilter) {
                objectFilter = ` AND object_name IN (${objectList})`;
            } else {
                objectFilter = ` WHERE object_name IN (${objectList})`;
            }
        }

        const finalFilter = baseFilter + objectFilter;

        switch (mode) {
            case 'stored_procedure_flow':
                return `
ADD EVENT sqlserver.module_start(
    ACTION(sqlserver.sql_text, sqlserver.database_name, sqlserver.server_principal_name)
    ${finalFilter ? finalFilter : ''}
),
ADD EVENT sqlserver.module_end(
    ACTION(sqlserver.sql_text, sqlserver.database_name)
    ${finalFilter ? finalFilter : ''}
),
ADD EVENT sqlserver.sp_statement_starting(
    ACTION(sqlserver.sql_text, sqlserver.database_name)
    ${finalFilter ? finalFilter : ''}
),
ADD EVENT sqlserver.sp_statement_completed(
    ACTION(sqlserver.sql_text, sqlserver.database_name)
    ${finalFilter ? finalFilter : ''}
),
ADD EVENT sqlserver.sql_batch_starting(
    ACTION(sqlserver.sql_text, sqlserver.database_name)
    ${finalFilter ? finalFilter : ''}
),
ADD EVENT sqlserver.sql_batch_completed(
    ACTION(sqlserver.sql_text, sqlserver.database_name)
    ${finalFilter ? finalFilter : ''}
) `;

            case 'full_execution':
                return `
ADD EVENT sqlserver.sql_statement_starting(
    ACTION(sqlserver.sql_text, sqlserver.database_name, sqlserver.plan_handle)
    ${finalFilter ? finalFilter : ''}
),
ADD EVENT sqlserver.sql_statement_completed(
    ACTION(sqlserver.sql_text, sqlserver.database_name, sqlserver.plan_handle)
    ${finalFilter ? finalFilter : ''}
),
ADD EVENT sqlserver.module_start(
    ACTION(sqlserver.sql_text, sqlserver.database_name)
    ${finalFilter ? finalFilter : ''}
),
ADD EVENT sqlserver.module_end(
    ACTION(sqlserver.sql_text, sqlserver.database_name)
    ${finalFilter ? finalFilter : ''}
) `;

            case 'performance_focus':
                return `
ADD EVENT sqlserver.sql_statement_completed(
    ACTION(sqlserver.sql_text, sqlserver.database_name, sqlserver.query_plan_hash)
    ${finalFilter ? (finalFilter + ' AND duration > 1000000') : 'WHERE duration > 1000000'}
),
ADD EVENT sqlserver.module_end(
    ACTION(sqlserver.sql_text, sqlserver.database_name)
    ${finalFilter ? (finalFilter + ' AND duration > 1000000') : 'WHERE duration > 1000000'}
) `;

            default:
                return this._getEventsForMode('stored_procedure_flow', config);
        }
    }

    /**
     * Check if session exists
     * @param {string} database - Database name
     * @param {string} sessionName - Session name
     * @returns {Promise<boolean>} True if session exists
     * @private
     */
    async _checkSessionExists(database, sessionName) {
        const sql = `
            SELECT COUNT(*) as session_count 
            FROM sys.server_event_sessions 
            WHERE name = '${sessionName}'
        `;
        
        const result = await this._connectionManager.executeQuery(sql);
        return result.recordset[0].session_count > 0;
    }

    /**
     * Validate session name for security
     * @param {string} sessionName - Session name to validate
     * @returns {boolean} True if valid
     * @private
     */
    _isValidSessionName(sessionName) {
        // Allow only alphanumeric, underscore, and hyphen
        // Prevent SQL injection
        const validPattern = /^[a-zA-Z0-9_-]+$/;
        return validPattern.test(sessionName) && sessionName.length <= 100;
    }

    /**
     * Parse file size string to KB
     * @param {string} sizeStr - Size string like "100MB"
     * @returns {number} Size in KB
     * @private
     */
    _parseFileSize(sizeStr) {
        const units = {
            'KB': 1,
            'MB': 1024,
            'GB': 1024 * 1024
        };
        
        const match = sizeStr.match(/^(\d+)(KB|MB|GB)$/i);
        if (!match) return 102400; // Default 100MB in KB
        
        const [, size, unit] = match;
        return parseInt(size) * (units[unit.toUpperCase()] || 1024);
    }

    /**
     * Get active sessions managed by this service
     * @returns {Map} Active sessions map
     */
    getActiveSessions() {
        return this.activeSessions;
    }

    /**
     * Clean up resources
     */
    async dispose() {
        // Stop all tracked sessions
        for (const [sessionName, sessionInfo] of this.activeSessions) {
            if (sessionInfo.status === 'running') {
                try {
                    await this.stopSession(sessionName);
                } catch (error) {
                    console.error(`Error stopping session ${sessionName}:`, error);
                }
            }
        }
        this.activeSessions.clear();
    }
}

module.exports = ExtendedEventsService;