const assert = require('assert');
const FileTree = require('../webview/fileTree');

// The workspace the extension sends: a flat list, each file carrying the
// directory it lives in, relative to the workspace root.
const files = [
	{ name: 'root.sql', path: 'D:/ws/root.sql', relativeDir: '' },
	{ name: '01_init.sql', path: 'D:/ws/app/scripts/01_init.sql', relativeDir: 'app/scripts' },
	{ name: '02_seed.sql', path: 'D:/ws/app/scripts/02_seed.sql', relativeDir: 'app/scripts' },
	{ name: 'api.sql', path: 'D:/ws/app/api/api.sql', relativeDir: 'app/api' },
	{ name: 'deep.sql', path: 'D:/ws/app/api/deep/deep.sql', relativeDir: 'app/api/deep' }
];

suite('FileTree.buildFileTree', () => {
	test('nests folders by path segment', () => {
		const root = FileTree.buildFileTree(files);
		assert.strictEqual(root.files.length, 1, 'the root keeps the files that sit at the workspace root');
		assert.deepStrictEqual([...root.folders.keys()], ['app']);

		const app = root.folders.get('app');
		assert.deepStrictEqual([...app.folders.keys()].sort(), ['api', 'scripts']);

		const api = app.folders.get('api');
		assert.deepStrictEqual([...api.folders.keys()], ['deep']);
		assert.strictEqual(api.files.length, 1, 'app/api holds api.sql itself');
		assert.strictEqual(api.folders.get('deep').files.length, 1);
	});

	test('a folder keeps the path it was built from', () => {
		const root = FileTree.buildFileTree(files);
		const deep = root.folders.get('app').folders.get('api').folders.get('deep');
		assert.strictEqual(deep.path, 'app/api/deep');
	});

	test('counts the files of a folder and of everything below it', () => {
		const root = FileTree.buildFileTree(files);
		assert.strictEqual(FileTree.countSubtree(root), 5);
		assert.strictEqual(FileTree.countSubtree(root.folders.get('app')), 4);
		assert.strictEqual(FileTree.countSubtree(root.folders.get('app').folders.get('api')), 2);
	});

	test('counts the folders of the tree, root included', () => {
		const root = FileTree.buildFileTree(files);
		// root, app, app/api, app/api/deep, app/scripts
		assert.strictEqual(FileTree.countFolders(root), 5);
	});
});

suite('FileTree.filterFiles', () => {
	test('matches on the file name', () => {
		const hits = FileTree.filterFiles(files, 'seed');
		assert.deepStrictEqual(hits.map(f => f.name), ['02_seed.sql']);
	});

	test('matches on the folder path and keeps every file of that folder', () => {
		const hits = FileTree.filterFiles(files, 'app/api');
		assert.deepStrictEqual(hits.map(f => f.name), ['api.sql', 'deep.sql']);
	});

	test('an empty filter keeps everything', () => {
		assert.strictEqual(FileTree.filterFiles(files, '').length, files.length);
		assert.strictEqual(FileTree.filterFiles(files, '   ').length, files.length);
	});
});

suite('FileTree.renderFileTree', () => {
	test('shows the folder name, not its whole path', () => {
		const html = FileTree.renderFileTree(FileTree.buildFileTree(files));
		assert.ok(html.includes('>scripts<'), 'the folder is labelled with its own name');
		assert.ok(!html.includes('>app/scripts<'), 'the path is not repeated in the label');
	});

	test('shows the number of files of each folder', () => {
		const html = FileTree.renderFileTree(FileTree.buildFileTree(files));
		assert.ok(html.includes('<span class="sql-file-count" title="2 files">2</span>'), 'two files in app/scripts');
		assert.ok(html.includes('<span class="sql-file-count" title="1 file">1</span>'), 'one file in app/api/deep');
		assert.ok(
			html.includes('<span class="sql-file-count" title="1 file here, 2 including sub-folders">2</span>'),
			'app/api holds one file and two counting its sub-folder'
		);
	});

	test('a closed folder hides its files but keeps its count', () => {
		const html = FileTree.renderFileTree(FileTree.buildFileTree(files), {
			collapsed: new Set(['app/scripts'])
		});
		assert.ok(!html.includes('01_init.sql'), 'the files of a closed folder are not rendered');
		assert.ok(html.includes('api.sql'), 'the files of the other folders are');
		assert.ok(html.includes('sql-file-folder collapsed'), 'the folder is marked as closed');
	});

	test('while filtering, everything stays open', () => {
		const html = FileTree.renderFileTree(FileTree.buildFileTree(files), {
			collapsed: new Set(['app/scripts']),
			filtering: true
		});
		assert.ok(html.includes('01_init.sql'), 'a filter must not hide its own results');
	});

	test('indents nested folders under their parent', () => {
		const html = FileTree.renderFileTree(FileTree.buildFileTree(files));
		assert.ok(html.includes('data-dir-toggle="app" style="--depth:0"'));
		assert.ok(html.includes('data-dir-toggle="app/api" style="--depth:1"'));
		assert.ok(html.includes('data-dir-toggle="app/api/deep" style="--depth:2"'));
	});

	test('escapes the names it prints', () => {
		const html = FileTree.renderFileTree(FileTree.buildFileTree([
			{ name: 'a&b.sql', path: 'D:/ws/a&b.sql', relativeDir: 'x"y' }
		]));
		assert.ok(html.includes('a&amp;b.sql'));
		assert.ok(!html.includes('x"y'), 'a quote in the path cannot break out of the attribute');
	});
});
