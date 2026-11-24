const assert = require('assert');
const SchemaLayout = require('../webview/schemaLayout.js');

// A Cytoscape graph of two tables, as the Schema tab builds it.
const fakeGraph = (sizes) => ({
	nodes: () => ({
		forEach: fn => Object.keys(sizes).forEach(id => {
			const node = sizes[id];
			fn({ id: () => id, position: p => { node.x = p.x; node.y = p.y; } });
		})
	})
});

suite('the layout of the Schema tab', () => {
	test('the ELK graph holds the tables and the edges between them', () => {
		const graph = SchemaLayout.buildGraph(
			[{ id: 's::dbo.Orders', width: 180, height: 90 }, { id: 's::dbo.OrderLines', width: 190, height: 90 }],
			[{ id: 'e1', source: 's::dbo.OrderLines', target: 's::dbo.Orders' }]
		);
		assert.strictEqual(graph.children.length, 2);
		assert.deepStrictEqual(graph.children[0], { id: 's::dbo.Orders', width: 180, height: 90 });
		assert.deepStrictEqual(graph.edges, [{ id: 'e1', sources: ['s::dbo.OrderLines'], targets: ['s::dbo.Orders'] }]);
	});

	test('an edge whose end is not a table is left out: ELK would refuse it', () => {
		const graph = SchemaLayout.buildGraph(
			[{ id: 's::dbo.Orders', width: 180, height: 90 }],
			[{ id: 'e1', source: 's::dbo.Orders', target: 's::dbo.Gone' }]
		);
		assert.strictEqual(graph.edges.length, 0);
	});

	test('the options ask for a layered layout, from the child to the parent', () => {
		const options = SchemaLayout.options();
		assert.strictEqual(options['elk.algorithm'], 'layered');
		assert.strictEqual(options['elk.direction'], 'RIGHT');
		// A relational schema is full of cycles: they have to be broken.
		assert.ok(options['elk.layered.cycleBreaking.strategy'], 'the cycles are broken');
		// The tables of the same layer must not sit on top of each other.
		assert.ok(Number(options['elk.spacing.nodeNode']) > 0, 'there is room between two tables');
	});

	test('the positions of ELK are the centers of the tables', () => {
		const sizes = { 's::dbo.Orders': { x: null, y: null }, 's::dbo.OrderLines': { x: null, y: null } };
		const cy = fakeGraph(sizes);
		const moved = SchemaLayout.apply(cy, {
			children: [
				{ id: 's::dbo.Orders', x: 300, y: 40, width: 180, height: 90 },
				{ id: 's::dbo.OrderLines', x: 30, y: 200, width: 190, height: 90 }
			]
		});
		assert.strictEqual(moved, 2);
		assert.deepStrictEqual(sizes['s::dbo.Orders'], { x: 390, y: 85 });
		assert.deepStrictEqual(sizes['s::dbo.OrderLines'], { x: 125, y: 245 });
	});

	test('a table ELK did not place keeps its place', () => {
		const sizes = { 's::dbo.Orders': { x: 7, y: 9 } };
		const cy = fakeGraph(sizes);
		const moved = SchemaLayout.apply(cy, { children: [] });
		assert.strictEqual(moved, 0);
		assert.deepStrictEqual(sizes['s::dbo.Orders'], { x: 7, y: 9 });
	});
});
