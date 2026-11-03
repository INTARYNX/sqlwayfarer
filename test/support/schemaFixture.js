// A scratch database with a bit of everything the schema model reads, for the
// live suites. Used through SQLWAYFARER_TEST_SQL (see AGENTS.md).

const { splitBatches } = require('../../database/sqlBatches');

const RICH_SCHEMA = `
CREATE SCHEMA Sales;
GO
CREATE TYPE dbo.Code FROM varchar(10) NOT NULL;
GO
CREATE TABLE Sales.Customer (
	id int IDENTITY(1,1) NOT NULL CONSTRAINT PK_Customer PRIMARY KEY CLUSTERED,
	code dbo.Code,
	name nvarchar(100) NOT NULL,
	email varchar(200) NULL,
	created datetime2(3) NOT NULL CONSTRAINT DF_Customer_created DEFAULT (sysutcdatetime()),
	active bit NOT NULL DEFAULT 1,
	nameUpper AS (upper(name)) PERSISTED,
	balance decimal(12,2) NOT NULL DEFAULT 0,
	note nvarchar(max) COLLATE Latin1_General_CS_AS NULL
);
GO
CREATE UNIQUE INDEX UX_Customer_email ON Sales.Customer (email) WHERE email IS NOT NULL;
CREATE INDEX IX_Customer_name ON Sales.Customer (name DESC) INCLUDE (balance);
ALTER TABLE Sales.Customer ADD CONSTRAINT UQ_Customer_code UNIQUE (code);
ALTER TABLE Sales.Customer ADD CONSTRAINT CK_Customer_balance CHECK (balance >= 0);
GO
CREATE TABLE Sales.[Order] (
	id int IDENTITY(100,5) PRIMARY KEY,
	customerId int NOT NULL,
	total money NOT NULL,
	placed date NOT NULL,
	CONSTRAINT FK_Order_Customer FOREIGN KEY (customerId) REFERENCES Sales.Customer (id) ON DELETE CASCADE
);
GO
CREATE TABLE dbo.Log (id int NOT NULL, msg varchar(max) NULL);
GO
CREATE VIEW Sales.vCustomer AS SELECT id, name FROM Sales.Customer;
GO
CREATE PROCEDURE Sales.usp_AddCustomer @name nvarchar(100)
AS
	INSERT Sales.Customer (name, code) VALUES (@name, 'x');
GO
CREATE FUNCTION dbo.fnDouble (@n int) RETURNS int AS BEGIN RETURN @n * 2 END;
GO
CREATE TRIGGER Sales.trg_Order ON Sales.[Order] AFTER INSERT AS SET NOCOUNT ON;
`;

const bracket = name => `[${String(name).replace(/]/g, ']]')}]`;

// Runs a script (GO included) in a database, on one connection that goes back to master.
async function runScript(manager, database, script) {
	const conn = await manager.acquireConnection();
	try {
		await conn.createRequest().batch(`USE ${bracket(database)}`);
		for (const batch of splitBatches(script)) await conn.createRequest().batch(batch.sql);
	} finally {
		try { await conn.createRequest().batch('USE [master]'); } catch { /* ignore */ }
		conn.release();
	}
}

async function createDatabase(manager, database, script = RICH_SCHEMA) {
	await dropDatabase(manager, database);
	await manager.executeQueryInDatabase('master', `CREATE DATABASE ${bracket(database)}`);
	await runScript(manager, database, script);
}

// Drops a database and the snapshots of it, whatever is left of an earlier run.
async function dropDatabase(manager, database) {
	const snapshots = (await manager.executeQueryInDatabase('master', 'SELECT d.name FROM sys.databases d JOIN sys.databases s ON s.database_id = d.source_database_id WHERE s.name = @name', { name: database })).recordset;
	for (const { name } of snapshots) await manager.executeQueryInDatabase('master', `DROP DATABASE ${bracket(name)}`);
	await manager.executeQueryInDatabase('master', `IF DB_ID(@name) IS NOT NULL BEGIN DECLARE @sql nvarchar(400) = N'ALTER DATABASE ' + QUOTENAME(@name) + N' SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ' + QUOTENAME(@name); EXEC (@sql); END`, { name: database });
}

module.exports = { RICH_SCHEMA, runScript, createDatabase, dropDatabase, bracket };
