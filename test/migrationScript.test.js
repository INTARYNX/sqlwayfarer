const assert = require('assert');
const { diffModels } = require('../database/schemaDiff');
const { buildMigrationScript, changeId, supportsCreateOrAlter, withHeader, orderModules } = require('../database/migrationScript');

const column = (name, extra) => Object.assign({ name, type: 'int', nullable: false, identity: null, computed: null, default: null, collation: null }, extra);
const table = (name, extra, schema = 'dbo') => Object.assign({ schema, name, columns: [column('id')], primaryKey: null, uniques: [], indexes: [], foreignKeys: [], checks: [] }, extra);
const mod = (type, name, definition, extra, schema = 'dbo') => Object.assign({ schema, name, type, definition, ansiNulls: true, quotedIdentifier: true }, extra);
const model = ({ schemas = [], tables = [], modules = [] } = {}) => ({
	schemas,
	tables: Object.fromEntries(tables.map(t => [`${t.schema}.${t.name}`, t])),
	modules: Object.fromEntries(modules.map(m => [`${m.schema}.${m.name}`, m])),
	notCompared: {}
});
const script = (reference, current, options) => buildMigrationScript(diffModels(model(reference), model(current)), Object.assign({ now: new Date('2026-11-03T10:00:00Z') }, options));
const batches = result => result.script.split('\nGO\n');
const pk = (name, columns, extra) => Object.assign({ name, systemNamed: false, clustered: true, columns: columns.map(c => ({ name: c, desc: false })) }, extra);
const fk = (name, columns, refTable, refColumns, extra) => Object.assign({ name, systemNamed: false, columns, refSchema: 'dbo', refTable, refColumns, onDelete: 'NO_ACTION', onUpdate: 'NO_ACTION', disabled: false }, extra);
const at = (result, text) => result.script.indexOf(text);

suite('migrationScript: shape of the script', () => {
	test('nothing to do is a script with no step', () => {
		const result = script({ tables: [table('T')] }, { tables: [table('T')] });
		assert.strictEqual(result.steps, 0);
		assert.ok(result.script.includes('0 step(s)'));
		assert.ok(!result.script.includes('SET NOEXEC'));
	});

	test('it says where it comes from and that it can be run again; one statement per batch, GO between', () => {
		const result = script({ tables: [table('T')] }, { tables: [table('T', { columns: [column('id'), column('a', { nullable: true })] })] }, { reference: 'Db_ref', current: 'Db' });
		assert.ok(result.script.startsWith('-- SQL Wayfarer'));
		assert.ok(result.script.includes('From: Db_ref   To: Db   Generated: 2026-11-03T10:00:00.000Z'));
		assert.ok(result.script.includes('Re-entrant'));
		const parts = batches(result);
		assert.ok(parts[1].startsWith('SET NOEXEC OFF;'));
		assert.ok(parts[2].includes('CREATE TABLE #wf'));
		assert.ok(parts[parts.length - 2].startsWith('SET NOEXEC OFF;'));
		assert.ok(parts[parts.length - 1].includes('DROP TABLE #wf') && parts[parts.length - 1].includes('SET QUOTED_IDENTIFIER ON;'));
		assert.ok(parts.some(p => p.includes('ALTER TABLE [dbo].[T] ADD [a] int NULL;')));
	});

	test('a batch runs only if the one before it finished, and says so when it does', () => {
		const result = script({ tables: [table('T')] }, { tables: [table('T', { columns: [column('id'), column('a', { nullable: true }), column('b', { nullable: true })] })] });
		const steps = batches(result).filter(p => p.includes('ADD ['));
		assert.strictEqual(steps.length, 2);
		assert.ok(steps[0].startsWith('IF NOT EXISTS (SELECT 1 FROM #wf WHERE n = 0) SET NOEXEC ON;\n'));
		assert.ok(steps[0].endsWith('IF @@ERROR = 0 UPDATE #wf SET n = 1;'));
		assert.ok(steps[1].startsWith('IF NOT EXISTS (SELECT 1 FROM #wf WHERE n = 1) SET NOEXEC ON;\n'));
		assert.ok(steps[1].endsWith('IF @@ERROR = 0 UPDATE #wf SET n = 2;'));
	});

	test('a column is added only if it is not there: the state is tested, not a version', () => {
		const result = script({ tables: [table('T')] }, { tables: [table('T', { columns: [column('id'), column('a', { nullable: true })] })] });
		assert.ok(result.script.includes("IF COL_LENGTH(N'[dbo].[T]', N'a') IS NULL\n    ALTER TABLE [dbo].[T] ADD [a] int NULL;"));
	});
});

