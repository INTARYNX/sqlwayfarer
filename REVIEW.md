# Review sécurité & fonctionnelle — SQL Wayfarer

**Commit audité :** `e17ce00` (Release v0.11.3) — branche `main`
**Date :** 2026-10-25
**Périmètre :** `extension.js`, `database/`, `panels/`, `storage/`, `webview/`, `scripts/`, config de build
**Hors périmètre :** `database/generated/` (parser ANTLR T-SQL généré), `node_modules/`

**Statut :** tous les points relevés (S1–S8, F1–F24) ont été corrigés et vérifiés — suite de tests
(210 tests, tous verts) et exécution du code réel contre une instance SQL Server locale pour les
correctifs d'injection et de requêtes (S1, S4, F4, F16). Deux ajustements notables faits pendant la
correction :
- **F16** : le premier correctif (deux `STRING_AGG(...) WITHIN GROUP` à tris différents dans le même
  scope) est rejeté par SQL Server (« mutually incompatible orderings ») — corrigé en triant les deux
  agrégats sur `index_column_id`, qui donne le même ordre que `key_ordinal` pour les colonnes de clé.
- **F4** : non reproductible en pratique — SQL Server interdit qu'un trigger DML ait un schéma
  différent de celui de sa table (vérifié à la création et via `ALTER SCHEMA TRANSFER`, rejetés dans
  les deux cas). Le correctif défensif reste en place mais ne change aucun comportement réel.
- **F2**, repéré en relisant la liste après la première passe (noms d'objets avec point ou `]` non
  qualifié mal découpés par `parseObjectName`), a été corrigé dans la même passe.

---

## Points positifs

Ces points sont corrects et méritent d'être conservés explicitement :

- **Mots de passe dans le SecretStorage de VS Code** (`storage/ConnectionStorage.js`), jamais en
  clair dans les settings ni dans `globalState` ; le stockage de la config de connexion ne contient
  pas le secret.
- **CSP correcte et serrée** : `default-src 'none'`, aucune source distante, aucun script inline,
  aucune requête réseau (`connect-src` tombe sur `default-src 'none'`).
- **Aucune ressource externe** : pas de CDN, pas de police distante, pas de télémétrie
  (`grep` sur `webview/index.html` : aucune URL absolue).
- **`localResourceRoots` restreint** à `extensionUri`.
- **Cache d'index correctement protégé contre la traversée de chemin** : le `slug` supprime `/` et `\`,
  et le nom de fichier est un seul composant (`database/IndexServices.js`).
- **Requêtes à paramètres** partout où c'est possible (`@pattern`, `@descValue`, …).
- **Garde-fou d'exécution destructive** (`QueryRiskAnalyzer`) et annulation/timeout propres
  (`QUERY_TIMEOUT_MS`, `request.cancel()`, nettoyage dans un `finally`).
- **Plan d'exécution XML assaini** avant envoi au webview (`sanitizePlanXml`).

### Vérifications au niveau du pilote (SQL Server / mssql)

Deux points de conception ont été validés en lisant le pilote plutôt que devinés :

- **Le préfixe `USE [db];` ne décale pas les jeux de résultats.** Dans `mssql` v10 / `tedious` 16
  (`node_modules/mssql/lib/tedious/request.js:529`), un jeu de résultats n'est ajouté à `recordsets`
  que si le serveur a envoyé des métadonnées de colonnes ; `USE` n'en envoie pas. `recordsets[0]` est
  donc bien le DMV et `recordsets[1]` la définition, exactement comme le suppose
  `database/IndexServices.js:422`. Si cette hypothèse était fausse, toute la lignée de colonnes
  serait vide — elle est donc correcte.
- **Le `0` supplémentaire dans `rowsAffected`** (le DONE token de `USE` porte un rowCount de 0) est
  sans effet : le webview somme les valeurs (`webview/queryManager.js:355`).
