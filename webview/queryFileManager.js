/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Owns the Query tab's sub-tabs: one shared textarea (QueryManager.input) is
// swapped between in-memory buffers. Each buffer is either a draft (no file)
// or bound to a .sql file on disk that can be saved back to, and remembers
// which database it was last run against. Unsaved drafts are snapshotted to
// workspaceState (see persistDraftsNow) so a crash never loses typed-but-
// unsaved SQL - file-backed tabs don't need that, their content is already
// safe on disk.
//
// Sub-tabs are not a horizontal strip: they live in a vertical dropdown that
// opens under the "Query" tab button (same idea as the History/Snippets
// dropdowns already in the toolbar), and the left-side panel for browsing
// workspace .sql files (including subfolders) toggles via the folder icon.
class QueryFileManager {
    constructor(queryManager) {
        this.queryManager = queryManager;
        this.input = document.getElementById('queryInput');
        this.queryTabButton = document.querySelector('.tab-button[data-tab="query"]');
        this.queryTabsBtn = document.getElementById('queryTabsBtn');
        this.activeTabLabel = document.getElementById('queryActiveTabLabel');
        this.tabsDropdown = document.getElementById('queryTabsDropdown');
        this.saveBtn = document.getElementById('saveQueryFileBtn');
        this.databaseSelect = document.getElementById('databaseSelect');

        this.folderBtn = document.getElementById('queryFilesBtn');
        this.filesPanel = document.getElementById('sqlFilesPanel');
        this.filesTree = document.getElementById('sqlFilesTree');
        this.filesRefreshBtn = document.getElementById('sqlFilesRefreshBtn');
        this.filesCollapseAllBtn = document.getElementById('sqlFilesCollapseAllBtn');
        this.filesHideBtn = document.getElementById('sqlFilesHideBtn');
        this.filesFilterInput = document.getElementById('sqlFilesFilterInput');
        this._collapsedDirs = new Set();
        this._allFiles = [];
        this._filterText = '';

        this.nextId = 1;
        this.draftCounter = 0;
        this.tabs = [this._makeDraftTab()];
        this.activeTabId = this.tabs[0].id;
        this._pendingCloseTabId = null;
        this._pendingSaveAsTabId = null;
        this._draftTimer = null;

        this.initEventListeners();
        this.render();
        vscode.postMessage({ command: 'getDraftRecovery' });
    }

