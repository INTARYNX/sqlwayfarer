/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Extended Events Manager - Handles SQL Server Extended Events with Raw XML Display
class ExtendedEventsManager {
    constructor() {
        this.currentDatabase = null;
        this.currentSession = null;
        this.sessionStatus = 'stopped';
        this.availableProcedures = [];
        this.lastSessionInfo = null;
        this.lastRefreshTime = null;
        this.isRefreshing = false;
        this.autoRefreshTimer = null;
        this.autoRefreshInterval = 10000; // 10 seconds
        this.initDOMElements();
        this.initEventListeners();
    }

    initDOMElements() {
        this.elements = {
            procedureSelect: document.getElementById('xeventProcedureSelect'),
            sessionNameInput: document.getElementById('xeventSessionName'),
            createSessionBtn: document.getElementById('createSessionBtn'),
            startSessionBtn: document.getElementById('startSessionBtn'),
            stopSessionBtn: document.getElementById('stopSessionBtn'),
            deleteSessionBtn: document.getElementById('deleteSessionBtn'),
            refreshEventsBtn: document.getElementById('refreshEventsBtn'),
            sessionStatus: document.getElementById('xeventStatus'),
            sessionInfo: document.getElementById('sessionInfo'),
            eventsContainer: document.getElementById('eventsContainer')
        };
    }

    initEventListeners() {
        this.elements.createSessionBtn.addEventListener('click', () => this.handleCreateSession());
        this.elements.startSessionBtn.addEventListener('click', () => this.handleStartSession());
        this.elements.stopSessionBtn.addEventListener('click', () => this.handleStopSession());
        this.elements.deleteSessionBtn.addEventListener('click', () => this.handleDeleteSession());
        this.elements.procedureSelect.addEventListener('change', () => this.handleProcedureChange());
        
        // Add refresh events button listener
        if (this.elements.refreshEventsBtn) {
            this.elements.refreshEventsBtn.addEventListener('click', () => this.handleRefreshEvents());
        }
    }

    // Handle database change
    onDatabaseChanged(database) {
        this.currentDatabase = database;
        this.currentSession = null;
        this.sessionStatus = 'stopped';
        this.lastSessionInfo = null;
        this.lastRefreshTime = null;
        this.isRefreshing = false;
        this.stopAutoRefresh();
        this.updateUI();
        this.clearResults();

        if (database) {
            this.enableControls();
            this.loadProcedures();
        } else {
            this.disableControls();
            this.showPlaceholder();
        }
    }

    // Handle objects loaded
    onObjectsLoaded(objects) {
        // Filter only stored procedures
        this.availableProcedures = objects.filter(obj => obj.object_type === 'Procedure');
        this.populateProcedureSelect();
    }

    // Populate procedure dropdown
    populateProcedureSelect() {
        this.elements.procedureSelect.innerHTML = '<option value="">Select a stored procedure...</option>';
        
        this.availableProcedures.forEach(proc => {
            const option = document.createElement('option');
            option.value = proc.name;
            option.textContent = proc.name;
            this.elements.procedureSelect.appendChild(option);
        });

        this.elements.procedureSelect.disabled = false;
    }

    // Load procedures for the current database
    loadProcedures() {
        if (this.currentDatabase) {
            // Request procedures from the backend
            vscode.postMessage({
                command: 'getObjects',
                database: this.currentDatabase
            });
        }
    }

    // Handle procedure selection change
    handleProcedureChange() {
        const selectedProcedure = this.elements.procedureSelect.value;
        
        if (selectedProcedure) {
            // Generate session name with _1 suffix
            const sessionName = `XE_SQLWayfarer_${selectedProcedure}_1`;
            this.elements.sessionNameInput.value = sessionName;
            this.elements.createSessionBtn.disabled = false;
        } else {
            this.elements.sessionNameInput.value = '';
            this.elements.createSessionBtn.disabled = true;
        }

        this.updateSessionInfo();
    }

