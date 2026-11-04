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
// The opening tags are found by a linear scan too: a regular expression would
// walk the rest of the text for every tag that is never closed.

// The opening tag at or after `pos` in xml: { name, start, end, selfClosing },
// or null when there is none. The name is the word characters right after the
// "<", and the tag ends at the first ">".
function nextOpeningTag(xml, pos) {
    while (pos < xml.length) {
        const start = xml.indexOf('<', pos);
        if (start === -1) return null;
        let i = start + 1;
        while (i < xml.length && /\w/.test(xml[i])) i++;
        // Not the name of a tag: "<", "</", "<3".
        if (i === start + 1) { pos = start + 1; continue; }
        const name = xml.slice(start + 1, i);
        // The name must be followed by the end of the tag, a slash or a space:
        // "<Taggy>" is not a "<Tag>".
        const after = xml[i];
        if (after !== '>' && after !== '/' && !(after && /\s/.test(after))) { pos = start + 1; continue; }
        const end = xml.indexOf('>', i);
        // An opening tag that is never closed ends the scan.
        if (end === -1) return null;
        return { name, start, end, selfClosing: xml[end - 1] === '/' };
    }
    return null;
}

// The elements named `tag` in xml, in order: { inner, selfClosing }. An opening
// tag that is never closed ends the search.
function elementsNamed(xml, tag, { first = false } = {}) {
    const out = [];
    const closing = `</${tag}>`;
    const open = `<${tag}`;
    let pos = 0;
    while (pos < xml.length) {
        const start = xml.indexOf(open, pos);
        if (start === -1) break;
        const after = start + open.length;
        const next = xml[after];
        let contentStart;
        let selfClosing;
        if (next === '>') {
            contentStart = after + 1;
            selfClosing = false;
        } else if (next === '/') {
            // "<tag/ >" is not a tag.
            if (xml[after + 1] !== '>') { pos = start + 1; continue; }
            contentStart = after + 2;
            selfClosing = true;
        } else if (next !== undefined && /\s/.test(next)) {
            const end = xml.indexOf('>', after);
            if (end === -1) break;
            selfClosing = xml[end - 1] === '/';
            contentStart = end + 1;
        } else {
            // "<taggy>" is not a "<tag>".
            pos = start + 1;
            continue;
        }
        if (selfClosing) {
            out.push({ inner: '', selfClosing: true });
            pos = contentStart;
        } else {
            const end = xml.indexOf(closing, contentStart);
            if (end === -1) break;
            out.push({ inner: xml.slice(contentStart, end), selfClosing: false });
            pos = end + closing.length;
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
    const unclosed = new Set();
    let pos = 0;
    for (;;) {
        const tag = nextOpeningTag(body, pos);
        if (!tag) break;
        pos = tag.end + 1;
        if (tag.selfClosing || unclosed.has(tag.name)) continue;
        const closing = `</${tag.name}>`;
        const end = body.indexOf(closing, pos);
        if (end === -1) { unclosed.add(tag.name); continue; }
        const inner = body.slice(pos, end);
        const id = elementText(inner, 'ID').trim();
        if (!id) continue;
        out.push({ id, tooltip: elementText(inner, 'ToolTip').trim(), default: elementText(inner, 'Default') });
        pos = end + closing.length;
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
