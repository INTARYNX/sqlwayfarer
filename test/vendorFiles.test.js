const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { FILES } = require('../scripts/copy-vendor');

// The scripts the page loads as they are (Viz.js, html-query-plan) come from
// node_modules at the end of the build. What the panel points at has to be what
// the build copies, or the page would load nothing and say nothing.
suite('vendor files', () => {
	const root = path.join(__dirname, '..');

	test('every vendor script the panel loads is one the build copies', () => {
		const provider = fs.readFileSync(path.join(root, 'panels', 'SqlWayfarerPanel.js'), 'utf8');
		const loaded = [...provider.matchAll(/u\('dist', 'webview', 'vendor', ([^)]*)\)/g)]
			.map(m => m[1].split(',').map(part => part.trim().replace(/^'|'$/g, '')).join('/'));
		assert.ok(loaded.length >= 4, 'the panel loads the vendor scripts from dist/webview/vendor');
		const copied = FILES.map(([, to]) => to);
		for (const file of loaded) assert.ok(copied.includes(file), `${file} is loaded by the panel but not copied by scripts/copy-vendor.js`);
	});

	test('every file the build copies exists in node_modules', () => {
		for (const [from] of FILES) assert.ok(fs.existsSync(path.join(root, 'node_modules', from)), `${from} is missing: npm install`);
	});

	test('the libraries are declared in package.json, with an exact version', () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
		for (const name of ['viz.js', 'html-query-plan']) {
			assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.devDependencies[name] || ''), `${name} has an exact version`);
		}
	});

	test('nothing is copied by hand into webview/vendor any more', () => {
		assert.ok(!fs.existsSync(path.join(root, 'webview', 'vendor')));
	});
});
