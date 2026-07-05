const assert = require('assert');
const QueryManager = require('../webview/queryManager');
const DatabaseService = require('../database/DatabaseService');

suite('QueryManager.toDelimited', () => {
	const set = {
		columns: ['id', 'name', 'note'],
		rows: [
			{ id: 1, name: 'plain', note: null },
			{ id: 2, name: 'has,comma', note: 'say "hi"\nline2' }
		]
	};

	test('CSV escapes separators, quotes and newlines per RFC 4180', () => {
		const csv = QueryManager.toDelimited(set, ',');
		const lines = csv.split('\r\n');
		assert.strictEqual(lines[0], 'id,name,note');
		assert.strictEqual(lines[1], '1,plain,');
		assert.strictEqual(lines[2], '2,"has,comma","say ""hi""\nline2"');
	});

	test('TSV (clipboard) leaves commas untouched but quotes tabs/newlines', () => {
		const tsv = QueryManager.toDelimited(set, '\t');
		assert.ok(tsv.includes('2\thas,comma\t'), 'comma must not be quoted in TSV');
	});
});

suite('DatabaseService.escapeLikePattern', () => {
	test('escapes LIKE wildcards so user input is matched literally', () => {
		assert.strictEqual(DatabaseService.escapeLikePattern('100%_[x]'), '100[%][_][[]x]');
	});

	test('leaves plain text unchanged', () => {
		assert.strictEqual(DatabaseService.escapeLikePattern('GetOrders'), 'GetOrders');
	});
});