suite('migrationScript: order', () => {
	test('what blocks goes first, then columns, keys, indexes, checks, foreign keys, then the code', () => {
		const reference = { tables: [table('Child', { foreignKeys: [fk('FK_old', ['p'], 'P', ['id'])] }), table('P')] };
		const current = {
			tables: [
				table('Child', { columns: [column('id'), column('x', { nullable: true })], indexes: [{ name: 'IX_x', unique: false, clustered: false, columns: [{ name: 'x', desc: false }], included: [], filter: null, disabled: false }], checks: [{ name: 'CK', systemNamed: false, definition: '([x]>(0))', disabled: false }], foreignKeys: [fk('FK_new', ['x'], 'P', ['id'])] }),
				table('P', { primaryKey: pk('PK_P', ['id']) })
			],
			modules: [mod('view', 'v', 'CREATE VIEW dbo.v AS SELECT 1 a'), mod('procedure', 'p', 'CREATE PROC dbo.p AS SELECT 1')]
		};
		const result = script(reference, current);
		const order = ['DROP CONSTRAINT', 'ADD [x] int NULL', 'PRIMARY KEY CLUSTERED', 'CREATE NONCLUSTERED INDEX [IX_x]', 'ADD CONSTRAINT [CK] CHECK', 'ADD CONSTRAINT [FK_new] FOREIGN KEY', 'CREATE OR ALTER VIEW', 'CREATE OR ALTER PROC'].map(t => at(result, t));
		assert.ok(order.every(i => i > -1), order.join());
		assert.deepStrictEqual([...order].sort((a, b) => a - b), order);
	});

	test('views, then functions, then procedures; each after what it reads', () => {
		const current = { modules: [
			mod('procedure', 'p', 'CREATE PROC dbo.p AS SELECT * FROM dbo.v2'),
			mod('view', 'v2', 'CREATE VIEW dbo.v2 AS SELECT * FROM dbo.v1'),
			mod('view', 'v1', 'CREATE VIEW dbo.v1 AS SELECT 1 a'),
			mod('function', 'f', 'CREATE FUNCTION dbo.f() RETURNS int AS BEGIN RETURN 1 END')
		] };
		const result = script({}, current);
		const order = ['VIEW dbo.v1', 'VIEW dbo.v2', 'FUNCTION dbo.f', 'PROC dbo.p'].map(t => at(result, `CREATE OR ALTER ${t}`));
		assert.ok(order.every(i => i > -1));
		assert.deepStrictEqual([...order].sort((a, b) => a - b), order);
	});

	test('orderModules puts a module after the ones it mentions, and survives a cycle', () => {
		const a = mod('view', 'a', 'CREATE VIEW a AS SELECT * FROM [dbo].[b]');
		const b = mod('view', 'b', 'CREATE VIEW b AS SELECT 1');
		assert.deepStrictEqual(orderModules([a, b]).map(m => m.name), ['b', 'a']);
		const x = mod('view', 'x', 'CREATE VIEW x AS SELECT * FROM y');
		const y = mod('view', 'y', 'CREATE VIEW y AS SELECT * FROM x');
		assert.deepStrictEqual(orderModules([x, y]).map(m => m.name).sort(), ['x', 'y']);
		const prefix = mod('view', 'orders', 'CREATE VIEW orders AS SELECT 1');
		const other = mod('view', 'v', 'CREATE VIEW v AS SELECT * FROM orders_archive');
		assert.deepStrictEqual(orderModules([other, prefix]).map(m => m.name), ['v', 'orders']);
	});

	test('a database of the size of a real legacy one is ordered in no time', () => {
		const modules = Array.from({ length: 2000 }, (_, i) => mod('procedure', `usp_${i}`, `CREATE PROC dbo.usp_${i} AS\nSELECT * FROM dbo.T${i % 700}\nEXEC dbo.usp_${(i * 7) % 2000}\n-- ${'x'.repeat(1500)}`));
		const started = Date.now();
		const ordered = orderModules(modules);
		assert.ok(Date.now() - started < 500, `${Date.now() - started} ms`);
		assert.strictEqual(new Set(ordered).size, 2000);
	});

	test('a module is after what it calls, through a chain of any length', () => {
		const modules = Array.from({ length: 300 }, (_, i) => mod('procedure', `p${i}`, `CREATE PROC dbo.p${i} AS ${i < 299 ? `EXEC dbo.p${i + 1}` : 'SELECT 1'}`));
		const names = orderModules(modules).map(m => m.name);
		assert.strictEqual(names[0], 'p299');
		assert.strictEqual(names[299], 'p0');
	});

	test('a table is created before the foreign keys that point at it, and dropped last', () => {
		const result = script({ tables: [table('Old')] }, { tables: [table('New', { foreignKeys: [fk('FK_n', ['id'], 'Other', ['id'])] }), table('Other', { primaryKey: pk('PK_O', ['id']) })] }, { allowDestructive: true });
		assert.ok(at(result, 'CREATE TABLE [dbo].[Other]') < at(result, 'FOREIGN KEY'));
		assert.ok(at(result, 'FOREIGN KEY') < at(result, 'DROP TABLE [dbo].[Old]'));
	});
});

