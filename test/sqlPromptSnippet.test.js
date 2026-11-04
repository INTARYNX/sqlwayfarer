const assert = require('assert');
const { parseSqlPromptSnippetFile, parseSqlPromptSnippetFiles } = require('../database/sqlPromptSnippet');

// Files in the format SQL Prompt writes (written here, not copied from anywhere).
const snippetXml = ({ title = 'Heading', shortcut = 'hh', description = 'A heading', declarations = '<Declarations />', code = '--$Section$\n$CURSOR$', extra = '' } = {}) => `﻿<?xml version="1.0" encoding="utf-8"?>
<CodeSnippets>
  <CodeSnippet Format="1.0.0">
    <Header>
      <Title>${title}</Title>
      <Shortcut>${shortcut}</Shortcut>
      <Description>${description}</Description>
      <Author />
      <SnippetTypes>
        <SnippetType>Expansion</SnippetType>
      </SnippetTypes>
    </Header>
    <Snippet>
      ${declarations}
      <Code Language="sql"><![CDATA[${code}]]></Code>
    </Snippet>
  </CodeSnippet>${extra}
</CodeSnippets>`;

const literal = (id, tooltip = '', def = '') => `<Literal><ID>${id}</ID>${tooltip ? `<ToolTip>${tooltip}</ToolTip>` : '<ToolTip />'}${def ? `<Default>${def}</Default>` : '<Default />'}</Literal>`;

suite('parseSqlPromptSnippetFile', () => {
	test('reads the header, the code and the type', () => {
		const { snippets, errors } = parseSqlPromptSnippetFile(snippetXml());
		assert.deepStrictEqual(errors, []);
		assert.strictEqual(snippets.length, 1);
		assert.deepStrictEqual(snippets[0], {
			name: 'Heading', abbreviation: 'hh', description: 'A heading', author: '',
			sql: '--$Section$\n$CURSOR$', placeholders: [], types: ['Expansion']
		});
	});

	test('reads the declared placeholders with their tooltip and default value', () => {
		const declarations = `<Declarations>${literal('Day', 'Name of the day')}${literal('Weeks', '', '0')}${literal('From', '', 'sysdatetime()')}</Declarations>`;
		const { snippets } = parseSqlPromptSnippetFile(snippetXml({ declarations, code: "DECLARE @d varchar(20) = '$Day$', @w int = $Weeks$, @f date = $From$" }));
		assert.deepStrictEqual(snippets[0].placeholders, [
			{ id: 'Day', tooltip: 'Name of the day', default: '' },
			{ id: 'Weeks', tooltip: '', default: '0' },
			{ id: 'From', tooltip: '', default: 'sysdatetime()' }
		]);
	});

	test('the code is kept as it is: tabs, markers, quotes, and "]]>" split across CDATA sections', () => {
		const code = "SELECT\t'a' -- x\n$SELECTEDTEXT$";
		assert.strictEqual(parseSqlPromptSnippetFile(snippetXml({ code })).snippets[0].sql, code);
		const split = `﻿<CodeSnippets><CodeSnippet><Header><Title>t</Title></Header><Snippet><Code Language="sql"><![CDATA[a]]]]><![CDATA[>b]]></Code></Snippet></CodeSnippet></CodeSnippets>`;
		assert.strictEqual(parseSqlPromptSnippetFile(split).snippets[0].sql, 'a]]>b');
	});

	test('windows line endings become newlines', () => {
		assert.strictEqual(parseSqlPromptSnippetFile(snippetXml({ code: 'a\r\nb' })).snippets[0].sql, 'a\nb');
	});

	test('entities in the header are decoded', () => {
		const { snippets } = parseSqlPromptSnippetFile(snippetXml({ title: 'Tom &amp; Jerry &lt;1&gt;', description: 'it&apos;s &quot;ok&quot;' }));
		assert.strictEqual(snippets[0].name, 'Tom & Jerry <1>');
		assert.strictEqual(snippets[0].description, 'it\'s "ok"');
	});

	test('the shortcut stands in for a missing title, and the other way round', () => {
		assert.strictEqual(parseSqlPromptSnippetFile(snippetXml({ title: '', shortcut: 'abc' })).snippets[0].name, 'abc');
		const noShortcut = parseSqlPromptSnippetFile(snippetXml({ title: 'Only title', shortcut: '' })).snippets[0];
		assert.strictEqual(noShortcut.name, 'Only title');
		assert.strictEqual(noShortcut.abbreviation, '');
	});

	test('a file with several snippets gives them all', () => {
		const second = `<CodeSnippet Format="1.0.0"><Header><Title>Second</Title><Shortcut>s2</Shortcut></Header><Snippet><Code Language="sql"><![CDATA[SELECT 2]]></Code></Snippet></CodeSnippet>`;
		const { snippets } = parseSqlPromptSnippetFile(snippetXml({ extra: second }));
		assert.deepStrictEqual(snippets.map(s => s.name), ['Heading', 'Second']);
	});

	test('what is not a snippet is reported, not thrown', () => {
		assert.ok(/empty/.test(parseSqlPromptSnippetFile('  ').errors[0]));
		assert.ok(/not a SQL Prompt snippet/.test(parseSqlPromptSnippetFile('<html><body>no</body></html>').errors[0]));
		assert.ok(/No code/.test(parseSqlPromptSnippetFile('<CodeSnippets><CodeSnippet><Header><Title>t</Title></Header><Snippet></Snippet></CodeSnippet></CodeSnippets>').errors[0]));
		assert.ok(/No title/.test(parseSqlPromptSnippetFile('<CodeSnippets><CodeSnippet><Header></Header><Snippet><Code><![CDATA[x]]></Code></Snippet></CodeSnippet></CodeSnippets>').errors[0]));
		assert.deepStrictEqual(parseSqlPromptSnippetFile(null).snippets, []);
		assert.ok(/too large/.test(parseSqlPromptSnippetFile('x'.repeat(1000001)).errors[0]));
	});

	test('one bad snippet does not hide the good one in the same file', () => {
		const bad = '<CodeSnippet><Header><Title>bad</Title></Header><Snippet></Snippet></CodeSnippet>';
		const { snippets, errors } = parseSqlPromptSnippetFile(snippetXml({ extra: bad }));
		assert.strictEqual(snippets.length, 1);
		assert.strictEqual(errors.length, 1);
		assert.ok(/snippet 2/.test(errors[0]));
	});

	test('nothing in the file is executed or fetched: markup in the code stays text', () => {
		const code = '<script>alert(1)</script> $CURSOR$';
		assert.strictEqual(parseSqlPromptSnippetFile(snippetXml({ code })).snippets[0].sql, code);
	});
});

