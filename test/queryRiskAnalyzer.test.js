const assert = require('assert');
const BabelfishSqlParser = require('../database/BabelfishSqlParser');
const QueryRiskAnalyzer = require('../database/QueryRiskAnalyzer');

suite('QueryRiskAnalyzer with the T-SQL parser', () => {
	const parser = new BabelfishSqlParser();
	parser.setEnabled(true);
	const analyzer = new QueryRiskAnalyzer(parser);

	test('flags UPDATE without WHERE, naming the target table', () => {
		const risks = analyzer.analyze('UPDATE dbo.Customer SET Active = 0');
		assert.strictEqual(risks.length, 1);
		assert.ok(risks[0].includes('UPDATE without WHERE'), risks[0]);
		assert.ok(risks[0].includes('dbo.Customer'), risks[0]);
	});

	test('UPDATE with WHERE is not flagged', () => {
		assert.deepStrictEqual(analyzer.analyze('UPDATE dbo.Customer SET Active = 0 WHERE ID = 3'), []);
	});

	test('flags DELETE without WHERE', () => {
		const risks = analyzer.analyze('DELETE FROM dbo.AuditLog');
		assert.strictEqual(risks.length, 1);
		assert.ok(risks[0].includes('DELETE without WHERE'), risks[0]);
	});

	test('SELECT and INSERT are not flagged', () => {
		assert.deepStrictEqual(
			analyzer.analyze('SELECT * FROM T; INSERT INTO T (a) VALUES (1);'),
			[]
		);
	});

	test('only the unsafe statement of a batch is flagged', () => {
		const risks = analyzer.analyze('UPDATE A SET x = 1 WHERE id = 2; DELETE FROM B;');
		assert.strictEqual(risks.length, 1);
		assert.ok(risks[0].startsWith('DELETE'), risks[0]);
	});

	test('flags TRUNCATE TABLE and DROP', () => {
		const risks = analyzer.analyze('TRUNCATE TABLE dbo.Staging; DROP TABLE dbo.Old;');
		assert.strictEqual(risks.length, 2);
		assert.ok(risks.some(r => /truncate table dbo.Staging/i.test(r)), risks.join());
		assert.ok(risks.some(r => /drop table dbo.Old/i.test(r)), risks.join());
	});
});

suite('QueryRiskAnalyzer regex fallback (no parser)', () => {
	const analyzer = new QueryRiskAnalyzer(null);

	test('still flags UPDATE without WHERE', () => {
		const risks = analyzer.analyze('UPDATE Customer SET Active = 0');
		assert.strictEqual(risks.length, 1);
		assert.ok(risks[0].includes('UPDATE without WHERE'));
	});

	test('does not flag UPDATE with WHERE', () => {
		assert.deepStrictEqual(analyzer.analyze('UPDATE Customer SET Active = 0 WHERE ID = 1'), []);
	});

	// F24: the fallback's statement regex only matched a bare leading UPDATE/
	// DELETE, missing the common "WITH cte AS (...) UPDATE ..." shape.
	test('flags UPDATE without WHERE behind a leading WITH-CTE', () => {
		const risks = analyzer.analyze('WITH cte AS (SELECT 1 AS x) UPDATE dbo.T SET y = 1');
		assert.strictEqual(risks.length, 1);
		assert.ok(risks[0].includes('UPDATE without WHERE'), risks[0]);
	});

	test('flags DELETE without WHERE behind a leading WITH-CTE', () => {
		const risks = analyzer.analyze('WITH cte AS (SELECT 1 AS x) DELETE FROM dbo.T');
		assert.strictEqual(risks.length, 1);
		assert.ok(risks[0].includes('DELETE without WHERE'), risks[0]);
	});

	// F24: "where" appearing anywhere in the statement text - including inside
	// a string literal - used to suppress the warning entirely.
	test('a "where" inside a string literal does not suppress the warning', () => {
		const risks = analyzer.analyze("UPDATE dbo.T SET note = 'no where clause'");
		assert.strictEqual(risks.length, 1);
		assert.ok(risks[0].includes('UPDATE without WHERE'), risks[0]);
	});
});

