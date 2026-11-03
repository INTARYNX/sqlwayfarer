const assert = require('assert');
const { RecentChanges } = require('../webview/recentChanges');

const item = (extra) => Object.assign({ kind: 'table', schema: 'dbo', name: 'T', status: 'altered', parent: null }, extra);

suite('RecentChanges (what it shows)', () => {
	test('an age reads as a person says it', () => {
		const f = RecentChanges.formatAge;
		assert.strictEqual(f(0), 'just now');
		assert.strictEqual(f(59), 'just now');
		assert.strictEqual(f(60), '1 min ago');
		assert.strictEqual(f(12 * 60 + 5), '12 min ago');
		assert.strictEqual(f(3600), '1 h ago');
		assert.strictEqual(f(3 * 3600 + 1800), '3 h ago');
		assert.strictEqual(f(86400), '1 day ago');
		assert.strictEqual(f(3 * 86400), '3 days ago');
		assert.strictEqual(f(-5), 'just now');
		assert.strictEqual(f(undefined), 'just now');
	});

	test('the filter looks at the name, the kind, the status and the table of a constraint', () => {
		const m = RecentChanges.matches;
		assert.ok(m(item(), ''));
		assert.ok(m(item({ name: 'Orders' }), 'order'));
		assert.ok(m(item({ kind: 'procedure' }), 'procedure'));
		assert.ok(m(item({ status: 'new' }), 'new'));
		assert.ok(m(item({ kind: 'constraint', name: 'CK_x', parent: 'Sales.Order' }), 'sales.order'));
		assert.ok(!m(item({ name: 'Orders' }), 'zzz'));
	});

	test('the summary counts the kinds, singular or plural, in a fixed order', () => {
		assert.strictEqual(RecentChanges.summaryText([item(), item({ name: 'U' }), item({ kind: 'procedure', name: 'p' }), item({ kind: 'constraint', name: 'c' }), item({ kind: 'function', name: 'f' }), item({ kind: 'function', name: 'g' })]),
			'2 tables · 2 functions · 1 procedure · 1 constraint');
		assert.strictEqual(RecentChanges.summaryText([item({ kind: 'synonym' })]), '1 synonym');
		assert.strictEqual(RecentChanges.summaryText([]), '');
	});

	test('an object is keyed by kind and name', () => {
		assert.strictEqual(RecentChanges.keyOf(item({ kind: 'view', schema: 'Sales', name: 'v' })), 'view:Sales.v');
	});
});