    // Handle create session
    handleCreateSession() {
        const procedureName = this.elements.procedureSelect.value;
        const sessionName = this.elements.sessionNameInput.value.trim();

        if (!procedureName || !sessionName) {
            this.showStatus('Please select a procedure and enter a session name.', 'error');
            return;
        }

        this.setButtonState(this.elements.createSessionBtn, true, 'Creating...');
        this.showStatus('Creating Extended Event session with ring buffer...', 'info');

        vscode.postMessage({
            command: 'createExecutionFlowSession',
            database: this.currentDatabase,
            sessionName: sessionName,
            config: {
                mode: 'stored_procedure_flow',
                targetObjects: [procedureName],
                includeDynamicSQL: true,
                includeSystemObjects: false
            }
        });
    }

    // Handle start session
    handleStartSession() {
        if (!this.currentSession) {
            this.showStatus('No session to start.', 'error');
            return;
        }

        this.setButtonState(this.elements.startSessionBtn, true, 'Starting...');
        this.showStatus('Starting Extended Event session...', 'info');

        vscode.postMessage({
            command: 'startExecutionFlowSession',
            sessionName: this.currentSession
        });
    }

    // Handle stop session
    handleStopSession() {
        if (!this.currentSession) {
            this.showStatus('No session to stop.', 'error');
            return;
        }

        this.setButtonState(this.elements.stopSessionBtn, true, 'Stopping...');
        this.showStatus('Stopping Extended Event session...', 'info');

        vscode.postMessage({
            command: 'stopExecutionFlowSession',
            sessionName: this.currentSession
        });
    }

    // Handle delete session
    async handleDeleteSession() {
        if (!this.currentSession) {
            this.showStatus('No session to delete.', 'error');
            return;
        }
        
        this.setButtonState(this.elements.deleteSessionBtn, true, 'Deleting...');
        this.showStatus('Deleting Extended Event session...', 'info');
        
        // If session is running, stop it first automatically
        if (this.sessionStatus === 'running') {
            this.showStatus('Stopping session before deletion...', 'info');
            
            vscode.postMessage({
                command: 'stopExecutionFlowSession',
                sessionName: this.currentSession
            });
            
            // Wait a moment for the stop to complete
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        vscode.postMessage({
            command: 'deleteExecutionFlowSession',
            sessionName: this.currentSession
        });
    }

    // Handle refresh events
    handleRefreshEvents() {
        if (!this.currentSession) {
            this.showStatus('No active session to refresh events from.', 'error');
            return;
        }

        this.isRefreshing = true;
        this.showRefreshingState();
        this.showStatus('Refreshing events from ring buffer...', 'info');
        
        // Get raw XML from ring buffer
        vscode.postMessage({
            command: 'getRawSessionEvents',
            sessionName: this.currentSession
        });
        
        // Also refresh session info to get event count
        vscode.postMessage({
            command: 'getExecutionFlowSessionInfo',
            sessionName: this.currentSession
        });
    }

    // Show refreshing state
    showRefreshingState() {
        const refreshBtn = document.getElementById('refreshEventsBtn');
        if (refreshBtn) {
            refreshBtn.disabled = true;
            refreshBtn.innerHTML = '🔄 Refreshing...';
        }
    }

    // Reset refresh button state
    resetRefreshState() {
        const refreshBtn = document.getElementById('refreshEventsBtn');
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.innerHTML = '🔄 Refresh Events';
        }
        this.isRefreshing = false;
    }

    // Message handlers
    onSessionCreated(result) {
        this.setButtonState(this.elements.createSessionBtn, false, 'Create Session');
        
        if (result.success) {
            this.currentSession = result.sessionName;
            this.sessionStatus = 'stopped';
            this.lastRefreshTime = null;
            this.showStatus(`Session "${this.currentSession}" created successfully.`, 'success');
            this.updateUI();
            this.updateSessionInfo();
            
            // Automatically get session info
            this.refreshSessionInfo();
        } else {
            this.showStatus(result.message, 'error');
        }
    }

    onSessionStarted(result) {
        this.setButtonState(this.elements.startSessionBtn, false, 'Start Session');
        
        if (result.success) {
            this.sessionStatus = 'running';
            this.showStatus(`Session started successfully. Execute your procedure to capture events.`, 'success');
            this.updateUI();
            this.updateSessionInfo();
            
            // Auto-refresh session info
            this.refreshSessionInfo();
            
            // Start auto-refresh timer
            this.startAutoRefresh();
        } else {
            this.showStatus(result.message, 'error');
        }
    }

