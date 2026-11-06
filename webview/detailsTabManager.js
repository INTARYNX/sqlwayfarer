/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Details Tab Manager
class DetailsTabManager {
    constructor() {
        this.initEventListeners();
    }

    initEventListeners() {
        const detailsTabButtons = document.querySelectorAll('.details-tab-button');
        detailsTabButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                const tabName = e.target.dataset.detailsTab;
                this.switchDetailsTab(tabName);
            });
        });
    }

    switchDetailsTab(tabName) {
        appState.activeDetailsTab = tabName;

        // Update button states
        document.querySelectorAll('.details-tab-button').forEach(button => {
            button.classList.toggle('active', button.dataset.detailsTab === tabName);
        });

        // Update tab content
        document.querySelectorAll('.details-tab-content').forEach(content => {
            content.classList.toggle('active', content.id === `${tabName}DetailsTab`);
        });

        // Load content for the active tab if needed
        if (appState.selectedObject && appState.currentDatabase) {
            const objectNameForBackend = window.explorerManager._getQualifiedName(appState.selectedObject);

            switch (tabName) {
                case 'comments':
                    window.commentsManager.loadCommentsForObject(
                        appState.currentDatabase,
                        appState.selectedObject.name,
                        appState.selectedObject.object_type
                    );
                    break;

                case 'code':
                    window.codeViewManager.loadCodeForObject(
                        appState.currentDatabase,
                        objectNameForBackend,
                        appState.selectedObject.object_type,
                        appState.selectedObject.definition
                    );
                    break;

                case 'tree':
                    vscode.postMessage({
                        command: 'getDependencyTree',
                        database: appState.currentDatabase,
                        objectName: objectNameForBackend,
                        maxDepth: 3
                    });
                    break;

                case 'graph':
                    // NEW: Load dependency graph
                    vscode.postMessage({
                        command: 'getObjectDetails',
                        database: appState.currentDatabase,
                        objectName: objectNameForBackend,
                        objectType: appState.selectedObject.object_type
                    });
                    break;
            }
        }
    }
}
