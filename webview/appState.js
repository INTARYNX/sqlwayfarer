/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// The VS Code API of the page (it can be acquired once) and the state the
// managers share. Loaded before every other script of the page.
const vscode = acquireVsCodeApi();

// Global application state
class AppState {
    constructor() {
        this.activeTab = 'query';
        this.activeDetailsTab = 'structure';
        this.isConnected = false;
        this.currentDatabase = null;
        this.selectedObject = null;
        this.currentDependencies = null;
        this.pendingVisualization = null;
        this.allObjects = [];
        this.filteredObjects = [];
        this.databases = []; // every database on the connection, for cross-database autocompletion
        this.foreignKeys = []; // whole-database FK edges, for join-condition autocompletion
        this.currentIndex = null; // Store the raw index data
        this.filters = {
            search: '',
            inCode: false,
            types: {
                Table: true,
                View: true,
                Procedure: true,
                Function: true
            }
        };
        // Set of qualified names (lowercase) matching the "search in code" query;
        // null while no code search is active or results are pending.
        this.definitionMatches = null;
    }
}

const appState = new AppState();
