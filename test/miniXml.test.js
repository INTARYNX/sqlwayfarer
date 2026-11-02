const assert = require('assert');
const { parseXml, childrenNamed, childText } = require('../database/miniXml');

suite('miniXml', () => {
	test('elements, attributes, text and CDATA, without namespace prefixes', () => {
		const root = parseXml('<?xml version="1.0"?><!-- c --><a:root x:id="1" kind=\'k\'><a:item>one &amp; two</a:item><item><![CDATA[<raw>]]></item><empty/></a:root>');
		assert.strictEqual(root.name, 'root');
		assert.deepStrictEqual(root.attributes, { id: '1', kind: 'k' });
		assert.deepStrictEqual(childrenNamed(root, 'ITEM').map(c => c.text), ['one & two', '<raw>']);
		assert.strictEqual(childText(root, 'item'), 'one & two');
		assert.strictEqual(childText(root, 'missing'), '');
		assert.strictEqual(root.children[2].name, 'empty');
	});

	test('a BOM and character references are handled; an impossible one stays as it is', () => {
		const root = parseXml('﻿<r><t>&#65;&#x42;&#99999999;</t></r>');
		assert.strictEqual(childText(root, 't'), 'AB&#99999999;');
	});

	test('a reference is decoded once: &#38;amp; is the text &amp;', () => {
		assert.strictEqual(childText(parseXml('<r><t>&#38;amp; &amp;lt; &lt;</t></r>'), 't'), '&amp; &lt; <');
	});

	test('entities are never expanded', () => {
		const root = parseXml('<!DOCTYPE r [<!ENTITY a "boom">]><r><t>&a;</t></r>');
		assert.strictEqual(childText(root, 't'), '&a;');
	});

	test('malformed input is refused with a reason', () => {
		for (const bad of ['', '   ', 'not xml', '<a><b></a>', '<a>', '</a>', '<a><</a>', '<!-- only a comment -->']) {
			assert.throws(() => parseXml(bad), Error, JSON.stringify(bad));
		}
		assert.throws(() => parseXml('<a>'.repeat(300)), /nested too deeply/);
	});
});
