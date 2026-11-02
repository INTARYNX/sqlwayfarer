const assert = require('assert');
const { formatSqlScript } = require('../webview-build/formatSql');

suite('formatSqlScript', () => {
	test('upper-cases the keywords and lays the clauses out', () => {
		const out = formatSqlScript('select e.ID from dbo.Employees e join dbo.Depts d on d.DeptID=e.DeptID where e.Salary>1000');
		assert.ok(out.includes('SELECT\n    e.ID'));
		assert.ok(out.includes('JOIN dbo.Depts d ON d.DeptID = e.DeptID'));
		assert.ok(out.includes('WHERE\n    e.Salary > 1000'));
	});

	test('GO lines are kept as they are, each batch formatted on its own', () => {
		const out = formatSqlScript('select 1\nGO\nselect 2\ngo 3\nselect 3');
		const lines = out.split('\n');
		assert.ok(lines.includes('GO'));
		assert.ok(lines.includes('go 3'), 'GO keeps its text and its repeat count');
		assert.strictEqual(lines.filter(l => /^SELECT/.test(l)).length, 3);
	});

	test('comments survive', () => {
		const out = formatSqlScript('select 1 -- one\n/* block */ from t');
		assert.ok(out.includes('-- one') && out.includes('/* block */'));
	});

	test('T-SQL specifics: variables, temp tables, CTE, OUTPUT', () => {
		const out = formatSqlScript('declare @id int=1; with c as (select 1 as x) insert #t (a) output inserted.a select x from c where x=@id');
		assert.ok(out.includes('@id') && out.includes('#t') && /output/i.test(out));
	});

	test('an unparseable batch returns null, so the text is left alone', () => {
		assert.strictEqual(formatSqlScript('select from where ((('), null);
	});

	test('a blank script is returned unchanged', () => {
		assert.strictEqual(formatSqlScript('  \n'), '  \n');
	});
});
