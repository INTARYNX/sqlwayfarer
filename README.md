# SQL Wayfarer

**Navigate, analyze, and document your SQL Server databases — directly inside VS Code.**

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/intarynx.sqlwayfarer?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=intarynx.sqlwayfarer)
[![GitHub](https://img.shields.io/badge/GitHub-Repository-181717?logo=github)](https://github.com/intarynx/sqlwayfarer)

> **Early Access** — Core features are stable and actively developed. Feedback and bug reports are welcome via [GitHub Issues](https://github.com/intarynx/sqlwayfarer/issues).

---

## Overview

SQL Wayfarer is a VS Code extension that turns your editor into a full SQL Server workspace. Connect to any SQL Server or Azure SQL database, browse your schema, inspect object code and structure, trace dependencies, and manage documentation — without leaving VS Code.

---

## Features

### Connection Management
- Save and switch between multiple SQL Server connections
- Secure credential storage integrated with VS Code
- Connection testing with live feedback

### Schema Explorer
- Browse databases, schemas, tables, views, stored procedures, and functions
- Filterable tree view organized by schema

### Object Inspector
| Tab | What you see |
|-----|-------------|
| **Structure** | Columns, data types, primary keys, foreign keys, indexes |
| **Code** | Syntax-highlighted T-SQL with line metrics and one-click copy |
| **Comments** | Editable extended properties and inline documentation |

### Dependency Analysis
- Visualize which objects depend on a given object and which objects it depends on
- Understand the full impact of a change before making it

### Documentation
- Read and write MS_Description extended properties directly from the panel
- Keep your database self-documented without external tools

## Getting Started

1. Install [**SQL Wayfarer**](https://marketplace.visualstudio.com/items?itemName=intarynx.sqlwayfarer) from the VS Code Marketplace.
2. Click the compass icon in the Activity Bar to open the panel.
3. Add a connection using your SQL Server credentials.
4. Select a database and start exploring.

You can also open the panel via `Ctrl+Shift+P` → **Open SQL Wayfarer**.

---

## Requirements

| Requirement | Minimum version |
|-------------|----------------|
| VS Code | 1.100+ |
| SQL Server | 2008 R2+ |
| Azure SQL | Any tier |
| Permissions | `db_datareader` (read-only access is sufficient) |

---

## Known Limitations

- Encrypted object definitions cannot be retrieved by design (SQL Server restriction).
- Very large databases may experience slower initial load times.
- T-SQL syntax highlighting covers standard cases; complex dialect features may not be fully highlighted.

---

## Roadmap

- [ ] Query builder with schema-aware autocomplete
- [ ] Export schema to markdown / PDF
- [ ] Multi-database comparison view

---

## Contributing

Bug reports and feature requests are tracked on [GitHub Issues](https://github.com/intarynx/sqlwayfarer/issues). Pull requests are welcome.

---

*SQL Wayfarer — built for developers who spend their days navigating complex databases.*
