const assert = require('assert');
const { isConnectionLostMessage } = require('../database/connectionLoss');

suite('isConnectionLostMessage', () => {
	test('recognises what the drivers say when the connection is gone', () => {
		for (const text of [
			'Failed to get objects: Connection lost - read ECONNRESET',
			'write EPIPE',
			'Connection is closed.',
			'Connection closed by the server',
			'Requests can only be made in the LoggedIn state, not the Final state',
			'A transport-level error has occurred when receiving results from the server.',
			'The connection is broken and recovery is not possible.',
			'A network-related or instance-specific error occurred while establishing a connection to SQL Server.',
			'socket hang up',
			'The Windows authentication helper stopped unexpectedly (exit code 1).',
			'The Windows authentication helper is not running.'
		]) {
			assert.ok(isConnectionLostMessage(text), text);
		}
	});

	test('an ordinary SQL error is not a lost connection', () => {
		for (const text of [
			"Line 3: Invalid object name 'Sales.Orders'.",
			"Incorrect syntax near 'FROM'.",
			"Login failed for user 'sa'.",
			'Query timed out after 300s and was cancelled.',
			'Query cancelled.',
			'Cannot insert duplicate key row in object dbo.T with unique index IX.',
			'Failed to get table details: Invalid column name x'
		]) {
			assert.ok(!isConnectionLostMessage(text), text);
		}
	});

	test('no text, no loss', () => {
		assert.strictEqual(isConnectionLostMessage(''), false);
		assert.strictEqual(isConnectionLostMessage(undefined), false);
		assert.strictEqual(isConnectionLostMessage(null), false);
	});
});
