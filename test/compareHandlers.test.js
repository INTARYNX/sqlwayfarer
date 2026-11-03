const assert = require('assert');
const CompareHandlers = require('../panels/handlers/CompareHandlers');

const NOW = new Date(2026, 10, 3, 9, 5, 7);
const column = (name, extra) => Object.assign({
	schema_name: 'dbo', table_name: 'T', column_id: 1, column_name: name, type_name: 'int', is_user_defined: 0, type_schema: 'sys', max_length: 4, precision: 10, scale: 0,
	is_nullable: 0, is_identity: 0, seed: null, increment: null, is_computed: 0, computed_definition: null, is_persisted: null, collation_name: null,
	default_name: null, default_definition: null, default_system_named: null
}, extra);

// A server with two databases whose tables are given: { Ref: ['id'], Db: ['id', 'extra'] }.
function fakeManager(tables, { snapshots = [], version = '16.0.4305.5', failRead = null } = {}) {
	const log = [];
	return {
		log,
		acquireConnection: async () => {
			let db = null;
			return {
				createRequest: () => ({
					batch: async text => {
						log.push(text);
						const use = /^USE \[(.*?)\];/.exec(text);
						if (use) db = use[1];
						if (!use) return { recordsets: [[]] };
						if (failRead === db) throw new Error(`cannot read ${db}`);
						const columns = (tables[db] || []).map((name, i) => column(name, { column_id: i + 1, is_nullable: name === 'extra' ? 1 : 0 }));
						return { recordsets: [[{ version, collation: 'C' }], [], columns, [], [], [], [], []] };
					}
				}),
				release: () => {}
			};
		},
		executeQueryInDatabase: async (database, sql, params) => {
			log.push(sql);
			if (sql.includes('source_database_id IS NOT NULL AND (@source')) return { recordset: snapshots.map(s => ({ name: s, source: params.source, create_date: NOW, state_desc: 'ONLINE' })) };
			if (sql.includes("state_desc = 'ONLINE' AND (@exclude")) return { recordset: Object.keys(tables).filter(n => n !== params.exclude).map(name => ({ name })) };
			if (sql.includes('FROM sys.databases d WHERE')) return { recordset: [{ engine: 3, version, database_id: 7, source_database_id: null, state_desc: 'ONLINE', filestream_files: 0 }] };
			if (sql.includes('SELECT name FROM sys.databases')) return { recordset: [{ name: 'Db' }] };
			if (sql.includes('FROM sys.master_files')) return { recordset: [{ name: 'Db', physical_name: '/data/Db.mdf' }] };
			if (sql.startsWith('DROP DATABASE') || sql.startsWith('CREATE DATABASE')) return { recordset: [] };
			return { recordset: [] };
		}
	};
}

function setup(options = {}, answers = {}) {
	const posts = [];
	const confirmed = [];
	const manager = fakeManager(options.tables || { Ref: ['id'], Db: ['id', 'extra'] }, options);
	const handlers = new CompareHandlers(m => posts.push(m), {
		connectionManager: manager,
		confirm: async (message, detail, action) => { confirmed.push({ message, detail, action }); return answers.confirm !== false; },
		now: () => NOW
	});
	return { handlers, posts, confirmed, manager };
}

