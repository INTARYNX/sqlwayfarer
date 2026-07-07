# Change Log

All notable changes to the SQL Wayfarer extension are documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/).

## [0.8.9] - 2026-07-07

### Changed

- Restored the native Marketplace **Q & A** tab (removed the redirect to GitHub Issues).

## [0.8.8] - 2026-07-07

### Changed

- Marketplace listing refresh: the extension description, search keywords, and categories now reflect what the extension actually does today — column-level lineage, trigger-aware table footprints, the script generator, and the data-dictionary export (the previous one-liner predated all of them). The Marketplace **Q & A** tab now points to GitHub Issues, matching the stated feedback channel.

## [0.8.7] - 2026-07-07

### Improved

- **Table Footprint legend**: the graph legend now groups the table chips under "Tables" and adds an "Edges" group with line samples that mirror the graph's edge styles (writes, reads, FK relationship, possible), so the diagram is readable without guessing what each line means.

### Changed

- **Full data dictionary is now exported as a folder of files instead of one giant `.md`.** With the per-table Mermaid ER diagrams, a large database produced a single document with hundreds of `mermaid` blocks, which chokes Markdown viewers (VS Code preview, GitHub, Obsidian). The full export now writes a `<database>-data-dictionary-full/` folder: a `README.md` index (header, coverage, model summary, user-defined types, and a per-schema list of the page files) plus one file per page of objects. Each category is paginated with a hard cap (~40 tables per file), so no file ever carries more than ~40 diagrams; tables are grouped by name prefix (e.g. `Invoice_*`) so related tables stay together, degrading to alphabetical packing when there's no naming convention. Cross-object links (foreign keys, depends-on / referenced-by) resolve across files (`<file>#anchor`). The basic (unchecked) export is unchanged — still a single file.

## [0.8.6] - 2026-07-07

### Fixed

- The current database's on-disk index was deleted when the panel was closed (`dispose`), forcing a full rebuild on every reopen — very costly on large databases. The index is a persistent, checksum-validated cache and is now kept; staleness is handled by the schema checksum on next open. (Companion to the 0.8.5 `getDatabases` fix, which closed the other path that wiped a valid index.)

## [0.8.5] - 2026-07-07

### Added

- **Table Footprint** (a button on every procedure, function, and view): an interactive graph of every table the object reads and writes — following nested procedure/function/view calls and, crucially, the DML **trigger cascades** that fire when a table is written (a procedure that writes one table can silently touch a dozen more through triggers, and nobody sees it by reading the procedure). Tables are coloured by access — written, read, reached **only via a trigger**, or a low-confidence **possible** match. Three tabs:
  - **Graph**: the object-centric footprint with read / write / trigger-cascade edges and the FK relationships between the tables. A "Show reads" toggle isolates the writes and cascades.
  - **Schema**: a pure relational ER of the footprint tables, each entity listing its key columns (e.g. `BusinessEntityID (PK, FK)`).
  - **Tables**: lean per-table documentation (columns, types, nullability, defaults, PK/FK, and `MS_Description` descriptions), so you can analyze in place without opening the full Markdown export.

  Rendered with a locally vendored Cytoscape + dagre (no CDN). The analysis engine is fully unit-tested (trigger cascade, cycle handling, nested calls).
- **Dynamic-SQL name scan**: during indexing, qualified names (`schema.table`) of known objects that appear in a module's text but are not resolved by static analysis are recorded as low-confidence references — catching tables referenced only inside `EXEC` / `sp_executesql` strings. They surface as dashed **possible** tables in the Table Footprint (read/write direction unknown). The index format changed (**v3**): the first indexing after the update is a full rebuild.
- **Data dictionary — Full mode**: a "Full" checkbox next to the Dictionary button enriches the Markdown export with, per table, non-clustered/unique indexes, incoming foreign-key relations ("referenced by"), CHECK and UNIQUE constraints, triggers, a compact per-table Mermaid ER diagram (the table and its directly related tables, keys only — bounded so it stays readable on large schemas), plus a whole-database model summary, a User Defined Types section, and per-table row counts and size. The basic (unchecked) export is unchanged.
- **Auto-connect**: the last connection used is remembered and reconnected automatically when the panel opens; an "Auto-connect on startup" checkbox turns it off (the last connection stays pre-selected either way).

### Fixed

- A valid, up-to-date index was deleted and fully rebuilt after reconnecting to a database: the current database's index was cleared on every `getDatabases`, so a large database re-indexed from scratch after quitting and reconnecting. The redundant clear was removed — staleness is already handled by the schema checksum (incremental update).
- UI spacing: filter checkboxes, icon/label gaps on buttons (Dictionary and others), the "Used by" pill height, and the column-usage Copy button.

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
