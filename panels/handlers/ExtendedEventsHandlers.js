'use strict';

class ExtendedEventsHandlers {
    constructor(postMessage, extendedEventsService, getCurrentDatabase) {
        this._post = postMessage;
        this._extendedEventsService = extendedEventsService;
        this._getCurrentDatabase = getCurrentDatabase;
    }

    async handleCreateExecutionFlowSession(database, sessionName, config) {
        try {
            const targetDatabase = database || this._getCurrentDatabase();
            const result = await this._extendedEventsService.createExecutionFlowSession(targetDatabase, sessionName, config || {});
            this._post({ command: 'executionFlowSessionCreated', success: result.success, message: result.message, sessionName: result.sessionName || sessionName });
        } catch (error) {
            this._post({ command: 'executionFlowSessionCreated', success: false, message: `Failed to create execution flow session: ${error.message}` });
        }
    }

    async handleStartExecutionFlowSession(sessionName) {
        try {
            const result = await this._extendedEventsService.startSession(sessionName);
            this._post({ command: 'executionFlowSessionStarted', success: result.success, message: result.message, sessionName });
        } catch (error) {
            this._post({ command: 'executionFlowSessionStarted', success: false, message: `Failed to start execution flow session: ${error.message}` });
        }
    }

    async handleStopExecutionFlowSession(sessionName) {
        try {
            const result = await this._extendedEventsService.stopSession(sessionName);
            this._post({ command: 'executionFlowSessionStopped', success: result.success, message: result.message, sessionName });
        } catch (error) {
            this._post({ command: 'executionFlowSessionStopped', success: false, message: `Failed to stop execution flow session: ${error.message}` });
        }
    }

    async handleDeleteExecutionFlowSession(sessionName) {
        try {
            const result = await this._extendedEventsService.deleteSession(sessionName);
            this._post({ command: 'executionFlowSessionDeleted', success: result.success, message: result.message, sessionName });
        } catch (error) {
            this._post({ command: 'executionFlowSessionDeleted', success: false, message: `Failed to delete execution flow session: ${error.message}` });
        }
    }

    async handleGetExecutionFlowSessionInfo(sessionName) {
        try {
            const info = await this._extendedEventsService.getSessionInfo(sessionName);
            this._post({ command: 'executionFlowSessionInfo', success: true, sessionName, info });
        } catch (error) {
            this._post({ command: 'executionFlowSessionInfo', success: false, message: `Failed to get session info: ${error.message}` });
        }
    }

    async handleListExecutionFlowSessions() {
        try {
            const sessions = await this._extendedEventsService.listSessions();
            this._post({ command: 'executionFlowSessionsList', success: true, sessions });
        } catch (error) {
            this._post({ command: 'executionFlowSessionsList', success: false, message: `Failed to list sessions: ${error.message}` });
        }
    }

    async handleGetRawSessionEvents(sessionName) {
        try {
            const result = await this._extendedEventsService.getSessionRawEvents(sessionName);
            this._post({ command: 'rawSessionEventsResult', success: result.success, sessionName, rawXml: result.rawXml, message: result.message });
        } catch (error) {
            this._post({ command: 'rawSessionEventsResult', success: false, sessionName, message: `Failed to get raw events: ${error.message}` });
        }
    }
}

module.exports = ExtendedEventsHandlers;
