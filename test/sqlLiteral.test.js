const assert = require('assert');
const { sqlLiteral } = require('../database/sqlLiteral');

suite('sqlLiteral', () => {
	test('null and undefined are NULL, whatever the type', () => {
		assert.strictEqual(sqlLiteral(null, 'int'), 'NULL');
		assert.strictEqual(sqlLiteral(undefined, 'nvarchar(50)'), 'NULL');
	});

	test('a string is an N-prefixed literal, with its apostrophes doubled', () => {
		assert.strictEqual(sqlLiteral("O'Brien", 'nvarchar(50)'), "N'O''Brien'");
		assert.strictEqual(sqlLiteral('', 'varchar(10)'), "N''");
	});

	test('a uniqueidentifier is written like any other string', () => {
		assert.strictEqual(sqlLiteral('3F2504E0-4F89-11D3-9A0C-0305E82C3301', 'uniqueidentifier'), "N'3F2504E0-4F89-11D3-9A0C-0305E82C3301'");
	});

	test('a number is written as-is; a non-finite number is NULL', () => {
		assert.strictEqual(sqlLiteral(10.5, 'decimal(10,2)'), '10.5');
		assert.strictEqual(sqlLiteral(0, 'int'), '0');
		assert.strictEqual(sqlLiteral(NaN, 'float'), 'NULL');
	});

	test('a bigint is written without a trailing n', () => {
		assert.strictEqual(sqlLiteral(9007199254740993n, 'bigint'), '9007199254740993');
	});

	test('a boolean is 1 or 0', () => {
		assert.strictEqual(sqlLiteral(true, 'bit'), '1');
		assert.strictEqual(sqlLiteral(false, 'bit'), '0');
	});

	test('a buffer is a 0x literal, empty buffer included', () => {
		assert.strictEqual(sqlLiteral(Buffer.from([1, 2, 0xAB]), 'varbinary(50)'), '0x0102ab');
		assert.strictEqual(sqlLiteral(Buffer.alloc(0), 'varbinary(50)'), '0x');
	});

	test('a date is CONVERTed with style 127, at the column type', () => {
		const d = new Date('2024-01-01T13:30:05.123Z');
		assert.strictEqual(sqlLiteral(d, 'date'), "CONVERT(date, N'2024-01-01T13:30:05.123', 127)");
		assert.strictEqual(sqlLiteral(d, 'time(7)'), "CONVERT(time, N'2024-01-01T13:30:05.123', 127)");
		assert.strictEqual(sqlLiteral(d, 'datetime2(3)'), "CONVERT(datetime2, N'2024-01-01T13:30:05.123', 127)");
		assert.strictEqual(sqlLiteral(d, 'smalldatetime'), "CONVERT(smalldatetime, N'2024-01-01T13:30:05.123', 127)");
	});

	test('a datetimeoffset gets a +00:00 offset: the driver always hands back UTC', () => {
		const d = new Date('2024-01-01T13:30:05.123Z');
		assert.strictEqual(sqlLiteral(d, 'datetimeoffset(7)'), "CONVERT(datetimeoffset, N'2024-01-01T13:30:05.123+00:00', 127)");
	});

	test('a date value of an unrecognized type falls back to datetime2', () => {
		const d = new Date('2024-01-01T00:00:00.000Z');
		assert.strictEqual(sqlLiteral(d, 'sql_variant'), "CONVERT(datetime2, N'2024-01-01T00:00:00.000', 127)");
	});
});
