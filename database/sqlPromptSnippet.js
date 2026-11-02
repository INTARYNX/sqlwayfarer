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

// The content of the first <tag ...>...</tag> in xml; '' for <tag /> or when absent.
function elementText(xml, tag) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${tag}>)`);
    const match = re.exec(xml);
    return match && match[1] !== undefined ? contentText(match[1]) : '';
}

function allElements(xml, tag) {
    const out = [];
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
    let match;
    while ((match = re.exec(xml))) out.push(match[1]);
    return out;
}

// The code of a snippet: <Code ...>CDATA</Code>. Line endings are normalized.
function codeOf(snippetXml) {
    const match = /<Code(?:\s[^>]*)?>([\s\S]*?)<\/Code>/.exec(snippetXml);
    return match ? contentText(match[1]).replace(/\r\n?/g, '\n') : null;
}

function placeholdersOf(snippetXml) {
    const declarations = /<Declarations(?:\s[^>]*)?>([\s\S]*?)<\/Declarations>/.exec(snippetXml);
    if (!declarations) return [];
    const out = [];
    // Literal is what the format uses; any other kind of declaration that
    // carries an ID is kept the same way (its default is just text).
    const re = /<(\w+)(?:\s[^>]*)?>((?:(?!<\/\1>)[\s\S])*?<ID>[\s\S]*?)<\/\1>/g;
    let match;
    while ((match = re.exec(declarations[1]))) {
        const id = elementText(match[2], 'ID').trim();
        if (!id) continue;
        out.push({ id, tooltip: elementText(match[2], 'ToolTip').trim(), default: elementText(match[2], 'Default') });
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
