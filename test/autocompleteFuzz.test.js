const assert = require('assert');
global.SqlContext = require('../webview/sqlContext');
global.SqlMatcher = require('../webview/sqlMatcher');
const SqlAutocomplete = require('../webview/sqlAutocomplete');
const SqlContext = global.SqlContext;

// Half-typed SQL is the normal input of an autocompletion: whatever the text
// and wherever the caret, nothing may throw and every suggestion must be
// something the editor can insert. Every caret position of a varied corpus is
// tried, with and without Ctrl+Space.
const CORPUS = {
	simple: 'SELECT e.ID, e.Name FROM dbo.Employees e WHERE e.ID > 10 ORDER BY e.Name;',
	joins: 'SELECT * FROM Employees e\nINNER JOIN Sales.Orders o ON o.ID = e.ID\nLEFT JOIN Sales.OrderLines l ON l.OrderID = o.OrderID\nWHERE o.Total > 100 GROUP BY e.Name HAVING COUNT(*) > 1',
	cte: 'WITH recent AS (SELECT ID, Name FROM Employees WHERE ID > 5), totals (id, total) AS (SELECT ID, SUM(Total) FROM Sales.Orders GROUP BY ID)\nSELECT r.Name, t.total FROM recent r JOIN totals t ON t.id = r.ID',
	subqueries: 'SELECT * FROM (SELECT ID, Name AS Who FROM Employees) d WHERE EXISTS (SELECT 1 FROM Sales.Orders o WHERE o.ID = d.ID) AND d.ID IN (SELECT ID FROM Employees)',
	temp: 'CREATE TABLE #t (id int, label varchar(10), CONSTRAINT pk PRIMARY KEY (id));\nINSERT INTO #t (id, label) VALUES (1, \'a\');\nSELECT t.label FROM #t t;\nSELECT ID, Name INTO #copy FROM Employees;\nGO\nSELECT * FROM #copy',
	variables: 'DECLARE @limit INT = 5, @name NVARCHAR(50);\nDECLARE @t TABLE (a int, b nvarchar(10));\nSELECT TOP (@limit) * FROM Employees WHERE Name = @name;\nSELECT a FROM @t',
	dml: 'UPDATE e SET e.Name = UPPER(e.Name) FROM Employees e WHERE e.ID = 1;\nDELETE FROM Sales.Orders WHERE Total < 0;\nINSERT INTO Employees (ID, Name) VALUES (1, \'x\'), (2, \'y\');\nMERGE Employees AS t USING Sales.Orders AS s ON t.ID = s.ID WHEN MATCHED THEN UPDATE SET t.Name = \'z\' WHEN NOT MATCHED THEN INSERT (ID) VALUES (s.ID);',
	procs: 'EXEC dbo.uspGetEmployees @Dept = 1, @Active = 0;\nEXECUTE uspGetEmployees;\nUSE AppDb;\nEXEC sp_who2',
	ddl: 'CREATE TABLE dbo.T (id int IDENTITY(1,1) PRIMARY KEY, name nvarchar(50) NOT NULL DEFAULT (\'x\'), CONSTRAINT fk FOREIGN KEY (id) REFERENCES dbo.U(id) ON DELETE CASCADE ON UPDATE CASCADE);\nCREATE TRIGGER trg ON dbo.T AFTER INSERT, UPDATE, DELETE AS SELECT * FROM inserted i;',
	control: 'IF EXISTS (SELECT 1 FROM Employees) BEGIN SELECT 1 END ELSE BEGIN SELECT 2 END\nWHILE @i < 3 BEGIN SET @i += 1 END\nBEGIN TRY SELECT 1/0 END TRY BEGIN CATCH THROW; END CATCH',
	literals: "SELECT 'it''s -- not a comment', [odd name], \"quoted\" /* FROM nothing */ FROM Employees -- trailing comment\n/* block\ncomment */ WHERE Name LIKE N'%é%'",
	unicode: 'SELECT Prénom, 名前, Straße FROM [Mitarbeiter Übersicht] m JOIN Größen g ON g.ID = m.ID',
	brackets: 'SELECT [e].[ID], [Order Details].[Qty] FROM [dbo].[Employees] [e] JOIN [Sales].[Order Details] ON 1=1 WHERE [e].[Name] = \'x\'',
	crossDb: 'SELECT * FROM Other.dbo.Employees o JOIN AppDb.Sales.Orders s ON s.ID = o.ID WHERE o.ID IN (SELECT ID FROM Other..Employees)',
	windows: 'SELECT ROW_NUMBER() OVER (PARTITION BY e.Name ORDER BY e.ID DESC) AS rn, COUNT(*) OVER () AS n, CAST(e.ID AS VARCHAR(10)) AS s FROM Employees e',
	unions: 'SELECT ID FROM Employees UNION ALL SELECT ID FROM Sales.Orders UNION SELECT 1 EXCEPT SELECT 2 INTERSECT SELECT 3',
	apply: 'SELECT e.Name, x.Total FROM Employees e CROSS APPLY (SELECT TOP 1 Total FROM Sales.Orders o WHERE o.ID = e.ID ORDER BY Total DESC) x OUTER APPLY dbo.fn_Tax(e.ID) t',
	hints: 'SELECT * FROM Employees WITH (NOLOCK) e2 JOIN Sales.Orders (NOLOCK) o ON 1=1 OPTION (RECOMPILE)',
	garbage: '(((( ))) ;;; ,,, ... [[[ ]]] \'\'\' """ -- /* */ @@ ## $$ \\ \u0000   SELECT FROM WHERE ON JOIN AS WITH GO GO GO'
};

