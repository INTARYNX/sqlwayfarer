# Change Log

All notable changes to the SQL Wayfarer extension are documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/).

## [0.99.1] - 2026-11-03

Release candidate of 1.0.0. No new feature: the features of 0.13.0 are corrected, and what runs a query is made safer.

### Changed

- **Destructive statement guardrails** are wider: a `WHERE` that is always true (`1=1`), `ALTER TABLE … DROP COLUMN` / `ALTER COLUMN`, every kind of `DROP` (schema, synonym, user, login, role, type, sequence, assembly…), `MERGE … THEN DELETE`, `ALTER DATABASE … SET SINGLE_USER/OFFLINE/EMERGENCY`, `xp_cmdshell`, and a statement written as a literal inside `EXEC('…')` or `sp_executesql`. Temporary tables and table variables no longer ask. The T-SQL parser is only asked about a query that has an `UPDATE` or a `DELETE` (it took 0.1 to 0.5 s of the host on each run).
- **Write footprint**: a trigger is followed only for the kind of write it is declared for (an `AFTER INSERT` trigger is not fired by a `DELETE`).
- **Index cache**: the index format is now 10 (the kind of each table write, `TRUNCATE` among them, checksums that no longer depend on the time zone, and no user-defined type among the dependencies): the first indexing after the update is a full rebuild.
- **Result grid**: a `date` column shows no time, a `time` column no date (grid, CSV and JSON); a `bigint` sent as text is aligned and sorted as a number; a column with no name is called `(No column name)`, and a name returned twice gets a suffix (`id`, `id (2)`) instead of folding into one.
- Closing a draft that holds text asks for a confirmation.
- The progress messages of the extension host print only with the `SQLWAYFARER_DEBUG` environment variable; the Marketplace keywords are cut to the 30 it reads.
- **SQL Server driver**: `mssql` 12 (was 10). A vulnerable transitive dependency (`uuid`) is gone: `npm audit --omit=dev` reports nothing for what the extension ships. The driver `tedious` stays on 19, for the Node 20 of VS Code 1.100.
- **Graph libraries**: the footprint graph (cytoscape and its dagre layout) is built from the versions npm installs instead of copied by hand, and Viz.js with Graphviz (2 MB) is loaded the first time a dependency graph is drawn instead of each time the panel opens.

### Fixed

