const assert = require('assert');
const manifest = require('../package.json');

suite('package.json', () => {
	// The Marketplace reads 30 keywords at most; more would be dropped without a word.
	test('has at most 30 keywords, each once', () => {
		assert.ok(manifest.keywords.length <= 30, `${manifest.keywords.length} keywords`);
		assert.strictEqual(new Set(manifest.keywords.map(k => k.toLowerCase())).size, manifest.keywords.length);
	});
});
