'use strict';

const vscode = require('vscode');

const STATE_KEY = 'sqlwayfarer.ratingPrompt';
const MARKETPLACE_URL = 'https://marketplace.visualstudio.com/items?itemName=intarynx.sqlwayfarer';

// Only ask once the tool has actually proven itself - a rating request
// thrown at someone who just installed the extension is noise.
const MIN_QUERIES = 10;
// And never more than once a month: a review is worth more if it comes from
// someone who likes the tool than from someone annoyed by a second popup.
const COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

// Whether the "leave a review" nudge is due. Pure, so the rule can be
// tested without VS Code.
function shouldAsk({ successfulQueries, lastAskedAt, now = Date.now(), minQueries = MIN_QUERIES, cooldownMs = COOLDOWN_MS }) {
    if (successfulQueries < minQueries) return false;
    if (!lastAskedAt) return true;
    return (now - lastAskedAt) >= cooldownMs;
}

async function defaultShow() {
    const choice = await vscode.window.showInformationMessage(
        'Enjoying SQL Wayfarer? A short review on the Marketplace helps other developers find it.',
        'Leave a review',
        'Not now'
    );
    return choice === 'Leave a review' ? 'review' : 'later';
}

// Asks the user, once in a while, to rate the extension on the Marketplace.
// The Marketplace shows the rating and the number of ratings right in the
// search results, which is the one discovery channel that needs nothing from
// the author: no post, no forum, no announcement.
class RatingPrompt {
    constructor(context, { showNotification } = {}) {
        this._context = context;
        this._show = showNotification || defaultShow;
    }

    // Called after every successful query.
    async onQuerySucceeded() {
        const state = this._context.globalState.get(STATE_KEY, {}) || {};
        const successfulQueries = (state.successfulQueries || 0) + 1;
        await this._context.globalState.update(STATE_KEY, { ...state, successfulQueries });

        if (!shouldAsk({ successfulQueries, lastAskedAt: state.lastAskedAt })) return;

        // Mark it as asked straight away, whatever the answer: being asked
        // twice is worse than missing an opportunity.
        await this._context.globalState.update(STATE_KEY, { successfulQueries, lastAskedAt: Date.now() });

        const choice = await this._show();
        if (choice === 'review') {
            await vscode.env.openExternal(vscode.Uri.parse(MARKETPLACE_URL));
        }
    }
}

module.exports = { RatingPrompt, shouldAsk, MIN_QUERIES, COOLDOWN_MS, MARKETPLACE_URL };
