const assert = require('assert');
const { IndexBuildStats, addRun, toMarkdown, MAX_RUNS } = require('../database/IndexStats');

const sampleRun = (extra = {}) => {
	const stats = new IndexBuildStats('full', 8);
	stats.phase('listObjectsMs', 12);
	stats.phase('analysisMs', 900);
	stats.phase('saveMs', 30);
	stats.recordObject({ name: 'dbo.T', type: 'U', queryMs: 5, parseMs: 0, scanMs: 0, definitionChars: 0 });
	stats.recordObject({ name: 'dbo.vA', type: 'V', queryMs: 20, parseMs: 40, scanMs: 2, definitionChars: 500 });
	stats.recordObject({ name: 'dbo.uspSlow', type: 'P', queryMs: 30, parseMs: 400, scanMs: 10, definitionChars: 9000, parseErrors: 2 });
	stats.recordObject({ name: 'dbo.uspBroken', type: 'P', queryMs: 15, parseMs: 5, scanMs: 1, definitionChars: 100, depsFailed: true });
	return Object.assign(stats.finish({ totalObjects: 10, reusedObjects: 6 }), extra);
};

suite('IndexBuildStats', () => {
	test('sums the objects, the types and the slowest', () => {
		const run = sampleRun();
		assert.strictEqual(run.mode, 'full');
		assert.strictEqual(run.analyzedObjects, 4);
		assert.strictEqual(run.totalObjects, 10);
		assert.strictEqual(run.reusedObjects, 6);
		assert.strictEqual(run.cumulative.queryMs, 70);
		assert.strictEqual(run.cumulative.parseMs, 445);
		assert.strictEqual(run.cumulative.definitionChars, 9600);
		assert.strictEqual(run.slowest[0].name, 'dbo.uspSlow');
		assert.strictEqual(run.slowest[0].totalMs, 440);
		assert.deepStrictEqual(run.byType.map(t => t.type), ['P', 'V', 'U']);
		assert.strictEqual(run.byType[0].count, 2);
		assert.deepStrictEqual(run.problems, { dependencyQueryFailed: 1, objectsWithParseErrors: 1 });
		assert.strictEqual(run.perObjectMs.max, 440);
		assert.deepStrictEqual(run.phases, { listObjectsMs: 12, analysisMs: 900, saveMs: 30 });
	});

	test('the wait for a parser thread is counted apart from the parse', () => {
		const stats = new IndexBuildStats('full', 8);
		stats.recordObject({ name: 'dbo.p', type: 'P', queryMs: 10, parseMs: 100, queueMs: 300, scanMs: 0, definitionChars: 50 });
		const run = stats.finish({ totalObjects: 1 });
		assert.strictEqual(run.cumulative.queueMs, 300);
		assert.strictEqual(run.cumulative.parseMs, 100);
		assert.strictEqual(run.slowest[0].totalMs, 410, 'the object latency holds the wait');
		assert.strictEqual(run.slowest[0].queueMs, 300);
	});

	test('a build that analyzed nothing is still a valid run', () => {
		const run = new IndexBuildStats('incremental', 8).finish({ totalObjects: 3, reusedObjects: 3 });
		assert.strictEqual(run.analyzedObjects, 0);
		assert.deepStrictEqual(run.slowest, []);
		assert.strictEqual(run.perObjectMs.max, 0);
	});

	test('the history keeps the latest runs first, capped', () => {
		let history = null;
		for (let i = 0; i < MAX_RUNS + 5; i++) history = addRun(history, sampleRun({ at: `run-${i}` }));
		assert.strictEqual(history.runs.length, MAX_RUNS);
		assert.strictEqual(history.runs[0].at, `run-${MAX_RUNS + 4}`);
	});

	test('the Markdown report names the figures', () => {
		const markdown = toMarkdown(sampleRun(), 'AppDb');
		assert.ok(markdown.includes('AppDb'));
		assert.ok(markdown.includes('4 object(s) analyzed (10 in the database, 6 reused)'));
		assert.ok(markdown.includes('| P | 2 |'));
		assert.strictEqual(toMarkdown(null), '');
	});
});
