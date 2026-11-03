'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const readline = require('readline');

// Windows integrated authentication.
//
// tedious (the driver behind mssql) cannot use the SSPI token of the logged-on
// Windows account, so these connections go through helper/SqlWayfarerSspi.exe
// (System.Data.SqlClient) instead. This file is the extension side of its
// JSON-lines protocol, shaped like the part of mssql the rest of the code
// uses - pool.request(), pool.acquire(), request.input() / query() / batch() /
// cancel() and the streaming events - so none of the callers has to know.

// One physical connection each; a query holds one for its whole run.
const MAX_SESSIONS = 8;
const STDERR_TAIL = 2000;

class SspiError extends Error {
    constructor(info, code) {
        super(info.message || 'Unknown error');
        this.name = code === 'ELOGIN' ? 'ConnectionError' : 'RequestError';
        this.code = code;
        this.number = info.number;
        this.state = info.state;
        this.class = info.class;
        this.lineNumber = info.lineNumber;
        this.procName = info.procName;
        this.serverName = info.serverName;
    }
}

// mssql guesses the SQL type of an input() from the JavaScript value.
function encodeParam(name, value) {
    if (value === null || value === undefined) return { name, type: 'nvarchar', value: null };
    if (typeof value === 'boolean') return { name, type: 'bit', value };
    if (typeof value === 'bigint') return { name, type: 'bigint', value: value.toString() };
    if (typeof value === 'number') {
        if (!Number.isInteger(value)) return { name, type: 'float', value };
        return Math.abs(value) <= 2147483647
            ? { name, type: 'int', value }
            : { name, type: 'bigint', value: String(value) };
    }
    if (value instanceof Date) return { name, type: 'datetime', value: value.toISOString() };
    if (Buffer.isBuffer(value)) return { name, type: 'varbinary', value: value.toString('base64') };
    return { name, type: 'nvarchar', value: String(value) };
}

// The helper sends dates as ISO strings and binaries as base64, and tells
// which columns are which in the 'recordset' event.
function decodeRow(raw, columns) {
    const row = {};
    for (let i = 0; i < columns.length; i++) {
        let value = raw[i];
        if (value !== null) {
            if (columns[i].kind === 'date') value = new Date(value);
            else if (columns[i].kind === 'binary') value = Buffer.from(value, 'base64');
        }
        const name = columns[i].name;
        // mssql turns a column name returned several times into an array.
        if (Object.prototype.hasOwnProperty.call(row, name)) {
            if (Array.isArray(row[name])) row[name].push(value);
            else row[name] = [row[name], value];
        } else {
            row[name] = value;
        }
    }
    return row;
}

function columnsObject(columns) {
    const result = {};
    columns.forEach((c, index) => {
        result[c.name] = { index, name: c.name, type: c.type, nullable: true };
    });
    return result;
}

// The helper process of one connection pool.
class SspiHelper {
    // onExit(error) is called once, when the process is gone.
    constructor(helperPath, spawnFn = spawn, onExit = () => {}) {
        this._helperPath = helperPath;
        this._spawn = spawnFn;
        this._onExitCallback = onExit;
        this._child = null;
        this._pending = new Map();
        this._nextId = 1;
        this._stderr = '';
        this._exited = false;
    }

