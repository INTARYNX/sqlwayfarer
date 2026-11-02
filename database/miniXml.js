/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// === A small XML reader ===
//
// Enough for the files a user hands to the extension (registered server
// exports): elements, attributes, text, CDATA. Namespace prefixes are dropped
// from names. Nothing is ever expanded (no DTD, no external entity) or run.

const MAX_CHARS = 5000000;
const MAX_DEPTH = 200;

const NAMED = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

// One pass, so "&#38;amp;" is the text "&amp;" and not "&".
function decode(text) {
    return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|quot|apos|amp));/g, (match, dec, hex, name) => name
        ? NAMED[name]
        : codePoint(match, dec !== undefined ? Number(dec) : parseInt(hex, 16)));
}

function codePoint(match, code) {
    return Number.isInteger(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : match;
}

const localName = name => name.slice(name.indexOf(':') + 1);

function parseAttributes(text) {
    const attributes = {};
    for (const m of text.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attributes[localName(m[1])] = decode(m[2] !== undefined ? m[2] : m[3]);
    }
    return attributes;
}

// The root element: { name, attributes, children: [element], text }.
function parseXml(source) {
    if (typeof source !== 'string' || source.trim() === '') throw new Error('The file is empty.');
    if (source.length > MAX_CHARS) throw new Error('The file is too large.');
    const xml = source.replace(/^﻿/, '');
    const token = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|(<)/g;
    const top = { name: '#document', attributes: {}, children: [], text: '' };
    const stack = [top];
    let match;
    while ((match = token.exec(xml))) {
        const current = stack[stack.length - 1];
        if (match[1] !== undefined) current.text += match[1];
        else if (match[2] !== undefined) {
            if (stack.length === 1 || current.name !== localName(match[2])) throw new Error(`Unexpected </${match[2]}>.`);
            stack.pop();
        } else if (match[3] !== undefined) {
            const element = { name: localName(match[3]), attributes: parseAttributes(match[4] || ''), children: [], text: '' };
            current.children.push(element);
            if (!match[5]) {
                if (stack.length > MAX_DEPTH) throw new Error('The file is nested too deeply.');
                stack.push(element);
            }
        } else if (match[6] !== undefined) current.text += decode(match[6]);
        else if (match[7] !== undefined) throw new Error('Malformed XML.');
    }
    if (stack.length !== 1) throw new Error(`<${stack[stack.length - 1].name}> is never closed.`);
    if (top.children.length === 0) throw new Error('No XML element found.');
    return top.children[0];
}

// The direct children called name (case-insensitive).
function childrenNamed(element, name) {
    const wanted = name.toLowerCase();
    return element.children.filter(child => child.name.toLowerCase() === wanted);
}

// The trimmed text of the first direct child called name; '' when absent.
function childText(element, name) {
    const child = childrenNamed(element, name)[0];
    return child ? child.text.trim() : '';
}

// The trimmed text of the first element called name at any depth below element; '' when absent.
function descendantText(element, name) {
    const wanted = name.toLowerCase();
    for (const child of element.children) {
        if (child.name.toLowerCase() === wanted) return child.text.trim();
        const deeper = descendantText(child, name);
        if (deeper) return deeper;
    }
    return '';
}

module.exports = { parseXml, childrenNamed, childText, descendantText };
