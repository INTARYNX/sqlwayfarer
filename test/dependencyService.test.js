const assert = require('assert');
const DependencyService = require('../database/DependencyService');

// Cross-database dependencies: the index of a database stores the name of an
// object living in ANOTHER database with that database as a prefix
// ('OtherDb.dbo.Orders'), because that is how sys.dm_sql_referenced_entities
// reports it. These tests cover how such a name is split, how it is told
// apart from a local dependency, and how its real type is resolved.

suite('DependencyService.parseDependencyName', () => {
	test('splits a local two-part name', () => {
		assert.deepStrictEqual(
			DependencyService.parseDependencyName('dbo.Orders'),
			{ database: null, schema: 'dbo', object: 'Orders' }
		);
	});

	test('splits a database-qualified name', () => {
		assert.deepStrictEqual(
			DependencyService.parseDependencyName('OtherDb.dbo.Orders'),
			{ database: 'OtherDb', schema: 'dbo', object: 'Orders' }
		);
	});

	test('keeps the object name whole when it contains dots', () => {
		assert.deepStrictEqual(
			DependencyService.parseDependencyName('OtherDb.dbo.my.table'),
			{ database: 'OtherDb', schema: 'dbo', object: 'my.table' }
		);
	});

	test('handles a reference with an omitted schema', () => {
		assert.deepStrictEqual(
			DependencyService.parseDependencyName('OtherDb..Orders'),
			{ database: 'OtherDb', schema: '', object: 'Orders' }
		);
	});

	test('strips the brackets of a quoted name', () => {
		assert.deepStrictEqual(
			DependencyService.parseDependencyName('[OtherDb].[dbo].[Orders]'),
			{ database: 'OtherDb', schema: 'dbo', object: 'Orders' }
		);
	});

	test('falls back to dbo for a bare name', () => {
		assert.deepStrictEqual(
			DependencyService.parseDependencyName('Orders'),
			{ database: null, schema: 'dbo', object: 'Orders' }
		);
	});
});

suite('DependencyService.externalTarget', () => {
	test('a local dependency has no external target', () => {
		assert.strictEqual(DependencyService.externalTarget('dbo.Orders', 'MyDb'), null);
	});

	test('a dependency in another database is external', () => {
		assert.deepStrictEqual(
			DependencyService.externalTarget('OtherDb.dbo.Orders', 'MyDb'),
			{ database: 'OtherDb', schema: 'dbo', object: 'Orders' }
		);
	});

	test('a self-qualified name stays local', () => {
		// 'MyDb.dbo.Orders' written from MyDb: same database, just qualified.
		assert.strictEqual(DependencyService.externalTarget('MyDb.dbo.Orders', 'MyDb'), null);
	});

	test('the database comparison ignores case', () => {
		assert.strictEqual(DependencyService.externalTarget('mydb.dbo.Orders', 'MyDb'), null);
		assert.ok(DependencyService.externalTarget('otherdb.dbo.Orders', 'MyDb'));
	});
});

suite('DependencyService.getDependencies', () => {
	function makeService(objects) {
		const service = new DependencyService();
		service.setIndexService({ getIndex: async () => ({ objects }) });
		return service;
	}

	const INDEX = {
		'dbo.Orders': { name: 'Orders', schema: 'dbo', qualifiedName: 'dbo.Orders', type: 'U', dependencies: [] },
		'dbo.vOrders': { name: 'vOrders', schema: 'dbo', qualifiedName: 'dbo.vOrders', type: 'V', dependencies: ['OtherDb.dbo.Orders'] }
	};

	test('a dependency on another database is flagged external', async () => {
		const service = makeService(INDEX);
		const result = await service.getDependencies('MyDb', 'dbo.vOrders');

		assert.strictEqual(result.dependsOn.length, 1);
		assert.strictEqual(result.dependsOn[0].is_external, true);
		assert.strictEqual(result.dependsOn[0].external_database, 'OtherDb');
		assert.strictEqual(result.dependsOn[0].schema_name, 'dbo');
		assert.strictEqual(result.dependsOn[0].object_name, 'Orders');
	});

	test('an object of another database is not listed as "referenced by"', async () => {
		// dbo.vOrders depends on OtherDb.dbo.Orders, not on the dbo.Orders of
		// the database being browsed - same name, different object.
		const service = makeService(INDEX);
		const result = await service.getDependencies('MyDb', 'Orders');

		assert.deepStrictEqual(result.referencedBy, []);
	});

	test('a local object whose name contains a dot stays local', async () => {
		// 'dbo.my.table' has enough parts to look database-qualified, but it
		// is an object of THIS database - the index knows it under that name.
		const service = makeService({
			'dbo.vDotted': { name: 'vDotted', schema: 'dbo', qualifiedName: 'dbo.vDotted', type: 'V', dependencies: ['dbo.my.table'] },
			'dbo.my.table': { name: 'my.table', schema: 'dbo', qualifiedName: 'dbo.my.table', type: 'U', dependencies: [] }
		});
		const result = await service.getDependencies('MyDb', 'dbo.vDotted');

		assert.strictEqual(result.dependsOn.length, 1);
		assert.strictEqual(result.dependsOn[0].is_external, false);
		assert.strictEqual(result.dependsOn[0].external_database, null);
		assert.strictEqual(result.dependsOn[0].referenced_object_type, 'Table');
	});
});

