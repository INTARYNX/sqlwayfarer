/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Lightweight T-SQL context analysis for the autocompletion.
// Pure functions, no DOM: unit-tested on their own.
//
// Not a real parser. It tokenizes (ignoring strings and comments), cuts the
// text into batches (GO) and statements, then walks the statement under the
// caret to learn: which clause the caret is in, which sources (tables,
// aliases, CTEs, derived tables, temp tables) are visible there, and which
// column names those sources expose. It must never throw on half-typed SQL.
class SqlContext {
    // === Tokenizer ===

    // Tokens: { t: 'w' word | 'b' bracketed/quoted name | 's' string | 'n' number
    // | 'p' punctuation, v, lc, s, e }. Comments are dropped but remembered in
    // `literals` so the caller can tell "caret inside a string/comment".
    static tokenize(text) {
        const tokens = [];
        const literals = [];
        const n = text.length;
        // ASCII by char code (this runs over the whole script on every keystroke),
        // the regex only for the other letters.
        const isLetter = (c, ch) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c > 127 && /\p{L}/u.test(ch));
        const isStart = (c, ch) => isLetter(c, ch) || c === 95 || c === 64 || c === 35;
        const isPart = (c, ch) => isStart(c, ch) || c === 36 || (c >= 48 && c <= 57) || (c > 127 && /\p{N}/u.test(ch));
        let i = 0;
        while (i < n) {
            const ch = text[i];
            const code = text.charCodeAt(i);
            if (code === 32 || code === 9 || code === 10 || code === 13) { i++; continue; }

            if (ch === '-' && text[i + 1] === '-') {
                let j = text.indexOf('\n', i);
                if (j < 0) j = n;
                literals.push({ start: i, end: j, closed: false });
                i = j;
                continue;
            }
            if (ch === '/' && text[i + 1] === '*') {
                const close = text.indexOf('*/', i + 2);
                const end = close < 0 ? n : close + 2;
                literals.push({ start: i, end, closed: close >= 0 });
                i = end;
                continue;
            }
            if (ch === "'") {
                let j = i + 1;
                while (j < n) {
                    if (text[j] === "'") {
                        if (text[j + 1] === "'") { j += 2; continue; }
                        break;
                    }
                    j++;
                }
                const closed = j < n;
                const end = closed ? j + 1 : n;
                tokens.push({ t: 's', v: text.slice(i, end), lc: '', s: i, e: end });
                literals.push({ start: i, end, closed });
                i = end;
                continue;
            }
            if (ch === '[' || ch === '"') {
                const closer = ch === '[' ? ']' : '"';
                let j = i + 1;
                let inner = '';
                let closed = false;
                while (j < n && text[j] !== '\n') {
                    if (text[j] === closer) {
                        if (text[j + 1] === closer) { inner += closer; j += 2; continue; }
                        closed = true;
                        break;
                    }
                    inner += text[j];
                    j++;
                }
                const end = closed ? j + 1 : j;
                tokens.push({ t: 'b', v: inner, lc: inner.toLowerCase(), s: i, e: end, closed });
                i = end;
                continue;
            }
            if (isStart(code, ch)) {
                let j = i + 1;
                while (j < n && isPart(text.charCodeAt(j), text[j])) j++;
                const v = text.slice(i, j);
                tokens.push({ t: 'w', v, lc: v.toLowerCase(), s: i, e: j });
                i = j;
                continue;
            }
            if (code >= 48 && code <= 57) {
                let j = i + 1;
                while (j < n && (isPart(text.charCodeAt(j), text[j]) || text[j] === '.')) j++;
                tokens.push({ t: 'n', v: text.slice(i, j), lc: '', s: i, e: j });
                i = j;
                continue;
            }
            tokens.push({ t: 'p', v: ch, lc: ch, s: i, e: i + 1 });
            i++;
        }
        return { tokens, literals };
    }

    static insideLiteral(literals, caret) {
        return literals.some(l => caret > l.start && (l.closed ? caret < l.end : caret <= l.end));
    }

    // Tokenizing is the only O(text) step; every consumer of one keystroke
    // (suggestions, join context...) shares its result.
    static _lex(text) {
        const cache = SqlContext._lexCache;
        if (cache && cache.text === text) return cache;
        const lexed = SqlContext.tokenize(text);
        const result = { text, tokens: lexed.tokens, literals: lexed.literals, statements: null };
        result.statements = SqlContext._statements(text, result.tokens);
        SqlContext._lexCache = result;
        return result;
    }

    // === Statements ===

    // Cut the token list into statements: ';' and a lone GO end one; a
    // SELECT/INSERT/UPDATE/DELETE/MERGE (or a WITH <cte> AS) at nesting level 0
    // starts a new one unless the previous token says it continues the
    // current one (UNION SELECT, AS SELECT, THEN UPDATE...).
    static _statements(text, tokens) {
        const statements = [];
        let from = 0;
        let depth = 0;
        let batch = 0;
        let cteMode = false;
        let seenMain = false;
        const push = to => { if (to > from) statements.push({ from, to, batch }); };
        const reset = k => { from = k; cteMode = !!tokens[k] && tokens[k].t === 'w' && tokens[k].lc === 'with'; seenMain = false; };
        reset(0);

        for (let k = 0; k < tokens.length; k++) {
            const tok = tokens[k];
            if (tok.t === 'w' && tok.lc === 'go' && SqlContext._onOwnLine(text, tokens, k)) {
                push(k);
                batch++;
                depth = 0;
                if (tokens[k + 1] && tokens[k + 1].t === 'n') k++; // "GO 5"
                reset(k + 1);
                continue;
            }
            if (tok.t === 'p') {
                if (tok.v === '(') depth++;
                else if (tok.v === ')') depth = Math.max(0, depth - 1);
                else if (tok.v === ';' && depth === 0) {
                    push(k + 1);
                    reset(k + 1);
                }
                continue;
            }
            if (tok.t !== 'w' || depth !== 0 || k === from) continue;

            const prev = tokens[k - 1];
            const continues = prev && ((prev.t === 'w' && SqlContext.CONTINUES_AFTER.has(prev.lc))
                || (prev.t === 'p' && (prev.v === ',' || prev.v === '(')));
            if (SqlContext.STATEMENT_STARTERS.has(tok.lc)) {
                if (cteMode && !seenMain) { seenMain = true; continue; }
                if (!continues) { push(k); reset(k); seenMain = true; }
            } else if (tok.lc === 'with' && !continues && SqlContext._isCteStart(tokens, k)) {
                push(k);
                reset(k);
            }
        }
        push(tokens.length);
        return statements;
    }

    static _isCteStart(tokens, k) {
        const name = tokens[k + 1];
        const after = tokens[k + 2];
        if (!name || !(name.t === 'w' || name.t === 'b') || !after) return false;
        return (after.t === 'w' && after.lc === 'as') || (after.t === 'p' && after.v === '(');
    }

    static _onOwnLine(text, tokens, k) {
        const tok = tokens[k];
        const prev = tokens[k - 1];
        const next = tokens[k + 1];
        const before = text.slice(prev ? prev.e : 0, tok.s);
        const after = text.slice(tok.e, next ? next.s : text.length);
        const ownBefore = !prev || before.includes('\n');
        if (!ownBefore) return false;
        if (!next || after.includes('\n')) return true;
        // "GO 5": a repeat count may follow, then the end of the line.
        if (next.t !== 'n') return false;
        const afterCount = tokens[k + 2];
        return !afterCount || text.slice(next.e, afterCount.s).includes('\n');
    }

    // === Statement walker ===

    static _isName(tok) { return !!tok && (tok.t === 'w' || tok.t === 'b'); }
    static _isWord(tok, lc) { return !!tok && tok.t === 'w' && tok.lc === lc; }
    static _isPunct(tok, v) { return !!tok && tok.t === 'p' && tok.v === v; }

    // Build the scope tree of one statement (tokens[from..to)).
    static _parseStatement(tokens, from, to) {
        const match = new Map();
        const stack = [];
        for (let k = from; k < to; k++) {
            const t = tokens[k];
            if (t.t !== 'p') continue;
            if (t.v === '(') stack.push(k);
            else if (t.v === ')' && stack.length) match.set(stack.pop(), k);
        }
        for (const open of stack) match.set(open, to);
        const closeOf = open => match.get(open);

        const isSubStart = k => SqlContext._isWord(tokens[k], 'select') || SqlContext._isWord(tokens[k], 'with');
        const newBlock = startIdx => ({ startIdx, marks: [], sources: [], intoTarget: null });
        const shared = { tokens, closeOf, stmtEnd: to };
        const newScope = (parent, start, end, openIdx, parentBlock, correlated) => ({
            parent, start, end, openIdx, parentBlock, correlated, shared,
            blocks: [], ctes: [], groups: [], children: [], insertTarget: null,
            firstWord: tokens[start] && tokens[start].t === 'w' ? tokens[start].lc : ''
        });

        const walk = scope => {
            let block = newBlock(scope.start);
            scope.blocks.push(block);
            let expect = null; // 'source' | 'target' | 'into' | 'apply'
            const clauseOf = b => (b.marks.length ? b.marks[b.marks.length - 1].clause : 'start');
            const mark = (k, clause) => block.marks.push({ idx: k, clause });

            const readSource = (k, role) => {
                const t = tokens[k];
                let src = null;
                if (SqlContext._isPunct(t, '(')) {
                    const c = closeOf(k);
                    if (isSubStart(k + 1)) {
                        const child = newScope(scope, k + 1, c, k, block, role === 'apply');
                        walk(child);
                        scope.children.push(child);
                        src = { kind: 'derived', child, parts: [] };
                    } else {
                        src = { kind: 'group', parts: [] };
                    }
                    k = c < to ? c + 1 : to;
                } else {
                    const parts = [t.v];
                    let j = k + 1;
                    while (j < scope.end && SqlContext._isPunct(tokens[j], '.')) {
                        j++;
                        if (j < scope.end && SqlContext._isName(tokens[j])) { parts.push(tokens[j].v); j++; }
                        else { parts.push(''); break; }
                    }
                    k = j;
                    src = { kind: 'table', parts };
                    if (role !== 'into' && k < scope.end && SqlContext._isPunct(tokens[k], '(')) {
                        const c = closeOf(k);
                        const first = tokens[k + 1];
                        if (!(first && first.t === 'w' && SqlContext.TABLE_HINTS.has(first.lc))) src.kind = 'function';
                        k = c < to ? c + 1 : to;
                    } else if (parts[0].startsWith('#')) src.kind = 'temp';
                    else if (parts[0].startsWith('@')) src.kind = 'variable';
                }
                if (k < scope.end && SqlContext._isWord(tokens[k], 'as')) k++;
                const a = tokens[k];
                if (k < scope.end && SqlContext._isName(a) && !(a.t === 'w' && SqlContext.NOT_AN_ALIAS.has(a.lc))) {
                    src.alias = a.v;
                    src.aliasIdx = k;
                    k++;
                    if (k < scope.end && SqlContext._isPunct(tokens[k], '(') && src.kind !== 'table') {
                        const c = closeOf(k);
                        src.columnNames = SqlContext._listNames(tokens, k + 1, c);
                        k = c < to ? c + 1 : to;
                    }
                }
                if (k < scope.end && SqlContext._isWord(tokens[k], 'with') && SqlContext._isPunct(tokens[k + 1], '(')) {
                    const c = closeOf(k + 1);
                    k = c < to ? c + 1 : to;
                }
                src.endIdx = k;
                if (role === 'into') {
                    if (scope.firstWord === 'insert') scope.insertTarget = src;
                    else if (scope.firstWord === 'merge') { src.target = true; block.sources.push(src); }
                    else block.intoTarget = src;
                } else {
                    if (role === 'target') src.target = true;
                    block.sources.push(src);
                }
                return k;
            };

            const readCtes = k => {
                let j = k + 1;
                while (j < scope.end && SqlContext._isName(tokens[j])) {
                    const cte = { name: tokens[j].v, columns: null, child: null };
                    j++;
                    if (SqlContext._isPunct(tokens[j], '(')) {
                        const c = closeOf(j);
                        cte.columns = SqlContext._listNames(tokens, j + 1, c);
                        j = c < to ? c + 1 : to;
                    }
                    if (!SqlContext._isWord(tokens[j], 'as')) { scope.ctes.push(cte); break; }
                    j++;
                    if (SqlContext._isPunct(tokens[j], '(')) {
                        const c = closeOf(j);
                        if (isSubStart(j + 1)) {
                            const child = newScope(scope, j + 1, c, j, block, false);
                            walk(child);
                            scope.children.push(child);
                            cte.child = child;
                        }
                        j = c < to ? c + 1 : to;
                    }
                    scope.ctes.push(cte);
                    if (SqlContext._isPunct(tokens[j], ',')) j++;
                    else break;
                }
                return j;
            };

            let k = scope.start;
            while (k < scope.end) {
                const t = tokens[k];
                if (expect) {
                    const role = expect;
                    const startsSource = SqlContext._isPunct(t, '(') || (SqlContext._isName(t)
                        && !(t.t === 'w' && SqlContext.SOURCE_STOPPERS.has(t.lc)));
                    expect = null;
                    if (startsSource) { k = readSource(k, role); continue; }
                }
                if (t.t === 'p') {
                    if (t.v === '(') {
                        const c = closeOf(k);
                        if (isSubStart(k + 1)) {
                            const child = newScope(scope, k + 1, c, k, block, true);
                            walk(child);
                            scope.children.push(child);
                        } else {
                            scope.groups.push({ open: k, close: c, block });
                        }
                        k = c < to ? c + 1 : to;
                        continue;
                    }
                    if (t.v === ',' && clauseOf(block) === 'from') expect = 'source';
                    k++;
                    continue;
                }
                if (t.t === 'w') {
                    switch (t.lc) {
                        case 'with':
                            if (k === scope.start && SqlContext._isCteStart(tokens, k)) { mark(k, 'with'); k = readCtes(k); continue; }
                            break;
                        case 'select': mark(k, 'select'); block.selectIdx = k; break;
                        case 'from': mark(k, 'from'); expect = 'source'; break;
                        case 'join': mark(k, 'join'); expect = 'source'; break;
                        case 'apply': mark(k, 'join'); expect = 'apply'; break;
                        case 'on': mark(k, 'on'); break;
                        case 'where': mark(k, 'where'); break;
                        case 'having': mark(k, 'having'); break;
                        case 'group': mark(k, 'groupby'); break;
                        case 'order': mark(k, 'orderby'); break;
                        case 'set': mark(k, 'set'); break;
                        case 'values': mark(k, 'values'); break;
                        case 'output': mark(k, 'output'); break;
                        case 'option': mark(k, 'option'); break;
                        case 'exec': case 'execute': mark(k, 'exec'); break;
                        case 'use': mark(k, 'use'); break;
                        case 'declare': mark(k, 'declare'); break;
                        case 'delete': mark(k, 'delete'); break;
                        case 'merge': mark(k, 'merge'); break;
                        case 'using': mark(k, 'using'); expect = 'source'; break;
                        case 'insert':
                            mark(k, 'insert');
                            if (SqlContext._isName(tokens[k + 1]) && !SqlContext._isWord(tokens[k + 1], 'into')) expect = 'into';
                            break;
                        case 'into': mark(k, 'into'); expect = 'into'; break;
                        case 'update': mark(k, 'update'); expect = 'target'; break;
                        case 'union': case 'intersect': case 'except':
                            block = newBlock(k + 1);
                            scope.blocks.push(block);
                            break;
                        default: break;
                    }
                }
                k++;
            }
        };

        const root = newScope(null, from, to, -1, null, false);
        walk(root);
        return root;
    }

    // Names inside a "(a, b, c)" list, tokens[from..to).
    static _listNames(tokens, from, to) {
        const names = [];
        for (let k = from; k < to; k++) {
            const t = tokens[k];
            const prev = tokens[k - 1];
            if (SqlContext._isName(t) && (k === from || SqlContext._isPunct(prev, ','))) names.push(t.v);
        }
        return names;
    }

    // === Select list columns (CTEs, derived tables, SELECT INTO) ===

    // { names: [...], stars: [{ alias|null }] } from a block's select list.
    static selectItems(scope, block) {
        const tokens = scope.shared.tokens;
        const result = { names: [], stars: [] };
        if (block.selectIdx === undefined) return result;
        // The select list ends at INTO (SELECT ... INTO #t) or FROM, whichever comes first.
        const fromMark = block.marks.find(m => m.clause === 'from' || m.clause === 'into');
        const next = scope.blocks[scope.blocks.indexOf(block) + 1];
        const end = fromMark ? fromMark.idx : (next ? next.startIdx - 1 : scope.end);

        let k = block.selectIdx + 1;
        while (k < end && tokens[k].t === 'w' && (tokens[k].lc === 'distinct' || tokens[k].lc === 'all')) k++;
        if (k < end && SqlContext._isWord(tokens[k], 'top')) {
            k++;
            if (SqlContext._isPunct(tokens[k], '(')) k = Math.min(end, SqlContext._skipGroup(scope, k));
            else k++;
            if (SqlContext._isWord(tokens[k], 'percent')) k++;
            if (SqlContext._isWord(tokens[k], 'with') && SqlContext._isWord(tokens[k + 1], 'ties')) k += 2;
        }

        let item = [];
        const flush = () => {
            SqlContext._itemName(item, result);
            item = [];
        };
        while (k < end) {
            const t = tokens[k];
            if (SqlContext._isPunct(t, '(')) {
                const after = SqlContext._skipGroup(scope, k);
                item.push({ t: 'g', v: '()' });
                k = after;
                continue;
            }
            if (SqlContext._isPunct(t, ',')) { flush(); k++; continue; }
            item.push(t);
            k++;
        }
        flush();
        return result;
    }

    // Index right after the group opened at k (inside the statement's matches).
    static _skipGroup(scope, k) {
        const c = scope.shared.closeOf(k);
        return c < scope.shared.stmtEnd ? c + 1 : scope.shared.stmtEnd;
    }

    static _itemName(item, result) {
        if (item.length === 0) return;
        const last = item[item.length - 1];
        // "*" and "alias.*"
        if (SqlContext._isPunct(last, '*')) {
            const before = item[item.length - 3];
            const dot = item[item.length - 2];
            result.stars.push({ alias: SqlContext._isPunct(dot, '.') && SqlContext._isName(before) ? before.v : null });
            return;
        }
        // "alias = expression"
        if (item.length >= 3 && SqlContext._isName(item[0]) && SqlContext._isPunct(item[1], '=')) {
            result.names.push(item[0].v);
            return;
        }
        if (!SqlContext._isName(last)) return;
        const prev = item[item.length - 2];
        if (!prev) { result.names.push(last.v); return; }              // bare column
        if (SqlContext._isWord(prev, 'as')) { result.names.push(last.v); return; } // expr AS alias
        if (SqlContext._isPunct(prev, '.')) { result.names.push(last.v); return; } // a.b.Column
        if (prev.t === 'p') return;                                    // operator before a name: no alias
        if (prev.t === 'w' && SqlContext.EXPRESSION_WORDS.has(prev.lc)) return;
        result.names.push(last.v);                                     // expr alias
    }

    // === Temp tables and variables ===

    // Column definitions of "CREATE TABLE #t (...)" / "DECLARE @t TABLE (...)":
    // [{ name, type }].
    static _definitionColumns(text, tokens, open, close) {
        const cols = [];
        let depth = 0;
        let itemStart = open + 1;
        const flush = end => {
            const first = tokens[itemStart];
            if (itemStart < end && SqlContext._isName(first) && !(first.t === 'w' && SqlContext.CONSTRAINT_WORDS.has(first.lc))) {
                const typeTok = tokens[itemStart + 1];
                let type = '';
                if (SqlContext._isName(typeTok)) {
                    const after = tokens[itemStart + 2];
                    const endPos = SqlContext._isPunct(after, '(') ? SqlContext._groupEndPos(tokens, itemStart + 2, end) : typeTok.e;
                    type = text.slice(typeTok.s, endPos);
                }
                cols.push({ name: first.v, type });
            }
        };
        for (let k = open + 1; k < close; k++) {
            const t = tokens[k];
            if (SqlContext._isPunct(t, '(')) depth++;
            else if (SqlContext._isPunct(t, ')')) depth--;
            else if (SqlContext._isPunct(t, ',') && depth === 0) { flush(k); itemStart = k + 1; }
        }
        flush(close);
        return cols;
    }

    static _groupEndPos(tokens, open, limit) {
        let depth = 0;
        for (let k = open; k < limit; k++) {
            if (SqlContext._isPunct(tokens[k], '(')) depth++;
            else if (SqlContext._isPunct(tokens[k], ')') && --depth === 0) return tokens[k].e;
        }
        return tokens[limit - 1].e;
    }

    static _matchingClose(tokens, open, limit) {
        let depth = 0;
        for (let k = open; k < limit; k++) {
            if (SqlContext._isPunct(tokens[k], '(')) depth++;
            else if (SqlContext._isPunct(tokens[k], ')') && --depth === 0) return k;
        }
        return limit;
    }

    // Temp tables of the whole text (they outlive a GO) and table variables of
    // the caret's batch. Returns { temps: Map(lowerName -> def), variables: [] }.
    // A def is { name, columns } or { name, derived: { root, scope, block } }.
    static _definitions(lexed, caretBatch) {
        const { text, tokens, statements } = lexed;
        const temps = new Map();
        const variables = [];
        for (const st of statements) {
            const first = tokens[st.from];
            if (!first || first.t !== 'w') continue;

            if (first.lc === 'create' && SqlContext._isWord(tokens[st.from + 1], 'table')) {
                const name = tokens[st.from + 2];
                const open = st.from + 3;
                if (SqlContext._isName(name) && name.v.startsWith('#') && SqlContext._isPunct(tokens[open], '(')) {
                    const close = SqlContext._matchingClose(tokens, open, st.to);
                    temps.set(name.lc, { name: name.v, columns: SqlContext._definitionColumns(text, tokens, open, close) });
                }
            }

            if (first.lc === 'declare' || first.lc === 'create' || first.lc === 'alter') {
                for (let k = st.from + 1; k < st.to; k++) {
                    const t = tokens[k];
                    const prev = tokens[k - 1];
                    if (t.t !== 'w' || !t.v.startsWith('@') || t.v.startsWith('@@')) continue;
                    // A declaration starts after DECLARE, a comma, "(" or the procedure name.
                    const declares = k === st.from + 1 || SqlContext._isPunct(prev, ',') || SqlContext._isPunct(prev, '(')
                        || (SqlContext._isName(prev) && SqlContext._isName(tokens[k - 2]) && /^(procedure|proc|function)$/.test(tokens[k - 2].lc));
                    if (!declares) continue;
                    let j = k + 1;
                    if (SqlContext._isWord(tokens[j], 'as')) j++;
                    const typeTok = tokens[j];
                    if (!SqlContext._isName(typeTok)) continue;
                    if (SqlContext._isWord(typeTok, 'table') && SqlContext._isPunct(tokens[j + 1], '(')) {
                        if (st.batch === caretBatch) {
                            const close = SqlContext._matchingClose(tokens, j + 1, st.to);
                            temps.set(t.lc, { name: t.v, columns: SqlContext._definitionColumns(text, tokens, j + 1, close) });
                        }
                        continue;
                    }
                    if (st.batch !== caretBatch) continue;
                    const endPos = SqlContext._isPunct(tokens[j + 1], '(')
                        ? SqlContext._groupEndPos(tokens, j + 1, st.to)
                        : typeTok.e;
                    variables.push({ name: t.v, type: text.slice(typeTok.s, endPos) });
                }
            }

            // SELECT ... INTO #t FROM ...: derive the columns from the select list.
            if (first.lc === 'select') {
                let hasTempInto = false;
                for (let k = st.from + 1; k < st.to - 1; k++) {
                    if (SqlContext._isWord(tokens[k], 'into') && SqlContext._isName(tokens[k + 1]) && tokens[k + 1].v.startsWith('#')) { hasTempInto = true; break; }
                }
                if (hasTempInto) {
                    const root = SqlContext._parseStatement(tokens, st.from, st.to);
                    const block = root.blocks.find(b => b.intoTarget);
                    if (block) {
                        const name = block.intoTarget.parts[0];
                        temps.set(name.toLowerCase(), { name, derived: { scope: root, block } });
                    }
                }
            }
        }
        return { temps, variables };
    }

    // === Caret analysis ===

    // Everything the suggestion builder needs about the caret position.
    // tokenStart: where the word being typed starts (caret when nothing typed).
    static analyze(text, caret, tokenStart) {
        const lexed = SqlContext._lex(text);
        const { tokens, literals, statements } = lexed;
        const result = {
            inLiteral: SqlContext.insideLiteral(literals, caret),
            clause: 'start', sources: [], ctes: [], temps: new Map(), variables: [],
            prevWord: '', prevToken: null, atLineStart: false, group: null, insertTarget: null,
            root: null, scope: null, block: null, stmtStart: 0
        };
        if (result.inLiteral) return result;

        const start = tokenStart === undefined ? caret : tokenStart;
        const before = SqlContext._lastTokenBefore(tokens, start);
        result.prevIdx = before;
        result.prevToken = before >= 0 ? tokens[before] : null;
        result.prev2Word = before >= 1 && tokens[before - 1].t === 'w' ? tokens[before - 1].lc : '';
        result.prevWord = result.prevToken ? (result.prevToken.t === 'w' ? result.prevToken.lc : result.prevToken.t === 'p' ? result.prevToken.v : '') : '';
        const lineBreak = text.lastIndexOf('\n', start - 1);
        result.atLineStart = /^[ \t]*$/.test(text.slice(lineBreak + 1, start));

        // Statement under the caret: the last one starting before it, unless
        // it ended with ';' before the caret or a GO sits between them (then
        // the caret is in a new statement, and a new batch for GO).
        let last = null;
        for (const st of statements) {
            if (tokens[st.from].s < caret) last = st;
            else break;
        }
        let stmt = last;
        let batch = last ? last.batch : 0;
        if (last) {
            const lastTok = tokens[last.to - 1];
            if (SqlContext._goBetween(text, lastTok.e, caret)) { stmt = null; batch++; }
            else if (SqlContext._isPunct(lastTok, ';') && lastTok.e <= start) stmt = null;
        }

        const defs = SqlContext._definitions(lexed, batch);
        result.temps = defs.temps;
        result.variables = defs.variables;
        if (!stmt) return result;

        const root = SqlContext._parseStatement(tokens, stmt.from, stmt.to);
        result.root = root;
        result.stmtStart = tokens[stmt.from].s;
        const scope = SqlContext._scopeAt(tokens, root, start);
        result.scope = scope;

        let block = scope.blocks[0];
        for (const b of scope.blocks) {
            if (b.startIdx < tokens.length && tokens[b.startIdx] && tokens[b.startIdx].s <= start) block = b;
        }
        result.block = block;
        let clause = 'start';
        for (const m of block.marks) {
            if (tokens[m.idx].e <= start) clause = m.clause;
            else break;
        }
        // The first statement keyword is not a clause of its own once typed.
        if (clause === 'start' && block.marks.length === 0 && before >= stmt.from && before >= 0 && tokens[before] && tokens[before].t === 'w' && scope === root) clause = 'other';
        result.clause = clause;

        // Plain parenthesis group around the caret (function args, IN list,
        // INSERT column list, VALUES row...).
        let group = null;
        for (const g of scope.groups) {
            const open = tokens[g.open];
            const closeTok = g.close < stmt.to ? tokens[g.close] : null;
            if (open.e <= start && (!closeTok || start <= closeTok.s)) {
                if (!group || g.open > group.open) group = g;
            }
        }
        if (group) {
            const opener = tokens[group.open - 1];
            const opener2 = tokens[group.open - 2];
            let kind = 'expr';
            if ((scope.firstWord === 'insert') && (clause === 'into' || clause === 'insert')) kind = 'insertcols';
            else if (clause === 'values') kind = 'values';
            else if (SqlContext._isWord(opener, 'with') || (SqlContext._isName(opener) && SqlContext.TABLE_HINTS.has((tokens[group.open + 1] || {}).lc))) kind = 'hints';
            else if (clause === 'start' && SqlContext._isName(opener) && SqlContext._isWord(opener2, 'table')) kind = 'definition';
            result.group = { kind, open: group.open, close: group.close, opener };
        }

        result.insertTarget = scope.insertTarget || (root.insertTarget || null);
        SqlContext._collectVisible(result, scope, block, defs);
        // The INSERT target can be a temp table or a table variable too.
        if (result.insertTarget) {
            result.insertTarget = Object.assign({}, result.insertTarget);
            SqlContext._bind(result.insertTarget, result.ctes, defs);
        }
        return result;
    }

    static _lastTokenBefore(tokens, pos) {
        let lo = 0;
        let hi = tokens.length - 1;
        let found = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (tokens[mid].e <= pos) { found = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return found;
    }

    // Is there a lone GO line in text[from, caret)?
    static _goBetween(text, from, caret) {
        return /(^|\n)[ \t]*go[ \t]*\d*[ \t]*(\r?\n|$)/i.test(text.slice(from, caret) + '\n');
    }

    // Innermost scope containing the position.
    static _scopeAt(tokens, scope, pos) {
        for (const child of scope.children) {
            const open = tokens[child.openIdx];
            const closeTok = child.end < scope.shared.stmtEnd ? tokens[child.end] : null;
            const inside = open.e <= pos && (!closeTok || !SqlContext._isPunct(closeTok, ')') || pos <= closeTok.s);
            if (inside) return SqlContext._scopeAt(tokens, child, pos);
        }
        return scope;
    }

    // Sources visible from a block: its own, then (for correlated subqueries)
    // the enclosing block's. CTEs of the whole chain are visible by name.
    static _collectVisible(result, scope, block, defs) {
        const ctes = [];
        for (let s = scope; s; s = s.parent) ctes.push(...s.ctes);
        result.ctes = ctes;

        const sources = [];
        const seen = new Set();
        let level = 0;
        let b = block;
        let s = scope;
        let from = null; // the subquery we came out of: its own derived table is not visible from inside
        for (;;) {
            for (const src of b.sources) {
                if (from && src.child === from) continue;
                const key = (src.alias || src.parts.join('.')).toLowerCase();
                if (src.target && seen.has(key)) continue;
                const resolved = Object.assign({ level }, src);
                SqlContext._bind(resolved, ctes, defs);
                if (b.sources.some(o => o !== src && !o.target && src.target && (o.alias || o.parts.join('.')).toLowerCase() === key)) continue;
                seen.add(key);
                sources.push(resolved);
            }
            if (!s.correlated || !s.parentBlock) break;
            level++;
            b = s.parentBlock;
            from = s;
            s = s.parent;
        }
        result.sources = sources;
    }

    // Bound copy of a source found inside `scope` (used for the sources of a
    // derived table or CTE, which the caret analysis did not bind).
    static bindInScope(src, scope, temps) {
        const ctes = [];
        for (let s = scope; s; s = s.parent) ctes.push(...s.ctes);
        const bound = Object.assign({}, src);
        SqlContext._bind(bound, ctes, { temps: temps || new Map() });
        return bound;
    }

    // Point a table reference at the CTE / temp definition it names.
    static _bind(src, ctes, defs) {
        if (src.kind === 'table' && src.parts.length === 1) {
            const cte = ctes.find(c => c.name.toLowerCase() === src.parts[0].toLowerCase());
            if (cte) { src.kind = 'cte'; src.cte = cte; return; }
        }
        if ((src.kind === 'temp' || src.kind === 'variable') && defs.temps.has(src.parts[0].toLowerCase())) {
            src.def = defs.temps.get(src.parts[0].toLowerCase());
        }
    }
}

