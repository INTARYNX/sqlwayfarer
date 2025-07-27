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
        // Get the qualified name directly from the dropdown value
        const qualifiedName = this.elements.usageObjectSelect.value;
        if (!qualifiedName || !this.currentDatabase) {
            this.showStatus('Please select an object to analyze.', 'error');
            return;
        }

        this.setAnalyzeButtonState(this.elements.analyzeObjectBtn, true, 'Analyzing...');
        this.showStatus('Analyzing object table usage...', 'info');

        console.log(`Analyzing object: ${qualifiedName}`);

        vscode.postMessage({
            command: 'getTableUsageAnalysis',
            database: this.currentDatabase,
            objectName: qualifiedName  // Already qualified from dropdown
        });
    }

    handleAnalyzeTable() {
        // Get the qualified name directly from the dropdown value
        const qualifiedName = this.elements.usageTableSelect.value;
        if (!qualifiedName || !this.currentDatabase) {
            this.showStatus('Please select a table to analyze.', 'error');
            return;
        }

        this.setAnalyzeButtonState(this.elements.analyzeTableBtn, true, 'Analyzing...');
        this.showStatus('Analyzing table usage by objects...', 'info');

        console.log(`Analyzing table: ${qualifiedName}`);

        vscode.postMessage({
            command: 'getTableUsageByObjects',
            database: this.currentDatabase,
            tableName: qualifiedName  // Already qualified from dropdown
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
            // ALWAYS store qualified name as value for backend
            option.value = obj.qualified_name || obj.name;
            // Display the user-friendly name
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
        console.log('TableUsageManager: Objects loaded:', objects.length);
        // Refresh object dropdown if in object-to-tables mode
        if (this.elements.modeSelect.value === 'object-to-tables') {
            this.loadObjectsForUsage();
        }
    }

    onAllTablesLoaded(tables) {
        this.allTables = tables;
        console.log('TableUsageManager: Tables loaded:', tables.length);
        
        this.elements.usageTableSelect.innerHTML = '<option value="">Select a table...</option>';
        
        tables.forEach(table => {
            const option = document.createElement('option');
            // ALWAYS store qualified name as value for backend
            option.value = table.qualified_name || table.name;
            // Display just the user-friendly name
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

   // Enhanced display methods
   /**
    * Enhanced buildTablesUsedTable with better table name handling
    */
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
                           <th>Operations</th>
                           <th>Details</th>
                           <th>Sources</th>
                       </tr>
                   </thead>
                   <tbody>
       `;

       tablesUsed.forEach(table => {
           // Extract table name for display (remove schema if present for cleaner display)
           const tableName = table.referenced_object || table.table_name || 'Unknown';
           const displayTableName = tableName.includes('.') ? tableName.split('.').pop() : tableName;
           
           const operations = table.operations || [];
           const operationBadges = operations.map(op => {
               const operationClass = this.getOperationClass(op);
               return `<span class="operation-badge ${operationClass}">${op}</span>`;
           }).join(' ');
           
           const details = this.buildTableUsageDetails(table);
           const sources = table.sources ? table.sources.join(', ') : 'Smart Parser';
           
           html += `
               <tr>
                   <td><strong>${this.escapeHtml(displayTableName)}</strong></td>
                   <td class="operations-cell">
                       <div class="multi-operation-container">${operationBadges}</div>
                   </td>
                   <td class="usage-details-cell">${details}</td>
                   <td class="sources-cell">
                       <span class="source-info">${this.escapeHtml(sources)}</span>
                   </td>
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

   /**
    * Enhanced displayObjectUsageAnalysis with better formatting
    */
   displayObjectUsageAnalysis(analysis) {
       console.log('Displaying object usage analysis:', analysis);
       
       let html = `
           <div class="usage-summary">
               <h3 class="usage-section-title">Object Usage Analysis: ${analysis.objectName}</h3>
               ${this.buildUsageSummaryStats(analysis.summary)}
           </div>
       `;

       // Tables Used Section
       html += `<div class="usage-section-title">Tables Used by This Object</div>`;
       if (analysis.tablesUsed && analysis.tablesUsed.length > 0) {
           html += this.buildTablesUsedTable(analysis.tablesUsed);
       } else {
           html += '<div class="no-usage-data">No table usage detected for this object.</div>';
       }
       
       // Related Objects Section
       html += `<div class="usage-section-title">Related Objects (using same tables)</div>`;
       if (analysis.relatedObjects && analysis.relatedObjects.length > 0) {
           html += this.buildRelatedObjectsTable(analysis.relatedObjects);
           
           // Add summary of related objects
           const relatedSummary = this.buildRelatedObjectsSummary(analysis.relatedObjects);
           html += relatedSummary;
       } else {
           html += '<div class="no-usage-data">No related objects found using the same tables.</div>';
       }
       
       this.elements.usageResults.innerHTML = html;
   }

   /**
    * Enhanced buildUsageSummaryStats with operation breakdown
    */
   buildUsageSummaryStats(summary) {
       const operationBreakdown = summary.operationCounts || {};
       const totalOperations = Object.values(operationBreakdown).reduce((sum, count) => sum + count, 0);
       
       let html = `
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
                   <span class="stat-number">${totalOperations}</span>
                   <span class="stat-label">Total Operations</span>
               </div>
           </div>
       `;

       // Add operation breakdown if we have detailed counts
       if (Object.keys(operationBreakdown).length > 0) {
           html += `
               <div class="operation-breakdown">
                   <h4 style="margin: 0 0 10px 0; font-size: 13px; color: var(--vscode-foreground);">Operation Breakdown</h4>
           `;

           // Sort operations by count (descending)
           const sortedOperations = Object.entries(operationBreakdown)
               .sort(([,a], [,b]) => b - a);

           sortedOperations.forEach(([operation, count]) => {
               const percentage = totalOperations > 0 ? Math.round((count / totalOperations) * 100) : 0;
               const statClass = this.getOperationStatClass(operation);
               
               html += `
                   <div class="operation-stat ${statClass}">
                       <span class="operation-stat-number">${count}</span>
                       <span class="operation-stat-label">${operation}</span>
                       <div class="operation-percentage">${percentage}%</div>
                   </div>
               `;
           });

           html += '</div>';
       }

       return html;
   }

   /**
    * Get CSS class for operation statistics
    */
   getOperationStatClass(operation) {
       const op = operation.toUpperCase();
       if (op.includes('SELECT')) return 'select-stat';
       if (op.includes('INSERT')) return 'insert-stat';
       if (op.includes('UPDATE')) return 'update-stat';
       if (op.includes('DELETE')) return 'delete-stat';
       return 'reference-stat';
   }

   /**
    * Build summary for related objects
    */
   buildRelatedObjectsSummary(relatedObjects) {
       const objectTypes = {};
       const operationCounts = {};
       const uniqueObjects = new Set();

       relatedObjects.forEach(obj => {
           uniqueObjects.add(obj.object_name);
           
           // Count object types
           objectTypes[obj.object_type] = (objectTypes[obj.object_type] || 0) + 1;
           
           // Count operations
           if (obj.operations_array) {
               obj.operations_array.forEach(op => {
                   operationCounts[op] = (operationCounts[op] || 0) + 1;
               });
           } else if (obj.operation_type) {
               const operations = obj.operation_type.split(',').map(op => op.trim());
               operations.forEach(op => {
                   operationCounts[op] = (operationCounts[op] || 0) + 1;
               });
           }
       });

       let html = `
           <div class="related-objects-summary">
               <h4 style="margin: 15px 0 10px 0; font-size: 14px; color: var(--vscode-foreground);">
                   📈 Related Objects Summary
               </h4>
               <div class="summary-grid">
                   <div class="summary-item">
                       <span class="summary-number">${uniqueObjects.size}</span>
                       <span class="summary-label">Unique Objects</span>
                   </div>
       `;

       // Add object type breakdown
       Object.entries(objectTypes).forEach(([type, count]) => {
           html += `
               <div class="summary-item">
                   <span class="summary-number">${count}</span>
                   <span class="summary-label">${type}s</span>
               </div>
           `;
       });

       html += '</div>';

       // Add operation distribution
       if (Object.keys(operationCounts).length > 1) {
           html += `
               <div class="operation-distribution">
                   <h5 style="margin: 10px 0 8px 0; font-size: 12px; color: var(--vscode-descriptionForeground);">
                       Operation Distribution:
                   </h5>
           `;
           
           Object.entries(operationCounts)
               .sort(([,a], [,b]) => b - a)
               .forEach(([operation, count]) => {
                   const operationClass = this.getOperationClass(operation);
                   html += `<span class="operation-badge ${operationClass}" style="margin: 2px;">${operation} (${count})</span>`;
               });
           
           html += '</div>';
       }

       html += '</div>';
       return html;
   }

   /**
    * Build detailed usage information for a table
    */
   buildTableUsageDetails(table) {
       const details = [];
       
       if (table.is_select_all && table.is_select_all > 0) {
           details.push('<span class="detail-item select-detail">SELECT *</span>');
       } else if (table.is_selected && table.is_selected > 0) {
           details.push('<span class="detail-item select-detail">SELECT columns</span>');
       }
       
       if (table.is_updated && table.is_updated > 0) {
           details.push('<span class="detail-item update-detail">UPDATE statements</span>');
       }
       
       if (table.is_insert_all && table.is_insert_all > 0) {
           details.push('<span class="detail-item insert-detail">INSERT statements</span>');
       }
       
       if (table.is_delete && table.is_delete > 0) {
           details.push('<span class="detail-item delete-detail">DELETE statements</span>');
       }
       
       if (table.usage_details) {
           details.push(`<span class="detail-item">${table.usage_details}</span>`);
       }
       
       return details.length > 0 ? details.join('<br>') : '<span class="detail-item reference-detail">Referenced</span>';
   }

   /**
    * Enhanced buildRelatedObjectsTable with proper operation consolidation
    */
   buildRelatedObjectsTable(relatedObjects) {
       if (!relatedObjects || relatedObjects.length === 0) {
           return '<div class="no-usage-data">No related objects found.</div>';
       }

       // Group objects by name to consolidate all their table operations
       const objectGroups = new Map();
       
       relatedObjects.forEach(obj => {
           if (!objectGroups.has(obj.object_name)) {
               objectGroups.set(obj.object_name, {
                   object_name: obj.object_name,
                   object_type: obj.object_type,
                   tables: new Map(),
                   allOperations: new Set()
               });
           }
           
           const group = objectGroups.get(obj.object_name);
           
           if (!group.tables.has(obj.table_name)) {
               group.tables.set(obj.table_name, new Set());
           }
           
           // Add operations for this table
           const operations = obj.operations_array || 
                             (obj.operation_type ? obj.operation_type.split(',').map(op => op.trim()) : ['REFERENCE']);
           
           operations.forEach(op => {
               group.tables.get(obj.table_name).add(op);
               group.allOperations.add(op);
           });
       });

       let html = `
           <div class="usage-table-container">
               <table class="usage-table">
                   <thead>
                       <tr>
                           <th>Object Name</th>
                           <th>Type</th>
                           <th>Tables & Operations</th>
                           <th>All Operations</th>
                       </tr>
                   </thead>
                   <tbody>
       `;

       Array.from(objectGroups.values()).forEach(group => {
           const objectTypeBadge = `<span class="object-type-badge ${group.object_type.toLowerCase()}-badge">${group.object_type}</span>`;
           
           // Build table operations display
           const tableOperations = Array.from(group.tables.entries()).map(([tableName, operations]) => {
               const displayTableName = tableName.includes('.') ? tableName.split('.').pop() : tableName;
               const operationBadges = Array.from(operations).map(op => {
                   const operationClass = this.getOperationClass(op);
                   return `<span class="operation-badge ${operationClass}">${op}</span>`;
               }).join(' ');
               
               return `
                   <div class="table-operation-item">
                       <strong>${this.escapeHtml(displayTableName)}</strong><br>
                       <div class="multi-operation-container">${operationBadges}</div>
                   </div>
               `;
           }).join('');
           
           // Build summary operations
           const allOperationBadges = Array.from(group.allOperations).map(op => {
               const operationClass = this.getOperationClass(op);
               return `<span class="operation-badge ${operationClass}">${op}</span>`;
           }).join(' ');
           
           html += `
               <tr>
                   <td><strong>${this.escapeHtml(group.object_name)}</strong></td>
                   <td>${objectTypeBadge}</td>
                   <td class="table-operations-cell">${tableOperations}</td>
                   <td class="operations-summary-cell">
                       <div class="multi-operation-container">${allOperationBadges}</div>
                   </td>
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

   /**
    * Enhanced operation class detection
    */
   getOperationClass(operationType) {
       if (!operationType) return 'operation-unknown';
       
       const type = operationType.toUpperCase().trim();
       if (type.includes('SELECT')) return 'operation-select';
       if (type.includes('INSERT')) return 'operation-insert';
       if (type.includes('UPDATE')) return 'operation-update';
       if (type.includes('DELETE')) return 'operation-delete';
       if (type.includes('REFERENCE')) return 'operation-reference';
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