suite('migrationScript: what is left out, and said', () => {
	test('a dropped column is left out unless destructive changes were asked for', () => {
		const reference = { tables: [table('T', { columns: [column('id'), column('a')] })] };
		const current = { tables: [table('T')] };
		const refused = script(reference, current);
		assert.strictEqual(refused.steps, 0);
		assert.ok(refused.script.includes('-- Left out: drop column a of dbo.T. It loses data'));
		assert.deepStrictEqual(refused.skipped.map(s => s.op), ['dropColumn']);
		const asked = script(reference, current, { allowDestructive: true });
		assert.ok(asked.script.includes("IF COL_LENGTH(N'[dbo].[T]', N'a') IS NOT NULL\n    ALTER TABLE [dbo].[T] DROP COLUMN [a];"));
		assert.strictEqual(asked.skipped.length, 0);
	});

	test('the default of a column goes before the column does', () => {
		const result = script({ tables: [table('T', { columns: [column('id'), column('a', { default: { name: 'DF', definition: '((0))', systemNamed: false } })] })] }, { tables: [table('T')] }, { allowDestructive: true });
		assert.ok(at(result, 'DROP CONSTRAINT') > -1 && at(result, 'DROP CONSTRAINT') < at(result, 'DROP COLUMN'));
	});

	test('an identity cannot be changed in place, destructive or not', () => {
		const reference = { tables: [table('T')] };
		const current = { tables: [table('T', { columns: [column('id', { identity: { seed: '1', increment: '1' } })] })] };
		const result = script(reference, current, { allowDestructive: true });
		assert.strictEqual(result.steps, 0);
		assert.ok(result.skipped[0].reason.includes('by hand'));
	});

	test('a dropped table and a narrower type are destructive', () => {
		const result = script({ tables: [table('Gone'), table('T', { columns: [column('c', { type: 'varchar(50)' })] })] }, { tables: [table('T', { columns: [column('c', { type: 'varchar(10)' })] })] });
		assert.deepStrictEqual(result.skipped.map(s => s.op).sort(), ['alterColumn', 'dropTable']);
	});

	test('a NOT NULL column with nothing to fill it is a warning, and still written', () => {
		const result = script({ tables: [table('T')] }, { tables: [table('T', { columns: [column('id'), column('a')] })] });
		assert.ok(result.warnings.some(w => w.includes('dbo.T.a')));
		assert.ok(result.script.includes('ADD [a] int NOT NULL;'));
		assert.ok(result.script.includes('caution'));
	});

	test('a user-defined type is a warning: it has to exist on the target', () => {
		const udt = column('code', { type: '[dbo].[Code]' });
		const created = script({}, { tables: [table('T', { columns: [column('id'), udt] })] });
		assert.ok(created.warnings.some(w => w.includes('dbo.T.code') && w.includes('[dbo].[Code]') && w.includes('has to exist on the target')));
		const added = script({ tables: [table('T')] }, { tables: [table('T', { columns: [column('id'), udt] })] });
		assert.strictEqual(added.warnings.filter(w => w.includes('has to exist on the target')).length, 1);
		const plain = script({ tables: [table('T')] }, { tables: [table('T', { columns: [column('id'), column('n', { type: 'nvarchar(10)', nullable: true })] })] });
		assert.deepStrictEqual(plain.warnings, []);
	});

	test('only the changes that were picked are written', () => {
		const reference = { tables: [table('A'), table('B')] };
		const current = { tables: [table('A', { columns: [column('id'), column('x', { nullable: true })] }), table('B', { columns: [column('id'), column('y', { nullable: true })] })] };
		const diff = diffModels(model(reference), model(current));
		const result = buildMigrationScript(diff, { selected: new Set([changeId(diff.changes[1])]) });
		assert.ok(result.script.includes('[y]') && !result.script.includes('[x]'));
		assert.deepStrictEqual(result.included, ['table:dbo.B']);
	});
});

