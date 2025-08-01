/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Code View Manager - Handles displaying and managing SQL code definitions
class CodeViewManager {
    constructor() {
        this.currentDatabase = null;
        this.currentObject = null;
        this.currentObjectType = null;
        this.currentDefinition = null;
        this.isExpanded = false;
        this.showLineNumbers = false;
    }

    // Called when an object is selected in the Explorer
    loadCodeForObject(database, objectName, objectType, definition = null) {
        this.currentDatabase = database;
        this.currentObject = objectName;
        this.currentObjectType = objectType;
        this.currentDefinition = definition;

        console.log(`Loading code for ${objectType}: ${objectName}`);

        // Handle tables differently (they don't have code definitions)
        if (objectType === 'Table') {
            this.displayTableMessage();
            return;
        }

        // If we already have the definition, display it
        if (definition) {
            this.displayCode(definition);
        } else {
            // Request the definition from the backend
            this.showLoadingState();
            // The definition will come through the object details handler
        }
    }

    // Display code definition
    displayCode(definition) {
        if (!definition || definition.trim() === '') {
            this.displayNoCodeMessage();
            return;
        }

        const container = document.getElementById('codeContainer');
        if (!container) return;

        const objectTypeClass = this.getObjectTypeClass(this.currentObjectType);
        const objectIcon = this.getObjectTypeIcon(this.currentObjectType);
        
        let html = `
            <div class="code-viewer">
                <div class="code-header">
                    <div class="code-title">
                        <span class="object-type-indicator ${objectTypeClass}">
                            ${this.currentObjectType}
                        </span>
                        <span>${this.escapeHtml(this.currentObject)}</span>
                    </div>
                    <div class="code-actions">
                        <button class="code-action-btn copy-btn" onclick="window.codeViewManager.copyCode()" title="Copy code">
                            Copy
                        </button>
                        <button class="code-action-btn format-btn" onclick="window.codeViewManager.formatCode()" title="Format SQL">
                            Format
                        </button>
                        <button class="code-action-btn" onclick="window.codeViewManager.toggleLineNumbers()" title="Toggle line numbers">
                            ${this.showLineNumbers ? 'Hide Lines' : 'Show Lines'}
                        </button>
                        <button class="code-action-btn expand-btn" onclick="window.codeViewManager.toggleExpand()" title="Expand/Collapse">
                            ${this.isExpanded ? 'Collapse' : 'Expand'}
                        </button>
                    </div>
                </div>
                
                <div class="code-content ${this.isExpanded ? 'expanded' : ''}">
                    ${this.renderCodeContent(definition)}
                </div>
                
                <div class="code-metrics">
                    <div class="code-stats">
                        <div class="code-stat">
                            📏 <span class="code-stat-value">${this.countLines(definition)}</span> lines
                        </div>
                        <div class="code-stat">
                            📝 <span class="code-stat-value">${definition.length}</span> characters
                        </div>
                        <div class="code-stat">
                            📊 <span class="code-stat-value">${this.estimateComplexity(definition)}</span> complexity
                        </div>
                    </div>
                    <div class="code-info">
                        Last updated: ${new Date().toLocaleString()}
                    </div>
                </div>
            </div>
        `;

        container.innerHTML = html;
        this.currentDefinition = definition;
    }

    // Render code content with optional line numbers
    renderCodeContent(definition) {
        const formattedCode = this.highlightSQL(definition);
        
        if (this.showLineNumbers) {
            const lines = definition.split('\n');
            const lineNumbers = lines.map((_, index) => (index + 1).toString().padStart(3, ' ')).join('\n');
            
            return `
                <div class="code-with-lines">
                    <div class="line-numbers">${lineNumbers}</div>
                    <pre class="code-editor">${formattedCode}</pre>
                </div>
            `;
        } else {
            return `<pre class="code-editor">${formattedCode}</pre>`;
        }
    }

    // Basic SQL syntax highlighting
    highlightSQL(sql) {
        if (!sql) return '';
        
        // Just escape HTML and return plain text - no syntax highlighting
        return this.escapeHtml(sql);
    }
        // Display message for tables (no code to show)
        displayTableMessage() {
            const container = document.getElementById('codeContainer');
            if (!container) return;

            container.innerHTML = `
                <div class="table-code-message">
                    <p><strong>Table Structure</strong></p>
                    <p>Tables don't have code definitions to display.</p>
                    <p>Switch to the <strong>Structure</strong> tab to view table columns, indexes, and constraints.</p>
                </div>
            `;
        }

    // Display message when no code is available
    displayNoCodeMessage() {
        const container = document.getElementById('codeContainer');
        if (!container) return;

        container.innerHTML = `
            <div class="code-error">
                <p><strong>No Code Available</strong></p>
                <p>Unable to retrieve the code definition for this ${this.currentObjectType.toLowerCase()}.</p>
                <p>The object may be encrypted or the definition may not be accessible.</p>
            </div>
        `;
    }

    // Show loading state
    showLoadingState() {
        const container = document.getElementById('codeContainer');
        if (!container) return;

        container.innerHTML = `
            <div class="code-loading">
                <span>Loading ${this.currentObjectType.toLowerCase()} definition...</span>
            </div>
        `;
    }

