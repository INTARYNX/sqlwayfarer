#!/usr/bin/env node
'use strict';

// === THIRD_PARTY_NOTICES.md ===
//
// What SQL Wayfarer ships that is not its own, with the license of each part.
// The licenses ask for the copyright notice and the text of the license to
// travel with what is distributed (MIT, BSD-3, Apache-2.0, CC-BY-4.0): this
// file is the place for them in the .vsix. It is written from node_modules -
// the exact versions that are built - and from a few entries made by hand for
// what node_modules does not hold (the T-SQL grammar, Graphviz).
//
//   node scripts/generate-notices.js           writes THIRD_PARTY_NOTICES.md
//   node scripts/generate-notices.js --check   fails when the file is out of date
//
// test/thirdPartyNotices.test.js runs the check: a dependency that changes
// without the notices following does not pass.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const OUTPUT = path.join(root, 'THIRD_PARTY_NOTICES.md');

// What each part of the package gets from npm. The extension host bundle holds
// the runtime dependencies (piscina is shipped as a folder next to it); the
// page holds the editor, the formatter, the graph libraries and the icons.
const EXTENSION_ROOTS = ['antlr4', 'mssql', 'piscina', 'yazl'];
const PAGE_ROOTS = [
    '@codemirror/autocomplete', '@codemirror/commands', '@codemirror/lang-sql', '@codemirror/language',
    '@codemirror/lint', '@codemirror/search', '@codemirror/state', '@codemirror/view', '@lezer/highlight',
    'sql-formatter', 'cytoscape', 'cytoscape-dagre', 'viz.js', 'html-query-plan', '@vscode/codicons'
];
// Their own code is in the bundles (a few helper functions of the runtime), their dependencies are not.
const ALONE = ['webpack'];

// The package folder of `name` as node resolves it from `from`.
function locate(name, from) {
    for (let dir = from; ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, 'node_modules', name);
        if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
        if (dir === path.dirname(dir)) return null;
    }
}

