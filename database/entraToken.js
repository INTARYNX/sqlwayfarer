'use strict';

// Microsoft Entra ID (Azure AD) sign-in for Azure SQL. The token comes from
// the Microsoft account already signed in to VS Code, so nothing secret is
// stored by the extension.

// Scope of the Azure SQL resource, whatever the cloud (public, sovereign).
const AZURE_SQL_SCOPE = 'https://database.windows.net/.default';

// A token is renewed once it has less than this left...
const REFRESH_MARGIN_MS = 15 * 60 * 1000;
// ...checked at this pace.
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// Expiry (epoch ms) read from the `exp` claim of a JWT, or null when the
// token is not one we can read.
function jwtExpiry(token) {
    try {
        const payload = String(token).split('.')[1];
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
    } catch {
        return null;
    }
}

// Holds the current access token of one connection. The mssql pool opens a
// new physical connection whenever it needs one (idle connections are closed
// after 30 s), each time reading the token again - so a token that is kept
// fresh here keeps the whole pool working past the ~1 h life of a token.
class EntraTokenSource {
    // getToken({ silent }) resolves to an access token string, or to a falsy
    // value when none can be had without asking the user (silent mode).
    constructor(getToken, { now = Date.now } = {}) {
        this._getToken = getToken;
        this._now = now;
        this._token = null;
        this._expiresAt = 0;
        this._timer = null;
    }

    get current() {
        return this._token;
    }

    // Interactive on purpose: this is the sign-in the user asked for by
    // pressing Connect. Throws when the user declines it.
    async acquire() {
        await this._fetch(false);
        if (!this._token) throw new Error('Microsoft sign-in was cancelled or returned no token');
        return this._token;
    }

    // Silent renewal, only when the token is about to expire. Never throws:
    // on failure the current token stays, and the next query that needs a new
    // physical connection reports the real error.
    async refreshIfNeeded() {
        if (this._expiresAt - this._now() > REFRESH_MARGIN_MS) return;
        try {
            await this._fetch(true);
        } catch (error) {
            console.warn('Entra token refresh failed:', error);
        }
    }

    start(intervalMs = REFRESH_INTERVAL_MS) {
        this.stop();
        this._timer = setInterval(() => { this.refreshIfNeeded(); }, intervalMs);
    }

    stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
    }

    async _fetch(silent) {
        const token = await this._getToken({ silent });
        if (!token) return;
        this._token = token;
        // Unreadable expiry: assume one hour, the usual life of these tokens.
        this._expiresAt = jwtExpiry(token) ?? this._now() + 60 * 60 * 1000;
    }
}

// getToken backed by the Microsoft authentication provider of VS Code.
function createVsCodeTokenFetcher(vscode) {
    return async ({ silent }) => {
        const options = silent ? { silent: true } : { createIfNone: true };
        const session = await vscode.authentication.getSession('microsoft', [AZURE_SQL_SCOPE], options);
        return session ? session.accessToken : null;
    };
}

module.exports = { AZURE_SQL_SCOPE, REFRESH_MARGIN_MS, jwtExpiry, EntraTokenSource, createVsCodeTokenFetcher };
