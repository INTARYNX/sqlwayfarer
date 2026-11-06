const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { generate, build, EXTENSION_ROOTS, PAGE_ROOTS, OUTPUT } = require('../scripts/generate-notices');

// The licenses of what is shipped ask for their notice to travel with it
// (scripts/generate-notices.js). A dependency that changes without
// THIRD_PARTY_NOTICES.md following does not pass.
suite('third-party notices', () => {
	const root = path.join(__dirname, '..');

	test('THIRD_PARTY_NOTICES.md is up to date: run `npm run notices`', () => {
		// A checkout on Windows may turn the line ends into CRLF.
		const current = fs.readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n');
		assert.ok(current === generate(), 'THIRD_PARTY_NOTICES.md is out of date: run `npm run notices`');
	});

	test('every root the notices start from is a dependency of the project', () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
		const declared = { ...pkg.dependencies, ...pkg.devDependencies };
		for (const name of [...EXTENSION_ROOTS, ...PAGE_ROOTS]) assert.ok(declared[name], `${name} is not in package.json`);
	});

	test('what the project depends on at run time is in the notices', () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
		for (const name of Object.keys(pkg.dependencies)) assert.ok(EXTENSION_ROOTS.includes(name), `${name} is a runtime dependency that the notices do not start from`);
	});

	test('every package has a license text, or says it has none', () => {
		const { packages } = build();
		assert.ok(packages.length > 50);
		const unknown = packages.filter(p => p.license === 'unknown').map(p => p.name);
		assert.deepStrictEqual(unknown, [], 'a package without a declared license');
		const text = fs.readFileSync(OUTPUT, 'utf8');
		assert.ok(text.includes('### antlr4 ') && text.includes('Copyright (c) 2012-2022 The ANTLR Project'), 'the ANTLR license text is in');
	});

	test('the grammar, Graphviz and the icons are credited, with the licenses texts they need', () => {
		const text = fs.readFileSync(OUTPUT, 'utf8');
		for (const needle of ['Mark Adams', 'Amazon.com', 'Apache License', 'Graphviz', 'Eclipse Public License', 'Microsoft Corporation, Creative Commons Attribution 4.0']) {
			assert.ok(text.includes(needle), `${needle} is not in THIRD_PARTY_NOTICES.md`);
		}
	});
});
