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
        // Carries the state of the active query for the stylesheet (the colour
        // of the focus frame), see updateEditorState().
        this.inputWrap = this.input.closest('.query-input-wrap');
        this.queryTabButton = document.querySelector('.tab-button[data-tab="query"]');
        this.queryTabsBtn = document.getElementById('queryTabsBtn');
        this.queryTabsCount = document.getElementById('queryTabsCount');
        this.activeTabLabel = document.getElementById('queryActiveTabLabel');
        this.tabsDropdown = document.getElementById('queryTabsDropdown');
        this.saveBtn = document.getElementById('saveQueryFileBtn');
        this.encodingSelect = document.getElementById('queryEncodingSelect');
        this.databaseSelect = document.getElementById('databaseSelect');

        this.folderBtn = document.getElementById('queryFilesBtn');
        this.filesPanel = document.getElementById('sqlFilesPanel');
        this.filesTree = document.getElementById('sqlFilesTree');
        this.filesSplitter = document.getElementById('sqlFilesSplitter');
        this.filesTotalEl = document.getElementById('sqlFilesTotal');
        this.filesRefreshBtn = document.getElementById('sqlFilesRefreshBtn');
        this.filesCollapseAllBtn = document.getElementById('sqlFilesCollapseAllBtn');
        this.filesHideBtn = document.getElementById('sqlFilesHideBtn');
        this.filesFilterInput = document.getElementById('sqlFilesFilterInput');
        this.filesContentBtn = document.getElementById('sqlFilesContentBtn');
        this.filesRegexBtn = document.getElementById('sqlFilesRegexBtn');
        this._collapsedDirs = new Set();
        this._allFiles = [];
        this._filterText = '';
        // The search in the contents of the files: off, the filter is on the names.
        this._contentSearch = false;
        this._regexSearch = false;
        this._searchId = 0;
        this._searchTimer = null;
        this._search = null;        // null: none; { searching } | { error } | { results: Map, truncated }

        this.nextId = 1;
        this.draftCounter = 0;
        this.tabs = [this._makeDraftTab()];
        this.activeTabId = this.tabs[0].id;
        this._pendingCloseTabId = null;
        this._pendingSaveAsTabId = null;
        this._draftTimer = null;

        this.initEventListeners();
        this.initSplitter();
        this.render();
        vscode.postMessage({ command: 'getDraftRecovery' });
    }

    initEventListeners() {
        this.saveBtn.addEventListener('click', () => this.saveActiveTab());
        // The encoding is the tab's own: a change makes a file modified (it has
        // to be saved again to be written in it).
        this.encodingSelect.addEventListener('change', () => {
            const tab = this._activeTab();
            if (!tab) return;
            tab.encoding = this.encodingSelect.value;
            this.render();
            this.persistDraftsNow();
        });
        this.input.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                this.saveActiveTab();
            }
        });
        // The draft snapshot follows what the user typed. A change the page
        // made on its own (the text of a script loaded, the text of another
        // tab, the drafts being recovered) must not write the editor's
        // content over the draft that is being recovered.
        this.input.addEventListener('input', () => this.onEditorInput());
        // The Save button follows every change of the text, whoever made it.
        this.input.addEventListener('content-changed', () => this.updateSaveButtonState());
        // Ctrl+Alt+PageDown / PageUp: the next / previous open query. Capture
        // phase, so the editor does not get to it first.
        document.addEventListener('keydown', (e) => {
            if (!e.ctrlKey || !e.altKey || (e.key !== 'PageDown' && e.key !== 'PageUp')) return;
            if (appState.activeTab !== 'query' || this.tabs.length < 2) return;
            e.preventDefault();
            this.cycleTab(e.key === 'PageDown' ? 1 : -1);
        }, true);

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
        // The cross of the active query: the other ones close from the list.
        document.getElementById('queryActiveClose').addEventListener('click', (e) => {
            e.stopPropagation();
            this.closeTab(this.activeTabId);
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
        this.filesRefreshBtn.addEventListener('click', () => (window.instanceTree && window.instanceTree.active ? window.instanceTree.refresh() : this.loadFilesTree()));
        this.filesCollapseAllBtn.addEventListener('click', () => (window.instanceTree && window.instanceTree.active ? window.instanceTree.toggleCollapseAll() : this.toggleCollapseAllDirs()));
        this.filesHideBtn.addEventListener('click', () => this._setFilesPanel(false));
        this.filesFilterInput.addEventListener('input', () => this._onFilterChanged());
        this.filesContentBtn.addEventListener('click', () => {
            this._contentSearch = !this._contentSearch;
            this.filesContentBtn.setAttribute('aria-pressed', String(this._contentSearch));
            this.filesRegexBtn.disabled = !this._contentSearch;
            this.filesFilterInput.placeholder = this._contentSearch ? 'Search in the files…' : 'Filter files…';
            this._onFilterChanged();
        });
        this.filesRegexBtn.addEventListener('click', () => {
            this._regexSearch = !this._regexSearch;
            this.filesRegexBtn.setAttribute('aria-pressed', String(this._regexSearch));
            this._onFilterChanged();
        });
        this.filesTree.addEventListener('click', (e) => {
            const header = e.target.closest('[data-dir-toggle]');
            if (header) { this._toggleDirCollapse(header.dataset.dirToggle); return; }
            const fileRow = e.target.closest('[data-file-path]');
            if (!fileRow) return;
            // A file found by a search opens on the line of its first match.
            const line = Number(fileRow.dataset.line) || undefined;
            vscode.postMessage({ command: 'openSqlFile', path: fileRow.dataset.filePath, line });
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
            encoding: 'utf8',
            savedEncoding: 'utf8',
            // The line ends the file had ('lf' or 'crlf'): the editor holds "\n" only.
            eol: 'lf',
            database: null
        };
    }

    // A file is modified when its text or its encoding differs from the disk;
    // a draft when it holds text.
    _isDirty(tab, content) {
        if (!tab.fileName) return (content || '').trim() !== '';
        return content !== tab.savedContent || tab.encoding !== tab.savedEncoding;
    }

    _activeTab() {
        return this.tabs.find(t => t.id === this.activeTabId);
    }

    // What a tab is called: the file's name, or for a draft the start of what
    // is typed in it ("Draft N" while it is empty).
    _tabLabel(tab, content) {
        if (tab.fileName) return tab.fileName;
        const firstLine = (content || '').split('\n').map(line => line.trim()).find(line => line !== '');
        if (!firstLine) return tab.draftLabel;
        const text = firstLine.replace(/\s+/g, ' ');
        return text.length > 20 ? `${text.slice(0, 20)}…` : text;
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

    cycleTab(step) {
        const index = this.tabs.findIndex(t => t.id === this.activeTabId);
        const next = this.tabs[(index + step + this.tabs.length) % this.tabs.length];
        this.switchTab(next.id);
        this.queryManager.input.focus();
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

    // A new draft tab that holds text (a script made from a result).
    addDraftTabWithContent(text) {
        this.addDraftTab();
        this.queryManager.loadEditorContent(text);
        this.onEditorInput();
    }

    closeTab(id) {
        const tab = this.tabs.find(t => t.id === id);
        if (!tab) return;
        if (id === this.activeTabId) tab.content = this.queryManager.getEditorContent();

        // A file with changes, or a draft with something in it: closing loses text.
        const dirty = this._isDirty(tab, tab.content);
        if (dirty) {
            this._pendingCloseTabId = id;
            vscode.postMessage({ command: 'confirmDiscardChanges', name: tab.fileName || tab.draftLabel });
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
    // (and not disabled) from Explorer too - but the panel it
    // toggles only exists inside #queryTab, which is display:none unless
    // that tab is active. Toggling the 'visible' class alone from another
    // tab was a silent no-op: switch to the Query tab and force the panel
    // open instead, rather than only ever toggling it.
    toggleFilesPanel() {
        if (appState.activeTab !== 'query') {
            if (window.tabManager) window.tabManager.switchTab('query');
            this._setFilesPanel(true);
            this.loadFilesTree();
            return;
        }

        const willShow = !this.filesPanel.classList.contains('visible');
        this._setFilesPanel(willShow);
        if (willShow) this.loadFilesTree();
    }

    // The button is VS Code's own side bar icon (filled while the panel is
    // open, outlined while it is closed), not a folder: the panel holds the
    // files and the instance.
    _setFilesPanel(visible) {
        this.filesPanel.classList.toggle('visible', visible);
        const icon = this.folderBtn.querySelector('.codicon');
        icon.classList.toggle('codicon-layout-sidebar-left-off', !visible);
        icon.classList.toggle('codicon-layout-sidebar-left', visible);
        this.folderBtn.setAttribute('aria-expanded', String(visible));
        this.folderBtn.title = visible ? 'Hide the side panel (files and instance)' : 'Show the side panel: the .sql files of the workspace and the databases of the instance';
    }

    loadFilesTree() {
        this.filesTree.innerHTML = '<p class="placeholder-text">Loading…</p>';
        vscode.postMessage({ command: 'listSqlFiles' });
    }

    onSqlFilesListed(message) {
        this._allFiles = message.files || [];
        this.renderFilesTree();
    }

    // The filter changed, or the way it searches: the names are filtered at
    // once; the contents are searched by the extension, after a short pause.
    _onFilterChanged() {
        this._filterText = this.filesFilterInput.value.trim().toLowerCase();
        clearTimeout(this._searchTimer);
        this._searchId++;
        this._search = null;
        const query = this.filesFilterInput.value.trim();
        if (this._contentSearch && query) {
            this._search = { searching: true };
            const id = this._searchId;
            this._searchTimer = setTimeout(() => {
                vscode.postMessage({ command: 'searchSqlFiles', query, regex: this._regexSearch, id });
            }, 300);
        }
        this.renderFilesTree();
    }

    onSqlFilesSearched(message) {
        if (message.id !== this._searchId || !this._search) return;
        this._search = message.error
            ? { error: message.error }
            : { results: new Map((message.results || []).map(r => [r.path, r])), truncated: !!message.truncated };
        this.renderFilesTree();
    }

    renderFilesTree() {
        if (this._search && this._search.searching) {
            this.filesTree.innerHTML = '<p class="placeholder-text"><span class="panel-spinner"></span>Searching…</p>';
            this._updateFilesTotal(null);
            return;
        }
        if (this._search && this._search.error) {
            this.filesTree.textContent = '';
            const p = document.createElement('p');
            p.className = 'placeholder-text';
            p.textContent = this._search.error;
            this.filesTree.appendChild(p);
            this._updateFilesTotal(null);
            return;
        }
        if (this._allFiles.length === 0) {
            this.filesTree.innerHTML = '<p class="placeholder-text">No .sql files found in this workspace.</p>';
            this._updateFilesTotal(null);
            return;
        }

        const filtering = this._filterText !== '';
        const found = this._search && this._search.results;
        const visibleFiles = found
            ? this._allFiles.filter(f => found.has(f.path)).map(f => ({ ...f, matches: found.get(f.path).count, line: found.get(f.path).line }))
            : FileTree.filterFiles(this._allFiles, this._filterText);

        if (visibleFiles.length === 0) {
            this.filesTree.innerHTML = found
                ? '<p class="placeholder-text">No file contains this text.</p>'
                : '<p class="placeholder-text">No files match this filter.</p>';
            this._updateFilesTotal(null);
            return;
        }

        // The real hierarchy: folders nested by path segment, each row showing
        // its own name and the number of files it holds.
        const tree = FileTree.buildFileTree(visibleFiles);
        this.filesTree.innerHTML = FileTree.renderFileTree(tree, {
            collapsed: this._collapsedDirs,
            filtering
        });
        this._updateFilesTotal(tree);
        if (found && this._search.truncated) this.filesTotalEl.textContent += '+';
        this._markOpenFiles();
    }

    // Highlights, in the files tree, the files that are open in a query tab
    // ("open") and the one of the tab being edited ("active"). The paths are
    // compared without regard to the slash and the case, as Windows does.
    _markOpenFiles() {
        if (!this.filesTree) return;
        const norm = p => String(p || '').replace(/\\/g, '/').toLowerCase();
        const open = new Set(this.tabs.filter(t => t.filePath).map(t => norm(t.filePath)));
        const current = this._activeTab();
        const active = current && current.filePath ? norm(current.filePath) : null;
        this.filesTree.querySelectorAll('.sql-file-item[data-file-path]').forEach(row => {
            const path = norm(row.dataset.filePath);
            row.classList.toggle('open', open.has(path));
            row.classList.toggle('active', path === active);
        });
    }

    // "N files in M folders" in the panel header: the tree only shows the
    // count of each folder, so the workspace total has to live somewhere.
    _updateFilesTotal(tree) {
        if (!this.filesTotalEl) return;
        if (!tree) {
            this.filesTotalEl.textContent = '';
            this.filesTotalEl.removeAttribute('title');
            return;
        }
        const files = FileTree.countSubtree(tree);
        const folders = Math.max(0, FileTree.countFolders(tree) - 1);
        this.filesTotalEl.textContent = `${files} file${files === 1 ? '' : 's'}`;
        this.filesTotalEl.setAttribute('title', `${files} file${files === 1 ? '' : 's'} in ${folders} folder${folders === 1 ? '' : 's'}`);
    }

    _toggleDirCollapse(dir) {
        if (this._collapsedDirs.has(dir)) this._collapsedDirs.delete(dir);
        else this._collapsedDirs.add(dir);
        this.renderFilesTree();
    }

    // One button for both directions: collapse every folder, or (once they're
    // all collapsed) expand them all back.
    toggleCollapseAllDirs() {
        const tree = FileTree.buildFileTree(this._allFiles);
        const allDirs = [];
        const collect = (node) => {
            for (const child of node.folders.values()) {
                allDirs.push(child.path);
                collect(child);
            }
        };
        collect(tree);

        const allCollapsed = allDirs.length > 0 && allDirs.every(d => this._collapsedDirs.has(d));
        this._collapsedDirs = allCollapsed ? new Set() : new Set(allDirs);
        this.renderFilesTree();
    }

    // Drag the bar on the right edge of the panel to widen it; double-click
    // puts it back to the default. The width is remembered between sessions.
    initSplitter() {
        const splitter = this.filesSplitter;
        const panel = this.filesPanel;
        if (!splitter || !panel) return;

        const MIN_WIDTH = 150;
        const DEFAULT_WIDTH = 260;
        const STORAGE_KEY = 'sqlwayfarer.sqlFilesPanelWidth';

        const readStoredWidth = () => {
            try {
                const stored = parseInt(window.localStorage.getItem(STORAGE_KEY), 10);
                return Number.isFinite(stored) && stored > 0 ? stored : null;
            } catch {
                return null;
            }
        };
        const storeWidth = (width) => {
            try {
                window.localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
            } catch {
                // Storage can be unavailable (private mode, sandboxed webview):
                // the width just won't be remembered.
            }
        };

        const stored = readStoredWidth();
        if (stored) panel.style.width = `${Math.max(MIN_WIDTH, stored)}px`;

        splitter.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startWidth = panel.getBoundingClientRect().width;
            splitter.classList.add('dragging');
            document.body.style.userSelect = 'none';

            const onMove = (ev) => {
                const host = panel.parentElement;
                const maxWidth = host ? Math.max(MIN_WIDTH, host.clientWidth * 0.6) : 900;
                const next = Math.min(Math.max(MIN_WIDTH, startWidth + (ev.clientX - startX)), maxWidth);
                panel.style.width = `${next}px`;
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                splitter.classList.remove('dragging');
                document.body.style.userSelect = '';
                storeWidth(panel.getBoundingClientRect().width);
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        splitter.addEventListener('dblclick', () => {
            panel.style.width = `${DEFAULT_WIDTH}px`;
            try {
                window.localStorage.removeItem(STORAGE_KEY);
            } catch {
                // Nothing to clean up.
            }
        });
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
            // The editor holds "\n" only (the file's own line ends come back in
            // `eol`): the text compared with the editor's must be in that form
            // too, or a CRLF file is "modified" from the moment it is opened.
            const text = message.content.replace(/\r\n?/g, '\n');
            const tab = {
                id: this.nextId++,
                filePath: message.path,
                fileName: message.name,
                content: text,
                savedContent: text,
                encoding: message.encoding || 'utf8',
                savedEncoding: message.encoding || 'utf8',
                eol: message.eol || 'lf',
                database: null
            };
            this.tabs.push(tab);
            this.activeTabId = tab.id;
        }

        const active = this._activeTab();
        this.queryManager.loadEditorContent(active.content);
        this._applyTabDatabase(active);
        this.render();
        // Found by a search: on the line of the first match.
        if (message.line && typeof this.queryManager.input.goToLine === 'function') this.queryManager.input.goToLine(message.line);
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
        if (!this._isDirty(tab, tab.content)) return;

        if (tab.fileName) {
            vscode.postMessage({ command: 'saveSqlFile', path: tab.filePath, content: tab.content, encoding: tab.encoding, eol: tab.eol });
        } else {
            this._pendingSaveAsTabId = tab.id;
            const suggested = tab.draftLabel.toLowerCase().replace(/\s+/g, '-') + '.sql';
            vscode.postMessage({ command: 'saveSqlFileAs', content: tab.content, suggestedName: suggested, encoding: tab.encoding });
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
            tab.savedEncoding = tab.encoding;
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
            tab.savedEncoding = tab.encoding;
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
            .filter(t => this._isDirty(t, t.content))
            .map(t => ({ content: t.content, database: t.database, filePath: t.filePath, fileName: t.fileName, encoding: t.encoding, savedEncoding: t.savedEncoding, eol: t.eol }));
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
                    encoding: d.encoding || 'utf8',
                    savedEncoding: d.savedEncoding || 'utf8',
                    eol: d.eol || 'lf',
                    database: d.database || null
                };
            }
            const tab = this._makeDraftTab(content);
            if (typeof d === 'object' && d.encoding) tab.encoding = tab.savedEncoding = d.encoding;
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
        this.activeTabLabel.textContent = active ? this._tabLabel(active, this.queryManager.getEditorContent()) : '';
        // The list of open queries is one click away - and how many there are
        // shows on its button as soon as there is more than one.
        if (active) this.encodingSelect.value = active.encoding;
        this.queryTabsCount.hidden = this.tabs.length < 2;
        this.queryTabsCount.textContent = String(this.tabs.length);
        this.activeTabLabel.title = 'Frame of the editor - purple: draft, not in a file; orange: file with unsaved changes; blue: saved file';
        if (this.tabsDropdown.classList.contains('visible')) this.renderTabsDropdown();
        this._markOpenFiles();
        this.updateSaveButtonState();
    }

    // Disabled whenever the active tab has nothing worth writing: an empty
    // draft, or a file whose content still matches what's on disk.
    updateSaveButtonState() {
        const tab = this._activeTab();
        if (!tab) { this.saveBtn.disabled = true; return; }
        const content = this.queryManager.getEditorContent();
        this.saveBtn.disabled = !this._isDirty(tab, content);
        this.activeTabLabel.textContent = this._tabLabel(tab, content);
        this.updateEditorState(tab, content);
    }

    // What the colour of the editor's focus frame says about the active query:
    //   draft     - not in a file (purple)
    //   modified  - a file with changes not saved yet (orange)
    //   saved     - a file, as on disk (the theme's focus colour)
    updateEditorState(tab, content) {
        if (!this.inputWrap) return;
        let state = '';
        if (tab) state = !tab.fileName ? 'draft' : (this._isDirty(tab, content) ? 'modified' : 'saved');
        this.inputWrap.dataset.queryState = state;
    }

    renderTabsDropdown() {
        // The active query is the one in the Query tab (with its own cross): the list is the other ones.
        const itemsHtml = this.tabs.filter(tab => tab.id !== this.activeTabId).map(tab => {
            const active = false;
            const label = this._tabLabel(tab, tab.content);
            const dirty = !!tab.fileName && this._isDirty(tab, tab.content);
            const preview = QueryManager.truncate(tab.content || '(empty)', 180);
            return `<div class="query-tabs-dropdown-item${active ? ' active' : ''}" `
                + `data-qtab-id="${tab.id}" role="menuitemradio" title="${this.escapeHtml(preview)}">`
                + (dirty ? '<span class="qtab-dirty-dot"></span>' : '')
                + `<span class="qtab-name">${this.escapeHtml(label)}</span>`
                + (tab.database ? `<span class="qtab-db" title="Database this query runs on">${this.escapeHtml(tab.database)}</span>` : '')
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
