/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// The part of the Explorer that shows an object: its structure (columns, indexes,
// foreign keys), the column usage, and the dependency tree and graph. It is mixed
// into ExplorerManager (see explorerManager.js), so `this` is the ExplorerManager.
// Methods of ExplorerManager: the details of an object.
class ExplorerDetailsMethods {
    // Whether the details that arrive are the ones the panel waits for: the
    // object selected, in its database - or an object whose dependencies were
    // asked for to be drawn. The user may have clicked another object since.
    _isAwaitedDetails(database, name) {
        if (database && database !== (this._currentDetailsDatabase || appState.currentDatabase)) return false;
        if (appState.pendingVisualization) return true;
        const selected = appState.selectedObject;
        return !selected || !name || name === this._getQualifiedName(selected);
    }

    onTableDetailsLoaded(tableName, columns, indexes, foreignKeys, dependencies, stats, database) {
        if (!this._isAwaitedDetails(database, tableName)) return;
        appState.currentDependencies = dependencies;
        this._currentDetailsTable = tableName;
        this._onExternalResolved(tableName, 'Table');

        // Column lineage comes from the in-memory index - fetched separately
        // so the details view never waits on it. Uses the database these
        // details were actually fetched from, not necessarily the one
        // currently selected (e.g. a cross-database reference).
        vscode.postMessage({
            command: 'getColumnUsage',
            database: this._currentDetailsDatabase || appState.currentDatabase,
            table: tableName
        });

        const html = [
            `<div class="section-header">Table: ${this.escapeHtml(tableName)}</div>`,
            this.buildStatsSection(stats),
            this.buildColumnsTable(columns),
            this.buildIndexesTable(indexes),
            this.buildForeignKeysTable(foreignKeys),
            this.buildDependenciesSection(dependencies)
        ].join('');

        this.elements.detailsContent.innerHTML = html;

        // Update graph tab if it's active
        if (appState.activeDetailsTab === 'graph') {
            this.displayDependencyGraph(tableName, dependencies);
        }

        this.checkPendingVisualization(tableName, dependencies);
    }

    onObjectDetailsLoaded(objectName, objectType, dependencies, definition, database) {
        if (!this._isAwaitedDetails(database, objectName)) return;
        appState.currentDependencies = dependencies;
        this._onExternalResolved(objectName, objectType);

        if (appState.selectedObject) {
            appState.selectedObject.definition = definition;
        }

        // Update structure tab
        let html = `<div class="section-header">${objectType}: ${this.escapeHtml(objectName)}</div>`;
        // Write footprint applies to programmable objects (they read/write tables).
        const ftType = appState.selectedObject && appState.selectedObject.object_type;
        const canFootprint = ['Procedure', 'Function', 'View'].includes(ftType);
        if (canFootprint) {
            html += `<div class="details-actions">
                <button id="writeFootprintBtn" class="viz-btn" title="Graph the tables this object reads and writes, including tables reached through trigger cascades">
                    <i class="codicon codicon-type-hierarchy"></i> Table footprint
                </button>
            </div>`;
        }
        // Procedures/functions get an auto-generated call snippet (EXEC/SELECT
        // template) so you don't have to dig into the object list's script menu.
        const canCallSnippet = ['Procedure', 'Function'].includes(ftType);
        if (canCallSnippet) {
            html += `<div class="call-snippet-section" id="callSnippetSection">
                <div class="section-header">Call snippet</div>
                <p class="placeholder-text">Generating…</p>
            </div>`;
        }
        html += this.buildDependenciesSection(dependencies);
        this.elements.detailsContent.innerHTML = html;

        if (canFootprint) {
            const btn = document.getElementById('writeFootprintBtn');
            if (btn) btn.addEventListener('click', () => {
                if (window.footprintManager) window.footprintManager.open(objectName);
            });
        }

        if (canCallSnippet) {
            this._pendingCallSnippetFor = objectName;
            vscode.postMessage({
                command: 'generateScript',
                database: this._currentDetailsDatabase || appState.currentDatabase,
                objectName,
                objectType: ftType,
                scriptType: ftType === 'Function' ? 'select' : 'exec',
                preview: true
            });
        }

        // Update graph tab if it's active
        if (appState.activeDetailsTab === 'graph') {
            this.displayDependencyGraph(objectName, dependencies);
        }

        // Handle code tab
        if (appState.activeDetailsTab === 'code' && window.codeViewManager) {
            window.codeViewManager.onDefinitionReceived(objectName, definition);
        }

        this.checkPendingVisualization(objectName, dependencies);
    }

