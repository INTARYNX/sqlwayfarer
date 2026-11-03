const assert = require('assert');
const { readSchemaModel, buildModel, formatColumnType, majorVersion, versionedNotCompared, versionedSpecialTables, FORMAT_VERSION } = require('../database/schemaCatalog');

const col = (extra) => Object.assign({
	schema_name: 'dbo', table_name: 'T', column_name: 'id', type_name: 'int', is_user_defined: 0, type_schema: 'sys',
	max_length: 4, precision: 10, scale: 0, is_nullable: 0, is_identity: 0, seed: null, increment: null,
	is_computed: 0, computed_definition: null, is_persisted: null, collation_name: null,
	default_name: null, default_definition: null, default_system_named: null
}, extra);
const INFO = { version: '16.0.4305.5', collation: 'SQL_Latin1_General_CP1_CI_AS' };
const model = (parts = {}) => buildModel('Db', INFO, parts.schemas || [], parts.columns || [], parts.indexes || [], parts.foreignKeys || [], parts.checks || [], parts.modules || [], parts.notCompared || [], parts.special || []);

suite('schemaCatalog.formatColumnType', () => {
	const t = (type_name, extra = {}) => formatColumnType(Object.assign({ type_name, is_user_defined: 0, max_length: 4, precision: 0, scale: 0 }, extra));
	test('lengths: bytes for char and binary, characters for nchar and nvarchar, max for -1', () => {
		assert.strictEqual(t('varchar', { max_length: 50 }), 'varchar(50)');
		assert.strictEqual(t('varchar', { max_length: -1 }), 'varchar(max)');
		assert.strictEqual(t('char', { max_length: 4 }), 'char(4)');
		assert.strictEqual(t('varbinary', { max_length: -1 }), 'varbinary(max)');
		assert.strictEqual(t('nvarchar', { max_length: 100 }), 'nvarchar(50)');
		assert.strictEqual(t('nvarchar', { max_length: -1 }), 'nvarchar(max)');
		assert.strictEqual(t('nchar', { max_length: 20 }), 'nchar(10)');
	});
	test('precision and scale', () => {
		assert.strictEqual(t('decimal', { precision: 10, scale: 2 }), 'decimal(10,2)');
		assert.strictEqual(t('numeric', { precision: 18, scale: 0 }), 'numeric(18,0)');
		assert.strictEqual(t('datetime2', { scale: 7 }), 'datetime2(7)');
		assert.strictEqual(t('time', { scale: 3 }), 'time(3)');
		assert.strictEqual(t('datetimeoffset', { scale: 7 }), 'datetimeoffset(7)');
		assert.strictEqual(t('float', { precision: 53 }), 'float');
		assert.strictEqual(t('float', { precision: 24 }), 'float(24)');
	});
	test('the others are their name; a user-defined type is qualified and bracketed', () => {
		for (const name of ['int', 'bigint', 'bit', 'datetime', 'uniqueidentifier', 'xml', 'money', 'text', 'sysname', 'timestamp']) assert.strictEqual(t(name), name);
		assert.strictEqual(t('MyType', { is_user_defined: 1, type_schema: 'dbo' }), '[dbo].[MyType]');
		assert.strictEqual(t('We]ird', { is_user_defined: 1, type_schema: 'a b' }), '[a b].[We]]ird]');
	});
});

