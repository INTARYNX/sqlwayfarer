/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Where a word the server pointed at ("Incorrect syntax near 'FROM'") sits on
// a line of the script: the first whole word that is not inside a string or a
// line comment. Returns { from, to } offsets in the line, or null (the caller
// then underlines the whole line instead of guessing a substring).

// The ranges of the line that are text, not code: 'strings' and a -- comment.
function textRanges(line) {
    const ranges = [];
    let i = 0;
    while (i < line.length) {
        if (line[i] === '-' && line[i + 1] === '-') { ranges.push([i, line.length]); break; }
        if (line[i] === "'") {
            let j = i + 1;
            while (j < line.length) {
                if (line[j] === "'" && line[j + 1] === "'") { j += 2; continue; }
                if (line[j] === "'") { j++; break; }
                j++;
            }
            ranges.push([i, j]);
            i = j;
            continue;
        }
        i++;
    }
    return ranges;
}

const WORD_CHAR = /[\w@#$]/;

function findToken(line, token) {
    if (!token) return null;
    const hay = line.toLowerCase();
    const needle = token.toLowerCase();
    const text = textRanges(line);
    const wordLike = WORD_CHAR.test(needle[0]) && WORD_CHAR.test(needle[needle.length - 1]);
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
        const end = at + needle.length;
        if (text.some(([a, b]) => at >= a && at < b)) continue;
        if (wordLike && ((at > 0 && WORD_CHAR.test(line[at - 1])) || (end < line.length && WORD_CHAR.test(line[end])))) continue;
        return { from: at, to: end };
    }
    return null;
}

module.exports = { findToken };
