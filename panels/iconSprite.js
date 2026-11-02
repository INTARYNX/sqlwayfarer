'use strict';

const fs = require('fs');
const path = require('path');

// The SVG sprite of SQL Wayfarer's own icons (webview/icons.svg), to be put
// in a webview's page: a <use href="#..."> only reaches symbols of its own
// document.
function readIconSprite(extensionPath) {
    try {
        return fs.readFileSync(path.join(extensionPath, 'webview', 'icons.svg'), 'utf8');
    } catch (error) {
        console.warn('Could not read the icon sprite:', error);
        return '';
    }
}

module.exports = { readIconSprite };
