const assert = require('assert');
const { toTemplate } = require('../webview-build/snippetTemplate');

suite('toTemplate', () => {
	test('a snippet without markers is its own template', () => {
		assert.deepStrictEqual(toTemplate('SELECT 1', []), { template: 'SELECT 1', fields: 0, usesSelection: false });
	});

	test('$CURSOR$ is the final stop', () => {
		assert.strictEqual(toTemplate('SELECT * FROM $CURSOR$', []).template, 'SELECT * FROM ${0}');
	});

	test('a declared placeholder is a field with its default value, numbered in order of appearance', () => {
		const placeholders = [{ id: 'Weeks', default: '0' }, { id: 'Day', default: '' }];
		const result = toTemplate("'$Day$', $Weeks$, $CURSOR$", placeholders);
		assert.strictEqual(result.template, "'${1}', ${2:0}, ${0}");
		assert.strictEqual(result.fields, 2);
	});

	test('the same placeholder used twice is one linked field', () => {
		assert.strictEqual(toTemplate('$T$ x $T$', [{ id: 'T', default: 'dbo' }]).template, '${1:dbo} x ${1}');
	});

	test('placeholder names are matched without regard to case', () => {
		assert.strictEqual(toTemplate('$schemaname$', [{ id: 'schemaName', default: '' }]).template, '${1}');
	});

	test('$SELECTEDTEXT$ becomes the selection; the selection markers disappear', () => {
		const result = toTemplate('$SELECTIONSTART$\nGO\n$SELECTEDTEXT$\nGO\n$SELECTIONEND$', [], 'SELECT 1');
		assert.strictEqual(result.template, '\nGO\nSELECT 1\nGO\n');
		assert.strictEqual(result.usesSelection, true);
	});

	test('braces in the code and in the selection are literal', () => {
		assert.strictEqual(toTemplate("WHERE n LIKE '{a}' $SELECTEDTEXT$", [], '{b}').template, "WHERE n LIKE '\\{a\\}' \\{b\\}");
		assert.strictEqual(toTemplate('SELECT ${x}', []).template, 'SELECT $\\{x\\}');
	});

	test('a default value with braces or a line break stays one literal line', () => {
		assert.strictEqual(toTemplate('$A$', [{ id: 'A', default: 'a{b}\nsecond' }]).template, '${1:a\\{b\\}}');
	});

	test('what looks like a marker but is not declared stays as it is', () => {
		assert.strictEqual(toTemplate("SELECT '$5.00$', $notDeclared$", []).template, "SELECT '$5.00$', $notDeclared$");
	});

	test('only the first $CURSOR$ is a stop', () => {
		assert.strictEqual(toTemplate('$CURSOR$ a $CURSOR$', []).template, '${0} a ');
	});

	test('a snippet without placeholders or cursor keeps its text', () => {
		assert.strictEqual(toTemplate('UPDATE t SET x = $action', []).template, 'UPDATE t SET x = $action');
	});
});