suite('CompareHandlers', () => {
	test('the sources: the snapshots of the database, the other databases, and whether it can have a snapshot', async () => {
		const { handlers, posts } = setup({ snapshots: ['Db_ref_1'] });
		await handlers.handleGetSources('Db');
		const sources = posts[0];
		assert.strictEqual(sources.command, 'compareSources');
		assert.deepStrictEqual(sources.snapshots.map(s => s.name), ['Db_ref_1']);
		assert.deepStrictEqual(sources.databases, ['Ref']);
		assert.deepStrictEqual(sources.support, { supported: true });
	});

	test('no database, no sources, and a reason', async () => {
		const { handlers, posts } = setup();
		await handlers.handleGetSources(null);
		assert.strictEqual(posts[0].support.supported, false);
	});

	test('the comparison reads both databases and says what changed, and whether CREATE OR ALTER can be used', async () => {
		const { handlers, posts } = setup();
		await handlers.handleCompare('Db', 'Ref');
		const result = posts[0];
		assert.strictEqual(result.command, 'compareResult');
		assert.deepStrictEqual([result.database, result.reference], ['Db', 'Ref']);
		assert.deepStrictEqual(result.diff.changes.map(c => `${c.kind}:${c.name}:${c.status}`), ['table:dbo.T:modified']);
		assert.strictEqual(result.diff.changes[0].ops[0].op, 'addColumn');
		assert.strictEqual(result.createOrAlter, true);
		assert.ok(result.durationMs >= 0);
	});

	test('an old server is told to write the code without CREATE OR ALTER', async () => {
		const { handlers, posts } = setup({ version: '12.0.6024.0' });
		await handlers.handleCompare('Db', 'Ref');
		assert.strictEqual(posts[0].createOrAlter, false);
	});

	test('a database cannot be compared with itself, nor with nothing; a failure to read is reported', async () => {
		const { handlers, posts } = setup({ failRead: 'Ref' });
		await handlers.handleCompare('Db', 'db');
		await handlers.handleCompare('Db', '');
		await handlers.handleCompare('Db', 'Ref');
		assert.deepStrictEqual(posts.map(p => p.command), ['compareFailed', 'compareFailed', 'compareFailed']);
		assert.ok(posts[2].message.includes('cannot read Ref'));
	});

	test('the script is made of the changes that were picked, from the last comparison', async () => {
		const { handlers, posts } = setup();
		handlers.handleBuildScript(['table:dbo.T'], false, false);
		assert.strictEqual(posts[0].command, 'compareFailed');
		await handlers.handleCompare('Db', 'Ref');
		posts.length = 0;
		handlers.handleBuildScript(['table:dbo.T'], false, false);
		assert.strictEqual(posts[0].command, 'compareScript');
		assert.ok(posts[0].script.includes('ADD [extra] int NULL;'));
		assert.ok(posts[0].script.includes('From: Ref   To: Db   Generated: '));
		assert.strictEqual(posts[0].steps, 1);

		handlers.handleBuildScript([], false, false);
		assert.strictEqual(posts[1].steps, 0);
		handlers.handleBuildScript(undefined, false, false);
		assert.strictEqual(posts[2].steps, 0);
	});

	test('the legacy choice writes the code without CREATE OR ALTER', async () => {
		const { handlers, posts } = setup({ tables: { Ref: ['id'], Db: ['id'] } });
		await handlers.handleCompare('Db', 'Ref');
		posts.length = 0;
		handlers.handleBuildScript([], false, true);
		assert.ok(!posts[0].script.includes('CREATE OR ALTER'));
	});

	test('a snapshot is taken only after the SQL has been shown and the user said yes', async () => {
		const yes = setup();
		await yes.handlers.handleTakeSnapshot('Db');
		assert.strictEqual(yes.confirmed.length, 1);
		assert.ok(yes.confirmed[0].detail.startsWith('CREATE DATABASE [Db_ref_20261103_090507] ON'));
		assert.strictEqual(yes.confirmed[0].action, 'Take snapshot');
		assert.ok(yes.manager.log.some(sql => sql.startsWith('CREATE DATABASE')));
		assert.deepStrictEqual(yes.posts.map(p => p.command), ['compareSnapshotDone', 'compareSources']);
		assert.strictEqual(yes.posts[0].name, 'Db_ref_20261103_090507');

		const no = setup({}, { confirm: false });
		await no.handlers.handleTakeSnapshot('Db');
		assert.ok(!no.manager.log.some(sql => sql.startsWith('CREATE DATABASE')));
		assert.deepStrictEqual(no.posts, []);
	});

	test('a snapshot that cannot be taken says why', async () => {
		const { handlers, posts, manager } = setup();
		const original = manager.executeQueryInDatabase;
		manager.executeQueryInDatabase = async (db, sql, params) => (sql.includes('FROM sys.databases d WHERE')
			? { recordset: [{ engine: 5, version: '12.0', database_id: 7, source_database_id: null, state_desc: 'ONLINE', filestream_files: 0 }] }
			: original(db, sql, params));
		await handlers.handleTakeSnapshot('Db');
		assert.strictEqual(posts[0].command, 'compareFailed');
		assert.ok(/Azure SQL Database/.test(posts[0].message));
	});

	test('a snapshot is dropped after a yes, and only a snapshot of this database', async () => {
		const { handlers, posts, confirmed, manager } = setup({ snapshots: ['Db_ref_1'] });
		await handlers.handleDropSnapshot('Db', 'Other_ref');
		assert.strictEqual(posts[0].command, 'compareFailed');
		assert.strictEqual(confirmed.length, 0);

		posts.length = 0;
		await handlers.handleDropSnapshot('Db', 'Db_ref_1');
		assert.strictEqual(confirmed[0].action, 'Drop snapshot');
		assert.ok(manager.log.some(sql => sql === 'DROP DATABASE [Db_ref_1]'));
		assert.deepStrictEqual(posts.map(p => p.command), ['compareSnapshotDone', 'compareSources']);
	});
});
