'use strict';

// Splits a potentially qualified SQL name (e.g. [dbo].[MyTable]) into schema + object parts
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
