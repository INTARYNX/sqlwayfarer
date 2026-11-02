/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// SQL Wayfarer's own icons (webview/icons.svg, injected in the page): the icon
// font has nothing for a table, a view, a procedure, an index, a key or a plan,
// so those are drawn here. Everything generic (save, copy, arrows, close...)
// stays with the codicons.

function swIcon(name, extraClass = '') {
    return `<svg class="sw-icon${extraClass ? ' ' + extraClass : ''}" viewBox="0 0 16 16" aria-hidden="true"><use href="#sw-${name}"/></svg>`;
}

// The icon of a database object, by the type the extension reports.
function swObjectIcon(objectType, fallback = 'table') {
    switch (objectType) {
        case 'Table': return swIcon('table');
        case 'View': return swIcon('view');
        case 'Procedure': return swIcon('procedure');
        case 'Function': return swIcon('function');
        case 'Trigger': return swIcon('trigger');
        case 'Database': return swIcon('database');
        default: return fallback ? swIcon(fallback) : '<i class="codicon codicon-file"></i>';
    }
}

// Allow unit tests to require() this file; in the webview `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { swIcon, swObjectIcon };
}
