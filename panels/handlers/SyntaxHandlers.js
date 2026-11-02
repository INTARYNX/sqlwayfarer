'use strict';

const MAX_CHARS = 300000;
const BACKOFF_MS = 30000;

// The syntax check of the query editor (see database/SyntaxChecker.js): the
// page sends its text after a pause in typing, the answer comes back with the
// request id so a late answer for an old text is ignored there. Checks run one
// at a time and only the latest text waits: typing never builds a queue.
class SyntaxHandlers {
    // checker: { check(text), reset() }. isEnabled(): the setting.
    constructor(postMessage, checker, isEnabled, now = () => Date.now()) {
        this._post = postMessage;
        this._checker = checker;
        this._isEnabled = isEnabled;
        this._now = now;
        this._running = false;
        this._waiting = null;
        this._retryAt = 0;
    }

    async handleCheckSyntax(requestId, text) {
        this._waiting = { requestId, text };
        if (this._running) return;
        this._running = true;
        try {
            while (this._waiting) {
                const job = this._waiting;
                this._waiting = null;
                this._post(Object.assign({ command: 'syntaxResult', requestId: job.requestId }, await this._run(job.text)));
            }
        } finally {
            this._running = false;
        }
    }

    async _run(text) {
        if (!this._isEnabled() || typeof text !== 'string' || text.length > MAX_CHARS) return { diagnostics: [] };
        if (this._now() < this._retryAt) return { diagnostics: [], unavailable: true };
        try {
            return { diagnostics: await this._checker.check(text) };
        } catch (error) {
            // Not asked again for a while: a server that cannot be reached must not cost a try per keystroke.
            console.warn('Syntax check unavailable:', error.message);
            this._retryAt = this._now() + BACKOFF_MS;
            return { diagnostics: [], unavailable: true, message: error.message };
        }
    }

    // The connection of the tab changed (reconnect, another server): start afresh.
    async reset() {
        this._retryAt = 0;
        await this._checker.reset();
    }
}

module.exports = SyntaxHandlers;
