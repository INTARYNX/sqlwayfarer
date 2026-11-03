// A line diff for the Compare tab: what changed between two definitions, as
// lines that are kept, added or removed, collapsed around the changes the way
// a unified diff is.

const LineDiff = (() => {
    // Above this many cells the exact diff is not worth waiting for.
    const MAX_CELLS = 4000000;

    const split = text => String(text === null || text === undefined ? '' : text).replace(/\r\n?/g, '\n').split('\n');

    // The text of a definition as it is compared: the same rules as normalizeDefinition
    // of database/sqlHeader.js (which the webview cannot load), so that the diff shows
    // what the comparison found and nothing else.
    function normalize(text) {
        if (text === null || text === undefined) return '';
        let out = String(text).replace(/\r\n?/g, '\n');
        let i = 0;
        for (;;) {
            if (/\s/.test(out[i] || '')) { i++; continue; }
            if (out.startsWith('--', i)) { const end = out.indexOf('\n', i); i = end === -1 ? out.length : end + 1; continue; }
            if (out.startsWith('/*', i)) {
                let depth = 1;
                i += 2;
                while (i < out.length && depth > 0) {
                    if (out.startsWith('/*', i)) { depth++; i += 2; } else if (out.startsWith('*/', i)) { depth--; i += 2; } else i++;
                }
                continue;
            }
            break;
        }
        const header = /^(create\s+(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*or(?:\s|\/\*[\s\S]*?\*\/|--[^\n]*\n)+alter|create|alter)\b/i.exec(out.slice(i));
        if (header) out = `${out.slice(0, i)}CREATE${out.slice(i + header[0].length).replace(/^[ \t]+/, ' ')}`;
        return out.replace(/[ \t]+$/gm, '').trim();
    }

    // The lines of the two texts, each marked 'same', 'add' or 'del', with its
    // line number in the old and in the new text.
    function diff(oldText, newText) {
        const a = split(oldText);
        const b = split(newText);
        let start = 0;
        while (start < a.length && start < b.length && a[start] === b[start]) start++;
        let endA = a.length;
        let endB = b.length;
        while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

        const out = [];
        let oldLine = 1;
        let newLine = 1;
        const push = (type, text) => {
            out.push({ type, text, oldLine: type === 'add' ? null : oldLine, newLine: type === 'del' ? null : newLine });
            if (type !== 'add') oldLine++;
            if (type !== 'del') newLine++;
        };

        for (let i = 0; i < start; i++) push('same', a[i]);
        const left = a.slice(start, endA);
        const right = b.slice(start, endB);
        if (left.length * right.length > MAX_CELLS) {
            left.forEach(line => push('del', line));
            right.forEach(line => push('add', line));
        } else {
            // Longest common subsequence of the lines between the common head and tail.
            const width = right.length + 1;
            const table = new Uint32Array((left.length + 1) * width);
            for (let i = left.length - 1; i >= 0; i--) {
                for (let j = right.length - 1; j >= 0; j--) {
                    table[i * width + j] = left[i] === right[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
                }
            }
            let i = 0;
            let j = 0;
            while (i < left.length && j < right.length) {
                if (left[i] === right[j]) { push('same', left[i]); i++; j++; }
                else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { push('del', left[i]); i++; }
                else { push('add', right[j]); j++; }
            }
            while (i < left.length) push('del', left[i++]);
            while (j < right.length) push('add', right[j++]);
        }
        for (let i = endA; i < a.length; i++) push('same', a[i]);
        return out;
    }

    // The lines around the changes (context lines on each side), and how many
    // unchanged lines lie between: [{ lines }, { gap: n }, { lines }, ...].
    function hunks(lines, context = 3) {
        const keep = new Array(lines.length).fill(false);
        lines.forEach((line, i) => {
            if (line.type === 'same') return;
            for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
        });
        const out = [];
        let run = null;
        let skipped = 0;
        lines.forEach((line, i) => {
            if (keep[i]) {
                if (skipped > 0) { out.push({ gap: skipped }); skipped = 0; }
                if (!run) { run = { lines: [] }; out.push(run); }
                run.lines.push(line);
            } else {
                run = null;
                skipped++;
            }
        });
        if (skipped > 0) out.push({ gap: skipped });
        return out;
    }

    return { diff, hunks, normalize, split };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = LineDiff;
}
