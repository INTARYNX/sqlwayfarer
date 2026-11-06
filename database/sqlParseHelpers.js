'use strict';

// === Reading a T-SQL parse tree ===
//
// What the visitors of the parser have in common: the names of tables as they
// are written, the aliases of a statement, and the tables behind a derived table
// or a CTE.

const TSqlParser = require('./generated/TSqlParser');

// Keeps the schema (and the database) when the SQL makes it explicit, so that
// e.g. dbo.Orders and sales.Orders do not end up under the same "orders" key.
function extractFromFullObjectName(fonCtx) {
    if (!fonCtx || !fonCtx.object_name) return null;
    const parts = [fonCtx.database, fonCtx.schema, fonCtx.object_name]
        .filter(Boolean)
        .map(idCtx => idCtx.getText());
    return parts.join('.');
}

function extractFromDdlObject(ddlCtx) {
    if (!ddlCtx) return null;
    const fon = ddlCtx.full_object_name ? ddlCtx.full_object_name() : null;
    if (fon) return extractFromFullObjectName(fon);
    return null;
}

// Common normalization of the table keys: brackets removed + lower-cased,
// aligned with the DependencyService lookup. Used by both visitors.
function cleanTableKey(name) {
    return name
        // The delimiters of a delimited identifier ("dbo"."Users", [dbo].[Users])
        // are not part of the name: the index keys are the bare names.
        .replace(/"([^"]*)"/g, '$1')
        .replace(/\[|\]/g, '')
        .toLowerCase();
}

// Generated accessors return an array when the rule can repeat - normalize
function firstCtx(ctxOrArray) {
    return Array.isArray(ctxOrArray) ? (ctxOrArray[0] || null) : ctxOrArray;
}

function findFirstRule(node, ruleIndex) {
    if (!node || node.symbol !== undefined) return null;
    if (node.ruleIndex === ruleIndex) return node;
    const count = node.getChildCount();
    for (let i = 0; i < count; i++) {
        const found = findFirstRule(node.getChild(i), ruleIndex);
        if (found) return found;
    }
    return null;
}

// Every node of a given rule under a subtree, in document order.
function findAllRule(node, ruleIndex, out = []) {
    if (!node || node.symbol !== undefined) return out;
    if (node.ruleIndex === ruleIndex) out.push(node);
    const count = node.getChildCount();
    for (let i = 0; i < count; i++) findAllRule(node.getChild(i), ruleIndex, out);
    return out;
}

// alias -> real table name pairs from the leaf table_source_item nodes of a
// FROM clause, so aliased UPDATE/DELETE targets resolve to the real table.
function collectTableAliases(tableSources, out = new Map()) {
    if (!tableSources) return out;
    const items = tableSources.table_source_item ? tableSources.table_source_item() : [];
    for (const item of items) collectAliasesFromItem(item, out);
    return out;
}

function collectAliasesFromItem(item, out) {
    if (!item) return;
    const nested = item.table_source_item ? item.table_source_item() : [];
    if (nested && nested.length > 0) {
        for (const child of nested) collectAliasesFromItem(child, out);
        return;
    }
    const fon = firstCtx(item.full_object_name ? item.full_object_name() : null);
    const aliasCtx = firstCtx(item.as_table_alias ? item.as_table_alias() : null);
    if (!fon || !aliasCtx) return;
    const aliasNode = findFirstRule(aliasCtx, TSqlParser.RULE_table_alias);
    if (aliasNode) out.set(cleanTableKey(aliasNode.getText()), extractFromFullObjectName(fon));
}

// Sentinel for aliases that point at a derived table (subquery) instead of a
// physical table: qualified refs through them are not physical columns.
const DERIVED = Symbol('derived-table');

// Collects the tables and aliases of a statement. The leaf table_source_item
// nodes carry the reliable table/alias pairing: a joined source is ONE
// flattened ctx with nested table_source_item children, and only the leaves
// are actual sources. Shared by the column lineage and the join graph.
function collectStatementScope(node, scope, ctes) {
    if (!node || node.symbol !== undefined) return;

    if (node.ruleIndex === TSqlParser.RULE_table_source_item) {
        const nested = node.table_source_item ? node.table_source_item() : [];
        const isLeaf = !nested || nested.length === 0;
        if (isLeaf) {
            const fon = firstCtx(node.full_object_name ? node.full_object_name() : null);
            const aliasCtx = firstCtx(node.as_table_alias ? node.as_table_alias() : null);
            const table = fon ? cleanTableKey(fon.getText()) : DERIVED;
            if (fon) scope.tables.add(table);
            if (aliasCtx) {
                const aliasNode = findFirstRule(aliasCtx, TSqlParser.RULE_table_alias);
                if (aliasNode) scope.aliases.set(cleanTableKey(aliasNode.getText()), table);
            }
        }
    } else if (node.ruleIndex === TSqlParser.RULE_common_table_expression) {
        const idNode = findFirstRule(node, TSqlParser.RULE_id);
        if (idNode) ctes.add(cleanTableKey(idNode.getText()));
    }

    const count = node.getChildCount();
    for (let i = 0; i < count; i++) collectStatementScope(node.getChild(i), scope, ctes);
}

// The physical tables of a statement body (a derived table or a CTE body).
function statementTables(node, ctes) {
    const scope = { aliases: new Map(), tables: new Set(), derived: new Map() };
    collectStatementScope(node, scope, ctes);
    return [...scope.tables].filter(t => t !== DERIVED && !ctes.has(t));
}

// Collects the alias -> base tables mapping of the derived tables (subqueries)
// and CTEs of a statement: a source that has no name of its own is shown
// through the tables it selects from.
function collectDerivedSources(node, scope, ctes) {
    if (!node || node.symbol !== undefined) return;

    if (node.ruleIndex === TSqlParser.RULE_table_source_item) {
        const nested = node.table_source_item ? node.table_source_item() : [];
        if (!nested || nested.length === 0) {
            const aliasCtx = firstCtx(node.as_table_alias ? node.as_table_alias() : null);
            const aliasNode = aliasCtx ? findFirstRule(aliasCtx, TSqlParser.RULE_table_alias) : null;
            const alias = aliasNode ? cleanTableKey(aliasNode.getText()) : null;
            const inner = firstCtx(node.derived_table ? node.derived_table() : null)
                || firstCtx(node.subquery ? node.subquery() : null);
            if (alias && inner) {
                const innerSelect = findFirstRule(inner, TSqlParser.RULE_select_statement);
                if (innerSelect) {
                    const tables = statementTables(innerSelect, ctes);
                    if (tables.length) scope.derived.set(alias, tables);
                }
            }
        }
    } else if (node.ruleIndex === TSqlParser.RULE_common_table_expression) {
        const idNode = findFirstRule(node, TSqlParser.RULE_id);
        const name = idNode ? cleanTableKey(idNode.getText()) : null;
        const innerSelect = findFirstRule(node, TSqlParser.RULE_select_statement);
        if (name && innerSelect) {
            const tables = statementTables(innerSelect, ctes);
            if (tables.length) scope.derived.set(name, tables);
        }
    }

    const count = node.getChildCount();
    for (let i = 0; i < count; i++) collectDerivedSources(node.getChild(i), scope, ctes);
}

module.exports = {
    extractFromFullObjectName,
    extractFromDdlObject,
    cleanTableKey,
    firstCtx,
    findFirstRule,
    findAllRule,
    collectTableAliases,
    collectAliasesFromItem,
    DERIVED,
    collectStatementScope,
    statementTables,
    collectDerivedSources
};
