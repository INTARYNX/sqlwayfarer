import globals from "globals";

export default [{
    ignores: ["dist/**", "webview/vendor/**", "webview/codicons/**", ".vscode-test/**", "database/generated/**"],
}, {
    // The extension host: CommonJS (require / module.exports), Node runtime.
    files: ["**/*.js"],
    languageOptions: {
        globals: {
            ...globals.commonjs,
            ...globals.node,
            ...globals.mocha,
        },

        ecmaVersion: 2022,
        sourceType: "commonjs",
    },

    rules: {
        "no-const-assign": "error",
        "no-this-before-super": "error",
        "no-undef": "error",
        "no-unreachable": "error",
        "no-unused-vars": "error",
        "constructor-super": "error",
        "valid-typeof": "error",
    },
}, {
    // The test files are indented with tabs (AGENTS.md).
    files: ["test/**/*.js"],
    rules: {
        indent: ["error", "tab", { SwitchCase: 1 }],
    },
},
{
    // The e2e suites run callbacks inside the browser page (window, document...).
    files: ["test/e2e/**/*.js", "test/tools/auditLayout.js"],
    languageOptions: {
        sourceType: "commonjs",
        globals: { ...globals.node, ...globals.mocha, ...globals.browser, appState: "readonly", DependencyVisualizer: "readonly" },
    },
},

{
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
            SqlContext: "readonly",
            SqlMatcher: "readonly",
            QueryManager: "readonly",
            TabManager: "readonly",
            SnippetManager: "readonly",
            QueryFileManager: "readonly",
            InstanceTree: "readonly",
            CompareManager: "readonly",
            RecentChanges: "readonly",
            LineDiff: "readonly",
            FootprintManager: "readonly",
            IndexStatsView: "readonly",
            TempTableScript: "readonly",
            SchemaSourceManager: "readonly",
            ConnectionStatus: "readonly",
            swIcon: "readonly",
            swObjectIcon: "readonly",
            SidebarConnections: "readonly",
            CommentsManager: "readonly",
            CodeViewManager: "readonly",
            ObjectsTabManager: "readonly",
            QueryResultsMethods: "readonly",
            QueryFormattingMethods: "readonly",
            QuerySnippetsMethods: "readonly",
            ExplorerManager: "readonly",
            ExplorerObjectListMethods: "readonly",
            ExplorerDetailsMethods: "readonly",
            FilterManager: "readonly",
            DependencyVisualizer: "readonly",
            DatabaseSelectorManager: "readonly",
            DetailsTabManager: "readonly",
            IndexingModalManager: "readonly",
            Viz: "readonly",
            QP: "readonly",
        },
    },

    rules: {
        // Top-level classes/consts are the shared API of the other scripts.
        "no-unused-vars": ["error", { vars: "local" }],
    },
}, {
    // CodeMirror bundle entry point (ES modules, built by webpack).
    files: ["webview-build/**/*.js"],
    languageOptions: {
        sourceType: "module",
        globals: { ...globals.browser },
    },
}];
