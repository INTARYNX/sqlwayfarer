import globals from "globals";

export default [{
    ignores: ["dist/**", "webview/vendor/**", "webview/codicons/**", ".vscode-test/**", "database/generated/**"],
}, {
    files: ["**/*.js"],
    languageOptions: {
        globals: {
            ...globals.commonjs,
            ...globals.node,
            ...globals.mocha,
        },

        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "no-const-assign": "warn",
        "no-this-before-super": "warn",
        "no-undef": "warn",
        "no-unreachable": "warn",
        "no-unused-vars": "warn",
        "constructor-super": "warn",
        "valid-typeof": "warn",
    },
}, {
    // Browser side: classic <script> tags sharing one global scope, plus the
    // VS Code webview API.
    files: ["webview/**/*.js"],
    languageOptions: {
        sourceType: "script",
        globals: {
            ...globals.browser,
            acquireVsCodeApi: "readonly",
            // Declared in one <script> file, used by the others (and vendor libs).
            vscode: "readonly",
            appState: "readonly",
            BUILTIN_SNIPPETS: "readonly",
            FileTree: "readonly",
            SqlAutocomplete: "readonly",
            QueryManager: "readonly",
            TabManager: "readonly",
            SnippetManager: "readonly",
            QueryFileManager: "readonly",
            FootprintManager: "readonly",
            ConnectionManager: "readonly",
            CommentsManager: "readonly",
            CodeViewManager: "readonly",
            Viz: "readonly",
            QP: "readonly",
        },
    },

    rules: {
        // Top-level classes/consts are the shared API of the other scripts.
        "no-unused-vars": ["warn", { vars: "local" }],
    },
}, {
    // CodeMirror bundle entry point (ES modules, built by webpack).
    files: ["webview-build/**/*.js"],
    languageOptions: {
        globals: { ...globals.browser },
    },
}];
