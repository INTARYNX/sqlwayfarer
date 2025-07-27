/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Comments Manager - Handles MS_Description extended properties
class CommentsManager {
    constructor() {
        this.currentDatabase = null;
        this.currentObject = null;
        this.currentObjectType = null;
        this.currentProperties = null;
        this.editingMode = false;
    }

    // Called when an object is selected in the Explorer
    loadCommentsForObject(database, objectName, objectType) {
        this.currentDatabase = database;
        this.currentObject = objectName;
        this.currentObjectType = objectType;
        this.editingMode = false;

        if (objectType === 'Table') {
            // Load table and column comments
            vscode.postMessage({
                command: 'getTableExtendedProperties',
                database: database,
                tableName: objectName
            });
        } else {
            // Load object comments (view, procedure, function)
            vscode.postMessage({
                command: 'getObjectExtendedProperties',
                database: database,
                objectName: objectName,
                objectType: objectType
            });
        }
    }

    // Display table comments (table + columns) - FIXED VERSION
    displayTableComments(properties) {
        this.currentProperties = properties;
        
        let html = `
            <div class="comments-header">
                <h3>Comments & Documentation</h3>
                <div class="comments-actions">
                    <button id="editCommentsBtn" class="comments-btn ${this.editingMode ? 'active' : ''}">
                        ${this.editingMode ? 'View Mode' : 'Edit Mode'}
                    </button>
                    <button id="refreshCommentsBtn" class="comments-btn">Refresh</button>
                </div>
            </div>

            <div class="comments-content">
        `;

        // Table description section
        html += `
            <div class="comment-section">
                <div class="comment-section-header">
                    <h4>📋 Table Description</h4>
                    ${this.editingMode ? '<button class="edit-btn" onclick="window.commentsManager.editTableDescription()">Edit</button>' : ''}
                </div>
                <div class="comment-display">
                    ${this.formatDescriptionBox(properties.tableDescription, 'No description set for this table.')}
                </div>
            </div>
        `;

        // Column descriptions section - FIXED TABLE FORMAT
        html += `
            <div class="comment-section">
                <div class="comment-section-header">
                    <h4>📝 Column Descriptions</h4>
                </div>
                <div class="column-descriptions-table">
                    <table class="comments-table">
                        <thead>
                            <tr>
                                <th>Column Name</th>
                                <th>Data Type</th>
                                <th>Nullable</th>
                                <th>Description</th>
                                ${this.editingMode ? '<th>Actions</th>' : ''}
                            </tr>
                        </thead>
                        <tbody>
        `;

        if (properties.allColumns && properties.allColumns.length > 0) {
            properties.allColumns.forEach(column => {
                const hasDescription = column.hasDescription;
                const description = column.description || '';
                const rowClass = hasDescription ? 'has-description' : 'no-description';
                
                // Build data type display with length info
                let dataTypeDisplay = column.dataType || 'Unknown';
                if (column.maxLength && column.maxLength > 0) {
                    dataTypeDisplay += `(${column.maxLength})`;
                }
                
                html += `
                    <tr class="${rowClass}">
                        <td class="column-name-cell">
                            <strong>${this.escapeHtml(column.columnName)}</strong>
                        </td>
                        <td class="column-type-cell">
                            <code class="column-type-code">${this.escapeHtml(dataTypeDisplay)}</code>
                        </td>
                        <td class="text-center">
                            ${column.isNullable ? 
                                '<span class="nullable">NULL</span>' : 
                                '<span class="not-null">NOT NULL</span>'
                            }
                        </td>
                        <td class="description-cell">
                            ${hasDescription ? 
                                `<div class="description-text">${this.escapeHtml(description)}</div>` : 
                                '<span class="no-description-text">No description</span>'
                            }
                        </td>
                        ${this.editingMode ? `
                            <td class="text-center action-cell">
                                <button class="edit-btn-small" onclick="window.commentsManager.editColumnDescription('${this.escapeHtml(column.columnName)}')" title="Edit description">
                                    ✏️ Edit
                                </button>
                            </td>
                        ` : ''}
                    </tr>
                `;
            });
        } else {
            html += `<tr><td colspan="${this.editingMode ? '5' : '4'}" class="text-center empty-state">No columns found.</td></tr>`;
        }

        html += `
                        </tbody>
                    </table>
                </div>
            </div>
        `;

        // Statistics section
        const totalColumns = properties.allColumns ? properties.allColumns.length : 0;
        const describedColumns = properties.allColumns ? properties.allColumns.filter(c => c.hasDescription).length : 0;
        const coveragePercent = totalColumns > 0 ? Math.round((describedColumns / totalColumns) * 100) : 0;

        html += `
            <div class="comment-stats">
                <h4>📊 Documentation Statistics</h4>
                <div class="stats-grid">
                    <div class="stat-item">
                        <span class="stat-label">Documentation Coverage:</span>
                        <span class="stat-value">${describedColumns}/${totalColumns} columns (${coveragePercent}%)</span>
                    </div>
                    <div class="coverage-bar">
                        <div class="coverage-fill" style="width: ${coveragePercent}%"></div>
                    </div>
                </div>
            </div>
        `;

        html += '</div>';

        const container = document.getElementById('commentsContainer');
        if (container) {
            container.innerHTML = html;
            this.setupEventListeners();
        }
    }

