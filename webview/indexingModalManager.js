/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Blocking modal shown while database indexing is running
class IndexingModalManager {
    constructor() {
        this.overlay = document.getElementById('indexingModalOverlay');
        this.messageEl = document.getElementById('indexingModalMessage');
        this.progressFill = document.getElementById('indexingProgressFill');
        this.progressText = document.getElementById('indexingProgressText');
        this.cancelBtn = document.getElementById('indexingCancelBtn');
        this._previousFocus = null;
        this.database = null;
        this.cancelBtn.addEventListener('click', () => {
            this.cancelBtn.disabled = true;
            this.messageEl.textContent = 'Cancelling…';
            // Cancel the build the modal actually shows, not whatever database
            // the dropdown happens to be on right now (the user may have
            // switched away while this indexing run kept going in the background).
            vscode.postMessage({ command: 'cancelIndexing', database: this.database });
        });
        // Focus trap: the overlay blocks the clicks but not the keyboard -
        // without it, a Ctrl+Enter in the query editor would run a query on
        // the single connection while the indexing is going, and Tab would
        // reach the UI in the background.
        document.addEventListener('keydown', (e) => {
            if (!this.overlay.classList.contains('visible')) return;
            if (e.key === 'Tab' || !this.overlay.contains(e.target)) {
                e.preventDefault();
                e.stopPropagation();
                this.cancelBtn.focus();
            }
        }, true);
    }

    show(message, database) {
        this.database = database;
        this.messageEl.textContent = message;
        this.progressFill.style.width = '0%';
        this.progressText.textContent = '';
        this.cancelBtn.disabled = false;
        this.overlay.classList.add('visible');
        this._previousFocus = document.activeElement;
        this.cancelBtn.focus();
    }

    updateProgress(progress, current, total, message) {
        this.progressFill.style.width = `${progress}%`;
        this.progressText.textContent = `${progress}% (${current}/${total})`;
        if (message) {
            this.messageEl.textContent = message;
        }
    }

    hide() {
        this.overlay.classList.remove('visible');
        if (this._previousFocus && typeof this._previousFocus.focus === 'function') {
            this._previousFocus.focus();
        }
        this._previousFocus = null;
        this.database = null;
    }
}
