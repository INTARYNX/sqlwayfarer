const assert = require('assert');
const { uniqueColumnKeys } = require('../database/resultColumns');

suite('resultColumns', () => {
	const keys = names => uniqueColumnKeys(names.map(name => ({ name })));

	test('distinct names are kept as they are', () => {
		assert.deepStrictEqual(keys(['id', 'Name', 'x y']), ['id', 'Name', 'x y']);
	});

	test('a column with no name is called as SSMS does', () => {
		assert.deepStrictEqual(keys(['']), ['(No column name)']);
		assert.deepStrictEqual(uniqueColumnKeys([{ name: undefined }, { name: null }]), ['(No column name)', '(No column name) (2)']);
	});

	test('a name returned again gets a suffix, and every key stays unique', () => {
		assert.deepStrictEqual(keys(['id', 'id', 'id']), ['id', 'id (2)', 'id (3)']);
		assert.deepStrictEqual(keys(['id', 'id (2)', 'id']), ['id', 'id (2)', 'id (3)']);
		assert.deepStrictEqual(keys(['', 'a', '']), ['(No column name)', 'a', '(No column name) (2)']);
	});

	test('the keys of a wide result set are unique', () => {
		const names = Array.from({ length: 300 }, (_, i) => (i % 3 === 0 ? 'a' : ''));
		assert.strictEqual(new Set(keys(names)).size, 300);
	});
});
