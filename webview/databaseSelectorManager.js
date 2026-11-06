/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Database selector UI manager
class DatabaseSelectorManager {
    constructor() {
        this.databaseSelect = document.getElementById('databaseSelect');
    }

    showReadyGlow() {
        // Once per tab: reopening the Explorer must not nag again.
        if (this._glowShown) return;
        this._glowShown = true;
        this.databaseSelect.classList.add('database-ready-glow');

        setTimeout(() => {
            this.databaseSelect.classList.remove('database-ready-glow');
        }, 2000);

        this.showReadyNotification();
    }

    showReadyNotification() {
        const notification = document.createElement('div');
        notification.className = 'database-ready-notification';
        notification.innerHTML = `
            <span class="notification-icon"><i class="codicon codicon-database"></i></span>
            <span class="notification-text">Connected. Select a database to explore.</span>
        `;

        const toolbar = document.querySelector('.app-toolbar');
        toolbar.appendChild(notification);

        setTimeout(() => {
            if (notification.parentNode) {
                notification.classList.add('fade-out');
                setTimeout(() => {
                    notification.parentNode.removeChild(notification);
                }, 300);
            }
        }, 4000);
    }
}
