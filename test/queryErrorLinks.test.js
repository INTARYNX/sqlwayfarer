const assert = require('assert');
const QueryManager = require('../webview/queryManager');

const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

suite('QueryManager - error lines', () => {
	test('"Line N" becomes a link to that line', () => {
		const html = QueryManager.linkErrorLines("Line 3: Invalid object name 'x'.", escape);
		assert.ok(html.includes('data-line="3"'));
		assert.ok(html.includes('>Line 3</a>: Invalid object name'));
	});

	test('every error of a batch gets its own link', () => {
		const html = QueryManager.linkErrorLines('Line 2: first\nLine 5: second', escape);
		assert.strictEqual((html.match(/error-line-link/g) || []).length, 2);
		assert.ok(html.includes('data-line="2"') && html.includes('data-line="5"'));
	});

	test('a plan error keeps its prefix and still links the line', () => {
		const html = QueryManager.linkErrorLines('Failed to get estimated plan: Line 4: Incorrect syntax', escape);
		assert.ok(html.startsWith('Failed to get estimated plan: <a'));
		assert.ok(html.includes('data-line="4"'));
	});

	test('the text of the error is escaped, never taken as markup', () => {
		const html = QueryManager.linkErrorLines('Line 1: <script>alert(1)</script>', escape);
		assert.ok(!html.includes('<script>'));
		assert.ok(html.includes('&lt;script&gt;'));
	});

	test('a message without a line is left alone', () => {
		assert.strictEqual(QueryManager.linkErrorLines('Query cancelled.', escape), 'Query cancelled.');
	});

	test('the lines the server counts start after the blank lines at the top', () => {
		assert.strictEqual(QueryManager.leadingBlankLines('SELECT 1'), 0);
		assert.strictEqual(QueryManager.leadingBlankLines('\n\nSELECT 1'), 2);
		assert.strictEqual(QueryManager.leadingBlankLines('  \n  \nSELECT 1\n\n'), 2);
		assert.strictEqual(QueryManager.leadingBlankLines(''), 0);
	});
});
