const { loadPlaywright, openPage, post, checker } = require('./harness');

const playwright = loadPlaywright();

// A small actual plan: Nested Loops (self cost 20%) over an Index Seek (30%,
// no warning) and an Index Scan (50%, flagged for missing statistics) - same
// shape (and same hand-checked cost %) as webview/queryPlanAnalyzer.js's own
// unit tests, rendered here through the real html-query-plan library instead
// of just the analyzer, so the data-statement-id/data-node-id selector
// syncPlanDiagramNode relies on is checked against that library's real
// output, not just a reading of its source.
const PLAN_XML = `<?xml version="1.0"?>
<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.5" Build="16.0">
  <BatchSequence><Batch><Statements>
    <StmtSimple StatementId="1" StatementText="SELECT * FROM T1 JOIN T2 ON T1.Id = T2.Id">
      <QueryPlan>
        <RelOp NodeId="0" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="10" AvgRowSize="50" EstimatedTotalSubtreeCost="1.0">
          <NestedLoops>
            <RelOp NodeId="1" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="1" AvgRowSize="20" EstimatedTotalSubtreeCost="0.3">
              <IndexScan>
                <Object Schema="[dbo]" Table="[T1]" Index="[IX_T1]" />
              </IndexScan>
              <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="1" ActualExecutions="1" /></RunTimeInformation>
            </RelOp>
            <RelOp NodeId="2" PhysicalOp="Index Scan" LogicalOp="Index Scan" EstimateRows="100" AvgRowSize="30" EstimatedTotalSubtreeCost="0.5">
              <IndexScan>
                <Object Schema="[dbo]" Table="[T2]" />
                <Warnings><ColumnsWithNoStatistics /></Warnings>
              </IndexScan>
              <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="100" ActualExecutions="1" /></RunTimeInformation>
            </RelOp>
          </NestedLoops>
          <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="1" ActualExecutions="1" /></RunTimeInformation>
        </RelOp>
      </QueryPlan>
    </StmtSimple>
  </Statements></Batch></BatchSequence>
</ShowPlanXML>`;

// A one-operator estimated plan (no RunTimeInformation at all) on a
// different table, distinct enough from PLAN_XML to catch the two being
// mixed up across query tabs.
const PLAN_XML_B = `<?xml version="1.0"?>
<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.5" Build="16.0">
  <BatchSequence><Batch><Statements>
    <StmtSimple StatementId="1" StatementText="SELECT * FROM T9">
      <QueryPlan>
        <RelOp NodeId="0" PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Index Scan" EstimateRows="5" AvgRowSize="40" EstimatedTotalSubtreeCost="0.2">
          <IndexScan><Object Schema="[dbo]" Table="[T9]" /></IndexScan>
        </RelOp>
      </QueryPlan>
    </StmtSimple>
  </Statements></Batch></BatchSequence>
</ShowPlanXML>`;

