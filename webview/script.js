'use strict';

const vscode = acquireVsCodeApi();

// DOM elements
const connectionStringInput = document.getElementById('connectionString');
const connectBtn = document.getElementById('connectBtn');
const connectionStatus = document.getElementById('connectionStatus');
const databaseSelect = document.getElementById('databaseSelect');
const objectList = document.getElementById('objectList');
const detailsContent = document.getElementById('detailsContent');

let selectedObject = null;

// Event listeners
connectBtn.addEventListener('click', handleConnect);
databaseSelect.addEventListener('change', handleDatabaseChange);

// Message handler
window.addEventListener('message', handleMessage);

function handleConnect() {
    const connectionString = connectionStringInput.value.trim();
    if (connectionString) {
        connectBtn.disabled = true;
        connectBtn.textContent = 'Connecting...';
        vscode.postMessage({
            command: 'connect',
            connectionString: connectionString
        });
    }
}

function handleDatabaseChange() {
    const database = databaseSelect.value;
    if (database) {
        objectList.innerHTML = '<p>Loading objects...</p>';
        detailsContent.innerHTML = '<p>Loading...</p>';
        vscode.postMessage({
            command: 'getObjects',
            database: database
        });
    } else {
        objectList.innerHTML = '';
        detailsContent.innerHTML = '<p>Select a database first.</p>';
    }
}

function handleMessage(event) {
    const message = event.data;
    
    switch (message.command) {
        case 'connectionStatus':
            handleConnectionStatus(message);
            break;
            
        case 'databasesLoaded':
            handleDatabasesLoaded(message.databases);
            break;
            
        case 'objectsLoaded':
            displayObjects(message.objects);
            break;
            
        case 'tableDetailsLoaded':
            displayTableDetails(
                message.tableName, 
                message.columns, 
                message.indexes, 
                message.foreignKeys,
                message.dependencies
            );
            break;
            
        case 'objectDetailsLoaded':
            displayObjectDetails(
                message.objectName,
                message.objectType,
                message.dependencies,
                message.definition
            );
            break;
            
        case 'error':
            handleError(message.message);
            break;
    }
}

function handleConnectionStatus(message) {
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect';
    
    connectionStatus.className = 'status ' + (message.success ? 'success' : 'error');
    connectionStatus.textContent = message.message;
    
    if (message.success) {
        databaseSelect.disabled = false;
    }
}

function handleDatabasesLoaded(databases) {
    databaseSelect.innerHTML = '<option value="">Select a database...</option>';
    databases.forEach(db => {
        const option = document.createElement('option');
        option.value = db;
        option.textContent = db;
        databaseSelect.appendChild(option);
    });
}

function handleError(message) {
    connectionStatus.className = 'status error';
    connectionStatus.textContent = message;
}

function displayObjects(objects) {
    objectList.innerHTML = '';
    
    objects.forEach(obj => {
        const div = document.createElement('div');
        div.className = 'object-item';
        div.innerHTML = `${obj.name}<span class="object-type">(${obj.object_type})</span>`;
        div.dataset.name = obj.name;
        div.dataset.type = obj.object_type;
        
        div.addEventListener('click', () => handleObjectClick(div, obj));
        
        objectList.appendChild(div);
    });
}

function handleObjectClick(element, obj) {
    // Remove previous selection
    const prevSelected = objectList.querySelector('.selected');
    if (prevSelected) {
        prevSelected.classList.remove('selected');
    }
    
    // Add selection to current item
    element.classList.add('selected');
    selectedObject = obj;
    
    // Load details for tables
    if (obj.object_type === 'Table') {
        vscode.postMessage({
            command: 'getTableDetails',
            database: databaseSelect.value,
            table: obj.name
        });
    } else {
        // Load details for other object types
        vscode.postMessage({
            command: 'getObjectDetails',
            database: databaseSelect.value,
            objectName: obj.name,
            objectType: obj.object_type
        });
    }
}

function displayTableDetails(tableName, columns, indexes, foreignKeys, dependencies) {
    const html = [
        `<div class="section-header">Table: ${tableName}</div>`,
        buildColumnsTable(columns),
        buildIndexesTable(indexes),
        buildForeignKeysTable(foreignKeys),
        buildDependenciesSection(dependencies)
    ].join('');
    
    detailsContent.innerHTML = html;
}