// F23: the TRUNCATE/DROP regex scan runs unconditionally (parser-path or
// fallback) over the raw SQL text - it must not match text that isn't
// actually executable: a comment, or a string literal.
suite('QueryRiskAnalyzer TRUNCATE/DROP scan ignores comments and string literals', () => {
	const analyzer = new QueryRiskAnalyzer(null);

	test('a DROP/TRUNCATE keyword inside a string literal is not flagged', () => {
		assert.deepStrictEqual(analyzer.analyze("SELECT * FROM dbo.Log WHERE msg = 'drop table x'"), []);
		assert.deepStrictEqual(analyzer.analyze("SELECT * FROM dbo.Log WHERE msg = 'TRUNCATE TABLE dbo.T'"), []);
	});

	test('a DROP/TRUNCATE keyword inside a line or block comment is not flagged', () => {
		assert.deepStrictEqual(analyzer.analyze('-- TRUNCATE TABLE dbo.T\nSELECT 1'), []);
		assert.deepStrictEqual(analyzer.analyze('/* DROP TABLE dbo.T */ SELECT 1'), []);
	});

	test('a real TRUNCATE/DROP statement is still flagged alongside an unrelated comment', () => {
		const risks = analyzer.analyze('-- cleanup\nTRUNCATE TABLE dbo.Staging;');
		assert.strictEqual(risks.length, 1);
		assert.ok(/truncate table dbo.Staging/i.test(risks[0]), risks[0]);
	});
});

// The checks beyond DML without WHERE: they must give the same answer with
// the T-SQL parser and without it.
[['with the T-SQL parser', true], ['regex fallback', false]].forEach(([label, withParser]) => {
	suite(`QueryRiskAnalyzer, wider destructive statements (${label})`, () => {
		const parser = new BabelfishSqlParser();
		parser.setEnabled(true);
		const analyzer = new QueryRiskAnalyzer(withParser ? parser : null);
		const flagged = (sql, pattern) => {
			const risks = analyzer.analyze(sql);
			assert.ok(risks.some(r => pattern.test(r)), `${sql} -> ${risks.join(' | ') || 'nothing'}`);
		};

		test('flags DROP COLUMN and ALTER COLUMN', () => {
			flagged('ALTER TABLE dbo.T DROP COLUMN a', /ALTER TABLE dbo\.T DROP COLUMN/);
			flagged('ALTER TABLE dbo.T ALTER COLUMN a varchar(1) NULL', /ALTER TABLE dbo\.T ALTER COLUMN/);
		});

		test('flags the other DROP kinds, and names the object after IF EXISTS', () => {
			for (const kind of ['SCHEMA', 'SYNONYM', 'USER', 'LOGIN', 'ROLE', 'TYPE', 'SEQUENCE', 'ASSEMBLY']) {
				flagged(`DROP ${kind} x`, new RegExp(`DROP ${kind} x`));
			}
			flagged('DROP TABLE IF EXISTS dbo.T', /^DROP TABLE dbo\.T$/);
		});

		test('flags a WHERE that is always true', () => {
			flagged('UPDATE dbo.T SET a = 1 WHERE 1=1', /UPDATE with an always-true WHERE/);
			flagged('DELETE FROM dbo.T WHERE (0 = 0)', /DELETE with an always-true WHERE/);
			assert.deepStrictEqual(analyzer.analyze('UPDATE dbo.T SET a = 1 WHERE 1 = 1 AND id = 3'), []);
		});

		test('flags MERGE ... THEN DELETE, ALTER DATABASE SET SINGLE_USER and xp_cmdshell', () => {
			flagged('MERGE dbo.T USING dbo.S ON 1=1 WHEN NOT MATCHED BY SOURCE THEN DELETE;', /MERGE deleting rows/);
			flagged('ALTER DATABASE d SET SINGLE_USER WITH ROLLBACK IMMEDIATE', /ALTER DATABASE d SET SINGLE_USER/);
			flagged("EXEC xp_cmdshell 'dir'", /xp_cmdshell/);
		});

		test('looks inside a dynamic statement written as a literal', () => {
			flagged("EXEC('DELETE FROM dbo.T')", /^In dynamic SQL: DELETE without WHERE/);
			flagged("EXEC sp_executesql N'DROP TABLE dbo.T'", /^In dynamic SQL: DROP TABLE dbo\.T/);
			flagged("EXEC sp_executesql N'SELECT ''x''; TRUNCATE TABLE dbo.T'", /In dynamic SQL: TRUNCATE TABLE dbo\.T/);
		});

		test('a harmless dynamic statement is not flagged', () => {
			assert.deepStrictEqual(analyzer.analyze("EXEC sp_executesql N'SELECT * FROM dbo.T WHERE id = @id', N'@id int', @id = 3"), []);
		});

		test('a temporary table or a table variable is not flagged', () => {
			assert.deepStrictEqual(analyzer.analyze('DELETE FROM #tmp'), []);
			assert.deepStrictEqual(analyzer.analyze('UPDATE @rows SET a = 1'), []);
			assert.deepStrictEqual(analyzer.analyze('DELETE #tmp WHERE 1=1'), []);
			assert.deepStrictEqual(analyzer.analyze('TRUNCATE TABLE #tmp; DROP TABLE #tmp'), []);
		});

		test('a real table still is', () => {
			flagged('DELETE FROM dbo.T', /DELETE without WHERE/);
		});
	});
});

