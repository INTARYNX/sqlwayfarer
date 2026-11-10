const assert = require('assert');
const { buildExportFiles, sideText, fileName } = require('../database/compareExport');

const column = (name, extra) => Object.assign({ name, type: 'int', nullable: false, identity: null, computed: null, default: null, collation: null }, extra);
const table = (name, columns) => ({ schema: 'dbo', name, columns, primaryKey: null, uniques: [], indexes: [], foreignKeys: [], checks: [] });
const proc = (definition) => ({ schema: 'dbo', name: 'p', type: 'procedure', definition });

const DIFF = {
	changes: [
		{ kind: 'table', name: 'dbo.T', status: 'modified', reference: table('T', [column('id')]), current: table('T', [column('id'), column('x')]), ops: [{ op: 'addColumn', risk: 'safe', column: column('x') }] },
		{ kind: 'table', name: 'dbo.New', status: 'added', current: table('New', [column('id')]), ops: [{ op: 'createTable', risk: 'safe' }] },
		{ kind: 'table', name: 'dbo.Old', status: 'removed', reference: table('Old', [column('id')]), ops: [{ op: 'dropTable', risk: 'destructive' }] },
		{ kind: 'procedure', name: 'dbo.p', status: 'modified', reference: proc('CREATE PROC dbo.p AS SELECT 1'), current: proc('ALTER PROC dbo.p AS SELECT 2'), ops: [{ op: 'alter', risk: 'safe', what: ['definition'] }] },
		{ kind: 'schema', name: 'app', status: 'added', ops: [{ op: 'createSchema', risk: 'safe' }] }
	]
};
const LAST = { database: 'Db', reference: 'Ref', diff: DIFF, createOrAlter: true };
const paths = files => files.map(f => f.path);
const content = (files, path) => files.find(f => f.path === path).content;

suite('compareExport', () => {
	test('only the picked changes are exported, and a side that does not exist has no file', () => {
		const { files, count } = buildExportFiles(LAST, { ids: ['table:dbo.T', 'table:dbo.New', 'table:dbo.Old', 'procedure:dbo.p', 'schema:app'] });
		assert.strictEqual(count, 5);
		assert.deepStrictEqual(paths(files), [
			'README.txt', 'changes.csv', 'script.sql',
			'reference/table/dbo.T.sql', 'current/table/dbo.T.sql', 'current/table/dbo.New.sql', 'reference/table/dbo.Old.sql',
			'reference/procedure/dbo.p.sql', 'current/procedure/dbo.p.sql', 'current/schema/app.sql'
		]);
		assert.deepStrictEqual(paths(buildExportFiles(LAST, { ids: ['procedure:dbo.p'] }).files), ['README.txt', 'changes.csv', 'script.sql', 'reference/procedure/dbo.p.sql', 'current/procedure/dbo.p.sql']);
	});

	test('a module is its code as it is, a table its CREATE script on that side', () => {
		const { files } = buildExportFiles(LAST, { ids: ['table:dbo.T', 'procedure:dbo.p'] });
		assert.strictEqual(content(files, 'reference/procedure/dbo.p.sql'), 'CREATE PROC dbo.p AS SELECT 1\n');
		assert.strictEqual(content(files, 'current/procedure/dbo.p.sql'), 'ALTER PROC dbo.p AS SELECT 2\n');
		const before = content(files, 'reference/table/dbo.T.sql');
		const after = content(files, 'current/table/dbo.T.sql');
		assert.ok(before.includes('CREATE TABLE') && !before.includes('[x]'), before);
		assert.ok(after.includes('[x]'), after);
		assert.ok(!before.includes('SQL Wayfarer: the changes'), 'no header of a comparison');
		assert.strictEqual(sideText({ kind: 'view', status: 'modified', reference: { definition: null }, current: {} }, 'reference').startsWith('-- The definition cannot be read'), true);
	});

	test('the list says what each change is, and the script is the one of the picked changes', () => {
		const { files, steps } = buildExportFiles(LAST, { ids: ['table:dbo.T', 'table:dbo.Old'] });
		const csv = content(files, 'changes.csv').replace('﻿', '').split('\r\n');
		assert.deepStrictEqual(csv.slice(0, 3), [
			'kind,name,status,risk,reference,current',
			'table,dbo.T,modified,safe,reference/table/dbo.T.sql,current/table/dbo.T.sql',
			'table,dbo.Old,removed,destructive,reference/table/dbo.Old.sql,'
		]);
		assert.strictEqual(steps, 1, 'the destructive step is left out unless asked for');
		assert.ok(content(files, 'script.sql').includes('ADD [x]'));
		assert.strictEqual(buildExportFiles(LAST, { ids: ['table:dbo.Old'], allowDestructive: true }).steps, 1);
	});

	test('a name is a file name', () => {
		assert.strictEqual(fileName('dbo.a:b/c*d'), 'dbo.a_b_c_d');
	});
});
