# SQL Wayfarer

A comprehensive SQL Server database explorer and analysis tool for Visual Studio Code. Navigate your database schema, analyze object dependencies, track table usage, and manage documentation - all within your favorite editor.

## Features

### 🔐 Secure Connection Management
- Save and manage multiple SQL Server connections
- Passwords stored securely using VS Code's built-in secrets API
- Support for SQL Server authentication and Windows authentication
- Connection testing before saving

### 🗂️ Database Object Explorer
- Browse tables, views, stored procedures, and functions
- Real-time search and filtering by object type
- Detailed structure view with columns, indexes, and foreign keys
- Quick access to object definitions and metadata

### 🕸️ Dependency Analysis & Visualization
- Interactive dependency graphs showing object relationships
- Analyze what objects depend on a selected table/view/procedure
- Impact analysis - see what would be affected by changes
- Visual graph rendering with dependency mapping

### 📊 Table Usage Analysis
- **Object → Tables**: See what tables a procedure/function/view uses
- **Table → Objects**: Find all objects that reference a specific table
- **Trigger Overview**: Comprehensive trigger analysis across the database
- Detailed operation type tracking (SELECT, INSERT, UPDATE, DELETE)

### 📝 Documentation & Comments Management
- View and edit MS_Description extended properties
- Table and column documentation support
- Object-level comments for views, procedures, and functions
- Visual indicators for documented vs undocumented objects

## Requirements

- Visual Studio Code 1.74.0 or higher
- SQL Server 2008 R2 or later (including Azure SQL Database)
- Network connectivity to your SQL Server instance
- Database permissions: `db_datareader` or higher for full functionality

## Getting Started

1. **Install**: Search for "SQL Wayfarer" in VS Code Extensions
2. **Open**: Click the SQL Wayfarer icon in the activity bar
3. **Connect**: Add your SQL Server connection details in the Configuration tab
4. **Select Database**: Choose a database from the dropdown
5. **Explore**: Navigate between Explorer, Table Usage, and Comments features

## Extension Settings

This extension does not add any VS Code settings. All configuration is managed within the SQL Wayfarer interface.

## Known Issues

- Large databases (1000+ objects) may experience slower initial loading
- Dependency analysis depth is limited to prevent performance issues
- Currently optimized for SQL Server; Azure SQL Database support may vary

## Release Notes

### 0.0.3

Initial release of SQL Wayfarer

- Database object exploration with search and filtering
- Secure connection management with VS Code secrets integration
- Interactive dependency visualization and analysis
- Comprehensive table usage tracking and analysis
- MS_Description comments and documentation management
- Multi-tab interface with responsive design

---

**Enjoy exploring your SQL Server databases with SQL Wayfarer!** 🧭