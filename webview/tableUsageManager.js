'use strict';

// Table Usage Manager
class TableUsageManager {
    constructor() {
        this.currentDatabase = null;
        this.allObjects = [];
        this.allTables = [];
        this.currentAnalysis = null;
        this.initDOMElements();
        this.initEventListeners();
    }

    initDOMElements() {
        this.elements = {
            modeSelect: document.getElementById('usageModeSelect'),
            objectToTablesMode: document.getElementById('objectToTablesMode'),
            tableToObjectsMode: document.getElementById('tableToObjectsMode'),
            triggersMode: document.getElementById('triggersMode'),
            usageObjectSelect: document.getElementById('usageObjectSelect'),
            usageTableSelect: document.getElementById('usageTableSelect'),
            analyzeObjectBtn: document.getElementById('analyzeObjectBtn'),
            analyzeTableBtn: document.getElementById('analyzeTableBtn'),
            analyzeTriggerBtn: document.getElementById('analyzeTriggerBtn'),
            usageStatus: document.getElementById('usageStatus'),
            usageResults: document.getElementById('usageResults')
        };
    }

    initEventListeners() {
        this.elements.modeSelect.addEventListener('change', () => this.handleModeChange());
        this.elements.analyzeObjectBtn.addEventListener('click', () => this.handleAnalyzeObject());
        this.elements.analyzeTableBtn.addEventListener('click', () => this.handleAnalyzeTable());
        this.elements.analyzeTriggerBtn.addEventListener('click', () => this.handleAnalyzeTriggers());
    }

    handleModeChange() {
        const mode = this.elements.modeSelect.value;
        
        // Hide all mode panels
        this.elements.objectToTablesMode.style.display = 'none';
        this.elements.tableToObjectsMode.style.display = 'none';
        this.elements.triggersMode.style.display = 'none';
        
        // Clear results
        this.clearResults();
        
        // Show selected mode panel
        switch (mode) {
            case 'object-to-tables':
                this.elements.objectToTablesMode.style.display = 'block';
                this.loadObjectsForUsage();
                break;
            case 'table-to-objects':
                this.elements.tableToObjectsMode.style.display = 'block';
                this.loadTablesForUsage();
                break;
            case 'triggers':
                this.elements.triggersMode.style.display = 'block';
                this.enableTriggerAnalysis();
                break;
        }
    }

    handleAnalyzeObject() {
        const objectName = this.elements.usageObjectSelect.value;
        if (!objectName || !this.currentDatabase) {
            this.showStatus('Please select an object to analyze.', 'error');
            return;
        }

        this.setAnalyzeButtonState(this.elements.analyzeObjectBtn, true, 'Analyzing...');
        this.showStatus('Analyzing object table usage...', 'info');

        vscode.postMessage({
            command: 'getTableUsageAnalysis',
            database: this.currentDatabase,
            objectName: objectName
        });
    }

    handleAnalyzeTable() {
        const tableName = this.elements.usageTableSelect.value;
        if (!tableName || !this.currentDatabase) {
            this.showStatus('Please select a table to analyze.', 'error');
            return;
        }

        this.setAnalyzeButtonState(this.elements.analyzeTableBtn, true, 'Analyzing...');
        this.showStatus('Analyzing table usage by objects...', 'info');

        vscode.postMessage({
            command: 'getTableUsageByObjects',
            database: this.currentDatabase,
            tableName: tableName
        });
    }

    handleAnalyzeTriggers() {
        if (!this.currentDatabase) {
            this.showStatus('Please select a database first.', 'error');
            return;
        }

        this.setAnalyzeButtonState(this.elements.analyzeTriggerBtn, true, 'Analyzing...');
        this.showStatus('Analyzing database triggers...', 'info');

        vscode.postMessage({
            command: 'getTriggerAnalysis',
            database: this.currentDatabase
        });
    }

    loadObjectsForUsage() {
        if (!this.currentDatabase) {
            this.elements.usageObjectSelect.innerHTML = '<option value="">Connect to a database first</option>';
            this.elements.usageObjectSelect.disabled = true;
            this.elements.analyzeObjectBtn.disabled = true;
            return;
        }

        // Filter objects to procedures, functions, views, and triggers
        const usableObjects = this.allObjects.filter(obj => 
            ['Procedure', 'Function', 'View'].includes(obj.object_type)
        );

        this.elements.usageObjectSelect.innerHTML = '<option value="">Select an object...</option>';
        
        usableObjects.forEach(obj => {
            const option = document.createElement('option');
            option.value = obj.name;
            option.textContent = `${obj.name} (${obj.object_type})`;
            this.elements.usageObjectSelect.appendChild(option);
        });

        this.elements.usageObjectSelect.disabled = false;
        this.elements.analyzeObjectBtn.disabled = false;
    }

