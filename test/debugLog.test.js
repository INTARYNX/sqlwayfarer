const assert = require('assert');
const debug = require('../database/debugLog');

suite('debugLog', () => {
	let lines;
	let original;
	let flag;
	setup(() => {
		lines = [];
		flag = process.env.SQLWAYFARER_DEBUG;
		// The console of the extension host cannot be replaced - its
		// console.log is a getter that ignores the assignments - so the
		// module is given another sink to write to.
		original = debug.setSink((...args) => lines.push(args.join(' ')));
	});
	teardown(() => {
		debug.setSink(original);
		if (flag === undefined) delete process.env.SQLWAYFARER_DEBUG; else process.env.SQLWAYFARER_DEBUG = flag;
	});

	test('says nothing unless SQLWAYFARER_DEBUG is set', () => {
		delete process.env.SQLWAYFARER_DEBUG;
		debug('Index complete');
		assert.deepStrictEqual(lines, []);
	});

	test('prints when SQLWAYFARER_DEBUG is set', () => {
		process.env.SQLWAYFARER_DEBUG = '1';
		debug('Index complete', 3);
		assert.deepStrictEqual(lines, ['Index complete 3']);
	});
});
