# SQL Wayfarer

A comprehensive SQL Server database explorer and analysis tool for Visual Studio Code. Navigate your database schema, analyze object dependencies, track table usage, manage documentation, and view SQL code - all within your favorite editor.

## Features

### 🔐 Secure Connection Management
- Save and manage multiple SQL Server connections
- Passwords stored securely using VS Code's built-in secrets API
- Support for SQL Server authentication and Windows authentication
- Connection testing before saving
- Edit and delete saved connections

### 🗂️ Database Object Explorer
- Browse tables, views, stored procedures, and functions organized by schema
- Real-time search and filtering by object type
- Multi-tab details panel with specialized views:
  - **Structure**: Columns, indexes, foreign keys, and metadata
  - **Code**: SQL definitions with syntax highlighting and tools
  - **Comments**: Documentation and extended properties management
- Quick access to object definitions and dependency graphs

### 💻 Code View & SQL Editor
- **Syntax-highlighted SQL code** display for views, procedures, and functions
- **Interactive code tools**:
  - Copy code to clipboard
  - Basic SQL formatting
  - Toggle line numbers
  - Expand/collapse view
- **Code metrics**: Line count, character count, complexity estimation
- **Object type indicators** with visual badges
- **Error handling** for encrypted or inaccessible objects

### 🕸️ Dependency Analysis & Visualization
- Interactive dependency graphs showing object relationships
- Analyze what objects depend on a selected table/view/procedure
- Impact analysis - see what would be affected by changes
- Visual graph rendering with dependency mapping
- Three view modes: Dependencies, References, or Both

### 📊 Table Usage Analysis
- **Object → Tables**: See what tables a procedure/function/view uses
- **Table → Objects**: Find all objects that reference a specific table
- **Trigger Overview**: Comprehensive trigger analysis across the database
- Detailed operation type tracking (SELECT, INSERT, UPDATE, DELETE)
- Enhanced metrics with operation breakdowns and complexity scoring
- Related objects discovery and usage patterns

### 📝 Documentation & Comments Management
- View and edit MS_Description extended properties
- Table and column documentation support
- Object-level comments for views, procedures, and functions
- Visual indicators for documented vs undocumented objects
- Documentation coverage statistics
- Modal editing interface with markdown-style formatting

### ⚡ Extended Events Integration
- Create and manage SQL Server Extended Events sessions
- Real-time procedure execution monitoring
- Ring buffer event capture and analysis
- Session lifecycle management (create, start, stop, delete)
- Raw XML event data inspection for debugging

## Interface Overview

### Main Tabs
1. **Configuration**: Connection management and settings
2. **Explorer**: Database object browsing with multi-tab details
3. **Table Usage**: Advanced usage analysis and relationship tracking
4. **Extended Events**: SQL Server monitoring and profiling

### Explorer Detail Tabs
- **Structure**: Schema information, constraints, and relationships
- **Code**: SQL definitions with syntax highlighting and tools
- **Comments**: Documentation and extended properties

## Requirements

- Visual Studio Code 1.74.0 or higher
- SQL Server 2008 R2 or later (including Azure SQL Database)
- Network connectivity to your SQL Server instance
- Database permissions: `db_datareader` or higher for full functionality
- For Extended Events: `ALTER ANY EVENT SESSION` permission

## Getting Started

1. **Install**: Search for "SQL Wayfarer" in VS Code Extensions
2. **Open**: Click the SQL Wayfarer icon in the activity bar or press `Ctrl+Shift+P` and run "SQL Wayfarer: Open"
3. **Connect**: Add your SQL Server connection details in the Configuration tab
4. **Select Database**: Choose a database from the header dropdown
5. **Explore**: Navigate between different features using the main tabs
6. **View Code**: Select an object and switch to the Code tab to see SQL definitions

## Tips & Best Practices

### For Code Viewing
- Use the **Format** button to clean up messy SQL code
- Toggle **line numbers** for easier navigation in large procedures
- **Expand** the code view for better readability of complex objects
- **Copy** formatted code directly to use in other tools

### For Documentation
- Start with **table descriptions** to establish data context
- Document **complex columns** with business logic explanations
- Use the **edit mode** for bulk documentation updates
- Monitor **coverage statistics** to track documentation completeness

### For Dependency Analysis
- Use **dependency graphs** before making schema changes
- Check **table usage** to understand data flow patterns
- Analyze **triggers** to identify automated business logic
- Review **impact analysis** for refactoring planning

## Extension Settings

This extension does not add any VS Code settings. All configuration is managed within the SQL Wayfarer interface.

## Performance Considerations

- **Large databases** (1000+ objects): Initial loading may take 30-60 seconds
- **Dependency analysis**: Depth limited to 3 levels to prevent performance issues
- **Code formatting**: Basic formatting only; complex SQL may need manual adjustment
- **Extended Events**: Sessions are automatically cleaned up on extension reload

## Known Issues

- **Encrypted objects**: Cannot display code for encrypted stored procedures/functions
- **Complex schemas**: Very large schemas may experience slower rendering
- **Azure SQL Database**: Some Extended Events features may not be available
- **Syntax highlighting**: Basic SQL highlighting; advanced T-SQL features may not be colored

## Troubleshooting

### Connection Issues
- Verify server name and port (default: 1433)
- Check firewall settings and network connectivity
- Ensure SQL Server authentication is enabled if using SQL auth
- Test connection before saving

### Performance Issues
- Close unused tabs to free memory
- Use search filters to limit object lists
- Consider connecting to specific databases rather than large instances

### Code View Issues
- Encrypted objects will show an error message
- Large procedures (10,000+ lines) may take time to load
- Some formatting may not work perfectly with complex T-SQL

## Release Notes

### 0.6.3
**Major Feature: Code View Integration**
- Added dedicated **Code tab** in Explorer for SQL object definitions
- **Syntax highlighting** for SQL code with keyword recognition
- **Interactive code tools**: copy, format, line numbers, expand/collapse
- **Code metrics**: line count, character count, complexity estimation
- **Object type indicators** with visual badges for procedures, functions, views
- **Enhanced Explorer structure**: separated code from metadata display
- **Improved user experience**: cleaner interface with specialized views
- **Error handling**: graceful handling of encrypted or inaccessible code

**Improvements:**
- Better schema organization and display
- Enhanced dependency analysis with improved parsing
- Refined documentation management interface
- Performance optimizations for large databases
- Updated visual design with modern VS Code theming

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

*Built with ❤️ for the SQL Server community*