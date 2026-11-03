const assert = require('assert');
const debug = require('../database/debugLog');

suite('debugLog', () => {
	let lines;
	let original;
	let flag;
	setup(() => {
		lines = [];
		original = console.log;
		flag = process.env.SQLWAYFARER_DEBUG;
		console.log = (...args) => lines.push(args.join(' '));
	});
	teardown(() => {
		console.log = original;
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
