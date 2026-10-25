const path = require('path');

const extensionConfig = {
  name: 'extension',
  target: 'node',
  entry: {
    extension: './extension.js',
    // Separate bundle: runs in a worker_threads Worker (database/ParserWorkerPool.js),
    // not inside the main extension host process.
    parseColumnsWorker: './database/parseColumnsWorker.js'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode',
    // piscina resolves its own internal worker bootstrap script relative to
    // its package's __dirname at runtime - bundling it would break that
    // (the bundled __dirname would point at dist/, not node_modules/piscina/dist/).
    piscina: 'commonjs piscina'
  },
  resolve: {
    extensions: ['.js']
  },
  mode: 'production'
};

// Everything else under webview/ is loaded as-is by SqlWayfarerPanel.js (no
// bundler, plain <script> tags under the webview's CSP). CodeMirror 6 is the
// one exception: it ships as ~15 modular ESM packages, not something you can
// vendor as a single script by hand, so webview-build/sqlEditor.js is bundled
// here (target 'web', unlike the extension host's 'node' config above) into
// dist/webview/sqlEditor.js and loaded the same way as any other vendored script.
const webviewConfig = {
  name: 'webview',
  target: 'web',
  entry: {
    sqlEditor: './webview-build/sqlEditor.js'
  },
  output: {
    path: path.resolve(__dirname, 'dist', 'webview'),
    filename: '[name].js'
  },
  resolve: {
    extensions: ['.js']
  },
  mode: 'production',
  // Served locally from disk to a webview, not fetched over a network -
  // webpack's web-page-sized performance budget doesn't apply here.
  performance: { hints: false }
};

module.exports = [extensionConfig, webviewConfig];