suite('migrationScript: constraints and keys', () => {
	test('a constraint with a name the server made up is created unnamed and found by what it does', () => {
		const sysPk = pk('PK__T__1', ['id'], { systemNamed: true });
		const created = script({ tables: [table('T')] }, { tables: [table('T', { primaryKey: sysPk })] });
		assert.ok(created.script.includes('ADD PRIMARY KEY CLUSTERED ([id]);'));
		assert.ok(!created.script.includes('PK__T__1'));
		assert.ok(created.script.includes("kc.type = 'PK'"));

		const sysFk = fk('FK__T__1', ['p'], 'P', ['id'], { systemNamed: true });
		const dropped = script({ tables: [table('T', { foreignKeys: [sysFk] })] }, { tables: [table('T')] });
		assert.ok(!dropped.script.includes('FK__T__1'));
		assert.ok(dropped.script.includes("pc.name = N'p' AND rc.name = N'id'"));
		assert.ok(dropped.script.includes("DECLARE @sql nvarchar(max) = N'ALTER TABLE [dbo].[T] DROP CONSTRAINT ' + QUOTENAME(@n);"));
		assert.ok(dropped.script.includes('IF @n IS NOT NULL EXEC (@sql);'));
	});

	test('a unique constraint, an index with INCLUDE and a filter, a foreign key with its actions', () => {
		const ix = { name: 'IX', unique: true, clustered: false, columns: [{ name: 'a', desc: true }], included: ['b'], filter: '([a]>(0))', disabled: false };
		const unique = { name: 'UQ', systemNamed: false, clustered: false, columns: [{ name: 'a', desc: false }] };
		const result = script({ tables: [table('T')] }, { tables: [table('T', { indexes: [ix], uniques: [unique], foreignKeys: [fk('FK', ['a'], 'P', ['id'], { onDelete: 'SET_NULL', onUpdate: 'CASCADE' })] })] });
		assert.ok(result.script.includes('CREATE UNIQUE NONCLUSTERED INDEX [IX] ON [dbo].[T] ([a] DESC) INCLUDE ([b]) WHERE ([a]>(0));'));
		assert.ok(result.script.includes('ADD CONSTRAINT [UQ] UNIQUE NONCLUSTERED ([a]);'));
		assert.ok(result.script.includes('FOREIGN KEY ([a]) REFERENCES [dbo].[P] ([id]) ON DELETE SET NULL ON UPDATE CASCADE;'));
	});

	test('a changed index is dropped and created again, in the right order', () => {
		const ix = (columns) => ({ name: 'IX', unique: false, clustered: false, columns: columns.map(c => ({ name: c, desc: false })), included: [], filter: null, disabled: false });
		const result = script({ tables: [table('T', { indexes: [ix(['a'])] })] }, { tables: [table('T', { indexes: [ix(['a', 'b'])] })] });
		assert.ok(at(result, 'DROP INDEX [IX]') > -1 && at(result, 'DROP INDEX [IX]') < at(result, 'CREATE NONCLUSTERED INDEX [IX]'));
	});

	test('a type that changes takes the default out of the way, and puts it back', () => {
		const withDefault = type => table('T', { columns: [column('c', { type, default: { name: 'DF_c', definition: '((0))', systemNamed: false } })] });
		const result = script({ tables: [withDefault('int')] }, { tables: [withDefault('bigint')] });
		const drop = at(result, 'DROP CONSTRAINT');
		const alter = at(result, 'ALTER COLUMN [c] bigint NOT NULL;');
		const add = at(result, 'ADD CONSTRAINT [DF_c] DEFAULT ((0)) FOR [c];');
		assert.ok(drop > -1 && drop < alter && alter < add, [drop, alter, add].join());
		assert.ok(result.script.includes("NOT (t.name = N'bigint' AND c.is_nullable = 0)"));
	});

	test('a table is created whole: columns, defaults, computed, keys inline, the rest after', () => {
		const created = table('T', {
			columns: [column('id', { identity: { seed: '1', increment: '1' } }), column('n', { type: 'nvarchar(50)', nullable: true, collation: 'Latin1_General_CS_AS' }), column('d', { default: { name: 'DF', definition: '((1))', systemNamed: false } }), column('u', { computed: { definition: '(upper([n]))', persisted: true } })],
			primaryKey: pk('PK_T', ['id'])
		});
		const result = script({}, { tables: [created] });
		assert.ok(result.script.includes("IF OBJECT_ID(N'[dbo].[T]', N'U') IS NULL\nBEGIN\n    CREATE TABLE [dbo].[T] ("));
		assert.ok(result.script.includes('[id] int IDENTITY(1,1) NOT NULL,'));
		assert.ok(result.script.includes('[n] nvarchar(50) COLLATE Latin1_General_CS_AS NULL,'));
		assert.ok(result.script.includes('[d] int NOT NULL CONSTRAINT [DF] DEFAULT ((1)),'));
		assert.ok(result.script.includes('[u] AS (upper([n])) PERSISTED,'));
		assert.ok(result.script.includes('CONSTRAINT [PK_T] PRIMARY KEY CLUSTERED ([id])'));
	});

	test('names with brackets and quotes are quoted', () => {
		const result = script({ tables: [table("we]ird'T", {}, "s]'")] }, { tables: [table("we]ird'T", { columns: [column('id'), column("c]'", { nullable: true })] }, "s]'")] });
		assert.ok(result.script.includes("ALTER TABLE [s]]'].[we]]ird'T] ADD [c]]'] int NULL;"));
		assert.ok(result.script.includes("COL_LENGTH(N'[s]]''].[we]]ird''T]', N'c]''')"));
	});
});