// On a production connection, a statement that changes data or schema asks for
// a confirmation whatever its WHERE.
[['with the T-SQL parser', true], ['regex fallback', false]].forEach(([label, withParser]) => {
	suite(`QueryRiskAnalyzer on a production connection (${label})`, () => {
		const parser = new BabelfishSqlParser();
		parser.setEnabled(true);
		const analyzer = new QueryRiskAnalyzer(withParser ? parser : null);
		const prod = sql => analyzer.analyze(sql, { production: true });

		test('a SELECT is not flagged', () => {
			assert.deepStrictEqual(prod('SELECT * FROM dbo.T WHERE id = 1'), []);
			assert.deepStrictEqual(prod('EXEC sp_help'), []);
		});

		test('an UPDATE with a WHERE is flagged, and listed once with the other verbs', () => {
			const risks = prod('UPDATE dbo.T SET a = 1 WHERE id = 3;\nINSERT INTO dbo.T (a) VALUES (1);\nUPDATE dbo.T SET a = 2 WHERE id = 4');
			assert.deepStrictEqual(risks, ['Changes data or schema (UPDATE, INSERT) on a production connection']);
		});

		test('DDL and a statement without a semicolon are flagged', () => {
			assert.ok(prod('CREATE TABLE dbo.X (a int)').length === 1);
			assert.ok(prod('SELECT 1\nALTER TABLE dbo.X ADD b int').some(r => /ALTER/.test(r)));
		});

		test('adds to the usual risks instead of replacing them', () => {
			const risks = prod('DELETE FROM dbo.T');
			assert.ok(risks.some(r => /DELETE without WHERE/.test(r)) && risks.some(r => /on a production connection/.test(r)), risks.join(' | '));
		});

		test('a temporary table or a table variable is not a change to production', () => {
			assert.deepStrictEqual(prod('CREATE TABLE #t (a int); INSERT INTO #t VALUES (1); UPDATE #t SET a = 2 WHERE a = 1; DROP TABLE #t'), []);
			assert.deepStrictEqual(prod('DECLARE @r TABLE (a int); INSERT @r VALUES (1)'), []);
		});

		test('a keyword in a comment or a string is not flagged', () => {
			assert.deepStrictEqual(prod("-- update later\nSELECT 'delete me'"), []);
		});

		test('without the option nothing is added', () => {
			assert.deepStrictEqual(analyzer.analyze('UPDATE dbo.T SET a = 1 WHERE id = 3'), []);
		});
	});
});
