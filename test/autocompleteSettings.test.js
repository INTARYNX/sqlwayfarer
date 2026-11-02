const assert = require('assert');
const path = require('path');
global.SqlContext = require('../webview/sqlContext');
global.SqlMatcher = require('../webview/sqlMatcher');
const SqlAutocomplete = require('../webview/sqlAutocomplete');
const { AUTOCOMPLETE_SETTING_KEYS, readAutocompleteSettings } = require('../panels/autocompleteSettings');
const { formatSqlType } = require('../database/DatabaseService');

const manifest = require(path.join(__dirname, '..', 'package.json'));
const properties = manifest.contributes.configuration.properties;

suite('sqlwayfarer.autocomplete settings', () => {
	test('every key sent to the webview is declared in package.json, and the other way round', () => {
		const declared = Object.keys(properties)
			.filter(k => k.startsWith('sqlwayfarer.autocomplete.'))
			.map(k => k.slice('sqlwayfarer.autocomplete.'.length))
			.sort();
		assert.deepStrictEqual([...AUTOCOMPLETE_SETTING_KEYS].sort(), declared);
	});

	test('the defaults of package.json are the defaults of the webview', () => {
		for (const key of AUTOCOMPLETE_SETTING_KEYS) {
			assert.strictEqual(properties[`sqlwayfarer.autocomplete.${key}`].default, SqlAutocomplete.DEFAULT_SETTINGS[key], key);
		}
	});

	test('every enum value of package.json is accepted by the webview', () => {
		for (const key of AUTOCOMPLETE_SETTING_KEYS) {
			const prop = properties[`sqlwayfarer.autocomplete.${key}`];
			for (const value of prop.enum || []) {
				assert.strictEqual(SqlAutocomplete.normalizeSettings({ [key]: value })[key], value, `${key}=${value}`);
			}
		}
	});

	test('integer bounds of package.json match the clamping of the webview', () => {
		for (const key of ['minChars', 'maxItems']) {
			const prop = properties[`sqlwayfarer.autocomplete.${key}`];
			assert.strictEqual(SqlAutocomplete.normalizeSettings({ [key]: prop.minimum - 1 })[key], prop.minimum);
			assert.strictEqual(SqlAutocomplete.normalizeSettings({ [key]: prop.maximum + 1 })[key], prop.maximum);
		}
	});

	test('readAutocompleteSettings reads each key and skips the unset ones', () => {
		const config = { get: key => ({ matching: 'prefix', minChars: 3 })[key] };
		assert.deepStrictEqual(readAutocompleteSettings(config), { matching: 'prefix', minChars: 3 });
	});
});

suite('DatabaseService.formatSqlType', () => {
	test('lengths are in characters for n-types and bytes otherwise', () => {
		assert.strictEqual(formatSqlType('nvarchar', 100), 'nvarchar(50)');
		assert.strictEqual(formatSqlType('varchar', 100), 'varchar(100)');
		assert.strictEqual(formatSqlType('nvarchar', -1), 'nvarchar(max)');
	});

	test('precision and scale for exact numerics, nothing for plain types', () => {
		assert.strictEqual(formatSqlType('decimal', 9, 18, 2), 'decimal(18,2)');
		assert.strictEqual(formatSqlType('int', 4, 10, 0), 'int');
		assert.strictEqual(formatSqlType('datetime2', 8, 27, 7), 'datetime2');
		assert.strictEqual(formatSqlType('datetime2', 8, 27, 3), 'datetime2(3)');
	});
});
