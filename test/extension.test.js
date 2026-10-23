const assert = require('assert');
const vscode = require('vscode');

suite('Extension activation', () => {
	test('sqlwayfarer.sqlwayfarer command is registered', async () => {
		const extension = vscode.extensions.getExtension('intarynx.sqlwayfarer');
		if (extension && !extension.isActive) {
			await extension.activate();
		}

		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('sqlwayfarer.sqlwayfarer'), 'sqlwayfarer.sqlwayfarer should be registered after activation');
	});
});
