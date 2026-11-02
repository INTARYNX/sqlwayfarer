const assert = require('assert');
const { findToken } = require('../webview-build/findToken');

suite('findToken', () => {
	test('the first whole word, in any case', () => {
		assert.deepStrictEqual(findToken('SELECT a, b from t', 'FROM'), { from: 12, to: 16 });
		assert.deepStrictEqual(findToken('FROM t', 'from'), { from: 0, to: 4 });
	});

	test('not inside a longer name', () => {
		assert.deepStrictEqual(findToken('SELECT * FROM from_t t2 JOIN x ON', 'FROM'), { from: 9, to: 13 });
		assert.strictEqual(findToken('SELECT * FROM_x', 'FROM'), null);
		assert.strictEqual(findToken('SELECT @from, #from, $from', 'from'), null);
	});

	test('not inside a string or a comment', () => {
		assert.deepStrictEqual(findToken("SELECT 'x FROM y', FROM t", 'FROM'), { from: 19, to: 23 });
		assert.deepStrictEqual(findToken("SELECT 'it''s FROM', FROM t", 'FROM'), { from: 21, to: 25 });
		assert.strictEqual(findToken('SELECT 1 -- FROM here', 'FROM'), null);
	});

	test('a symbol is found as it is; nothing to find gives null', () => {
		assert.deepStrictEqual(findToken('SELECT a,, b', ',,'), { from: 8, to: 10 });
		assert.deepStrictEqual(findToken('SELECT a )', ')'), { from: 9, to: 10 });
		assert.strictEqual(findToken('SELECT 1', ''), null);
		assert.strictEqual(findToken('SELECT 1', 'WHERE'), null);
	});
});