    start() {
        const child = this._spawn(this._helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        this._child = child;
        child.stderr.on('data', chunk => {
            this._stderr = (this._stderr + chunk.toString()).slice(-STDERR_TAIL);
        });
        child.stdin.on('error', () => { /* the exit handler reports it */ });
        readline.createInterface({ input: child.stdout }).on('line', line => this._onLine(line));
        child.on('error', error => this._onExit(
            error.code === 'ENOENT'
                ? new Error(`The Windows authentication helper was not found (${this._helperPath}).`)
                : error));
        child.on('exit', code => this._onExit(
            new Error(`The Windows authentication helper stopped unexpectedly (exit code ${code}).${this._stderr ? ' ' + this._stderr.trim() : ''}`)));
    }

    get alive() {
        return this._child !== null && !this._exited;
    }

    nextId() {
        return this._nextId++;
    }

    // Sends a request; onEvent receives its events, the promise settles with
    // the terminal message.
    request(message, onEvent) {
        return new Promise((resolve, reject) => {
            if (!this.alive) {
                reject(new Error('The Windows authentication helper is not running.'));
                return;
            }
            this._pending.set(message.id, { onEvent, resolve, reject });
            this._write(message);
        });
    }

    cancel(target) {
        if (this.alive) this._write({ op: 'cancel', target });
    }

    _write(message) {
        this._child.stdin.write(JSON.stringify(message) + '\n');
    }

    _onLine(line) {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        const pending = this._pending.get(message.id);
        if (!pending) return;
        if (message.ev) {
            pending.onEvent(message);
        } else if (message.fail) {
            this._pending.delete(message.id);
            pending.reject(message.fail);
        } else if (message.end) {
            this._pending.delete(message.id);
            pending.resolve(message);
        }
    }

    _onExit(error) {
        if (this._exited) return;
        this._exited = true;
        for (const pending of this._pending.values()) pending.reject({ message: error.message });
        this._pending.clear();
        this._onExitCallback(error);
    }

    async stop() {
        if (!this._child || this._exited) return;
        const child = this._child;
        const exited = new Promise(resolve => child.once('exit', resolve));
        try { this._write({ op: 'exit' }); } catch { /* already gone */ }
        const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, 2000);
        await exited;
        clearTimeout(timer);
    }
}

// What mssql's Request offers, minus what nothing here uses (output
// parameters, table-valued parameters, bulk).
class SspiRequest extends EventEmitter {
    constructor(runner, requestTimeout) {
        super();
        this.stream = false;
        this._runner = runner;
        this._requestTimeout = requestTimeout;
        this._params = [];
        this._id = null;
        // The helper the request runs on: a restarted helper numbers its
        // requests again, so a cancel must go to the one that has the id.
        this._helper = null;
        this._cancelled = false;
    }

    input(name, value) {
        this._params.push(encodeParam(name, value));
        return this;
    }

    // A parameterless query already goes to the server as a plain SQL batch
    // with SqlClient (not through sp_executesql), which is what SET
    // SHOWPLAN_XML needs - so batch() and query() are the same thing here.
    query(sql) {
        return this._runner.run(this, sql);
    }

    batch(sql) {
        return this._runner.run(this, sql);
    }

    cancel() {
        this._cancelled = true;
        if (this._id !== null) this._helper.cancel(this._id);
    }
}

// Runs one request on one helper session.
function execute(helper, sessionId, request, sql) {
    const id = helper.nextId();
    request._id = id;
    request._helper = helper;
    if (request._cancelled) helper.cancel(id);

    const recordsets = [];
    const rowsAffected = [];
    const errors = [];
    let columns = [];
    let current = null;

    const fail = info => {
        const error = new SspiError(info, 'EREQUEST');
        errors.push(error);
        if (request.stream && request.listenerCount('error') > 0) request.emit('error', error);
        return error;
    };

    const onEvent = event => {
        switch (event.ev) {
            case 'recordset': {
                columns = event.columns;
                const meta = columnsObject(columns);
                if (request.stream) {
                    request.emit('recordset', meta);
                } else {
                    current = [];
                    current.columns = meta;
                    recordsets.push(current);
                }
                break;
            }
            case 'rows':
                for (const raw of event.rows) {
                    const row = decodeRow(raw, columns);
                    if (request.stream) request.emit('row', row);
                    else current.push(row);
                }
                break;
            case 'info':
                request.emit('info', event);
                break;
            case 'rowsaffected':
                rowsAffected.push(event.count);
                request.emit('rowsaffected', event.count);
                break;
            case 'error':
                fail(event);
                break;
        }
    };

    return helper.request({
        id,
        op: 'query',
        session: sessionId,
        sql,
        params: request._params,
        timeout: request._requestTimeout
    }, onEvent).then(() => {
        if (errors.length > 0) throw errors[0];
        return { recordsets, recordset: recordsets[0], rowsAffected, output: {} };
    }, info => {
        // The request itself failed (cancelled, timed out, connection lost).
        throw fail(info);
    });
}

class SspiPool {
    // helperPath: where SqlWayfarerSspi.exe lives. spawnFn is for the tests.
    constructor(config, helperPath, spawnFn = spawn, platform = process.platform) {
        this.config = config;
        this._helperPath = helperPath;
        this._spawn = spawnFn;
        this._platform = platform;
        this._helper = null;
        this._sessions = [];
        this._waiters = [];
        this._closed = false;
    }

