/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Lightweight SQL syntax highlighting for the query textarea.
// A plain <textarea> can't color its own text, so an absolutely-positioned
// <pre> overlay sits behind it (same font/padding/border, see styles.css)
// and the textarea itself is made transparent except for its caret - the
// classic "invisible textarea on top of a highlighted <pre>" trick.
// The tokenizer is a pure static method so it can be unit-tested without a DOM.
class SqlHighlighter {
    constructor(textarea) {
        this.textarea = textarea;

        this.overlay = document.createElement('pre');
        this.overlay.className = 'sql-highlight-overlay';
        this.overlay.setAttribute('aria-hidden', 'true');
        textarea.parentElement.insertBefore(this.overlay, textarea);
        textarea.classList.add('query-input-transparent');

        this.initEventListeners();
        this.render();
    }

    initEventListeners() {
        this.textarea.addEventListener('input', () => this.render());
        // Fired by SqlAutocomplete.accept() - it sets .value directly, which
        // doesn't fire 'input' on its own.
        this.textarea.addEventListener('sql:valuechange', () => this.render());
        this.textarea.addEventListener('scroll', () => this.syncScroll());
    }

    render() {
        // Trailing newline so a blank last line still reserves its height.
        this.overlay.innerHTML = `${SqlHighlighter.toHtml(this.textarea.value)}\n`;
        this.syncScroll();
    }

    syncScroll() {
        this.overlay.scrollTop = this.textarea.scrollTop;
        this.overlay.scrollLeft = this.textarea.scrollLeft;
    }

    // === Pure tokenizer (unit-testable, no DOM) ===

    // HTML-escaped, <span class="sql-tok-*">-wrapped markup for the overlay.
    static toHtml(text) {
        let html = '';
        let i = 0;
        const n = text.length;

        while (i < n) {
            const ch = text[i];

            if (ch === '-' && text[i + 1] === '-') {
                const end = text.indexOf('\n', i);
                const stop = end === -1 ? n : end;
                html += SqlHighlighter._span('comment', text.slice(i, stop));
                i = stop;
                continue;
            }
            if (ch === '/' && text[i + 1] === '*') {
                const end = text.indexOf('*/', i + 2);
                const stop = end === -1 ? n : end + 2;
                html += SqlHighlighter._span('comment', text.slice(i, stop));
                i = stop;
                continue;
            }
            if (ch === "'") {
                let j = i + 1;
                while (j < n) {
                    if (text[j] === "'") {
                        if (text[j + 1] === "'") { j += 2; continue; }
                        j += 1;
                        break;
                    }
                    j++;
                }
                html += SqlHighlighter._span('string', text.slice(i, j));
                i = j;
                continue;
            }
            if (ch === '[') {
                const end = text.indexOf(']', i + 1);
                const stop = end === -1 ? n : end + 1;
                html += SqlHighlighter._span('bracket', text.slice(i, stop));
                i = stop;
                continue;
            }
            if (ch === '@' || ch === '#') {
                const m = /^[@#]{1,2}[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
                if (m) {
                    html += SqlHighlighter._span('variable', m[0]);
                    i += m[0].length;
                    continue;
                }
            }
            if (/[0-9]/.test(ch)) {
                const m = /^\d+(\.\d+)?/.exec(text.slice(i));
                html += SqlHighlighter._span('number', m[0]);
                i += m[0].length;
                continue;
            }
            if (/[A-Za-z_]/.test(ch)) {
                const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
                const word = m[0];
                i += word.length;
                const upper = word.toUpperCase();
                if (SqlHighlighter.KEYWORDS.has(upper)) {
                    html += SqlHighlighter._span('keyword', word);
                } else if (SqlHighlighter.FUNCTIONS.has(upper)) {
                    html += SqlHighlighter._span('function', word);
                } else {
                    html += SqlHighlighter._escape(word);
                }
                continue;
            }

            html += SqlHighlighter._escape(ch);
            i++;
        }
        return html;
    }

    static _escape(text) {
        return text.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
    }

    static _span(cls, text) {
        return `<span class="sql-tok-${cls}">${SqlHighlighter._escape(text)}</span>`;
    }
}

SqlHighlighter.KEYWORDS = new Set([
    'SELECT', 'FROM', 'WHERE', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'JOIN', 'ON',
    'AND', 'OR', 'NOT', 'NULL', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'ORDER', 'BY', 'GROUP', 'HAVING',
    'DISTINCT', 'TOP', 'AS', 'UNION', 'ALL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'INSERT', 'INTO',
    'VALUES', 'UPDATE', 'SET', 'DELETE', 'DECLARE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION',
    'EXEC', 'EXECUTE', 'WITH', 'OVER', 'PARTITION', 'ASC', 'DESC', 'IS', 'MERGE', 'USING', 'OUTPUT',
    'PRINT', 'RAISERROR', 'IF', 'WHILE', 'RETURN', 'GO', 'USE', 'CAST', 'CONVERT', 'DEFAULT',
    'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'TABLE', 'VIEW', 'PROCEDURE', 'FUNCTION', 'TRIGGER',
    'INDEX', 'CONSTRAINT', 'ALTER', 'CREATE', 'DROP', 'TRUNCATE', 'NOCOUNT', 'IDENTITY', 'WAITFOR',
    'DELAY'
]);

SqlHighlighter.FUNCTIONS = new Set([
    'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GETDATE', 'ISNULL', 'COALESCE', 'LEN', 'SUBSTRING',
    'ROUND', 'CHARINDEX', 'REPLACE', 'UPPER', 'LOWER', 'LTRIM', 'RTRIM', 'TRIM', 'ROW_NUMBER',
    'RANK', 'DENSE_RANK', 'DATEADD', 'DATEDIFF', 'DATEPART', 'YEAR', 'MONTH', 'DAY'
]);

// Allow unit tests to require() this file; in the webview `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SqlHighlighter;
}
