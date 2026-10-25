# Évaluation : remplacer le `<textarea>` de l'éditeur de requêtes

**Contexte :** la demande initiale était la sélection rectangulaire (Alt+glisser, comme SSMS) dans
l'éditeur de requêtes. Un `<textarea>` HTML natif ne peut pas faire ça — ni multi-curseur, ni
sélection en bloc. La seule voie réaliste est de remplacer le `<textarea>` actuel (avec son overlay
de coloration `sqlHighlight.js`) par un vrai composant éditeur. Deux candidats évalués : **Monaco**
(le composant de VS Code) et **CodeMirror 6**.

**Verdict : CodeMirror 6 est clairement le meilleur choix pour ce cas d'usage précis.** Monaco reste
faisable mais apporte un coût (taille, CSP, workers) disproportionné par rapport au besoin — un
éditeur SQL dans un panneau de webview, pas un IDE complet.

---

## 1. Monaco Editor

### Coût en taille

| | Taille |
|---|---|
| Package npm `monaco-editor` complet (`dev` + `min` + `min-maps`) | ~97 Mo |
| Distribution utile (`min/vs`) | ~15 Mo |
| Bundle webpack minifié (éditeur + langage SQL seul) | 1,5 – 6 Mo |
| `webview/vendor/` actuel (viz.js, cytoscape, dagre) | 3,5 Mo au total |

Même optimisé au minimum, Monaco multiplierait la taille du webview par 2 à 4.

### Coût CSP

Le point le plus sensible : la CSP du projet vient d'être volontairement verrouillée
(`default-src 'none'`, aucun `unsafe-inline` sur `script-src`, cf. `REVIEW.md` / fixes F1-S5).

- Monaco a besoin de **`worker-src blob:`** pour ses web workers — une vraie relâche, même si plus
  étroite qu'un `unsafe-inline` global.
- Même avec ça, les workers échouent généralement dans un webview VS Code : la page vit sur l'origine
  `vscode-webview://` alors que les fichiers vendorés sont servis depuis une origine CDN différente,
  et un worker doit être **same-origin** avec la page qui le démarre. Monaco bascule alors
  silencieusement les services de langage sur le thread principal (dégradé mais fonctionnel).
- La coloration syntaxique de base n'est pas impactée (tokenizer Monarch, thread principal).

### Coût d'intégration

Remplacement complet du `<textarea>` : suppression de `sqlHighlight.js`, portage de
`sqlAutocomplete.js` vers `registerCompletionItemProvider`, migration de tous les accès
`textarea.value`/`selectionStart`/`setSelectionRange` (`queryManager.js`, `queryFileManager.js`,
`snippetManager.js`) vers l'API Monaco, appel explicite à `editor.layout()` au resize, et
synchronisation manuelle du thème (Monaco ne suit pas les variables `--vscode-*`).

---

## 2. CodeMirror 6

### Coût en taille

CodeMirror 6 est modulaire et tree-shakeable : **~50 Ko pour le cœur**, et environ **~150 Ko gzippé**
avec le module SQL (`@codemirror/lang-sql`) et l'autocomplétion. À comparer aux 5-10 Mo (+ workers) de
Monaco. Ça reste dans l'ordre de grandeur de ce que le projet vendorise déjà (viz.js, cytoscape).

### Coût CSP — point décisif

