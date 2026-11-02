/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// How each way of signing in is shown in the list.
const AUTH_ICONS = {
    sql: { icon: 'key', label: 'SQL login' },
    windows: { icon: 'account', label: 'Windows (current user)' },
    entra: { icon: 'azure', label: 'Microsoft Entra ID' }
};

// The saved connections, in the activity bar sidebar (see
// panels/SnippetSidebarProvider.js): list, create, edit, delete, test, and
// open one in its own SQL Wayfarer tab.
class SidebarConnections {
    constructor() {
        this.connections = [];
        this.openNames = [];
        this.lastConnection = null;
        this.editingName = null;
        // Groups the user folded, kept with the view (see setState).
        this.collapsed = new Set(this.savedCollapsed());
        this._statusTimer = null;
        this.initDOMElements();
        this.initEventListeners();
        vscode.postMessage({ command: 'loadConnections' });
    }

    initDOMElements() {
        const byId = id => document.getElementById(id);
        this.elements = {
            listView: byId('connectionListView'),
            formView: byId('connectionFormView'),
            newBtn: byId('newConnectionBtn'),
            importBtn: byId('importConnectionsBtn'),
            list: byId('connectionList'),
            filter: byId('connectionFilter'),
            status: byId('connectionsStatus'),
            backBtn: byId('connectionFormBackBtn'),
            formTitle: byId('connectionFormTitle'),
            saveBtn: byId('saveConnectionBtn'),
            saveAndOpenBtn: byId('saveAndOpenConnectionBtn'),
            testBtn: byId('testConnectionBtn'),
            formStatus: byId('connectionFormStatus'),
            nameInput: byId('connectionNameInput'),
            serverInput: byId('serverInput'),
            portInput: byId('portInput'),
            groupInput: byId('groupInput'),
            databaseInput: byId('databaseInput'),
            authTypeSelect: byId('authTypeSelect'),
            sqlAuthFields: byId('sqlAuthFields'),
            entraAuthHint: byId('entraAuthHint'),
            windowsAuthHint: byId('windowsAuthHint'),
            usernameInput: byId('usernameInput'),
            passwordInput: byId('passwordInput'),
            encryptCheckbox: byId('encryptCheckbox'),
            trustCertCheckbox: byId('trustCertCheckbox')
        };
    }

