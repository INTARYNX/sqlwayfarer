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

            // Extract procedure name from config
            const procedureName = config.targetObjects && config.targetObjects[0];
            if (!procedureName) {
                throw new Error('Procedure name is required');
            }

            // Generate session name with _1 suffix
            const finalSessionName = `XE_SQLWayfarer_${procedureName}_1`;

            // Create session SQL with ring buffer and procedure-specific filtering
            const sessionSQL = this._generateProcedureSessionSQL(finalSessionName, procedureName);
            
            // Execute session creation
            await this._connectionManager.executeQuery(sessionSQL);
            
            // Track the session
            this.activeSessions.set(finalSessionName, {
                database: database,
                procedureName: procedureName,
                config: config,
                status: 'stopped',
                created: new Date()
            });

            return {
                success: true,
                message: `Extended Events session '${finalSessionName}' created successfully`,
                sessionName: finalSessionName
            };

        } catch (error) {
            return {
                success: false,
                message: `Failed to create session: ${error.message}`
            };
        }
    }

    /**
     * Generate procedure-specific session SQL with ring buffer
     * @param {string} sessionName - Session name
     * @param {string} procedureName - Procedure name to monitor
     * @returns {string} SQL CREATE EVENT SESSION statement
     * @private
     */
    _generateProcedureSessionSQL(sessionName, procedureName) {
        return `
-- Drop session if it exists
IF EXISTS (SELECT * FROM sys.server_event_sessions WHERE name = '${sessionName}')
    DROP EVENT SESSION [${sessionName}] ON SERVER;

-- Create new session with ring buffer target
CREATE EVENT SESSION [${sessionName}] ON SERVER
ADD EVENT sqlserver.sql_batch_completed(
    ACTION(sqlserver.sql_text, sqlserver.database_name, sqlserver.client_hostname, sqlserver.username, sqlserver.session_id)
    WHERE (sqlserver.sql_text LIKE N'%EXEC dbo.${procedureName}%')
),
ADD EVENT sqlserver.sp_statement_completed(
    ACTION(sqlserver.sql_text, sqlserver.database_name, sqlserver.client_hostname, sqlserver.username, sqlserver.session_id)
),
ADD EVENT sqlserver.sql_statement_completed(
    ACTION(sqlserver.sql_text, sqlserver.database_name, sqlserver.client_hostname, sqlserver.username, sqlserver.session_id)
)
ADD TARGET package0.ring_buffer
WITH (
    MAX_MEMORY = 4096KB,
    EVENT_RETENTION_MODE = ALLOW_SINGLE_EVENT_LOSS,
    MAX_DISPATCH_LATENCY = 1 SECONDS,
    TRACK_CAUSALITY = ON,
    STARTUP_STATE = OFF
);`;
    }

    /**
     * Get raw XML events from ring buffer for debugging
     * @param {string} sessionName - Session name
     * @returns {Promise<Object>} Raw XML events
     */
    async getSessionRawEvents(sessionName) {
        if (!this._connectionManager.isConnected()) {
            throw new Error('No active connection');
        }

        try {
            console.log(`Getting raw events for session: ${sessionName}`);
            
            // Simplified query that works across SQL Server versions
            const sql = `
                SELECT 
                    CAST(st.target_data AS XML) AS event_xml,
                    st.target_name,
                    s.name as session_name
                FROM 
                    sys.dm_xe_sessions s
                JOIN 
                    sys.dm_xe_session_targets st ON s.address = st.event_session_address
                WHERE 
                    s.name = '${sessionName}'
                    AND st.target_name = 'ring_buffer'
            `;

            const result = await this._connectionManager.executeQuery(sql);
            
            console.log(`Query result: ${result.recordset.length} rows`);
            
            if (result.recordset.length === 0) {
                return {
                    success: true,
                    rawXml: null,
                    message: 'No ring buffer data found. Session may not be running or no events captured yet.'
                };
            }

            const row = result.recordset[0];
            
            return {
                success: true,
                rawXml: row.event_xml,
                message: row.event_xml ? 'Raw XML retrieved successfully' : 'Ring buffer exists but no events captured yet'
            };

        } catch (error) {
            console.error('Error getting raw events:', error);
            return {
                success: false,
                message: `Failed to get raw events: ${error.message}`
            };
        }
    }

    /**
     * Get enhanced session status including event count
     * @param {string} sessionName - Session name
     * @returns {Promise<Object>} Enhanced session info
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
                        WHEN r.address IS NOT NULL THEN 'running'
                        ELSE 'stopped'
                    END as status,
                    s.create_time,
                    COUNT(e.event_session_id) as event_count,
                    -- Try to get ring buffer event count
                    CASE 
                        WHEN st.target_data IS NOT NULL 
                        THEN CAST(st.target_data AS XML).value('count(/RingBufferTarget/event)', 'int')
                        ELSE 0
                    END as ring_buffer_event_count
                FROM sys.server_event_sessions s
                LEFT JOIN sys.dm_xe_sessions r ON s.name = r.name
                LEFT JOIN sys.server_event_session_events e ON s.event_session_id = e.event_session_id
                LEFT JOIN sys.dm_xe_session_targets st ON r.address = st.event_session_address 
                    AND st.target_name = 'ring_buffer'
                WHERE s.name = '${sessionName}'
                GROUP BY s.name, s.event_session_id, s.create_time, r.address, st.target_data
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
                ringBufferEventCount: sessionData.ring_buffer_event_count,
                createTime: sessionData.create_time,
                localInfo: this.activeSessions.get(sessionName) || null
            };

        } catch (error) {
            throw new Error(`Failed to get session info: ${error.message}`);
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