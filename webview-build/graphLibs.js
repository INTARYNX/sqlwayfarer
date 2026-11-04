'use strict';

// The libraries of the footprint graph, built from the versions npm installs
// instead of copied by hand: cytoscape and its dagre layout (which carries
// dagre itself). The webview reads them from the page's global scope.
window.cytoscape = require('cytoscape');
window.cytoscapeDagre = require('cytoscape-dagre');
