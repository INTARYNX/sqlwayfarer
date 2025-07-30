'use strict';

class SmartSqlParser {
    constructor(connectionManager, databaseService) {
        // We don't actually need these anymore
    }

    analyzeDependencies(database, objectName) {
        // This is now handled directly in DependencyService
        return { dependsOn: [], referencedBy: [] };
    }

    dispose() {
        // Nothing to dispose
    }
}

module.exports = SmartSqlParser;