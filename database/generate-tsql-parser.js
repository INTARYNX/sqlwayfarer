#!/usr/bin/env node
/**
 * Generates the JS sources of the T-SQL parser from the Babelfish grammar.
 *
 * Usage:  node database/generate-tsql-parser.js
 *
 * Prerequisites:
 *   - Java (to run antlr.jar)
 *   - antlr.jar present in database/tsql-grammar/
 *
 * Output:
 *   - database/generated/TSqlLexer.js
 *   - database/generated/TSqlParser.js
 *   - database/generated/TSqlParserListener.js
 *   - database/generated/TSqlParserVisitor.js
 *     (patched to CommonJS + removal of the "extern bool" artifact)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname);
const GRAMMAR_DIR = path.join(ROOT, 'tsql-grammar');
const OUTPUT_DIR = path.join(ROOT, 'generated');
const ANTLR_JAR = path.join(GRAMMAR_DIR, 'antlr.jar');

function run(cmd, cwd) {
    console.log(`> ${cmd}`);
    execSync(cmd, { cwd, stdio: 'inherit' });
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function patchToCommonJS(filePath) {
    let content = fs.readFileSync(filePath, 'utf8');

    // The Babelfish grammar carries a Postgres-ism: the lexer predicates
    // {pltsql_quoted_identifier == true}? decide whether a double-quoted
    // name is an identifier or a string literal. The C++ "extern" declaration
    // is an artifact of that grammar and has no meaning here - but the
    // predicates themselves still reference it, and an undefined reference
    // crashes the lexer on the first double-quoted identifier.
    // SQL Server runs with QUOTED_IDENTIFIER ON by default: a double-quoted
    // name is an identifier.
    content = content.replace(
        /\n\s*extern bool pltsql_quoted_identifier;\s*\n/,
        '\n// patched: pltsql_quoted_identifier (Babelfish grammar C++ artifact) ->\n'
        + '// SQL Server runs with QUOTED_IDENTIFIER ON: a double-quoted name is an identifier.\n'
        + 'const pltsql_quoted_identifier = true;\n'
    );

    // Patch antlr4.{atn,dfa,tree,error}.* references — runtime exposes classes at top level, not nested
    content = content.replace(/antlr4\.(atn|dfa|tree|error)\./g, 'antlr4.');

    // Convert all ESM "import" to CommonJS "require"
    content = content.replace(
        /^import (.+) from ['"](.+)['"];?$/gm,
        "const $1 = require('$2');"
    );

    // Strip ESM "export default" keyword while keeping the class declaration
    content = content.replace(
        /^export default class /gm,
        'class '
    );

    // Convert ESM "export class X" to CommonJS
    content = content.replace(
        /^export class (\w+)/gm,
        'module.exports.$1 = class $1'
    );

    // Append module.exports = ClassName at the end (for default export)
    const defaultClassMatch = content.match(/^class (\w+) extends /m);
    if (defaultClassMatch) {
        const className = defaultClassMatch[1];
        content += `\nmodule.exports = ${className};\n`;
    }

    fs.writeFileSync(filePath, content, 'utf8');
}

function main() {
    if (!fs.existsSync(ANTLR_JAR)) {
        console.error(`ANTLR jar not found: ${ANTLR_JAR}`);
        console.error('Download it from https://www.antlr.org/download/antlr-4.13.2-complete.jar');
        process.exit(1);
    }

    ensureDir(OUTPUT_DIR);

    // Clean previous generated files
    for (const f of fs.readdirSync(OUTPUT_DIR)) {
        if (f.startsWith('TSql') && f.endsWith('.js')) {
            fs.unlinkSync(path.join(OUTPUT_DIR, f));
        }
    }

    // Generate JS sources via ANTLR
    run(`java -jar "${ANTLR_JAR}" -Dlanguage=JavaScript -lib "${GRAMMAR_DIR}" -o "${OUTPUT_DIR}" -visitor "${path.join(GRAMMAR_DIR, 'TSqlLexer.g4')}" "${path.join(GRAMMAR_DIR, 'TSqlParser.g4')}"`, GRAMMAR_DIR);

    // Patch files to CommonJS
    const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.startsWith('TSql') && f.endsWith('.js'));
    for (const f of files) {
        const fp = path.join(OUTPUT_DIR, f);
        patchToCommonJS(fp);
        console.log(`Patched: ${f}`);
    }

    console.log(`\n✓ Generated ${files.length} files in ${OUTPUT_DIR}`);
}

main();