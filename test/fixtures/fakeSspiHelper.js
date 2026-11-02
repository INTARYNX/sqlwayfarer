'use strict';

// Stands in for helper/SqlWayfarerSspi.exe in the tests: same JSON-lines
// protocol, canned answers chosen by the SQL text.
const readline = require('readline');

const send = message => process.stdout.write(JSON.stringify(message) + '\n');
let nextSession = 0;
const running = new Map();

readline.createInterface({ input: process.stdin }).on('line', line => {
	const message = JSON.parse(line);
	const id = message.id;
	switch (message.op) {
		case 'open':
			if (message.server === 'badlogin') {
				send({ id, fail: { message: "Login failed for user 'X'.", number: 18456 } });
			} else {
				send({ id, end: true, session: ++nextSession });
			}
			break;
		case 'cancel':
			if (running.has(message.target)) {
				const { id: target } = running.get(message.target);
				running.delete(message.target);
				send({ id: target, fail: { message: 'Operation cancelled by user.' } });
			}
			break;
		case 'exit':
			process.exit(0);
			break;
		case 'query':
			query(message);
			break;
	}
});

function query(message) {
	const id = message.id;
	switch (message.sql) {
		case 'SELECT':
			send({ id, ev: 'recordset', columns: [
				{ name: 'a', type: 'int', kind: 'value' },
				{ name: 'd', type: 'datetime', kind: 'date' },
				{ name: 'b', type: 'varbinary', kind: 'binary' }
			] });
			send({ id, ev: 'rows', rows: [[1, '2020-01-02T03:04:05.000Z', 'AQI='], [2, null, null]] });
			send({ id, ev: 'rowsaffected', count: 2 });
			send({ id, ev: 'info', message: 'hello', number: 0 });
			send({ id, end: true });
			break;
		case 'ERROR':
			send({ id, ev: 'error', message: 'Invalid object name', number: 208, lineNumber: 3, class: 16, state: 1 });
			send({ id, end: true });
			break;
		case 'PARAMS':
			send({ id, ev: 'recordset', columns: [{ name: 'p', type: 'nvarchar', kind: 'value' }] });
			send({ id, ev: 'rows', rows: [[JSON.stringify(message.params)]] });
			send({ id, end: true });
			break;
		case 'SESSION':
			send({ id, ev: 'recordset', columns: [{ name: 's', type: 'int', kind: 'value' }] });
			send({ id, ev: 'rows', rows: [[message.session]] });
			send({ id, end: true });
			break;
		case 'DIE':
			process.exit(1);
			break;
		case 'SLOW':
			// Never answers by itself: only a cancel ends it.
			running.set(id, { id });
			break;
		default:
			send({ id, end: true });
	}
}