    // Show placeholder when no object is selected
    showPlaceholder() {
        const container = document.getElementById('codeContainer');
        if (!container) return;

        container.innerHTML = `
            <div class="code-placeholder">
                <h3>💻 Code View</h3>
                <p class="placeholder-text">Select a view, procedure, or function to view its code definition.</p>
            </div>
        `;
    }

    // Action handlers
    copyCode() {
        if (!this.currentDefinition) {
            this.showStatus('No code to copy', 'error');
            return;
        }

        navigator.clipboard.writeText(this.currentDefinition).then(() => {
            this.showStatus('Code copied to clipboard!', 'success');
        }).catch(err => {
            console.error('Failed to copy code:', err);
            this.showStatus('Failed to copy code', 'error');
        });
    }

    formatCode() {
        if (!this.currentDefinition) {
            this.showStatus('No code to format', 'error');
            return;
        }

        // Basic SQL formatting
        const formatted = this.basicSQLFormat(this.currentDefinition);
        this.displayCode(formatted);
        this.showStatus('Code formatted', 'success');
    }

    toggleLineNumbers() {
        this.showLineNumbers = !this.showLineNumbers;
        if (this.currentDefinition) {
            this.displayCode(this.currentDefinition);
        }
    }

    toggleExpand() {
        this.isExpanded = !this.isExpanded;
        if (this.currentDefinition) {
            this.displayCode(this.currentDefinition);
        }
    }

    // Basic SQL formatting
    basicSQLFormat(sql) {
        if (!sql) return sql;

        let formatted = sql
            // Add line breaks after major keywords
            .replace(/\bSELECT\b/gi, '\nSELECT')
            .replace(/\bFROM\b/gi, '\nFROM')
            .replace(/\bWHERE\b/gi, '\nWHERE')
            .replace(/\bGROUP BY\b/gi, '\nGROUP BY')
            .replace(/\bORDER BY\b/gi, '\nORDER BY')
            .replace(/\bHAVING\b/gi, '\nHAVING')
            .replace(/\bINNER JOIN\b/gi, '\n    INNER JOIN')
            .replace(/\bLEFT JOIN\b/gi, '\n    LEFT JOIN')
            .replace(/\bRIGHT JOIN\b/gi, '\n    RIGHT JOIN')
            .replace(/\bFULL JOIN\b/gi, '\n    FULL JOIN')
            // Clean up extra whitespace
            .replace(/\n\s*\n/g, '\n')
            .replace(/^\n+/, '')
            .trim();

        return formatted;
    }

    // Utility methods
    getObjectTypeClass(objectType) {
        switch (objectType) {
            case 'Procedure': return 'procedure-indicator';
            case 'Function': return 'function-indicator';
            case 'View': return 'view-indicator';
            case 'Trigger': return 'trigger-indicator';
            default: return '';
        }
    }

    getObjectTypeIcon(objectType) {
        switch (objectType) {
            case 'Procedure': return '⚙️';
            case 'Function': return '🔧';
            case 'View': return '👁️';
            case 'Trigger': return '⚡';
            default: return '💻';
        }
    }

    countLines(text) {
        return text ? text.split('\n').length : 0;
    }

    estimateComplexity(sql) {
        if (!sql) return 'Low';
        
        const complexityIndicators = [
            /\bJOIN\b/gi, /\bSUBQUERY\b/gi, /\bEXISTS\b/gi, /\bCASE\b/gi,
            /\bCTE\b/gi, /\bWITH\b/gi, /\bRECURSIVE\b/gi, /\bCURSOR\b/gi
        ];
        
        let complexity = 0;
        complexityIndicators.forEach(pattern => {
            const matches = sql.match(pattern);
            if (matches) complexity += matches.length;
        });
        
        if (complexity === 0) return 'Low';
        if (complexity <= 3) return 'Medium';
        return 'High';
    }

    showStatus(message, type) {
        // Try to show status in the main status area
        const statusElements = [
            document.getElementById('connectionStatus'),
            document.querySelector('.status-container'),
            document.querySelector('.status')
        ];
        
        const statusEl = statusElements.find(el => el);
        if (statusEl) {
            statusEl.className = `status ${type}`;
            statusEl.textContent = message;
            
            // Auto-hide success messages
            if (type === 'success') {
                setTimeout(() => {
                    statusEl.textContent = '';
                    statusEl.className = 'status';
                }, 3000);
            }
        }
    }

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Reset when database changes
    onDatabaseChanged() {
        this.currentDatabase = null;
        this.currentObject = null;
        this.currentObjectType = null;
        this.currentDefinition = null;
        this.isExpanded = false;
        this.showLineNumbers = false;
        this.showPlaceholder();
    }

    // Handle object selection from explorer
    onObjectSelected(objectName, objectType, definition) {
        if (this.currentDatabase) {
            this.loadCodeForObject(this.currentDatabase, objectName, objectType, definition);
        }
    }

    // Handle definition received from backend
    onDefinitionReceived(objectName, definition) {
        if (objectName === this.currentObject) {
            if (definition) {
                this.displayCode(definition);
            } else {
                this.displayNoCodeMessage();
            }
        }
    }
}