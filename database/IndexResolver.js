'use strict';

// Resolution of the object names an index entry refers to.
//
// A QUALIFIED reference (schema.name) is authoritative: it matches that
// object or nothing. Falling back to the bare name would resolve
// 'dbo.Orders' to 'audit.Orders' - a different table, with different
// triggers.
//
// An UNQUALIFIED reference (a table named without its schema) is resolved
// the way SQL Server resolves it inside a module: the schema of the
// referring module first, then - only when the bare name is unique in the
// database - the single object carrying that name.
//
// Anything else stays unresolved. Picking one of two candidates silently
// reports an object that may not be the one involved, and a wrong table
// means the wrong triggers fire.
//
// The rule lives here, and not in each service, because two services
// resolving names with two different rules is how the same name came to be
// resolved to two different tables.
class IndexResolver {
    /**
     * @param {object} objects    the cached index (index.objects map)
     * @param {function} isTable  (type) => boolean - what counts as a table
     */
    constructor(objects, isTable) {
        this._byQN = {};
        this._byBare = {};
        this._isTable = isTable;
        for (const e of Object.values(objects || {})) {
            const qn = IndexResolver._clean(e.qualifiedName);
            this._byQN[qn] = e;
            if (isTable(e.type)) {
                const bare = qn.split('.').pop();
                (this._byBare[bare] = this._byBare[bare] || []).push(e);
            }
        }
    }

    static _clean(name) {
        return (name || '').replace(/\[|\]/g, '').toLowerCase();
    }

    // The object a qualified name refers to, whatever its type (a procedure,
    // a view...). Unqualified names are not resolved here: only the DMV,
    // which always qualifies its names, feeds this.
    resolve(name) {
        return this._byQN[IndexResolver._clean(name)] || null;
    }

    // The table a reference points to, or null when it cannot be resolved.
    // @param {string} key          the name as it appears in the source
    // @param {string} preferSchema schema of the module the name was written
    //                               in (null for a name typed by a user)
    resolveTable(key, preferSchema) {
        const n = IndexResolver._clean(key);
        const exact = this._byQN[n];
        if (exact) return this._isTable(exact.type) ? exact : null;
        // A qualified name that is not in the index stays unresolved: the
        // bare name would point at another schema's object.
        if (n.includes('.')) return null;

        const candidates = this._byBare[n] || [];
        if (candidates.length === 0) return null;
        if (candidates.length === 1) return candidates[0];

        // Several schemas carry that name: the module's own schema wins, the
        // way SQL Server resolves it.
        if (preferSchema) {
            const inSchema = candidates.filter(
                e => IndexResolver._clean(e.schema) === IndexResolver._clean(preferSchema)
            );
            if (inSchema.length === 1) return inSchema[0];
        }
        // Ambiguous: reported as unresolved rather than guessed.
        return null;
    }

    // The tables that carry a bare name, for a caller that wants to report
    // the ambiguity instead of resolving it.
    candidates(bareName) {
        return this._byBare[IndexResolver._clean(bareName)] || [];
    }
}

module.exports = IndexResolver;
