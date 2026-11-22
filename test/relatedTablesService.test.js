'use strict';

const assert = require('assert');
const RelatedTablesService = require('../database/RelatedTablesService');

function table(qualifiedName) {
	return { qualifiedName, type: 'U', dependencies: [] };
}

function proc(qualifiedName, dependencies) {
	return { qualifiedName, type: 'P', dependencies };
}

suite('RelatedTablesService.foreignKeyNeighbors', () => {
	test('a table with exactly one end of the FK in the set is a neighbor, labelled parent/child', () => {
		const fks = [
			{ fkName: 'FK_A_B', fromTable: 'dbo.A', toTable: 'dbo.B' }, // A holds the FK -> B is the referenced parent
			{ fkName: 'FK_C_A', fromTable: 'dbo.C', toTable: 'dbo.A' }  // C holds the FK -> C is a child of A
		];
		const neighbors = RelatedTablesService.foreignKeyNeighbors(fks, ['dbo.A']);
		const byName = Object.fromEntries(neighbors.map(n => [n.qualifiedName, n]));
		assert.strictEqual(neighbors.length, 2);
		assert.strictEqual(byName['dbo.B'].direction, 'parent');
		assert.strictEqual(byName['dbo.B'].anchorTable, 'dbo.A');
		assert.strictEqual(byName['dbo.C'].direction, 'child');
		assert.strictEqual(byName['dbo.C'].anchorTable, 'dbo.A');
	});

	test('an FK with both ends already in the set, or neither, is not a neighbor', () => {
		const fks = [
			{ fkName: 'FK_A_B', fromTable: 'dbo.A', toTable: 'dbo.B' },
			{ fkName: 'FK_D_E', fromTable: 'dbo.D', toTable: 'dbo.E' }
		];
		assert.deepStrictEqual(RelatedTablesService.foreignKeyNeighbors(fks, ['dbo.A', 'dbo.B']), []);
	});

	test('the same neighbor reached by two FKs is listed once', () => {
		const fks = [
			{ fkName: 'FK1', fromTable: 'dbo.A', toTable: 'dbo.B' },
			{ fkName: 'FK2', fromTable: 'dbo.A', toTable: 'dbo.B' }
		];
		assert.strictEqual(RelatedTablesService.foreignKeyNeighbors(fks, ['dbo.A']).length, 1);
	});
});

suite('RelatedTablesService.usageNeighbors', () => {
	test('ranks neighbor tables by how many distinct objects touch them alongside the set', () => {
		const index = {
			objects: {
				A: table('dbo.A'), B: table('dbo.B'), C: table('dbo.C'), D: table('dbo.D'),
				P1: proc('dbo.P1', ['dbo.A', 'dbo.B']),
				P2: proc('dbo.P2', ['dbo.A', 'dbo.B', 'dbo.C']),
				P3: proc('dbo.P3', ['dbo.D'])
			}
		};
		const neighbors = RelatedTablesService.usageNeighbors(index, ['dbo.A']);
		assert.deepStrictEqual(neighbors.map(n => n.qualifiedName), ['dbo.B', 'dbo.C']);
		assert.strictEqual(neighbors[0].procCount, 2);
		assert.deepStrictEqual(neighbors[0].procedures, ['dbo.P1', 'dbo.P2']);
		assert.strictEqual(neighbors[0].anchorTable, 'dbo.A');
		assert.strictEqual(neighbors[1].procCount, 1);
	});

	test('only tables are reported as neighbors, not a referenced view or function', () => {
		const index = {
			objects: {
				A: table('dbo.A'), V: { qualifiedName: 'dbo.V', type: 'V', dependencies: [] },
				P1: proc('dbo.P1', ['dbo.A', 'dbo.V'])
			}
		};
		assert.deepStrictEqual(RelatedTablesService.usageNeighbors(index, ['dbo.A']), []);
	});

	test('an object that does not touch the set at all contributes nothing', () => {
		const index = {
			objects: {
				A: table('dbo.A'), B: table('dbo.B'), Z: table('dbo.Z'),
				P1: proc('dbo.P1', ['dbo.B', 'dbo.Z'])
			}
		};
		assert.deepStrictEqual(RelatedTablesService.usageNeighbors(index, ['dbo.A']), []);
	});
});

suite('RelatedTablesService.merge', () => {
	test('an FK neighbor also found by usage keeps its FK label, with the usage count attached', () => {
		const fkNeighbors = [{ qualifiedName: 'dbo.B', via: 'fk', fkName: 'FK1', direction: 'parent' }];
		const usageNeighbors = [{ qualifiedName: 'dbo.B', via: 'usage', procCount: 5, procedures: ['dbo.P1'] }];
		const merged = RelatedTablesService.merge(fkNeighbors, usageNeighbors);
		assert.strictEqual(merged.length, 1);
		assert.strictEqual(merged[0].via, 'fk');
		assert.strictEqual(merged[0].procCount, 5);
	});

	test('a usage-only neighbor is kept as-is, after the FK ones', () => {
		const fkNeighbors = [{ qualifiedName: 'dbo.B', via: 'fk', fkName: 'FK1', direction: 'parent' }];
		const usageNeighbors = [{ qualifiedName: 'dbo.C', via: 'usage', procCount: 2, procedures: ['dbo.P1', 'dbo.P2'] }];
		const merged = RelatedTablesService.merge(fkNeighbors, usageNeighbors);
		assert.deepStrictEqual(merged.map(m => m.qualifiedName), ['dbo.B', 'dbo.C']);
		assert.strictEqual(merged[1].via, 'usage');
	});
});
