const assert = require('assert');
const QueryPlanAnalyzer = require('../webview/queryPlanAnalyzer');

const SHOWPLAN_HEADER = '<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan">';

function wrapStatements(statementsXml) {
	return `${SHOWPLAN_HEADER}<BatchSequence><Batch><Statements>${statementsXml}</Statements></Batch></BatchSequence></ShowPlanXML>`;
}

suite('QueryPlanAnalyzer', () => {
	test('flattens a plan tree, computing each operator\'s own cost % the same way the diagram does', () => {
		const xml = wrapStatements(`
			<StmtSimple StatementId="1" StatementText="SELECT * FROM T1 JOIN T2 ON T1.Id = T2.Id">
				<QueryPlan>
					<RelOp NodeId="0" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="10" AvgRowSize="50" EstimatedTotalSubtreeCost="1.0">
						<NestedLoops>
							<RelOp NodeId="1" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="1" AvgRowSize="20" EstimatedTotalSubtreeCost="0.3">
								<IndexScan><Object Schema="[dbo]" Table="[T1]" Index="[IX_T1]" /></IndexScan>
							</RelOp>
							<RelOp NodeId="2" PhysicalOp="Index Scan" LogicalOp="Index Scan" EstimateRows="100" AvgRowSize="30" EstimatedTotalSubtreeCost="0.5">
								<IndexScan>
									<Object Schema="[dbo]" Table="[T2]" />
									<Warnings><ColumnsWithNoStatistics /></Warnings>
								</IndexScan>
							</RelOp>
						</NestedLoops>
					</RelOp>
				</QueryPlan>
			</StmtSimple>`);

		const { rows, hasActual, multiStatement } = QueryPlanAnalyzer.analyze([xml]);

		assert.strictEqual(hasActual, false);
		assert.strictEqual(multiStatement, false);
		assert.strictEqual(rows.length, 3);

		const [root, seek, scan] = rows;
		assert.strictEqual(root.physicalOp, 'Nested Loops');
		assert.strictEqual(root.logicalOp, 'Inner Join');
		assert.ok(Math.abs(root.costPercent - 20) < 1e-9, `expected ~20, got ${root.costPercent}`);
		assert.strictEqual(seek.object, 'dbo.T1 (IX_T1)');
		assert.strictEqual(seek.costPercent, 30);
		assert.strictEqual(scan.object, 'dbo.T2');
		assert.deepStrictEqual(scan.warnings, ['Columns with no statistics']);
		assert.strictEqual(scan.costPercent, 50);
	});

	test('sums actual rows and executions across parallel threads, leaving operators without runtime info as null', () => {
		const xml = wrapStatements(`
			<StmtSimple StatementId="1" StatementText="SELECT 1">
				<QueryPlan>
					<RelOp NodeId="0" PhysicalOp="Nested Loops" EstimateRows="10" EstimatedTotalSubtreeCost="1.0">
						<NestedLoops>
							<RelOp NodeId="1" PhysicalOp="Index Seek" EstimateRows="1" EstimatedTotalSubtreeCost="0.3">
								<IndexScan />
								<RunTimeInformation>
									<RunTimeCountersPerThread Thread="0" ActualRows="10" ActualExecutions="1" />
									<RunTimeCountersPerThread Thread="1" ActualRows="15" ActualExecutions="2" />
								</RunTimeInformation>
							</RelOp>
						</NestedLoops>
					</RelOp>
				</QueryPlan>
			</StmtSimple>`);

		const { rows, hasActual } = QueryPlanAnalyzer.analyze([xml]);
		assert.strictEqual(hasActual, true);
		const [root, seek] = rows;
		assert.strictEqual(root.actualRows, null);
		assert.strictEqual(seek.actualRows, 25);
		assert.strictEqual(seek.actualExecutions, 3);
	});

	test('flags more than one statement and keeps each one\'s cost % relative to its own total', () => {
		const xml = wrapStatements(`
			<StmtSimple StatementId="1" StatementText="SELECT 1">
				<QueryPlan><RelOp NodeId="0" PhysicalOp="Constant Scan" EstimateRows="1" EstimatedTotalSubtreeCost="0.1" /></QueryPlan>
			</StmtSimple>
			<StmtSimple StatementId="2" StatementText="SELECT 2">
				<QueryPlan><RelOp NodeId="0" PhysicalOp="Constant Scan" EstimateRows="1" EstimatedTotalSubtreeCost="0.2" /></QueryPlan>
			</StmtSimple>`);

		const { rows, multiStatement } = QueryPlanAnalyzer.analyze([xml]);
		assert.strictEqual(multiStatement, true);
		assert.strictEqual(rows.length, 2);
		assert.strictEqual(rows[0].statementId, '1');
		assert.strictEqual(rows[0].costPercent, 100);
		assert.strictEqual(rows[1].statementId, '2');
		assert.strictEqual(rows[1].costPercent, 100);
	});

	test('a batch that fails to parse contributes no rows, without breaking the others', () => {
		const good = wrapStatements('<StmtSimple StatementId="1" StatementText="SELECT 1"><QueryPlan><RelOp NodeId="0" PhysicalOp="Constant Scan" EstimateRows="1" EstimatedTotalSubtreeCost="0.1" /></QueryPlan></StmtSimple>');
		const { rows } = QueryPlanAnalyzer.analyze([good, 'not xml', '']);
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].planIndex, 0);
	});
});