    // NEW METHOD: Display dependency graph in the graph tab
    displayDependencyGraph(objectName, dependencies) {
        const container = document.getElementById('graphContainer');
        if (!container) return;

        if (!dependencies || (!dependencies.dependsOn?.length && !dependencies.referencedBy?.length)) {
            container.innerHTML = `
                <div class="graph-placeholder">
                    <h3><i class="codicon codicon-graph"></i> Dependency Graph</h3>
                    <p class="placeholder-text">No dependencies found for ${this.escapeHtml(objectName)}</p>
                    ${this.indexMissingHtml()}
                </div>
            `;
            return;
        }

        // Create a new visualization container for the graph tab
        container.innerHTML = `
            <div class="graph-viz-container">
                <div class="graph-header">
                    <h3><i class="codicon codicon-graph"></i> Dependency Graph: ${this.escapeHtml(objectName)}</h3>
                    <div class="viz-controls">
                        <button id="showDependenciesBtn" class="viz-btn">Dependencies</button>
                        <button id="showReferencesBtn" class="viz-btn">References</button>
                        <button id="showBothBtn" class="viz-btn active">Both</button>
                    </div>
                </div>
                <div id="dependencyGraph" class="dependency-graph"></div>
            </div>
        `;

        // Show the dependency visualization in the graph container
        setTimeout(() => {
            this.dependencyVisualizer.currentMode = 'both';
            this.dependencyVisualizer.currentObjectName = objectName;
            this.dependencyVisualizer.dependencies = dependencies;
            this.dependencyVisualizer.generateGraph(objectName, dependencies);

            // Re-attach event listeners for the controls
            document.getElementById('showDependenciesBtn').addEventListener('click', () => {
                this.dependencyVisualizer.setMode('dependencies');
            });
            document.getElementById('showReferencesBtn').addEventListener('click', () => {
                this.dependencyVisualizer.setMode('references');
            });
            document.getElementById('showBothBtn').addEventListener('click', () => {
                this.dependencyVisualizer.setMode('both');
            });
        }, 100);
    }

    checkPendingVisualization(objectName, dependencies) {
        if (appState.pendingVisualization === objectName) {
            appState.pendingVisualization = null;
            setTimeout(() => {
                this.dependencyVisualizer.showDependencyVisualization(objectName, dependencies);
            }, 100);
        }
    }

    // Shown in place of a result that needs the dependency index while it is
    // not built: an empty result would read as "no dependencies".
    indexMissingHtml() {
        if (appState.indexState !== 'none') return '';
        return `<p class="placeholder-text index-missing">The dependency index of this database is not built, so dependencies cannot be shown. <button class="link-btn" data-index-action="build">Build index</button></p>`;
    }

    displayDependencyTree(treeData) {
        const container = document.getElementById('treeContainer');
        if (!container) return;

        if (!treeData) {
            container.innerHTML = `<p class="placeholder-text">No dependency data</p>${this.indexMissingHtml()}`;
            return;
        }

        // A node living in another database is a link, like in the
        // Dependencies table.
        const renderName = (node) => {
            if (node.external && node.external.database) {
                const ext = node.external;
                const schema = ext.schema || 'dbo';
                const label = `${ext.database}.${schema}.${ext.object}`;
                return `<button class="dep-link" data-db="${this.escapeHtml(ext.database)}" data-schema="${this.escapeHtml(schema)}" data-name="${this.escapeHtml(ext.object)}" title="Open ${this.escapeHtml(label)} in ${this.escapeHtml(ext.database)}">${this.escapeHtml(node.name)}</button>`;
            }
            return this.escapeHtml(node.name);
        };

        // Simple recursive text tree
        function buildTree(node, prefix = '') {
            let result = renderName(node) + '\n';

            if (node.dependencies && node.dependencies.length > 0) {
                node.dependencies.forEach((child, index) => {
                    const isLast = index === node.dependencies.length - 1;
                    const connector = isLast ? '└── ' : '├── ';
                    const nextPrefix = prefix + (isLast ? '    ' : '│   ');

                    result += prefix + connector + buildTree(child, nextPrefix);
                });
            }

            return result;
        }

        // The names are escaped by renderName, the rest is the branches of the drawing.
        container.innerHTML = `<pre>${buildTree(treeData)}</pre>`;
    }

    // Row count and disk usage summary line shown under the table header.
    // stats is null when the backend could not read allocation metadata.
    buildStatsSection(stats) {
        if (!stats) return '';

        const parts = [
            `Rows: <strong>${Number(stats.rowCount).toLocaleString('en-US')}</strong>`,
            `Data: <strong>${this._formatKb(stats.dataKb)}</strong>`,
            `Indexes: <strong>${this._formatKb(stats.indexKb)}</strong>`,
            `Reserved: <strong>${this._formatKb(stats.reservedKb)}</strong>`
        ];
        return `<div class="table-stats">${parts.join('<span class="stat-separator">·</span>')}</div>`;
    }