const objects = [
	{ name: 'Employees', object_name: 'Employees', qualified_name: 'dbo.Employees', object_type: 'Table', schema_name: 'dbo' },
	{ name: 'Sales.Orders', object_name: 'Orders', qualified_name: 'Sales.Orders', object_type: 'Table', schema_name: 'Sales' },
	{ name: 'Sales.OrderLines', object_name: 'OrderLines', qualified_name: 'Sales.OrderLines', object_type: 'Table', schema_name: 'Sales' },
	{ name: 'Sales.vTotals', object_name: 'vTotals', qualified_name: 'Sales.vTotals', object_type: 'View', schema_name: 'Sales' },
	{ name: 'uspGetEmployees', object_name: 'uspGetEmployees', qualified_name: 'dbo.uspGetEmployees', object_type: 'Procedure', schema_name: 'dbo' },
	{ name: 'fn_Tax', object_name: 'fn_Tax', qualified_name: 'dbo.fn_Tax', object_type: 'Function', schema_name: 'dbo' },
	{ name: 'sys.objects', object_name: 'objects', qualified_name: 'sys.objects', object_type: 'View', schema_name: 'sys' }
];
const columns = {
	'dbo.employees': [{ name: 'ID', type: 'int', nullable: false, isPrimaryKey: true }, { name: 'Name', type: 'nvarchar(50)', nullable: true }],
	'sales.orders': [{ name: 'OrderID', type: 'int' }, { name: 'ID', type: 'int' }, { name: 'Total', type: 'money' }],
	'sales.orderlines': [{ name: 'OrderID', type: 'int' }, { name: 'Qty', type: 'int' }]
};
const foreignKeys = [
	{ fkName: 'FK_O_E', fromTable: 'Sales.Orders', toTable: 'dbo.Employees', fromColumn: 'ID', toColumn: 'ID' },
	{ fkName: 'FK_L_O', fromTable: 'Sales.OrderLines', toTable: 'Sales.Orders', fromColumn: 'OrderID', toColumn: 'OrderID' }
];

function env(overrides = {}) {
	return Object.assign({
		objects,
		databases: ['AppDb', 'Other'],
		currentDatabase: 'AppDb',
		foreignKeys,
		getColumns: (db, q) => columns[q.toLowerCase()],
		getParameters: () => [{ name: '@Dept', type: 'int' }],
		getDatabaseObjects: db => (db === 'Other' ? objects : undefined),
		settings: {},
		usage: new Map(),
		snippets: [{ name: 'mine', sql: 'SELECT 42' }],
		force: false
	}, overrides);
}

// What the editor does with an item: replace [partialStart, caret) by insert.
function applyItem(text, caret, result, item) {
	const start = item.replaceStart === undefined ? result.ctx.partialStart : item.replaceStart;
	return text.slice(0, start) + item.insert + text.slice(caret);
}