    onSessionStopped(result) {
        this.setButtonState(this.elements.stopSessionBtn, false, 'Stop Session');
        
        if (result.success) {
            this.sessionStatus = 'stopped';
            this.showStatus(`Session stopped successfully.`, 'success');
            this.updateUI();
            this.updateSessionInfo();
            
            // Stop auto-refresh
            this.stopAutoRefresh();
            
            // Refresh session info and events
            this.refreshSessionInfo();
        } else {
            this.showStatus(result.message, 'error');
        }
    }

    onSessionDeleted(result) {
        this.setButtonState(this.elements.deleteSessionBtn, false, 'Delete Session');
        
        if (result.success) {
            this.currentSession = null;
            this.sessionStatus = 'stopped';
            this.lastSessionInfo = null;
            this.lastRefreshTime = null;
            this.elements.sessionNameInput.value = '';
            
            // Stop auto-refresh
            this.stopAutoRefresh();
            
            this.showStatus(`Session deleted successfully.`, 'success');
            this.updateUI();
            this.updateSessionInfo();
            this.clearResults();
        } else {
            this.showStatus(result.message, 'error');
        }
    }

    // Handle session info response
    onSessionInfoReceived(sessionName, info) {
        if (sessionName === this.currentSession) {
            this.lastSessionInfo = info;
            this.sessionStatus = info.status;
            this.updateSessionInfo();
            this.updateUI();
        }
    }

    // Handle raw XML events response
    onRawEventsReceived(sessionName, rawXml, message) {
        if (sessionName !== this.currentSession) {
            return;
        }

        // Update last refresh time
        this.lastRefreshTime = new Date();
        
        // Reset refresh button state
        this.resetRefreshState();
        
        this.showStatus(message, rawXml ? 'success' : 'info');
        this.displayRawEvents(rawXml);
        
        // Update session info to show new refresh time
        this.updateSessionInfo();
        
        // STOP auto-refresh if events are found
        if (rawXml && this.countEventsInXml(rawXml)) {
            this.stopAutoRefresh();
            this.showStatus('Events captured! Auto-refresh stopped. Use manual refresh to update.', 'success');
        }
    }

    // Display raw XML events for debugging
    displayRawEvents(rawXml) {
        if (!rawXml) {
            this.elements.eventsContainer.innerHTML = `
                <div class="no-events-message">
                    <p>No events captured yet.</p>
                    <p>1. Make sure the session is running</p>
                    <p>2. Execute your stored procedure: <code>EXEC dbo.${this.elements.procedureSelect.value}</code></p>
                    <p>3. Click "Refresh Events" to see captured data</p>
                </div>
            `;
        } else {
            // Display raw XML for debugging
            const xmlString = typeof rawXml === 'string' ? rawXml : 
                            (rawXml.toString ? rawXml.toString() : JSON.stringify(rawXml));
            
            this.elements.eventsContainer.innerHTML = `
                <div class="raw-xml-container">
                    <div class="xml-info">
                        <p><strong>📋 Raw XML from Ring Buffer:</strong></p>
                        <p>This shows the actual XML structure returned by the ring buffer target.</p>
                        <p>Use this to understand the event structure and build proper parsing.</p>
                        <p><strong>Events found:</strong> ${this.countEventsInXml(xmlString)}</p>
                    </div>
                    <div class="xml-content">
                        <pre><code class="xml-code">${this.escapeHtml(xmlString)}</code></pre>
                    </div>
                </div>
            `;
        }

        // DON'T re-attach refresh button listener - it's already in the main HTML
    }

    // Start auto-refresh timer
    startAutoRefresh() {
        if (this.autoRefreshTimer) {
            clearInterval(this.autoRefreshTimer);
        }
        
        this.autoRefreshTimer = setInterval(() => {
            if (this.currentSession && this.sessionStatus === 'running' && !this.isRefreshing) {
                this.handleRefreshEvents();
            }
        }, this.autoRefreshInterval);
    }

    // Stop auto-refresh timer
    stopAutoRefresh() {
        if (this.autoRefreshTimer) {
            clearInterval(this.autoRefreshTimer);
            this.autoRefreshTimer = null;
        }
    }

    // Count events in XML
    countEventsInXml(xmlString) {
        if (!xmlString) return 0;
        const eventMatches = xmlString.match(/<event/g);
        return eventMatches ? eventMatches.length : 0;
    }

