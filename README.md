# SQL Wayfarer

A SQL Server and Azure SQL client for VS Code, for the people who write T-SQL and maintain the database behind it. Free, open source, no telemetry.

![SQL Wayfarer: a procedure that only mentions two tables, shown touching five through the triggers it fires](images/banner.png)

[![VS Code Marketplace](https://vsmarketplacebadges.dev/version/intarynx.sqlwayfarer.svg)](https://marketplace.visualstudio.com/items?itemName=intarynx.sqlwayfarer)
[![CI](https://github.com/INTARYNX/sqlwayfarer/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/INTARYNX/sqlwayfarer/actions/workflows/ci.yml)
[![GitHub](https://img.shields.io/badge/GitHub-Repository-181717?logo=github)](https://github.com/intarynx/sqlwayfarer)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![No telemetry](https://img.shields.io/badge/telemetry-none-blue)

## Why

Microsoft's tooling for SQL Server has never settled on who it is for, DBAs or developers. The polished tools for developers are commercial, and priced like it.

This is the tool its author wanted while maintaining a legacy database: hundreds of tables, procedures that call procedures, triggers nobody remembers. *What reads this column? What does this procedure really write? What fires when I delete a row?* It answers from the server's own metadata, in the editor you already have open.

- **Free.** No paid tier, no account, no licence key. It is not a product and will not become one.
- **No telemetry.** Nothing is collected, nothing is sent anywhere.
- **Open source, MIT.**

## What it does

![Table Footprint: a procedure that only mentions two tables, shown touching five through two trigger cascades](table-footprint.jpg)

- **Explorer and object details.** Browse a database, search in the code of every definition, see columns, keys, indexes, dependencies and definitions.
- **Column lineage.** Which views, procedures, functions and triggers read or write a column: "what breaks if I rename this?".
- **Table footprint.** Every table a procedure reads and writes, through nested calls and the triggers that fire. The picture above is `usp_PlaceOrder`: it names two tables and touches five.
- **Query graph.** The tables a query reads, how they are joined, and what its `EXEC`s reach.
- **Query editor.** Several tabs and `.sql` files, one connection per tab like SSMS (a `BEGIN TRAN` stays open), execution plans, autocompletion, snippets (SQL Prompt files can be imported), CSV and JSON export.
- **Guardrails.** Confirmation before a `DELETE` without `WHERE`, a `DROP`, a `TRUNCATE`... and before every write on a connection marked *production*.
- **Compare.** What changed since a snapshot, and a re-runnable script to repeat it elsewhere.
- **Data dictionary.** A Markdown export of the whole database.
- **Connections.** SQL login, Windows, Entra ID; import from a Central Management Server or SSMS.

Where the analysis is unsure (dynamic SQL, an ambiguous name, a definition that did not parse), it says so instead of looking complete.

## Getting started

1. Install it from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=intarynx.sqlwayfarer).
2. Click the compass in the Activity Bar, add a connection, pick a database.

The dependency analysis needs a local index. It is never built behind your back: the Explorer offers **Build index** and says what it costs. Everything else works without it.

Needs VS Code 1.100+ and SQL Server 2017+ or Azure SQL. `db_datareader` is enough to browse; `VIEW DEFINITION` for code and dependencies.

## Privacy

No analytics, no crash reports. It only talks to the SQL Server you point it at (and the Microsoft sign-in of VS Code if you use Entra ID). Nothing is loaded from the internet; the index, history and drafts stay on your machine.

## Limits

It is young: tested on AdventureWorks, a generated 700-table database and a live SQL Server in CI, not on enough real production schemas. Entra ID is beta and untested on a live Azure SQL; Windows authentication has seen little testing. Dynamic SQL is followed only when the statement is a literal, or a variable given one literal and nothing else; a statement built at run time is only name-scanned. The footprint lists every path of the code it reads, so it can show more than one run does. A table written only in a `CATCH`, or in a trigger branch chosen by `IF UPDATE(column)` or by a test on `inserted` / `deleted`, is drawn with a dotted border: it is not written on every run. On AdventureWorks it never missed a table the server really modified. A wrong result on your database is the most useful bug report.

## Author

Made by [intarynx](https://www.intarynx.com), one developer who builds all kinds of things, not a company. Bugs and ideas: [GitHub Issues](https://github.com/intarynx/sqlwayfarer/issues). `AGENTS.md` explains how the repository is built and tested.

## License

[MIT](LICENSE). The third-party software it ships, and its licenses, are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
