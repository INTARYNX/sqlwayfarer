#!/usr/bin/env node
'use strict';

/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */

// === The files no test loads ===
//
// A test that does not exist cannot find a fault. This script reads the
// coverage the test run produced (NODE_V8_COVERAGE) and lists the source
// files that NO test ever loaded: the blind spots.
//
// The list is compared with test/coverage-baseline.json, which records the
// blind spots that are known and accepted. A file that was covered and stops
// being covered - or a new file that nobody loads - fails the check: the
// blind spot must not grow silently.
//
// Usage: node scripts/coverage-check.js <coverage-directory>

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const coverageDir = process.argv[2];
const baselinePath = path.join(root, 'test', 'coverage-baseline.json');

if (!coverageDir || !fs.existsSync(coverageDir)) {
    console.error(`No coverage directory: ${coverageDir}`);
    process.exit(2);
}

// The source files a test could load.
function sourceFiles() {
    const out = [];
    for (const dir of ['database', 'panels', 'storage']) {
        const walk = current => {
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === 'generated') continue;
                    walk(full);
                } else if (entry.name.endsWith('.js')) {
                    out.push(path.relative(root, full));
                }
            }
        };
        walk(path.join(root, dir));
    }
    out.push('extension.js');
    return out;
}

// Every file the run loaded, whatever the process that loaded it.
function loadedFiles() {
    const loaded = new Set();
    for (const name of fs.readdirSync(coverageDir)) {
        if (!name.endsWith('.json')) continue;
        let data;
        try {
            data = JSON.parse(fs.readFileSync(path.join(coverageDir, name), 'utf8'));
        } catch {
            continue;
        }
        for (const entry of data.result || []) {
            if (entry.url && entry.url.startsWith('file://')) loaded.add(entry.url.slice(7));
        }
    }
    return loaded;
}

const loaded = loadedFiles();
const uncovered = sourceFiles()
    .filter(file => !loaded.has(path.join(root, file)))
    .sort();

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const known = new Set(baseline.uncovered);
const neverLoaded = new Set(baseline.neverLoaded || []);
const unexpected = uncovered.filter(file => !known.has(file));
const gone = baseline.uncovered.filter(file => !uncovered.includes(file));

console.log(`Source files the unit suite loads: ${sourceFiles().length - uncovered.length}`);
console.log(`Source files it does not load: ${uncovered.length}`);
for (const file of uncovered) {
    const mark = neverLoaded.has(file) ? ' (loaded by no test at all)' : ' (loaded by the job that runs VS Code)';
    console.log(`  ${file}${mark}`);
}

if (unexpected.length) {
    console.error(`\nThese files are loaded by no test, and are not in the baseline:`);
    for (const file of unexpected) console.error(`  ${file}`);
    console.error('\nEither write a test that loads them, or add them to test/coverage-baseline.json (with the reason).');
    process.exit(1);
}

if (gone.length) {
    console.log(`\nThese files are now loaded by the unit suite - remove them from the baseline:`);
    for (const file of gone) console.log(`  ${file}`);
}

console.log('\nThe blind spots have not grown.');