- **Run sent the whole editor even with a selection** (F5, Ctrl+Enter, the Run button). It now sends the selection when there is one, as SSMS does; the line of an error is still the one of the editor.
- **Code tab: Format cut string literals and comments, and replaced the code** (Copy then copied the changed text). It now uses the real formatter of the editor and is a way of looking: the code of the server is kept, Copy copies what is shown, pressed again the button gives the code back.
- **Comments tab listed a column twice**, and describing a column could fail, when an index carried a description too (AdventureWorks describes its indexes): the description of an index was read as that of the column of the same number.
- **Explorer: the structure of a wide table widened the whole page** and shrank the object list; it now scrolls in its panel. The same went for a wide result grid, which now scrolls in its pane, with one line per row (long values cut with an ellipsis), its actions bar and header staying in place.
- **Top 10 overwrote the text of the editor**: the query now goes to a new draft tab when the editor holds text.
- **Write footprint: `TRUNCATE TABLE` was reported as a read.** It is now a write of the table, and fires no trigger.
- **Write footprint: a write through a view was reported as a read** of the table behind it, with the view "unresolved" and the triggers of the table missed. The table behind the view (through views of views) is now written, and its triggers are followed. An `INSTEAD OF` trigger on the view is not followed.
- **Write footprint reported a user-defined type** (`dbo.Flag`...) used by a procedure as an unresolved reference.
- **Query graph: the condition written on a join was hidden behind the tables** it joins; the gap is now made for it.
- **The query graph did not follow `EXEC`**, though the README says it follows the procedures a query calls: the procedure an `EXEC` runs, and the tables behind it, are now in the graph.
- **A production server was run like a test one**: nothing told them apart, and the confirmation before a destructive statement was the same on both. A saved connection can now be marked *Production* (a checkbox when you edit it): the list shows a `PROD` badge, the tab a `PRODUCTION` banner, and every statement that changes data or schema (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`) asks for a confirmation, whatever its `WHERE`.
- **A `CREATE` or `ALTER` of a procedure, view, function or trigger failed** ("must be the first statement in a query batch"): the `USE` and the plan setting now go as batches of their own.
- **A column with no name, or a name twice, lost a value** in the results (`SELECT COUNT(*), MAX(x)`, `a.id, b.id`).
- **Cancelling an indexing, or a failed force reindex, deleted the index that was there.**
- **Ctrl+Z brought back the text of the query tab that was open before.**
- **Save As outside the workspace**, then Save, was refused.
- **Explorer**: an answer for another database, or another object, than the one now shown no longer replaces what is on screen.
- **Dependency tree**: a node of another database is a link (the flag was lost), and a name with `&` or `<` was escaped twice.
- A change made by the code (history, a script, a snippet) now counts as an edit: the Save button, the drafts and the syntax check know it.
- An error raised inside a procedure names it (`In dbo.proc, line 4`) instead of giving a line of the script.
- **Saved connections**: a name that is taken is not overwritten with its password, and two windows of VS Code no longer overwrite one another's connections (they are read before each write, and a change made by another window is picked up).
- `.`, `(local)` and a bracketed IPv6 address, as SSMS lists them, now reach the SQL login driver as real host names.
- **A SQL Prompt snippet file made of tags that are never closed froze the extension host** for minutes.
- Names with a dot or a bracket in them work for the columns, the parameters, the stats and the scripts of an object; a bare name finds its schema instead of trying a list of AdventureWorks ones; the row count uses `COUNT_BIG`.
- The Code tab complexity counts T-SQL (joins, subqueries, CTEs, `CASE`, `EXISTS`, `UNION`, loops, cursors), not `WITH (NOLOCK)` nor words that are not T-SQL.
- A default of two parenthesized parts keeps its parentheses in the data dictionary; saving a snippet again from the Query tab keeps its abbreviation; the friendly message of an indexing error no longer depends on the case of the driver text.
- `package-lock.json` is tracked, which the CI (`npm ci`) needs.

### Known limits

- SQL built in a variable (`EXEC(@sql)`) and a procedure that deletes by its own logic are not seen by the guardrails; the footprint and the query graph do not follow dynamic SQL.
- Not tested in a real VS Code yet (native dialogs), nor on Azure SQL; Windows and Entra sign-in have seen limited testing.

## [0.13.0] - 2026-11-03

Release candidate: the features of the first version are in, from here on only fixes.

### Added

- **Compare tab**: what changed in a database since a reference, and the script that repeats it elsewhere.
  - The reference is a **SQL Server database snapshot** (taken from the tab, after the exact `CREATE DATABASE … AS SNAPSHOT OF` and its cost are shown; never taken on its own) or any other database of the instance. Not on Azure SQL Database; before SQL Server 2016 SP1 snapshots need Enterprise, Developer or Evaluation.
  - The two catalogs are read in one round trip (about 2 s for 700 tables and 2 100 modules) and compared: schemas, tables (columns, identity, computed columns, defaults, collations, keys, indexes with INCLUDE and filter, foreign keys, checks), views, procedures, functions, triggers. Constraints the server named itself are matched by what they do; a definition is compared without line ends, trailing blanks, or CREATE / ALTER. What is not read is counted and said.
  - Git-style view (added, modified, removed), a risk on every step (safe, caution, destructive, manual), a line diff for code.
  - **The script is re-entrant**: every step tests the state it changes, one statement per batch, ordered, and it stops at the first error; run again, on a database that is up to date or half done, it does no harm. Destructive steps are left out unless asked for. `CREATE OR ALTER` from SQL Server 2016 SP1, a stand-in and `ALTER` before.
  - **Apply…** runs it on another database of the connection or on another saved connection: where the target stands first (to do, already done, partly done or different), a confirmation naming the server and the database, a progress bar, Stop, then the target is read again.
  - **Modified since…** lists what was created or altered in the last 15 minutes to 30 days from the dates the server keeps on its objects, without a snapshot, with their code. It does not see what was dropped nor what happened to the data.
- **Open transactions**: a panel now runs its scripts on one connection of its own; a transaction a script leaves open is shown in the footer of the results with Commit and Roll back, and asked about when the panel closes. A `BEGIN TRAN` is no longer reported as error 266, and `#temp` tables survive from one run to the next.
- **Instance tree** in the side panel (Files / Instance): databases, tables, views, procedures and functions read level by level; script, rename and delete from the context menu, with the exact SQL and what refers to the object shown before anything runs.
- **Syntax check** by SQL Server itself (`sqlwayfarer.diagnostics.syntax`, off by default): errors underlined on their line.
- **Result grid**: column resizing, vertical separators, a **#Temp** button that scripts a result set into a temp table, and a pop-up with the column names to copy.
- **Import of servers** from a Central Management Server or a `.regsrvr` file, with connection groups; never a password.
- **Schema source**: the Explorer, the index and the autocompletion can read the schema of another saved connection while the queries run on the tab's own.
- **SQL Prompt snippets** (`.sqlpromptsnippet`) can be imported; snippets expand with Tab fields.
- **Autocompletion**: table-valued functions, temp tables and table variables, `OUTPUT`, `MERGE`, data types, `ORDER BY` aliases, `JOIN … ON` key proposals, `USE other_db`.
- **Format SQL** (`Shift+Alt+F`, GO-aware) and find and replace (`Ctrl+H`); more rows, JSON export and cell copy in the result grid.
- **Index**: what every build costs is recorded, with a Stats tab; the Explorer lists the objects an update would re-analyze.
- **Windows authentication** (current user) through a small helper; Microsoft Entra ID sign-in (beta).

### Changed

- The query editor takes two thirds of the Query tab by default.
- The top bar stays on one line (800 px for a Query tab; the actions go to a second line below 1100 px when the schema comes from another connection).
- **Indexing a database of the size of a real legacy one** (2 835 objects) takes 9 to 16 s instead of 488 s: the T-SQL parser predicts with SLL first and falls back to the full parse only when needed, and its workers are kept alive between batches.
- Every connection has its own pool (the driver's global pool was shared by every tab).
- **Index cache**: the index format is now 6: the first indexing after the update is a full rebuild.

### Fixed

- Server addresses with an instance, a port or a protocol; XML entities in imports decoded in one pass.
- A group name with a `/` is not a level; named pipes are skipped and reported.

### Known limits

- Not tested in a real VS Code yet: the native dialogs of the new features, and the connection to another server for Apply. Windows and Entra sign-in have seen limited testing.
- The comparison does not read permissions, user-defined types, synonyms, sequences, CLR, partitioning, columnstore or XML indexes, nor column properties such as sparse, masked or encrypted; temporal, memory-optimized, graph and file tables are left out. A rename is seen as a drop and an add.

## [0.12.12] - 2026-10-26

### Fixed

- **Table Footprint**: a `DELETE` was recorded as a *read*, so the triggers of the deleted table were never followed and the tables they write were missing from the footprint — the one effect the view exists to reveal. Writes are now tracked at the table level, next to the column level: a `DELETE` and an `INSERT` without a column list are writes even though they name no column, and the triggers of a written table fire as they should.
- **Table Footprint**: a table referenced without its schema was resolved to the first same-named table found, which could well be another schema's (`audit.Users` instead of `dbo.Users`), and the wrong triggers were then followed. It is now resolved the way SQL Server resolves it inside a module — against the schema of the module that mentions it — and a reference that stays ambiguous is reported as unresolved rather than guessed.
- **Parsing**: a double-quoted identifier (`"dbo"."Users"`) crashed the T-SQL lexer and took the whole analysis of the object down with it. The Babelfish grammar carries a PostgreSQL-ism behind that rule; the generated parser now fixes the flag to the SQL Server default (`QUOTED_IDENTIFIER ON`).
- **Parsing**: the delimiters of a delimited identifier (`"dbo"."Users"`, `[dbo].[Users]`) were kept in the table names, so those names never matched the objects of the index.

### Added

- **Table Footprint**: a warning when an object could not be parsed cleanly. The T-SQL parser recovers from a syntax error and analyzes the rest of the definition anyway, so the footprint built on it was partial but looked complete — it now says so.

### Changed

- **Index cache**: the index format changed (v5): the first indexing after the update is a full rebuild.

## [0.12.11] - 2026-10-26

### Fixed

- **Indexing**: since 0.12.9 the indexing messages (progress, failure, cancellation) threw an error, so the Explorer stayed locked on "Select a database to activate the explorer" and nothing worked. A test now guards against it.

## [0.12.10] - 2026-10-26

### Changed

- **Sidebar view**: it is named "SQL Wayfarer" instead of "Snippets" (0.12.9) or "SQL Snippets": the view holds the entry point of the whole extension, not only the snippets.

## [0.12.9] - 2026-10-26

### Added

- **Microsoft Entra ID sign-in (beta)**: a connection can now use *Microsoft Entra ID (Azure SQL)* as its authentication, for Azure SQL servers that no longer accept SQL logins. It signs in with the Microsoft account of VS Code (MFA and single sign-on included), stores no password, always encrypts the connection, and renews the access token in the background so the connection keeps working past the hour a token lives. Not yet tested against a live Azure SQL: please report problems via GitHub Issues.

### Changed

- **Sidebar view**: "SQL Snippets" is now simply "Snippets", as the extension is much more than snippets.
- **Authentication in the README**: it now says plainly what is supported. A Windows account is sent with its password (NTLM), saved once in the secret storage; integrated authentication (SSPI/Kerberos) is not available, because the underlying driver (tedious) cannot call SSPI.

### Fixed

- **Escaping in the Explorer**: text coming from the database (schema names, index filter definitions, indexing and documentation messages, the name in "No dependencies found") was inserted into the page without being escaped.
- **Operations query**: the dependency operations lookup built its SQL by interpolating the object name. It passes the name as parameters now, like every other query.

## [0.12.8] - 2026-10-26

### Added

- **Query graph**: a button in the Query toolbar graphs what the editor's query touches — the tables it reads, the join conditions between them, and the tables reached through the procedures, functions and views it calls. The joins come from a real T-SQL parser, so the edges are the ones the query actually writes: `ON` conditions with their columns, `LEFT`/`INNER`/`CROSS` kinds, comma joins (flagged as inferred), and CTEs or derived tables resolved to the tables behind them. **Select a query in the editor and the graph covers that query only**; with no selection, the whole buffer is graphed. The overlay has the same three tabs as the Table Footprint: the join graph, the PK/FK relations between those tables, and their documentation.

### Changed

- **Cross-database dependencies**: a dependency that lives in another database (a view of this one selecting from `OtherDb.dbo.Orders`) was a dead end — its type was guessed as "Object" and there was no way to reach it. It now shows its real type, resolved in the database that owns it, and is a link: one click opens that database in the Explorer and selects the object. Those nodes are dashed in the dependency graph.
- **Modal chrome**: the header of the dialogs (title and close button) and the tabs of the graph overlay took more room than the content itself. Both are more compact now.

## [0.12.7] - 2026-10-25

### Changed

- **Marketplace listing**: the extension was listed with the vocabulary of SQL tooling, but not with the one of its actual audience - the developer who inherits a legacy database with no documentation and no tests. The keywords and the first lines of the README now say it in those words, so the extension shows up when someone searches for a legacy database to document or a schema to audit.

## [0.12.6] - 2026-10-25

### Fixed

- **SQL Files panel**: some files would not open when they were clicked. The folder headers of the list were sticky, so on a long list they piled up over the files underneath and swallowed the clicks.
- **Toolbar icons**: the icons of the tab bar (settings, files, new tab) sat lower than the labels next to them. They now have the same height and the same box as the text tabs.
- **Snippets sidebar**: "Open SQL Wayfarer tab" was styled as a link, so it looked like plain text. It is a button now.

### Changed

- **SQL Files panel**: the list is now a real tree - folders nested by path, each row showing only its own name, indented under its parent, with the number of files it holds. The number of files of the workspace is shown in the panel header. The panel can be resized by dragging its right edge, and the width is remembered.

### Removed

- The emoji in front of the History and Snippets dropdowns, replaced by real icons.

## [0.12.5] - 2026-10-25

### Changed

- **Rating prompt**: the request for a Marketplace rating now comes after five successful queries instead of ten, and no more than once every three weeks. It also asks for a rating rather than a written review - a star is enough to make the number of ratings show up in the search results, which is the one thing the extension page is missing.

## [0.12.4] - 2026-10-25

### Fixed

- **Marketplace header**: the extension page header lost its dark blue colour when the banner was dropped from the package. The banner block is back - colour, theme and artwork - and the artwork ships in the VSIX again.

## [0.12.3] - 2026-10-25

### Changed

- **README**: the extension page on the Marketplace now opens on the project banner. The Marketplace has no banner slot of its own - the README is what visitors actually see.

### Removed

- The banner image is no longer packaged in the VSIX: nothing on the Marketplace ever displayed it. It stays in the repository, where it is useful for sharing the extension.

## [0.12.2] - 2026-10-25

### Fixed

- **Banner artwork**: the project banner added in 0.12.1 carried a hand-drawn copy of the compass instead of the real icon. It now uses the extension's own logo.

## [0.12.1] - 2026-10-25

### Added

- **Rating prompt**: after ten successful queries, SQL Wayfarer asks - once a month, and never twice in a row - whether you would like to leave a review on the Marketplace. The rating and the number of ratings are shown right in the Marketplace search results, which is how people find the extension in the first place.

### Changed

- **Marketplace listing**: the extension page now uses the full 30 keyword slots and two categories (Visualization and Data Science). Until now half of the keyword budget was unused, and the listing had a single category.

## [0.12.0] - 2026-10-25

### Added

- **CodeMirror 6 query editor**: the query editor is no longer a `<textarea>` with a hand-rolled highlighting overlay, but a real editor component - line numbers, SSMS-style rectangular selection (Alt+drag), and syntax highlighting driven by a T-SQL tokenizer.
- **Independent tabs**: every SQL Wayfarer tab now has its own connection, its own query history and its own draft recovery. A new tab is opened from the "+" button in the toolbar. One server + login can only be used by one tab at a time, so the per-connection query history stays unambiguous.
- **Snippet manager in the activity bar**: snippets are reachable without a tab open, and a change is broadcast live to every open tab.

### Fixed

- **Switching between tabs**: no more black screen, and no more full reload of the tab. VS Code was tearing the webview down every time a tab was hidden and rebuilding it on the way back - re-parsing ~3 MB of vendored scripts and re-running every request. The tab also kept its state, starting with the selected database.
- **Waiting screen**: a tab that is starting now shows a spinner instead of a blank panel, and says so if it is taking unusually long - so it is clear whether it is loading or stuck.
- **F5 in the query editor**: running a query no longer also opens VS Code's "Select debugger" picker in the middle of the screen.
- **Autocomplete predictions after a server lookup**: the suggestion list no longer stays empty when the column list of a `schema.table` reference (or the object list of a `database.schema.table` reference) came back from the server. The editor's focus is now detected through the editor itself - the focused element is the editor's own text area, so comparing it with the editor's container was never true, and the refresh was skipped every time.
- **Opening a new tab**: the tab no longer comes up blank. When the connection it would auto-connect to is already open in another tab, it says so - which connection is busy, and that a server + login can only be used by one tab at a time - instead of silently failing to connect.
- **Dates in the results grid**: shown as `2008-04-30 00:00:00.000` instead of the raw ISO 8601 `2008-04-30T00:00:00.000Z`. CSV and clipboard export keep the unambiguous ISO form.
- **Ctrl+Enter in the query editor**: no longer inserts a blank line while running the query, and accepting an autocomplete suggestion no longer adds a newline.
- **Editor focus frame**: the frame around the query editor now surrounds the line numbers as well - the line-number gutter is painted over the editor's own outline.
- **Tab state**: a tab that is rebuilt (page reload, window reload) comes back on the database it was working in, and on the tab it was showing. The database selector is rebuilt from scratch every time the list of databases is sent, which wiped the selection; the panel now remembers it per connection and sends it back with the list.
- **Big result sets**: the grid draws the first 2 000 rows of a result set instead of building the whole table at once - 200 000 rows x 10 columns was tens of megabytes of markup, which froze the tab and could take the renderer down. Copy and CSV export still export every row.
- **Autocomplete on large databases**: the object list is indexed once (by name and by schema) instead of being scanned - and every name lowercased - on every keystroke. Resolving a table name in a 20 000 object database went from 1.5 ms to instant.
- **Index cache**: the index files moved to a per-server folder, which left every index written before the move invisible - the extension silently rebuilt all of them at the update (minutes of indexing nobody asked for). They are now migrated on first use.
- **Editor undo**: inserting a snippet or accepting an autocomplete suggestion now replaces the range at the caret instead of the whole query - undoing it no longer throws away the entire query.

### Changed

- **Toolbar**: the Configuration tab is a cog instead of a text tab, a "+" next to the Query tab opens the list of open queries (what a double-click on it did), and the button that opens a new tab shows the extension's compass icon.

## [0.11.3] - 2026-10-24

### Changed

- README: added a Table Footprint screenshot near the top, showing a procedure that only mentions two tables in its own code touching five through a trigger cascade. No functional change.

## [0.11.2] - 2026-10-24

### Fixed

- Table Footprint graph: tables reached only through a trigger cascade were drawn as disconnected floating nodes, with no edge showing how they were reached. The graph now draws an edge from the table whose write actually fired the trigger to the cascaded table, labelled with the trigger's name, so the cascade is visible instead of implied by the node color alone.

## [0.11.1] - 2026-10-24

### Changed

- README reorganized to lead with what actually sets the extension apart (column-level lineage, trigger-aware Table Footprint, dependency analysis) instead of opening with generic connection/browsing features shared by every SQL client. No functional change.

## [0.11.0] - 2026-10-24

### Added

- **Multiple buffers in the Query tab**: a dropdown under "Query" lists every open buffer — a draft, or a `.sql` file on disk that can be saved straight back to it (`Ctrl+S` or a Save button, greyed out when there's nothing to save). Each buffer remembers which database it was last run against.
- **Workspace SQL file browser**: a collapsible side panel (folder icon next to the Query tab) lists every `.sql` file in the workspace, recursing into subfolders, with a filter box, per-folder collapse/expand, and a collapse-all toggle.
- **Crash recovery for the Query tab**: unsaved drafts and in-progress edits to an open file are snapshotted continuously and restored automatically after an unexpected close — only the in-editor buffer is touched, files on disk are never auto-written.
- **Result grid filtering and sorting**: a per-grid row filter and clickable column-header sorting, reset on every new run.
- **Unlimited row cap** option alongside the existing 100 / 1,000 / 5,000 / 10,000 choices.
- **Messages tab**: `PRINT` / `RAISERROR` output now collects in its own tab, interleaved in the order it actually happened relative to each result set, instead of attaching to whichever grid happened to be active.
- **Execution plans**: Estimated Plan and Actual Plan buttons render the plan inline via a vendored `html-query-plan`, with dark-mode support.
- **SQL Snippets**: a quick-insert dropdown in the Query toolbar (built-in templates plus custom ones), with a full add/edit/delete manager in the Configuration tab.
- **Go to definition** now also triggers on double-click (in addition to `Ctrl+Click`), and resolves 3-part `database.schema.object` references in another database on the same connection.
- Procedures and functions in the Explorer auto-show a generated call snippet (`EXEC`/`SELECT` template) in the Structure tab.

### Changed

- The query status line ("Done in … — N row(s)") moved from the toolbar to the bottom of the results pane, and the database selector is now pinned to the right of the toolbar — the toolbar no longer wraps to a second line as controls are added.

## [0.10.2] - 2026-10-24

### Fixed

- Toggling a type filter (Tables/Views/…) crashed the Objects list with a `TypeError`, leaving it stuck on "Loading objects…" — a lookup map introduced for collapsible schema groups was read from the wrong manager instance.
- The "NULL" nullability badge was unreadable in themes where the terminal background isn't dark; both nullability badges now use fixed, guaranteed-contrast colors.

## [0.10.1] - 2026-10-24

### Added

- Collapsible schema groups in the Explorer's Objects list — click a schema header to collapse/expand it, state persists across filter and reindex re-renders.

### Fixed

- Unchecking a type filter on a database with many objects did an O(n²) DOM scan to find each row, freezing the UI (~400ms+ on 9,000 objects, worse every keystroke). Replaced with a name → element map built once per render.

## [0.10.0] - 2026-10-24

### Added

- The Objects (raw JSON index) modal is now a collapsible tree instead of a flat pretty-printed dump: containers start collapsed with a one-line preview and expand on click, with children built lazily so opening the modal stays cheap regardless of database size.

## [0.9.2] - 2026-10-23

### Fixed

- Objects-view responsiveness on large databases.
- `large_db_test.sql` (a manual test fixture) is now excluded from the packaged VSIX.

## [0.9.1] - 2026-10-23

### Fixed

- The dependency **Graph** tab loaded `viz.js` from `cdnjs.cloudflare.com` at runtime. On a machine without internet access, or behind a proxy/firewall that blocks that host (common on corporate networks), the graph silently failed to render. `viz.js` is now vendored locally alongside the other graph libraries (dagre, cytoscape).
- Added a `Content-Security-Policy` to the webview, restricting scripts and styles to the extension's own bundled resources now that nothing is loaded from a CDN.
- Removed a stray `"# sqlwayfarer"` line left over from the repository's initial GitHub setup, which rendered at the bottom of this README.

### Changed

- `USE [database]` now doubles a literal `]` in the database name before building the identifier, closing a theoretical injection vector if a database name itself contains `]`.

## [0.9.0] - 2026-10-23

### Added

- **Tabbed multi-result-sets**: the Query tool now renders multiple result sets as tabs, with a hover tooltip naming the statement that produced each one.
- **SQL syntax highlighting** in the query editor, via a lightweight overlay on the textarea.
- **Cross-database autocomplete**: three-part `Database.Schema.Object` references now resolve across other databases on the same connection.

### Changed

- Autocomplete no longer suggests stored procedures outside an `EXEC` context.
- The dependency index is no longer built automatically on every connection — it only starts when the user opens the Explorer tab. The per-object dependency scan now runs 8-way concurrent instead of one round-trip at a time.
- **UI**: the top toolbar is now a single contextual bar whose action buttons swap between Explorer and Query depending on the active tab, reclaiming vertical space for the query editor. The app now lands on the Query tab after connecting, with Query ordered before Explorer.

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
