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
        // The code as the server has it, and whether what is shown is its formatted form.
        this.currentDefinition = null;
        this._isFormatted = false;
        this.showLineNumbers = false;
        // The read-only CodeMirror view of the definition on screen, if any.
        this._view = null;
        this._attachActionDelegation();
    }

    // codeContainer is static (defined in index.html) - displayCode() only ever
    // replaces its innerHTML, never the container itself - so one delegated
    // listener set up once here covers every future render. The CSP has no
    // 'unsafe-inline' on script-src, so onclick="" attributes (the previous
    // approach) are silently never invoked.
    _attachActionDelegation() {
        const container = document.getElementById('codeContainer');
        if (!container) return;
        container.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            if (btn.dataset.action === 'copyCode') this.copyCode();
            else if (btn.dataset.action === 'formatCode') this.formatCode();
            else if (btn.dataset.action === 'toggleLineNumbers') this.toggleLineNumbers();
        });
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

    // Display code definition. `formatted`: it is the formatted form of
    // currentDefinition, which stays what the server sent.
    displayCode(definition, { formatted = false } = {}) {
        if (!definition || definition.trim() === '') {
            this.displayNoCodeMessage();
            return;
        }

        const container = document.getElementById('codeContainer');
        if (!container) return;
        this._isFormatted = formatted;
        if (!formatted) this.currentDefinition = definition;
        this._shownText = definition;

        const objectTypeClass = this.getObjectTypeClass(this.currentObjectType);
        const objectIcon = this.getObjectTypeIcon(this.currentObjectType);

        if (this._view) this._view.destroy();
        this._view = null;

        let html = `
            <div class="code-viewer">
                <div class="code-header">
                    <div class="code-title">
                        <span class="object-type-indicator ${objectTypeClass}">
                            ${objectIcon} ${this.currentObjectType}
                        </span>
                        <span>${this.escapeHtml(this.currentObject)}</span>
                    </div>
                    <div class="code-actions">
                        <button class="code-action-btn copy-btn" data-action="copyCode" title="Copy code">
                            Copy
                        </button>
                        <button class="code-action-btn format-btn${formatted ? ' active' : ''}" data-action="formatCode" aria-pressed="${formatted}" title="${formatted ? 'Back to the code as it is on the server' : 'Format SQL (the code on the server is not changed)'}">
                            Format
                        </button>
                        <button class="code-action-btn${this.showLineNumbers ? ' active' : ''}" data-action="toggleLineNumbers" aria-pressed="${this.showLineNumbers}" title="Show or hide the line numbers">
                            Line numbers
                        </button>
                    </div>
                </div>
                
                <div class="code-content">
                    <div class="code-cm"></div>
                </div>
                
                <div class="code-metrics">
                    <div class="code-stats">
                        <div class="code-stat">
                            <i class="codicon codicon-list-ordered"></i> <span class="code-stat-value">${this.countLines(definition)}</span> lines
                        </div>
                        <div class="code-stat">
                            <i class="codicon codicon-note"></i> <span class="code-stat-value">${definition.length}</span> characters
                        </div>
                        <div class="code-stat">
                            <i class="codicon codicon-graph"></i> <span class="code-stat-value">${this.estimateComplexity(definition)}</span> complexity
                        </div>
                    </div>
                </div>
            </div>
        `;

        container.innerHTML = html;

        const host = container.querySelector('.code-cm');
        if (window.SqlCodeMirror && window.SqlCodeMirror.readOnlyView) {
            this._view = window.SqlCodeMirror.readOnlyView(host, definition, { lineNumbers: this.showLineNumbers });
        } else {
            host.textContent = definition;
            host.classList.add('code-plain');
        }
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
                <h3><i class="codicon codicon-file-code"></i> Code View</h3>
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

        // What is on screen: the formatted code when it is formatted.
        navigator.clipboard.writeText(this._shownText || this.currentDefinition).then(() => {
            this.showStatus('Code copied to clipboard!', 'success');
        }).catch(err => {
            console.error('Failed to copy code:', err);
            this.showStatus('Failed to copy code', 'error');
        });
    }

    // Format is a way of looking: the code of the server stays in currentDefinition,
    // and the button, pressed again, shows it back.
    formatCode() {
        if (!this.currentDefinition) {
            this.showStatus('No code to format', 'error');
            return;
        }
        if (this._isFormatted) {
            this.displayCode(this.currentDefinition);
            this.showStatus('Code as it is on the server', 'success');
            return;
        }
        const format = window.SqlCodeMirror && window.SqlCodeMirror.formatSql;
        const formatted = format ? format(this.currentDefinition) : null;
        if (formatted === null) {
            this.showStatus('This code cannot be parsed, so it is shown as it is', 'error');
            return;
        }
        this.displayCode(formatted, { formatted: true });
        this.showStatus('Code formatted', 'success');
    }

    toggleLineNumbers() {
        this.showLineNumbers = !this.showLineNumbers;
        if (this._view) this._view.setLineNumbers(this.showLineNumbers);
        const button = document.querySelector('#codeContainer [data-action="toggleLineNumbers"]');
        if (button) {
            button.classList.toggle('active', this.showLineNumbers);
            button.setAttribute('aria-pressed', String(this.showLineNumbers));
        }
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
            case 'Procedure':
            case 'Function':
            case 'View':
            case 'Trigger':
                return swObjectIcon(objectType);
            default: return '<i class="codicon codicon-file-code"></i>';
        }
    }

    countLines(text) {
        return text ? text.split('\n').length : 0;
    }

    estimateComplexity(sql) {
        return CodeViewManager.estimateComplexity(sql);
    }

    // Low, Medium or High from what makes T-SQL code harder to read: joins, subqueries,
    // CTEs, CASE, EXISTS, UNION, loops and cursors. Comments and strings do not count,
    // and neither does WITH (NOLOCK) or another table hint.
    static estimateComplexity(sql) {
        if (!sql) return 'Low';
        const code = sql
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/--.*$/gm, ' ')
            .replace(/'(?:[^']|'')*'/g, "''");
        const indicators = [
            /\bJOIN\b/gi, /\(\s*SELECT\b/gi, /\bEXISTS\b/gi, /\bCASE\b/gi, /\bUNION\b/gi,
            /\bWHILE\b/gi, /\bCURSOR\b/gi,
            // A CTE: WITH name [(columns)] AS (
            /\bWITH\s+[\w[\]]+\s*(?:\([^)]*\)\s*)?AS\s*\(/gi
        ];
        const complexity = indicators.reduce((sum, pattern) => sum + (code.match(pattern) || []).length, 0);
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
        if (text === null || text === undefined) return '';
        return String(text).replace(/[&<>"']/g, ch => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
        ));
    }

    // Reset when database changes
    onDatabaseChanged() {
        this.currentDatabase = null;
        this.currentObject = null;
        this.currentObjectType = null;
        this.currentDefinition = null;
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

// Allow unit tests to require() this file; in the webview `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CodeViewManager;
}
