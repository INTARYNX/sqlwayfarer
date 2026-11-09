/**
 * VS Code Extension – Keep this header in every file.
 *
 * ✱ Comments in English only.
 * ✱ Each section must have a name + brief description.
 * ✱ Keep it simple – follow the KISS principle.
 */
'use strict';

// Dragging an object of a list (the Explorer, the instance tree) into the
// editor: what is dropped is its full name, database.schema.object.
const ObjectDrag = {
    TYPE: 'application/x-sqlwayfarer-object',

    // A name as it is written in a query: bracketed when it is not a plain identifier.
    part(name) {
        const text = String(name);
        return /^[A-Za-z_][\w$#@]*$/.test(text) ? text : `[${text.replace(/]/g, ']]')}]`;
    },

    fullName(database, schema, name) {
        return [database, schema, name].filter(Boolean).map(ObjectDrag.part).join('.');
    },

    // The name to drop in the query editor: the database is left out when it
    // is the one the query runs on (the name is then schema.object).
    forEditor(database, schema, name) {
        const queries = typeof window !== 'undefined' ? window.queryManager : null;
        const onOtherConnection = queries && queries.runsOnOtherConnection();
        const target = queries ? queries.targetDatabase() : null;
        const sameDatabase = !onOtherConnection && target && database
            && String(target).toLowerCase() === String(database).toLowerCase();
        return ObjectDrag.fullName(sameDatabase ? null : database, schema, name);
    },

    // The element can be dragged from anywhere on it; getName gives what is dropped.
    attach(element, getName) {
        element.draggable = true;
        element.addEventListener('dragstart', (event) => {
            const text = getName();
            if (!text) { event.preventDefault(); return; }
            event.dataTransfer.setData('text/plain', text);
            // Only the editor of the page reads this one: it places the caret after the name.
            event.dataTransfer.setData(ObjectDrag.TYPE, text);
            event.dataTransfer.effectAllowed = 'copy';
        });
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ObjectDrag;
}