    initEventListeners() {
        this.saveBtn.addEventListener('click', () => this.saveActiveTab());
        this.input.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                this.saveActiveTab();
            }
        });
        this.input.addEventListener('input', () => this.onEditorInput());

        // A single click only switches to the Query tab (TabManager's own
        // click listener on this same button) - the sub-tabs dropdown opens
        // on double-click instead, so a normal click never pops it open.
        this.queryTabButton.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            this.toggleTabsDropdown();
        });
        // The "+" next to the Query tab does the same as the double-click -
        // the double-click is not discoverable on its own.
        this.queryTabsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleTabsDropdown();
        });
        this.tabsDropdown.addEventListener('click', (e) => {
            const closeBtn = e.target.closest('[data-qtab-close]');
            if (closeBtn) { e.stopPropagation(); this.closeTab(Number(closeBtn.dataset.qtabClose)); return; }
            const addBtn = e.target.closest('[data-qtab-add]');
            if (addBtn) { this.addDraftTab(); this.closeTabsDropdown(); return; }
            const item = e.target.closest('.query-tabs-dropdown-item');
            if (item) { this.switchTab(Number(item.dataset.qtabId)); this.closeTabsDropdown(); }
        });
        document.addEventListener('click', (e) => {
            if (!this.tabsDropdown.classList.contains('visible')) return;
            if (this.tabsDropdown.contains(e.target) || e.target === this.queryTabButton) return;
            // The "+" button opens the dropdown too - without this, the click
            // that opened it would immediately close it again.
            if (this.queryTabsBtn && (e.target === this.queryTabsBtn || this.queryTabsBtn.contains(e.target))) return;
            this.closeTabsDropdown();
        });

        // A sub-tab remembers whichever database is selected while it's the
        // active one - only while the Query tab itself is in view, so
        // picking a database on Explorer doesn't silently reassign it.
        this.databaseSelect.addEventListener('change', () => {
            if (appState.activeTab !== 'query') return;
            const tab = this._activeTab();
            if (tab) tab.database = this.databaseSelect.value || null;
        });

        this.folderBtn.addEventListener('click', () => this.toggleFilesPanel());
        this.filesRefreshBtn.addEventListener('click', () => this.loadFilesTree());
        this.filesCollapseAllBtn.addEventListener('click', () => this.toggleCollapseAllDirs());
        this.filesHideBtn.addEventListener('click', () => this.filesPanel.classList.remove('visible'));
        this.filesFilterInput.addEventListener('input', () => {
            this._filterText = this.filesFilterInput.value.trim().toLowerCase();
            this.renderFilesTree();
        });
        this.filesTree.addEventListener('click', (e) => {
            const header = e.target.closest('[data-dir-toggle]');
            if (header) { this._toggleDirCollapse(header.dataset.dirToggle); return; }
            const fileRow = e.target.closest('[data-file-path]');
            if (fileRow) vscode.postMessage({ command: 'openSqlFile', path: fileRow.dataset.filePath });
        });
    }

    _makeDraftTab(content = '') {
        this.draftCounter++;
        return {
            id: this.nextId++,
            filePath: null,
            fileName: null,
            draftLabel: `Draft ${this.draftCounter}`,
            content,
            savedContent: null,
            database: null
        };
    }

    _activeTab() {
        return this.tabs.find(t => t.id === this.activeTabId);
    }

    // === Tabs dropdown ===

    toggleTabsDropdown() {
        if (this.tabsDropdown.classList.contains('visible')) this.closeTabsDropdown();
        else this.openTabsDropdown();
    }

    openTabsDropdown() {
        this.renderTabsDropdown();
        this.tabsDropdown.classList.add('visible');
    }

    closeTabsDropdown() {
        this.tabsDropdown.classList.remove('visible');
    }

    // === Tab switching / lifecycle ===

    switchTab(id) {
        if (id === this.activeTabId) return;
        const current = this._activeTab();
        if (current) current.content = this.queryManager.getEditorContent();

        this.activeTabId = id;
        const next = this._activeTab();
        this.queryManager.loadEditorContent(next.content || '');
        this._applyTabDatabase(next);
        this.render();
    }

    // A brand-new tab adopts whatever database is currently selected (first
    // activation only); an already-known one restores its own.
    _applyTabDatabase(tab) {
        if (tab.database === null) {
            tab.database = this.databaseSelect.value || null;
            return;
        }
        if (tab.database !== this.databaseSelect.value) {
            this.databaseSelect.value = tab.database;
            this.databaseSelect.dispatchEvent(new Event('change'));
        }
    }

    addDraftTab() {
        const current = this._activeTab();
        if (current) current.content = this.queryManager.getEditorContent();

        const tab = this._makeDraftTab();
        this.tabs.push(tab);
        this.activeTabId = tab.id;
        this.queryManager.loadEditorContent('');
        this._applyTabDatabase(tab);
        this.render();
    }

    closeTab(id) {
        const tab = this.tabs.find(t => t.id === id);
        if (!tab) return;
        if (id === this.activeTabId) tab.content = this.queryManager.getEditorContent();

        const dirty = tab.fileName && tab.content !== tab.savedContent;
        if (dirty) {
            this._pendingCloseTabId = id;
            vscode.postMessage({ command: 'confirmDiscardChanges', name: tab.fileName });
            return;
        }
        this._removeTab(id);
    }

    onDiscardConfirmed(message) {
        const id = this._pendingCloseTabId;
        this._pendingCloseTabId = null;
        if (id && message.discard) this._removeTab(id);
    }

    _removeTab(id) {
        const index = this.tabs.findIndex(t => t.id === id);
        if (index === -1) return;

        this.tabs.splice(index, 1);
        if (this.tabs.length === 0) this.tabs.push(this._makeDraftTab());

        if (id === this.activeTabId) {
            const fallback = this.tabs[Math.max(0, index - 1)] || this.tabs[0];
            this.activeTabId = fallback.id;
            this.queryManager.loadEditorContent(fallback.content || '');
            this._applyTabDatabase(fallback);
        }
        this.render();
        this.persistDraftsNow();
    }

    // === Left panel: browsing workspace .sql files ===

    // queryFilesBtn lives in the global tab-nav (next to the tab buttons
    // themselves), not inside the Query tab's own toolbar, so it's reachable
    // (and not disabled) from Configuration/Explorer too - but the panel it
    // toggles only exists inside #queryTab, which is display:none unless
    // that tab is active. Toggling the 'visible' class alone from another
    // tab was a silent no-op: switch to the Query tab and force the panel
    // open instead, rather than only ever toggling it.
    toggleFilesPanel() {
        if (appState.activeTab !== 'query') {
            if (window.tabManager) window.tabManager.switchTab('query');
            this.filesPanel.classList.add('visible');
            this.loadFilesTree();
            return;
        }

        const willShow = !this.filesPanel.classList.contains('visible');
        this.filesPanel.classList.toggle('visible', willShow);
        if (willShow) this.loadFilesTree();
    }

    loadFilesTree() {
        this.filesTree.innerHTML = '<p class="placeholder-text">Loading…</p>';
        vscode.postMessage({ command: 'listSqlFiles' });
    }

    onSqlFilesListed(message) {
        this._allFiles = message.files || [];
        this.renderFilesTree();
    }

    renderFilesTree() {
        if (this._allFiles.length === 0) {
            this.filesTree.innerHTML = '<p class="placeholder-text">No .sql files found in this workspace.</p>';
            return;
        }

        const filtering = this._filterText !== '';
        const visibleFiles = filtering
            ? this._allFiles.filter(f => f.name.toLowerCase().includes(this._filterText)
                || f.relativeDir.toLowerCase().includes(this._filterText))
            : this._allFiles;

        if (visibleFiles.length === 0) {
            this.filesTree.innerHTML = '<p class="placeholder-text">No files match this filter.</p>';
            return;
        }

        // Group by relativeDir ('' = workspace root, shown ungrouped at the top).
        const byDir = new Map();
        for (const file of visibleFiles) {
            if (!byDir.has(file.relativeDir)) byDir.set(file.relativeDir, []);
            byDir.get(file.relativeDir).push(file);
        }

        let html = '';
        const rootFiles = byDir.get('') || [];
        rootFiles.forEach(file => { html += this._fileRowHtml(file); });

        [...byDir.keys()].filter(dir => dir !== '').sort().forEach(dir => {
            const files = byDir.get(dir);
            // While filtering, matches stay expanded regardless of collapse
            // state - a collapsed group would otherwise hide its own results.
            const collapsed = !filtering && this._collapsedDirs.has(dir);
            html += `<div class="schema-header${collapsed ? ' collapsed' : ''}" data-dir-toggle="${this.escapeHtml(dir)}">`
                + `<span class="schema-name"><i class="codicon codicon-chevron-down schema-chevron"></i><i class="codicon codicon-folder"></i> ${this.escapeHtml(dir)}</span>`
                + `<span class="schema-count">(${files.length})</span></div>`;
            if (!collapsed) files.forEach(file => { html += this._fileRowHtml(file); });
        });

        this.filesTree.innerHTML = html;
    }

    _fileRowHtml(file) {
        return `<div class="object-item" data-file-path="${this.escapeHtml(file.path)}" title="${this.escapeHtml(file.path)}">`
            + `<span class="object-name-with-icon"><i class="codicon codicon-file"></i> ${this.escapeHtml(file.name)}</span>`
            + '</div>';
    }

    _toggleDirCollapse(dir) {
        if (this._collapsedDirs.has(dir)) this._collapsedDirs.delete(dir);
        else this._collapsedDirs.add(dir);
        this.renderFilesTree();
    }

    // One button for both directions: collapse every folder group, or (once
    // they're all collapsed) expand them all back.
    toggleCollapseAllDirs() {
        const allDirs = [...new Set(this._allFiles.map(f => f.relativeDir).filter(Boolean))];
        const allCollapsed = allDirs.length > 0 && allDirs.every(d => this._collapsedDirs.has(d));
        this._collapsedDirs = allCollapsed ? new Set() : new Set(allDirs);
        this.renderFilesTree();
    }

    onSqlFileOpened(message) {
        const current = this._activeTab();
        if (current) current.content = this.queryManager.getEditorContent();

        // Already open - just switch to it. Reloading from disk here would
        // silently wipe any unsaved edits in that tab.
        const existing = this.tabs.find(t => t.filePath === message.path);
        if (existing) {
            this.activeTabId = existing.id;
        } else {
            const tab = {
                id: this.nextId++,
                filePath: message.path,
                fileName: message.name,
                content: message.content,
                savedContent: message.content,
                database: null
            };
            this.tabs.push(tab);
            this.activeTabId = tab.id;
        }

        const active = this._activeTab();
        this.queryManager.loadEditorContent(active.content);
        this._applyTabDatabase(active);
        this.render();
    }

    onSqlFileError(message) {
        this.queryManager.setStatus(message.message, 'error');
    }

    // === Saving ===

    saveActiveTab() {
        const tab = this._activeTab();
        if (!tab) return;
        tab.content = this.queryManager.getEditorContent();

        // Mirrors the Save button's disabled state - Ctrl+S on a clean tab
        // (or an empty draft) is a no-op instead of a pointless write/prompt.
        const dirty = tab.fileName ? tab.content !== tab.savedContent : tab.content.trim() !== '';
        if (!dirty) return;

        if (tab.fileName) {
            vscode.postMessage({ command: 'saveSqlFile', path: tab.filePath, content: tab.content });
        } else {
            this._pendingSaveAsTabId = tab.id;
            const suggested = tab.draftLabel.toLowerCase().replace(/\s+/g, '-') + '.sql';
            vscode.postMessage({ command: 'saveSqlFileAs', content: tab.content, suggestedName: suggested });
        }
    }

    onSqlFileSaved(message) {
        if (!message.success) {
            this.queryManager.setStatus(`Save failed: ${message.message}`, 'error');
            return;
        }
        const tab = this.tabs.find(t => t.filePath === message.path);
        if (tab) {
            tab.savedContent = tab.content;
            this.render();
        }
        this.queryManager.setStatus(`Saved to ${tab ? tab.fileName : message.path}`, 'success');
    }

    onSqlFileSavedAs(message) {
        const id = this._pendingSaveAsTabId;
        this._pendingSaveAsTabId = null;
        if (message.cancelled) return;
        if (!message.success) {
            this.queryManager.setStatus(`Save failed: ${message.message}`, 'error');
            return;
        }

        const tab = this.tabs.find(t => t.id === id);
        if (tab) {
            tab.filePath = message.path;
            tab.fileName = message.name;
            tab.savedContent = tab.content;
            this.render();
            this.persistDraftsNow();
        }
        this.queryManager.setStatus(`Saved to ${message.name}`, 'success');
    }

    // === Crash-recovery snapshot for unsaved drafts only ===

    onEditorInput() {
        this.updateSaveButtonState();
        clearTimeout(this._draftTimer);
        this._draftTimer = setTimeout(() => this.persistDraftsNow(), 1500);
    }

    // Snapshots anything that would be lost in a crash: draft tabs with
    // content, and file-backed tabs with edits not yet written to disk
    // (their last save is safe, but whatever's typed since isn't).
    persistDraftsNow() {
        const active = this._activeTab();
        if (active) active.content = this.queryManager.getEditorContent();

        const drafts = this.tabs
            .filter(t => (!t.fileName && (t.content || '').trim() !== '') || (t.fileName && t.content !== t.savedContent))
            .map(t => ({ content: t.content, database: t.database, filePath: t.filePath, fileName: t.fileName }));
        vscode.postMessage({ command: 'saveDraftRecovery', drafts });
    }

    // Called both at startup and, now that drafts are scoped per connection
    // (see QueryFileHandlers.maybeOfferRecoveryForCurrentIdentity), again
    // after a successful connect - only ever applied while every open tab is
    // still pristine, so a recovery offer can never overwrite SQL the user
    // has already typed in this session.
    _isPristine() {
        const active = this._activeTab();
        return this.tabs.every(t => {
            if (t.fileName) return false;
            const content = t === active ? this.queryManager.getEditorContent() : (t.content || '');
            return content.trim() === '';
        });
    }

    onDraftRecoveryLoaded(message) {
        const drafts = message.drafts || [];
        if (drafts.length === 0 || !this._isPristine()) return;

        this.tabs = drafts.map(d => {
            const content = typeof d === 'string' ? d : (d.content || '');
            if (typeof d === 'object' && d.filePath) {
                return {
                    id: this.nextId++,
                    filePath: d.filePath,
                    fileName: d.fileName,
                    draftLabel: null,
                    content,
                    // Unknown vs. the current disk content until re-saved or
                    // re-opened - treated as modified, which is the safe guess.
                    savedContent: null,
                    database: d.database || null
                };
            }
            const tab = this._makeDraftTab(content);
            tab.database = typeof d === 'object' && d.database ? d.database : null;
            return tab;
        });
        this.activeTabId = this.tabs[0].id;
        this.queryManager.loadEditorContent(this.tabs[0].content);
        this.render();
        this.queryManager.setStatus(
            `Recovered ${drafts.length} unsaved buffer${drafts.length > 1 ? 's' : ''} from a previous session.`, ''
        );
    }

    // === Rendering ===

    render() {
        const active = this._activeTab();
        this.activeTabLabel.textContent = active ? (active.fileName || active.draftLabel) : '';
        if (this.tabsDropdown.classList.contains('visible')) this.renderTabsDropdown();
        this.updateSaveButtonState();
    }

    // Disabled whenever the active tab has nothing worth writing: an empty
    // draft, or a file whose content still matches what's on disk.
    updateSaveButtonState() {
        const tab = this._activeTab();
        if (!tab) { this.saveBtn.disabled = true; return; }
        const content = this.queryManager.getEditorContent();
        const dirty = tab.fileName ? content !== tab.savedContent : content.trim() !== '';
        this.saveBtn.disabled = !dirty;
    }

    renderTabsDropdown() {
        const itemsHtml = this.tabs.map(tab => {
            const active = tab.id === this.activeTabId;
            const label = tab.fileName || tab.draftLabel;
            const dirty = !!(tab.fileName && tab.content !== tab.savedContent);
            const preview = QueryManager.truncate(tab.content || '(empty)', 180);
            return `<div class="query-tabs-dropdown-item${active ? ' active' : ''}" `
                + `data-qtab-id="${tab.id}" role="menuitemradio" title="${this.escapeHtml(preview)}">`
                + (dirty ? '<span class="qtab-dirty-dot"></span>' : '')
                + `<span class="qtab-name">${this.escapeHtml(label)}</span>`
                + `<span class="qtab-close" data-qtab-close="${tab.id}">×</span>`
                + '</div>';
        }).join('');

        this.tabsDropdown.innerHTML = itemsHtml
            + '<button type="button" class="query-tabs-dropdown-add" data-qtab-add="1"><i class="codicon codicon-add"></i> New draft query</button>';
    }

    escapeHtml(text) {
        if (text === null || text === undefined) return '';
        return String(text).replace(/[&<>"']/g, ch => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
        ));
    }
}
