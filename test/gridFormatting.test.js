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

// Inserting a snippet replaces the range the caret is in, not the whole
// document: with the whole document replaced, undoing the insertion threw
// away the entire query.
suite('QueryManager.insertAtCursor', () => {
	function makeEditor(text) {
		return {
			value: text,
			selectionStart: text.length,
			selectionEnd: text.length,
			focus() {},
			setSelectionRange(start, end) {
				this.selectionStart = start;
				this.selectionEnd = end;
			}
		};
	}

	function makeManager(editor) {
		const manager = Object.create(QueryManager.prototype);
		manager.input = editor;
		return manager;
	}

	test('replaces the range at the caret and keeps the text around it', () => {
		const editor = makeEditor('SELECT * FROM ');
		editor.replaceRange = (from, to, text) => {
			editor.value = editor.value.slice(0, from) + text + editor.value.slice(to);
			editor.setSelectionRange(from + text.length, from + text.length);
		};

		makeManager(editor).insertAtCursor('dbo.Orders');

		assert.strictEqual(editor.value, 'SELECT * FROM dbo.Orders');
		assert.strictEqual(editor.selectionStart, 'SELECT * FROM dbo.Orders'.length);
	});

	test('falls back to the whole document when the editor cannot replace a range', () => {
		const editor = makeEditor('SELECT * FROM ');

		makeManager(editor).insertAtCursor('dbo.Orders');

		assert.strictEqual(editor.value, 'SELECT * FROM dbo.Orders');
	});
});
// The grid draws a prefix of a big result set: the webview builds the whole
// table as one HTML string, and 200 000 rows x 10 columns is tens of
// megabytes of markup - enough to freeze the tab. The data itself is
// untouched (Copy/CSV export use the full result set).
suite('QueryManager grid rendering', () => {
	function makeGrid(rows) {
		const grid = Object.create(QueryManager.prototype);
		grid._gridState = [{ filterText: '', sortCol: null, sortDir: 1 }];
		return grid.buildResultSetTableHtml(rows, ['id'], 0);
	}

	function makeRows(count) {
		const rows = [];
		for (let i = 0; i < count; i++) rows.push({ id: i });
		return rows;
	}

	test('draws every row of a small result set', () => {
		const html = makeGrid(makeRows(10));

		// 10 rows + the header row.
		assert.strictEqual((html.match(/<tr>/g) || []).length, 11);
		assert.ok(!html.includes('truncation-note'));
	});

	test('draws a prefix of a huge result set and says so', () => {
		const html = makeGrid(makeRows(QueryManager.MAX_RENDERED_ROWS + 500));

		// +1 for the header row.
		assert.strictEqual((html.match(/<tr>/g) || []).length, QueryManager.MAX_RENDERED_ROWS + 1);
		assert.ok(html.includes('truncation-note'));
		assert.ok(html.includes(`first ${QueryManager.MAX_RENDERED_ROWS} of ${QueryManager.MAX_RENDERED_ROWS + 500} rows`));
	});

	test('a result set exactly at the limit is drawn whole', () => {
		const html = makeGrid(makeRows(QueryManager.MAX_RENDERED_ROWS));

		assert.strictEqual((html.match(/<tr>/g) || []).length, QueryManager.MAX_RENDERED_ROWS + 1);
		assert.ok(!html.includes('truncation-note'));
	});
});

suite('QueryManager.columnNames', () => {
	test('one name per line, a comma after each but the last', () => {
		assert.strictEqual(QueryManager.columnNames(['id', 'first name', 'x'], false), 'id,\nfirst name,\nx');
		assert.strictEqual(QueryManager.columnNames(['only'], false), 'only');
		assert.strictEqual(QueryManager.columnNames([], false), '');
	});

	test('with brackets, a ] in a name is doubled; an unnamed column gets a name', () => {
		assert.strictEqual(QueryManager.columnNames(['id', 'a]b', ''], true), '[id],\n[a]]b],\n[Column3]');
		assert.strictEqual(QueryManager.columnNames(['a', ''], false), 'a,\nColumn2');
		assert.strictEqual(QueryManager.columnNames(['a', '(No column name)', '(No column name) (2)'], true), '[a],\n[Column2],\n[Column3]');
	});
});

suite('QueryManager date and time columns, and numbers sent as text', () => {
	const format = (value, type) => QueryManager.prototype.formatValue.call({}, value, type);
	const date = { sql: 'date', kind: 'date' };
	const time = (sql = 'time(7)') => ({ sql, kind: 'time' });

	test('a date column shows the date only, a time column the time only', () => {
		assert.strictEqual(format('2008-04-30T00:00:00.000Z', date), '2008-04-30');
		assert.strictEqual(format('1970-01-01T13:45:09.123Z', time()), '13:45:09.123');
		assert.strictEqual(format('1970-01-01T13:45:09.123Z', time('time(2)')), '13:45:09.12');
		assert.strictEqual(format('1970-01-01T13:45:09.000Z', time('time(0)')), '13:45:09');
		assert.strictEqual(format('1970-01-01T13:45:09.123Z', time('time')), '13:45:09.123');
	});

	test('a datetime column, and a value with no known type, are as before', () => {
		assert.strictEqual(format('2008-04-30T10:20:30.123Z', { sql: 'datetime', kind: 'datetime' }), '2008-04-30 10:20:30.123');
		assert.strictEqual(format('2008-04-30T00:00:00.000Z'), '2008-04-30 00:00:00.000');
		assert.strictEqual(format(null, date), 'NULL');
	});

	test('the exports carry the same narrow date and time, and keep the datetimes whole', () => {
		const set = {
			columns: ['d', 't', 'dt'],
			types: [date, time('time(3)'), { sql: 'datetime', kind: 'datetime' }],
			rows: [{ d: '2008-04-30T00:00:00.000Z', t: '1970-01-01T08:00:00.500Z', dt: '2008-04-30T10:20:30.000Z' }]
		};
		assert.strictEqual(QueryManager.toDelimited(set, ','), 'd,t,dt\r\n2008-04-30,08:00:00.500,2008-04-30T10:20:30.000Z');
		assert.deepStrictEqual(JSON.parse(QueryManager.toJson(set))[0], { d: '2008-04-30', t: '08:00:00.500', dt: '2008-04-30T10:20:30.000Z' });
	});

	test('a number that comes as text sorts as a number', () => {
		const number = { sql: 'bigint', kind: 'number' };
		const sorted = ['10', '9', '100', '-5', '9007199254740993', '9007199254740992'].sort((a, b) => QueryManager.compareValues(a, b, number));
		assert.deepStrictEqual(sorted, ['-5', '9', '10', '100', '9007199254740992', '9007199254740993']);
		assert.deepStrictEqual(['b', 'a'].sort((a, b) => QueryManager.compareValues(a, b, { sql: 'varchar(5)', kind: 'string' })), ['a', 'b']);
		assert.strictEqual(QueryManager.compareValues(1.5, 10, number), -1);
	});

	test('the types of a result set go by column', () => {
		assert.deepStrictEqual(QueryManager.typesByColumn({ columns: ['a', 'b'], types: [date] }), { a: date });
		assert.deepStrictEqual(QueryManager.typesByColumn({ columns: ['a'] }), {});
	});
});