suite('parseSqlPromptSnippetFiles', () => {
	test('a reference is decoded once: &#38;amp; is the text &amp;', () => {
		const { snippets } = parseSqlPromptSnippetFiles([{ path: 'a', text: snippetXml({ title: 'R&#38;amp;D &amp;lt;' }) }]);
		assert.strictEqual(snippets[0].name, 'R&amp;D &lt;');
	});

	test('an impossible character reference does not abort the other files', () => {
		const { snippets, skipped } = parseSqlPromptSnippetFiles([
			{ path: 'bad.sqlpromptsnippet', text: snippetXml({ title: 'Bad &#99999999; &#xFFFFFFFF;' }) },
			{ path: 'ok.sqlpromptsnippet', text: snippetXml({ title: 'Ok' }) }
		]);
		assert.deepStrictEqual(snippets.map(s => s.name).includes('Ok'), true);
		assert.ok(Array.isArray(skipped));
	});
	test('keeps the source of each snippet and says why a file was skipped', () => {
		const { snippets, skipped } = parseSqlPromptSnippetFiles([
			{ path: 'a.sqlpromptsnippet', text: snippetXml({ title: 'A' }) },
			{ path: 'b.txt', text: 'not xml' }
		]);
		assert.strictEqual(snippets[0].source, 'a.sqlpromptsnippet');
		assert.deepStrictEqual(skipped.map(s => s.path), ['b.txt']);
	});
});

// A file is read whatever it holds (up to 1,000,000 characters): nothing in it may take long.
suite('sqlPromptSnippet: files made to be slow', () => {
	const within = (ms, text) => {
		const started = Date.now();
		const result = parseSqlPromptSnippetFile(text);
		assert.ok(Date.now() - started < ms, `took ${Date.now() - started} ms`);
		return result;
	};
	const wrap = inner => `<CodeSnippet><Title>t</Title>${inner}<Code>SELECT 1</Code></CodeSnippet>`;

	test('thousands of declarations that are never closed', () => {
		const result = within(1500, wrap('<Declarations>' + '<Literal><ID>x</ID>'.repeat(30000) + '</Declarations>'));
		assert.strictEqual(result.snippets.length, 1);
	});

	test('thousands of CodeSnippet, Title, Code or Declarations tags that are never closed', () => {
		within(1500, '<CodeSnippet>'.repeat(70000));
		within(1500, '<CodeSnippet>' + '<Title>'.repeat(100000) + '</CodeSnippet>');
		within(1500, '<CodeSnippet><Title>t</Title>' + '<Code>'.repeat(100000) + '</CodeSnippet>');
		within(1500, '<CodeSnippet><Title>t</Title><Code>x</Code>' + '<Declarations>'.repeat(60000) + '</CodeSnippet>');
	});

	test('an opening tag that is never closed does not make the scan walk the text again and again', () => {
		// A tag whose ">" is missing: the pattern that looked for it used to
		// walk the rest of the file for each one of them - quadratic.
		within(1500, '<CodeSnippet '.repeat(30000));
		within(1500, '<CodeSnippet a="1"'.repeat(30000));
		within(1500, wrap('<Declarations>' + '<Literal '.repeat(30000) + '</Declarations>'));
	});

	test('a self-closing tag with attributes is empty, not stretched to the next closing tag', () => {
		const result = within(500, '<CodeSnippet><Title a="1"/><Shortcut>zz</Shortcut><Code>SELECT 1</Code></CodeSnippet>');
		assert.strictEqual(result.snippets[0].name, 'zz', 'no title: the shortcut names it');
	});

	test('a declaration that is never closed is left out, the others stay', () => {
		const result = within(500, wrap('<Declarations><Literal><ID>a</ID><Default>1</Default></Literal><Literal><ID>b</ID></Declarations>'));
		assert.deepStrictEqual(result.snippets[0].placeholders.map(p => p.id), ['a']);
	});
});
