const assert = require('assert');
const SqlHighlighter = require('../webview/sqlHighlight');

suite('SqlHighlighter.toHtml', () => {
	test('wraps keywords in a keyword span, leaves plain tokens untouched', () => {
		const html = SqlHighlighter.toHtml('SELECT * FROM t');
		assert.strictEqual(html, '<span class="sql-tok-keyword">SELECT</span> * <span class="sql-tok-keyword">FROM</span> t');
	});

	test('keyword matching is case-insensitive but preserves the original case', () => {
		const html = SqlHighlighter.toHtml('select 1');
		assert.strictEqual(html, '<span class="sql-tok-keyword">select</span> <span class="sql-tok-number">1</span>');
	});

	test('wraps a known function name differently from a keyword', () => {
		const html = SqlHighlighter.toHtml('COUNT(*)');
		assert.strictEqual(html, '<span class="sql-tok-function">COUNT</span>(*)');
	});

	test('a string literal is one token, including an escaped quote', () => {
		const html = SqlHighlighter.toHtml("SELECT 'it''s'");
		assert.strictEqual(
			html,
			'<span class="sql-tok-keyword">SELECT</span> <span class="sql-tok-string">\'it\'\'s\'</span>'
		);
	});

	test('an unterminated string literal still consumes to end of input', () => {
		const html = SqlHighlighter.toHtml("SELECT 'oops");
		assert.ok(html.endsWith('<span class="sql-tok-string">\'oops</span>'));
	});

	test('a line comment runs to the newline, not past it', () => {
		const html = SqlHighlighter.toHtml('SELECT 1 -- note\nSELECT 2');
		assert.ok(html.includes('<span class="sql-tok-comment">-- note</span>'));
		assert.ok(html.includes('<span class="sql-tok-keyword">SELECT</span> <span class="sql-tok-number">2</span>'));
	});

	test('a block comment is one token even across content', () => {
		const html = SqlHighlighter.toHtml('/* a b c */SELECT 1');
		assert.ok(html.startsWith('<span class="sql-tok-comment">/* a b c */</span>'));
	});

	test('a bracketed identifier is one token', () => {
		const html = SqlHighlighter.toHtml('SELECT * FROM [My Table]');
		assert.ok(html.endsWith('<span class="sql-tok-bracket">[My Table]</span>'));
	});

	test('recognizes @variables, #temp tables and ##global temp tables', () => {
		const html = SqlHighlighter.toHtml('@Id #Tmp ##GlobalTmp');
		assert.strictEqual(
			html,
			'<span class="sql-tok-variable">@Id</span> <span class="sql-tok-variable">#Tmp</span> <span class="sql-tok-variable">##GlobalTmp</span>'
		);
	});

	test('escapes HTML-sensitive characters outside of tokens', () => {
		const html = SqlHighlighter.toHtml('WHERE x < 5 AND y & 1');
		assert.ok(html.includes('x &lt; <span class="sql-tok-number">5</span>'));
		assert.ok(html.includes('y &amp; <span class="sql-tok-number">1</span>'));
	});

	test('escapes HTML-sensitive characters inside a string literal', () => {
		const html = SqlHighlighter.toHtml("SELECT '<b>&</b>'");
		assert.ok(html.includes('<span class="sql-tok-string">\'&lt;b&gt;&amp;&lt;/b&gt;\'</span>'));
	});

	test('a plain identifier that is not a keyword or function is left bare', () => {
		const html = SqlHighlighter.toHtml('MyTable');
		assert.strictEqual(html, 'MyTable');
	});
});
