/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Extended Events Manager - Handles SQL Server Extended Events
class ExtendedEventsManager {
    constructor() {
        this.currentDatabase = null;
        this.currentSession = null;
        this.sessionStatus = 'stopped';
        this.availableProcedures = [];
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
    }

    // Handle database change
    onDatabaseChanged(database) {
        this.currentDatabase = database;
        this.currentSession = null;
        this.sessionStatus = 'stopped';
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
            // Generate default session name
            const sessionName = `XE_SQLWayfarer_${selectedProcedure}_${Date.now()}`;
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
        this.showStatus('Creating Extended Event session...', 'info');

        vscode.postMessage({
            command: 'createExecutionFlowSession',
            database: this.currentDatabase,
            sessionName: sessionName,
            config: {
                mode: 'stored_procedure_flow',
                targetObjects: [procedureName],
                includeDynamicSQL: true,
                includeSystemObjects: false,
                maxFileSize: '100MB',
                maxFiles: 5
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
        
        // Remove this broken confirm line:
        // if (!confirm(`Are you sure you want to delete the session "${this.currentSession}"?`)) {
        //     return;
        // }
        
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

    // Message handlers
    onSessionCreated(result) {
        this.setButtonState(this.elements.createSessionBtn, false, 'Create Session');
        
        if (result.success) {
            this.currentSession = result.sessionName;
            this.sessionStatus = 'stopped';
            


            this.showStatus(`Session "${this.currentSession}" created successfully.`, 'success');
            this.updateUI();
            this.updateSessionInfo();
        } else {
            this.showStatus(result.message, 'error');
        }
    }

    onSessionStarted(result) {
        this.setButtonState(this.elements.startSessionBtn, false, 'Start Session');
        
        if (result.success) {
            this.sessionStatus = 'running';
            this.showStatus(`Session started successfully.`, 'success');
            this.updateUI();
            this.updateSessionInfo();
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
        } else {
            this.showStatus(result.message, 'error');
        }
    }

    onSessionDeleted(result) {
        this.setButtonState(this.elements.deleteSessionBtn, false, 'Delete Session');
        
        if (result.success) {
            this.currentSession = null;
            this.sessionStatus = 'stopped';
            this.elements.sessionNameInput.value = '';
            this.showStatus(`Session deleted successfully.`, 'success');
            this.updateUI();
            this.updateSessionInfo();
            this.clearResults();
        } else {
            this.showStatus(result.message, 'error');
        }
    }

    onEventsReceived(events) {
        this.displayEvents(events);
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
        this.elements.deleteSessionBtn.disabled = false;

        // Procedure selection
        this.elements.procedureSelect.disabled = hasSession;
        this.elements.sessionNameInput.disabled = hasSession;
    }

    updateSessionInfo() {
        if (!this.currentSession) {
            this.elements.sessionInfo.innerHTML = '<p class="placeholder-text">No active session</p>';
            return;
        }

        const statusClass = this.sessionStatus === 'running' ? 'status-running' : 'status-stopped';
        const statusText = this.sessionStatus === 'running' ? 'Running' : 'Stopped';
        const procedureName = this.elements.procedureSelect.value;

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
            </div>
        `;
    }

    displayEvents(events) {
        if (!events || events.length === 0) {
            this.elements.eventsContainer.innerHTML = '<p class="placeholder-text">No events captured yet. Execute the stored procedure to see events.</p>';
            return;
        }

        let html = `
            <div class="events-header">
                <h4>Captured Events (${events.length})</h4>
                <button id="clearEventsBtn" class="clear-events-btn">Clear Events</button>
            </div>
            <div class="events-list">
        `;

        events.forEach((event, index) => {
            html += `
                <div class="event-item">
                    <div class="event-header">
                        <span class="event-type">${this.escapeHtml(event.event_type)}</span>
                        <span class="event-timestamp">${new Date(event.timestamp).toLocaleString()}</span>
                    </div>
                    <div class="event-details">
                        <div class="event-detail"><strong>Object:</strong> ${this.escapeHtml(event.object_name || 'N/A')}</div>
                        <div class="event-detail"><strong>Statement:</strong> ${this.escapeHtml(event.statement || 'N/A')}</div>
                        <div class="event-detail"><strong>Duration:</strong> ${event.duration || 'N/A'} μs</div>
                    </div>
                </div>
            `;
        });

        html += '</div>';
        this.elements.eventsContainer.innerHTML = html;

        // Add clear events listener
        const clearBtn = document.getElementById('clearEventsBtn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => this.clearResults());
        }
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