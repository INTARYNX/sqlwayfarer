/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

const vscode = require('vscode');

/**
 * Index Handlers - background indexing, force reindex, stats
 */
class IndexHandlers {
    constructor(postMessage, indexService, dependencyService, getCurrentDatabase) {
        this._post = postMessage;
        this._indexService = indexService;
        this._dependencyService = dependencyService;
        this._getCurrentDatabase = getCurrentDatabase;
        this._indexingInProgress = false;
    }

    get isIndexing() {
        return this._indexingInProgress;
    }

    cancel() {
        this._indexingInProgress = false;
    }

    async startBackgroundIndexing(database) {
        if (this._indexingInProgress) {
            console.log('Indexing already in progress, skipping');
            return;
        }

        this._indexingInProgress = true;

        try {
            this._post({ command: 'indexingStarted', database });

            const progressCallback = (progress) => {
                try {
                    this._post({ command: 'indexingProgress', database, progress: progress.progress, current: progress.current, total: progress.total, message: progress.message });
                } catch (err) {
                    console.error('Error sending progress update:', err);
                }
            };

            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Indexing timeout after 5 minutes')), 300000)
            );
            await Promise.race([this._indexService.getIndex(database, progressCallback), timeoutPromise]);

            this._post({ command: 'indexingCompleted', database, success: true, message: 'Database indexing completed successfully' });
            console.log(`Background indexing completed successfully for database: ${database}`);

        } catch (error) {
            console.error('Background indexing failed:', error);
            this._post({ command: 'indexingCompleted', database, success: false, message: `Indexing failed: ${error.message}` });

            const errorMsg = this._getUserFriendlyIndexingError(error);
            vscode.window.showWarningMessage(`Database indexing failed: ${errorMsg}`, 'Retry', 'Ignore')
                .then(selection => {
                    if (selection === 'Retry') {
                        setTimeout(() => {
                            this._indexingInProgress = false;
                            this.startBackgroundIndexing(database);
                        }, 2000);
                    }
                });
        } finally {
            this._indexingInProgress = false;
        }
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
            console.error('Error force reindexing:', error);
            this._post({ command: 'indexingCompleted', database, success: false, forced: true, message: `Force reindex failed: ${error.message}` });
            this._post({ command: 'error', message: `Failed to force reindex: ${error.message}` });
        }
    }

    async handleCancelIndexing() {
        try {
            console.log('Canceling indexing operation');
            this._indexingInProgress = false;

            const currentDb = this._getCurrentDatabase();
            if (currentDb && typeof this._dependencyService.clearIndex === 'function') {
                try {
                    await this._dependencyService.clearIndex(currentDb);
                    console.log('Index cleared during cancellation');
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

            const stats = {
                exists: false,
                objectCount: 0,
                lastIndexed: null,
                indexingInProgress: this._indexingInProgress
            };

            if (this._dependencyService && typeof this._dependencyService.getIndex === 'function') {
                try {
                    stats.exists = true;
                    stats.lastIndexed = new Date().toISOString();
                } catch (indexError) {
                    console.warn('Index not accessible:', indexError);
                }
            }

            this._post({ command: 'indexStatsResult', database: targetDatabase, stats });
        } catch (error) {
            console.error('Error getting index stats:', error);
            this._post({ command: 'error', message: `Failed to get index stats: ${error.message}` });
        }
    }

    async handleGetIndex(database) {
        try {
            if (!database) {
                this._post({ command: 'error', message: 'No database specified for indexing' });
                return;
            }

            const progressCallback = (progress) => {
                this._post({ command: 'indexingProgress', database, progress: progress.progress, current: progress.current, total: progress.total, message: progress.message });
            };

            const index = await this._indexService.getIndex(database, progressCallback);
            this._post({ command: 'indexResult', indexData: index });
            console.log(`Index retrieved for database: ${database}`);

        } catch (error) {
            console.error('Error getting index:', error);
            this._post({ command: 'indexResult', indexData: null });
            this._post({ command: 'error', message: `Failed to get index: ${error.message}` });
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