    loadTablesForUsage() {
        if (!this.currentDatabase) {
            this.elements.usageTableSelect.innerHTML = '<option value="">Connect to a database first</option>';
            this.elements.usageTableSelect.disabled = true;
            this.elements.analyzeTableBtn.disabled = true;
            return;
        }

        // Load tables specifically for usage analysis
        vscode.postMessage({
            command: 'getAllTablesForUsage',
            database: this.currentDatabase
        });
    }

    enableTriggerAnalysis() {
        if (!this.currentDatabase) {
            this.elements.analyzeTriggerBtn.disabled = true;
            return;
        }
        this.elements.analyzeTriggerBtn.disabled = false;
    }

    // Message handlers
    onDatabaseChanged(database) {
        this.currentDatabase = database;
        this.clearResults();
        
        if (database) {
            this.elements.modeSelect.disabled = false;
            // Reset mode selection
            this.elements.modeSelect.value = '';
            this.handleModeChange();
        } else {
            this.elements.modeSelect.disabled = true;
            this.disableAllControls();
        }
    }

    onObjectsLoaded(objects) {
        this.allObjects = objects;
        // Refresh object dropdown if in object-to-tables mode
        if (this.elements.modeSelect.value === 'object-to-tables') {
            this.loadObjectsForUsage();
        }
    }

    onAllTablesLoaded(tables) {
        this.allTables = tables;
        
        this.elements.usageTableSelect.innerHTML = '<option value="">Select a table...</option>';
        
        tables.forEach(table => {
            const option = document.createElement('option');
            option.value = table.name;
            option.textContent = table.name;
            this.elements.usageTableSelect.appendChild(option);
        });

        this.elements.usageTableSelect.disabled = false;
        this.elements.analyzeTableBtn.disabled = false;
    }

    onTableUsageAnalysisResult(objectName, analysis) {
        this.setAnalyzeButtonState(this.elements.analyzeObjectBtn, false, 'Analyze Object Usage');
        this.currentAnalysis = analysis;
        this.displayObjectUsageAnalysis(analysis);
        this.showStatus(`Analysis complete for ${objectName}`, 'success');
    }

    onTableUsageByObjectsResult(tableName, usage) {
        this.setAnalyzeButtonState(this.elements.analyzeTableBtn, false, 'Analyze Table Usage');
        this.currentAnalysis = usage;
        this.displayTableUsageAnalysis(usage);
        this.showStatus(`Analysis complete for table ${tableName}`, 'success');
    }

    onTriggerAnalysisResult(database, triggers) {
        this.setAnalyzeButtonState(this.elements.analyzeTriggerBtn, false, 'Analyze All Triggers');
        this.currentAnalysis = triggers;
        this.displayTriggerAnalysis(triggers);
        this.showStatus(`Found ${triggers.length} triggers in ${database}`, 'success');
    }

    // Display methods
    displayObjectUsageAnalysis(analysis) {
        const html = [
            `<div class="usage-summary">`,
            `<h3 class="usage-section-title">Object Usage Analysis: ${analysis.objectName}</h3>`,
            this.buildUsageSummaryStats(analysis.summary),
            `</div>`,
            
            `<div class="usage-section-title">Tables Used by This Object</div>`,
            this.buildTablesUsedTable(analysis.tablesUsed),
            
            `<div class="usage-section-title">Related Objects (using same tables)</div>`,
            this.buildRelatedObjectsTable(analysis.relatedObjects)
        ].join('');
        
        this.elements.usageResults.innerHTML = html;
    }

    displayTableUsageAnalysis(usage) {
        const html = [
            `<div class="usage-summary">`,
            `<h3 class="usage-section-title">Table Usage Analysis: ${usage.tableName}</h3>`,
            this.buildTableUsageSummaryStats(usage.summary),
            `</div>`,
            
            `<div class="usage-section-title">Objects Using This Table</div>`,
            this.buildObjectsUsingTableTable(usage.usedByObjects)
        ].join('');
        
        this.elements.usageResults.innerHTML = html;
    }

    displayTriggerAnalysis(triggers) {
        const html = [
            `<div class="usage-summary">`,
            `<h3 class="usage-section-title">Database Trigger Analysis</h3>`,
            this.buildTriggerSummaryStats(triggers),
            `</div>`,
            
            `<div class="usage-section-title">Triggers by Table</div>`,
            this.buildTriggersGroupedByTable(triggers)
        ].join('');
        
        this.elements.usageResults.innerHTML = html;
    }

