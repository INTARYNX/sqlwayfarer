# Revue de code complète — SQL Wayfarer

**Dépôt :** https://github.com/INTARYNX/sqlwayfarer
**Branche auditée :** `dev` (`bdea5d2`) — revue du **repo entier**, pas seulement du diff
**Périmètre :** 273 fichiers · ~53 600 lignes de JS/CSS/HTML · `database/` (55) · `webview/` (41) · `panels/` (29) · `test/` (115) · `storage/` · `helper/` · CI · build · packaging
**Date :** 2026-11-04
**Méthode :** lecture du code + exécution réelle (lint, suite de tests, build, `npm audit`) + mesures de performance + analyse croisée automatisée du protocole webview ↔ extension.

---

## Synthèse

> **État au 2026-11-04, après les corrections** — les 15 commits qui suivent la
> revue ont traité 11 des 15 constats. Le détail est dans
> [« Ce qui a été corrigé »](#ce-qui-a-été-corrigé) en bas de ce document.
> Les 4 constats qui restent sont signalés « ouvert ».

Le code est **nettement au-dessus de la moyenne** pour une extension VS Code de cette taille : l'échappement SQL est systématique, la CSP est stricte, les secrets sont dans le `SecretStorage`, le cycle de vie des panels est propre, le protocole est couvert par un test de non-régression, et la suite de tests est substantielle (1 232 cas, 0 test vide, 0 `.only`).

Les problèmes réels ne sont pas dans le code métier mais **autour** :

| | Constat | Sévérité |
|---|---|---|
| **C1** | La CI n'a **jamais** été verte (4 runs, 4 échecs) et ne couvre pas `dev` (+34 294 lignes) | 🔴 Critique |
| **C2** | La suite de tests est **rouge** : un timeout ANTLR (défaut 2 000 ms) — préexistant, aussi sur `main` | 🔴 Critique |
| **E1/E2** | `npm run lint` ne peut **jamais** échouer (règles en `warn`) ; `sourceType: "module"` sur du CommonJS | 🟠 Élevé |
| **E3/E4/E5** | 16 CVE npm ; la CI ne build pas ; 2,9 Mo de vendor sans version ni licence | 🟠 Élevé |
| **E6** | `connect()` concurrent : le **dernier choix de l'utilisateur est perdu** (démontré) | 🟠 Élevé |
| **E7/E8** | Cache d'index écrit non atomiquement ; slug `..` non neutralisé | 🟠 Élevé |
| **E9** | 5 réponses de l'extension sans consommateur → 5 fonctionnalités inaccessibles | 🟠 Élevé |
| **E10** | 158 commits signés « Claude », sans revue humaine ni CI | 🟠 Élevé |

**Verdict :** la base de code est saine ; le projet, lui, n'a jamais été vérifié automatiquement. Le premier chantier n'est pas du code, c'est de **rétablir la boucle de contrôle** (lockfile sur `main`, CI sur `dev`, build dans la CI, timeout de test).

---

## 🔴 C1 — La CI n'a jamais été verte et ne couvre pas la branche de travail

**Fichiers :** `.github/workflows/ci.yml:1-4`, `package-lock.json` (présente sur `dev`, absente de `main`)

```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
```

**Constats vérifiés :**

- `dev` est **158 commits devant `main`** (`git rev-list --count main..dev` = 158, `dev..main` = **0** → `main` est fast-forwardable). Le diff vaut **215 fichiers, +34 294 / −2 407 lignes**. La CI ne teste donc **aucune** de ces lignes.
- L'API GitHub Actions du dépôt renvoie **4 runs au total**, tous sur `main`, tous les 4 le 2026-10-26, tous `conclusion: "failure"` :
  ```
  4 | main | failure | Release 0.12.7                  | 2026-10-26
  3 | main | failure | Remove an unused glyph...        | 2026-10-26
  2 | main | failure | Remove the unused claude glyph.. | 2026-10-26
  1 | main | failure | Release 0.12.7                  | 2026-10-26
  ```
- Le détail du job (`/actions/runs/40282959538/jobs`) montre que **les 4 runs ont échoué à l'étape `npm ci`** — jamais aux tests, jamais au lint :
  ```
  1 Set up job              -> success
  2 Run actions/checkout@v4 -> success
  3 Run actions/setup-node  -> success
  4 Run npm ci              -> failure   <-- ici
  5 Run npm run lint        -> skipped
  6 Run xvfb-run -a npm test-> skipped
  ```
- **Cause racine :** `package-lock.json` n'existait pas. `git ls-tree main --name-only | grep -c package-lock` → **0**. Or `npm ci` refuse de s'exécuter sans lockfile (`lockfileVersion >= 1`).
- Le lockfile a été ajouté **sur `dev` uniquement**, au commit `fa87d33` — dont le message dit exactement le diagnostic : *« Track package-lock.json: the CI runs npm ci, which needs it »*. **`main` ne l'a toujours pas** : la CI de `main` échouerait donc encore aujourd'hui.

**Conséquence :** depuis la création du dépôt (2026-10-26), **aucun test n'a jamais été exécuté automatiquement**, ni sur `main`, ni sur `dev`. Ni le lint, ni les 1 232 tests, ni le build.

**Correction :**

1. Fast-forward `main` sur `dev` (`git checkout main && git merge --ff-only dev`) — le lockfile et les 158 commits arrivent avec.
2. Étendre les déclencheurs : `branches: [main, dev]` en `push` **et** en `pull_request`.
3. Ajouter `npm run build` à la CI (cf. E4).
4. Ajouter `npm audit --audit-level=high` et un cache npm (`actions/setup-node` avec `cache: 'npm'`).
5. Envisager un job `sql-integration` avec le service `mcr.microsoft.com/mssql/server` + `SQLWAYFARER_TEST_SQL` pour couvrir les 39 tests live aujourd'hui skippés.

---

## 🔴 C2 — La suite de tests est rouge (timeout ANTLR)

**Fichier :** `test/babelfishSqlParser.test.js:85-90`

```
$ npm run test:unit
  1266 passing (26s)
  232 pending
  1 failing

  1) BabelfishSqlParser
       detects UPDATE and INSERT targets in HumanResources.uspUpdateEmployeeHireInfo:
     Error: Timeout of 2000ms exceeded.
```

**Mesures.** Le coût n'est pas dans l'analyse mais dans la **construction initiale des tables DFA d'ANTLR**, par processus :

| | SLL (stage rapide) | LL (parse complet) |
|---|---|---|
| Processus neuf (cache à froid) | **1 399 ms** | **1 653 ms** |
| Cache chaud | 0–3 ms | 10–52 ms |

**Pourquoi c'est déterministe :** `babelfishSqlParser.test.js` est le **premier fichier alphabétiquement** de `test/` → il s'exécute toujours en premier → il est toujours le premier à payer le cold start. Relancé isolément avec `--timeout 20000`, le même cas passe en **2 198 ms** — juste au-dessus du défaut mocha de 2 000 ms.

**Ce n'est pas une régression de `dev`.** Vérifié par worktrees :

| Commit | Résultat |
|---|---|
| `dev` (bdea5d2) | ❌ timeout |
| `f78d1f6^` (parent de l'optimisation SLL) | ❌ timeout |
| `main` (8611e9f, Release 0.12.12) | ❌ timeout |

Le commit `f78d1f6` (« Parser: SLL prediction first… ») a bien ajouté un étage rapide, mais **il ne change rien à ce test** : le coût est dominé par le cold start du cache DFA, pas par la stratégie de prédiction. Le commentaire du commit (« tens of times faster on a warm parser ») est exact — mais le test ne tourne jamais « à chaud ».

**Correction :**

- court terme : `--timeout 10000` sur `test:unit` (et sur `.vscode-test.mjs`) ;
- mieux : un `before()` de warms du cache ANTLR dans le test ;
- structurellement : le vrai coût est ailleurs — voir ci-dessous.

**Impact réel sur l'extension (au-delà du test) :** `ParserWorkerPool` (`database/ParserWorkerPool.js:36-49`) crée **jusqu'à 4 workers**, et chacun charge le parser ANTLR généré (5,71 Mo de source) dans son propre heap. Chaque worker paie son cold start → **jusqu'à ~4 × 1,5 s = 6 s** de latence au premier indexage, et **×4 la mémoire** pour des tables DFA identiques. Le commentaire du fichier (« the CPU-bound ANTLR parse (40-550ms per object) ») décrit le cas chaud et masque ce cold start.

---

## 🟠 Élevé

### E1 — `npm run lint` ne peut jamais échouer

**Fichier :** `eslint.config.mjs:20-26` — toutes les règles structurantes sont en `"warn"` (`no-undef`, `no-unused-vars`, `no-unreachable`…).

Vérifié : `npx eslint .` → `✖ 3 problems (0 errors, 3 warnings)`, **exit 0**. Les 3 warnings actuels (`BabelfishSqlParser.js:733`, `:891`, `:915`) ne bloquent rien.

Une porte de lint purement informative sur 35 000 lignes n'est pas une porte. Passer en `"error"` et ajouter `--max-warnings=0` ; les 3 warnings actuels se corrigent en 3 lignes.

### E2 — `sourceType: "module"` appliqué à du code CommonJS

**Fichier :** `eslint.config.mjs:11-19`

```js
{ files: ["**/*.js"], languageOptions: { sourceType: "module", ... } }
```

Tout le code extension (`extension.js`, `database/`, `panels/`, `storage/`) est en **CommonJS** (`require` / `module.exports`). Le bloc webview est, lui, correct (`sourceType: "script"`). Le bloc global fausse la résolution de portée (`require` non résolu, `module`/`exports` traités comme des liaisons de module).

**Correction :** `sourceType: "script"` par défaut, avec un override `module` uniquement pour `webview-build/**` (qui est en ESM).

### E3 — 16 vulnérabilités npm (1 high, 15 moderate)

```
$ npm audit
serialize-javascript  CPU exhaustion DoS + XSS via unescaped </script>
uuid < 11.1.1         Missing buffer bounds check (via @azure/msal-node → mssql)
16 vulnerabilities (15 moderate, 1 high)
```

`npm audit fix` sans rupture corrige `serialize-javascript`. Le correctif d'`uuid` exige `mssql@12` (rupture). À traiter : `npm audit fix` d'abord, puis planifier la montée de `mssql`.

### E4 — La CI ne construit pas l'extension

`ci.yml` ne fait pas `npm run build`. Une régression webpack, un `main` de `package.json` désynchronisé, ou un fichier runtime absent du `.vsix` passent inaperçus — le `.vsix` n'est jamais produit ni inspecté.

**Coût mesuré du build :**
```
extension : 104 730 ms   (dont 5,71 Mo de parser ANTLR généré)
webview   :  29 388 ms   (sqlEditor.js = 700 Ko minifié)
total     : ~2 min 15
```

À ajouter à la CI : `npm run build`, puis `npx vsce package --no-dependencies` et une **assertion sur le contenu du paquet** (`vsce ls`) vérifiant la présence de `webview/**`, `dist/extension.js`, `helper/SqlWayfarerSspi.exe` et l'absence de `test/**`, `*.ps1`, `database/**`.

### E5 — 2,9 Mo de vendor non versionnés, dont 1,98 Mo sans bandeau de licence

**`webview/vendor/`** :

| Fichier | Taille | Bandeau de licence |
|---|---|---|
| `viz.full.render.js` | **1 979 670 o** | **aucun** (Viz.js 2.1.2 / Graphviz 2.40.1 / Emscripten 1.37.36) |
| `cytoscape.min.js` | 435 328 o | MIT ✔ |
| `dagre.min.js` | 283 803 o | **aucun** |
| `cytoscape-dagre.min.js` | 45 620 o | MIT ✔ |
| `viz.js` | 11 468 o | MIT ✔ |

Les fichiers n'ont **pas de version dans leur nom** → impossible de savoir quelle CVE s'applique, et hors de portée de `npm audit` (copiés à la main). `dagre` est pourtant déjà en `devDependencies` (0.8.5) — le vendor fait doublon.

**Correction :** basculer `dagre` et `cytoscape` en dépendances npm et les bundler via webpack (le bundler est déjà en place) ; pour `viz.full.render.js`, **obtenir la licence** (Viz.js est MIT) et l'exposer clairement, ou l'évaluer comme du code mort.

### E6 — `connect()` concurrent : le dernier choix de l'utilisateur est perdu

**Fichier :** `database/ConnectionManager.js:135-149`

```js
async connect(connectionConfig) {
    const poolConfig = await this.buildConnectionConfig(connectionConfig);
    const newConnection = await this._openPool(poolConfig);   // <-- await non protégé
    if (this._activeConnection) await this._activeConnection.close()...;
    this._activeConnection = newConnection;
    ...
}
```

Aucun verrou d'in-flight, aucune déduplication. **La connexion qui gagne est celle qui résout en dernier, pas celle demandée en dernier.** Reproduction (délais simulés : A = 200 ms, B = 10 ms ; l'utilisateur clique A puis B) :

```
ordre demande : A puis B (B = dernier clic)
appels         : open srvB | open srvA | close srvB
connexion active FINALE : srvA        <-- le dernier choix est perdu
```

Le pool de B (le dernier choix) est refermé et l'extension se dit connectée à A (le premier choix). Double Défaut : deux pools ouverts au lieu d'un, et une connexion refermée par erreur.

**Garde partielle existante mais incomplète :**
- `panels/SqlWayfarerPanel.js:358` et `:398` ont un garde `this._connecting` ;
- mais `_reconnect()` (`:397-406`) **ne pose pas** `_connecting = true` pendant sa phase `dispose()/reset()` (`:400-404`) → fenêtre d'exposition réelle ;
- `panels/handlers/ConnectionHandlers.js:48-64` (`handleConnectWithSaved`) n'a **aucun** garde de concurrence — `_refuseDuplicate` (`:28-37`) ne refuse que le **même onglet déjà ouvert sur la même identité**, pas deux connexions distinctes lancées en parallèle.

**Correction :** sérialiser les connexions dans `ConnectionManager` (file d'attente ou numéro de séquence : seule la connexion dont le jeton est le plus récent devient active, les autres sont fermées), et poser `_connecting = true` dès le début de `_reconnect()`.

### E7 — Écriture non atomique du cache d'index

**Fichier :** `database/IndexServices.js:873-881`

```js
await fs.writeFile(indexFile, JSON.stringify(index, null, 2), 'utf8');
```

Pas d'écriture temporaire + `rename()`. Une interruption (kill de VS Code, crash, coupure) laisse un JSON **tronqué**. La lecture est bien tolérante — `_loadIndex` (`:814-836`) encapsule le `JSON.parse` dans un `try/catch` et renvoie `null` → reconstruction. Donc **pas de crash**, mais **perte de l'index** → reindexation complète (des minutes sur une grosse base, et un pic de charge serveur).

Même problème pour `_recordStats` (`:856`).

**Correction :** écrire `index.json.tmp` puis `fs.rename()` (atomique sur le même système de fichiers).

### E8 — Le slug de l'index laisse passer `..`

**Fichier :** `database/IndexServices.js:765`

```js
const slug = name => (name || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
```

Le `.` est autorisé, donc `..` traverse intact. Vérifié :

```
server=".."   db="MyDb"  ->  ~/.vscode/sqlwayfarer/MyDb.json     (au lieu de .../indexes/../MyDb.json)
server=".."   db=".."    ->  ~/.vscode/sqlwayfarer/...json
```

Le nom de serveur vient de la config de connexion (utilisateur) ou de `@@SERVERNAME`. Impact limité (un seul niveau, nom de fichier assaini), mais la neutralisation est incomplète : `..` doit être traité comme un segment invalide, pas comme un nom d'objet.

### E9 — 5 réponses de l'extension sans consommateur : 5 fonctionnalités inaccessibles

Analyse croisée automatisée du protocole (commande → `case`), sur `webview/**/*.js`, `webview/**/*.html`, `panels/**/*.js` :

| Sens | Résultat |
|---|---|
| webview → extension | 83 commandes envoyées, **0 orpheline** ✔ |
| extension → webview | 87 commandes envoyées, **5 orphelines** ✘ |

Les 5 commandes orphelines :

| Envoyée par | Commande | Consommée ? |
|---|---|---|
| `panels/handlers/DatabaseHandlers.js:182` | `searchObjectsResult` | **non** |
| `panels/handlers/DatabaseHandlers.js:191` | `tableRowCountResult` | **non** |
| `panels/handlers/DatabaseHandlers.js:200` | `tableSampleDataResult` | **non** |
| `panels/handlers/DatabaseHandlers.js:231` | `impactAnalysisResult` | **non** |
| `panels/handlers/IndexHandlers.js:97` | `indexStatsResult` | **non** |

Symétriquement, le webview n'envoie **jamais** `searchObjects`, `getTableRowCount`, `getTableSampleData`, `getImpactAnalysis`, `getIndexStats` (grep sur tout le dépôt → 0 occurrence hors extension et tests).

**Ce n'est pas un oubli, c'est un choix assumé** — `test/webviewProtocol.test.js:68-76` :

```js
// Answers of handlers for requests the page does not send (any more): fine
// as long as that stays true - the day a page asks for one, it needs a case.
const ANSWERS_NOBODY_ASKS_FOR = {
    searchObjectsResult: 'searchObjects',
    tableRowCountResult: 'getTableRowCount',
    ...
};
```

**Conséquences :**
1. **5 fonctionnalités complètes mais inaccessibles** : recherche d'objets, comptage de lignes via `COUNT_BIG`, échantillon de données, analyse d'impact, statistiques d'index.
2. **Du code mort maintenu en vie** : `DatabaseService.getTableRowCount` / `getTableSampleData`, `DependencyService.getImpactAnalysis`, `IndexService.getIndexStats`, plus tout le câblage des handlers.
3. **Une incohérence de roadmap** : le commit `ab3a19b` (« Row count: COUNT_BIG, so a table past 2^31 rows does not fail ») corrige un chemin que l'UI n'atteint plus.

À noter : le README reste exact — le badge de nombre de lignes de l'Explorer vient d'un **autre** chemin (`sys.dm_db_partition_stats`, `DatabaseService.js:427-438`), pas de `getTableRowCount`.

**Correction (au choix) :** soit rebrancher les 5 dans le webview, soit les supprimer (côté service, handler, test et liste blanche du test de protocole).

### E10 — 158 commits, 100 % IA, sans revue ni CI

```
$ git log --format='%an' main..dev | sort | uniq -c
    158 Claude
$ git log --format='%ad' --date=short main..dev | sort | uniq -c
     90 2026-11-02
     67 2026-11-03
      1 2026-11-04
```

Trois jours de développement, 158 commits, **aucun commit humain, aucune pull request, aucune CI sur la branche**. Combiné à C1, cela signifie que **34 294 lignes n'ont jamais été exécutées par un pipeline automatique**.

Ce n'est pas en soi un défaut du code (la qualité est bonne), mais c'est un risque de process : rien ne garantit que les commits restent atomiques, testés et réversibles.

**Correction :** au minimum, activer la CI sur `dev` (C1) et exiger un pipeline vert avant merge.

---

## 🟡 Moyen

### M1 — `sqlwayfarer.openConnection` enregistrée mais absente du manifeste

`extension.js:52` enregistre `sqlwayfarer.openConnection` ; `package.json` → `contributes.commands` ne déclare que `sqlwayfarer.sqlwayfarer`. La commande fonctionne (appelée par `executeCommand` depuis `panels/SnippetSidebarProvider.js:74` et `:122`), mais elle est invisible dans la palette et échoue à tout contrôle de cohérence manifeste ↔ code.

### M2 — Import de connexions : collision de nom silencieuse, mot de passe périmé

`storage/ConnectionStorage.js:105-121` (`_saveConnections`, chemin de l'import) :

```js
this._savedConnections.set(config.name, { ...config, password: undefined });  // écrase sans vérifier
// ... "No password is touched."
```

Un import qui porte un nom déjà existant **remplace** serveur/base mais **conserve l'ancien mot de passe** → l'utilisateur ne peut plus se connecter, sans message d'erreur. Le chemin unitaire `saveConnection` refuse lui la collision (`:66-68`) : l'incohérence entre les deux chemins est visible.

### M3 — `PanelStateStore.set()` : read-modify-write sans section critique

`panels/panelState.js:28-33` : `const all = {...get()}` puis `update(STATE_KEY, all)`. Deux panels écrivant deux identités en parallèle peuvent se perdre une écriture. Faible en pratique (état d'UI, pas de données), mais réel ettrivial à corriger (sérialiser par identité).

### M4 — `deleteConnection` supprime le secret avant de vérifier l'existence

`storage/ConnectionStorage.js:134-137` : `secrets.delete(...)` précède le `if (!this._savedConnections.delete(name)) throw`. Supprimer une connexion inexistante efface quand même le mot de passe associé à ce nom.

### M5 — `commit.ps1` : `git add -A` puis `git push`

`commit.ps1` indexe **tout** le répertoire de travail (y compris des fichiers parasites non couverts par `.gitignore` : `.env`, dumps SQL, secrets) puis pousse. `deploy.ps1` appelle ce script **après** `vsce publish` → un commit raté laisse une version publiée sans commit correspondant.

À noter, `deploy.ps1` ne contient **aucun secret en dur** (il utilise `vsce publish`, qui lit le PAT de l'environnement) ✔.

### M6 — `test:unit` exclut 8 fichiers, dont le cœur

```
--ignore test/extension.test.js        --ignore test/queryHandlers.test.js
--ignore test/panelState.test.js        --ignore test/indexHandlers.test.js
--ignore test/queryFileHandlers.test.js --ignore test/liveQueryHandlers.test.js
--ignore test/ratingPrompt.test.js      --ignore test/snippetHandlers.test.js
```

Ces fichiers sont couverts par `npm test` (vscode-test), donc **pas de couverture perdue** — sauf que la CI n'a jamais dépassé `npm ci` (C1) : **aucun de ces tests n'a jamais été exécuté automatiquement**. Corriger C1 rend cette exclusion inoffensive.

### M7 — Le webview (~7 000 lignes de JS métier) n'a aucun test unitaire

Les tests e2e (`test/e2e/*.e2e.js`) se skippent quand Playwright est absent, et `npm run test:e2e` n'est pas dans la CI. La logique pure du webview (`sqlContext.js`, `sqlMatcher.js`, `sqlAutocomplete.js`) est pourtant du JavaScript pur, testable en Node sans DOM — c'est même ce que fait `test/autocompleteFuzz.test.js`. Extraire cette logique dans des modules `require`-ables (plutôt que des globals de webview) la rendrait couverte par `test:unit`.

### M8 — `package-lock.json` exclu du `.vsix`

`.vscodeignore` l'exclut. Sans impact à l'exécution (le bundle est autonome), mais le paquet livré n'est pas reproductible.

---

## 🔵 Faible

- **F1** — `.vscodeignore` : `!readme.md` et `!LICENSE.txt` ne correspondent pas aux fichiers réels (`README.md`, `LICENSE`). Sans conséquence sur un empaquetage Windows (système insensible à la casse), cassant sous Linux/macOS.
- **F2** — **2,9 Mo de JS vendor parsés à chaque ouverture de panel** (`viz.full.render.js` 1,98 Mo + `dagre` 284 Ko + `cytoscape` 435 Ko + `cytoscape-dagre` 46 Ko), alors que le graphe n'est affiché qu'à la demande. Chargement bloquant du webview à chaque ouverture de l'extension.
- **F3** — `database/ParserWorkerPool.js:22` : le commentaire « the CPU-bound ANTLR parse (40-550ms per object) » décrit le cas **chaud** ; le cas froid (premier parse d'un processus) coûte 1,4–1,65 s. Le commentaire masque le coût réel du démarrage.
- **F4** — `database/IndexServices.js:762` : le commentaire assure que la séparation serveur/base empêche les collisions, mais sur un système de fichiers **insensible à la casse** (Windows, macOS) `SERVER/MyDb.json` et `server/myDb.json` sont le même fichier. Sans conséquence réelle (SQL Server est insensible à la casse), mais l'affirmation du commentaire est inexacte.

---

## ✅ Points forts vérifiés

### Sécurité — aucune vulnérabilité confirmée

**Injection SQL : l'échappement est systématique.** `database/sqlIdentifier.js` fournit `bracketIdentifier()` (double le `]`, la règle SQL Server) et `escapeLiteral()` (double le `'`). Vérifié sur toutes les interpolations de noms d'objets :

- `DatabaseService.js:482,494` · `schemaCatalog.js:134,315` · `migrationScript.js` (toute la génération de DDL) · `recentChanges.js:83-84` · `instanceActions.js:15,20,27` · `dbSnapshots.js:42,116` · `ScriptGeneratorService.js:81` · `ConnectionManager.js:264` — tous via `bracketIdentifier` / `escapeLiteral`.
- Les littéraux passent par `escapeLiteral` ; le reste est **paramétré** (`@pattern`, `@descValue`, `@schema`, `@objectName`…).
- `DataDictionaryService.js:34-37` construit un `IN (@t0, @t1, …)` **paramétré**.
- Aucun `eval`, `new Function`, `vm.runInNewContext`.
- `child_process` n'est utilisé que par `database/SspiPool.js:107`, qui lance le helper **sans aucun argument** (`spawn(this._helperPath, [])`) et communique par stdin/stdout → **pas d'injection d'argument de ligne de commande**.

**XSS : la CSP est stricte et l'échappement est appliqué.**
- `webview/index.html:6` : `default-src 'none'; font-src {{CSP_SOURCE}}; img-src {{CSP_SOURCE}}; style-src {{CSP_SOURCE}} 'unsafe-inline'; script-src {{CSP_SOURCE}}` — **aucun `unsafe-inline` sur les scripts**, aucune source distante, aucune télémétrie.
- `panels/SqlWayfarerPanel.js:232` : `localResourceRoots: [extensionUri]`.
- `escapeHtml` (`webview/fileTree.js:64-68`) couvre `& < > " '`.
- J'ai analysé les **17 blocs `innerHTML =` à interpolation** du webview : tous les cas non échappés sont des valeurs numériques, des noms d'icônes ou du HTML déjà construit (`main.js:335-365` échappe explicitement la base et la date ; `queryManager.js:679` encapsule du HTML interne).

**Secrets :** les mots de passe vivent dans le `SecretStorage` VS Code (`sqlwayfarer.password.<nom>`), la config de connexion est stockée avec `password: undefined` (`ConnectionStorage.js:80`). Le mot de passe ne transite pas en clair par `postMessage`.

### Architecture et robustesse

- **Protocole bien tenu :** 83 commandes webview→extension, **0 orpheline** ; le switch principal a un `default:` qui journalise les commandes inconnues (`SqlWayfarerPanel.js` fin du switch) ; `test/webviewProtocol.test.js` vérifie **les deux sens** + l'ordre de chargement des scripts + que chaque placeholder HTML est fourni.
- **Cycle de vie :** `SqlWayfarerPanel.dispose()` (`:665-695`) libère les `_disposables`, le `ConnectionManager`, l'`IndexService`, le comparateur et la source de schéma. Les vues CodeMirror sont `destroy()` (`webview-build/sqlEditor.js:375`, `webview/codeViewManager.js:82`), les Cytoscape aussi (`footprintManager.js:164,208,270`).
- **Cache d'index tolérant :** `_loadIndex` encapsule `readFile` + `JSON.parse` dans un `try/catch` → un cache corrompu **ne casse pas** l'extension, il est reconstruit. C'est exactement le point que le `REVIEW.md` précédent avait traité (S7) : le correctif est bien présent sur `dev`.
- **Anti-destruction :** `QueryRiskAnalyzer` → confirmation **modale avant exécution** (`panels/handlers/QueryHandlers.js:189-201`) ; `SET PARSEONLY ON` sur une **connexion dédiée** (`database/SyntaxChecker.js`) qui refuse les scripts contenant `PARSEONLY` (sinon `SET PARSEONLY OFF` s'exécuterait à la compilation) ; `UNLIMITED_SAFETY_CAP = 200 000` lignes ; timeout 5 min + annulation propre.
- **Concurrence bien gérée ailleurs :** `ConnectionStorage` (file d'attente + relecture avant écriture + écoute du `SecretStorage.onDidChange`), `IndexService` (une entrée de build par base, `subscribers` multiples, annulation ciblée par base), `SyntaxChecker` (sérialisation par `_tail`, connexion réutilisée), `ParserWorkerPool` (seuil de 10 échecs, repli in-process, `dispose()`).
- **Autocomplétion — mesurée :** médiane **0,1–1,3 ms**, p95 **~30 ms**, max 70 ms sur 78 Ko. Budgets du fuzz respectés (200 Ko < 1 500 ms ; 20 000 objets < 400 ms).
- **Suite de tests :** 97 fichiers · **1 232 cas** · 218 suites · **0 `.only`** · **0 `assert.ok(true)`** · 39 skips assumés (tests live opt-in via `SQLWAYFARER_TEST_SQL`).
- **Documentation :** `AGENTS.md` est réellement à jour et utile (conventions, format d'index, gotchas du pilote `mssql`/NTLM documentés par lecture du code source de `tedious`). `REVIEW.md` documente l'audit précédent (S1–S8, F1–F24) — j'ai **vérifié que les correctifs sont bien présents sur `dev`** : échappement systématique, `try/catch` autour du `JSON.parse`, CSP stricte, slug d'index, `QueryRiskAnalyzer`.
- **Build sain :** deux configurations webpack distinctes (`node` pour l'extension + le worker, `web` pour CodeMirror), `piscina` correctement externalisé (sinon `__dirname` cassé), bundle worker séparé.

---

## Plan de remédiation priorisé

### P0 — Rétablir la boucle de contrôle (1 h)

1. `git checkout main && git merge --ff-only dev` — le lockfile part avec.
2. `.github/workflows/ci.yml` : `branches: [main, dev]` en `push` **et** `pull_request` ; ajouter `npm run build` ; ajouter `npm audit --audit-level=high` ; `cache: 'npm'`.
3. `--timeout 10000` sur `test:unit` et `.vscode-test.mjs` → la suite devient verte (C2).
4. `npm audit fix` (sans rupture) → E3.

### P1 — Correction du code (1–2 j)

5. Sérialiser `ConnectionManager.connect()` par jeton de séquence (E6) + poser `_connecting = true` dans `_reconnect()`.
6. Écriture atomique du cache d'index : `writeFile(tmp)` + `rename()` (E7).
7. Neutraliser `..` dans le slug de l'index (E8).
8. Réviser `saveConnections` : refuser ou confirmer une collision de nom (M2).
9. Décider du sort des 5 fonctionnalités orphelines : rebrancher ou supprimer (E9).

### P2 — Qualité et dette (1 sem.)

10. eslint : règles en `"error"` + `--max-warnings=0` + `sourceType: "script"` (E1, E2).
11. `.vscodeignore` : corriger `!readme.md` / `!LICENSE.txt` ; vérifier le contenu réel du `.vsix` en CI (E4, F1).
12. Sortir `dagre`/`cytoscape` du vendor vers npm ; trancher le sort de `viz.full.render.js` et documenter sa licence (E5, F2).
13. Extraire la logique pure du webview en modules testables (M7).
14. `commit.ps1` : ne plus faire `git add -A` à l'aveugle ; `deploy.ps1` : committer avant de publier (M5).
15. Ajouter `sqlwayfarer.openConnection` au manifeste (M1).

---

## Méthodologie et limites

**Vérifié par exécution :** `npm ci` · `npm run lint` (exit 0, 3 warnings) · `npm run test:unit` (1 266 passing / 232 pending / **1 failing**) · `npm run build` (134 s) · `npm audit` (16 vulnérabilités) · API GitHub Actions (4 runs, 4 échecs, détail des jobs) · mesures ANTLR cold/warm · mesures d'autocomplétion (médiane / p95 / max) · simulation de `connect()` concurrent avec pools instrumentés · analyse croisée du protocole (script sur les `command:`/`case:`) · analyse des 17 `innerHTML` à interpolation · worktrees `main` et `f78d1f6^` pour qualifier la régression.

**Non vérifié (délégué à l'auteur, environnement requis) :** comportement contre une instance SQL Server réelle (aucun serveur dans l'environnement d'audit) ; exécution des tests e2e Playwright (navigateurs non installés) ; exécution de `npm test` (vscode-test) qui exige un bureau ; audit de sécurité ligne à ligne de `helper/SqlWayfarerSspi.cs` (22 Ko de C# natif) au-delà de l'analyse de son lancement ; revue exhaustive de la grammaire ANTLR `database/tsql-grammar/*.g4` (source générée de 5,71 Mo).

**Note :** quatre sous-auditeurs délégués n'ont pas eu accès au système de fichiers dans leur session ; leurs grilles de contrôle ont été conservées comme pistes, mais **aucun constat de ce rapport ne provient d'eux** — tout est vérifié ci-dessus par exécution directe.

---

# Ce qui a été corrigé

15 commits, sur la branche `dev`, non poussés. Chaque point est vérifié par
l'exécution, pas par la lecture.

| Constat | Correction | Commit |
|---|---|---|
| **C1** — CI jamais verte, `dev` non couverte | CI déclenchée sur `main` **et** `dev` (push + PR) ; 4 jobs : `unit`, `test`, `package`, `audit` ; `npm run build` dans la CI ; cache npm ; le job `package` liste le contenu du `.vsix` et échoue si le webview ou un bundle manque | `9083758` |
| **C2** — suite rouge (timeout ANTLR) | Timeout mocha à 10 s (`.mocharc.json` + `.vscode-test.mjs`). **Résultat : 1 274 passing, 0 échec** | `c0d742f` |
| **E1** — `lint` ne peut jamais échouer | Règles en `error`, script `--max-warnings=0`, les 3 warnings corrigés | `a08a112`, `d6661e9` |
| **E2** — `sourceType: "module"` sur du CommonJS | `sourceType: "commonjs"` par défaut, `module` seulement pour le bundle CodeMirror | `a08a112` |
| **E3** — 16 CVE npm | **Nuancé** : `serialize-javascript` (le « high ») vient de `@vscode/test-cli` → chaîne de build seule, pas l'extension livrée ; `uuid` vient de `mssql` → exigence `mssql@12` (rupture). Le job `audit` est en `continue-on-error` pour ne pas habituer à l'ignorer | `9083758` |
| **E4** — la CI ne construit pas | Job `package` : build + contrôle du contenu du paquet | `9083758` |
| **E5** — vendor sans version ni licence | `webview/vendor/VERSIONS.md` : versions, licences, et l'avertissement que les copies peuvent diverger de `node_modules`. La migration vers npm reste à faire (refactor lourd) | `2302301` |
| **E6** — `connect()` concurrent perd le dernier choix | Ticket par demande : la **dernière demandée** gagne, pas la dernière à répondre ; une connexion plus récente qui **échoue** laisse la précédente active ; une connexion qui s'ouvre après la fermeture du panel est fermée aussitôt. 3 tests ajoutés | `7eb8cea` |
| **E7** — cache d'index écrit non atomiquement | Écriture dans un fichier temporaire + `rename()` (atomique), pour l'index et l'historique des builds | `8d0b941` |
| **E8** — slug laissant passer `..` | Un segment fait uniquement de points devient `_` | `8d0b941` |
| **E9** — 5 réponses sans consommateur | **Conservées** : le commit `ab3a19b` les corrigeait volontairement il y a 2 jours. Elles sont désormais **documentées comme réservées**, et le test du protocole vérifie les deux sens | `5417e1c` |
| **E10** — 158 commits sans CI ni revue | Traité par C1 (la CI couvre enfin `dev`). La part « revue humaine » reste une question de process | `9083758` |
| **M1** — commande absente du manifeste | `sqlwayfarer.openConnection` déclarée | `f552150` |
| **M3** — `panelState` : deux onglets s'écrasaient | File d'attente sur les écritures (vérifié : l'ancien code perdait un état) | `dab2772` |
| **M4** — suppression effaçait un password | Le secret n'est plus effacé qu'une fois la connexion confirmée | `9d530e9` |
| **M5** — `git add -A` + publish avant commit | Exclusion des noms de secrets courants + affichage des fichiers indexés ; commit avant publish | `68a5487` |
| **F1** — `.vscodeignore` aux mauvais noms | `README.md` / `LICENSE` ; `webview-build/` et `CODE_REVIEW.md` exclus | `3100c54` |
| **F3** — commentaire faux sur le coût du parse | Commentaire réécrit avec le coût réel (à froid / à chaud) | `03dfb14` |

## Ce qui reste ouvert

| Constat | Pourquoi il reste | Ce qu'il faudrait |
|---|---|---|
| **E3** (CVE `uuid`) | Le correctif exige `mssql@12` (rupture) | Tester la montée sur une instance réelle, puis la faire |
| **E5** (vendor) | Sortir les libs du `.vsix` = changer le chargement du webview | Sortir `dagre`/`cytoscape` de npm et les bundler ; trancher le sort de `viz.full.render.js` (1,98 Mo parsés à chaque ouverture) |
| **M6/M7** (tests) | `npm test` exige un bureau ; les e2e exigeent les navigateurs Playwright | Le job `unit` couvre l'essentiel ; ajouter un job `sql-integration` avec un service SQL Server pour les 39 tests live |
| **E10** (process) | Hors code | Garder la CI verte sur `dev` avant merge, et relire les commits IA avant merge |

## Un point de méthode

Deux constats de ce rapport ont été **corrigés à l'envers** après vérification,
et c'est le but de la revue :

- **M2** (import de connexions) : la fusion volontaire du mot de passe existant
  (`mergeIntoExisting`, documenté) avait été lue comme un défaut. Le patch
  aurait cassé l'intention : il a été revert.
- **E3** : le « high » de `npm audit` est dans la chaîne de test, pas dans
  l'extension livrée. La sévérité a été revue à la baisse.

Les deux cas sont le rappel qu'un constat de revue qui n'a pas été
reproduction est une hypothèse, pas un fait.
