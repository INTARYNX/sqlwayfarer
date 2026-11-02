/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Candidate matching and ranking for the SQL autocompletion.
// Pure functions, no DOM: unit-tested on their own.
//
// A match is a { tier, sub } pair. Tiers (higher is better):
//   6 exact, 5 prefix, 4 initials ("ho" -> HumanOrders), 3 substring starting
//   on a word boundary, 2 substring, 1 fuzzy subsequence.
// `sub` orders candidates inside one tier (shorter / earlier wins).
class SqlMatcher {
    // Lowercase and drop the quoting characters the user may have typed.
    static normalizeQuery(query) {
        return (query || '').replace(/[[\]"]/g, '').toLowerCase();
    }

    static _isAlnum(ch) {
        const c = ch.charCodeAt(0);
        if (c < 128) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
        return ch.toLowerCase() !== ch.toUpperCase();
    }

    static _isUpper(ch) { return ch !== ch.toLowerCase(); }

    // Start offsets of the "words" of an identifier: after a separator
    // (_ . space) or at a camelCase hump.
    static wordStarts(candidate) {
        const starts = [];
        const n = candidate.length;
        for (let i = 0; i < n; i++) {
            const ch = candidate[i];
            if (!SqlMatcher._isAlnum(ch)) continue;
            const prev = i > 0 ? candidate[i - 1] : '';
            const afterSeparator = i === 0 || !SqlMatcher._isAlnum(prev);
            const upper = SqlMatcher._isUpper(ch);
            const hump = upper && prev !== '' && !SqlMatcher._isUpper(prev);
            const acronymEnd = upper && prev !== '' && SqlMatcher._isUpper(prev) && i + 1 < n
                && SqlMatcher._isAlnum(candidate[i + 1]) && !SqlMatcher._isUpper(candidate[i + 1]) && candidate[i + 1] !== candidate[i + 1].toUpperCase();
            if (afterSeparator || hump || acronymEnd) starts.push(i);
        }
        return starts;
    }

    // Best match of `query` against one candidate string, or null.
    // mode: 'prefix' | 'contains' | 'fuzzy'
    static match(candidate, query, mode = 'fuzzy') {
        const q = SqlMatcher.normalizeQuery(query);
        if (!q) return { tier: 5, sub: 0 };
        const raw = candidate || '';
        const text = /[[\]"]/.test(raw) ? raw.replace(/[[\]"]/g, '') : raw;
        const lower = text.toLowerCase();

        if (lower === q) return { tier: 6, sub: 0 };
        if (lower.startsWith(q)) return { tier: 5, sub: -(lower.length - q.length) };
        if (mode === 'prefix') return null;

        // Cheap tests first: this runs once per object of the database, per keystroke.
        const index = lower.indexOf(q);
        if (mode === 'contains' && index < 0) {
            return SqlMatcher._initials(text, lower, q);
        }
        const initials = SqlMatcher._initials(text, lower, q);
        if (initials) return initials;
        if (index >= 0) {
            return SqlMatcher.wordStarts(text).includes(index)
                ? { tier: 3, sub: -index }
                : { tier: 2, sub: -index };
        }
        return SqlMatcher._fuzzy(text, lower, q);
    }

    // "ho" -> HumanOrders: the query is the start of the word initials.
    static _initials(text, lower, q) {
        if (q.length < 2 || lower[0] !== q[0]) return null;
        const starts = SqlMatcher.wordStarts(text);
        const initials = starts.map(i => lower[i]).join('');
        return initials.startsWith(q) ? { tier: 4, sub: -(initials.length - q.length) } : null;
    }

    // Subsequence match: every query character found in order. Characters
    // sitting on a word start and consecutive ones score higher.
    static _fuzzy(text, lower, q) {
        if (q.length < 3) return null; // two scattered letters match almost anything
        let pos = 0;
        for (const ch of q) {
            pos = lower.indexOf(ch, pos);
            if (pos < 0) return null;
            pos++;
        }
        const startSet = new Set(SqlMatcher.wordStarts(text));
        let score = 0;
        let last = -2;
        pos = 0;
        for (const ch of q) {
            const found = lower.indexOf(ch, pos);
            if (found === last + 1) score += 8;
            if (startSet.has(found)) score += 10;
            score -= Math.min(found - pos, 6);
            last = found;
            pos = found + 1;
        }
        return { tier: 1, sub: score - lower.length / 10 };
    }

    // Best match over several candidate strings (e.g. bare and qualified name).
    static matchAny(candidates, query, mode) {
        let best = null;
        for (const c of candidates) {
            const m = SqlMatcher.match(c, query, mode);
            if (m && (!best || SqlMatcher.compareMatch(m, best) < 0)) best = m;
        }
        return best;
    }

    // Negative when a is the better match.
    static compareMatch(a, b) {
        return (b.tier - a.tier) || (b.sub - a.sub);
    }

    // Filter and order items. Each item carries `match` (string[] or string),
    // `priority` (lower first inside a tier), `order` (natural order, e.g. the
    // column position, for what is otherwise a tie) and a stable `usageKey`.
    // usage: Map usageKey -> count (or null).
    static rank(items, query, mode, usage) {
        const scored = [];
        for (const item of items) {
            const candidates = Array.isArray(item.match) ? item.match : [item.match || item.label];
            const m = SqlMatcher.matchAny(candidates, query, mode);
            if (!m) continue;
            const used = usage && item.usageKey ? (usage.get(item.usageKey) || 0) : 0;
            scored.push({ item, m, used, key: String(item.label).toLowerCase() });
        }
        // Labels are compared as plain lowercase strings: localeCompare is far too
        // slow to sort the thousands of objects of a big database on every keystroke.
        scored.sort((a, b) =>
            (b.m.tier - a.m.tier)
            || (Number((b.item.priority || 0) < 0) - Number((a.item.priority || 0) < 0)) // pinned first
            || (b.used - a.used)
            || ((a.item.priority || 0) - (b.item.priority || 0))
            || (b.m.sub - a.m.sub)
            || ((a.item.order || 0) - (b.item.order || 0))
            || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        return scored.map(s => s.item);
    }
}

// Allow unit tests to require() this file; in the webview `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SqlMatcher;
}