suite('migrationScript: code objects', () => {
	test('CREATE OR ALTER keeps the options the module was made with, and the session is put back after', () => {
		const result = script({}, { modules: [mod('procedure', 'p', 'ALTER PROC dbo.p AS SELECT 1', { quotedIdentifier: false, ansiNulls: false })] });
		const parts = batches(result);
		const create = parts.findIndex(p => p.startsWith('CREATE OR ALTER PROC dbo.p'));
		assert.ok(create > 1, parts.join('|'));
		assert.ok(parts[create - 1].includes('SET ANSI_NULLS OFF;') && parts[create - 1].includes('SET QUOTED_IDENTIFIER OFF;'));
		assert.ok(parts[create - 1].startsWith('IF NOT EXISTS (SELECT 1 FROM #wf WHERE n = 0) SET NOEXEC ON;'));
		assert.ok(parts[create - 1].endsWith('UPDATE #wf SET t = GETDATE();'));
		assert.ok(!parts[create].includes('#wf'));
		assert.ok(parts[create + 1].includes('o.modify_date >= w.t') && parts[create + 1].endsWith('UPDATE #wf SET n = 1;'));
		assert.ok(parts[parts.length - 1].includes('SET QUOTED_IDENTIFIER ON;'));
	});

	test('before 2016 SP1: a procedure or a view gets a stand-in, then ALTER; a function is dropped and created', () => {
		const result = script({}, { modules: [
			mod('procedure', 'p', 'CREATE PROC dbo.p AS SELECT 1'), mod('view', 'v', 'CREATE VIEW dbo.v AS SELECT 1 a'),
			mod('function', 'f', 'CREATE FUNCTION dbo.f() RETURNS int AS BEGIN RETURN 1 END')
		] }, { createOrAlter: false });
		assert.ok(!result.script.includes('CREATE OR ALTER'));
		assert.ok(result.script.includes("EXEC (N'CREATE PROCEDURE [dbo].[p] AS RETURN 0')"));
		assert.ok(result.script.includes("EXEC (N'CREATE VIEW [dbo].[v] AS SELECT 1 AS stub')"));
		assert.ok(result.script.includes('\nALTER PROC dbo.p AS SELECT 1'));
		assert.ok(result.script.includes('\nALTER VIEW dbo.v AS SELECT 1 a'));
		assert.ok(result.script.includes('DROP FUNCTION [dbo].[f];'));
		assert.ok(result.script.includes('\nCREATE FUNCTION dbo.f() RETURNS int'));
	});

	test('a module that is only in the reference is dropped, last', () => {
		const result = script({ tables: [table('T')], modules: [mod('procedure', 'gone', 'CREATE PROC dbo.gone AS SELECT 1')] }, { tables: [table('T', { columns: [column('id'), column('a', { nullable: true })] })] });
		assert.ok(result.script.includes("IF OBJECT_ID(N'[dbo].[gone]', N'P') IS NOT NULL\n    DROP PROCEDURE [dbo].[gone];"));
		assert.ok(at(result, 'DROP PROCEDURE') > at(result, 'ADD [a]'));
	});

	test('a definition that cannot be read is left out, and said', () => {
		const result = script({}, { modules: [mod('procedure', 'p', null)] });
		assert.strictEqual(result.steps, 0);
		assert.ok(result.skipped[0].reason.includes('cannot be read'));
	});

	test('triggers: created after the code, disabled if they are, moved ones dropped first', () => {
		const trigger = extra => mod('trigger', 'trg', 'CREATE TRIGGER dbo.trg ON dbo.T AFTER INSERT AS SELECT 1', Object.assign({ parent: 'dbo.T', disabled: false }, extra));
		const added = script({}, { modules: [trigger({ disabled: true }), mod('procedure', 'p', 'CREATE PROC dbo.p AS SELECT 1')] });
		assert.ok(at(added, 'CREATE OR ALTER PROC') < at(added, 'CREATE OR ALTER TRIGGER'));
		assert.ok(added.script.includes('DISABLE TRIGGER [dbo].[trg] ON [dbo].[T];'));
		const moved = script({ modules: [trigger()] }, { modules: [trigger({ parent: 'dbo.U', definition: 'CREATE TRIGGER dbo.trg ON dbo.U AFTER INSERT AS SELECT 1' })] });
		assert.ok(at(moved, 'DROP TRIGGER [dbo].[trg]') > -1 && at(moved, 'DROP TRIGGER [dbo].[trg]') < at(moved, 'CREATE OR ALTER TRIGGER'));
		const enabled = script({ modules: [trigger({ disabled: true })] }, { modules: [trigger()] });
		assert.ok(enabled.script.includes('ENABLE TRIGGER [dbo].[trg] ON [dbo].[T];'));
		assert.ok(!enabled.script.includes('CREATE OR ALTER TRIGGER'));
	});
});

suite('migrationScript: helpers', () => {
	test('CREATE OR ALTER exists from 2016 SP1', () => {
		assert.strictEqual(supportsCreateOrAlter('16.0.4305.5'), true);
		assert.strictEqual(supportsCreateOrAlter('13.0.4001.0'), true);
		assert.strictEqual(supportsCreateOrAlter('13.0.1601.5'), false);
		assert.strictEqual(supportsCreateOrAlter('12.0.6024.0'), false);
		assert.strictEqual(supportsCreateOrAlter(undefined), false);
	});

	test('the header of a definition is replaced, not the words that look like it', () => {
		assert.strictEqual(withHeader('-- CREATE\nalter proc p as select 1', 'CREATE OR ALTER'), '-- CREATE\nCREATE OR ALTER proc p as select 1');
		assert.strictEqual(withHeader('select 1', 'CREATE'), null);
	});
});
