'use strict';

const { splitBatches } = require('./sqlBatches');
const { bracketIdentifier } = require('./sqlIdentifier');
const { PROGRESS_CLEAR } = require('./migrationScript');

// === Applying the script of a comparison to a database ===
//
// classifyTarget says where a database stands against the changes of a script,
// applyScript runs the script on it the way the editor does (every batch, in
// order, on one connection; a batch that fails does not stop the next, the
// script stops itself, see migrationScript.js).

const idOf = change => `${change.kind}:${change.name}`;

// For the changes that are picked, where the target is:
//   done      it already is as in the current state
//   pending   it still is as in the reference: the script will change it
//   differs   it is neither (half done, or changed since): the script finishes
//             what is half done, and overwrites what is different
// referenceToTarget and targetToCurrent are diffModels() of the three models.
function classifyTarget(selectedIds, referenceToTarget, targetToCurrent) {
    const needed = new Set(targetToCurrent.changes.map(idOf));
    const departed = new Set(referenceToTarget.changes.map(idOf));
    const result = { done: [], pending: [], differs: [] };
    for (const id of selectedIds) {
        if (!needed.has(id)) result.done.push(id);
        else if (!departed.has(id)) result.pending.push(id);
        else result.differs.push(id);
    }
    return result;
}

// Runs the script on a database. onProgress(done, total) after each batch;
// shouldStop() is asked between batches. Returns the errors, each with the
// number of the batch (from 1) and the line it starts at in the script.
async function applyScript(connectionManager, database, script, { onProgress = () => {}, shouldStop = () => false } = {}) {
    const batches = splitBatches(script);
    const errors = [];
    let ran = 0;
    let stopped = false;
    const startedAt = Date.now();
    const conn = await connectionManager.acquireConnection();
    try {
        await conn.createRequest().batch(`USE ${bracketIdentifier(database)}`);
        for (const batch of batches) {
            if (shouldStop()) { stopped = true; break; }
            for (let rep = 0; rep < batch.repeat; rep++) {
                try {
                    await conn.createRequest().batch(batch.sql);
                } catch (error) {
                    errors.push({ batch: ran + 1, line: batch.startLine, message: error.message });
                }
            }
            ran++;
            onProgress(ran, batches.length);
        }
    } finally {
        // A pooled connection keeps what the script left: NOEXEC when it stopped itself, its
        // progress marks and the SET options of the last module when it was stopped half way.
        try {
            await conn.createRequest().batch('SET NOEXEC OFF');
            await conn.createRequest().batch(`${PROGRESS_CLEAR}\nSET ANSI_NULLS ON;\nSET QUOTED_IDENTIFIER ON;\nUSE [master];`);
        } catch { /* the connection is gone */ }
        conn.release();
    }
    return { batches: batches.length, ran, errors, stopped, durationMs: Date.now() - startedAt };
}

module.exports = { classifyTarget, applyScript, idOf };
