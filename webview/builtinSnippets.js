/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Ready-made snippets offered alongside any custom ones the user saves.
// Its own file (not just a QueryManager static) so the sidebar snippet
// manager (panels/SnippetSidebarProvider.js) can list built-ins too without
// loading the whole query-editor stack, which it has no DOM for.
const BUILTIN_SNIPPETS = [
    { name: 'SELECT TOP 100', sql: 'SELECT TOP 100 *\nFROM ' },
    { name: 'COUNT rows', sql: 'SELECT COUNT(*) AS row_count\nFROM ' },
    { name: 'INSERT INTO', sql: 'INSERT INTO table_name (column1, column2)\nVALUES (value1, value2);' },
    { name: 'UPDATE ... WHERE', sql: 'UPDATE table_name\nSET column1 = value1\nWHERE condition;' },
    { name: 'DELETE ... WHERE', sql: 'DELETE FROM table_name\nWHERE condition;' },
    { name: 'CREATE TABLE', sql: 'CREATE TABLE table_name (\n    id INT IDENTITY(1,1) PRIMARY KEY,\n    column1 NVARCHAR(100) NOT NULL\n);' },
    { name: 'GROUP BY ... HAVING', sql: 'SELECT column1, COUNT(*) AS cnt\nFROM table_name\nGROUP BY column1\nHAVING COUNT(*) > 1;' },
    { name: 'ROW_NUMBER window function', sql: 'SELECT *,\n    ROW_NUMBER() OVER (PARTITION BY column1 ORDER BY column2) AS rn\nFROM table_name;' },
    { name: 'Temp table', sql: 'CREATE TABLE #temp (\n    id INT\n);\n\nDROP TABLE #temp;' },
    { name: 'BEGIN TRAN / COMMIT', sql: 'BEGIN TRAN;\n\n\nCOMMIT TRAN;\n-- ROLLBACK TRAN;' }
];

// Allow unit tests to require() this file; in the webview `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = BUILTIN_SNIPPETS;
}
