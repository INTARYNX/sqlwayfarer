const assert = require('assert');
const FootprintManager = require('../webview/footprintManager');

// The footprint tells the user when an object could not be parsed cleanly:
// its analysis is partial, so its footprint may be missing tables and
// triggers. The warning must not be silently swallowed.
//
// The renderer only needs a DOM good enough for the elements it creates,
// so the stub below is deliberately minimal.
function makeEl() {
	return {
		className: '', textContent: '', innerHTML: '',
		children: [],
		appendChild(child) { this.children.push(child); return child; }
	};
}

function withDom(fn) {
	const previous = global.document;
	global.document = { createElement: () => makeEl() };
	try {
		fn();
	} finally {
		global.document = previous;
	}
}

function renderMeta(fp) {
	const manager = Object.create(FootprintManager.prototype);
	manager.metaEl = makeEl();
	withDom(() => manager._renderMeta(fp, { write: 1, read: 2, trigger: 0, possible: 0 }));
	return manager.metaEl;
}

suite('FootprintManager parse issues', () => {
	test('a partially parsed object is warned about', () => {
		const meta = renderMeta({
			tables: [], triggersFired: [], unresolved: [],
			parseIssues: [{ object: 'dbo.usp_Broken', errors: [{ line: 3, column: 12, message: 'mismatched input' }] }]
		});

		const warning = meta.children.find(c => c.className === 'footprint-warning');
		assert.ok(warning, 'the warning is rendered');
		assert.ok(warning.textContent.includes('dbo.usp_Broken'), 'the object is named');
		assert.ok(/partial/i.test(warning.textContent), 'the warning says the analysis is partial');

		const summary = meta.children.find(c => c.className === 'footprint-summary');
		assert.ok(summary.textContent.includes('partially parsed'), 'the summary counts it');
	});

	test('nothing is warned about when every object parsed cleanly', () => {
		const meta = renderMeta({
			tables: [], triggersFired: [], unresolved: [], parseIssues: []
		});

		assert.ok(!meta.children.find(c => c.className === 'footprint-warning'), 'no warning');
		const summary = meta.children.find(c => c.className === 'footprint-summary');
		assert.ok(!summary.textContent.includes('partially parsed'), 'the summary does not count it');
	});

	test('a footprint without the field at all does not warn', () => {
		// An index built before the field existed has no parseIssues.
		const meta = renderMeta({ tables: [], triggersFired: [], unresolved: [] });
		assert.ok(!meta.children.find(c => c.className === 'footprint-warning'), 'no warning');
	});
});
