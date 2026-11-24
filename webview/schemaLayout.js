'use strict';

// The layout of the Schema tab - the relational ER of the footprint tables.
// ELK (elkjs) says where each table goes, Cytoscape keeps drawing them and
// their edges as before: the two are separate, so this file only builds the
// graph ELK lays out and reads its answer back. It touches no DOM of its
// own, which keeps it unit-testable.
class SchemaLayout {
    // The ELK options of a relational schema.
    static options() {
        return {
            // The layered layout (Sugiyama): the tables are put in layers
            // along the foreign keys, from the child to the parent.
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            // Room between two layers (the foreign-key arrows have to be
            // readable) and between two tables of the same layer.
            'elk.layered.spacing.nodeNodeBetweenLayers': '80',
            'elk.spacing.nodeNode': '35',
            'elk.spacing.edgeNode': '20',
            'elk.layered.spacing.edgeNodeBetweenLayers': '20',
            // A relational schema is full of cycles - a table can reference
            // itself, two tables can reference each other: they are broken
            // before the layers are computed.
            'elk.layered.cycleBreaking.strategy': 'greedy',
            'elk.layered.layering.strategy': 'network-simplex',
            // Fewer crossing arrows: the layers are swept, then the order of
            // the tables inside a layer is improved (Brandes-Köpf).
            'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
            'elk.layered.crossingMinimization.semiInteractive': 'true',
            'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
            // Cytoscape draws the edges itself (its own curves): ELK only
            // places the tables, so it does not have to reserve room for a
            // routing that nobody draws.
            'elk.edgeRouting': 'POLYLINE',
            'elk.padding': '[top=20,left=20,bottom=20,right=20]'
        };
    }

    // The ELK graph of the tables and of the edges between them.
    //   nodes: [{ id, width, height }] - the size Cytoscape gave the table
    //   edges: [{ id, source, target }] - an edge whose two ends are not
    //          among the nodes is left out: ELK would refuse the graph.
    static buildGraph(nodes, edges) {
        const known = new Set(nodes.map(n => n.id));
        return {
            id: 'root',
            layoutOptions: SchemaLayout.options(),
            children: nodes.map(n => ({ id: n.id, width: n.width, height: n.height })),
            edges: edges
                .filter(e => known.has(e.source) && known.has(e.target))
                .map(e => ({ id: e.id, sources: [e.source], targets: [e.target] }))
        };
    }

    // Puts the tables where ELK put them: ELK gives the top-left corner of a
    // table, Cytoscape places a node by its center. Returns how many tables
    // were moved.
    static apply(cy, elkLayout) {
        const placed = {};
        for (const child of (elkLayout && elkLayout.children) || []) {
            placed[child.id] = { x: child.x + child.width / 2, y: child.y + child.height / 2 };
        }
        let moved = 0;
        cy.nodes().forEach(node => {
            const position = placed[node.id()];
            if (!position) return;
            node.position(position);
            moved++;
        });
        return moved;
    }
}

// Allow unit tests to require() this file; in the webview `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SchemaLayout;
}
