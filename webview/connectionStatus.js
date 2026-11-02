/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// The connection of this tab. The tab is opened for one saved connection (see
// the sidebar's connection list) and connects as soon as the page is up: this
// class owns the screen that covers the app until then, and that explains a
// failure with a Retry.
class ConnectionStatus {
    constructor() {
        this.overlay = document.getElementById('appLoading');
        this.spinner = document.getElementById('appLoadingSpinner');
        this.title = document.getElementById('appLoadingTitle');
        this.detail = document.getElementById('appLoadingDetail');
        this.retryBtn = document.getElementById('appLoadingRetryBtn');
        this.icon = document.getElementById('appLoadingIcon');
        this.hint = document.getElementById('appLoadingHint');
        this.retryBtn.addEventListener('click', () => this.retry());
        this.banner = document.getElementById('connectionBanner');
        this.bannerText = document.getElementById('connectionBannerText');
        this.bannerBtn = document.getElementById('connectionBannerBtn');
        this.bannerBtn.addEventListener('click', () => this.reconnect());
        // True once the tab was connected: from then on a failed connection is
        // reported in the banner, the app stays where it is.
        this.connectedOnce = false;
        this.startLoadingHintTimer();
    }

    // If the app is still not up after a while, say so instead of leaving a
    // spinner turning - "is it stuck?" is the wrong question to have to ask
    // about a blank panel.
    startLoadingHintTimer() {
        clearTimeout(this._loadingHintTimer);
        this._loadingHintTimer = setTimeout(() => {
            if (!this.overlay.isConnected) return;
            this.detail.textContent = 'Still connecting… - if this does not go away, check the extension host log (Developer: Toggle Developer Tools > Console) for errors.';
        }, 20000);
    }

    // Returns true for the first successful connection of the tab.
    onConnectionStatus(message) {
        if (this.connectedOnce) {
            // A reconnection: nothing to cover, nothing to leave.
            if (message.success) this.hideBanner();
            else this.showBanner(message.message, 'Retry');
            return false;
        }
        if (message.success) {
            clearTimeout(this._loadingHintTimer);
            appState.isConnected = true;
            this.connectedOnce = true;
            this.overlay.remove();
            return true;
        }
        clearTimeout(this._loadingHintTimer);
        this.spinner.style.display = 'none';
        this.icon.style.display = '';
        this.title.textContent = 'Could not connect';
        this.detail.textContent = message.message;
        this.hint.style.display = '';
        this.retryBtn.style.display = '';
        return false;
    }

    // The server stopped answering after the tab was up.
    onConnectionLost(message) {
        this.showBanner(message || 'The connection to the server was lost.', 'Reconnect');
    }

    showBanner(text, buttonLabel) {
        this.bannerText.textContent = text;
        this.bannerBtn.textContent = buttonLabel;
        this.bannerBtn.disabled = false;
        this.banner.hidden = false;
    }

    hideBanner() {
        this.banner.hidden = true;
    }

    reconnect() {
        this.bannerText.textContent = 'Reconnecting…';
        this.bannerBtn.disabled = true;
        vscode.postMessage({ command: 'reconnect' });
    }

    retry() {
        this.spinner.style.display = '';
        this.icon.style.display = 'none';
        this.title.textContent = 'Connecting…';
        this.detail.textContent = '';
        this.hint.style.display = 'none';
        this.retryBtn.style.display = 'none';
        this.startLoadingHintTimer();
        vscode.postMessage({ command: 'retryConnection' });
    }

    // Errors only have a place to show while the overlay is up.
    showStatus(message) {
        if (this.overlay.isConnected) this.detail.textContent = message;
    }
}
