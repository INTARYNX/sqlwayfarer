'use strict';

// === The header of a module's definition ===
//
// sys.sql_modules keeps the text exactly as it was last submitted, so the same
// procedure reads "CREATE PROCEDURE ..." in one database and "ALTER PROCEDURE
// ..." in another. Telling them apart from the text that matters needs the first
// word of the definition, found the way T-SQL reads it: after whitespace and
// comments (block comments nest), never inside one.

// The index of the first character that is not whitespace or a comment.
function skipTrivia(text, from = 0) {
    let i = from;
    const n = text.length;
    while (i < n) {
        const ch = text[i];
        if (/\s/.test(ch)) { i++; continue; }
        if (ch === '-' && text[i + 1] === '-') {
            const end = text.indexOf('\n', i);
            i = end === -1 ? n : end + 1;
            continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
            let depth = 1;
            i += 2;
            while (i < n && depth > 0) {
                if (text[i] === '/' && text[i + 1] === '*') { depth++; i += 2; }
                else if (text[i] === '*' && text[i + 1] === '/') { depth--; i += 2; }
                else i++;
            }
            continue;
        }
        break;
    }
    return i;
}

function wordAt(text, i) {
    const match = /^[A-Za-z_]+/.exec(text.slice(i, i + 16));
    return match ? match[0] : '';
}

// { start, end, keyword } of the CREATE, ALTER or CREATE OR ALTER that opens
// the definition (start and end delimit it in the text), or null.
function parseHeader(text) {
    if (typeof text !== 'string') return null;
    const start = skipTrivia(text);
    const first = wordAt(text, start).toUpperCase();
    if (first === 'ALTER') return { start, end: start + 5, keyword: 'ALTER' };
    if (first !== 'CREATE') return null;

    let end = start + 6;
    const orAt = skipTrivia(text, end);
    if (wordAt(text, orAt).toUpperCase() === 'OR') {
        const alterAt = skipTrivia(text, orAt + 2);
        if (wordAt(text, alterAt).toUpperCase() === 'ALTER') {
            end = alterAt + 5;
            return { start, end, keyword: 'CREATE OR ALTER' };
        }
    }
    return { start, end, keyword: 'CREATE' };
}

// The text of a definition as it is compared: one kind of line ending, no
// trailing blanks, and CREATE / ALTER / CREATE OR ALTER read as the same word
// (the server keeps the blanks of "CREATE OR ALTER": "CREATE   PROCEDURE").
function normalizeDefinition(text) {
    if (typeof text !== 'string') return null;
    let out = text.replace(/\r\n?/g, '\n');
    const header = parseHeader(out);
    if (header) out = `${out.slice(0, header.start)}CREATE${out.slice(header.end).replace(/^[ \t]+/, ' ')}`;
    return out.replace(/[ \t]+$/gm, '').trim();
}

module.exports = { skipTrivia, parseHeader, normalizeDefinition };
