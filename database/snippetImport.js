/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

const fs = require('fs').promises;
const path = require('path');
const { MAX_FILE_CHARS } = require('./sqlPromptSnippet');

// === Importing snippets from disk ===
//
// Finding the snippet files the user picked (files, or a folder with its
// subfolders), and merging what was read into the snippets already saved.

const EXTENSION = '.sqlpromptsnippet';
const MAX_FILES = 5000;
const MAX_DEPTH = 8;

// paths: files and/or folders. Returns { files: [{ path, text }], skipped: [{ path, reason }], truncated }.
async function collectSnippetFiles(paths, fsApi = fs) {
    const files = [];
    const skipped = [];
    let truncated = false;

    const readFile = async file => {
        if (files.length >= MAX_FILES) { truncated = true; return; }
        try {
            const stat = await fsApi.stat(file);
            if (stat.size > MAX_FILE_CHARS * 4) { skipped.push({ path: file, reason: 'The file is too large to be a snippet.' }); return; }
            files.push({ path: file, text: await fsApi.readFile(file, 'utf8') });
        } catch (error) {
            skipped.push({ path: file, reason: `Cannot be read: ${error.message}` });
        }
    };

    const walk = async (dir, depth) => {
        if (depth > MAX_DEPTH) return;
        let entries;
        try {
            entries = await fsApi.readdir(dir, { withFileTypes: true });
        } catch (error) {
            skipped.push({ path: dir, reason: `Cannot be read: ${error.message}` });
            return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) continue; // never follow a link out of the folder
            if (entry.isDirectory()) await walk(full, depth + 1);
            else if (entry.isFile() && entry.name.toLowerCase().endsWith(EXTENSION)) await readFile(full);
        }
    };

    for (const target of paths) {
        let stat;
        try { stat = await fsApi.stat(target); } catch (error) { skipped.push({ path: target, reason: `Cannot be read: ${error.message}` }); continue; }
        if (stat.isDirectory()) await walk(target, 0);
        else await readFile(target);
    }
    return { files, skipped, truncated };
}

// A parsed snippet in the shape the extension stores.
function toStoredSnippet(parsed, now = Date.now()) {
    const stored = { name: parsed.name, sql: parsed.sql, createdAt: now, source: 'SQL Prompt' };
    if (parsed.abbreviation) stored.abbreviation = parsed.abbreviation;
    if (parsed.description) stored.description = parsed.description;
    if (parsed.placeholders && parsed.placeholders.length) stored.placeholders = parsed.placeholders;
    return stored;
}

// Two imported snippets with the same name must not erase each other: the
// later ones get " (2)", " (3)"... A name a built-in snippet already has counts
// as taken. Each result keeps the name it came with in `base`.
function uniqueNames(imported, reserved = []) {
    const seen = new Map();
    for (const name of reserved) seen.set(name, 1);
    return imported.map(snippet => {
        const count = (seen.get(snippet.name) || 0) + 1;
        seen.set(snippet.name, count);
        return { snippet: count === 1 ? snippet : Object.assign({}, snippet, { name: `${snippet.name} (${count})` }), base: snippet.name, count };
    });
}

// Which imported snippets are new, and which would replace one that exists.
// The twins of a name that exists are duplicates too (they never replace it).
function planImport(existing, imported, reserved = []) {
    const names = new Set(existing.map(s => s.name));
    const fresh = [];
    const duplicates = [];
    for (const { snippet, base, count } of uniqueNames(imported, reserved)) {
        if (names.has(snippet.name) || (count > 1 && names.has(base))) duplicates.push(snippet);
        else fresh.push(snippet);
    }
    return { fresh, duplicates };
}

// The saved snippets after the import. A duplicate either replaces the
// existing snippet (overwrite) or is left out.
function mergeSnippets(existing, imported, overwrite, reserved = []) {
    const plan = planImport(existing, imported, reserved);
    const names = new Set(existing.map(s => s.name));
    let snippets = existing.slice();
    let overwritten = 0;
    if (overwrite) {
        const replacements = new Map(plan.duplicates.filter(s => names.has(s.name)).map(s => [s.name, s]));
        snippets = snippets.map(s => replacements.has(s.name) ? replacements.get(s.name) : s);
        overwritten = replacements.size;
    }
    snippets.push(...plan.fresh);
    snippets.sort((a, b) => a.name.localeCompare(b.name));
    return { snippets, added: plan.fresh.length, overwritten, leftOut: plan.duplicates.length - overwritten };
}

module.exports = { collectSnippetFiles, toStoredSnippet, planImport, mergeSnippets, uniqueNames, EXTENSION };
