const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { swIcon, swObjectIcon } = require('../webview/icons');

const webview = path.join(__dirname, '..', 'webview');
const sprite = fs.readFileSync(path.join(webview, 'icons.svg'), 'utf8');
const defined = new Set([...sprite.matchAll(/<symbol id="sw-([a-z-]+)"/g)].map(m => m[1]));

suite('icons', () => {
	test('swIcon points at the sprite symbol', () => {
		assert.ok(swIcon('table').includes('href="#sw-table"'));
		assert.ok(swIcon('table', 'big').includes('class="sw-icon big"'));
	});

	test('every kind of database object has its own icon', () => {
		const icons = ['Table', 'View', 'Procedure', 'Function', 'Trigger'].map(t => swObjectIcon(t));
		assert.strictEqual(new Set(icons).size, 5);
	});

	test('an unknown object type falls back to a generic icon, never to nothing', () => {
		assert.ok(swObjectIcon('Whatever').length > 0);
		assert.ok(swObjectIcon('Whatever', null).includes('codicon'));
	});

	test('every icon used in the webview exists in the sprite', () => {
		const used = new Set();
		for (const file of fs.readdirSync(webview).filter(f => /\.(js|html)$/.test(f))) {
			const source = fs.readFileSync(path.join(webview, file), 'utf8');
			for (const m of source.matchAll(/swIcon\('([a-z-]+)'/g)) used.add(m[1]);
			for (const m of source.matchAll(/href="#sw-([a-z-]+)"/g)) used.add(m[1]);
		}
		// swObjectIcon builds its names from the object type
		['table', 'view', 'procedure', 'function', 'trigger', 'database'].forEach(n => used.add(n));
		assert.ok(used.size > 5);
		for (const name of used) assert.ok(defined.has(name), `icon "${name}" is used but not drawn in icons.svg`);
	});

	test('every drawn icon is used somewhere', () => {
		const all = fs.readdirSync(webview).filter(f => /\.(js|html)$/.test(f))
			.map(f => fs.readFileSync(path.join(webview, f), 'utf8')).join('\n');
		for (const name of defined) {
			assert.ok(all.includes(`swIcon('${name}'`) || all.includes(`#sw-${name}`) || ['table', 'view', 'procedure', 'function', 'trigger', 'database'].includes(name),
				`icon "${name}" is drawn but never used`);
		}
	});
});