    buildColumnsTable(columns) {
        if (!columns || columns.length === 0) {
            return `<h3>${swIcon('table')} Columns</h3><p>No columns found.</p>`;
        }

        let html = `<h3>${swIcon('table')} Columns</h3>`;
        html += `<table>
           <tr>
               <th>Name</th>
               <th>Type</th>
               <th>Nullable</th>
               <th>Default</th>
               <th class="rs-num">Length</th>
               <th>Extra</th>
               <th>Used by</th>
           </tr>`;

        columns.forEach(col => {
            const extraInfo = [];
            if (col.IS_IDENTITY) extraInfo.push('IDENTITY');
            if (col.IS_COMPUTED) extraInfo.push('COMPUTED');

            let typeDisplay = col.DATA_TYPE;
            if (col.CHARACTER_MAXIMUM_LENGTH) {
                typeDisplay += `(${col.CHARACTER_MAXIMUM_LENGTH})`;
            } else if (col.NUMERIC_PRECISION && col.NUMERIC_SCALE !== undefined) {
                typeDisplay += `(${col.NUMERIC_PRECISION},${col.NUMERIC_SCALE})`;
            }

            html += `<tr>
               <td><strong>${this.escapeHtml(col.COLUMN_NAME)}</strong></td>
               <td><code>${this.escapeHtml(typeDisplay)}</code></td>
               <td>${col.IS_NULLABLE}</td>
               <td>${this.escapeHtml(col.COLUMN_DEFAULT || '')}</td>
               <td class="rs-num">${col.CHARACTER_MAXIMUM_LENGTH || ''}</td>
               <td>${extraInfo.join(', ')}</td>
               <td class="col-usage" data-column="${this.escapeHtml(col.COLUMN_NAME.toLowerCase()).replace(/"/g, '&quot;')}" data-column-label="${this.escapeHtml(col.COLUMN_NAME).replace(/"/g, '&quot;')}">…</td>
           </tr>`;
        });

        html += '</table>';
        return html;
    }