    buildUsageSummaryStats(summary) {
        return `
            <div class="summary-stats">
                <div class="summary-stat">
                    <span class="stat-number">${summary.totalTables}</span>
                    <span class="stat-label">Total Tables</span>
                </div>
                <div class="summary-stat">
                    <span class="stat-number">${summary.readTables}</span>
                    <span class="stat-label">Read Tables</span>
                </div>
                <div class="summary-stat">
                    <span class="stat-number">${summary.writeTables}</span>
                    <span class="stat-label">Write Tables</span>
                </div>
                <div class="summary-stat">
                    <span class="stat-number">${Object.keys(summary.operationTypes || {}).length}</span>
                    <span class="stat-label">Operation Types</span>
                </div>
            </div>
        `;
    }

    buildTableUsageSummaryStats(summary) {
        return `
            <div class="summary-stats">
                <div class="summary-stat">
                    <span class="stat-number">${summary.totalObjects}</span>
                    <span class="stat-label">Total Objects</span>
                </div>
                <div class="summary-stat">
                    <span class="stat-number">${summary.procedures}</span>
                    <span class="stat-label">Procedures</span>
                </div>
                <div class="summary-stat">
                    <span class="stat-number">${summary.views}</span>
                    <span class="stat-label">Views</span>
                </div>
                <div class="summary-stat">
                    <span class="stat-number">${summary.functions}</span>
                    <span class="stat-label">Functions</span>
                </div>
                <div class="summary-stat">
                    <span class="stat-number">${summary.triggers}</span>
                    <span class="stat-label">Triggers</span>
                </div>
                <div class="summary-stat">
                    <span class="stat-number">${summary.tables}</span>
                    <span class="stat-label">FK Tables</span>
                </div>
            </div>
        `;
    }

    buildTriggerSummaryStats(triggers) {
        const stats = {
            total: triggers.length,
            enabled: triggers.filter(t => !t.is_disabled).length,
            disabled: triggers.filter(t => t.is_disabled).length,
            tables: new Set(triggers.map(t => t.table_name)).size
        };

        return `
            <div class="summary-stats">
                <div class="summary-stat">
                    <span class="stat-number">${stats.total}</span>
                    <span class="stat-label">Total Triggers</span>
                </div>
                <div class="summary-stat">
                    <span class="stat-number">${stats.enabled}</span>
                    <span class="stat-label">Enabled</span>
                </div>
                <div class="summary-stat">
                    <span class="stat-number">${stats.disabled}</span>
                    <span class="stat-label">Disabled</span>
                </div>
                <div class="summary-stat">
                    <span class="stat-number">${stats.tables}</span>
                    <span class="stat-label">Tables</span>
                </div>
            </div>
        `;
    }

    buildTablesUsedTable(tablesUsed) {
        if (!tablesUsed || tablesUsed.length === 0) {
            return '<p class="placeholder-text">No table usage found.</p>';
        }

        let html = `
            <div class="usage-table-container">
                <table class="usage-table">
                    <thead>
                        <tr>
                            <th>Table Name</th>
                            <th>Operation Type</th>
                            <th>Usage Details</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        tablesUsed.forEach(table => {
            const operationClass = this.getOperationClass(table.operation_type);
            const usageDetails = this.buildUsageDetails(table);
            
            html += `
                <tr>
                    <td><strong>${this.escapeHtml(table.table_name)}</strong></td>
                    <td><span class="operation-badge ${operationClass}">${table.operation_type}</span></td>
                    <td>${usageDetails}</td>
                </tr>
            `;
        });

        html += `
                    </tbody>
                </table>
            </div>
        `;

        return html;
    }

    buildRelatedObjectsTable(relatedObjects) {
        if (!relatedObjects || relatedObjects.length === 0) {
            return '<p class="placeholder-text">No related objects found.</p>';
        }

        let html = `
            <div class="usage-table-container">
                <table class="usage-table">
                    <thead>
                        <tr>
                            <th>Object Name</th>
                            <th>Object Type</th>
                            <th>Table Used</th>
                            <th>Operation</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        relatedObjects.forEach(obj => {
            const operationClass = this.getOperationClass(obj.operation_type);
            
            html += `
                <tr>
                    <td><strong>${this.escapeHtml(obj.object_name)}</strong></td>
                    <td><span class="object-type-badge">${obj.object_type}</span></td>
                    <td>${this.escapeHtml(obj.table_name)}</td>
                    <td><span class="operation-badge ${operationClass}">${obj.operation_type}</span></td>
                </tr>
            `;
        });

        html += `
                    </tbody>
                </table>
            </div>
        `;

        return html;
    }