function readPackage(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

// Every package reachable from the roots through `dependencies`. The optional
// ones are left out: they are native builds that depend on the machine, and the
// notices must be the same wherever they are generated.
function closure(rootNames, part, found) {
    const queue = rootNames.map(name => ({ name, from: root }));
    while (queue.length) {
        const { name, from } = queue.shift();
        const dir = locate(name, from);
        if (!dir) continue;
        const entry = found.get(dir) || { parts: new Set() };
        const known = entry.parts.has(part);
        entry.parts.add(part);
        found.set(dir, entry);
        if (known) continue;
        const pkg = readPackage(dir);
        for (const dependency of Object.keys(pkg.dependencies || {})) {
            queue.push({ name: dependency, from: dir });
        }
    }
}

function licenseOf(pkg) {
    if (typeof pkg.license === 'string') return pkg.license;
    if (pkg.license && pkg.license.type) return pkg.license.type;
    if (Array.isArray(pkg.licenses)) return pkg.licenses.map(l => l.type || l).join(' OR ');
    return 'unknown';
}

// A package that is published without its license file: the text of its
// project, kept in scripts/licenses/ (the ANTLR runtime does not carry it).
const FALLBACK_LICENSES = { antlr4: 'antlr4.txt' };

// The license and notice files at the root of a package.
function licenseFiles(dir, name) {
    const own = fs.readdirSync(dir)
        .filter(file => /^(licen[sc]e|copying|notice)(\.|-|$)/i.test(file) && fs.statSync(path.join(dir, file)).isFile())
        .sort()
        .map(file => ({ file, text: fs.readFileSync(path.join(dir, file), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim() }));
    if (own.length === 0 && FALLBACK_LICENSES[name]) {
        const text = fs.readFileSync(path.join(__dirname, 'licenses', FALLBACK_LICENSES[name]), 'utf8').replace(/\r\n/g, '\n').trim();
        return [{ file: 'LICENSE.txt (of the project: the package has none)', text }];
    }
    return own;
}

function build() {
    const found = new Map();
    closure(EXTENSION_ROOTS, 'extension', found);
    closure(PAGE_ROOTS, 'page', found);
    for (const name of ALONE) {
        const dir = locate(name, root);
        if (dir) found.set(dir, { parts: new Set(['build runtime']) });
    }

    const packages = [...found.entries()].map(([dir, entry]) => {
        const pkg = readPackage(dir);
        return { name: pkg.name, version: pkg.version, license: licenseOf(pkg), parts: [...entry.parts].sort(), files: licenseFiles(dir, pkg.name), home: (pkg.repository && (pkg.repository.url || pkg.repository)) || pkg.homepage || '' };
    }).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

    const apache = fs.readFileSync(path.join(__dirname, 'licenses', 'Apache-2.0.txt'), 'utf8').replace(/\r\n/g, '\n').trim();
    const clean = url => String(url).replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://');

    const out = [];
    out.push('# Third-party notices');
    out.push('');
    out.push('SQL Wayfarer is MIT licensed (see `LICENSE`). It ships the third-party software below, each under its own license. The notices are kept here as those licenses ask.');
    out.push('');
    out.push('This file is generated by `scripts/generate-notices.js` from the versions that are built. Do not edit it by hand.');
    out.push('');
    out.push('## Not from npm');
    out.push('');
    out.push('### The T-SQL grammar, and the parser generated from it');
    out.push('');
    out.push('`database/generated/` is the output of ANTLR 4 (BSD-3, see `antlr4` below) on the T-SQL grammar of [Babelfish for PostgreSQL](https://github.com/babelfish-for-postgresql/babelfish_extensions), which is derived from the T-SQL grammar of [antlr/grammars-v4](https://github.com/antlr/grammars-v4).');
    out.push('');
    out.push('- The original grammar is MIT: Copyright (c) 2017, Mark Adams (madams51703@gmail.com); Copyright (c) 2015-2017, Ivan Kochurkin (kvanttt@gmail.com), Positive Technologies; Copyright (c) 2016, Scott Ure (scott@redstormsoftware.com); Copyright (c) 2016, Rui Zhang (ruizhang.ccs@gmail.com); Copyright (c) 2016, Marcus Henriksson (kuseman80@gmail.com). The text of the MIT license is at the end of this file.');
    out.push('- The additions of Babelfish are Apache-2.0: Copyright Amazon.com, Inc. or its affiliates. The text of the Apache License 2.0 is at the end of this file. The grammar was modified in this project (see `database/tsql-grammar/README.md`).');
    out.push('');
    out.push('### Viz.js, and what it holds');
    out.push('');
    out.push('`viz.js` (listed below, MIT) is Graphviz 2.40.1, Expat 2.2.5 and zlib compiled to JavaScript with Emscripten 1.37.36:');
    out.push('');
    out.push('- Graphviz: Eclipse Public License 1.0, <https://www.eclipse.org/legal/epl-v10.html>. The source of Graphviz is at <https://gitlab.com/graphviz/graphviz>. It is used unmodified.');
    out.push('- Expat (<https://libexpat.github.io>): the MIT license. zlib (<https://zlib.net>): the zlib license. Emscripten (<https://emscripten.org>): the MIT license. Their copyrights are those of their authors.');
    out.push('');
    out.push('### Icons');
    out.push('');
    out.push('The icon font of the page (`webview/codicons/codicon.ttf`) is the Codicons of Microsoft: Copyright (c) Microsoft Corporation, Creative Commons Attribution 4.0 International (<https://creativecommons.org/licenses/by/4.0/>), from <https://github.com/microsoft/vscode-codicons>. Its code (the CSS) is MIT. Both texts are under `@vscode/codicons` below. The font is used unmodified.');
    out.push('');
    out.push('## Packages');
    out.push('');
    out.push('| Package | Version | License | Part of |');
    out.push('|---|---|---|---|');
    for (const p of packages) out.push(`| ${p.name} | ${p.version} | ${p.license} | ${p.parts.join(', ')} |`);
    out.push('');
    out.push('## License texts');
    for (const p of packages) {
        out.push('');
        out.push(`### ${p.name} ${p.version}`);
        out.push('');
        out.push(`License: ${p.license}${p.home ? ` - ${clean(p.home)}` : ''}`);
        if (p.files.length === 0) {
            out.push('');
            out.push('The package carries no license file; the license it declares is the one above.');
        }
        for (const f of p.files) {
            out.push('');
            out.push(`\`${f.file}\``);
            out.push('');
            out.push('```text');
            out.push(f.text);
            out.push('```');
        }
    }
    out.push('');
    out.push('## The MIT license of the T-SQL grammar');
    out.push('');
    out.push('```text');
    out.push('Permission is hereby granted, free of charge, to any person obtaining a copy');
    out.push('of this software and associated documentation files (the "Software"), to deal');
    out.push('in the Software without restriction, including without limitation the rights');
    out.push('to use, copy, modify, merge, publish, distribute, sublicense, and/or sell');
    out.push('copies of the Software, and to permit persons to whom the Software is');
    out.push('furnished to do so, subject to the following conditions:');
    out.push('');
    out.push('The above copyright notice and this permission notice shall be included in');
    out.push('all copies or substantial portions of the Software.');
    out.push('');
    out.push('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR');
    out.push('IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,');
    out.push('FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE');
    out.push('AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER');
    out.push('LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,');
    out.push('OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN');
    out.push('THE SOFTWARE.');
    out.push('```');
    out.push('');
    out.push('## The Apache License 2.0');
    out.push('');
    out.push('```text');
    out.push(apache);
    out.push('```');
    out.push('');
    return { text: out.join('\n'), packages };
}

function generate() {
    return build().text;
}

if (require.main === module) {
    const text = generate();
    if (process.argv.includes('--check')) {
        const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n') : '';
        if (current !== text) {
            console.error('THIRD_PARTY_NOTICES.md is out of date: run `npm run notices`.');
            process.exit(1);
        }
        console.log('THIRD_PARTY_NOTICES.md is up to date.');
    } else {
        fs.writeFileSync(OUTPUT, text);
        console.log(`THIRD_PARTY_NOTICES.md: ${build().packages.length} packages, ${Math.round(text.length / 1024)} KB`);
    }
}

module.exports = { generate, build, EXTENSION_ROOTS, PAGE_ROOTS, OUTPUT };
