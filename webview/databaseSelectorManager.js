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
        this.placeUnderSelect(notification, toolbar);

        setTimeout(() => {
            if (notification.parentNode) {
                notification.classList.add('fade-out');
                setTimeout(() => {
                    notification.parentNode.removeChild(notification);
                }, 300);
            }
        }, 4000);
    }

    // Under the database selector, its arrow pointing at the middle of it (kept
    // inside the toolbar). The narrow layout pins it on top of the window instead.
    placeUnderSelect(notification, toolbar) {
        if (getComputedStyle(notification).position !== 'absolute') return;
        const bar = toolbar.getBoundingClientRect();
        const select = this.databaseSelect.getBoundingClientRect();
        const width = notification.offsetWidth;
        const middle = select.left + select.width / 2 - bar.left;
        const left = Math.max(0, Math.min(select.left - bar.left, bar.width - width));
        notification.style.left = `${left}px`;
        notification.style.right = 'auto';
        notification.style.setProperty('--arrow-left', `${Math.max(12, Math.min(middle - left, width - 12)) - 4}px`);
    }
}
