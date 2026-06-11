/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

/**
 * Parse a potentially qualified SQL object name into schema + object parts.
 * Handles brackets, multi-part names (db.schema.object), defaults schema to 'dbo'.
 * @param {string} objectName
 * @returns {{ schema: string, objectName: string }}
 */
function parseObjectName(objectName) {
    if (!objectName) return { schema: 'dbo', objectName: '' };
    const clean = objectName.replace(/[\[\]]/g, '');
    const parts = clean.split('.');
    if (parts.length >= 2) {
        return { schema: parts[parts.length - 2] || 'dbo', objectName: parts[parts.length - 1] };
    }
    return { schema: 'dbo', objectName: clean };
}

module.exports = parseObjectName;
