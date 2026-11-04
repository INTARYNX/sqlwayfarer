const assert = require('assert');
const BabelfishSqlParser = require('../database/BabelfishSqlParser');

// Real extracts from the AdventureWorks database (HumanResources schema) - they
// serve as fixtures representative of a real procedure T-SQL, not of a minimal
// synthetic SQL.

const USP_UPDATE_EMPLOYEE_HIRE_INFO = `
CREATE PROCEDURE [HumanResources].[uspUpdateEmployeeHireInfo]
    @BusinessEntityID [int],
    @JobTitle [nvarchar](50),
    @HireDate [datetime],
    @RateChangeDate [datetime],
    @Rate [money],
    @PayFrequency [tinyint],
    @CurrentFlag [dbo].[Flag]
WITH EXECUTE AS CALLER
AS
BEGIN
    SET NOCOUNT ON;

    BEGIN TRY
        BEGIN TRANSACTION;

        UPDATE [HumanResources].[Employee]
        SET [JobTitle] = @JobTitle
            ,[HireDate] = @HireDate
            ,[CurrentFlag] = @CurrentFlag
        WHERE [BusinessEntityID] = @BusinessEntityID;

        INSERT INTO [HumanResources].[EmployeePayHistory]
            ([BusinessEntityID]
            ,[RateChangeDate]
            ,[Rate]
            ,[PayFrequency])
        VALUES
            (@BusinessEntityID
            ,@RateChangeDate
            ,@Rate
            ,@PayFrequency);

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;
        EXECUTE [dbo].[uspLogError];
    END CATCH;
END;
`;

const UPDATE_WITH_FROM_JOIN = `
CREATE PROCEDURE dbo.uspDisableOrdersForBadCustomers
AS
BEGIN
    UPDATE Sales.SalesOrderHeader
    SET Status = 6
    FROM Sales.SalesOrderHeader o
    JOIN Sales.Customer c ON c.CustomerID = o.CustomerID
    WHERE c.Disabled = 1;
END;
`;

const SELECT_WITH_JOIN = `
CREATE VIEW dbo.vEmployeeDepartment
AS
SELECT e.BusinessEntityID, d.Name
FROM HumanResources.Employee e
JOIN HumanResources.EmployeeDepartmentHistory edh ON edh.BusinessEntityID = e.BusinessEntityID
JOIN HumanResources.Department d ON d.DepartmentID = edh.DepartmentID;
`;

function parse(sql) {
	const parser = new BabelfishSqlParser();
	parser.setEnabled(true);
	return parser.analyzeOperations(sql);
}

suite('BabelfishSqlParser', () => {
	test('disabled parser returns null without attempting to parse', () => {
		const parser = new BabelfishSqlParser();
		assert.strictEqual(parser.analyzeOperations(USP_UPDATE_EMPLOYEE_HIRE_INFO), null);
	});

	test('detects UPDATE and INSERT targets in HumanResources.uspUpdateEmployeeHireInfo', () => {
		const result = parse(USP_UPDATE_EMPLOYEE_HIRE_INFO);

		assert.deepStrictEqual(result['humanresources.employee'], ['UPDATE']);
		assert.deepStrictEqual(result['humanresources.employeepayhistory'], ['INSERT']);
	});

	test('does not classify EXECUTE calls or parameter-type references as operations', () => {
		const result = parse(USP_UPDATE_EMPLOYEE_HIRE_INFO);

		// Known / documented in the README as a limitation: the EXEC of
		// another procedure and a parameter type reference produce no entry
		// in the map.
		assert.strictEqual(result['dbo.uspLogError'], undefined);
		assert.strictEqual(result['dbo.flag'], undefined);
	});

	test('treats the FROM/JOIN clause of an UPDATE as SELECT, in addition to the UPDATE target', () => {
		const result = parse(UPDATE_WITH_FROM_JOIN);

		// Sales.SalesOrderHeader is both the UPDATE target and re-read via its alias in FROM.
		assert.deepStrictEqual(result['sales.salesorderheader'].sort(), ['SELECT', 'UPDATE']);
		assert.deepStrictEqual(result['sales.customer'], ['SELECT']);
	});

	test('collects every joined table in a SELECT as SELECT', () => {
		const result = parse(SELECT_WITH_JOIN);

		assert.deepStrictEqual(result['humanresources.employee'], ['SELECT']);
		assert.deepStrictEqual(result['humanresources.employeedepartmenthistory'], ['SELECT']);
		assert.deepStrictEqual(result['humanresources.department'], ['SELECT']);
	});
});

suite('BabelfishSqlParser: the fast SLL stage gives what the full parse gives', () => {
	const SAMPLES = [
		USP_UPDATE_EMPLOYEE_HIRE_INFO,
		'CREATE PROCEDURE p AS BEGIN SET NOCOUNT ON; WITH c AS (SELECT a FROM t) UPDATE u SET x = c.a FROM u JOIN c ON c.a = u.a; END',
		'CREATE PROCEDURE p AS INSERT INTO #t SELECT * FROM dbo.x; EXEC sp_executesql N\'SELECT 1\'; DELETE FROM dbo.y WHERE id = 1',
		'CREATE PROCEDURE p AS SELECT a, FROM t WHERE',   // a syntax error: the full parse takes over
		'SELECT 1 FROM',
		'not sql at all ((('
	];
	const both = definition => {
		const slow = new BabelfishSqlParser(); slow.setEnabled(true); slow._fastPrediction = false;
		const fast = new BabelfishSqlParser(); fast.setEnabled(true);
		const strip = analysis => { if (analysis) delete analysis.parseTimeMs; return JSON.stringify(analysis); };
		return [strip(slow.analyzeDefinition(definition)), strip(fast.analyzeDefinition(definition))];
	};

	test('the same analysis, for correct text and for text with syntax errors', () => {
		for (const definition of SAMPLES) {
			const [slow, fast] = both(definition);
			assert.strictEqual(fast, slow, definition.slice(0, 60));
		}
	});

	test('the syntax errors are still reported (the full parse collects them)', () => {
		const parser = new BabelfishSqlParser(); parser.setEnabled(true);
		const analysis = parser.analyzeDefinition('CREATE PROCEDURE p AS SELECT a, FROM t WHERE');
		assert.ok(analysis && analysis.errors.length > 0);
		const clean = parser.analyzeDefinition('CREATE PROCEDURE p AS SELECT a FROM t');
		assert.ok(clean && clean.errors.length === 0);
	});
});
