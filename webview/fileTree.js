/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// The SQL Files panel used to render one flat group per directory, labelled
// with its full path. That made the tree unreadable (the path ate the whole
// width, so the file counts were clipped), and every group header was
// sticky - so on a long list they piled up over the files underneath and
// swallowed their clicks.
//
// This module builds the real hierarchy instead: folders nested by path
// segment, each row showing its own name and indented under its parent, with
// the number of files it holds. Pure functions, no DOM, so the rendering can
// be unit-tested.

// A folder in the tree. The workspace root is a folder with an empty name.
function makeFolder(name, path) {
    return { name, path, files: [], folders: new Map() };
}

// Turns the flat list the extension sends ({name, path, relativeDir}) into a
// tree of folders. relativeDir uses '/' separators and is empty for files
// sitting at the workspace root.
function buildFileTree(files) {
    const root = makeFolder('', '');
    for (const file of files || []) {
        const dir = String(file.relativeDir || '').replace(/^[/\\]+|[/\\]+$/g, '');
        const segments = dir ? dir.split(/[/\\]/) : [];
        let node = root;
        let currentPath = '';
        for (const segment of segments) {
            currentPath = currentPath ? currentPath + '/' + segment : segment;
            let child = node.folders.get(segment);
            if (!child) {
                child = makeFolder(segment, currentPath);
                node.folders.set(segment, child);
            }
            node = child;
        }
        node.files.push(file);
    }
    return root;
}

// The files of a folder and of every folder below it.
function countSubtree(node) {
    let total = node.files.length;
    for (const child of node.folders.values()) total += countSubtree(child);
    return total;
}

// How many folders the tree holds, root included.
function countFolders(node) {
    let total = 1;
    for (const child of node.folders.values()) total += countFolders(child);
    return total;
}

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text).replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

function compareNames(a, b) {
    return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
}

// The filter matches on the file name or on the folder path - a folder name
// therefore keeps all of its files.
function filterFiles(files, filterText) {
    const filter = String(filterText || '').trim().toLowerCase();
    if (!filter) return files || [];
    return (files || []).filter(file =>
        String(file.name || '').toLowerCase().includes(filter)
        || String(file.relativeDir || '').toLowerCase().includes(filter)
    );
}

// Renders the tree to HTML. Every row carries the path it belongs to, so the
// caller can tell a folder row from a file row without inspecting the markup.
//
// `collapsed` holds the folder paths the user closed; `filtering` expands
// everything, because a closed folder would hide the very files the filter
// was asked for.
function renderFileTree(root, { collapsed = new Set(), filtering = false } = {}) {
    let html = '';

    // Files at the workspace root have no folder to sit under.
    const rootFiles = root.files.slice().sort((a, b) => compareNames(a.name, b.name));
    for (const file of rootFiles) html += fileRowHtml(file, 0);

    const folders = [...root.folders.values()].sort((a, b) => compareNames(a.name, b.name));
    for (const folder of folders) html += folderHtml(folder, 0, collapsed, filtering);

    return html;
}

function folderHtml(folder, depth, collapsed, filtering) {
    const isCollapsed = !filtering && collapsed.has(folder.path);
    const direct = folder.files.length;
    const total = countSubtree(folder);
    // The badge shows what the folder holds in total - a folder that only
    // contains sub-folders would otherwise read "0". The tooltip spells out
    // how many of them sit directly in it.
    const tooltip = direct === total
        ? `${direct} file${direct === 1 ? '' : 's'}`
        : `${direct} file${direct === 1 ? '' : 's'} here, ${total} including sub-folders`;

    let html = `<div class="sql-file-folder${isCollapsed ? ' collapsed' : ''}" data-dir-toggle="${escapeHtml(folder.path)}" style="--depth:${depth}" title="${escapeHtml(folder.path)}">`
        + '<span class="sql-file-folder-name">'
        + `<i class="codicon codicon-chevron-down sql-file-chevron"></i>`
        + `<i class="codicon codicon-folder"></i>`
        + `<span class="sql-file-text">${escapeHtml(folder.name)}</span>`
        + '</span>'
        + `<span class="sql-file-count" title="${escapeHtml(tooltip)}">${total}</span>`
        + '</div>';

    if (isCollapsed) return html;

    const files = folder.files.slice().sort((a, b) => compareNames(a.name, b.name));
    for (const file of files) html += fileRowHtml(file, depth + 1);

    const subFolders = [...folder.folders.values()].sort((a, b) => compareNames(a.name, b.name));
    for (const sub of subFolders) html += folderHtml(sub, depth + 1, collapsed, filtering);

    return html;
}

function fileRowHtml(file, depth) {
    const fullPath = file.path || '';
    return `<div class="sql-file-item" data-file-path="${escapeHtml(fullPath)}" title="${escapeHtml(fullPath)}" style="--depth:${depth}">`
        + '<span class="sql-file-item-name">'
        + '<i class="codicon codicon-file"></i>'
        + `<span class="sql-file-text">${escapeHtml(file.name)}</span>`
        + '</span>'
        + '</div>';
}

// Allow unit tests to require() this file; in the webview `module` is undefined.
const FileTree = {
    buildFileTree,
    countSubtree,
    countFolders,
    filterFiles,
    renderFileTree,
    escapeHtml
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = FileTree;
}