SqlContext._lexCache = null;

// Words after which a SELECT/INSERT/UPDATE/DELETE continues the same statement.
SqlContext.CONTINUES_AFTER = new Set([
    'union', 'all', 'intersect', 'except', 'as', 'then', 'for', 'after', 'of', 'on'
]);
SqlContext.STATEMENT_STARTERS = new Set(['select', 'insert', 'update', 'delete', 'merge']);

// Words that can follow a table name but are never an alias.
SqlContext.NOT_AN_ALIAS = new Set([
    'where', 'on', 'inner', 'left', 'right', 'full', 'cross', 'outer', 'join', 'natural',
    'group', 'order', 'having', 'set', 'values', 'select', 'union', 'intersect', 'except',
    'as', 'with', 'option', 'output', 'when', 'then', 'else', 'end', 'and', 'or', 'not',
    'exists', 'pivot', 'unpivot', 'for', 'using', 'apply', 'from', 'into', 'insert',
    'update', 'delete', 'merge', 'tablesample', 'offset', 'fetch', 'window', 'go'
]);
// Words that, right after FROM/JOIN/..., mean "no source here (yet)".
SqlContext.SOURCE_STOPPERS = new Set([
    'where', 'on', 'group', 'order', 'having', 'set', 'values', 'select', 'union',
    'intersect', 'except', 'option', 'output', 'inner', 'left', 'right', 'full', 'cross',
    'outer', 'join', 'from', 'into', 'with', 'for', 'when', 'then', 'as', 'of'
]);
SqlContext.TABLE_HINTS = new Set([
    'nolock', 'holdlock', 'readuncommitted', 'readcommitted', 'repeatableread', 'serializable',
    'rowlock', 'paglock', 'tablock', 'tablockx', 'updlock', 'xlock', 'readpast', 'nowait',
    'index', 'forceseek', 'forcescan', 'snapshot', 'noexpand'
]);
// A word before a bare name in a select item means an operator, not an alias.
SqlContext.EXPRESSION_WORDS = new Set([
    'and', 'or', 'not', 'in', 'is', 'like', 'between', 'case', 'when', 'then', 'else', 'distinct',
    'exists', 'all', 'any', 'some', 'null', 'over', 'by'
]);
SqlContext.CONSTRAINT_WORDS = new Set(['constraint', 'primary', 'unique', 'foreign', 'check', 'index', 'period']);

// Allow unit tests to require() this file; in the webview `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SqlContext;
}