**CodeMirror 6 ne nécessite aucun web worker.** Tout tourne sur le thread principal. Ça élimine
complètement le problème `worker-src blob:` / cross-origin qui complique Monaco dans un webview VS
Code — la CSP actuelle (`default-src 'none'`, pas d'`unsafe-inline` sur script-src) n'a besoin
d'aucune relâche supplémentaire pour CodeMirror.

### La fonctionnalité demandée existe déjà, prête à l'emploi

`@codemirror/view` fournit une extension **`rectangularSelection`** : Alt+glisser (configurable, y
compris pour matcher exactement le binding VS Code `Alt+Shift+glisser`) sélectionne un bloc
rectangulaire, une plage de sélection par ligne — exactement le besoin initial, sans rien construire
à la main. Une extension compagnon `crosshairCursor` change le curseur en croix pendant le Alt pour
indiquer visuellement le mode. Le multi-curseur (Alt+clic) est natif aussi.

### Autocomplétion SQL

`@codemirror/lang-sql` expose un dialecte SQL avec mots-clés adaptés, et surtout
**`schemaCompletionSource`** : on lui donne l'arbre de schéma (tables/colonnes) et il génère
l'autocomplétion `table.colonne` automatiquement. C'est conceptuellement très proche de ce que fait
déjà `sqlAutocomplete.js` à la main (résolution d'objets/colonnes, cross-database) — probablement
récupérable en grande partie en alimentant `schemaCompletionSource` avec les données déjà
disponibles (index des objets, colonnes), plutôt qu'en réécrivant toute la logique de résolution.

### Coût d'intégration

Même ampleur que pour Monaco sur un point : il faut migrer tous les accès directs
`textarea.value`/`selectionStart`/`setSelectionRange` vers l'API CodeMirror (`EditorState`,
`EditorView`, transactions `dispatch`). Mais :
- pas de thème à synchroniser à la main dans la même mesure — CodeMirror expose un système de thème
  basé sur des styles CSS/objets JS plus simple à mapper sur les variables `--vscode-*` existantes ;
- pas de `editor.layout()` à gérer explicitement de la même façon (CodeMirror suit la taille de son
  conteneur DOM nativement) ;
- l'autocomplétion peut probablement réutiliser la logique métier existante plutôt que tout réécrire.

---

## 3. Comparaison directe

| | Monaco | CodeMirror 6 |
|---|---|---|
| Taille ajoutée | 1,5 – 6 Mo (minifié) | ~150 Ko (gzippé) |
| Web workers requis | Oui (dégrade en fallback dans un webview) | Non |
| Relâche CSP nécessaire | `worker-src blob:` | Aucune |
| Sélection rectangulaire | À router soi-même via l'API Monaco | Extension native (`rectangularSelection`) |
| Autocomplétion SQL schéma-aware | À construire sur `registerCompletionItemProvider` | `schemaCompletionSource` fourni par `@codemirror/lang-sql` |
| Synchronisation thème VS Code | Manuelle, système de thème propre à Monaco | Plus simple à mapper sur les variables CSS existantes |
| Fidélité à l'expérience SSMS/VS Code | Maximale (c'est littéralement l'éditeur de VS Code) | Très bonne, mais pas pixel-perfect avec VS Code |

## Recommandation

**CodeMirror 6**, sans ambiguïté, pour ce projet : la fonctionnalité demandée au départ (sélection
rectangulaire) existe déjà sous forme d'extension prête à l'emploi, l'empreinte reste cohérente avec
le reste du `webview/vendor/`, et surtout **aucune concession sur la CSP** qui vient d'être
durcie. Le seul vrai travail reste la migration des accès `textarea` → API de l'éditeur dans
`queryManager.js` / `queryFileManager.js` / `snippetManager.js`, qui est incompressible quel que soit
le choix (Monaco ou CodeMirror).

Monaco ne se justifierait que si l'objectif dépassait le SQL — par exemple vouloir un jour éditer du
JSON/XML/autre langage avec la richesse exacte de VS Code (validation sémantique, LSP complet). Pour
un éditeur de requêtes SQL dans un panneau, ce n'est pas le bon rapport coût/bénéfice ici.

### Sources consultées

**Monaco :**
- [Monaco workers fall back to the main thread in a VS Code extension webview](https://github.com/mohsinonxrm/pptb-mxrm-dataverse-request-studio/issues/255)
- [Monaco's web workers can't start in a VS Code extension](https://github.com/mohsinonxrm/pptb-mxrm-commandbar-studio/issues/125)
- [Monaco editor web worker blocked by CSP](https://github.com/armaxri/termiHub/issues/3632)
- [Monaco editor inline styling violates CSP](https://github.com/microsoft/monaco-editor/issues/4927)
- [Reducing the size of the monaco-editor dependency](https://lightrun.com/answers/microsoft-monaco-editor-reducing-size-of-monaco-editor-dependency)
- [monaco-editor 0.55 bundle larger than 6MB](https://github.com/Microsoft/monaco-editor/issues/5154)
- [monaco-editor — npm](https://www.npmjs.com/package/monaco-editor)

**CodeMirror 6 :**
- [Monaco Editor vs CodeMirror 6 vs Sandpack 2026 — PkgPulse Guides](https://www.pkgpulse.com/guides/monaco-editor-vs-codemirror-6-vs-sandpack-in-browser-2026)
- [CodeMirror vs Monaco Editor: A Comprehensive Comparison](https://agenthicks.com/research/codemirror-vs-monaco-editor-comparison)
- [QoreDB's SQL editor: CodeMirror, autocompletion and deliberate choices](https://www.qoredb.com/en/blog/sql-editor-codemirror-autocompletion-deliberate-choices)
- [schemaCompletionSource example - discuss.CodeMirror](https://discuss.codemirror.net/t/schemacompletionsource-example/5196)
- [SQL Autocomplete additions - discuss.CodeMirror](https://discuss.codemirror.net/t/sql-autocomplete-additions/9115)
- [codemirror/lang-sql](https://code.haverbeke.berlin/codemirror/lang-sql)
- [Minimal setup (v6 is +50kb) - discuss.CodeMirror](https://discuss.codemirror.net/t/minimal-setup-because-by-default-v6-is-50kb-compared-to-v5/4514)
- [CodeMirror 6 beta: alt+drag rectangular selection missing (Joplin issue)](https://github.com/laurent22/joplin/issues/9196)
- [Add default `alt` binding for multi cursor selection](https://github.com/codemirror/dev/issues/765)
- [CodeMirror Reference Manual](https://codemirror.net/docs/ref/)