suite('schemaCatalog.buildModel', () => {
	test('columns carry type, nullability, identity, computed, default and a collation that is not the database one', () => {
		const m = model({ columns: [
			col({ column_id: 1, column_name: 'id', is_identity: 1, seed: '1', increment: '1' }),
			col({ column_id: 2, column_name: 'name', type_name: 'nvarchar', max_length: 100, is_nullable: 1, collation_name: 'Latin1_General_CS_AS' }),
			col({ column_id: 3, column_name: 'plain', type_name: 'nvarchar', max_length: 20, collation_name: INFO.collation }),
			col({ column_id: 4, column_name: 'total', is_computed: 1, computed_definition: '([id]*(2))', is_persisted: 1 }),
			col({ column_id: 5, column_name: 'state', default_name: 'DF_T_state', default_definition: '((0))', default_system_named: 0 })
		] });
		const [id, name, plain, total, state] = m.tables['dbo.T'].columns;
		assert.deepStrictEqual(id.identity, { seed: '1', increment: '1' });
		assert.strictEqual(name.type, 'nvarchar(50)');
		assert.strictEqual(name.nullable, true);
		assert.strictEqual(name.collation, 'Latin1_General_CS_AS');
		assert.strictEqual(plain.collation, null);
		assert.deepStrictEqual(total.computed, { definition: '([id]*(2))', persisted: true });
		assert.deepStrictEqual(state.default, { name: 'DF_T_state', definition: '((0))', systemNamed: false });
		assert.strictEqual(id.default, null);
		assert.strictEqual(id.computed, null);
	});

	test('the rows of an index become one index: keys in order, included apart, filter kept', () => {
		const ix = (extra) => Object.assign({ schema_name: 'dbo', table_name: 'T', index_id: 2, index_name: 'IX_T', type_desc: 'NONCLUSTERED', is_unique: 0, is_primary_key: 0, is_unique_constraint: 0, has_filter: 1, filter_definition: '([a]>(0))', is_disabled: 0, constraint_system_named: null, is_included_column: 0, is_descending_key: 0 }, extra);
		const m = model({ columns: [col({})], indexes: [
			ix({ column_name: 'a', key_ordinal: 1 }), ix({ column_name: 'b', key_ordinal: 2, is_descending_key: 1 }),
			ix({ column_name: 'c', key_ordinal: 0, is_included_column: 1 })
		] });
		assert.deepStrictEqual(m.tables['dbo.T'].indexes, [{
			name: 'IX_T', unique: false, clustered: false,
			columns: [{ name: 'a', desc: false }, { name: 'b', desc: true }], included: ['c'], filter: '([a]>(0))', disabled: false
		}]);
	});

	test('the primary key and the unique constraints are not indexes, and say if their name is the server\'s', () => {
		const ix = (extra) => Object.assign({ schema_name: 'dbo', table_name: 'T', type_desc: 'CLUSTERED', is_unique: 1, is_primary_key: 0, is_unique_constraint: 0, has_filter: 0, is_disabled: 0, is_included_column: 0, is_descending_key: 0 }, extra);
		const m = model({ columns: [col({})], indexes: [
			ix({ index_id: 1, index_name: 'PK__T__3213E83F', is_primary_key: 1, constraint_system_named: 1, column_name: 'id', key_ordinal: 1 }),
			ix({ index_id: 3, index_name: 'UQ_T_code', type_desc: 'NONCLUSTERED', is_unique_constraint: 1, constraint_system_named: 0, column_name: 'code', key_ordinal: 1 })
		] });
		const t = m.tables['dbo.T'];
		assert.deepStrictEqual(t.primaryKey, { name: 'PK__T__3213E83F', systemNamed: true, clustered: true, columns: [{ name: 'id', desc: false }] });
		assert.deepStrictEqual(t.uniques, [{ name: 'UQ_T_code', systemNamed: false, clustered: false, columns: [{ name: 'code', desc: false }] }]);
		assert.deepStrictEqual(t.indexes, []);
	});

	test('columnstore, xml and hash indexes are left out (they are counted, not read)', () => {
		const m = model({ columns: [col({})], indexes: [
			{ schema_name: 'dbo', table_name: 'T', index_id: 2, index_name: 'CCI', type_desc: 'CLUSTERED COLUMNSTORE', column_name: 'id', key_ordinal: 0, is_included_column: 0 },
			{ schema_name: 'dbo', table_name: 'T', index_id: 3, index_name: 'HX', type_desc: 'NONCLUSTERED HASH', column_name: 'id', key_ordinal: 1, is_included_column: 0 }
		] });
		assert.deepStrictEqual(m.tables['dbo.T'].indexes, []);
	});

	test('the rows of a foreign key become one, columns in order', () => {
		const fk = (extra) => Object.assign({ schema_name: 'dbo', table_name: 'Child', fk_name: 'FK_Child_Parent', is_system_named: 0, is_disabled: 0, on_delete: 'CASCADE', on_update: 'NO_ACTION', ref_schema: 'dbo', ref_table: 'Parent' }, extra);
		const m = model({ columns: [col({ table_name: 'Child' })], foreignKeys: [fk({ column_name: 'a', ref_column: 'x' }), fk({ column_name: 'b', ref_column: 'y' })] });
		assert.deepStrictEqual(m.tables['dbo.Child'].foreignKeys, [{
			name: 'FK_Child_Parent', systemNamed: false, columns: ['a', 'b'], refSchema: 'dbo', refTable: 'Parent', refColumns: ['x', 'y'],
			onDelete: 'CASCADE', onUpdate: 'NO_ACTION', disabled: false
		}]);
	});

	test('check constraints, and modules by type; a trigger knows its table and whether it is disabled', () => {
		const m = model({
			columns: [col({})],
			checks: [{ schema_name: 'dbo', table_name: 'T', check_name: 'CK_T', definition: '([id]>(0))', is_system_named: 0, is_disabled: 0 }],
			modules: [
				{ schema_name: 'dbo', object_name: 'v', type_code: 'V ', definition: 'CREATE VIEW dbo.v AS SELECT 1 a', uses_ansi_nulls: 1, uses_quoted_identifier: 1 },
				{ schema_name: 'dbo', object_name: 'p', type_code: 'P ', definition: null, uses_ansi_nulls: 1, uses_quoted_identifier: 0 },
				{ schema_name: 'dbo', object_name: 'f', type_code: 'IF', definition: 'x', uses_ansi_nulls: 1, uses_quoted_identifier: 1 },
				{ schema_name: 'dbo', object_name: 'tr', type_code: 'TR', definition: 'x', uses_ansi_nulls: 1, uses_quoted_identifier: 1, parent_schema: 'dbo', parent_name: 'T', is_disabled: 1 }
			]
		});
		assert.strictEqual(m.tables['dbo.T'].checks[0].definition, '([id]>(0))');
		assert.deepStrictEqual(Object.values(m.modules).map(x => `${x.type}:${x.name}`), ['function:f', 'procedure:p', 'trigger:tr', 'view:v']);
		assert.strictEqual(m.modules['dbo.p'].definition, null);
		assert.strictEqual(m.modules['dbo.p'].quotedIdentifier, false);
		assert.deepStrictEqual([m.modules['dbo.tr'].parent, m.modules['dbo.tr'].disabled], ['dbo.T', true]);
	});

	test('the model does not depend on the order the server answered in', () => {
		const a = col({ column_id: 1, column_name: 'a' });
		const b = col({ column_id: 1, column_name: 'a', table_name: 'B' });
		const one = model({ columns: [a, b], schemas: [{ name: 'z' }, { name: 'a' }] });
		const two = model({ columns: [b, a], schemas: [{ name: 'a' }, { name: 'z' }] });
		assert.strictEqual(JSON.stringify(one), JSON.stringify(two));
		assert.deepStrictEqual(Object.keys(one.tables), ['dbo.B', 'dbo.T']);
	});

	test('what is not compared is counted, zeros left out, and the model is plain JSON', () => {
		const m = model({ notCompared: [{ kind: 'synonyms', n: 2 }, { kind: 'sequences', n: 0 }, { kind: 'otherIndexes', n: 1 }] });
		assert.deepStrictEqual(m.notCompared, { synonyms: 2, otherIndexes: 1 });
		assert.strictEqual(m.formatVersion, FORMAT_VERSION);
		assert.deepStrictEqual(JSON.parse(JSON.stringify(m)), m);
	});
});

