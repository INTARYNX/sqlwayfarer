const assert = require('assert');
const WriteFootprintService = require('../database/WriteFootprintService');

// Minimal index entry factory.
function obj(qualifiedName, type, { columnRefs = {}, dependencies = [], possibleRefs = [] } = {}) {
    const [schema, name] = qualifiedName.split('.');
    return { qualifiedName, schema, name, type, columnRefs, dependencies, possibleRefs };
}

// Scenario:
//   app.P (proc)  writes app.T, reads app.R, calls app.P2, references app.Ext (external/unresolved)
//   app.P2 (proc) writes app.W
//   app.T has trigger app.trg   -> writes app.A
//   app.A has trigger app.trg2  -> writes app.T   (cycle back to T)
//   app.R has trigger app.trgR  -> DISABLED, must not fire
function makeIndex() {
    const objects = {};
    const add = e => { objects[e.qualifiedName] = e; };

    add(obj('app.P', 'P', {
        columnRefs: { 'app.T': { c: { write: true } }, 'app.R': { c: { write: false } } },
        dependencies: ['app.T', 'app.R', 'app.P2', 'app.Ext'],
        // Dynamic-SQL name scan: app.Dyn only mentioned in text; app.T also
        // mentioned but is written confidently and must stay 'write'.
        possibleRefs: ['app.Dyn', 'app.T']
    }));
    add(obj('app.P2', 'P', {
        columnRefs: { 'app.W': { c: { write: true } } },
        dependencies: ['app.W']
    }));
    add(obj('app.trg', 'TR', {
        columnRefs: { 'app.A': { c: { write: true } } },
        dependencies: ['app.A', 'app.T']
    }));
    add(obj('app.trg2', 'TR', {
        columnRefs: { 'app.T': { c: { write: true } } },
        dependencies: ['app.T', 'app.A']
    }));
    add(obj('app.trgR', 'TR', { columnRefs: { 'app.R': { c: { write: true } } }, dependencies: ['app.R'] }));

    for (const t of ['app.T', 'app.R', 'app.A', 'app.W', 'app.Dyn']) add(obj(t, 'U'));

    return { objects };
}

const triggers = [
    { trigger: 'app.trg', parentTable: 'app.T', disabled: false },
    { trigger: 'app.trg2', parentTable: 'app.A', disabled: false },
    { trigger: 'app.trgR', parentTable: 'app.R', disabled: true }
];

function run(target = 'app.P') {
    return WriteFootprintService.analyzeFootprint({ index: makeIndex(), triggers, target });
}

suite('WriteFootprintService.analyzeFootprint', () => {
    test('returns not found for an unknown object', () => {
        const r = WriteFootprintService.analyzeFootprint({ index: makeIndex(), triggers, target: 'app.Nope' });
        assert.strictEqual(r.found, false);
    });

    test('classifies direct reads and writes', () => {
        const r = run();
        const t = r.tables.find(x => x.qualifiedName === 'app.T');
        const rd = r.tables.find(x => x.qualifiedName === 'app.R');
        assert.strictEqual(t.access, 'write');
        assert.strictEqual(t.viaTriggerOnly, false, 'T is written directly, not only via trigger');
        assert.strictEqual(rd.access, 'read');
    });

    test('follows nested procedure calls', () => {
        const w = run().tables.find(x => x.qualifiedName === 'app.W');
        assert.ok(w, 'table written by a called proc is in the footprint');
        assert.strictEqual(w.access, 'write');
        assert.strictEqual(w.viaTriggerOnly, false);
    });

    test('follows trigger cascade on written tables and flags trigger-only tables', () => {
        const r = run();
        const a = r.tables.find(x => x.qualifiedName === 'app.A');
        assert.ok(a, 'table written by a trigger is in the footprint');
        assert.strictEqual(a.access, 'write');
        assert.strictEqual(a.viaTriggerOnly, true, 'A is reachable only through the trigger cascade');
        assert.ok(r.triggersFired.includes('app.trg'), 'trg fired (T written)');
        assert.ok(r.triggersFired.includes('app.trg2'), 'trg2 fired (A written via trigger)');
    });

    test('does not fire disabled triggers', () => {
        assert.ok(!run().triggersFired.includes('app.trgR'));
    });

    test('terminates on trigger cycles', () => {
        // trg -> A -> trg2 -> T -> trg ... must not loop forever.
        const r = run();
        assert.strictEqual(r.truncated, false, 'cycle handled without hitting the depth guard');
    });

    test('reports unresolved external references', () => {
        assert.ok(run().unresolved.includes('app.ext'));
    });

    test('surfaces dynamic-SQL name mentions as possible tables', () => {
        const dyn = run().tables.find(x => x.qualifiedName === 'app.Dyn');
        assert.ok(dyn, 'a table only mentioned by name is included');
        assert.strictEqual(dyn.access, 'possible');
    });

    test('a confidently written table is not downgraded to possible', () => {
        const t = run().tables.find(x => x.qualifiedName === 'app.T');
        assert.strictEqual(t.access, 'write', 'confident write wins over a name mention');
    });
});

suite('WriteFootprintService.foreignKeysAmong', () => {
    const fks = [
        { fkName: 'FK_Order_Customer', fromTable: 'app.Order', fromColumn: 'CustomerID', toTable: 'app.Customer', toColumn: 'CustomerID' },
        { fkName: 'FK_Order_Ext', fromTable: 'app.Order', fromColumn: 'X', toTable: 'other.Thing', toColumn: 'Id' },
        // multi-column FK -> should collapse to a single edge
        { fkName: 'FK_Multi', fromTable: 'app.A', fromColumn: 'c1', toTable: 'app.B', toColumn: 'c1' },
        { fkName: 'FK_Multi', fromTable: 'app.A', fromColumn: 'c2', toTable: 'app.B', toColumn: 'c2' }
    ];
    const tables = [{ qualifiedName: 'app.Order' }, { qualifiedName: 'app.Customer' }, { qualifiedName: 'app.A' }, { qualifiedName: 'app.B' }];

    test('keeps only edges whose both ends are in the footprint', () => {
        const edges = WriteFootprintService.foreignKeysAmong(fks, tables);
        assert.ok(edges.some(e => e.fkName === 'FK_Order_Customer'));
        assert.ok(!edges.some(e => e.fkName === 'FK_Order_Ext'), 'edge to a table outside the footprint is dropped');
    });

    test('collapses multi-column FKs to one edge', () => {
        const edges = WriteFootprintService.foreignKeysAmong(fks, tables);
        assert.strictEqual(edges.filter(e => e.fkName === 'FK_Multi').length, 1);
    });
});