    get connected() {
        return !this._closed && this._helper !== null;
    }

    // (Re)starts the helper process. Its sessions died with it.
    _startHelper() {
        this._sessions = [];
        this._helper = new SspiHelper(this._helperPath, this._spawn, error => this._onHelperExit(error));
        this._helper.start();
    }

    // Whoever was waiting for a session of the dead helper would wait forever.
    _onHelperExit(error) {
        const waiters = this._waiters;
        this._waiters = [];
        for (const waiter of waiters) waiter.reject(error);
    }

    async connect() {
        if (this._platform !== 'win32') throw new Error('Windows authentication is only available on Windows.');
        this._startHelper();
        try {
            // Opening the first session is the connection test.
            const entry = await this._openSession();
            this._sessions.push(entry);
        } catch (error) {
            await this._helper.stop();
            throw error;
        }
        return this;
    }

    async _openSession() {
        const options = this.config.options || {};
        const id = this._helper.nextId();
        try {
            const reply = await this._helper.request({
                id,
                op: 'open',
                server: this.config.server,
                port: this.config.port,
                database: this.config.database,
                encrypt: options.encrypt,
                trustServerCertificate: options.trustServerCertificate
            }, () => {});
            return { id: reply.session, busy: false, helper: this._helper };
        } catch (info) {
            if (info instanceof Error) throw info;
            throw new SspiError(info, 'ELOGIN');
        }
    }

    // Hands out an idle session, opens one if there is room, otherwise waits
    // for one to be released.
    async _checkout() {
        if (this._closed) throw new Error('The connection is closed.');
        // A crashed helper is replaced by a new one, which opens its sessions
        // again as they are needed - the way a pool drops broken connections.
        if (!this._helper.alive) this._startHelper();
        let entry = this._sessions.find(s => !s.busy);
        if (!entry && this._sessions.length < MAX_SESSIONS) {
            entry = { id: null, busy: true, helper: this._helper };
            this._sessions.push(entry);
            try {
                entry.id = (await this._openSession()).id;
            } catch (error) {
                const index = this._sessions.indexOf(entry);
                if (index !== -1) this._sessions.splice(index, 1);
                throw error;
            }
            return entry;
        }
        if (entry) {
            entry.busy = true;
            return entry;
        }
        return new Promise((resolve, reject) => this._waiters.push({ resolve, reject }));
    }

    _release(entry) {
        // A session of a helper that has been replaced is gone for good.
        if (entry.helper !== this._helper) return;
        const waiter = this._waiters.shift();
        if (waiter) waiter.resolve(entry);
        else entry.busy = false;
    }

    // How many sessions are idle right now.
    idleCount() {
        return this._sessions.filter(s => !s.busy).length;
    }

    // pool.request(): every query takes a session for its own duration.
    request() {
        const pool = this;
        return new SspiRequest({
            async run(request, sql) {
                const entry = await pool._checkout();
                try {
                    return await execute(entry.helper, entry.id, request, sql);
                } finally {
                    pool._release(entry);
                }
            }
        }, this.config.requestTimeout);
    }

    // The counterpart of ConnectionManager.acquireConnection(): requests
    // pinned to one session, so a USE, a SET option or a #temp table stays
    // visible to the next one.
    async acquireSession() {
        const entry = await this._checkout();
        const pool = this;
        const runner = {
            run: (request, sql) => execute(entry.helper, entry.id, request, sql)
        };
        const batch = text => new SspiRequest(runner, pool.config.requestTimeout).batch(text);
        return {
            createRequest: () => new SspiRequest(runner, pool.config.requestTimeout),
            transactionCount: async () => (await batch('SELECT @@TRANCOUNT AS n')).recordset[0].n,
            endTransaction: action => batch(action === 'commit'
                ? 'WHILE @@TRANCOUNT > 0 COMMIT TRANSACTION'
                : 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION'),
            release: () => pool._release(entry)
        };
    }

    async close() {
        if (this._closed) return;
        this._closed = true;
        for (const waiter of this._waiters) waiter.reject(new Error('The connection is closed.'));
        this._waiters = [];
        if (this._helper) await this._helper.stop();
    }
}

module.exports = { SspiPool, SspiError };
