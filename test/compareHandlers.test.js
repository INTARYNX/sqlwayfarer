const assert = require('assert');
const CompareHandlers = require('../panels/handlers/CompareHandlers');

const NOW = new Date(2026, 10, 3, 9, 5, 7);
const column = (name, extra) => Object.assign({
	schema_name: 'dbo', table_name: 'T', column_id: 1, column_name: name, type_name: 'int', is_user_defined: 0, type_schema: 'sys', max_length: 4, precision: 10, scale: 0,
	is_nullable: 0, is_identity: 0, seed: null, increment: null, is_computed: 0, computed_definition: null, is_persisted: null, collation_name: null,
	default_name: null, default_definition: null, default_system_named: null
}, extra);

// A server with two databases whose tables are given: { Ref: ['id'], Db: ['id', 'extra'] }.
function fakeManager(tables, { snapshots = [], version = '16.0.4305.5', failRead = null, name = 'srv', onBatch = null } = {}) {
	const log = [];
	return {
		log,
		tables,
		getServerName: () => name,
		connectWithSaved: async () => {},
		dispose: async () => { log.push('dispose'); },
		acquireConnection: async () => {
			let db = null;
			return {
				createRequest: () => ({
					batch: async text => {
						log.push(`[${db}] ${text}`);
						const switched = /^USE \[(.*?)\]/.exec(text);
						if (switched) db = switched[1];
						// What the script does to the database in use.
						if (/ADD \[extra\] int NULL;/.test(text) && db && tables[db] && !tables[db].includes('extra')) tables[db].push('extra');
						if (onBatch) onBatch(text);
						const use = /^USE \[(.*?)\];/.exec(text);
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
	const others = {};
	const handlers = new CompareHandlers(m => posts.push(m), {
		connectionManager: manager,
		confirm: async (message, detail, action) => { confirmed.push({ message, detail, action }); return answers.confirm !== false; },
		now: () => NOW,
		connectionStorage: { getSavedConnections: () => [{ name: 'Me', server: 'srv' }, { name: 'Prod', server: 'prod-sql' }] },
		getOwnName: () => 'Me',
		createManager: () => {
			const other = fakeManager(options.otherTables || { Live: ['id'] }, { name: 'prod-sql' });
			if (options.connectFails) other.connectWithSaved = async () => { throw new Error('login failed'); };
			others.last = other;
			return other;
		}
	});
	return { handlers, posts, confirmed, manager, others };
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
	suite('applying', () => {
		const IDS = ['table:dbo.T'];
		const ran = manager => manager.log.filter(l => /ADD \[extra\] int NULL;/.test(l));

		test('the connections to apply on: this one and the saved ones', () => {
			const { handlers, posts } = setup();
			handlers.handleGetTargets();
			assert.deepStrictEqual(posts[0], { command: 'compareTargets', own: { name: 'Me', server: 'srv' }, connections: [{ name: 'Prod', server: 'prod-sql' }] });
		});

		test('the databases of this connection leave out the one the changes come from; another connection is opened on demand, once', async () => {
			const { handlers, posts, others } = setup({ tables: { Ref: ['id'], Db: ['id', 'extra'], T1: ['id'] }, otherTables: { Live: ['id'], Staging: ['id'] } });
			await handlers.handleCompare('Db', 'Ref');
			posts.length = 0;
			await handlers.handleGetTargetDatabases('Me');
			assert.deepStrictEqual(posts[0].databases.sort(), ['Ref', 'T1']);
			await handlers.handleGetTargetDatabases('Prod');
			assert.deepStrictEqual(posts[1].databases.sort(), ['Live', 'Staging']);
			const first = others.last;
			await handlers.handleGetTargetDatabases('Prod');
			assert.strictEqual(others.last, first, 'the connection is kept');
		});

		test('a connection that cannot be opened is said, with the reason', async () => {
			const { handlers, posts } = setup({ connectFails: true });
			await handlers.handleGetTargetDatabases('Prod');
			assert.deepStrictEqual(posts[0].databases, []);
			assert.ok(posts[0].message.includes("Could not connect to 'Prod': login failed"));
		});

		test('where the target stands: to do, already done, or different from the reference', async () => {
			const tables = { Ref: ['id'], Db: ['id', 'extra'], Pending: ['id'], Done: ['id', 'extra'], Other: ['id', 'other'] };
			const { handlers, posts } = setup({ tables });
			await handlers.handleCompare('Db', 'Ref');
			posts.length = 0;
			for (const target of ['Pending', 'Done', 'Other']) await handlers.handleTargetStatus(IDS, false, false, 'Me', target);
			const [pending, done, other] = posts;
			assert.deepStrictEqual([pending.counts, done.counts, other.counts], [{ done: 0, pending: 1, differs: 0 }, { done: 1, pending: 0, differs: 0 }, { done: 0, pending: 0, differs: 1 }]);
			assert.deepStrictEqual(other.differs, ['table:dbo.T']);
			assert.strictEqual(pending.steps, 1);
			assert.strictEqual(pending.createOrAlter, true);
		});

		test('the script follows the version of the target, not of the source', async () => {
			const { handlers, posts } = setup({ tables: { Ref: ['id'], Db: ['id', 'extra'], T1: ['id'] } });
			await handlers.handleCompare('Db', 'Ref');
			posts.length = 0;
			await handlers.handleTargetStatus(IDS, false, false, 'Me', 'T1');
			assert.strictEqual(posts[0].createOrAlter, true);
			await handlers.handleTargetStatus(IDS, false, true, 'Me', 'T1');
			assert.strictEqual(posts[1].createOrAlter, false);
		});

		test('applying runs the script on the target after a yes, and says what is left', async () => {
			const { handlers, posts, confirmed, manager } = setup({ tables: { Ref: ['id'], Db: ['id', 'extra'], T1: ['id'] } });
			await handlers.handleCompare('Db', 'Ref');
			posts.length = 0;
			await handlers.handleApply(IDS, false, false, 'Me', 'T1');
			assert.strictEqual(confirmed.length, 1);
			assert.strictEqual(confirmed[0].message, 'Apply 1 step(s) to T1 on srv (this connection)?');
			assert.ok(confirmed[0].detail.startsWith('Target: T1 on srv (this connection)'));
			assert.ok(confirmed[0].detail.includes('0 change(s) already as in Db · 1 to do · 0 partly done'));
			assert.ok(confirmed[0].detail.includes('stops at the first error'));
			assert.strictEqual(confirmed[0].action, 'Apply');
			assert.strictEqual(ran(manager).length, 1);
			assert.ok(manager.log.some(l => l === '[null] USE [T1]'));
			assert.deepStrictEqual(manager.tables.T1, ['id', 'extra']);

			const applied = posts.find(p => p.command === 'compareApplied');
			assert.deepStrictEqual([applied.database, applied.errors, applied.stopped, applied.remaining], ['T1', [], false, []]);
			assert.ok(posts.some(p => p.command === 'compareApplyProgress' && p.total > 0));
		});

		test('nothing is run when the user says no', async () => {
			const { handlers, posts, manager } = setup({ tables: { Ref: ['id'], Db: ['id', 'extra'], T1: ['id'] } }, { confirm: false });
			await handlers.handleCompare('Db', 'Ref');
			posts.length = 0;
			await handlers.handleApply(IDS, false, false, 'Me', 'T1');
			assert.strictEqual(ran(manager).length, 0);
			assert.deepStrictEqual(posts.map(p => p.command), ['compareApplyDeclined']);
		});

		test('on another connection: the confirmation names it, and the script runs there', async () => {
			const { handlers, posts, confirmed, others, manager } = setup({ otherTables: { Live: ['id'] } });
			await handlers.handleCompare('Db', 'Ref');
			posts.length = 0;
			await handlers.handleApply(IDS, false, false, 'Prod', 'Live');
			assert.strictEqual(confirmed[0].message, 'Apply 1 step(s) to Live on prod-sql (Prod)?');
			assert.strictEqual(ran(others.last).length, 1);
			assert.strictEqual(ran(manager).length, 0, 'not on this connection');
		});

		test('a change that is not applied is listed as what is left', async () => {
			const { handlers, posts, manager } = setup({ tables: { Ref: ['id'], Db: ['id', 'extra'], T1: ['id'] }, onBatch: null });
			await handlers.handleCompare('Db', 'Ref');
			// This server ignores the ALTER: the column is still missing afterwards.
			const original = manager.acquireConnection;
			manager.acquireConnection = async () => {
				const conn = await original();
				const create = conn.createRequest;
				conn.createRequest = () => { const r = create(); const batch = r.batch; r.batch = async text => { if (/ADD \[extra\]/.test(text)) return { recordsets: [[]] }; return batch(text); }; return r; };
				return conn;
			};
			posts.length = 0;
			await handlers.handleApply(IDS, false, false, 'Me', 'T1');
			const applied = posts.find(p => p.command === 'compareApplied');
			assert.deepStrictEqual(applied.remaining, ['table:dbo.T']);
		});

		test('refused: no comparison, the database the changes come from, no database, nothing picked, two at once', async () => {
			const { handlers, posts } = setup({ tables: { Ref: ['id'], Db: ['id', 'extra'], T1: ['id'] } });
			await handlers.handleApply(IDS, false, false, 'Me', 'T1');
			await handlers.handleCompare('Db', 'Ref');
			posts.length = 0;
			await handlers.handleApply(IDS, false, false, 'Me', 'db');
			await handlers.handleApply(IDS, false, false, 'Me', '');
			await handlers.handleApply([], false, false, 'Me', 'T1');
			assert.deepStrictEqual(posts.map(p => p.command), ['compareFailed', 'compareFailed', 'compareFailed']);
			assert.ok(posts[0].message.includes('the changes come from'));
			assert.ok(posts[2].message.includes('Nothing to apply'));

			// The same database name on another connection is another database.
			posts.length = 0;
			await handlers.handleTargetStatus(IDS, false, false, 'Prod', 'Live');
			assert.strictEqual(posts[0].command, 'compareTargetStatus');
		});

		test('only a database that is offered can be a target: not a system database, not a snapshot, not an unknown name', async () => {
			const { handlers, posts, manager } = setup({ tables: { Ref: ['id'], Db: ['id', 'extra'], T1: ['id'] } });
			await handlers.handleCompare('Db', 'Ref');
			posts.length = 0;
			for (const name of ['master', 'tempdb', 'Db_ref_1', 'NoSuch']) await handlers.handleApply(IDS, false, false, 'Me', name);
			await handlers.handleTargetStatus(IDS, false, false, 'Me', 'master');
			assert.deepStrictEqual(posts.map(p => p.command), ['compareFailed', 'compareFailed', 'compareFailed', 'compareFailed', 'compareFailed']);
			assert.ok(posts[0].message.includes('not a database a script can be applied on'));
			assert.strictEqual(ran(manager).length, 0);
		});

		test('Azure SQL Database, which has no USE, is told in words', async () => {
			const { handlers, posts } = setup({ failRead: 'Ref' });
			const original = handlers._connectionManager.acquireConnection;
			handlers._connectionManager.acquireConnection = async () => { throw Object.assign(new Error('The USE statement is not supported to switch between databases.'), { number: 40508 }); };
			await handlers.handleCompare('Db', 'Ref');
			assert.ok(/Azure SQL Database/.test(posts[0].message));
			handlers._connectionManager.acquireConnection = original;
		});

		test('while one is being applied, another is refused; it can be stopped between batches', async () => {
			let release;
			const gate = new Promise(resolve => { release = resolve; });
			const posts = [];
			const manager = fakeManager({ Ref: ['id'], Db: ['id', 'extra'], T1: ['id'] });
			let handlers;
			const stopWhenRunning = text => { if (/ADD \[extra\]/.test(text)) handlers.handleCancelApply(); };
			const guarded = fakeManager({ Ref: ['id'], Db: ['id', 'extra'], T1: ['id'] }, { onBatch: stopWhenRunning });
			handlers = new CompareHandlers(m => posts.push(m), { connectionManager: guarded, confirm: async () => { await gate; return true; }, now: () => NOW, getOwnName: () => 'Me' });
			await handlers.handleCompare('Db', 'Ref');
			posts.length = 0;
			const first = handlers.handleApply(IDS, false, false, 'Me', 'T1');
			await new Promise(resolve => setTimeout(resolve, 20));
			await handlers.handleApply(IDS, false, false, 'Me', 'T1');
			assert.ok(posts.some(p => p.command === 'compareFailed' && p.message.includes('being applied')));
			release();
			await first;
			const applied = posts.find(p => p.command === 'compareApplied');
			assert.strictEqual(applied.stopped, true, 'stopped after the batch that asked for it');
			assert.ok(manager);
		});

		test('a new connection of the tab ends the comparison, and closes the connections opened for targets', async () => {
			const { handlers, others } = setup();
			await handlers.handleCompare('Db', 'Ref');
			await handlers.handleGetTargetDatabases('Prod');
			await handlers.reset();
			assert.ok(others.last.log.includes('dispose'));
			handlers.handleBuildScript(['table:dbo.T'], false, false);
		});
	});
});
