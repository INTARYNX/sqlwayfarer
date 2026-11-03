/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// === Reading SQL Prompt snippet files (.sqlpromptsnippet) ===
//
// One XML file holds one or more <CodeSnippet>: a header (title, shortcut,
// description, author, types), the placeholders it declares (<Literal> with an
// ID, a tooltip and a default value) and the code in a CDATA section, where
// $ID$ marks a placeholder, $CURSOR$ the caret and $SELECTEDTEXT$ the
// selection. The structure is small and regular, so it is read here directly
// instead of pulling an XML library in; nothing in the file is ever executed.

const MAX_FILE_CHARS = 1000000;

// A numeric reference outside Unicode stays as it is instead of throwing.
function fromCode(match, code) {
    return Number.isInteger(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : match;
}

const NAMED_ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

// One pass, so "&#38;amp;" is the text "&amp;" and not "&".
function decodeEntities(text) {
    return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|quot|apos|amp));/g, (match, dec, hex, name) => name
        ? NAMED_ENTITIES[name]
        : fromCode(match, dec !== undefined ? Number(dec) : parseInt(hex, 16)));
}

// The text of an element's content: CDATA sections as they are, the rest with its entities decoded.
function contentText(raw) {
    let out = '';
    let rest = raw;
    for (;;) {
        const start = rest.indexOf('<![CDATA[');
        if (start === -1) { out += decodeEntities(rest); break; }
        out += decodeEntities(rest.slice(0, start));
        const end = rest.indexOf(']]>', start + 9);
        if (end === -1) { out += rest.slice(start + 9); break; }
        out += rest.slice(start + 9, end);
        rest = rest.slice(end + 3);
    }
    return out;
}

// === Finding elements without backtracking ===
//
// A file is read by whoever hands it over, up to MAX_FILE_CHARS: a pattern that
// looks for "<tag> ... </tag>" lazily goes through the rest of the text for
// every <tag> that is never closed, and a file made of such tags takes minutes.
// Here an element is an opening tag, then the first closing tag after it (found
// with indexOf); when there is none, no later element of that name has one.

// The elements named `tag` in xml, in order: { inner, selfClosing }. An opening
// tag that is never closed ends the search.
function elementsNamed(xml, tag, { first = false } = {}) {
    const out = [];
    const open = new RegExp(`<${tag}(?:\\s[^>]*?)?(/?)>`, 'g');
    const closing = `</${tag}>`;
    let match;
    while ((match = open.exec(xml))) {
        if (match[1] === '/') {
            out.push({ inner: '', selfClosing: true });
        } else {
            const end = xml.indexOf(closing, open.lastIndex);
            if (end === -1) break;
            out.push({ inner: xml.slice(open.lastIndex, end), selfClosing: false });
            open.lastIndex = end + closing.length;
        }
        if (first) break;
    }
    return out;
}

// The content of the first <tag ...>...</tag> in xml; '' for <tag /> or when absent.
function elementText(xml, tag) {
    const [element] = elementsNamed(xml, tag, { first: true });
    return element && !element.selfClosing ? contentText(element.inner) : '';
}

function allElements(xml, tag) {
    return elementsNamed(xml, tag).filter(element => !element.selfClosing).map(element => element.inner);
}

// The code of a snippet: <Code ...>CDATA</Code>. Line endings are normalized.
function codeOf(snippetXml) {
    const [element] = elementsNamed(snippetXml, 'Code', { first: true });
    return element && !element.selfClosing ? contentText(element.inner).replace(/\r\n?/g, '\n') : null;
}

function placeholdersOf(snippetXml) {
    const [declarations] = elementsNamed(snippetXml, 'Declarations', { first: true });
    if (!declarations || declarations.selfClosing) return [];
    const out = [];
    // Literal is what the format uses; any other kind of declaration that
    // carries an ID is kept the same way (its default is just text). Walks the
    // opening tags: the first element with an <ID> inside is one declaration.
    const body = declarations.inner;
    const open = /<(\w+)(?:\s[^>]*?)?>/g;
    const unclosed = new Set();
    let match;
    while ((match = open.exec(body))) {
        const tag = match[1];
        if (match[0].endsWith('/>') || unclosed.has(tag)) continue;
        const closing = `</${tag}>`;
        const end = body.indexOf(closing, open.lastIndex);
        if (end === -1) { unclosed.add(tag); continue; }
        const inner = body.slice(open.lastIndex, end);
        const id = elementText(inner, 'ID').trim();
        if (!id) continue;
        out.push({ id, tooltip: elementText(inner, 'ToolTip').trim(), default: elementText(inner, 'Default') });
        open.lastIndex = end + closing.length;
    }
    return out;
}

// Reads one file: { snippets: [...], errors: [message] }. A snippet is
// { name, abbreviation, description, author, sql, placeholders: [{ id, tooltip, default }], types }.
function parseSqlPromptSnippetFile(text) {
    const result = { snippets: [], errors: [] };
    if (typeof text !== 'string' || text.trim() === '') {
        result.errors.push('The file is empty.');
        return result;
    }
    if (text.length > MAX_FILE_CHARS) {
        result.errors.push('The file is too large to be a snippet.');
        return result;
    }
    const xml = text.replace(/^﻿/, '');
    const blocks = allElements(xml, 'CodeSnippet');
    if (blocks.length === 0) {
        result.errors.push('No <CodeSnippet> in the file: it is not a SQL Prompt snippet.');
        return result;
    }
    blocks.forEach((block, index) => {
        const label = blocks.length > 1 ? ` (snippet ${index + 1})` : '';
        const sql = codeOf(block);
        const title = elementText(block, 'Title').trim();
        const shortcut = elementText(block, 'Shortcut').trim();
        if (sql === null || sql.trim() === '') {
            result.errors.push(`No code${label}.`);
            return;
        }
        if (!title && !shortcut) {
            result.errors.push(`No title and no shortcut${label}.`);
            return;
        }
        result.snippets.push({
            name: title || shortcut,
            abbreviation: shortcut,
            description: elementText(block, 'Description').trim(),
            author: elementText(block, 'Author').trim(),
            sql,
            placeholders: placeholdersOf(block),
            types: allElements(block, 'SnippetType').map(t => contentText(t).trim()).filter(Boolean)
        });
    });
    return result;
}

// Several files at once: files is [{ path, text }]. The snippets of all the
// readable ones, and for each unreadable one why.
function parseSqlPromptSnippetFiles(files) {
    const snippets = [];
    const skipped = [];
    for (const file of files) {
        let parsed;
        try { parsed = parseSqlPromptSnippetFile(file.text); } catch (error) { parsed = { snippets: [], errors: [`Cannot be read: ${error.message}`] }; }
        for (const snippet of parsed.snippets) snippets.push(Object.assign({ source: file.path }, snippet));
        for (const error of parsed.errors) skipped.push({ path: file.path, reason: error });
    }
    return { snippets, skipped };
}

module.exports = { parseSqlPromptSnippetFile, parseSqlPromptSnippetFiles, MAX_FILE_CHARS };
