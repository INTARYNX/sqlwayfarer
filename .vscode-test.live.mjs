import { defineConfig } from '@vscode/test-cli';

// The tests that need a real SQL Server. They run inside VS Code like the
// others - some of them load the handlers of the extension, which need the
// API of the host - and they read the connection from SQLWAYFARER_TEST_SQL.
// Without it, they skip themselves.
export default defineConfig({
	files: 'test/live*.test.js',
	// A fixed version: without one, every run first asks Microsoft which VS Code
	// is the latest, and a slow answer (15 s) fails the job before any test ran.
	// It is the minimum the extension supports (engines.vscode in package.json).
	version: '1.100.0',
	mocha: {
		// They create their databases, and one of them builds an index: the
		// default timeout of two seconds is not enough.
		timeout: 600000
	}
});