function checkResult(label, text, caret, result, maxItems) {
	assert.ok(Array.isArray(result.items), `${label}: items`);
	assert.ok(result.items.length <= maxItems, `${label}: at most ${maxItems} items, got ${result.items.length}`);
	assert.ok(Number.isInteger(result.ctx.partialStart) && result.ctx.partialStart >= 0 && result.ctx.partialStart <= caret, `${label}: partialStart ${result.ctx.partialStart} within [0, ${caret}]`);
	for (const arr of [result.needs.columns, result.needs.databaseObjects, result.needs.parameters]) assert.ok(Array.isArray(arr), `${label}: needs arrays`);
	for (const need of result.needs.columns) assert.ok(typeof need.database === 'string' && typeof need.qualifiedName === 'string', `${label}: column need`);
	const seen = new Set();
	for (const item of result.items) {
		assert.ok(typeof item.label === 'string' && item.label.length > 0, `${label}: label ${JSON.stringify(item)}`);
		assert.ok(typeof item.insert === 'string' && item.insert.length > 0, `${label}: insert ${JSON.stringify(item)}`);
		assert.ok(typeof item.kind === 'string', `${label}: kind`);
		assert.ok(!/undefined|NaN|\[object/.test(item.insert), `${label}: insert has junk: ${item.insert}`);
		assert.ok(!item.caretBack || (Number.isInteger(item.caretBack) && item.caretBack >= 0 && item.caretBack <= item.insert.length), `${label}: caretBack`);
		const start = item.replaceStart === undefined ? result.ctx.partialStart : item.replaceStart;
		assert.ok(start >= 0 && start <= caret, `${label}: replaceStart`);
		const applied = applyItem(text, caret, result, item);
		assert.strictEqual(applied.slice(0, start), text.slice(0, start), `${label}: text before the replaced range is untouched`);
		assert.strictEqual(applied.slice(start + item.insert.length), text.slice(caret), `${label}: text after the caret is untouched`);
		const key = `${item.kind}|${item.insert}|${item.detail}`;
		assert.ok(!seen.has(key) || item.kind === 'column' || item.kind === 'keyword', `${label}: duplicate ${key}`);
		seen.add(key);
	}
}

suite('autocomplete robustness: every caret position of a varied corpus', () => {
	for (const [name, text] of Object.entries(CORPUS)) {
		test(`${name}: never throws, always insertable`, () => {
			const step = text.length > 400 ? 3 : 1;
			for (let caret = 0; caret <= text.length; caret += step) {
				for (const force of [false, true]) {
					const label = `${name}@${caret}${force ? ' (forced)' : ''}`;
					let result;
					assert.doesNotThrow(() => { result = SqlAutocomplete.compute(text, caret, env({ force })); }, label);
					checkResult(label, text, caret, result, 20);
				}
			}
		});
	}

	test('the corpus really exercises every kind of suggestion', () => {
		const kinds = new Set();
		for (const text of Object.values(CORPUS)) {
			for (let caret = 0; caret <= text.length; caret += 2) {
				for (const item of SqlAutocomplete.compute(text, caret, env({ force: true })).items) kinds.add(item.kind);
			}
		}
		for (const kind of ['keyword', 'column', 'Table', 'View', 'Procedure', 'Function', 'function', 'schema', 'Database', 'alias', 'variable', 'cte', 'temp', 'joinCondition', 'columns', 'parameter', 'snippet']) {
			assert.ok(kinds.has(kind), `no "${kind}" suggestion anywhere in the corpus (got ${[...kinds].join(', ')})`);
		}
	});

	test('truncated at every length (the script being typed from the start)', () => {
		for (const [name, text] of Object.entries(CORPUS)) {
			for (let n = 0; n <= text.length; n += 2) {
				const part = text.slice(0, n);
				const result = SqlAutocomplete.compute(part, part.length, env({ force: true }));
				checkResult(`${name}[0..${n}]`, part, part.length, result, 20);
			}
		}
	});

	test('with every setting changed', () => {
		const variants = [
			{ enabled: false }, { matching: 'prefix' }, { matching: 'contains' }, { keywordCase: 'lower' }, { keywordCase: 'match' },
			{ bracketNames: 'always' }, { bracketNames: 'never' }, { columnQualification: 'always' }, { columnQualification: 'never' },
			{ addAlias: true }, { includeSystemObjects: true }, { snippets: false }, { maxItems: 5 }, { minChars: 0 }, { showTypes: false }
		];
		for (const settings of variants) {
			for (const name of ['joins', 'cte', 'temp', 'dml']) {
				const text = CORPUS[name];
				for (let caret = 0; caret <= text.length; caret += 5) {
					const result = SqlAutocomplete.compute(text, caret, env({ settings, force: true }));
					checkResult(`${JSON.stringify(settings)} ${name}@${caret}`, text, caret, result, SqlAutocomplete.normalizeSettings(settings).maxItems);
				}
			}
		}
	});

	test('the same input gives the same suggestions', () => {
		const text = CORPUS.joins;
		for (let caret = 0; caret <= text.length; caret += 7) {
			const strip = r => JSON.stringify(r.items.map(i => [i.kind, i.insert, i.detail]));
			assert.strictEqual(strip(SqlAutocomplete.compute(text, caret, env({ force: true }))), strip(SqlAutocomplete.compute(text, caret, env({ force: true }))));
		}
	});

	test('missing data in the environment is tolerated', () => {
		const bare = { objects: [], settings: {} };
		for (const [, text] of Object.entries(CORPUS)) {
			for (let caret = 0; caret <= text.length; caret += 9) {
				assert.doesNotThrow(() => SqlAutocomplete.compute(text, caret, Object.assign({ force: true }, bare)));
			}
		}
		assert.doesNotThrow(() => SqlAutocomplete.compute('SELECT * FROM x', 15, { settings: null, objects: undefined }));
	});
});

suite('autocomplete robustness: tokenizer and statements', () => {
	test('tokens never overlap, are ordered and cover only what they say', () => {
		for (const [name, text] of Object.entries(CORPUS)) {
			const { tokens } = SqlContext.tokenize(text);
			let end = 0;
			for (const t of tokens) {
				assert.ok(t.s >= end && t.e > t.s, `${name}: token ${JSON.stringify(t)} after ${end}`);
				if (t.t !== 'b') assert.strictEqual(text.slice(t.s, t.e), t.v, `${name}: token text`);
				end = t.e;
			}
		}
	});

	test('statements are ordered, disjoint, and every batch number only grows', () => {
		for (const [name, text] of Object.entries(CORPUS)) {
			const lexed = SqlContext._lex(text);
			let to = 0;
			let batch = 0;
			for (const st of lexed.statements) {
				assert.ok(st.from >= to && st.to > st.from, `${name}: statement range`);
				assert.ok(st.batch >= batch, `${name}: batch order`);
				to = st.to;
				batch = st.batch;
			}
		}
	});

	test('a big script is analyzed in a reasonable time', () => {
		const big = 'SELECT a, b FROM T t WHERE x = 1;\n'.repeat(6000) + 'SELECT * FROM Employees e WHERE e.';
		const start = process.hrtime.bigint();
		const result = SqlAutocomplete.compute(big, big.length, env());
		const ms = Number(process.hrtime.bigint() - start) / 1e6;
		assert.ok(result.items.length > 0);
		assert.ok(ms < 1500, `200 KB script took ${ms} ms`);
	});

	test('a big database is suggested from in a reasonable time', () => {
		const many = [];
		for (let i = 0; i < 20000; i++) {
			const schema = ['dbo', 'Sales', 'HR', 'Fin'][i % 4];
			const name = `Obj${['Order', 'Line', 'Total', 'Human', 'Cust'][i % 5]}Name${i}`;
			many.push({ name: schema === 'dbo' ? name : `${schema}.${name}`, object_name: name, schema_name: schema, qualified_name: `${schema}.${name}`, object_type: i % 7 ? 'Table' : 'View' });
		}
		const run = sql => {
			const start = process.hrtime.bigint();
			const result = SqlAutocomplete.compute(sql, sql.length, env({ objects: many }));
			return { ms: Number(process.hrtime.bigint() - start) / 1e6, result };
		};
		run('SELECT * FROM ho'); // warm up: builds the object index once
		for (const sql of ['SELECT * FROM ho', 'SELECT * FROM cstnm', 'SELECT * FROM ObjOrder', 'SELECT * FROM ']) {
			const { ms, result } = run(sql);
			assert.ok(result.items.length > 0, sql);
			assert.ok(ms < 400, `${sql}: ${ms} ms for 20 000 objects`);
		}
	});
});
