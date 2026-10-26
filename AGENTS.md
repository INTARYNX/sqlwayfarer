# AGENTS.md

Working notes for AI agents (and humans) working on this repository.

## What this is

**SQL Wayfarer** — a VS Code extension for SQL Server and Azure SQL: a schema
Explorer, an object inspector (structure, dependency tree, dependency graph,
code, comments), a query editor with execution plans, a data dictionary
exporter, and a write-footprint tracer.

- Extension host code: `extension.js`, `panels/`, `database/`, `storage/`
- Webview (browser side): `webview/` — plain `<script>` tags, **no bundler**
  except CodeMirror (`webview-build/`, bundled by webpack into `dist/webview/`)
- Tests: `test/*.test.js` (mocha TDD style: `suite()` / `test()`), run by
  `@vscode/test-cli` (`vscode-test`), which launches a real VS Code

## Commands

```bash
npm run build      # webpack -> dist/extension.js (+ dist/webview/sqlEditor.js)
npm run lint       # eslint
npm test           # vscode-test (downloads VS Code on first run)
npm run package    # build + vsce package -> .vsix
```

`npm test` needs a desktop session (it opens an Electron window). It works
here, but it takes ~1 min on the first run (VS Code download).

## Conventions

- **Comments in English**, in every file.
- Source files: 4-space indentation. **Test files: tab indentation.**
- The webview files share one global scope (classic `<script>` tags), so a
  class declared in `webview/foo.js` is reachable from `webview/main.js`
  without an import. A file that also has to be unit-tested adds the
  `if (typeof module !== 'undefined' && module.exports)` guard at the bottom
  (see `webview/sqlAutocomplete.js`).
- The `CHANGELOG.md` entry and the version bump (`package.json` +
  `version.json`) belong to a **separate "Release X.Y.Z" commit**, not to the
  feature commit.
- `database/IndexServices.js` caches one index **per database** under
  `~/.vscode/sqlwayfarer/indexes/<server>/<database>.json`. The `<server>`
  segment is the server string of the *connection* (e.g. `localhost`), not
  `@@SERVERNAME`. Bump `INDEX_FORMAT_VERSION` only when the shape of an index
  entry changes — it invalidates every cached index on every user's machine.
- `.vscode/launch.json` and `.vscode/tasks.json` are **tracked** (the rest of
  `.vscode/` is ignored, so each developer's personal settings stay private).
  They are the only way to run the extension from the sources: F5 starts an
  Extension Host on `dist/extension.js`, which is built, not in git. A
  `git clean -xdf` wipes everything *ignored* — a local-only launch.json
  disappeared that way once, and F5 then silently did nothing. The build runs
  as a `preLaunchTask`, so a missing `dist/` is never a blocker.

## Local environment

**A local SQL Server is installed and running on this workstation** — use it
to check behaviour against a real server instead of guessing.

| | |
|---|---|
| Instance | `MSSQLSERVER` (default instance), SQL Server 2022 — 16.0.1000.6 |
| Service | `MSSQLSERVER` (`C:\Program Files\Microsoft SQL Server\MSSQL16.MSSQLSERVER\MSSQL\Binn\sqlservr.exe`), running |
| Machine | `IRATA` — but `@@SERVERNAME` returns **`DESKTOP-JFLHJUC`**, the name registered when SQL Server was installed. Same box, two names: `localhost`, `IRATA` and `DESKTOP-JFLHJUC` all reach the same instance. |
| Account | `IRATA\nifou` — sysadmin, Windows authentication |

```bash
sqlcmd -S localhost -E -q "SELECT @@SERVERNAME, SUSER_SNAME()"   # Windows auth
```

Databases on the instance: `AdventureWorks`, `BigObjectTest`, `demo`,
`sqlpage`, `test`.

Two gotchas:

- **Node's `mssql` driver cannot use Windows authentication here.** It speaks
  NTLM with an explicit password, not the OS token (`sqlcmd -E` works because
  it uses SSPI). To drive the server from Node, create a temporary SQL login
  (`CREATE LOGIN ... WITH PASSWORD=...`) and drop it afterwards. The
  extension's own saved connections carry a password in the VS Code secret
  storage, which cannot be read from outside VS Code.
- **Scratch databases are fine.** Creating a database to test a scenario is
  expected here; drop it when done (`ALTER DATABASE ... SET SINGLE_USER WITH
  ROLLBACK IMMEDIATE; DROP DATABASE ...`).

### Reference data for cross-database work

`AdventureWorks` is a good cross-database target: a view created in another
database can select from `AdventureWorks.Person.Person`, which is exactly the
scenario the Explorer has to resolve (the DMV then reports the dependency as
`AdventureWorks.Person.Person`).