    initEventListeners() {
        const e = this.elements;
        e.newBtn.addEventListener('click', () => this.openForm());
        e.importBtn.addEventListener('click', () => vscode.postMessage({ command: 'importConnections' }));
        e.backBtn.addEventListener('click', () => this.closeForm());
        e.saveBtn.addEventListener('click', () => this.save());
        e.saveAndOpenBtn.addEventListener('click', () => this.save(true));
        e.testBtn.addEventListener('click', () => this.test());
        e.authTypeSelect.addEventListener('change', () => this.applyAuthType());
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !e.formView.hidden) this.closeForm();
        });

        e.filter.addEventListener('input', () => this.renderList());
        e.filter.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                e.filter.value = '';
                this.renderList();
            } else if (event.key === 'Enter') {
                // The first match, so a connection can be reached by typing.
                const first = this.visibleConnections()[0];
                if (first) this.open(first.name);
            }
        });

        // Rows are re-rendered on every update: one delegated listener.
        e.list.addEventListener('click', event => {
            if (event.target.closest('[data-connection-action="new"]')) {
                this.openForm();
                return;
            }
            const toggle = event.target.closest('[data-group-toggle]');
            if (toggle) {
                this.toggleGroup(toggle.dataset.groupToggle);
                return;
            }
            const row = event.target.closest('[data-connection-name]');
            if (!row) return;
            const button = event.target.closest('button[data-connection-action]');
            this.runAction(row.dataset.connectionName, button ? button.dataset.connectionAction : 'connect');
        });
        e.list.addEventListener('keydown', event => {
            // Enter or Space on the row itself (not on one of its buttons).
            const row = event.target.closest('[data-connection-name]');
            if (!row || event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return;
            event.preventDefault();
            this.runAction(row.dataset.connectionName, 'connect');
        });
    }

    runAction(name, action) {
        if (action === 'connect') this.open(name);
        else if (action === 'edit') this.openForm(name);
        else if (action === 'delete') vscode.postMessage({ command: 'deleteConnection', connectionName: name });
    }

    open(name) {
        vscode.postMessage({ command: 'connectToSaved', connectionName: name });
    }

    // ---- List ---------------------------------------------------------

    onSavedConnectionsLoaded(message) {
        this.connections = message.connections || [];
        this.openNames = message.openConnections || [];
        this.lastConnection = message.lastConnection;
        this.renderList();
    }

    onOpenConnectionsChanged(names) {
        this.openNames = names || [];
        this.renderList();
    }

    // Ungrouped first, then by group, alphabetical inside; narrowed by the
    // filter (name, group, server or database).
    visibleConnections() {
        const needle = this.elements.filter.value.trim().toLowerCase();
        const compare = (a, b) => (a || '').localeCompare(b || '', undefined, { sensitivity: 'base', numeric: true });
        return this.connections
            .filter(c => !needle || [c.name, c.group, c.server, c.database].some(v => (v || '').toLowerCase().includes(needle)))
            .sort((a, b) => (!!a.group - !!b.group) || compare(a.group, b.group) || compare(a.name, b.name));
    }

    savedCollapsed() {
        try {
            const state = vscode.getState();
            return state && Array.isArray(state.collapsedGroups) ? state.collapsedGroups : [];
        } catch { return []; }
    }

    // "Production/Europe" is out of sight when "Production" is folded.
    isHiddenByAncestor(group) {
        const parts = group.split('/');
        for (let i = 1; i < parts.length; i++) if (this.collapsed.has(parts.slice(0, i).join('/'))) return true;
        return false;
    }

    toggleGroup(group) {
        if (this.collapsed.has(group)) this.collapsed.delete(group);
        else this.collapsed.add(group);
        try { vscode.setState(Object.assign({}, vscode.getState(), { collapsedGroups: [...this.collapsed] })); } catch { /* not kept */ }
        this.renderList();
    }

    renderList() {
        if (this.connections.length === 0) {
            this.elements.list.innerHTML = `<div class="sb-empty">No connection yet.<br>
                <button type="button" class="sb-btn primary" data-connection-action="new">New connection</button></div>`;
            return;
        }
        const visible = this.visibleConnections();
        if (visible.length === 0) {
            this.elements.list.innerHTML = '<p class="sb-empty">No connection matches.</p>';
            return;
        }
        // A filter shows every match, folded or not.
        const filtering = this.elements.filter.value.trim() !== '';
        let html = '';
        let current = '';
        for (const connection of visible) {
            const group = connection.group || '';
            const hidden = !filtering && this.isHiddenByAncestor(group);
            if (group && group !== current && !hidden) {
                const size = visible.filter(c => (c.group || '') === group || (c.group || '').startsWith(group + '/')).length;
                const folded = !filtering && this.collapsed.has(group);
                html += `<button type="button" class="sb-group-toggle" data-group-toggle="${this.escapeHtml(group)}" aria-expanded="${!folded}"${filtering ? ' disabled' : ''}>
                    <i class="codicon codicon-chevron-${folded ? 'right' : 'down'}"></i>${this.escapeHtml(group.split('/').join(' / '))}<span class="sb-group-count">${size}</span></button>`;
            }
            current = group;
            if (group && !filtering && (this.collapsed.has(group) || hidden)) continue;
            html += this.buildRowHtml(connection);
        }
        this.elements.list.innerHTML = html;
    }

    buildRowHtml(connection) {
        const isOpen = this.openNames.includes(connection.name);
        const isLast = connection.name === this.lastConnection;
        const auth = AUTH_ICONS[connection.authType] || AUTH_ICONS.sql;
        const target = connection.server + (connection.port ? `:${connection.port}` : '')
            + (connection.database ? ` / ${connection.database}` : '');
        const flags = (isLast ? '<i class="codicon codicon-history sb-last-used" title="Last used"></i>' : '')
            + (isOpen ? '<span class="sb-open-dot" title="Open in a tab"></span>' : '');
        return `<div class="sb-row clickable" role="button" tabindex="0" data-connection-name="${this.escapeHtml(connection.name)}" title="${isOpen ? 'Show its tab' : 'Open in a tab'}">
            <i class="codicon codicon-${auth.icon} sb-row-icon" title="${auth.label}"></i>
            <div class="sb-row-main">
                <div class="sb-row-name">${this.escapeHtml(connection.name)}</div>
                <div class="sb-row-sub">${this.escapeHtml(target)}</div>
            </div>
            <div class="sb-row-flags">${flags}</div>
            <div class="sb-row-actions">
                <button type="button" class="sb-icon-btn" data-connection-action="connect" title="Open in a tab" aria-label="Open in a tab"><svg class="sw-icon" viewBox="0 0 16 16" aria-hidden="true"><use href="#sw-run"/></svg></button>
                <button type="button" class="sb-icon-btn" data-connection-action="edit" title="Edit" aria-label="Edit"><i class="codicon codicon-edit"></i></button>
                <button type="button" class="sb-icon-btn" data-connection-action="delete" title="Delete" aria-label="Delete"><i class="codicon codicon-trash"></i></button>
            </div>
        </div>`;
    }

    // ---- Form ---------------------------------------------------------

    openForm(name = null) {
        const e = this.elements;
        this.editingName = name;
        const connection = name ? this.connections.find(c => c.name === name) : null;
        e.formTitle.textContent = connection ? `Edit ${name}` : 'New connection';
        this.fillForm(connection);
        this.showFormStatus('', '');
        e.listView.hidden = true;
        e.formView.hidden = false;
        (connection ? e.serverInput : e.nameInput).focus();
    }

    closeForm() {
        this.elements.formView.hidden = true;
        this.elements.listView.hidden = false;
        this.editingName = null;
    }

    fillForm(connection) {
        const e = this.elements;
        e.nameInput.value = connection ? connection.name : '';
        e.serverInput.value = connection ? connection.server || '' : '';
        e.portInput.value = connection ? connection.port || '' : '';
        e.groupInput.value = connection ? connection.group || '' : '';
        e.databaseInput.value = connection ? connection.database || '' : '';
        const authType = connection ? connection.authType : 'sql';
        e.authTypeSelect.value = ['entra', 'windows'].includes(authType) ? authType : 'sql';
        this.applyAuthType();
        e.usernameInput.value = connection ? connection.username || '' : '';
        // The password is never sent back to the view.
        e.passwordInput.value = '';
        e.passwordInput.placeholder = connection ? 'Leave empty to use the saved password' : 'Password';
        e.encryptCheckbox.checked = connection ? !!connection.encrypt : false;
        e.trustCertCheckbox.checked = connection ? connection.trustServerCertificate !== false : true;
    }

    // Windows and Entra ID have no login or password to type; Azure SQL only
    // takes encrypted connections.
    applyAuthType() {
        const e = this.elements;
        const authType = e.authTypeSelect.value;
        e.sqlAuthFields.hidden = authType !== 'sql';
        e.entraAuthHint.hidden = authType !== 'entra';
        e.windowsAuthHint.hidden = authType !== 'windows';
        if (authType === 'entra') e.encryptCheckbox.checked = true;
    }

    buildConnectionConfig() {
        const e = this.elements;
        const config = {
            useConnectionString: false,
            authType: e.authTypeSelect.value,
            server: e.serverInput.value.trim(),
            port: e.portInput.value.trim(),
            group: e.groupInput.value.trim().replace(/\s*\/\s*/g, '/').replace(/^\/+|\/+$/g, ''),
            database: e.databaseInput.value.trim(),
            username: e.usernameInput.value.trim(),
            password: e.passwordInput.value,
            encrypt: e.encryptCheckbox.checked,
            trustServerCertificate: e.trustCertCheckbox.checked
        };
        // The fields are only hidden for Windows and Entra ID: what is left in
        // them must not end up in the secret storage.
        if (config.authType !== 'sql') {
            config.username = '';
            config.password = '';
        }
        return config;
    }

    save(openAfter = false) {
        const name = this.elements.nameInput.value.trim();
        if (!name) {
            this.showFormStatus('Please enter a connection name.', 'error');
            return;
        }
        if (!this.elements.serverInput.value.trim()) {
            this.showFormStatus('Please enter a server.', 'error');
            return;
        }
        const connectionConfig = this.buildConnectionConfig();
        connectionConfig.name = name;
        // When editing under a new name, the backend needs the old name to
        // clean up the previous entry and its stored secret.
        vscode.postMessage({
            command: openAfter ? 'saveAndOpenConnection' : 'saveConnection',
            connectionConfig,
            originalName: this.editingName
        });
    }

    test() {
        const connectionConfig = this.buildConnectionConfig();
        if (this.editingName) {
            // Editing: an empty password means "the saved one".
            connectionConfig.name = this.editingName;
            connectionConfig.isLoadedConnection = !connectionConfig.password;
        }
        this.elements.testBtn.disabled = true;
        this.elements.testBtn.textContent = 'Testing…';
        this.showFormStatus('', '');
        vscode.postMessage({ command: 'testConnection', connectionConfig });
    }

    // ---- Replies ------------------------------------------------------

    onConnectionSaved(message) {
        if (message.success) {
            this.closeForm();
            this.showStatus(message.message, 'success');
        } else {
            this.showFormStatus(message.message, 'error');
        }
    }

    onConnectionsImported(message) {
        const parts = [`${message.added} added`];
        if (message.overwritten) parts.push(`${message.overwritten} overwritten`);
        if (message.failed) parts.push(`${message.failed} failed`);
        if (message.skipped) parts.push(`${message.skipped} skipped (address that cannot be used)`);
        this.showStatus(`Connections imported: ${parts.join(', ')}.`, message.failed ? 'error' : 'success');
    }

    onConnectionDeleted(message) {
        this.showStatus(message.message, message.success ? 'success' : 'error');
    }

    onTestConnectionResult(message) {
        this.elements.testBtn.disabled = false;
        this.elements.testBtn.textContent = 'Test';
        this.showFormStatus(message.message, message.success ? 'success' : 'error');
    }

    onError(message) {
        this.showStatus(message, 'error');
    }

    // A confirmation under the list: it fades away by itself, an error stays.
    showStatus(message, type) {
        clearTimeout(this._statusTimer);
        this.elements.status.className = 'sb-status ' + type;
        this.elements.status.textContent = message;
        if (type === 'success') {
            this._statusTimer = setTimeout(() => { this.elements.status.textContent = ''; }, 4000);
        }
    }

    showFormStatus(message, type) {
        this.elements.formStatus.className = 'sb-status ' + type;
        this.elements.formStatus.textContent = message;
    }

    escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}
