# Change Log

All notable changes to the SQL Wayfarer extension are documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/).

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