    // Display object comments (for views, procedures, functions)
    displayObjectComments(properties) {
        this.currentProperties = properties;
        
        let html = `
            <div class="comments-header">
                <h3>Comments & Documentation</h3>
                <div class="comments-actions">
                    <button id="editCommentsBtn" class="comments-btn ${this.editingMode ? 'active' : ''}">
                        ${this.editingMode ? 'View Mode' : 'Edit Mode'}
                    </button>
                    <button id="refreshCommentsBtn" class="comments-btn">Refresh</button>
                </div>
            </div>

            <div class="comments-content">
                <div class="comment-section">
                    <div class="comment-section-header">
                        <h4>📋 ${properties.objectType} Description</h4>
                        ${this.editingMode ? '<button class="edit-btn" onclick="window.commentsManager.editObjectDescription()">Edit</button>' : ''}
                    </div>
                    <div class="comment-display">
                        ${this.formatDescriptionBox(properties.description, `No description set for this ${properties.objectType.toLowerCase()}.`)}
                    </div>
                </div>
            </div>
        `;

        const container = document.getElementById('commentsContainer');
        if (container) {
            container.innerHTML = html;
            this.setupEventListeners();
        }
    }

    // IMPROVED: Better description formatting with proper boxes
    formatDescriptionBox(description, placeholder) {
        if (!description || description.trim() === '') {
            return `<div class="description-placeholder">${placeholder}</div>`;
        }
        
        // Convert line breaks and format text with proper styling
        const formatted = this.escapeHtml(description)
            .replace(/\n/g, '<br>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')  // Bold
            .replace(/\*(.*?)\*/g, '<em>$1</em>');              // Italic
        
        return `<div class="description-content">${formatted}</div>`;
    }