suite('DependencyService._resolveExternalTypes', () => {
	function makeService(getObjectTypes) {
		const service = new DependencyService();
		service.setDatabaseService({ getObjectTypes });
		return service;
	}

	test('resolves the real type of an object living in another database', async () => {
		const asked = [];
		const service = makeService(async (database, names) => {
			asked.push({ database, names });
			return { 'person.person': 'Table' };
		});

		const entries = [{
			is_external: true, external_database: 'AdventureWorks',
			schema_name: 'Person', object_name: 'Person',
			referenced_object: 'AdventureWorks.Person.Person',
			referenced_object_type: 'Object'
		}];
		await service._resolveExternalTypes(entries);

		assert.strictEqual(entries[0].referenced_object_type, 'Table');
		assert.strictEqual(asked.length, 1);
		assert.strictEqual(asked[0].database, 'AdventureWorks');
		assert.deepStrictEqual(asked[0].names, ['person.person']);
	});

	test('asks each target database only once', async () => {
		const asked = [];
		const service = makeService(async (database) => {
			asked.push(database);
			return { 'dbo.orders': 'Table', 'dbo.customers': 'View' };
		});

		const entries = [
			{ is_external: true, external_database: 'OtherDb', schema_name: 'dbo', object_name: 'Orders', referenced_object_type: 'Object' },
			{ is_external: true, external_database: 'OtherDb', schema_name: 'dbo', object_name: 'Customers', referenced_object_type: 'Object' }
		];
		await service._resolveExternalTypes(entries);

		assert.deepStrictEqual(asked, ['OtherDb']);
		assert.strictEqual(entries[0].referenced_object_type, 'Table');
		assert.strictEqual(entries[1].referenced_object_type, 'View');
	});

	test('keeps the generic type when the other database cannot be read', async () => {
		const service = makeService(async () => { throw new Error('permission denied'); });

		const entries = [{
			is_external: true, external_database: 'OtherDb',
			schema_name: 'dbo', object_name: 'Orders',
			referenced_object_type: 'Object'
		}];
		await service._resolveExternalTypes(entries);

		// The dependency stays external and clickable, only its type is unknown.
		assert.strictEqual(entries[0].referenced_object_type, 'Object');
		assert.strictEqual(entries[0].is_external, true);
	});

	test('an object missing from the other database is local after all', async () => {
		// A local schema named like a database ('dbo.Orders' in a database
		// called 'dbo') looks database-qualified - but the object is not in
		// the database that name points at, so it is a local dependency.
		const service = makeService(async () => ({}));

		const entries = [{
			is_external: true, external_database: 'dbo',
			schema_name: 'Orders', object_name: 'Orders',
			referenced_object_type: 'Table'
		}];
		await service._resolveExternalTypes(entries);

		assert.strictEqual(entries[0].is_external, false);
		assert.strictEqual(entries[0].external_database, null);
		assert.strictEqual(entries[0].referenced_object_type, 'Table');
	});

	test('does nothing without a database service', async () => {
		const service = new DependencyService();
		const entries = [{
			is_external: true, external_database: 'OtherDb',
			schema_name: 'dbo', object_name: 'Orders',
			referenced_object_type: 'Object'
		}];
		await service._resolveExternalTypes(entries);
		assert.strictEqual(entries[0].referenced_object_type, 'Object');
	});
});
