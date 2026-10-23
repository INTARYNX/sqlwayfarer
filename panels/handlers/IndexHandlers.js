'use strict';

const vscode = require('vscode');

class IndexHandlers {
    constructor(postMessage, indexService, dependencyService, getCurrentDatabase) {
        this._post = postMessage;
        this._indexService = indexService;
        this._dependencyService = dependencyService;
        this._getCurrentDatabase = getCurrentDatabase;
        this._indexingInProgress = false;
    }

    cancel() {
        this._indexingInProgress = false;
        this._indexService.requestCancel();
    }

    async handleConfirmForceReindex(database) {
        try {
            const selection = await vscode.window.showWarningMessage(
                `Are you sure you want to force reindex database "${database}"?\n\nThis will clear the existing index and rebuild it from scratch.`,
                { modal: true },
                'Yes, Force Reindex',
                'Cancel'
            );
            if (selection === 'Yes, Force Reindex') {
                this._post({ command: 'forceReindexConfirmed', database });
            }
        } catch (error) {
            console.error('Error showing confirmation dialog:', error);
            this._post({ command: 'error', message: 'Failed to show confirmation dialog' });
        }
    }

    async handleForceReindex(database) {
        try {
            if (!database) {
                this._post({ command: 'error', message: 'No database specified for force reindex' });
                return;
            }

            console.log(`Force reindexing database: ${database}`);
            this._post({ command: 'indexingStarted', database, forced: true });

            const progressCallback = (progress) => {
                this._post({ command: 'indexingProgress', database, progress: progress.progress, current: progress.current, total: progress.total, message: progress.message });
            };

            const index = await this._indexService.forceReindex(database, progressCallback);
            this._post({ command: 'indexResult', indexData: index });
            this._post({ command: 'indexingCompleted', database, success: true, forced: true, message: 'Force reindex completed successfully' });
            console.log(`Force reindex completed for database: ${database}`);

        } catch (error) {
            if (error.code === 'INDEXING_CANCELLED') {
                console.log(`Force reindex cancelled for database: ${database}`);
                return;
            }
            console.error('Error force reindexing:', error);
            this._post({ command: 'indexingCompleted', database, success: false, forced: true, message: `Force reindex failed: ${error.message}` });
            this._post({ command: 'error', message: `Failed to force reindex: ${error.message}` });
        }
    }

    async handleCancelIndexing() {
        try {
            console.log('Canceling indexing operation');
            this._indexingInProgress = false;
            this._indexService.requestCancel();

            const currentDb = this._getCurrentDatabase();
            if (currentDb) {
                try {
                    await this._indexService.clearIndex(currentDb);
                } catch (clearError) {
                    console.warn('Error clearing index during cancellation:', clearError);
                }
            }

            this._post({ command: 'indexingCancelled', message: 'Indexing operation cancelled', success: true });
        } catch (error) {
            console.error('Error cancelling indexing:', error);
            this._post({ command: 'indexingCancelled', message: `Error cancelling indexing: ${error.message}`, success: false });
        }
    }

    async handleGetIndexStats(database) {
        try {
            const targetDatabase = database || this._getCurrentDatabase();
            if (!targetDatabase) {
                this._post({ command: 'error', message: 'No database selected' });
                return;
            }

            const stats = await this._indexService.getIndexStats(targetDatabase);
            stats.indexingInProgress = this._indexingInProgress;
            this._post({ command: 'indexStatsResult', database: targetDatabase, stats });
        } catch (error) {
            console.error('Error getting index stats:', error);
            this._post({ command: 'error', message: `Failed to get index stats: ${error.message}` });
        }
    }

    // The only entry point that builds/loads the dependency index now - fired
    // once when the user opens the Explorer tab (or switches database while
    // already there), never automatically on connect. Cheap when the cached
    // index's schema checksum still matches; a real (progress-reported) build
    // otherwise.
    async handleGetIndex(database) {
        if (!database) {
            this._post({ command: 'error', message: 'No database specified for indexing' });
            return;
        }

        this._indexingInProgress = true;
        try {
            const progressCallback = (progress) => {
                this._post({ command: 'indexingProgress', database, progress: progress.progress, current: progress.current, total: progress.total, message: progress.message });
            };

            const index = await this._indexService.getIndex(database, progressCallback);
            this._post({ command: 'indexResult', indexData: index });
            console.log(`Index retrieved for database: ${database}`);

        } catch (error) {
            if (error.code === 'INDEXING_CANCELLED') {
                this._post({ command: 'indexResult', indexData: null });
                return;
            }
            console.error('Error getting index:', error);
            this._post({ command: 'indexResult', indexData: null });

            const errorMsg = this._getUserFriendlyIndexingError(error);
            vscode.window.showWarningMessage(`Database indexing failed: ${errorMsg}`, 'Retry', 'Ignore')
                .then(selection => {
                    if (selection === 'Retry') {
                        setTimeout(() => this.handleGetIndex(database), 2000);
                    }
                });
        } finally {
            this._indexingInProgress = false;
        }
    }

    _getUserFriendlyIndexingError(error) {
        const msg = error.message || '';
        if (msg.includes('timeout')) return 'The indexing operation timed out. The database may be too large or the connection is slow.';
        if (msg.includes('permission') || msg.includes('denied')) return 'Permission denied. Ensure the user has VIEW DEFINITION rights.';
        if (msg.includes('connection')) return 'Connection lost during indexing. Please reconnect and try again.';
        return msg;
    }
}

module.exports = IndexHandlers;