    buildObjectsUsingTableTable(usedByObjects) {
        if (!usedByObjects || usedByObjects.length === 0) {
            return '<p class="placeholder-text">No objects found using this table.</p>';
        }

        let html = `
            <div class="usage-table-container">
                <table class="usage-table">
                    <thead>
                        <tr>
                            <th>Object Name</th>
                            <th>Object Type</th>
                            <th>Operation Type</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        usedByObjects.forEach(obj => {
            const operationClass = this.getOperationClass(obj.operation_type);
            
            html += `
                <tr>
                    <td><strong>${this.escapeHtml(obj.object_name || obj.referencing_object)}</strong></td>
                    <td><span class="object-type-badge">${obj.object_type || obj.referencing_object_type}</span></td>
                    <td><span class="operation-badge ${operationClass}">${obj.operation_type}</span></td>
                </tr>
            `;
        });

        html += `
                    </tbody>
                </table>
            </div>
        `;

        return html;
    }

    buildTriggersGroupedByTable(triggers) {
        if (!triggers || triggers.length === 0) {
            return '<p class="placeholder-text">No triggers found in this database.</p>';
        }

        // Group triggers by table
        const triggersByTable = {};
        triggers.forEach(trigger => {
            const tableName = trigger.table_name;
            if (!triggersByTable[tableName]) {
                triggersByTable[tableName] = [];
            }
            triggersByTable[tableName].push(trigger);
        });

        let html = '<div class="trigger-info">';

        Object.keys(triggersByTable).sort().forEach(tableName => {
            html += `
                <div class="trigger-table-group">
                    <div class="trigger-table-name">${this.escapeHtml(tableName)} (${triggersByTable[tableName].length} triggers)</div>
            `;

            triggersByTable[tableName].forEach(trigger => {
                const disabledClass = trigger.is_disabled ? ' trigger-disabled' : '';
                const statusText = trigger.is_disabled ? ' [DISABLED]' : '';
                
                html += `
                    <div class="trigger-item${disabledClass}">
                        <strong>${this.escapeHtml(trigger.trigger_name)}</strong>${statusText}<br>
                        <span style="font-size: 11px; color: var(--vscode-descriptionForeground);">
                            ${trigger.trigger_timing} ${trigger.trigger_event} • 
                            Created: ${new Date(trigger.create_date).toLocaleDateString()} • 
                            Modified: ${new Date(trigger.modify_date).toLocaleDateString()}
                        </span>
                    </div>
                `;
            });

            html += '</div>';
        });

        html += '</div>';
        return html;
    }

    buildUsageDetails(table) {
        const details = [];
        
        if (table.is_select_all) details.push('SELECT *');
        if (table.is_updated) details.push('UPDATE');
        if (table.is_insert_all) details.push('INSERT');
        if (table.is_delete) details.push('DELETE');
        
        return details.length > 0 ? details.join(', ') : 'Reference';
    }

    getOperationClass(operationType) {
        if (!operationType) return 'operation-unknown';
        
        const type = operationType.toLowerCase();
        if (type.includes('select')) return 'operation-select';
        if (type.includes('insert')) return 'operation-insert';
        if (type.includes('update')) return 'operation-update';
        if (type.includes('delete')) return 'operation-delete';
        if (type.includes('reference')) return 'operation-reference';
        return 'operation-unknown';
    }

    // Utility methods
    setAnalyzeButtonState(button, disabled, text) {
        button.disabled = disabled;
        if (text) button.textContent = text;
    }

    showStatus(message, type) {
        this.elements.usageStatus.className = `status ${type}`;
        this.elements.usageStatus.textContent = message;
    }

    clearResults() {
        this.elements.usageResults.innerHTML = '<p class="placeholder-text">Select an analysis mode and click Analyze to see results.</p>';
        this.elements.usageStatus.textContent = '';
        this.elements.usageStatus.className = 'status-container';
    }

    disableAllControls() {
        this.elements.usageObjectSelect.disabled = true;
        this.elements.usageTableSelect.disabled = true;
        this.elements.analyzeObjectBtn.disabled = true;
        this.elements.analyzeTableBtn.disabled = true;
        this.elements.analyzeTriggerBtn.disabled = true;
        
        // Hide all mode panels
        this.elements.objectToTablesMode.style.display = 'none';
        this.elements.tableToObjectsMode.style.display = 'none';
        this.elements.triggersMode.style.display = 'none';
    }

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}