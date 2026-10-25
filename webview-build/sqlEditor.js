/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Webpack-bundled entry point for the query editor's CodeMirror 6 instance.
// webview/*.js is loaded as-is (no bundler, see panels/SqlWayfarerPanel.js) -
// this file is the one exception, built by the 'web' config in
// webpack.config.js into dist/webview/sqlEditor.js, because CodeMirror 6
// ships as ~15 modular ESM packages instead of one vendorable script.
//
// Exposes window.SqlCodeMirror.attach(container) -> an adapter object that
// mimics the subset of the HTMLTextAreaElement API the rest of the webview
// already uses (value, selectionStart/End, setSelectionRange, focus,
// scrollTop, addEventListener/dispatchEvent) so queryManager.js,
// queryFileManager.js and sqlAutocomplete.js keep working against "the
// editor" without needing to know it's not a <textarea> anymore - only
// sqlAutocomplete.js's caret-pixel positioning needed a real rewrite (CM's
// coordsAtPos vs the old mirror-div trick), see its own comments.
import { EditorView, keymap, lineNumbers, drawSelection, dropCursor, rectangularSelection, crosshairCursor, placeholder, Decoration, ViewPlugin } from '@codemirror/view';
import { EditorState, RangeSetBuilder } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { sql, MSSQL } from '@codemirror/lang-sql';
import { tags } from '@lezer/highlight';

// Colors match the ones webview/styles.css used for the old overlay-based
// highlighter (sql-tok-*), themselves VS Code Dark+ values - same look,
// now driven by a real tokenizer instead of a hand-rolled one.
const sqlHighlightStyle = HighlightStyle.define([
    { tag: [tags.keyword, tags.typeName, tags.bool, tags.null], color: 'var(--vscode-terminal-ansiBlue, #569cd6)', fontWeight: '600' },
    { tag: tags.standard(tags.name), color: 'var(--vscode-terminal-ansiCyan, #4ec9b0)' },
    { tag: tags.string, color: 'var(--vscode-terminal-ansiGreen, #ce9178)' },
    { tag: tags.number, color: 'var(--vscode-terminal-ansiMagenta, #b5cea8)' },
    { tag: [tags.lineComment, tags.blockComment], color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' },
    { tag: tags.special(tags.name), color: 'var(--vscode-terminal-ansiYellow, #9cdcfe)' },
    { tag: tags.special(tags.string), color: 'var(--vscode-editor-foreground)' },
    { tag: [tags.paren, tags.brace, tags.squareBracket, tags.punctuation, tags.operator], color: 'var(--vscode-editor-foreground)' }
]);

// GO is a client-side batch separator (sqlcmd/SSMS convention), not a real
// T-SQL keyword, so the lezer SQL grammar tags it the same blue as every
// other keyword. A dedicated decoration recolors standalone "GO [N]" lines
// so batch boundaries stand out the way they do in SSMS. Cosmetic only -
// QueryHandlers.splitBatches (panels/handlers/QueryHandlers.js) is the
// actual authority on where batches split, this just mirrors its regex
// closely enough to look right.
const GO_LINE_RE = /^[ \t]*GO([ \t]+\d+)?[ \t]*(--.*)?$/i;

function buildGoDecorations(view) {
    const builder = new RangeSetBuilder();
    const { doc } = view.state;
    for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        const trimmedEnd = line.text.replace(/[ \t\r]+$/, '').length;
        if (trimmedEnd > 0 && GO_LINE_RE.test(line.text)) {
            builder.add(line.from, line.from + trimmedEnd, Decoration.mark({ class: 'cm-go-separator' }));
        }
    }
    return builder.finish();
}

const goHighlighter = ViewPlugin.fromClass(class {
    constructor(view) {
        this.decorations = buildGoDecorations(view);
    }
    update(update) {
        if (update.docChanged) this.decorations = buildGoDecorations(update.view);
    }
}, { decorations: v => v.decorations });