    // Set up event listeners
    setupEventListeners() {
        const editBtn = document.getElementById('editCommentsBtn');
        const refreshBtn = document.getElementById('refreshCommentsBtn');

        if (editBtn) {
            editBtn.addEventListener('click', () => this.toggleEditMode());
        }

        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => this.refreshComments());
        }
    }

    // Toggle between view and edit mode
    toggleEditMode() {
        this.editingMode = !this.editingMode;
        
        // Refresh the display with new mode
        if (this.currentObjectType === 'Table') {
            this.displayTableComments(this.currentProperties);
        } else {
            this.displayObjectComments(this.currentProperties);
        }
    }

    // Refresh comments from database
    refreshComments() {
        if (this.currentObject && this.currentDatabase) {
            this.loadCommentsForObject(this.currentDatabase, this.currentObject, this.currentObjectType);
        }
    }

    // Edit table description
    editTableDescription() {
        const currentDescription = this.currentProperties.tableDescription || '';
        
        this.showEditDialog(
            'Edit Table Description',
            currentDescription,
            'Enter a description for this table:',
            (newDescription) => {
                if (newDescription !== null) {
                    vscode.postMessage({
                        command: 'updateTableDescription',
                        database: this.currentDatabase,
                        tableName: this.currentObject,
                        description: newDescription
                    });
                }
            }
        );
    }

    // Edit column description
    editColumnDescription(columnName) {
        const column = this.currentProperties.allColumns.find(c => c.columnName === columnName);
        const currentDescription = column ? column.description || '' : '';
        
        this.showEditDialog(
            `Edit Description for Column: ${columnName}`,
            currentDescription,
            'Enter a description for this column:',
            (newDescription) => {
                if (newDescription !== null) {
                    vscode.postMessage({
                        command: 'updateColumnDescription',
                        database: this.currentDatabase,
                        tableName: this.currentObject,
                        columnName: columnName,
                        description: newDescription
                    });
                }
            }
        );
    }

    // Edit object description
    editObjectDescription() {
        const currentDescription = this.currentProperties.description || '';
        
        this.showEditDialog(
            `Edit ${this.currentObjectType} Description`,
            currentDescription,
            `Enter a description for this ${this.currentObjectType.toLowerCase()}:`,
            (newDescription) => {
                if (newDescription !== null) {
                    vscode.postMessage({
                        command: 'updateObjectDescription',
                        database: this.currentDatabase,
                        objectName: this.currentObject,
                        description: newDescription
                    });
                }
            }
        );
    }

    // Show edit dialog
    showEditDialog(title, currentValue, prompt, onSave) {
        // Create modal dialog
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-dialog">
                <div class="modal-header">
                    <h3>${this.escapeHtml(title)}</h3>
                    <button class="modal-close">&times;</button>
                </div>
                <div class="modal-body">
                    <p>${this.escapeHtml(prompt)}</p>
                    <textarea id="descriptionTextarea" rows="6" placeholder="Enter description...">${this.escapeHtml(currentValue)}</textarea>
                </div>
                <div class="modal-footer">
                    <button id="saveDescriptionBtn" class="btn-primary">Save</button>
                    <button id="cancelDescriptionBtn" class="btn-secondary">Cancel</button>
                    ${currentValue ? '<button id="deleteDescriptionBtn" class="btn-danger">Delete</button>' : ''}
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const textarea = modal.querySelector('#descriptionTextarea');
        const saveBtn = modal.querySelector('#saveDescriptionBtn');
        const cancelBtn = modal.querySelector('#cancelDescriptionBtn');
        const deleteBtn = modal.querySelector('#deleteDescriptionBtn');
        const closeBtn = modal.querySelector('.modal-close');

        // Focus textarea and select text
        textarea.focus();
        textarea.select();

        // Event handlers
        const closeModal = () => {
            document.body.removeChild(modal);
        };

        const handleSave = () => {
            const newValue = textarea.value.trim();
            onSave(newValue);
            closeModal();
        };

        const handleDelete = () => {
            if (confirm('Are you sure you want to delete this description?')) {
                onSave(''); // Empty string to delete
                closeModal();
            }
       };

       saveBtn.addEventListener('click', handleSave);
       cancelBtn.addEventListener('click', closeModal);
       closeBtn.addEventListener('click', closeModal);
       if (deleteBtn) {
           deleteBtn.addEventListener('click', handleDelete);
       }

       // Close on Escape key
       modal.addEventListener('keydown', (e) => {
           if (e.key === 'Escape') {
               closeModal();
           } else if (e.key === 'Enter' && e.ctrlKey) {
               handleSave();
           }
       });

       // Close on background click
       modal.addEventListener('click', (e) => {
           if (e.target === modal) {
               closeModal();
           }
       });
   }

   // Message handlers
   onTableExtendedPropertiesResult(tableName, properties) {
       if (tableName === this.currentObject) {
           this.displayTableComments(properties);
       }
   }

   onObjectExtendedPropertiesResult(objectName, objectType, properties) {
       if (objectName === this.currentObject) {
           this.displayObjectComments(properties);
       }
   }

   onUpdateDescriptionResult(result) {
       if (result.success) {
           this.showStatus(result.message, 'success');
           // Refresh the comments to show updated data
           setTimeout(() => {
               this.refreshComments();
           }, 500);
       } else {
           this.showStatus(result.message, 'error');
       }
   }

   onDeleteDescriptionResult(result) {
       if (result.success) {
           this.showStatus(result.message, 'success');
           // Refresh the comments to show updated data
           setTimeout(() => {
               this.refreshComments();
           }, 500);
       } else {
           this.showStatus(result.message, 'error');
       }
   }

   // Show placeholder when no object is selected
   showPlaceholder() {
       const container = document.getElementById('commentsContainer');
       if (container) {
           container.innerHTML = `
               <div class="comments-placeholder">
                   <h3>Comments & Documentation</h3>
                   <p class="placeholder-text">Select a table, view, procedure, or function to view and edit its comments.</p>
               </div>
           `;
       }
   }

   // Utility methods
   formatDescription(description, placeholder) {
       if (!description || description.trim() === '') {
           return `<span class="placeholder-text">${placeholder}</span>`;
       }
       
       // Convert line breaks and format text
       const formatted = this.escapeHtml(description)
           .replace(/\n/g, '<br>')
           .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')  // Bold
           .replace(/\*(.*?)\*/g, '<em>$1</em>');              // Italic
       
       return `<span class="description-text">${formatted}</span>`;
   }

   showStatus(message, type) {
       // Create or update status element
       let statusEl = document.getElementById('commentsStatus');
       if (!statusEl) {
           statusEl = document.createElement('div');
           statusEl.id = 'commentsStatus';
           statusEl.className = 'comments-status';
           
           const container = document.getElementById('commentsContainer');
           if (container) {
               container.insertBefore(statusEl, container.firstChild);
           }
       }

       statusEl.className = `comments-status ${type}`;
       statusEl.textContent = message;

       // Auto-hide after 3 seconds
       setTimeout(() => {
           if (statusEl && statusEl.parentNode) {
               statusEl.parentNode.removeChild(statusEl);
           }
       }, 3000);
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
       this.currentProperties = null;
       this.editingMode = false;
       this.showPlaceholder();
   }
}