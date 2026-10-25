'use strict';

// Splits a potentially qualified SQL name (e.g. [dbo].[MyTable], or a raw
// unbracketed "schema.object") into schema + object parts.
//
// Every caller feeds this a 2-part "schema.object" name (built by
// DatabaseService's own queries as `s.name + '.' + o.name`, or typed by the
// user without a database prefix) - never a genuine 3-part
// database.schema.object reference. So only the FIRST dot outside brackets
// is treated as the schema/object separator: an object name that itself
// contains further dots (e.g. "dbo.my.table", a table literally named
// "my.table") is preserved whole as the object name, not torn in two.
// Brackets are only stripped where they actually delimit a segment -
// a lone ']' with no matching '[' (part of a legitimate object name) is
// left alone instead of being silently deleted; ']]' inside brackets is
// unescaped to a literal ']', per SQL Server's own identifier-quoting rule.
function parseObjectName(objectName) {
    if (!objectName) return { schema: 'dbo', objectName: '' };

    const segments = [];
    let current = '';
    let i = 0;
    const n = objectName.length;

    while (i < n) {
        if (objectName[i] === '[') {
            let j = i + 1;
            let content = '';
            while (j < n) {
                if (objectName[j] === ']') {
                    if (objectName[j + 1] === ']') { content += ']'; j += 2; continue; }
                    j += 1;
                    break;
                }
                content += objectName[j];
                j++;
            }
            current += content;
            i = j;
            continue;
        }
        if (objectName[i] === '.') {
            segments.push(current);
            current = '';
            i++;
            continue;
        }
        current += objectName[i];
        i++;
    }
    segments.push(current);

    if (segments.length === 1) return { schema: 'dbo', objectName: segments[0] };
    return { schema: segments[0] || 'dbo', objectName: segments.slice(1).join('.') };
}

module.exports = parseObjectName;