function displayObjectDetails(objectName, objectType, dependencies, definition) {
    let html = `<div class="section-header">${objectType}: ${objectName}</div>`;
    
    // Add definition for non-table objects
    if (definition) {
        html += buildDefinitionSection(definition);
    }
    
    // Add dependencies
    html += buildDependenciesSection(dependencies);
    
    detailsContent.innerHTML = html;
}

function buildColumnsTable(columns) {
    let html = '<h3>Columns</h3>';
    html += '<table><tr><th>Name</th><th>Type</th><th>Nullable</th><th>Default</th><th>Length</th></tr>';
    
    columns.forEach(col => {
        html += `<tr>
            <td>${col.COLUMN_NAME}</td>
            <td>${col.DATA_TYPE}</td>
            <td>${col.IS_NULLABLE}</td>
            <td>${col.COLUMN_DEFAULT || ''}</td>
            <td>${col.CHARACTER_MAXIMUM_LENGTH || ''}</td>
        </tr>`;
    });
    
    html += '</table>';
    return html;
}

function buildIndexesTable(indexes) {
    let html = '<h3>Indexes</h3>';
    
    if (indexes.length > 0) {
        html += '<table><tr><th>Name</th><th>Type</th><th>Unique</th><th>Primary Key</th><th>Columns</th></tr>';
        
        indexes.forEach(idx => {
            html += `<tr>
                <td>${idx.index_name}</td>
                <td>${idx.type_desc}</td>
                <td>${idx.is_unique ? 'Yes' : 'No'}</td>
                <td>${idx.is_primary_key ? 'Yes' : 'No'}</td>
                <td>${idx.columns}</td>
            </tr>`;
        });
        
        html += '</table>';
    } else {
        html += '<p>No indexes found.</p>';
    }
    
    return html;
}

function buildForeignKeysTable(foreignKeys) {
    let html = '<h3>Foreign Keys</h3>';
    
    if (foreignKeys.length > 0) {
        html += '<table><tr><th>Name</th><th>Column</th><th>Referenced Table</th><th>Referenced Column</th></tr>';
        
        foreignKeys.forEach(fk => {
            html += `<tr>
                <td>${fk.fk_name}</td>
                <td>${fk.column_name}</td>
                <td>${fk.referenced_table}</td>
                <td>${fk.referenced_column}</td>
            </tr>`;
        });
        
        html += '</table>';
    } else {
        html += '<p>No foreign keys found.</p>';
    }
    
    return html;
}

function buildDefinitionSection(definition) {
    let html = '<h3>Definition</h3>';
    html += '<div class="definition-container">';
    html += `<pre><code>${escapeHtml(definition || 'No definition available')}</code></pre>`;
    html += '</div>';
    return html;
}

function buildDependenciesSection(dependencies) {
    if (!dependencies) {
        return '<h3>Dependencies</h3><p>No dependency information available.</p>';
    }
    
    let html = '<h3>Dependencies</h3>';
    
    // Objects this object depends on
    html += '<h4>Dependencies (objects this depends on):</h4>';
    if (dependencies.dependsOn && dependencies.dependsOn.length > 0) {
        html += '<table><tr><th>Object Name</th><th>Type</th><th>Dependency Type</th></tr>';
        dependencies.dependsOn.forEach(dep => {
            html += `<tr>
                <td>${dep.referenced_object}</td>
                <td>${dep.referenced_object_type}</td>
                <td>${dep.dependency_type || 'Unknown'}</td>
            </tr>`;
        });
        html += '</table>';
    } else {
        html += '<p>No dependencies found.</p>';
    }
    
    // Objects that depend on this object
    html += '<h4>Referenced by (objects that depend on this):</h4>';
    if (dependencies.referencedBy && dependencies.referencedBy.length > 0) {
        html += '<table><tr><th>Object Name</th><th>Type</th><th>Dependency Type</th></tr>';
        dependencies.referencedBy.forEach(ref => {
            html += `<tr>
                <td>${ref.referencing_object}</td>
                <td>${ref.referencing_object_type}</td>
                <td>${ref.dependency_type || 'Unknown'}</td>
            </tr>`;
        });
        html += '</table>';
    } else {
        html += '<p>No objects reference this object.</p>';
    }
    
    return html;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Initialize the webview
document.addEventListener('DOMContentLoaded', function() {
    console.log('SQL Wayfarer webview loaded');
});