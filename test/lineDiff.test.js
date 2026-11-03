const assert = require('assert');
const LineDiff = require('../webview/lineDiff');
const { normalizeDefinition } = require('../database/sqlHeader');

const shape = lines => lines.map(l => `${l.type === 'same' ? ' ' : l.type === 'add' ? '+' : '-'}${l.text}`);

suite('LineDiff.diff', () => {
	test('identical texts are all kept, numbered', () => {
		const lines = LineDiff.diff('a\nb', 'a\nb');
		assert.deepStrictEqual(shape(lines), [' a', ' b']);
		assert.deepStrictEqual(lines.map(l => [l.oldLine, l.newLine]), [[1, 1], [2, 2]]);
	});

	test('a changed line is one removed and one added, in place', () => {
		const lines = LineDiff.diff('a\nb\nc', 'a\nB\nc');
		assert.deepStrictEqual(shape(lines), [' a', '-b', '+B', ' c']);
		assert.deepStrictEqual(lines.map(l => [l.oldLine, l.newLine]), [[1, 1], [2, null], [null, 2], [3, 3]]);
	});

	test('lines added at the start, the middle and the end, and removed', () => {
		assert.deepStrictEqual(shape(LineDiff.diff('b', 'a\nb\nc')), ['+a', ' b', '+c']);
		assert.deepStrictEqual(shape(LineDiff.diff('a\nb\nc\nd', 'a\nd')), [' a', '-b', '-c', ' d']);
		assert.deepStrictEqual(shape(LineDiff.diff('', 'x')), ['-', '+x']);
		assert.deepStrictEqual(shape(LineDiff.diff('x', '')), ['-x', '+']);
	});

	test('the shortest edit is found, not just any', () => {
		const lines = LineDiff.diff('a\nb\nc\nd\ne', 'a\nc\nd\nx\ne');
		assert.deepStrictEqual(shape(lines), [' a', '-b', ' c', ' d', '+x', ' e']);
	});

	test('line ends are not a difference', () => {
		assert.deepStrictEqual(shape(LineDiff.diff('a\r\nb', 'a\nb')), [' a', ' b']);
	});

	test('a very large change is still answered, as everything removed then everything added', () => {
		const old = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join('\n');
		const next = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join('\n');
		const lines = LineDiff.diff(old, next);
		assert.strictEqual(lines.length, 6000);
		assert.ok(lines.slice(0, 3000).every(l => l.type === 'del') && lines.slice(3000).every(l => l.type === 'add'));
	});

	test('a long file with one change is exact and quick', () => {
		const many = Array.from({ length: 20000 }, (_, i) => `line ${i}`);
		const changed = many.slice();
		changed[10000] = 'changed';
		const started = Date.now();
		const lines = LineDiff.diff(many.join('\n'), changed.join('\n'));
		assert.ok(Date.now() - started < 500);
		assert.deepStrictEqual(lines.filter(l => l.type !== 'same').map(l => `${l.type}:${l.text}`), ['del:line 10000', 'add:changed']);
	});
});

suite('LineDiff.hunks', () => {
	test('the changes with their context, and a gap for what lies between', () => {
		const old = Array.from({ length: 30 }, (_, i) => `l${i}`);
		const next = old.slice();
		next[3] = 'X';
		next[25] = 'Y';
		const parts = LineDiff.hunks(LineDiff.diff(old.join('\n'), next.join('\n')), 2);
		assert.deepStrictEqual(parts.map(p => (p.gap !== undefined ? `gap ${p.gap}` : `${p.lines.length} lines`)), ['gap 1', '6 lines', 'gap 17', '6 lines', 'gap 2']);
		assert.ok(parts[1].lines.some(l => l.type === 'add' && l.text === 'X'));
	});

	test('nothing changed is a single gap; everything changed has none', () => {
		assert.deepStrictEqual(LineDiff.hunks(LineDiff.diff('a\nb', 'a\nb')), [{ gap: 2 }]);
		assert.deepStrictEqual(LineDiff.hunks(LineDiff.diff('a', 'b')).filter(p => p.gap !== undefined), []);
	});
});

suite('LineDiff.normalize', () => {
	test('it reads definitions the way the comparison does (same as sqlHeader.normalizeDefinition)', () => {
		const samples = [
			'CREATE PROCEDURE dbo.p\r\nAS\r\n  SELECT 1   \r\n',
			'ALTER PROCEDURE dbo.p\nAS\n  SELECT 1',
			'create or alter PROCEDURE dbo.p\nAS\n  SELECT 1\n\n',
			'\tCREATE   FUNCTION dbo.f() RETURNS int AS BEGIN RETURN 1 END\n\n',
			'-- ALTER in a comment\nCREATE PROC p AS SELECT 1',
			'/* a /* nested */ x */ ALTER VIEW v AS SELECT 1',
			'create /* x */ or\n  alter proc p as select 1',
			'SELECT 1',
			'  x  \r\ny  ',
			''
		];
		for (const sample of samples) assert.strictEqual(LineDiff.normalize(sample), normalizeDefinition(sample), JSON.stringify(sample));
		assert.strictEqual(LineDiff.normalize(null), '');
	});
});