suite('schemaCatalog: tables that are not rebuilt', () => {
	test('a temporal, memory-optimized, graph or file table is not in the model, nor what hangs on it; it is counted', () => {
		const ix = (table) => ({ schema_name: 'dbo', table_name: table, index_id: 1, index_name: 'PK', type_desc: 'CLUSTERED', is_unique: 1, is_primary_key: 1, is_unique_constraint: 0, has_filter: 0, is_disabled: 0, is_included_column: 0, is_descending_key: 0, column_name: 'id', key_ordinal: 1 });
		const m = model({
			columns: [col({ table_name: 'Audit' }), col({ table_name: 'AuditHistory' }), col({ table_name: 'Normal' })],
			indexes: [ix('Audit'), ix('Normal')],
			checks: [{ schema_name: 'dbo', table_name: 'Audit', check_name: 'CK', definition: '(1=1)', is_system_named: 0, is_disabled: 0 }],
			modules: [
				{ schema_name: 'dbo', object_name: 'trg_audit', type_code: 'TR', definition: 'x', uses_ansi_nulls: 1, uses_quoted_identifier: 1, parent_schema: 'dbo', parent_name: 'Audit', is_disabled: 0 },
				{ schema_name: 'dbo', object_name: 'trg_normal', type_code: 'TR', definition: 'x', uses_ansi_nulls: 1, uses_quoted_identifier: 1, parent_schema: 'dbo', parent_name: 'Normal', is_disabled: 0 }
			],
			special: [{ kind: 'temporalTables', schema_name: 'dbo', table_name: 'Audit' }, { kind: 'temporalTables', schema_name: 'dbo', table_name: 'AuditHistory' }, { kind: 'graphTables', schema_name: 'dbo', table_name: 'Node' }],
			notCompared: [{ kind: 'synonyms', n: 1 }]
		});
		assert.deepStrictEqual(Object.keys(m.tables), ['dbo.Normal']);
		assert.deepStrictEqual(Object.keys(m.modules), ['dbo.trg_normal']);
		assert.deepStrictEqual(m.notCompared, { synonyms: 1, temporalTables: 2, graphTables: 1 });
	});
});

