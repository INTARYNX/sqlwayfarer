import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'test/**/*.test.js',
	mocha: {
		// The first parse of a T-SQL definition in a process builds ANTLR's
		// decision caches, which takes a second and a half - the default
		// 2s timeout of mocha fails the test that happens to be first. The
		// timeout is the same one the unit suite uses, see .mocharc.json.
		timeout: 10000
	}
});