const vsCodeTheme = EditorView.theme({
    '&': {
        // position:absolute + inset:0 (not just height:100%) so the editor
        // fills .query-input exactly regardless of content - a plain flow
        // child sized by height:100% was instead shrinking to fit just its
        // content (one line in, one line tall), leaving the rest of the
        // container as bare background with no actual editor underneath it.
        position: 'absolute',
        inset: '0',
        height: '100%',
        width: '100%',
        backgroundColor: 'var(--vscode-textCodeBlock-background)',
        color: 'var(--vscode-editor-foreground)',
        fontSize: 'var(--vscode-editor-font-size, 13px)'
    },
    '.cm-content': {
        fontFamily: 'var(--vscode-editor-font-family)',
        caretColor: 'var(--vscode-editor-foreground)',
        padding: '2px 0'
    },
    '.cm-scroller': {
        overflow: 'auto',
        fontFamily: 'var(--vscode-editor-font-family)'
    },
    '.cm-gutters': {
        backgroundColor: 'var(--vscode-textCodeBlock-background)',
        color: 'var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground))',
        border: 'none'
    },
    '&.cm-focused': {
        outline: '1px solid #ffa500',
        outlineOffset: '-1px'
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
        backgroundColor: 'var(--vscode-editor-selectionBackground) !important'
    },
    '.cm-go-separator': {
        color: '#d7ba7d',
        fontWeight: '700'
    }
}, { dark: true });

// Minimal subset of @codemirror/basic-setup, picked individually instead of
// pulling the whole bundle in: no autocompletion()/closeBrackets()/search
// panel, since the editor keeps its own SqlAutocomplete dropdown and its own
// Ctrl+Space/Ctrl+Enter/F5 handling (queryManager.js) - a second completion
// engine would just fight the first one over the same keys.
function baseExtensions(options) {
    return [
        placeholder(options.placeholder || ''),
        lineNumbers(),
        history(),
        drawSelection(),
        dropCursor(),
        bracketMatching(),
        indentOnInput(),
        rectangularSelection(),
        crosshairCursor(),
        EditorState.allowMultipleSelections.of(true),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        sql({ dialect: MSSQL }),
        syntaxHighlighting(sqlHighlightStyle),
        goHighlighter,
        vsCodeTheme,
        EditorView.lineWrapping
    ];
}

// Thin adapter: the EditorView lives inside `container` (kept as the mount
// point so document.getElementById('queryInput') still resolves the way the
// rest of the webview expects), and the handful of textarea-shaped
// properties/methods the rest of the code calls are defined directly on
// that same DOM node - real DOM events (keydown/click/dblclick) already
// bubble up from CodeMirror's contentDOM to it with no extra wiring needed.
function attach(container, options = {}) {
    const onUserInput = () => container.dispatchEvent(new Event('input'));

    const view = new EditorView({
        parent: container,
        doc: options.initialDoc || '',
        extensions: [
            ...baseExtensions(options),
            EditorView.updateListener.of((update) => {
                if (update.docChanged && update.transactions.some(tr => tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('undo') || tr.isUserEvent('redo'))) {
                    onUserInput();
                }
            })
        ]
    });

    container.cmView = view;

    Object.defineProperty(container, 'value', {
        configurable: true,
        get() { return view.state.doc.toString(); },
        set(text) {
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text == null ? '' : String(text) } });
        }
    });
    Object.defineProperty(container, 'selectionStart', {
        configurable: true,
        get() { return view.state.selection.main.from; }
    });
    Object.defineProperty(container, 'selectionEnd', {
        configurable: true,
        get() { return view.state.selection.main.to; }
    });
    Object.defineProperty(container, 'scrollTop', {
        configurable: true,
        get() { return view.scrollDOM.scrollTop; },
        set(v) { view.scrollDOM.scrollTop = v; }
    });

    container.setSelectionRange = (start, end) => {
        const len = view.state.doc.length;
        const a = Math.max(0, Math.min(start, len));
        const b = Math.max(0, Math.min(end, len));
        view.dispatch({ selection: { anchor: a, head: b }, scrollIntoView: true });
    };
    container.focus = () => view.focus();
    // 'scroll' doesn't bubble, and the element that actually scrolls is
    // view.scrollDOM (a descendant of container, CM's own .cm-scroller) -
    // forward it so a plain container.addEventListener('scroll', ...), as
    // sqlAutocomplete.js uses to close the dropdown, keeps working.
    view.scrollDOM.addEventListener('scroll', () => container.dispatchEvent(new Event('scroll')));

    // Exact pixel position of a document offset, relative to `container`
    // (not the viewport) - what SqlAutocomplete.position() needs to place
    // its dropdown, and what a caret-pixel-position feature would use in
    // general. Returns null for an offset currently scrolled out of view.
    container.coordsAtOffset = (pos) => {
        const coords = view.coordsAtPos(Math.max(0, Math.min(pos, view.state.doc.length)));
        if (!coords) return null;
        const box = container.getBoundingClientRect();
        return { left: coords.left - box.left, bottom: coords.bottom - box.top, top: coords.top - box.top };
    };

    return container;
}

window.SqlCodeMirror = { attach };