    // Fill the "Used by" cells once the index-based column lineage arrives.
    // usage: { columnNameLower: [{ object, type, write, confident }] }
    onColumnUsageResult(tableName, usage) {
        if (tableName !== this._currentDetailsTable) return;

        this.elements.detailsContent.querySelectorAll('.col-usage').forEach(cell => {
            // usage === null: lookup failed (index unreadable) - unlike an
            // empty object, this is not a confident "no references"
            if (!usage) {
                cell.textContent = '';
                cell.title = 'Column usage unavailable (index could not be read)';
                return;
            }
            const refs = usage[cell.dataset.column] || [];
            if (refs.length === 0) {
                cell.textContent = '—';
                cell.title = 'No indexed object references this column';
                return;
            }

            const writes = refs.filter(r => r.write).length;
            const uncertain = refs.filter(r => !r.confident).length;
            const label = `${refs.length} object${refs.length > 1 ? 's' : ''}` +
                (writes ? ` · ${writes} <i class="codicon codicon-edit"></i>` : '') + (uncertain ? ' · ~' : '');

            cell.innerHTML = '';
            const btn = document.createElement('button');
            btn.className = 'col-usage-btn';
            btn.innerHTML = label;
            btn.title = 'Objects referencing this column (pencil = writes, ~ = uncertain matches). Click for the list.';
            const columnLabel = cell.dataset.columnLabel || cell.dataset.column;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.openColumnUsageModal(columnLabel, refs);
            });
            cell.appendChild(btn);
        });
    }

    // List of referencing objects; click reveals the object in the Explorer.
    // A real modal, not a dropdown: the list can hold 150+ objects and a menu
    // pinned to the viewport can neither scroll nor show them all.
    openColumnUsageModal(columnLabel, refs) {
        if (!this._usageModal) {
            this._usageModal = {
                overlay: document.getElementById('columnUsageModalOverlay'),
                title: document.getElementById('columnUsageModalTitle'),
                filter: document.getElementById('columnUsageFilter'),
                list: document.getElementById('columnUsageList')
            };
            const m = this._usageModal;
            document.getElementById('columnUsageModalCloseBtn').addEventListener('click', () => this.closeColumnUsageModal());
            m.overlay.addEventListener('click', (e) => {
                if (e.target === m.overlay) this.closeColumnUsageModal();
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && m.overlay.classList.contains('visible')) {
                    this.closeColumnUsageModal();
                }
            });
            m.filter.addEventListener('input', () => this._renderColumnUsageList());
            m.copyBtn = document.getElementById('columnUsageCopyBtn');
            m.copyBtn.addEventListener('click', () => this._copyColumnUsageList());
        }

        const m = this._usageModal;
        this._usageRefs = refs;
        m.title.textContent = `Objects using ${columnLabel} (${refs.length})`;
        m.filter.value = '';
        // A filter box on a three-line list is clutter
        m.filter.style.display = refs.length > 8 ? '' : 'none';
        this._renderColumnUsageList();
        m.overlay.classList.add('visible');
        if (refs.length > 8) m.filter.focus();
    }

    _renderColumnUsageList() {
        const m = this._usageModal;
        const needle = m.filter.value.trim().toLowerCase();
        const matching = this._usageRefs.filter(ref => !needle || ref.object.toLowerCase().includes(needle));
        // Kept for the Copy button: it copies what the user sees (filter applied)
        this._usageVisibleRefs = matching;

        m.list.innerHTML = '';
        if (matching.length === 0) {
            m.list.innerHTML = '<p class="placeholder-text">No matching object.</p>';
            return;
        }
        matching.forEach(ref => {
            const item = document.createElement('button');
            item.className = 'column-usage-item';
            item.append(ref.object);
            if (ref.write) {
                const pencil = document.createElement('i');
                pencil.className = 'codicon codicon-edit';
                item.append(' ', pencil);
            }
            if (!ref.confident) item.append(' (?)');
            item.title = `${ref.write ? 'Writes to' : 'Reads'} this column${ref.confident ? '' : ' (ambiguous, unqualified reference)'}. Click to reveal in Explorer.`;
            item.addEventListener('click', () => {
                const obj = (appState.allObjects || []).find(o =>
                    (o.qualified_name || '').toLowerCase() === ref.object.toLowerCase());
                this.closeColumnUsageModal();
                if (obj) this.revealObject(obj);
            });
            m.list.appendChild(item);
        });
    }

    _copyColumnUsageList() {
        const m = this._usageModal;
        const refs = this._usageVisibleRefs || [];
        if (refs.length === 0) return;

        const text = refs.map(ref => ref.object).join('\n');
        const resetLabel = '<i class="codicon codicon-copy"></i> Copy';
        navigator.clipboard.writeText(text).then(
            () => {
                m.copyBtn.innerHTML = `<i class="codicon codicon-check"></i> ${refs.length} copied`;
                setTimeout(() => { m.copyBtn.innerHTML = resetLabel; }, 1500);
            },
            () => {
                m.copyBtn.innerHTML = '<i class="codicon codicon-close"></i> Copy failed';
                setTimeout(() => { m.copyBtn.innerHTML = resetLabel; }, 1500);
            }
        );
    }

    closeColumnUsageModal() {
        if (this._usageModal) this._usageModal.overlay.classList.remove('visible');
    }

    buildIndexesTable(indexes) {
        let html = `<h3>${swIcon('index')} Indexes</h3>`;

        if (indexes && indexes.length > 0) {
            html += '<table><tr><th>Name</th><th>Type & Properties</th><th>Columns</th><th>Details</th></tr>';

            indexes.forEach(idx => {
                let badges = '';

                if (idx.is_primary_key === true || idx.is_primary_key === 1) {
                    badges += `<span class="index-badge index-primary">${swIcon('key')} Primary Key</span>`;
                }

                if (idx.is_unique === true || idx.is_unique === 1) {
                    badges += '<span class="index-badge index-unique">Unique</span>';
                }

                if (idx.is_unique_constraint === true || idx.is_unique_constraint === 1) {
                    badges += '<span class="index-badge index-unique">Unique Constraint</span>';
                }

                if (idx.type_desc) {
                    const typeDesc = idx.type_desc.toLowerCase();
                    if (typeDesc.includes('clustered') && !typeDesc.includes('nonclustered')) {
                        badges += '<span class="index-badge index-clustered">Clustered</span>';
                    } else if (typeDesc.includes('nonclustered')) {
                        badges += '<span class="index-badge index-normal">NonClustered</span>';
                    }
                }

                if (!badges) {
                    badges = '<span class="index-badge index-normal">Index</span>';
                }

                const details = [];
                if (idx.fill_factor && idx.fill_factor !== 0) {
                    details.push(`Fill Factor: ${idx.fill_factor}%`);
                }
                if (idx.has_filter) {
                    details.push(`Filtered: ${this.escapeHtml(idx.filter_definition || 'Yes')}`);
                }

                html += `<tr>
                  <td><strong>${this.escapeHtml(idx.index_name)}</strong></td>
                  <td>${badges}</td>
                  <td><code style="background: var(--vscode-textCodeBlock-background); padding: 2px 4px; border-radius: 2px;">${this.escapeHtml(idx.columns)}</code></td>
                  <td><small>${details.join('<br>')}</small></td>
              </tr>`;
            });

            html += '</table>';
        } else {
            html += '<p>No indexes found.</p>';
        }

        return html;
    }

    buildForeignKeysTable(foreignKeys) {
        let html = `<h3>${swIcon('fk')} Foreign Keys</h3>`;

        if (foreignKeys && foreignKeys.length > 0) {
            html += '<table><tr><th>Name</th><th>Column</th><th>Referenced Table</th><th>Referenced Column</th><th>Actions</th></tr>';

            foreignKeys.forEach(fk => {
                const actions = [];
                if (fk.delete_referential_action_desc && fk.delete_referential_action_desc !== 'NO_ACTION') {
                    actions.push(`ON DELETE ${fk.delete_referential_action_desc}`);
                }
                if (fk.update_referential_action_desc && fk.update_referential_action_desc !== 'NO_ACTION') {
                    actions.push(`ON UPDATE ${fk.update_referential_action_desc}`);
                }

                html += `<tr>
                  <td>${this.escapeHtml(fk.fk_name)}</td>
                  <td><strong>${this.escapeHtml(fk.column_name)}</strong></td>
                  <td>${this.escapeHtml(fk.referenced_table)}</td>
                  <td><strong>${this.escapeHtml(fk.referenced_column)}</strong></td>
                  <td><small>${actions.join('<br>')}</small></td>
              </tr>`;
            });

            html += '</table>';
        } else {
            html += '<p>No foreign keys found.</p>';
        }

        return html;
    }

    buildDependenciesSection(dependencies) {
        if (!dependencies) {
            return '<h3><i class="codicon codicon-type-hierarchy"></i> Dependencies</h3><p>No dependency information available.</p>';
        }

        let html = '<h3><i class="codicon codicon-type-hierarchy"></i> Dependencies</h3>';

        html += '<h4>Dependencies (objects this depends on):</h4>';
        if (dependencies.dependsOn && dependencies.dependsOn.length > 0) {
            html += '<table><tr><th>Object Name</th><th>Type</th><th>Operations</th></tr>';
            dependencies.dependsOn.forEach(dep => {
                const operations = dep.operations ? dep.operations.join(', ') : (dep.dependency_type || 'Unknown');
                html += `<tr>
              <td>${this.renderDependencyName(dep)}</td>
              <td>${this.escapeHtml(dep.referenced_object_type)}</td>
              <td><small>${this.escapeHtml(operations)}</small></td>
          </tr>`;
            });
            html += '</table>';
        } else {
            html += `<p>No dependencies found.</p>${this.indexMissingHtml()}`;
        }

        html += '<h4>Referenced by (objects that depend on this):</h4>';
        if (dependencies.referencedBy && dependencies.referencedBy.length > 0) {
            html += '<table><tr><th>Object Name</th><th>Type</th><th>Operations</th></tr>';
            dependencies.referencedBy.forEach(ref => {
                const operations = ref.operations ? ref.operations.join(', ') : (ref.dependency_type || 'Unknown');
                html += `<tr>
              <td>${this.escapeHtml(ref.referencing_object)}</td>
              <td>${this.escapeHtml(ref.referencing_object_type)}</td>
              <td><small>${this.escapeHtml(operations)}</small></td>
          </tr>`;
            });
            html += '</table>';
        } else {
            html += '<p>No objects reference this object.</p>';
        }

        return html;
    }

    // A dependency living in another database is a link: clicking it opens
    // that database in the Explorer and selects the object - the same path as
    // the Ctrl+Click "go to definition" on a cross-database reference.
    renderDependencyName(dep) {
        if (dep && dep.is_external && dep.external_database) {
            const schema = dep.schema_name || 'dbo';
            const label = `${dep.external_database}.${schema}.${dep.object_name}`;
            return `<button class="dep-link" data-db="${this.escapeHtml(dep.external_database)}" data-schema="${this.escapeHtml(schema)}" data-name="${this.escapeHtml(dep.object_name)}" title="Open ${this.escapeHtml(label)} in ${this.escapeHtml(dep.external_database)}">${this.escapeHtml(dep.referenced_object)}</button>`;
        }
        return this.escapeHtml(dep ? dep.referenced_object : '');
    }
}