suite('e2e: the execution plan\'s Top Operations tabular view', function () {
	this.timeout(120000);
	let browser;
	suiteSetup(async function () {
		if (!playwright) this.skip();
		browser = await playwright.chromium.launch();
	});
	suiteTeardown(async () => { if (browser) await browser.close(); });

	test('lists every operator, sorted by cost %, filters, and syncs a row to the diagram', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 760 });
		await post(p, { command: 'connectionStatus', success: true, message: 'ok' });
		await post(p, { command: 'databasesLoaded', databases: ['master'], currentDatabase: 'master' });
		await post(p, { command: 'planResult', planXmls: [PLAN_XML] });

		// Top Operations is the sub-tab shown by default, not the diagram.
		check(await p.$eval('.plan-subtab[data-plan-subtab="topops"]', el => el.classList.contains('active')), 'Top Operations starts active');
		check(await p.$eval('.plan-subpane[data-plan-subpane="diagram"]', el => el.style.display === 'none'), 'the diagram sub-pane starts hidden');

		const operationCells = () => p.$$eval('.plan-op-row td:nth-child(1)', cells => cells.map(c => c.textContent.trim()));
		check((await operationCells()).join(' | ') === 'Index Scan | Index Seek | Nested Loops (Inner Join)',
			'sorted by cost % descending by default: ' + (await operationCells()).join(' | '));
		const costCells = () => p.$$eval('.plan-op-row td:nth-child(6)', cells => cells.map(c => c.textContent.trim()));
		check((await costCells()).join(',') === '50.0%,30.0%,20.0%', 'the cost % column: ' + (await costCells()).join(','));

		// No "Statement" column (one statement only); "Act. Rows"/"Act. Executions" present (this is an actual plan).
		const headers = () => p.$$eval('.plan-ops-table-wrap th', ths => ths.map(th => th.textContent.trim()));
		check((await headers()).join(',') === 'Operation,Object,Est. Rows,Act. Rows,Act. Executions,Cost %,Subtree Cost,Avg Row Size',
			'columns: ' + (await headers()).join(','));

		// The scan's missing-statistics warning shows as a badge, with its label in the tooltip.
		check(await p.$('.plan-op-row .plan-op-warning[title="Columns with no statistics"]') !== null, 'the warning badge carries its label');

		// Filtering to the seek narrows the list to one row.
		await p.fill('input[data-plan-filter]', 'seek');
		check((await operationCells()).length === 1 && (await operationCells())[0].startsWith('Index Seek'), 'filtering to "seek" leaves one row');
		await p.fill('input[data-plan-filter]', '');

		// Clicking the scan's row jumps to the diagram and highlights its node -
		// the real html-query-plan output, not just the analyzer's own data.
		await p.click('.plan-op-row:has-text("Index Scan")');
		check(await p.$eval('.plan-subtab[data-plan-subtab="diagram"]', el => el.classList.contains('active')), 'clicking a row switches to the diagram sub-tab');
		check(await p.$('.qp-node[data-node-id="2"].qp-node-highlight') !== null, 'the matching node is highlighted');
		check(await p.$('.qp-node[data-node-id="1"].qp-node-highlight') === null, 'only that node is highlighted');

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		check.done();
		await p.close();
	});

	test('each query tab keeps its own plan - and its own pending diagram - switching away and back', async () => {
		const check = checker();
		const p = await openPage(browser, 'index.html', 'panels/SqlWayfarerPanel.js', 'dark', { width: 1100, height: 760 });
		await post(p, { command: 'connectionStatus', success: true, message: 'ok' });
		await post(p, { command: 'databasesLoaded', databases: ['master'], currentDatabase: 'master' });

		// Tab 1 gets the 3-operator plan; its diagram is left unopened (still
		// pending - see renderPendingPlanIfVisible) when we leave the tab.
		await post(p, { command: 'planResult', planXmls: [PLAN_XML] });
		const operationCells = () => p.$$eval('.plan-op-row td:nth-child(1)', cells => cells.map(c => c.textContent.trim()));
		check((await operationCells()).length === 3, 'tab 1 shows its 3 operators');

		// A second, empty tab, with a one-operator estimated (no Act. columns) plan of its own.
		await p.evaluate(() => window.queryFileManager.addDraftTab());
		await post(p, { command: 'planResult', planXmls: [PLAN_XML_B] });
		check((await operationCells()).length === 1 && (await operationCells())[0].startsWith('Clustered Index Scan'),
			'tab 2 shows its own single operator: ' + (await operationCells()).join(' | '));
		check((await p.$$eval('.plan-ops-table-wrap th', ths => ths.map(th => th.textContent.trim()))).includes('Act. Rows') === false,
			'tab 2 is an estimated plan: no Act. Rows column');

		// Back to tab 1: its own 3 operators, not tab 2's - then its own diagram, not tab 2's.
		await p.evaluate(() => window.queryFileManager.switchTab(window.queryFileManager.tabs[0].id));
		check((await operationCells()).length === 3, 'back on tab 1, its 3 operators are still there');
		await p.click('.plan-op-row:has-text("Index Scan")');
		check(await p.$('.qp-node[data-node-id="2"].qp-node-highlight') !== null, 'tab 1\'s own diagram renders and highlights its own node');
		check(await p.$('.qp-node-outer:has-text("T9")') === null, 'tab 2\'s plan never leaked into tab 1\'s diagram');

		check(p.errors.length === 0, 'no page error: ' + p.errors.join(' | '));
		check.done();
		await p.close();
	});
});
