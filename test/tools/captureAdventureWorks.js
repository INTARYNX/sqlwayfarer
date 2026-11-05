'use strict';

// Captures real result sets of AdventureWorks into test/e2e/fixtures/adventureworks.json,
// in the shape the page receives them (columns, types, rows by column name,
// dates as the ISO strings the message carries). The e2e suites replay them,
// so the grid is tested on real data - wide rows, long text, xml - without a
// SQL Server. Reads the connection from SQLWAYFARER_TEST_SQL (a server that
// has AdventureWorks) and is run by hand: npm run e2e:fixtures
const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const { describeColumn } = require('../../database/columnTypes');
const { uniqueColumnKeys } = require('../../database/resultColumns');

const QUERIES = {
	// 26 columns, a description of up to 400 characters.
	products: `SELECT TOP 100 p.*, d.Description
		FROM Production.Product p
		JOIN Production.ProductModelProductDescriptionCulture c ON c.ProductModelID = p.ProductModelID AND c.CultureID = 'en'
		JOIN Production.ProductDescription d ON d.ProductDescriptionID = c.ProductDescriptionID
		ORDER BY p.ProductID`,
	// Enough rows to scroll, and an xml column that is long.
	people: `SELECT TOP 300 * FROM Person.Person ORDER BY BusinessEntityID`
};

async function main() {
	const config = JSON.parse(process.env.SQLWAYFARER_TEST_SQL || 'null');
	if (!config) throw new Error('SQLWAYFARER_TEST_SQL is not set');
	const pool = await new sql.ConnectionPool({ ...config, database: 'AdventureWorks' }).connect();
	const out = {};
	try {
		for (const [name, query] of Object.entries(QUERIES)) {
			const request = pool.request();
			request.arrayRowMode = true;
			const result = await request.query(query);
			const columns = result.columns[0];
			const keys = uniqueColumnKeys(columns);
			const rows = result.recordset.map(row => {
				const byKey = {};
				keys.forEach((key, i) => { byKey[key] = row[i]; });
				return byKey;
			});
			// What goes through postMessage: dates become strings, buffers arrays.
			out[name] = JSON.parse(JSON.stringify({ columns: keys, types: columns.map(describeColumn), rows, totalRows: rows.length }));
		}
	} finally {
		await pool.close();
	}
	const file = path.join(__dirname, '..', 'e2e', 'fixtures', 'adventureworks.json');
	fs.writeFileSync(file, JSON.stringify(out));
	console.log(`${file}: ${Object.entries(out).map(([k, v]) => `${k} ${v.columns.length} columns x ${v.rows.length} rows`).join(', ')}`);
}

main().catch(error => { console.error(error); process.exit(1); });
