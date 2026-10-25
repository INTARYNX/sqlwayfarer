const assert = require('assert');
const QueryManager = require('../webview/queryManager');

// formatValue only reads its argument and a static regex, so a bare object
// is enough - no DOM, no webview.
const formatValue = value => QueryManager.prototype.formatValue.call({}, value);

suite('QueryManager.formatValue', () => {
	// A datetime crosses the extension host -> webview boundary as JSON, so
	// it arrives as a *string* ("2008-04-30T00:00:00.000Z"), never as a Date
	// object: the grid has to recognise that shape itself.
	test('formats a datetime that arrived as a JSON ISO string, SSMS-style', () => {
		assert.strictEqual(formatValue('2008-04-30T00:00:00.000Z'), '2008-04-30 00:00:00.000');
	});

	test('formats a Date object the same way', () => {
		assert.strictEqual(formatValue(new Date(Date.UTC(2008, 3, 30))), '2008-04-30 00:00:00.000');
	});

	test('leaves a string that only looks like a date alone', () => {
		// Not JSON.stringify's exact shape - it must not be rewritten.
		assert.strictEqual(formatValue('2008-04-30'), '2008-04-30');
		assert.strictEqual(formatValue('2008-04-30 00:00:00'), '2008-04-30 00:00:00');
		assert.strictEqual(formatValue('2008-04-30T00:00:00.000'), '2008-04-30T00:00:00.000');
		assert.strictEqual(formatValue('2008-04-30T00:00:00.000+02:00'), '2008-04-30T00:00:00.000+02:00');
	});

	test('keeps NULL and plain values as they were', () => {
		assert.strictEqual(formatValue(null), 'NULL');
		assert.strictEqual(formatValue(undefined), 'NULL');
		assert.strictEqual(formatValue(42), '42');
		assert.strictEqual(formatValue('hello'), 'hello');
	});
});
