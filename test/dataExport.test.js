const assert = require('assert');
const { buildDataExportFiles } = require('../database/dataExport');

const baseTable = extra => Object.assign({
	schema: 'dbo', name: 'T', key: ['id'], columns: ['id', 'name'],
	columnTypes: { id: 'int', name: 'nvarchar(50)' }, identityColumn: null,
	added: [], removed: [], modified: []
}, extra);

const content = (files, path) => files.find(f => f.path === path).content;

suite('dataExport: buildDataExportFiles', () => {
	test('only the picked tables are counted and put in changes.csv', () => {
		const t = baseTable({ added: [{ id: 1, name: 'a' }], removed: [{ id: 2, name: 'b' }] });
		const other = baseTable({ name: 'Other', added: [{ id: 1, name: 'x' }] });
		const { files, count } = buildDataExportFiles([t, other], { ids: ['dbo.T'] });
		assert.strictEqual(count, 1);
		assert.deepStrictEqual(files.map(f => f.path), ['README.txt', 'changes.csv', 'data_script.sql']);
		const csv = content(files, 'changes.csv');
		assert.ok(csv.includes('dbo.T,1,0,1'));
		assert.ok(!csv.includes('Other'));
	});

	test('the script inside the zip is the same the "Script to editor" action would build', () => {
		const t = baseTable({ added: [{ id: 1, name: 'a' }] });
		const { files, steps } = buildDataExportFiles([t], { ids: ['dbo.T'] });
		assert.strictEqual(steps, 1);
		assert.match(content(files, 'data_script.sql'), /MERGE INTO \[dbo\]\.\[T\]/);
	});

	test('nothing picked: an empty, but still valid, export', () => {
		const { files, count, steps } = buildDataExportFiles([baseTable()], { ids: [] });
		assert.strictEqual(count, 0);
		assert.strictEqual(steps, 0);
		assert.ok(content(files, 'changes.csv').startsWith('﻿table,added,modified,removed'));
	});
});