    // Helper method to refresh session info
    refreshSessionInfo() {
        if (this.currentSession) {
            vscode.postMessage({
                command: 'getExecutionFlowSessionInfo',
                sessionName: this.currentSession
            });
        }
    }

    // UI Helper methods
    updateUI() {
        const hasSession = !!this.currentSession;
        const isRunning = this.sessionStatus === 'running';
        const isStopped = this.sessionStatus === 'stopped' && hasSession;

        // Create session button
        this.elements.createSessionBtn.disabled = hasSession || !this.elements.procedureSelect.value;

        // Session control buttons
        this.elements.startSessionBtn.disabled = !isStopped;
        this.elements.stopSessionBtn.disabled = !isRunning;
        this.elements.deleteSessionBtn.disabled = !hasSession;

        // Procedure selection
        this.elements.procedureSelect.disabled = hasSession;
        this.elements.sessionNameInput.disabled = hasSession;

        // Update refresh button if exists
        if (this.elements.refreshEventsBtn) {
            this.elements.refreshEventsBtn.disabled = !hasSession || this.isRefreshing;
        }
    }

    updateSessionInfo() {
        if (!this.currentSession) {
            this.elements.sessionInfo.innerHTML = '<p class="placeholder-text">No active session</p>';
            return;
        }

        const statusClass = this.sessionStatus === 'running' ? 'status-running' : 'status-stopped';
        const statusText = this.sessionStatus === 'running' ? 'Running' : 'Stopped';
        const procedureName = this.elements.procedureSelect.value;

        // Get event count from session info
        const eventCount = this.lastSessionInfo?.ringBufferEventCount || 0;
        
        // Use actual last refresh time, or show "Never" if not refreshed yet
        const lastRefresh = this.lastRefreshTime ? 
            this.lastRefreshTime.toLocaleTimeString() : 
            'Never';

        this.elements.sessionInfo.innerHTML = `
            <div class="session-details">
                <div class="session-detail-item">
                    <strong>Session:</strong> ${this.escapeHtml(this.currentSession)}
                </div>
                <div class="session-detail-item">
                    <strong>Status:</strong> 
                    <span class="session-status ${statusClass}">${statusText}</span>
                </div>
                <div class="session-detail-item">
                    <strong>Procedure:</strong> ${this.escapeHtml(procedureName)}
                </div>
                <div class="session-detail-item">
                    <strong>Database:</strong> ${this.escapeHtml(this.currentDatabase)}
                </div>
                <div class="session-detail-item">
                    <strong>Events Captured:</strong> 
                    <span class="event-count">${eventCount}</span>
                </div>
                <div class="session-detail-item">
                    <strong>Last Refresh:</strong> 
                    <span class="last-refresh">${lastRefresh}</span>
                </div>
            </div>
        `;
    }

    // Utility methods
    setButtonState(button, disabled, text) {
        button.disabled = disabled;
        if (text) button.textContent = text;
    }

    showStatus(message, type) {
        this.elements.sessionStatus.className = `status ${type}`;
        this.elements.sessionStatus.textContent = message;

        // Auto-hide info messages after 3 seconds
        if (type === 'info') {
            setTimeout(() => {
                if (this.elements.sessionStatus.className.includes('info')) {
                    this.elements.sessionStatus.textContent = '';
                    this.elements.sessionStatus.className = 'status';
                }
            }, 3000);
        }
    }

    enableControls() {
        this.elements.procedureSelect.disabled = false;
        this.elements.sessionNameInput.disabled = false;
        this.updateUI();
    }

    disableControls() {
        this.elements.procedureSelect.disabled = true;
        this.elements.sessionNameInput.disabled = true;
        this.elements.createSessionBtn.disabled = true;
        this.elements.startSessionBtn.disabled = true;
        this.elements.stopSessionBtn.disabled = true;
        this.elements.deleteSessionBtn.disabled = true;
        if (this.elements.refreshEventsBtn) {
            this.elements.refreshEventsBtn.disabled = true;
        }
    }

    clearResults() {
        this.elements.eventsContainer.innerHTML = '<p class="placeholder-text">Events will appear here when the session is running and the procedure is executed.</p>';
    }

    showPlaceholder() {
        this.elements.sessionInfo.innerHTML = '<p class="placeholder-text">Connect to a database to manage Extended Event sessions.</p>';
        this.clearResults();
    }

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}