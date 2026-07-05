'use strict';

// Dev-only tool: prints the pruned ANTLR parse tree of a T-SQL script next to
// the analyzeOperations() result, to harden the parser on edge cases
// (CTEs, dynamic SQL, MERGE, nested subqueries) before building column lineage.
//
// Usage:
//   node scripts/print-ast.js path/to/file.sql
//   node scripts/print-ast.js --sql "WITH x AS (SELECT 1 AS a) SELECT a FROM x"
//   node scripts/print-ast.js --sql "..." --full        (no chain collapsing)
//   node scripts/print-ast.js --sql "..." --max-depth 8

const fs = require('fs');
const antlr4 = require('antlr4');
const TSqlLexer = require('../database/generated/TSqlLexer');
const TSqlParser = require('../database/generated/TSqlParser');
const BabelfishSqlParser = require('../database/BabelfishSqlParser');

function parseArgs(argv) {
    const opts = { sql: null, file: null, full: false, maxDepth: Infinity };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--sql') opts.sql = argv[++i];
        else if (arg === '--full') opts.full = true;
        else if (arg === '--max-depth') opts.maxDepth = Number(argv[++i]);
        else opts.file = arg;
    }
    return opts;
}

function truncate(text, len = 60) {
    const clean = text.replace(/\s+/g, ' ');
    return clean.length > len ? clean.slice(0, len - 1) + '…' : clean;
}

// Single-child rule chains (expression > unary_op > primary > …) dominate the
// raw tree; collapse them into one "a > b > c" line so structure stays visible.
function collapseChain(node) {
    const names = [];
    let current = node;
    while (current.ruleIndex !== undefined && current.getChildCount() === 1
        && current.getChild(0).ruleIndex !== undefined) {
        names.push(TSqlParser.ruleNames[current.ruleIndex]);
        current = current.getChild(0);
    }
    if (current.ruleIndex !== undefined) names.push(TSqlParser.ruleNames[current.ruleIndex]);
    return { names, node: current };
}

function printTree(node, opts, prefix = '', isLast = true, depth = 0) {
    const connector = prefix === '' ? '' : (isLast ? '└─ ' : '├─ ');

    // Terminal token
    if (node.symbol !== undefined) {
        console.log(`${prefix}${connector}"${truncate(node.getText(), 30)}"`);
        return;
    }

    let label;
    let target = node;
    if (opts.full) {
        label = TSqlParser.ruleNames[node.ruleIndex];
    } else {
        const chain = collapseChain(node);
        label = chain.names.join(' > ');
        target = chain.node;
    }

    console.log(`${prefix}${connector}${label}  «${truncate(target.getText())}»`);

    if (depth >= opts.maxDepth) return;

    const childPrefix = prefix + (prefix === '' ? '' : (isLast ? '   ' : '│  '));
    const count = target.getChildCount();
    for (let i = 0; i < count; i++) {
        const child = target.getChild(i);
        // Skip pure punctuation/keyword terminals at depth > 0 to reduce noise
        if (!opts.full && child.symbol !== undefined && /^[A-Z_]+$|^[(),.;]$/.test(child.getText())) continue;
        printTree(child, opts, childPrefix, i === count - 1, depth + 1);
    }
}

function main() {
    const opts = parseArgs(process.argv);
    let sql = opts.sql;
    if (!sql && opts.file) sql = fs.readFileSync(opts.file, 'utf8');
    if (!sql) {
        console.error('Usage: node scripts/print-ast.js <file.sql> | --sql "SELECT ..." [--full] [--max-depth N]');
        process.exit(1);
    }

    const chars = new antlr4.InputStream(sql);
    const lexer = new TSqlLexer(chars);
    lexer.removeErrorListeners();
    const tokens = new antlr4.CommonTokenStream(lexer);
    const parser = new TSqlParser(tokens);

    // Collect syntax errors instead of spamming stderr mid-tree
    const errors = [];
    parser.removeErrorListeners();
    parser.addErrorListener({
        syntaxError: (recognizer, offendingSymbol, line, column, msg) => {
            errors.push(`line ${line}:${column} ${msg}`);
        },
        reportAmbiguity: () => { },
        reportAttemptingFullContext: () => { },
        reportContextSensitivity: () => { }
    });

    const tree = parser.tsql_file();

    console.log('=== Parse tree (pruned) ===\n');
    printTree(tree, opts);

    if (errors.length) {
        console.log('\n=== Syntax errors ===\n');
        errors.forEach(e => console.log('  ' + e));
    }

    const analyzer = new BabelfishSqlParser();
    analyzer.setEnabled(true);
    console.log('\n=== analyzeOperations ===\n');
    console.log(JSON.stringify(analyzer.analyzeOperations(sql), null, 2));
    console.log('\n=== analyzeColumns ===\n');
    console.log(JSON.stringify(analyzer.analyzeColumns(sql), null, 2));
}

main();
