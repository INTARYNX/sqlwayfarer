const assert = require('assert');
const ScriptGeneratorService = require('../database/ScriptGeneratorService');

// INFORMATION_SCHEMA-style column rows as returned by getTableDetails
function col(name, overrides = {}) {
	return {
		COLUMN_NAME: name, DATA_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null,
		CHARACTER_MAXIMUM_LENGTH: null, NUMERIC_PRECISION: 10, NUMERIC_SCALE: 0,
		DATETIME_PRECISION: null, IS_IDENTITY: 0, IS_COMPUTED: 0,
		IDENTITY_SEED: null, IDENTITY_INCREMENT: null, COMPUTED_DEFINITION: null,
		...overrides
	};
}

const employeeColumns = [
	col('Id', { IS_IDENTITY: 1, IDENTITY_SEED: 1, IDENTITY_INCREMENT: 1 }),
	col('Name', { DATA_TYPE: 'nvarchar', CHARACTER_MAXIMUM_LENGTH: 50 }),
	col('HireDate', { DATA_TYPE: 'datetime', IS_NULLABLE: 'YES' }),
	col('FullName', { IS_COMPUTED: 1, COMPUTED_DEFINITION: "([Name]+' ')" })
];

const pkIndex = {
	index_name: 'PK_Employee', type_desc: 'CLUSTERED', is_unique: true,
	is_primary_key: true, is_unique_constraint: false, columns: 'Id',
	fill_factor: 0, has_filter: false, filter_definition: null
};

suite('ScriptGeneratorService builders', () => {
	test('SELECT lists every column, bracketed', () => {
		const sql = ScriptGeneratorService.buildSelect('[dbo].[Employee]', employeeColumns);
		assert.ok(sql.startsWith('SELECT'));
		assert.ok(sql.includes('    [Id],'));
		assert.ok(sql.includes('    [FullName]\n'));
		assert.ok(sql.endsWith('FROM [dbo].[Employee];'));
	});

	test('INSERT skips identity and computed columns and annotates types', () => {
		const sql = ScriptGeneratorService.buildInsert('[dbo].[Employee]', employeeColumns);
		assert.ok(!sql.includes('[Id]'), 'identity column excluded');
		assert.ok(!sql.includes('[FullName]'), 'computed column excluded');
		assert.ok(sql.includes('[Name]'));
		assert.ok(sql.includes("N'' -- Name nvarchar(50) NOT NULL"));
		assert.ok(sql.includes('NULL -- HireDate datetime'));
	});

	test('UPDATE uses the primary key in the WHERE clause', () => {
		const sql = ScriptGeneratorService.buildUpdate('[dbo].[Employee]', employeeColumns, [pkIndex]);
		assert.ok(sql.includes("SET [Name] = N''"));
		assert.ok(sql.includes('WHERE [Id] = 0;'));
		assert.ok(!sql.includes('SET [Id]'), 'identity not in SET');
	});

	test('UPDATE without a primary key leaves an explicit placeholder', () => {
		const sql = ScriptGeneratorService.buildUpdate('[dbo].[Employee]', employeeColumns, []);
		assert.ok(sql.includes('WHERE /* no primary key'));
	});

	test('CREATE TABLE renders identity, nullability, computed column and PK', () => {
		const details = { columns: employeeColumns, indexes: [pkIndex], foreignKeys: [] };
		const sql = ScriptGeneratorService.buildCreateTable('[dbo].[Employee]', details);
		assert.ok(sql.includes('[Id] int IDENTITY(1,1) NOT NULL'));
		assert.ok(sql.includes('[Name] nvarchar(50) NOT NULL'));
		assert.ok(sql.includes('[HireDate] datetime NULL'));
		assert.ok(sql.includes("[FullName] AS ([Name]+' ')"));
		assert.ok(sql.includes('CONSTRAINT [PK_Employee] PRIMARY KEY CLUSTERED ([Id])'));
	});

	test('CREATE TABLE emits secondary indexes and grouped multi-column FKs', () => {
		const details = {
			columns: employeeColumns,
			indexes: [pkIndex, {
				index_name: 'IX_Name', type_desc: 'NONCLUSTERED', is_unique: true,
				is_primary_key: false, is_unique_constraint: false, columns: 'Name',
				fill_factor: 0, has_filter: true, filter_definition: '([Name] IS NOT NULL)'
			}],
			foreignKeys: [
				{ fk_name: 'FK_Emp_Dept', column_name: 'DeptId', referenced_table: 'dbo.Dept', referenced_column: 'Id', delete_referential_action_desc: 'CASCADE', update_referential_action_desc: 'NO_ACTION' },
				{ fk_name: 'FK_Emp_Dept', column_name: 'DeptRegion', referenced_table: 'dbo.Dept', referenced_column: 'Region', delete_referential_action_desc: 'CASCADE', update_referential_action_desc: 'NO_ACTION' }
			]
		};
		const sql = ScriptGeneratorService.buildCreateTable('[dbo].[Employee]', details);
		assert.ok(sql.includes('CREATE UNIQUE NONCLUSTERED INDEX [IX_Name] ON [dbo].[Employee] ([Name]) WHERE ([Name] IS NOT NULL);'));
		assert.ok(sql.includes('FOREIGN KEY ([DeptId], [DeptRegion]) REFERENCES [dbo].[Dept] ([Id], [Region]) ON DELETE CASCADE;'));
		assert.strictEqual((sql.match(/FK_Emp_Dept/g) || []).length, 1, 'multi-column FK emitted once');
	});

	test('EXEC declares OUTPUT parameters and selects them back', () => {
		const sql = ScriptGeneratorService.buildExec('[dbo].[uspHire]', [
			{ name: '@Name', data_type: 'nvarchar', max_length: 100, precision: 0, scale: 0, is_output: false },
			{ name: '@NewId', data_type: 'int', max_length: 4, precision: 10, scale: 0, is_output: true }
		]);
		assert.ok(sql.includes('DECLARE @NewId int;'));
		assert.ok(sql.includes("@Name = N'', -- nvarchar(50)"));
		assert.ok(sql.includes('@NewId = @NewId OUTPUT; -- int'));
		assert.ok(sql.includes('SELECT @NewId AS [NewId];'));
	});

	test('EXEC without parameters is a single line', () => {
		assert.strictEqual(ScriptGeneratorService.buildExec('[dbo].[uspNoArgs]', []), 'EXEC [dbo].[uspNoArgs];');
	});

	test('function SELECT: scalar vs table-valued call shape', () => {
		const params = [{ name: '@Y', data_type: 'int', max_length: 4, precision: 10, scale: 0, is_output: false }];
		assert.ok(ScriptGeneratorService.buildFunctionSelect('[dbo].[fnAge]', params, true).startsWith('SELECT [dbo].[fnAge]('));
		assert.ok(ScriptGeneratorService.buildFunctionSelect('[dbo].[fnList]', params, false).includes('FROM [dbo].[fnList]('));
	});

	test('nvarchar parameter lengths are converted from bytes to characters', () => {
		assert.strictEqual(
			ScriptGeneratorService.formatParamType({ data_type: 'nvarchar', max_length: 100, precision: 0, scale: 0 }),
			'nvarchar(50)'
		);
		assert.strictEqual(
			ScriptGeneratorService.formatParamType({ data_type: 'varchar', max_length: -1, precision: 0, scale: 0 }),
			'varchar(MAX)'
		);
	});
});