suite('schemaCatalog.readSchemaModel', () => {
	const EMPTY = [[{ version: '16.0.1', collation: 'C' }], [], [], [], [], [], [], []];
	function connection(answers, log) {
		let release = 0;
		return {
			createRequest: () => ({ batch: async text => { log.push(text); const next = answers.shift(); if (next instanceof Error) throw next; return { recordsets: next }; } }),
			release: () => { release++; log.release = release; }
		};
	}

	test('one batch for the catalog, on one connection that goes back to master and is released', async () => {
		const log = [];
		const conn = connection([EMPTY, [[]], undefined], log);
		const m = await readSchemaModel({ acquireConnection: async () => conn }, 'My]Db');
		assert.strictEqual(m.database, 'My]Db');
		assert.ok(log[0].startsWith('USE [My]]Db];'));
		assert.ok(log[0].includes('sys.columns') && log[0].includes('sys.sql_modules'));
		assert.strictEqual(log[log.length - 1], 'USE [master]');
		assert.strictEqual(log.release, 1);
	});

	test('it still goes back to master and releases when the catalog cannot be read', async () => {
		const log = [];
		const conn = connection([new Error('permission denied'), undefined], log);
		await assert.rejects(readSchemaModel({ acquireConnection: async () => conn }, 'Db'), /permission denied/);
		assert.strictEqual(log[log.length - 1], 'USE [master]');
		assert.strictEqual(log.release, 1);
	});

	test('what only exists on a recent server is asked only there', () => {
		assert.strictEqual(versionedNotCompared(10), '');
		assert.ok(versionedNotCompared(11).includes('sys.sequences'));
		assert.strictEqual(versionedSpecialTables(10), '');
		assert.ok(versionedSpecialTables(11).includes('is_filetable') && !versionedSpecialTables(11).includes('is_memory_optimized'));
		assert.ok(versionedSpecialTables(12).includes('is_memory_optimized') && !versionedSpecialTables(12).includes('temporal_type'));
		assert.ok(versionedSpecialTables(13).includes('temporal_type') && !versionedSpecialTables(13).includes('is_node'));
		assert.ok(versionedSpecialTables(16).includes('is_node'));
		assert.strictEqual(majorVersion('16.0.4305.5'), 16);
		assert.strictEqual(majorVersion('10.50.6000'), 10);
		assert.strictEqual(majorVersion(undefined), 0);
	});

	test('the counts of the recent server are added to the others, and its special tables are left out', async () => {
		const log = [];
		const answers = [EMPTY.map((x, i) => i === 7 ? [{ kind: 'synonyms', n: 1 }] : x), [[{ kind: 'sequences', n: 3 }], [{ kind: 'temporalTables', schema_name: 'dbo', table_name: 'Audit' }]]];
		const m = await readSchemaModel({ acquireConnection: async () => connection(answers.concat([undefined]), log) }, 'Db');
		assert.deepStrictEqual(m.notCompared, { synonyms: 1, sequences: 3, temporalTables: 1 });
	});
});
