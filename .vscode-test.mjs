import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'test/**/*.test.js',
	// A fixed version: without one, every run first asks Microsoft which VS Code
	// is the latest, and a slow answer (15 s) fails the job before any test ran.
	// It is the minimum the extension supports (engines.vscode in package.json).
	version: '1.100.0',
	mocha: {
		// The first parse of a T-SQL definition in a process builds ANTLR's
		// decision caches, which takes a second and a half - the default
		// 2s timeout of mocha fails the test that happens to be first. The
		// timeout is the same one the unit suite uses, see .mocharc.json.
		timeout: 10000
	}
});
