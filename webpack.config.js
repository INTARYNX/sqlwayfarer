const path = require('path');

module.exports = {
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