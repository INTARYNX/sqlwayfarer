#!/usr/bin/env node
'use strict';

// === The libraries the webview loads as they are ===
//
// Viz.js (the Graphviz engine behind the dependency graph) and html-query-plan
// (the execution plans) are plain scripts the page loads with a <script> tag:
// they are not bundled. They come from node_modules - their version is the one
// of package.json - and are copied next to the other scripts of the page, in
// dist/webview/vendor/, at the end of the build.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

// [the file in node_modules, where it goes in dist/webview/vendor/]
const FILES = [
    ['viz.js/viz.js', 'viz.js'],
    ['viz.js/full.render.js', 'viz.full.render.js'],
    ['html-query-plan/dist/qp.min.js', 'html-query-plan/qp.min.js'],
    ['html-query-plan/css/qp.css', 'html-query-plan/qp.css'],
    ['html-query-plan/css/qp_icons.png', 'html-query-plan/qp_icons.png']
];

function copyVendor() {
    const out = path.join(root, 'dist', 'webview', 'vendor');
    for (const [from, to] of FILES) {
        const source = path.join(root, 'node_modules', from);
        if (!fs.existsSync(source)) throw new Error(`${from} is not in node_modules: run npm install`);
        fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
        fs.copyFileSync(source, path.join(out, to));
    }
    return FILES.length;
}

if (require.main === module) {
    console.log(`vendor: ${copyVendor()} files copied to dist/webview/vendor/`);
}

module.exports = { FILES, copyVendor };
