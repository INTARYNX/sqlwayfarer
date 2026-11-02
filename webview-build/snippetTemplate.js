/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// === From a snippet to an editor template ===
//
// A snippet's code marks its placeholders the SQL Prompt way: $Name$ for a
// declared placeholder (with a default value), $CURSOR$ for where the caret
// ends up, $SELECTEDTEXT$ for the text that was selected when it was
// inserted. This turns it into the template syntax of CodeMirror's snippet():
// ${1:default} fields to Tab through (the same placeholder used twice is one
// linked field), ${0} for the final caret position.

const SELECTION_MARKERS = new Set(['SELECTIONSTART', 'SELECTIONEND']);

// A literal brace would be read as the start of a field.
const escapeLiteral = text => text.replace(/[{}]/g, brace => '\\' + brace);

// placeholders: [{ id, default }]. Returns { template, fields, usesSelection }.
function toTemplate(sql, placeholders = [], selectedText = '') {
    const declared = new Map();
    for (const placeholder of placeholders || []) {
        if (placeholder && placeholder.id) declared.set(String(placeholder.id).toLowerCase(), placeholder);
    }
    const numbers = new Map(); // lower id -> field number
    let fields = 0;
    let cursorPlaced = false;
    let usesSelection = false;
    let template = '';
    let last = 0;
    const re = /\$(\w+)\$/g;
    let match;
    while ((match = re.exec(sql))) {
        const name = match[1];
        const upper = name.toUpperCase();
        let replacement = null;
        if (upper === 'CURSOR') {
            replacement = cursorPlaced ? '' : '${0}';
            cursorPlaced = true;
        } else if (upper === 'SELECTEDTEXT') {
            usesSelection = true;
            replacement = escapeLiteral(selectedText);
        } else if (SELECTION_MARKERS.has(upper)) {
            replacement = '';
        } else if (declared.has(name.toLowerCase())) {
            const key = name.toLowerCase();
            if (numbers.has(key)) {
                replacement = '${' + numbers.get(key) + '}';
            } else {
                numbers.set(key, ++fields);
                const def = String(declared.get(key).default || '').split(/\r?\n/)[0];
                replacement = def ? '${' + fields + ':' + escapeLiteral(def) + '}' : '${' + fields + '}';
            }
        }
        if (replacement === null) continue; // not a placeholder: stays in the text
        template += escapeLiteral(sql.slice(last, match.index)) + replacement;
        last = match.index + match[0].length;
    }
    template += escapeLiteral(sql.slice(last));
    return { template, fields, usesSelection };
}

module.exports = { toTemplate };
