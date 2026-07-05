# Change Log

All notable changes to the SQL Wayfarer extension are documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/).

## [0.8.0] - 2026-07-05

### Added

- **Table statistics in the Explorer**:
  - The object list shows a badge next to each table with its row count and reserved size (e.g. `1.2M · 340 MB`), loaded with a single `sys.dm_db_partition_stats` query for the whole database right after the objects. Hovering the badge shows exact numbers.
  - The Structure tab shows a summary line under the table header with row count and disk usage breakdown (data, indexes, reserved), using the same formulas as `sp_spaceused`.
  - Both are metadata-based (no `COUNT(*)` scans) and best-effort: without `VIEW DATABASE STATE` permission the Explorer simply shows no badges.
- **Script generator**: a 📜 button on every object in the Explorer opens a menu of ready-to-edit scripts, inserted into the Query tab (without running): `SELECT` all columns, `INSERT`/`UPDATE` templates with typed placeholders and a PK-based `WHERE` for tables, full `CREATE TABLE` DDL (identity, computed columns, defaults, PK, secondary indexes, foreign keys with cascade rules), `EXEC` templates with declared `OUTPUT` parameters for procedures, call templates for scalar and table-valued functions, and the `CREATE` definition for views/procedures/functions.
- **Column-level lineage** ("what breaks if I rename this column?"): the background indexer now parses every view/procedure/function/trigger definition (Babelfish T-SQL grammar) and records which columns of which tables each object reads or writes. The Columns table of the table details gains a **Used by** column: a badge with the number of referencing objects (✍ marks writers, `~` marks ambiguous unqualified references); clicking it lists the objects and jumps to them in the Explorer. Alias resolution handles `UPDATE alias ... FROM Table alias`, CTE names are excluded, MERGE targets and `inserted`/`deleted` trigger pseudo-tables are resolved to their real tables. The index format changed (v2): the first indexing after the update is a full rebuild.
- **Dev tooling**: `scripts/print-ast.js` prints the pruned ANTLR parse tree of a T-SQL script next to the `analyzeOperations`/`analyzeColumns` results, to investigate parser edge cases (`node scripts/print-ast.js --sql "..."`).

## [0.7.4] - 2026-07-05

### Added

- **Ctrl+F search** in the panel (VS Code's native find widget): searches code definitions, query results and object lists.

### Fixed

- Explorer filtering: schema badges now show filtered counts ("3 of 15"), schemas with no matching object are hidden, and an explicit "no match" message replaces the empty list.

### Removed

- Expand/Collapse button in the Code tab: the code area now always fills the available height, making the button pointless.

## [0.7.2] - 2026-07-05

### Added

- **Copy / CSV export of query results**: every result set now has a 📋 Copy button (tab-separated, pastes straight into Excel) and a ⬇ CSV button (RFC 4180 escaping, UTF-8 BOM so Excel decodes accents correctly).
- **Destructive statement guardrails**: `UPDATE`/`DELETE` without a `WHERE` clause (detected by the T-SQL parser, so subqueries and multi-statement batches are analyzed correctly), `TRUNCATE TABLE` and `DROP` now require an explicit confirmation before execution.
- **Search in code**: a "Search in code" toggle in the Explorer searches inside view / procedure / function / trigger definitions (`sys.sql_modules`), answering "where is this column or table used?". Wildcards in the search text are escaped and matched literally.

## [0.7.1] - 2026-07-05

### Added

- **Go to definition**: Ctrl+Click (Cmd+Click on macOS) on an object name in the query editor jumps to that object in the Explorer. Aliases are resolved (`FROM Employee e` → Ctrl+Click on `e` opens `Employee`).
- **Incremental indexing**: when the schema changes, only added or modified objects (per-object checksum on name, type and `modify_date`) are re-analyzed; unchanged objects keep their cached dependencies and dropped objects are pruned. A full rebuild now only happens on first indexing or Force Reindex.

## [0.7.0] - 2026-07-05

### Added

- **Query tool overhaul**
  - Multiple result sets: scripts with several `SELECT` statements now render every grid, with `PRINT`/informational messages shown below the results.
  - Row limit selector (100 / 1 000 / 5 000 / 10 000) backed by streaming execution: rows beyond the cap are counted but never accumulate in memory.
  - Cancel button that actually interrupts the running query server-side, plus a 5-minute safety timeout.
  - Execution time in the status line; SQL error messages now carry the correct line number.
  - Persisted query history (last 50 queries per workspace) with one-click recall and a clear option.
  - Resizable editor: drag the splitter between the SQL editor and the results grid, double-click to reset.
- **SQL autocompletion** in the query editor: tables/views/procedures/functions from the object index, schema-aware completion (`Sales.` → objects), column completion after a table name or alias (`FROM Employee e` → `e.` lists columns with types), SQL keywords, Ctrl+Space to trigger manually.
- **Data dictionary export** (📖 Dictionary button): generates a Markdown document of the whole database — tables and views with columns, types, defaults, primary/foreign keys, procedure and function parameters, cross-linked dependencies, and the `MS_Description` extended properties edited in the Comments tab. Includes a documentation-coverage summary and deterministic ordering for clean git diffs.

### Changed

- Dependency indexing now runs one `dm_sql_referenced_entities` query per object from the extension instead of a single server-side cursor batch: the progress bar reports real per-object progress and the new Cancel button in the indexing modal interrupts the operation immediately.

### Fixed

- Indexing progress bar was permanently stuck at 0% (the progress callback was never invoked).
- Objects (Raw JSON Index) modal: was capped at 500px wide and showed nested scrollbars; now uses the full wide layout with a single scrollbar and unwrapped JSON lines.
- Indexing modal showed a spurious horizontal scrollbar.
- Query toolbar controls were vertically misaligned.

## [0.6.x]

- Explorer with object search, filters and per-object "Top 10" peek.
- Dependency tree and graph visualization, impact analysis.
- Extended properties (comments) viewing and editing.
- Background object indexing with checksum-based caching.
- Basic query panel.
- Initial BabelfishSqlParser implementation and test suite.
