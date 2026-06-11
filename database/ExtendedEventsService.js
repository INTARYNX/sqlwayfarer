'use strict';

class ExtendedEventsService {
    constructor(connectionManager) {
        this._connectionManager = connectionManager;
        this._activeSessions = new Map();
    }

    async createExecutionFlowSession(database, sessionName, config = {}) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');
        if (!this._isValidSessionName(sessionName)) throw new Error('Invalid session name. Use only alphanumeric characters and underscores.');

        const procedureName = config.targetObjects?.[0];
        if (!procedureName) throw new Error('Procedure name is required');

        const finalSessionName = `XE_SQLWayfarer_${procedureName}_1`;
        await this._connectionManager.executeQuery(this._generateProcedureSessionSQL(finalSessionName, procedureName));

        this._activeSessions.set(finalSessionName, {
            database, procedureName, config, status: 'stopped', created: new Date()
        });

        return { success: true, message: `Extended Events session '${finalSessionName}' created successfully`, sessionName: finalSessionName };
    }

    async getSessionRawEvents(sessionName) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');

        const result = await this._connectionManager.executeQuery(`
            SELECT
                CAST(st.target_data AS XML) AS event_xml,
                st.target_name,
                s.name as session_name
            FROM sys.dm_xe_sessions s
            JOIN sys.dm_xe_session_targets st ON s.address = st.event_session_address
            WHERE s.name = '${sessionName}' AND st.target_name = 'ring_buffer'
        `);

        if (result.recordset.length === 0) {
            return { success: true, rawXml: null, message: 'No ring buffer data found. Session may not be running or no events captured yet.' };
        }

        const row = result.recordset[0];
        return { success: true, rawXml: row.event_xml, message: row.event_xml ? 'Raw XML retrieved successfully' : 'Ring buffer exists but no events captured yet' };
    }

    async getSessionInfo(sessionName) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');

        const result = await this._connectionManager.executeQuery(`
            SELECT
                s.name,
                s.event_session_id,
                CASE WHEN s.create_time IS NOT NULL THEN 1 ELSE 0 END as exists,
                CASE WHEN r.address IS NOT NULL THEN 'running' ELSE 'stopped' END as status,
                s.create_time,
                COUNT(e.event_session_id) as event_count,
                CASE
                    WHEN st.target_data IS NOT NULL
                    THEN CAST(st.target_data AS XML).value('count(/RingBufferTarget/event)', 'int')
                    ELSE 0
                END as ring_buffer_event_count
            FROM sys.server_event_sessions s
            LEFT JOIN sys.dm_xe_sessions r ON s.name = r.name
            LEFT JOIN sys.server_event_session_events e ON s.event_session_id = e.event_session_id
            LEFT JOIN sys.dm_xe_session_targets st ON r.address = st.event_session_address AND st.target_name = 'ring_buffer'
            WHERE s.name = '${sessionName}'
            GROUP BY s.name, s.event_session_id, s.create_time, r.address, st.target_data
        `);

        if (result.recordset.length === 0) return { exists: false, status: 'not_found' };

        const d = result.recordset[0];
        return {
            exists: true,
            status: d.status,
            eventCount: d.event_count,
            ringBufferEventCount: d.ring_buffer_event_count,
            createTime: d.create_time,
            localInfo: this._activeSessions.get(sessionName) || null
        };
    }

    async startSession(sessionName) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');
        if (!this._isValidSessionName(sessionName)) throw new Error('Invalid session name');

        await this._connectionManager.executeQuery(`ALTER EVENT SESSION [${sessionName}] ON SERVER STATE = START;`);
        if (this._activeSessions.has(sessionName)) {
            Object.assign(this._activeSessions.get(sessionName), { status: 'running', started: new Date() });
        }
        return { success: true, message: `Session '${sessionName}' started successfully` };
    }

    async stopSession(sessionName) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');
        if (!this._isValidSessionName(sessionName)) throw new Error('Invalid session name');

        await this._connectionManager.executeQuery(`ALTER EVENT SESSION [${sessionName}] ON SERVER STATE = STOP;`);
        if (this._activeSessions.has(sessionName)) {
            Object.assign(this._activeSessions.get(sessionName), { status: 'stopped', stopped: new Date() });
        }
        return { success: true, message: `Session '${sessionName}' stopped successfully` };
    }

    async deleteSession(sessionName) {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');
        if (!this._isValidSessionName(sessionName)) throw new Error('Invalid session name');

        await this.stopSession(sessionName);
        await this._connectionManager.executeQuery(`DROP EVENT SESSION [${sessionName}] ON SERVER;`);
        this._activeSessions.delete(sessionName);
        return { success: true, message: `Session '${sessionName}' deleted successfully` };
    }

    async listSessions() {
        if (!this._connectionManager.isConnected()) throw new Error('No active connection');

        const result = await this._connectionManager.executeQuery(`
            SELECT
                s.name,
                s.event_session_id,
                CASE WHEN r.event_session_address IS NOT NULL THEN 'running' ELSE 'stopped' END as status,
                s.create_time,
                COUNT(e.event_session_id) as event_count
            FROM sys.server_event_sessions s
            LEFT JOIN sys.dm_xe_sessions r ON s.name = r.name
            LEFT JOIN sys.server_event_session_events e ON s.event_session_id = e.event_session_id
            WHERE s.name LIKE 'XE_SQLWayfarer_%'
            GROUP BY s.name, s.event_session_id, s.create_time, r.event_session_address
            ORDER BY s.create_time DESC
        `);
        return result.recordset;
    }

    // Only alphanumeric, underscore, hyphen — prevents SQL injection in session name interpolation
    _isValidSessionName(sessionName) {
        return /^[a-zA-Z0-9_-]+$/.test(sessionName) && sessionName.length <= 100;
    }

    _generateProcedureSessionSQL(sessionName, procedureName) {
        return `
IF EXISTS (SELECT * FROM sys.server_event_sessions WHERE name = '${sessionName}')
    DROP EVENT SESSION [${sessionName}] ON SERVER;

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

    async dispose() {
        for (const [sessionName, info] of this._activeSessions) {
            if (info.status === 'running') {
                try { await this.stopSession(sessionName); } catch (error) {
                    console.error(`Error stopping session ${sessionName}:`, error);
                }
            }
        }
        this._activeSessions.clear();
    }
}

module.exports = ExtendedEventsService;
