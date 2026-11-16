'use strict';

// Shared matching logic for a user-typed search: plain text or a regular
// expression, matched case-insensitively. Used by the "search in the
// contents of the files" of the Files tab (QueryFileHandlers) and the
// instance-wide object/definition search of the Instance tab
// (InstanceHandlers) - same semantics, same match-count-plus-first-line
// result, two different bodies of text to run it against.

// The pattern of a search: the text as typed, or a regular expression.
// Never case sensitive, and ^ / $ are those of a line. Throws on an
// invalid regular expression.
function searchPattern(query, isRegex) {
    const source = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(source, 'gim');
}

// How many times the pattern matches, and the line (from 1) of the first.
function findMatches(text, pattern) {
    let count = 0;
    let line = 1;
    for (const match of text.matchAll(pattern)) {
        if (count === 0) line = text.slice(0, match.index).split('\n').length;
        count++;
    }
    return { count, line };
}

module.exports = { searchPattern, findMatches };
