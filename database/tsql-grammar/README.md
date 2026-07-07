# T-SQL Grammar (Babelfish)

Ce dossier contient la grammaire ANTLR T-SQL utilisée pour parser le SQL Server
et en extraire les opérations DML (SELECT/INSERT/UPDATE/DELETE/MERGE) par table référencée.

## Source

Grammaire officielle du projet [Babelfish for PostgreSQL](https://github.com/babelfish-for-postgresql/babelfish_extensions) :
- `TSqlLexer.g4`
- `TSqlParser.g4`

C'est la grammaire T-SQL open-source la plus complète disponible, maintenue par
Microsoft/AWS pour porter T-SQL vers PostgreSQL.

## Runtime vs Dev

**Au runtime (utilisateurs finaux de l'extension VS Code) :**
- Aucun pré-requis spécial — seulement Node.js (déjà inclus dans VS Code).
- Les fichiers `JS` du parser sont **pré-générés** et versionnés dans `../generated/`.
- Webpack les bundle dans `dist/extension.js`.
- L'utilisateur ne sait même pas que ANTLR est utilisé.

**En dev (mainteneur de l'extension, toi) :**
Pour mettre à jour la grammaire (quand Babelfish release une nouvelle version) :
1. Télécharger `antlr-4.13.2-complete.jar` depuis https://www.antlr.org/download/
2. Le placer dans ce dossier (il est gitignoré)
3. Avoir Java installé (`java -version`)
4. Lancer `node database/generate-tsql-parser.js`

Le script va :
- Générer les fichiers `TSqlLexer.js`, `TSqlParser.js`, `TSqlParserVisitor.js`, `TSqlParserListener.js`
- Les patcher pour les rendre compatibles CommonJS (le projet utilise CJS)
- Les sortir dans `../generated/`

## Pourquoi pas directement un npm package ?

`node-sql-parser` supporte T-SQL mais chie sur les cas courants (`IF EXISTS (...)`).
La grammaire Babelfish est la seule solution open-source complète.

Le seul vrai concurrent est `Microsoft.SqlServer.TransactSql.ScriptDom` (en .NET),
qui nécessite un bridge .NET → JS et complique le packaging. Pas la peine.

## Limitations connues

- Dynamic SQL (`EXEC('SELECT * FROM ' + @table)`) : non résolu (fail safe, fallback)
- MERGE : on note `MERGE` sans détailler les WHEN clauses (à améliorer)
- Bugs grammaires ponctuels : on log un warning et on fallback sur `['REFERENCE']`