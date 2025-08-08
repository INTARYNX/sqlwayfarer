# SQL Wayfarer

[![GitHub Repository](https://img.shields.io/badge/-GitHub-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/intarynx/sqlwayfarer)
[![VS Code Marketplace](https://img.shields.io/badge/-VS%20Code%20Marketplace-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=intarynx.sqlwayfarer)

> ⚠️ **Early Development** — Features may be incomplete or unstable. Feedback welcome!

A lightweight SQL Server explorer and analyzer for Visual Studio Code. Browse schemas, view object code, analyze dependencies, and manage documentation — all inside VS Code.

---

## Features

- **Connection Management**: Save and test multiple SQL Server connections securely.
- **Database Explorer**: Browse tables, views, procedures, and functions by schema.
- **Object Details**:
  - Structure: Columns, keys, indexes.
  - Code: Syntax-highlighted SQL with formatting and copy tools.
  - Comments: Edit documentation and extended properties.
- **Dependency Analysis**: Visualize object relationships and impact.
- **Documentation**: Manage descriptions and comments with markdown-style editing.

---

## Usage

1. Install [**SQL Wayfarer** from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=intarynx.sqlwayfarer).  
2. Open via activity bar or `Ctrl+Shift+P` → “SQL Wayfarer: Open”.  
3. Add your SQL Server connection and select a database.  
4. Browse objects and switch tabs for code, structure, and docs.  
5. Use dependency graphs to understand object relations.

---

## Requirements

- VS Code 1.74+  
- SQL Server 2008 R2+ or Azure SQL  
- `db_datareader` permissions for full access

---

## Notes

- Large databases may load slowly initially.  
- Encrypted objects’ code won’t display.  
- Basic SQL highlighting; advanced T-SQL may not be fully supported.

---

## Release Highlights

- Code view with syntax highlighting and metrics  
- Secure connection management  
- Dependency visualization  
- Documentation editing  

---

Enjoy exploring your SQL Server databases with SQL Wayfarer! 🧭  
*Built with ❤️ for the SQL Server community*  
