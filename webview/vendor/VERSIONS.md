# The libraries the webview loads as they are

They are loaded by the webview as they are, not bundled by webpack (CodeMirror
and the footprint graph libraries are, see `webpack.config.js`). They are copied here by
hand, so this file is what says **which version** is shipped and **under what
license**: a copied file carries neither in its name, and `npm audit` does not
see it.

| File | Library | Version | License |
|---|---|---|---|
| `viz.js` | [Viz.js](https://github.com/mdaines/viz-js) | 2.1.2 | MIT |
| `viz.full.render.js` | [Viz.js](https://github.com/mdaines/viz-js) (the render engine of the build above) | 2.1.2 | MIT |
| `html-query-plan/qp.min.js`, `qp.css`, `qp_icons.png` | [html-query-plan](https://github.com/anthonyjgraves/html-query-plan) | unknown | MIT |

`viz.js` and `viz.full.render.js` are two halves of the same build: the first
is the API, the second the Graphviz engine it calls. Viz.js bundles Graphviz
2.40.1 (Eclipse Public License 1.0), Expat 2.2.5 (MIT) and zlib (zlib
license) - the notice of `viz.js` lists them all.

## What is not here any more

`cytoscape` and `cytoscape-dagre` (which carries dagre) are built from the
versions npm installs, by webpack (`webview-build/graphLibs.js`, output
`dist/webview/graphLibs.js`): bumping the dependency is enough.

## Loaded on demand

`viz.js` and `viz.full.render.js` (1.98 MB, the Graphviz engine) are not
loaded with the page: `DependencyVisualizer.initViz()` (webview/main.js) loads
them the first time a dependency graph is drawn.

## How a file is added here

1. Take the **minified** build of the version above, from its release page.
2. Keep the license notice at the top of the file.
3. Add the row to the table above.
4. Check that the file is still in the package: `npx vsce ls | grep vendor`.
