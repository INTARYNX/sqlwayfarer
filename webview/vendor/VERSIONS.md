# The libraries the webview loads as they are

They are loaded with plain `<script>` tags by the webview, not bundled by
webpack (only CodeMirror is, see `webpack.config.js`). They are copied here by
hand, so this file is what says **which version** is shipped and **under what
license**: a copied file carries neither in its name, and `npm audit` does not
see it.

| File | Library | Version | License |
|---|---|---|---|
| `cytoscape.min.js` | [cytoscape.js](https://js.cytoscape.org) | 3.34.0 | MIT |
| `cytoscape-dagre.min.js` | [cytoscape-dagre](https://github.com/cytoscape/cytoscape-dagre) | 3.0.0 | MIT |
| `dagre.min.js` | [dagre](https://github.com/dagrejs/dagre) | 0.8.5 | MIT |
| `viz.js` | [Viz.js](https://github.com/mdaines/viz-js) | 2.1.2 | MIT |
| `viz.full.render.js` | [Viz.js](https://github.com/mdaines/viz-js) (the render engine of the build above) | 2.1.2 | MIT |
| `html-query-plan/qp.min.js`, `qp.css`, `qp_icons.png` | [html-query-plan](https://github.com/anthonyjgraves/html-query-plan) | unknown | MIT |

`viz.js` and `viz.full.render.js` are two halves of the same build: the first
is the API, the second the Graphviz engine it calls. Viz.js bundles Graphviz
2.40.1 (Eclipse Public License 1.0), Expat 2.2.5 (MIT) and zlib (zlib
license) - the notice of `viz.js` lists them all.

## Two things to know before changing this folder

- **`cytoscape`, `cytoscape-dagre` and `dagre` are already in the
  `devDependencies`.** The copies here are the ones the webview loads, and
  they can drift from what npm installs: `cytoscape-dagre` is 3.0.0 here and
  4.0.1 in `node_modules`. Bumping the dependency does **not** change what
  ships - the file in this folder has to be replaced too.
- **The graph libraries are needed only when a graph is opened**, but all of
  them are parsed by the browser every time the panel is opened: 2.9 MB, of
  which `viz.full.render.js` alone is 1.98 MB. They are the first thing to
  make lazy.

## How a file is added here

1. Take the **minified** build of the version above, from its release page.
2. Keep the license notice at the top of the file.
3. Add the row to the table above.
4. Check that the file is still in the package: `npx vsce ls | grep vendor`.
