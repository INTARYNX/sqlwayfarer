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
import { EditorState, RangeSetBuilder, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { sql, MSSQL } from '@codemirror/lang-sql';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { setDiagnostics } from '@codemirror/lint';
import { snippet } from '@codemirror/autocomplete';
import { tags } from '@lezer/highlight';
import { formatSqlScript } from './formatSql';
import { toTemplate } from './snippetTemplate';
import { findToken } from './findToken';

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
// splitBatches (database/sqlBatches.js) is the
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
        // height/width:100% is what makes the editor fill .query-input.
        // position:absolute + inset:0 cannot be used here: CodeMirror's own
        // base theme sets `position: relative !important` on the editor
        // root, and an !important declaration wins over both this theme and
        // an inline style - the editor root is always a relative box.
        height: '100%',
        width: '100%',
        backgroundColor: 'var(--vscode-textCodeBlock-background)',
        color: 'var(--vscode-editor-foreground)',
        fontSize: 'var(--vscode-editor-font-size, 13px)',
        // No outline of its own: the browser's default focus ring would draw
        // a second frame around the editor, and the editor's focus frame is
        // drawn by styles.css on the container (it has to be, to sit above
        // the line-number gutter).
        outline: 'none'
    },
    '.cm-content': {
        fontFamily: 'var(--vscode-editor-font-family)',
        caretColor: 'var(--vscode-editor-foreground)',
        padding: '2px 0',
        // The browser's own focus ring on the contenteditable would draw a
        // second frame around the text column only.
        outline: 'none'
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
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
        backgroundColor: 'var(--vscode-editor-selectionBackground) !important'
    },
    // The find / replace panel (Ctrl+H), in the colors of VS Code's own widgets.
    '.cm-panels': {
        backgroundColor: 'var(--vscode-editorWidget-background)',
        color: 'var(--vscode-editorWidget-foreground, var(--vscode-editor-foreground))'
    },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--vscode-editorWidget-border, transparent)' },
    '.cm-search input, .cm-search button': {
        backgroundColor: 'var(--vscode-input-background)',
        color: 'var(--vscode-input-foreground)',
        border: '1px solid var(--vscode-input-border, transparent)',
        borderRadius: '2px'
    },
    '.cm-search button': { backgroundImage: 'none', cursor: 'pointer' },
    '.cm-search button:hover': { backgroundColor: 'var(--vscode-toolbar-hoverBackground)' },
    '.cm-searchMatch': { backgroundColor: 'var(--vscode-editor-findMatchHighlightBackground)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--vscode-editor-findMatchBackground)' },
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
function baseExtensions(options, historyBox) {
    return [
        placeholder(options.placeholder || ''),
        lineNumbers(),
        historyBox.of(history()),
        drawSelection(),
        dropCursor(),
        bracketMatching(),
        indentOnInput(),
        rectangularSelection(),
        crosshairCursor(),
        EditorState.allowMultipleSelections.of(true),
        // Mod-Enter (Ctrl+Enter) is the extension's "run query" shortcut
        // (queryManager.js). CodeMirror's default binding for it inserts a
        // blank line, which would happen *and* run the query - so that one
        // entry is dropped and the shortcut is left to the extension.
        // Ctrl+F stays the page's own search; Ctrl+H opens find / replace here.
        search({ top: true }),
        keymap.of([{ key: 'Mod-h', run: openSearchPanel, preventDefault: true }, ...searchKeymap.filter(binding => binding.key !== 'Mod-f')]),
        keymap.of([...defaultKeymap.filter(binding => binding.key !== 'Mod-Enter'), ...historyKeymap, indentWithTab]),
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
    // Where the change being dispatched comes from: 'user' when the user
    // typed or asked for the text, 'program' when the code changed it on its
    // own (the text of a script loaded, the text of another tab, the drafts
    // being recovered).
    let changeSource = 'user';
    // The text changed. The 'input' event means the USER typed (or asked for
    // the text): what listens to it - the draft snapshot - must not be woken
    // by a change the code made on its own, or a draft that is being
    // recovered can be written back over. The 'content-changed' event
    // carries every change, with its source.
    const onContentChanged = source => {
        container.dispatchEvent(new CustomEvent('content-changed', { detail: { source } }));
        if (source === 'user') container.dispatchEvent(new Event('input'));
    };
    // The undo history sits in a compartment so it can be emptied (resetHistory).
    const historyBox = new Compartment();

    const view = new EditorView({
        parent: container,
        doc: options.initialDoc || '',
        extensions: [
            ...baseExtensions(options, historyBox),
            keymap.of([{ key: 'Shift-Alt-f', run: () => { container.dispatchEvent(new Event('sw-format')); return true; }, preventDefault: true }]),
            EditorView.updateListener.of((update) => {
                if (update.docChanged) onContentChanged(changeSource);
            })
        ]
    });

    // Dispatches a change of the text, remembering where it comes from.
    const dispatchText = (spec, source) => {
        const previous = changeSource;
        changeSource = source;
        try {
            view.dispatch(spec);
        } finally {
            changeSource = previous;
        }
    };

    container.cmView = view;

    // Forgets what can be undone. For a text that replaces the whole content (a
    // query tab opened): going back with Ctrl+Z would give the text of another tab.
    container.resetHistory = () => {
        view.dispatch({ effects: historyBox.reconfigure([]) });
        view.dispatch({ effects: historyBox.reconfigure(history()) });
    };

    // Inserts a snippet over from..to (the selection when called without a
    // range): its placeholders become fields to Tab through, $CURSOR$ the
    // final caret position, $SELECTEDTEXT$ the text that was selected. One
    // change, so one undo step.
    container.insertSnippet = (sqlText, placeholders = [], from = null, to = null) => {
        const sel = view.state.selection.main;
        const a = from === null ? sel.from : from;
        const b = to === null ? sel.to : to;
        const selected = view.state.sliceDoc(sel.from, sel.to);
        const { template } = toTemplate(sqlText, placeholders, selected);
        view.focus();
        snippet(template)({ state: view.state, dispatch: view.dispatch.bind(view) }, null, a, b);
    };

    // Formats the selection, or the whole script without one: one change, so
    // one undo step. Returns false when the text cannot be parsed (nothing is touched).
    container.formatSql = () => {
        const sel = view.state.selection.main;
        const whole = sel.empty;
        const from = whole ? 0 : sel.from;
        const to = whole ? view.state.doc.length : sel.to;
        const original = view.state.sliceDoc(from, to);
        const formatted = formatSqlScript(original);
        if (formatted === null) return false;
        if (formatted !== original) view.dispatch({ changes: { from, to, insert: formatted }, userEvent: 'input.format' });
        return true;
    };

    // Focus state, in the shape the rest of the webview needs. The element
    // that actually takes focus is CodeMirror's own contenteditable
    // (.cm-content), a *descendant* of the container - so
    // `document.activeElement === container` is never true once the editor
    // has focus, and callers have to ask the adapter instead.
    container.isFocused = () => view.hasFocus;

    // Replaces the whole text. This is what the page does on its own (the
    // text of a script loaded, the text of another tab, the drafts being
    // recovered): the drafts must not follow it as if the user had typed it.
    const setText = (text, source) => {
        const str = text == null ? '' : String(text);
        dispatchText({
            changes: { from: 0, to: view.state.doc.length, insert: str },
            // A <textarea>'s value setter leaves the caret at the end of
            // the new text; CodeMirror would otherwise map the old
            // selection through the replacement and land it at the
            // start, which breaks the autocomplete's context detection.
            selection: { anchor: str.length }
        }, source);
    };

    Object.defineProperty(container, 'value', {
        configurable: true,
        get() { return view.state.doc.toString(); },
        set(text) { setText(text, 'program'); }
    });

    // The text the user asked for (a generated script): the drafts follow it
    // like they follow a typed text.
    container.setUserText = text => setText(text, 'user');
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

    // Replaces a range of the document, the way a <textarea>'s setRangeText()
    // would. Unlike the value setter this is one change in one range: the
    // text around it is not rewritten, and the editor's undo history keeps
    // it as a single step - replacing the whole document would make an
    // inserted snippet undo the entire query.
    container.replaceRange = (from, to, text) => {
        const len = view.state.doc.length;
        const a = Math.max(0, Math.min(from, len));
        const b = Math.max(a, Math.min(to, len));
        const str = text == null ? '' : String(text);
        view.dispatch({
            changes: { from: a, to: b, insert: str },
            // The caret lands right after the inserted text, like it does
            // when a snippet is typed.
            selection: { anchor: a + str.length },
            scrollIntoView: true
        });
    };
    // Puts the caret on a line (1-based) and selects it, scrolled into view.
    // Beyond the document, the last line.
    container.goToLine = (lineNumber) => {
        const doc = view.state.doc;
        const line = doc.line(Math.max(1, Math.min(Number(lineNumber) || 1, doc.lines)));
        view.dispatch({ selection: { anchor: line.from, head: line.to }, scrollIntoView: true });
        view.focus();
    };

    container.focus = () => view.focus();

    // Underlines what the server reported: [{ line, message, near }], lines from
    // 1. The word the server pointed at ("near 'FROM'") when it is on the line,
    // else the line itself. An empty list clears them. The positions follow
    // the edits made afterwards.
    container.setDiagnostics = (items) => {
        const doc = view.state.doc;
        const diagnostics = [];
        for (const item of items || []) {
            if (!(item.line >= 1 && item.line <= doc.lines)) continue;
            const line = doc.line(item.line);
            let from = line.from + (line.text.length - line.text.trimStart().length);
            let to = line.to;
            const found = findToken(line.text, item.near);
            if (found) { from = line.from + found.from; to = line.from + found.to; }
            if (to <= from) { from = line.from; to = Math.max(line.to, Math.min(line.from + 1, doc.length)); }
            if (to > from) diagnostics.push({ from, to, severity: 'error', message: item.message, source: 'SQL Server' });
        }
        view.dispatch(setDiagnostics(view.state, diagnostics));
    };
    // 'scroll' doesn't bubble, and the element that actually scrolls is
    // view.scrollDOM (a descendant of container, CM's own .cm-scroller) -
    // forward it so a plain container.addEventListener('scroll', ...), as
    // sqlAutocomplete.js uses to close the dropdown, keeps working.
    view.scrollDOM.addEventListener('scroll', () => container.dispatchEvent(new Event('scroll')));
    // Same story for 'blur': it doesn't bubble either, and the element that
    // holds the focus is contentDOM - so the container never sees a blur
    // unless it is forwarded explicitly.
    view.contentDOM.addEventListener('blur', () => container.dispatchEvent(new Event('blur')));

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

// A read-only view of some SQL - the definition shown by the Code tab of the
// Explorer - with the same colours as the query editor. setLineNumbers() shows
// or hides the gutter without rebuilding the view.
function readOnlyView(container, doc, options = {}) {
    const gutter = new Compartment();
    const view = new EditorView({
        parent: container,
        doc: doc || '',
        extensions: [
            EditorState.readOnly.of(true),
            gutter.of(options.lineNumbers ? lineNumbers() : []),
            drawSelection(),
            sql({ dialect: MSSQL }),
            syntaxHighlighting(sqlHighlightStyle),
            goHighlighter,
            vsCodeTheme,
            EditorView.theme({ '.cm-content': { padding: '10px 0' } }),
            EditorView.lineWrapping
        ]
    });
    return {
        setLineNumbers(on) { view.dispatch({ effects: gutter.reconfigure(on ? lineNumbers() : []) }); },
        destroy() { view.destroy(); }
    };
}

window.SqlCodeMirror = { attach, readOnlyView, formatSql: formatSqlScript };
