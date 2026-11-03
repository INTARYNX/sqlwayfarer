const assert = require('assert');
const { skipTrivia, parseHeader, normalizeDefinition } = require('../database/sqlHeader');

suite('sqlHeader', () => {
	test('skipTrivia passes whitespace, line comments and nested block comments', () => {
		assert.strictEqual(skipTrivia('  \n\t x'), 5);
		assert.strictEqual(skipTrivia('-- one\n-- two\nx'), 14);
		assert.strictEqual(skipTrivia('/* a /* nested */ still */ x'), 27);
		assert.strictEqual(skipTrivia('-- never ends'), 13);
		assert.strictEqual(skipTrivia('/* never ends'), 13);
		assert.strictEqual(skipTrivia('x'), 0);
	});

	test('the header is the first word, in any case and after comments', () => {
		assert.deepStrictEqual(parseHeader('CREATE PROC p AS SELECT 1'), { start: 0, end: 6, keyword: 'CREATE' });
		assert.deepStrictEqual(parseHeader('alter view v AS SELECT 1'), { start: 0, end: 5, keyword: 'ALTER' });
		assert.strictEqual(parseHeader('-- note\n/* CREATE */\nCreate   Function f() RETURNS int AS BEGIN RETURN 1 END').keyword, 'CREATE');
		assert.strictEqual(parseHeader('-- ALTER in a comment\nCREATE PROC p AS SELECT 1').keyword, 'CREATE');
	});

	test('CREATE OR ALTER is one header, comments and line breaks between the words included', () => {
		const text = 'create /* x */ or\n  alter proc p as select 1';
		const header = parseHeader(text);
		assert.strictEqual(header.keyword, 'CREATE OR ALTER');
		assert.strictEqual(text.slice(header.end), ' proc p as select 1');
	});

	test('"CREATE ORDERS" is not "CREATE OR ..."', () => {
		assert.strictEqual(parseHeader('CREATE ORDERS').keyword, 'CREATE');
	});

	test('what does not start with CREATE or ALTER has no header', () => {
		assert.strictEqual(parseHeader('SELECT 1'), null);
		assert.strictEqual(parseHeader(''), null);
		assert.strictEqual(parseHeader('-- only a comment'), null);
		assert.strictEqual(parseHeader(null), null);
		assert.strictEqual(parseHeader(undefined), null);
	});

	test('the normalized text does not depend on CREATE or ALTER, line ends or trailing blanks', () => {
		const a = 'CREATE PROCEDURE dbo.p\r\nAS\r\n  SELECT 1   \r\n';
		const b = 'ALTER PROCEDURE dbo.p\nAS\n  SELECT 1';
		const c = 'create or alter PROCEDURE dbo.p\nAS\n  SELECT 1\n\n';
		assert.strictEqual(normalizeDefinition(a), normalizeDefinition(b));
		assert.strictEqual(normalizeDefinition(a), normalizeDefinition(c));
	});

	test('the blanks the server leaves where OR ALTER was are not a change', () => {
		assert.strictEqual(normalizeDefinition('\tCREATE   PROCEDURE dbo.p AS SELECT 1\n\n'), normalizeDefinition('\tCREATE PROCEDURE dbo.p AS SELECT 1\n'));
		assert.strictEqual(normalizeDefinition('CREATE OR ALTER PROC p AS SELECT 1'), 'CREATE PROC p AS SELECT 1');
	});

	test('a real change is still one: the body, the name, a comment', () => {
		const base = normalizeDefinition('CREATE PROC dbo.p AS SELECT 1 -- x');
		assert.notStrictEqual(base, normalizeDefinition('CREATE PROC dbo.p AS SELECT 2 -- x'));
		assert.notStrictEqual(base, normalizeDefinition('CREATE PROC dbo.q AS SELECT 1 -- x'));
		assert.notStrictEqual(base, normalizeDefinition('CREATE PROC dbo.p AS SELECT 1 -- y'));
	});

	test('a CREATE inside a comment before the header is left alone', () => {
		const text = '/* CREATE */ ALTER PROC p AS SELECT 1';
		assert.strictEqual(normalizeDefinition(text), '/* CREATE */ CREATE PROC p AS SELECT 1');
	});

	test('text with no header is only tidied; nothing in, nothing out', () => {
		assert.strictEqual(normalizeDefinition('  x  \r\ny  '), 'x\ny');
		assert.strictEqual(normalizeDefinition(null), null);
	});
});
