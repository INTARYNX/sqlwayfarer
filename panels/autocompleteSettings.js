/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// The sqlwayfarer.autocomplete.* settings, as the query editor of a webview
// receives them. The webview clamps and completes them again
// (SqlAutocomplete.normalizeSettings), so this only has to read them.
const AUTOCOMPLETE_SETTING_KEYS = [
    'enabled', 'autoTrigger', 'triggerAfterKeywords', 'minChars', 'maxItems', 'matching',
    'keywordCase', 'acceptKeys', 'showTypes', 'addAlias', 'bracketNames',
    'columnQualification', 'includeSystemObjects', 'sortByUsage', 'snippets', 'showDetails'
];

// config: a WorkspaceConfiguration for the 'sqlwayfarer.autocomplete' section
// (anything with get(key)).
function readAutocompleteSettings(config) {
    const settings = {};
    for (const key of AUTOCOMPLETE_SETTING_KEYS) {
        const value = config.get(key);
        if (value !== undefined) settings[key] = value;
    }
    return settings;
}

module.exports = { AUTOCOMPLETE_SETTING_KEYS, readAutocompleteSettings };
