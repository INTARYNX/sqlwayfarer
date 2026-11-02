const assert = require('assert');
const { describeColumn } = require('../database/columnTypes');

const col = (declaration, extra = {}) => Object.assign({ type: { declaration }, nullable: true }, extra);

suite('describeColumn', () => {
	test('numbers keep their precision and scale', () => {
		assert.deepStrictEqual(describeColumn(col('int')), { sql: 'int', kind: 'number', nullable: true });
		assert.strictEqual(describeColumn(col('bigint')).sql, 'bigint');
		assert.strictEqual(describeColumn(col('decimal', { precision: 10, scale: 2 })).sql, 'decimal(10,2)');
		assert.strictEqual(describeColumn(col('numeric', { precision: 5 })).sql, 'numeric(5,0)');
		assert.strictEqual(describeColumn(col('money')).kind, 'number');
		assert.deepStrictEqual(describeColumn(col('bit')), { sql: 'bit', kind: 'bit', nullable: true });
	});

	test('the length of n-types is in bytes for the driver, in characters for the declaration; MAX is recognised', () => {
		assert.strictEqual(describeColumn(col('varchar', { length: 50 })).sql, 'varchar(50)');
		assert.strictEqual(describeColumn(col('nvarchar', { length: 100 })).sql, 'nvarchar(50)');
		assert.strictEqual(describeColumn(col('nchar', { length: 6 })).sql, 'nchar(3)');
		assert.strictEqual(describeColumn(col('nvarchar', { length: 65535 })).sql, 'nvarchar(max)');
		assert.strictEqual(describeColumn(col('varchar', { length: 65535 })).sql, 'varchar(max)');
		assert.strictEqual(describeColumn(col('nvarchar', { length: 8000 })).sql, 'nvarchar(4000)');
		assert.strictEqual(describeColumn(col('text', { length: 2147483647 })).sql, 'varchar(max)');
		assert.strictEqual(describeColumn(col('ntext')).sql, 'nvarchar(max)');
		assert.strictEqual(describeColumn(col('char', { length: 3 })).kind, 'string');
	});

	test('dates, binary, guid and xml', () => {
		assert.deepStrictEqual(['datetime', 'smalldatetime', 'date'].map(t => describeColumn(col(t)).sql), ['datetime', 'smalldatetime', 'date']);
		assert.strictEqual(describeColumn(col('datetime2', { scale: 3 })).sql, 'datetime2(3)');
		assert.strictEqual(describeColumn(col('time', { scale: 4 })).sql, 'time(4)');
		assert.deepStrictEqual([describeColumn(col('datetimeoffset', { scale: 7 })).sql, describeColumn(col('datetimeoffset', { scale: 7 })).kind], ['datetimeoffset(7)', 'datetimeoffset']);
		assert.strictEqual(describeColumn(col('varbinary', { length: 2 })).sql, 'varbinary(2)');
		assert.strictEqual(describeColumn(col('varbinary', { length: 65535 })).sql, 'varbinary(max)');
		assert.strictEqual(describeColumn(col('image')).sql, 'varbinary(max)');
		assert.deepStrictEqual([describeColumn(col('uniqueidentifier')).kind, describeColumn(col('xml')).sql], ['guid', 'xml']);
	});

	test('what has no literal is nvarchar(max) of kind unsupported', () => {
		for (const type of ['udt', 'geography', 'geometry', 'variant', 'hierarchyid', 'something-new']) {
			assert.deepStrictEqual(describeColumn(col(type)), { sql: 'nvarchar(max)', kind: 'unsupported', nullable: true }, type);
		}
		assert.strictEqual(describeColumn(undefined).kind, 'unsupported');
	});

	test('NOT NULL is kept', () => {
		assert.strictEqual(describeColumn(col('int', { nullable: false })).nullable, false);
	});

	test('the Windows authentication helper gives the type as a name only: a size that is not known cannot lose data', () => {
		const named = (type, extra = {}) => Object.assign({ type, nullable: true }, extra);
		assert.deepStrictEqual(describeColumn(named('int')), { sql: 'int', kind: 'number', nullable: true });
		assert.strictEqual(describeColumn(named('decimal')).sql, 'decimal(38,10)');
		assert.strictEqual(describeColumn(named('varchar')).sql, 'varchar(max)');
		assert.strictEqual(describeColumn(named('nvarchar')).sql, 'nvarchar(max)');
		assert.strictEqual(describeColumn(named('char')).sql, 'varchar(max)', 'char has no (max): its variable twin');
		assert.strictEqual(describeColumn(named('nchar')).sql, 'nvarchar(max)');
		assert.strictEqual(describeColumn(named('binary')).sql, 'varbinary(max)');
		assert.strictEqual(describeColumn(named('varbinary')).sql, 'varbinary(max)');
		assert.strictEqual(describeColumn(named('datetime2')).sql, 'datetime2');
		assert.deepStrictEqual([describeColumn(named('uniqueidentifier')).kind, describeColumn(named('bit')).kind, describeColumn(named('datetime')).kind], ['guid', 'bit', 'datetime']);
		assert.deepStrictEqual(describeColumn(named('geography')), { sql: 'nvarchar(max)', kind: 'unsupported', nullable: true });
		assert.deepStrictEqual(describeColumn(named('sysname')), { sql: 'nvarchar(128)', kind: 'string', nullable: true });
	});

	test('a fixed char with a length stays fixed, one that is too long becomes variable', () => {
		assert.strictEqual(describeColumn(col('char', { length: 3 })).sql, 'char(3)');
		assert.strictEqual(describeColumn(col('nchar', { length: 6 })).sql, 'nchar(3)');
		assert.strictEqual(describeColumn(col('binary', { length: 4 })).sql, 'binary(4)');
		assert.strictEqual(describeColumn(col('char', { length: 65535 })).sql, 'varchar(max)');
	});
});
