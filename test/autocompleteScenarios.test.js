const assert = require('assert');
global.SqlContext = require('../webview/sqlContext');
global.SqlMatcher = require('../webview/sqlMatcher');
const SqlAutocomplete = require('../webview/sqlAutocomplete');

// === Autocompletion scenarios: CTE, temp tables, table variables, table-valued functions... ===
//
// Each scenario is [text with the caret as '|', inserts that must be offered,
// inserts that must not be]. The schema is a small fake one (the same
// scenarios were also run against a real SQL Server).

const DB = 'sqlwf_adv';
const obj = (schema, name, type) => ({ name: schema === 'dbo' ? name : `${schema}.${name}`, object_name: name, qualified_name: `${schema}.${name}`, object_type: type, schema_name: schema });
const col = (name, type = 'int') => ({ name, type, nullable: true, isIdentity: false, isPrimaryKey: false });

const OBJECTS = {
	[DB]: [
		obj('dbo', 'Employees', 'Table'), obj('dbo', 'Depts', 'Table'), obj('dbo', 'Order Items', 'Table'), obj('dbo', 'vEmp', 'View'),
		obj('dbo', 'fnInline', 'Function'), obj('dbo', 'fnMulti', 'Function'), obj('dbo', 'fnScalar', 'Function'), obj('dbo', 'uspP', 'Procedure')
	],
	OtherDb: [obj('Person', 'Person', 'Table')]
};
const COLUMNS = {
	[`${DB}::dbo.employees`]: [col('ID'), col('Name', 'nvarchar(50)'), col('Salary', 'decimal(18,2)'), col('DeptID')],
	[`${DB}::dbo.depts`]: [col('DeptID'), col('DeptName', 'nvarchar(50)')],
	[`${DB}::dbo.order items`]: [col('Item ID'), col('Unit Price', 'money')],
	[`${DB}::dbo.vemp`]: [col('ID'), col('Name'), col('DeptName')],
	[`${DB}::dbo.fninline`]: [col('ID'), col('Name')],
	[`${DB}::dbo.fnmulti`]: [col('EmpID'), col('Label')],
	[`${DB}::dbo.fnscalar`]: [],
	'OtherDb::person.person': [col('BusinessEntityID'), col('FirstName'), col('LastName')]
};
const PARAMETERS = { [`${DB}::dbo.uspp`]: [{ name: '@a', type: 'int', isOutput: false }, { name: '@b', type: 'nvarchar(10)', isOutput: false }] };
const FOREIGN_KEYS = [];

const SCENARIOS = require('./support/autocompleteScenarios');

suite('Autocompletion scenarios (CTE, temp tables, table variables, functions)', () => {
	for (const [name, text0, must, mustNot = []] of SCENARIOS) {
		test(name, () => {
			const caret = text0.indexOf('|');
			const text = text0.replace('|', '');
			const env = {
				objects: OBJECTS[DB], foreignKeys: FOREIGN_KEYS, databases: ['master', DB, 'OtherDb'], currentDatabase: DB,
				getColumns: (db, q) => COLUMNS[`${db || DB}::${q.toLowerCase()}`],
				getParameters: (db, q) => PARAMETERS[`${db || DB}::${q.toLowerCase()}`],
				getDatabaseObjects: db => OBJECTS[db], settings: {}, usage: new Map(), force: true
			};
			const inserts = SqlAutocomplete.compute(text, caret, env).items.map(i => i.insert);
			for (const m of must) {
				// The default schema is written too: dbo.Employees is Employees.
				const bare = inserts.map(i => i.replace(/^dbo\./i, ''));
				assert.ok(bare.some(i => i === m || i.startsWith(m + ' ') || i.toLowerCase() === m.toLowerCase()), `${m} missing in: ${inserts.slice(0, 15)}`);
			}
			for (const m of mustNot) assert.ok(!inserts.includes(m), `${m} must not be offered`);
		});
	}
});
