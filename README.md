# SQL Wayfarer

A SQL Server and Azure SQL client for VS Code, made for the people who write T-SQL and maintain the database behind it. Free, open source, no telemetry.

![SQL Wayfarer: a procedure that only mentions two tables, shown touching five through the triggers it fires](images/banner.png)

[![VS Code Marketplace](https://vsmarketplacebadges.dev/version/intarynx.sqlwayfarer.svg)](https://marketplace.visualstudio.com/items?itemName=intarynx.sqlwayfarer)
[![CI](https://github.com/INTARYNX/sqlwayfarer/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/INTARYNX/sqlwayfarer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![No telemetry](https://img.shields.io/badge/telemetry-none-blue)

## Why

Microsoft's tooling for SQL Server has never settled on who it is for, DBAs or developers, and keeps changing course. The polished tools for developers are commercial, and priced like it.

SQL Wayfarer is the tool its author wanted while maintaining a legacy database: hundreds of tables, procedures that call procedures, triggers nobody remembers writing. Before every change there are the same questions. *What reads this column? What does this procedure really write? What fires when I delete a row?* It answers them from the server's own metadata, in the editor you already have open.

- **Free.** No paid tier, no account, no licence key, no "pro" edition. It is not a product and is not going to become one.
- **No telemetry.** Nothing is collected and nothing is sent anywhere. See [Privacy](#privacy).
- **Open source, MIT.** Read it, fork it.

It is not a deployment tool or a data editor. It reads a database, helps you understand it, and runs the T-SQL you write.

## What it does

### Understand a database

![Table Footprint: a procedure that only mentions two tables in its own code, shown touching five through two trigger cascades](table-footprint.jpg)

*`usp_PlaceOrder` only mentions `Orders` and `Inventory`. The footprint follows the triggers it fires and shows the other three tables it touches.*

- **Explorer.** Databases, schemas, tables, views, procedures and functions, with a filter, per-schema counts, row count and size badges, a Top 10 button, and a search in the code of every definition ("where is this column used?"). It works with the keyboard and a context menu.
- **Object details.** Columns, keys, indexes and foreign keys; the dependency tree and graph (what depends on the object, what it depends on, including other databases); the definition; the extended properties, editable.
- **Column lineage.** For each column, which views, procedures, functions and triggers read it and which ones write it. It answers "what breaks if I rename this?". A reference that cannot be pinned to one table is marked ambiguous rather than dropped.
- **Table footprint.** The tables a procedure, function or view reads and writes, through nested calls and through the triggers that fire (an `AFTER INSERT` trigger is not fired by a `DELETE`). Tables are coloured by access: written, read, reached only through a trigger, or a "possible" match found in dynamic SQL.
- **Query graph.** Select a query in the editor and see the tables it reads, the joins between them as written, and the tables behind the procedures it executes.
- **Compare.** What changed in a database since a snapshot (or another database), and a re-runnable script that repeats the change on another one. *Modified since…* lists what was created or altered in the last minutes to 30 days, from the dates the server keeps, without any snapshot.
- **Data dictionary.** A Markdown document of the database: tables, views, procedures, functions, columns, keys, parameters, cross-linked dependencies and your descriptions. The detailed mode writes a folder of linked pages with a Mermaid diagram per table.

Dependencies, lineage and footprints come from `sys.dm_sql_referenced_entities`, completed by a T-SQL parser for what the metadata does not say (which column, which operation). Where the analysis is unsure, it says so: dynamic SQL, an unresolved name or a definition that did not parse is marked *possible*, *ambiguous* or *partial*. It never presents a guess as complete.

### Write and run T-SQL

- **Query tabs.** Drafts and `.sql` files side by side in one list, each remembering its database. Save back to the file with `Ctrl+S`. Unsaved work is recovered if VS Code closes unexpectedly. A side panel lists the `.sql` files of the workspace and the instance tree (databases, objects, script as, rename, delete).
- **Run** (`F5` or `Ctrl+Enter`) runs the selection, or the whole editor without one. Several result sets, a row cap, cancellation, `PRINT` and `RAISERROR` output in order, errors that link to their line.
- **One connection per tab, like an SSMS query window.** A `BEGIN TRAN` stays open until you commit or roll back, a `#temp` table survives from one run to the next, and the footer says when a transaction is open.
- **Execution plans.** Estimated and actual, drawn inline.
- **Autocompletion** that follows the clause: tables after `FROM`, columns of the tables in the current statement (aliases, CTEs, subqueries, temp tables and table variables included), join conditions from foreign keys, parameters after `EXEC`. Everything is configurable under `sqlwayfarer.autocomplete.*`.
- **Results.** Filter, sort, copy to Excel, export to CSV or JSON. The grid draws 2 000 rows at a time, and copy and export always take every row.
- **Snippets**, including `.sqlpromptsnippet` files imported from Redgate SQL Prompt, with their abbreviations and `$placeholders$`.
- Format (`Shift+Alt+F`), find and replace, go to definition, and an optional syntax check done by SQL Server itself (`SET PARSEONLY`).
- **Scripts.** `SELECT`, `INSERT`, `UPDATE`, `EXEC` and full `CREATE` scripts for any object, written into the editor and never run.

### Guardrails

- Confirmation before an `UPDATE` or `DELETE` without a `WHERE` or with an always-true one, `TRUNCATE`, any `DROP`, `ALTER TABLE … DROP COLUMN`, `MERGE … THEN DELETE`, `ALTER DATABASE … SINGLE_USER`, and `xp_cmdshell`. A statement written as a literal inside `EXEC('…')` is checked too. SQL built in a variable is not, and neither is a procedure that deletes by its own logic.
- **Production connections.** Tick the box on a saved connection: it gets a `PROD` badge, its tab a `PRODUCTION` banner, and every statement that changes data or schema asks first, whatever its `WHERE`.

### Connections

- Saved in a sidebar, with groups. Passwords go to VS Code's secret storage.
- SQL login, a `DOMAIN\user` account, Windows integrated authentication (Windows only, through a small helper program shipped with the extension), or Microsoft Entra ID for Azure SQL.
- Import from a Central Management Server or from a `.regsrvr` file exported by SSMS. No password is imported.
- A bar offers **Reconnect** when the server stops answering.

## Getting started

1. Install **SQL Wayfarer** from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=intarynx.sqlwayfarer).
2. Click the compass in the Activity Bar and add a connection. `Ctrl+Shift+P` then **Open SQL Wayfarer** works as well.
3. Pick a database.

The dependency analysis (tree, graph, lineage, footprint, query graph) needs a local index of the database. It is never built behind your back: the Explorer offers **Build index**, says what it costs, and lists what an update would re-analyze when the schema has changed. Everything else works without it.

## Requirements

| | |
|---|---|
| VS Code | 1.100 or later |
| SQL Server | 2017 or later |
| Azure SQL | any tier |
| Permissions | `db_datareader` to browse. `VIEW DEFINITION` for the code, dependencies and lineage. `VIEW DATABASE STATE` for the size badges (optional). `ALTER` on an object to save its description. |

## Privacy

- No usage data, no analytics, no crash reports. Nothing is sent to the author or to anyone.
- The only connection it makes is to the SQL Server you point it at. With Entra ID it also uses the Microsoft sign-in of VS Code, like any extension using that account.
- The webview loads nothing from the internet: no CDN, no remote font.
- The index, the query history and the drafts stay on your machine.
- It does ask for a star on the Marketplace now and then: a message after you have run a few queries, at most once every three weeks, that opens the Marketplace page in your browser if you click it.

## What to keep in mind

- **It is young.** It has been tested against AdventureWorks, a generated legacy-sized database (700 tables, 1 600 procedures) and a live SQL Server in CI. It has not seen enough real production schemas. A wrong result on yours is the most useful bug report there is.
- **Entra ID is beta** and was not tested against a live Azure SQL. Windows integrated authentication has seen limited testing.
- Dynamic SQL is not followed beyond a name scan, which marks what it finds as "possible". Column lineage attributes an unqualified column in a multi-table statement to every table in scope and flags it, instead of choosing.
- A table named without its schema is resolved the way SQL Server does, against the schema of the module. If that is ambiguous, it is reported as unresolved rather than guessed.
- Encrypted definitions cannot be read (a SQL Server restriction). The first index of a very large database takes a while, and the next ones are incremental.
- The Compare tab does not cover everything (synonyms, sequences, user types, CLR, columnstore and XML indexes, partitioning, permissions); what it skips is counted and said, never reported as identical.

## Author

Made by [intarynx](https://www.intarynx.com): one developer who builds all kinds of things (generative art, VS Code tooling, Bluetooth hardware, language-learning apps), not a company. SQL Wayfarer comes from maintaining a legacy SQL Server database, and is shared because other people live in the same kind of database.

## Contributing

Bugs and ideas: [GitHub Issues](https://github.com/intarynx/sqlwayfarer/issues). Pull requests are welcome; `AGENTS.md` describes how the repository is built and tested.

## License

[MIT](LICENSE). Free to use, copy, modify and distribute.
