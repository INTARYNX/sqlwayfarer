'use strict';

const fs = require('fs');
const path = require('path');

// mtime of the bundle actually loaded (dist/extension.js) - makes it possible
// to check that the last build is really the one under test, and not a session
// left running on the previous code.
function getBuildTime(extensionPath) {
    try {
        return fs.statSync(path.join(extensionPath, 'dist', 'extension.js')).mtime.toLocaleString();
    } catch (error) {
        console.warn('Could not read build time:', error);
        return 'unknown';
    }
}

module.exports = { getBuildTime };
