/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Bootstrap for the activity bar sidebar's snippet manager (see
// panels/SnippetSidebarProvider.js) - much smaller than webview/main.js since
// this view hosts only SnippetManager, not the full SQL Wayfarer panel.
const vscode = acquireVsCodeApi();

document.addEventListener('DOMContentLoaded', () => {
    const snippetManager = new SnippetManager();

    // The one clear "open a tab" affordance now that this view's main
    // content is the snippet list, not a launcher item - without it, opening
    // the very first tab means digging for the small title-bar icon or the
    // command palette.
    document.getElementById('openPanelBtn').addEventListener('click', () => {
        vscode.postMessage({ command: 'openNewPanel' });
    });

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.command === 'snippetsLoaded') {
            snippetManager.onSnippetsLoaded(message.snippets);
        }
    });
});
