const assert = require('assert');
const parseObjectName = require('../database/parseObjectName');
const { bracketIdentifier, escapeLiteral } = require('../database/sqlIdentifier');

suite('parseObjectName', () => {
	test('splits a simple schema.object name', () => {
		assert.deepStrictEqual(parseObjectName('dbo.Orders'), { schema: 'dbo', objectName: 'Orders' });
	});

	test('defaults to dbo when no schema is given', () => {
		assert.deepStrictEqual(parseObjectName('Orders'), { schema: 'dbo', objectName: 'Orders' });
	});

	test('strips brackets from a bracketed name', () => {
		assert.deepStrictEqual(parseObjectName('[dbo].[Orders]'), { schema: 'dbo', objectName: 'Orders' });
	});

	test('empty input yields an empty object name under dbo', () => {
		assert.deepStrictEqual(parseObjectName(''), { schema: 'dbo', objectName: '' });
	});

	// Hostile names SQL Server itself allows - DatabaseService/CommentsService
	// used to interpolate schema/objectName directly into string literals
	// (S1/S4 in the security review), so parseObjectName's job is only to
	// split the name - it must NOT be relied on to neutralize these. The
	// actual defense is parameterized queries downstream.
	test('does not strip or escape apostrophes - that is the caller\'s job via query parameters', () => {
		assert.deepStrictEqual(
			parseObjectName("dbo.x' OR '1'='1"),
			{ schema: 'dbo', objectName: "x' OR '1'='1" }
		);
	});

	test('a name containing a semicolon-separated payload is still just split, not sanitized', () => {
		assert.deepStrictEqual(
			parseObjectName("dbo.x'; DROP TABLE Users;--"),
			{ schema: 'dbo', objectName: "x'; DROP TABLE Users;--" }
		);
	});

	// F2: every caller passes a 2-part "schema.object" name sourced from
	// DatabaseService's own qualified_name (schema + '.' + object, never
	// bracketed) - an object literally named with a dot in it (SQL Server
	// allows this) used to be torn apart as if it were a 3-part
	// database.schema.object reference, resolving the wrong schema entirely.
	test('an object name containing a dot is kept whole, not mistaken for a 3-part reference', () => {
		assert.deepStrictEqual(parseObjectName('dbo.my.table'), { schema: 'dbo', objectName: 'my.table' });
	});

	// F2: a lone ']' with no matching '[' is part of a real object name, not
	// bracket punctuation - it must survive, not be silently deleted.
	test('a name containing an unmatched "]" is preserved, not silently stripped', () => {
		assert.deepStrictEqual(parseObjectName('dbo.Weird]Name'), { schema: 'dbo', objectName: 'Weird]Name' });
	});

	test('"]]" inside a bracketed segment unescapes to a literal "]"', () => {
		assert.deepStrictEqual(parseObjectName('[dbo].[Foo]]Bar]'), { schema: 'dbo', objectName: 'Foo]Bar' });
	});
});

suite('sqlIdentifier.bracketIdentifier', () => {
	test('wraps a plain name in brackets', () => {
		assert.strictEqual(bracketIdentifier('Orders'), '[Orders]');
	});

	test('doubles an embedded "]" so the identifier cannot be broken out of', () => {
		// Without doubling, "x];EXEC xp_cmdshell 'whoami';--" would close the
		// bracket early and let the rest run as separate statements (S2/S3).
		assert.strictEqual(bracketIdentifier("x];EXEC xp_cmdshell 'whoami';--"), "[x]];EXEC xp_cmdshell 'whoami';--]");
	});
});

suite('sqlIdentifier.escapeLiteral', () => {
	test('doubles an embedded single quote', () => {
		assert.strictEqual(escapeLiteral("x' OR '1'='1"), "x'' OR ''1''=''1");
	});
});
