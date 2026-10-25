#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONFIRM_MARKER = '[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]';
const REJECTED_MARKER = '[safe-delete][SAFE_DELETE_BULK_REJECTED]';
const ERROR_MARKER = '[safe-delete][SAFE_DELETE_BULK_GUARD_ERROR]';
const DEFAULT_THRESHOLD = 500;
const LOCK_TIMEOUT_MS = 2000;
const STALE_LOCK_MS = 5 * 60 * 1000;
const TURN_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Idle TTL for the per-request delete counter.
 *
 * Deliberately much shorter than TURN_STATE_TTL_MS: the counter is the only
 * piece of state that *accumulates*, and a zombie requestId (leaked into a
 * long-lived daemon) accumulating for 7 days is exactly what pushed an
 * unrelated DevEco build past the 500 threshold. Approvals and rejections keep
 * the long TTL because they must be remembered for the whole conversation.
 *
 * The timer is idle-based (refreshed on every counted delete), so a genuinely
 * long-running turn is not reset mid-flight.
 */
const REQUEST_STATE_TTL_MS = 60 * 60 * 1000;
const TARGET_SAMPLE_LIMIT = 5;
const DISPLAY_COUNT_LIMIT = 9999;
// Kept in the same literal form as the other runtimes: a contract test pins the
// four implementations to one set of staleness constants.
const HOST_HEARTBEAT_STALE_FACTOR = 3;
const DEFAULT_HOST_HEARTBEAT_INTERVAL_MS = 30_000;
const MIN_HOST_HEARTBEAT_INTERVAL_MS = 1_000;
const MAX_HOST_HEARTBEAT_INTERVAL_MS = 300_000;

class GuardError extends Error {}

function fail(message) {
    throw new GuardError(message);
}

function parseArgs(argv) {
    const command = argv[2];
    const targets = [];
    let scope;
    // `--deleted`: the targets have already been recycled by the caller, which counted
    // them as it went and submits them in one batch afterwards. A path that no longer
    // exists therefore has to count as one deleted item instead of being skipped -
    // otherwise a script that deletes a tree file by file would add ~1 per *batch* to
    // the counter instead of 1 per file and the threshold would never be reached
    // (issue #95509 follow-up).
    let deleted = false;
    for (let i = 3; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--target') {
            const target = argv[++i];
            if (!target) fail('missing --target value');
            targets.push(target);
        } else if (arg === '--scope') {
            scope = argv[++i];
            if (!scope) fail('missing --scope value');
        } else if (arg === '--deleted') {
            deleted = true;
        } else {
            fail(`unknown argument: ${arg}`);
        }
    }
    return { command, targets, scope, deleted };
}

function requireEnv(name) {
    const value = process.env[name];
    if (!value) fail(`${name} is not set`);
    return value;
}

function normalizeThreshold(value) {
    const raw = value === undefined || value === null || value === '' ? DEFAULT_THRESHOLD : value;
    const threshold = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(threshold) || threshold <= 0) fail(`invalid threshold: ${value}`);
    return threshold;
}

function createSafeDeleteBulkGuardContext(input) {
    if (!input || !input.stateRoot || !input.sessionId || !input.toolCallId) {
        fail('missing bulk guard context');
    }
    const threshold = normalizeThreshold(input.threshold);
    const sessionId = input.sessionId;
    const conversationRequestId = input.conversationRequestId;
    const sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex');
    const sessionDir = path.join(input.stateRoot, sessionHash);
    return {
        stateRoot: input.stateRoot,
        sessionId,
        toolCallId: input.toolCallId,
        requestId: conversationRequestId || input.toolCallId,
        threshold,
        conversationRequestId,
        sessionHash,
        sessionDir,
        statePath: path.join(sessionDir, 'state.json'),
    };
}

/**
 * Execution context liveness gate (Node replica of context-liveness.ts, which is the
 * single source of truth; cross-runtime agreement is pinned by
 * SAFE_DELETE_LIVENESS_VECTORS).
 *
 * The guard runs it itself as defense in depth: callers already skip the guard when
 * the context is dead, but a dead context must never *accumulate* delete counts —
 * that accumulation under a zombie requestId is what made an unrelated DevEco build
 * cross the 500 threshold and fail with a confirmation nobody could approve.
 *
 * Both gates are "unknown → treat as live", so hosts that inject neither keep the
 * pre-fix behaviour.
 */
function readJsonWithMtime(filePath) {
    let raw;
    let mtimeMs;
    try {
        raw = fs.readFileSync(filePath, 'utf-8');
        mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch (_) {
        return undefined;
    }
    try {
        return { parsed: JSON.parse(raw), mtimeMs };
    } catch (_) {
        return { parsed: undefined, mtimeMs };
    }
}

function normalizeHeartbeatIntervalMs(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_HOST_HEARTBEAT_INTERVAL_MS;
    return Math.min(MAX_HOST_HEARTBEAT_INTERVAL_MS, Math.max(MIN_HOST_HEARTBEAT_INTERVAL_MS, Math.floor(value)));
}

/** @returns {'live'|'dead'|'unknown'} */
function checkHostHeartbeatLiveness(now) {
    const heartbeatPath = process.env.CODEBUDDY_SAFE_DELETE_HOST_HEARTBEAT;
    if (!heartbeatPath) return 'unknown';
    const file = readJsonWithMtime(heartbeatPath);
    if (!file) return 'dead';
    const parsed = file.parsed;
    if (!parsed || parsed.version !== 1) {
        // Corrupt / mid-write snapshot: fall back to mtime rather than declaring the
        // host dead (which would silently disable protection).
        const mtimeAge = now - file.mtimeMs;
        return mtimeAge <= 0 || mtimeAge <= DEFAULT_HOST_HEARTBEAT_INTERVAL_MS * HOST_HEARTBEAT_STALE_FACTOR
            ? 'live'
            : 'dead';
    }
    const refreshedAt = typeof parsed.refreshedAt === 'number' && Number.isFinite(parsed.refreshedAt)
        ? parsed.refreshedAt
        : file.mtimeMs;
    const age = now - refreshedAt;
    if (age <= 0) return 'live';
    return age <= normalizeHeartbeatIntervalMs(parsed.intervalMs) * HOST_HEARTBEAT_STALE_FACTOR ? 'live' : 'dead';
}

/**
 * Read + validate the per-terminal state file written by the host before every
 * command (see terminal-state-writer.ts).
 *
 * The VS Code Terminal API has no per-command env, so `CODEBUDDY_TOOL_CALL_ID` is
 * absent in a reusable terminal and every runtime shim (node / python / bash /
 * PowerShell) has to resolve it from this state file. Doing it here as well means a
 * runtime that forgets the lookup degrades to "guard still enforced" instead of
 * "guard silently skipped".
 *
 * Validation mirrors node-safe-delete-shim.cjs: the state file must stay inside the
 * state root (no symlink / `..` escape), be version 1, active and unexpired.
 *
 * @returns {{ liveness: 'live'|'dead'|'unknown', context?: object }}
 */
function readTerminalState(now) {
    const stateDir = process.env.CODEBUDDY_SAFE_DELETE_STATE_DIR;
    const terminalKey = process.env.CODEBUDDY_SAFE_DELETE_TERMINAL_KEY;
    if (!stateDir || !terminalKey) return { liveness: 'unknown' };
    const root = path.resolve(stateDir);
    const stateFile = path.resolve(root, `${terminalKey}.json`);
    if (stateFile !== root && !stateFile.startsWith(root + path.sep)) return { liveness: 'unknown' };
    const file = readJsonWithMtime(stateFile);
    if (!file) return { liveness: 'dead' };
    const ctx = file.parsed;
    if (!ctx || ctx.version !== 1 || ctx.active !== true) return { liveness: 'dead' };
    const expiresAt = Number.isFinite(ctx.expiresAt) ? ctx.expiresAt : 0;
    if (now > expiresAt) return { liveness: 'dead' };
    return { liveness: 'live', context: ctx };
}

/**
 * Whether this process's safe-delete context is still owned by a live tool call.
 * `false` → the caller must allow the delete without counting it.
 */
function isSafeDeleteContextLive() {
    const now = Date.now();
    return checkHostHeartbeatLiveness(now) !== 'dead' && readTerminalState(now).liveness !== 'dead';
}

/**
 * Identity from the per-terminal state file. Liveness is validated by
 * `isSafeDeleteContextLive`; here a live-but-identity-less state file keeps the
 * previous behaviour (caller fails with the guard error marker).
 */
function readTerminalExecutionContext() {
    const state = readTerminalState(Date.now());
    const ctx = state.liveness === 'live' ? state.context : undefined;
    if (!ctx || !ctx.toolCallId) return undefined;
    return {
        toolCallId: String(ctx.toolCallId),
        conversationRequestId: ctx.conversationRequestId ? String(ctx.conversationRequestId) : undefined,
    };
}

function resolveToolCallIdentity() {
    if (process.env.CODEBUDDY_TOOL_CALL_ID) {
        return {
            toolCallId: process.env.CODEBUDDY_TOOL_CALL_ID,
            conversationRequestId: process.env.CODEBUDDY_CONVERSATION_REQUEST_ID,
        };
    }
    const terminalContext = readTerminalExecutionContext();
    if (!terminalContext) fail('CODEBUDDY_TOOL_CALL_ID is not set');
    return {
        toolCallId: terminalContext.toolCallId,
        conversationRequestId: process.env.CODEBUDDY_CONVERSATION_REQUEST_ID || terminalContext.conversationRequestId,
    };
}

function getContext() {
    const identity = resolveToolCallIdentity();
    return createSafeDeleteBulkGuardContext({
        stateRoot: requireEnv('CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR'),
        sessionId: requireEnv('CODEBUDDY_SESSION_ID'),
        toolCallId: identity.toolCallId,
        conversationRequestId: identity.conversationRequestId,
        threshold: process.env.CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD || DEFAULT_THRESHOLD,
    });
}

function defaultState() {
    return { requests: {}, toolApprovals: {}, requestRejections: {} };
}

function normalizeState(parsed) {
    if (!parsed || typeof parsed !== 'object') return defaultState();
    return {
        requests: parsed.requests && typeof parsed.requests === 'object' ? parsed.requests : {},
        toolApprovals: parsed.toolApprovals && typeof parsed.toolApprovals === 'object' ? parsed.toolApprovals : {},
        requestRejections: parsed.requestRejections && typeof parsed.requestRejections === 'object' ? parsed.requestRejections : {},
    };
}

function readState(statePath) {
    try {
        return normalizeState(JSON.parse(fs.readFileSync(statePath, 'utf-8')));
    } catch (error) {
        if (error && error.code === 'ENOENT') return defaultState();
        fail(`failed to read state: ${error && error.message ? error.message : String(error)}`);
    }
}

/**
 * Publish a file by writing a sibling temp file and renaming it over the target.
 *
 * Windows is where the rename can fail transiently: the file was just written, so
 * Defender / the indexer frequently still holds a handle on it, and a rename onto a
 * file with an open handle fails with EPERM (EBUSY / EACCES on some file systems).
 * One EPERM used to abort the whole `check`: the state write threw, the caller
 * reported `SAFE_DELETE_BULK_GUARD_ERROR` and *every* deletion in that command was
 * refused even though nothing was wrong with it (issue #95509 follow-up).
 *
 * The retry is short and only covers the transient codes; a persistent failure still
 * fails closed, and the temp file is removed so it cannot be mistaken for state.
 */
function publishFile(targetPath, content) {
    const tmpPath = `${targetPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, content, 'utf-8');
    const maxAttempts = 4;
    for (let attempt = 1; ; attempt++) {
        try {
            fs.renameSync(tmpPath, targetPath);
            return;
        } catch (error) {
            const code = error && error.code;
            const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
            if (!transient || attempt >= maxAttempts) {
                try { fs.unlinkSync(tmpPath); } catch (_) { /* best effort */ }
                throw error;
            }
            sleepMs(10 * attempt);
        }
    }
}

function writeState(statePath, state) {
    publishFile(statePath, `${JSON.stringify(state)}\n`);
}

function normalizeRequest(request, now) {
    if (!request || typeof request !== 'object') return { count: 0, updatedAt: now };
    return {
        count: Number.isFinite(request.count) ? request.count : 0,
        updatedAt: Number.isFinite(request.updatedAt) ? request.updatedAt : now,
    };
}

function normalizeToolApproval(approval, now) {
    if (!approval || typeof approval !== 'object') return { approved: false, updatedAt: now };
    return {
        approved: approval.approved === true,
        updatedAt: Number.isFinite(approval.updatedAt) ? approval.updatedAt : now,
    };
}

function normalizeRequestRejection(rejection, now) {
    if (!rejection || typeof rejection !== 'object') {
        return { rejected: false, updatedAt: now };
    }
    const targets = Array.isArray(rejection.targets)
        ? rejection.targets.filter(target => typeof target === 'string').slice(0, TARGET_SAMPLE_LIMIT)
        : [];
    return {
        rejected: rejection.rejected === true,
        updatedAt: Number.isFinite(rejection.updatedAt) ? rejection.updatedAt : now,
        count: Number.isFinite(rejection.count) ? rejection.count : 0,
        threshold: Number.isFinite(rejection.threshold) ? rejection.threshold : DEFAULT_THRESHOLD,
        targets,
        targetCount: Number.isFinite(rejection.targetCount) ? rejection.targetCount : targets.length,
    };
}

function pruneExpired(state, now) {
    let changed = false;
    const nextRequests = {};
    for (const [requestId, rawRequest] of Object.entries(state.requests)) {
        const request = normalizeRequest(rawRequest, now);
        if (now - request.updatedAt > REQUEST_STATE_TTL_MS) {
            changed = true;
            continue;
        }
        nextRequests[requestId] = request;
        if (
            !rawRequest
            || typeof rawRequest !== 'object'
            || rawRequest.count !== request.count
            || rawRequest.updatedAt !== request.updatedAt
        ) {
            changed = true;
        }
    }
    if (changed) state.requests = nextRequests;

    const nextToolApprovals = {};
    for (const [toolCallId, rawApproval] of Object.entries(state.toolApprovals)) {
        const approval = normalizeToolApproval(rawApproval, now);
        if (now - approval.updatedAt > TURN_STATE_TTL_MS) {
            changed = true;
            continue;
        }
        nextToolApprovals[toolCallId] = approval;
        if (
            !rawApproval
            || typeof rawApproval !== 'object'
            || rawApproval.approved !== approval.approved
            || rawApproval.updatedAt !== approval.updatedAt
        ) {
            changed = true;
        }
    }
    if (changed) state.toolApprovals = nextToolApprovals;

    const nextRequestRejections = {};
    for (const [requestId, rawRejection] of Object.entries(state.requestRejections || {})) {
        const rejection = normalizeRequestRejection(rawRejection, now);
        if (now - rejection.updatedAt > TURN_STATE_TTL_MS) {
            changed = true;
            continue;
        }
        if (rejection.rejected) {
            nextRequestRejections[requestId] = rejection;
        }
        if (
            !rawRejection
            || typeof rawRejection !== 'object'
            || rawRejection.rejected !== rejection.rejected
            || rawRejection.updatedAt !== rejection.updatedAt
            || rawRejection.count !== rejection.count
            || rawRejection.threshold !== rejection.threshold
            || rawRejection.targetCount !== rejection.targetCount
        ) {
            changed = true;
        }
    }
    if (changed) state.requestRejections = nextRequestRejections;
    return changed;
}

function sleepMs(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch (_) {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            // fallback for constrained Node runtimes
        }
    }
}

function removeStaleLock(lockDir) {
    try {
        const stat = fs.statSync(lockDir);
        if (!stat.isDirectory() || Date.now() - stat.mtimeMs <= STALE_LOCK_MS) return false;
        fs.rmSync(lockDir, { recursive: true, force: true });
        return true;
    } catch (_) {
        return false;
    }
}

function withLock(context, fn) {
    fs.mkdirSync(context.sessionDir, { recursive: true });
    const lockDir = path.join(context.sessionDir, '.lock');
    const started = Date.now();
    for (;;) {
        try {
            fs.mkdirSync(lockDir);
            break;
        } catch (error) {
            if (!error || error.code !== 'EEXIST') fail(`failed to acquire lock: ${error && error.message ? error.message : String(error)}`);
            if (removeStaleLock(lockDir)) continue;
            if (Date.now() - started > LOCK_TIMEOUT_MS) fail('state lock timeout');
            sleepMs(25);
        }
    }
    try {
        return fn(context.statePath);
    } finally {
        try { fs.rmdirSync(lockDir); } catch (_) { /* best effort */ }
    }
}

function normalizeTargetPath(target) {
    if (process.platform !== 'win32' || typeof target !== 'string') return target;
    if (/^[A-Za-z]:[\\/]/.test(target)) return target;
    const msysMatch = target.match(/^\/([A-Za-z])(?:\/(.*))?$/);
    if (!msysMatch) return target;
    const drive = msysMatch[1].toUpperCase();
    const rest = (msysMatch[2] || '').replace(/\//g, '\\');
    return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
}

function countTarget(target, remaining, deleted) {
    if (remaining <= 0) return 0;
    target = normalizeTargetPath(target);
    let stat;
    try {
        stat = fs.lstatSync(target);
    } catch (error) {
        if (error && error.code === 'ENOENT') return deleted ? 1 : 0;
        fail(`failed to stat target: ${target}`);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 1;

    let dir;
    try {
        dir = fs.opendirSync(target);
    } catch (_) {
        // `--deleted`: the caller vouches that it recycled this path, so it counts as the
        // one item it was. Without the flag an unreadable directory still has to fail
        // closed — an uncountable delete must never be waved through.
        if (!deleted) fail(`failed to read directory: ${target}`);
        return 1;
    }
    let count = 0;
    try {
        for (;;) {
            if (count >= remaining) break;
            const entry = dir.readSync();
            if (!entry) break;
            if (entry.isDirectory() && !entry.isSymbolicLink()) {
                count += countTarget(path.join(target, entry.name), remaining - count, deleted);
            } else {
                count += 1;
            }
        }
    } finally {
        try { dir.closeSync(); } catch (_) { /* best effort */ }
    }
    return count;
}

function countTargets(targets, limit, deleted) {
    let count = 0;
    for (const target of targets) {
        if (count >= limit) break;
        count += countTarget(target, limit - count, deleted);
    }
    return count;
}

function checkSafeDeleteBulkGuard(context, targets, options) {
    if (!targets || targets.length === 0) fail('check requires at least one target');
    let decision = { kind: 'allow' };
    withLock(context, statePath => {
        const now = Date.now();
        const state = readState(statePath);
        const pruned = pruneExpired(state, now);
        const rejection = normalizeRequestRejection(state.requestRejections && state.requestRejections[context.requestId], now);
        if (rejection.rejected) {
            decision = {
                kind: 'rejected',
                payload: {
                    count: rejection.count,
                    threshold: rejection.threshold,
                    scope: 'turn',
                    targets: rejection.targets,
                    targetCount: rejection.targetCount,
                },
            };
            if (pruned) writeState(statePath, state);
            return;
        }
        const request = normalizeRequest(state.requests[context.requestId], now);
        const approval = normalizeToolApproval(state.toolApprovals[context.toolCallId], now);
        const deleteCount = countTargets(targets, DISPLAY_COUNT_LIMIT, options && options.deleted === true);
        if (deleteCount === 0) {
            if (pruned) writeState(statePath, state);
            return;
        }
        const totalCount = request.count + deleteCount;
        if (approval.approved) {
            state.requests[context.requestId] = { count: totalCount, updatedAt: now };
            writeState(statePath, state);
            return;
        }
        if (totalCount >= context.threshold) {
            decision = {
                kind: 'confirmRequired',
                payload: {
                    count: totalCount,
                    threshold: context.threshold,
                    scope: 'turn',
                    targets: targets.slice(0, TARGET_SAMPLE_LIMIT),
                    targetCount: targets.length,
                },
            };
            if (pruned) writeState(statePath, state);
            return;
        }
        state.requests[context.requestId] = { count: totalCount, updatedAt: now };
        writeState(statePath, state);
    });
    return decision;
}

function signalFilePath(context) {
    return path.join(context.sessionDir, `signal-${context.toolCallId}.json`);
}

function writeSignalFile(context, signal) {
    try {
        fs.mkdirSync(context.sessionDir, { recursive: true });
        publishFile(signalFilePath(context), `${JSON.stringify(signal)}\n`);
    } catch (_) {
        // Best-effort: stderr marker is the fallback.
    }
}

function handleCheck(args) {
    if (args.targets.length === 0) fail('check requires at least one --target');
    // Dead context → allow silently: no counting, no signal file, no marker. The env
    // that reached us was inherited by a process that outlived its tool call (e.g. a
    // build daemon later reused by another IDE); it must behave like a plain process.
    if (!isSafeDeleteContextLive()) return;
    const context = getContext();
    const decision = checkSafeDeleteBulkGuard(context, args.targets, { deleted: args.deleted });
    if (decision.kind === 'confirmRequired') {
        writeSignalFile(context, { type: 'confirmRequired', payload: decision.payload });
        process.stderr.write(`${CONFIRM_MARKER} ${JSON.stringify(decision.payload)}\n`);
        process.exit(2);
    }
    if (decision.kind === 'rejected') {
        writeSignalFile(context, { type: 'rejected', payload: decision.payload });
        process.stderr.write(`${REJECTED_MARKER} ${JSON.stringify(decision.payload)}\n`);
        process.exit(3);
    }
}

function approveSafeDeleteBulkGuard(context, scope) {
    if (scope && scope !== 'turn') fail('approve requires scope turn');
    withLock(context, statePath => {
        const now = Date.now();
        const state = readState(statePath);
        pruneExpired(state, now);
        state.toolApprovals[context.toolCallId] = { approved: true, updatedAt: now };
        writeState(statePath, state);
    });
}

function rejectSafeDeleteBulkGuard(context, payload) {
    const normalized = normalizeRequestRejection({ ...payload, rejected: true }, Date.now());
    withLock(context, statePath => {
        const now = Date.now();
        const state = readState(statePath);
        pruneExpired(state, now);
        state.requests[context.requestId] = {
            count: normalized.count,
            updatedAt: now,
        };
        state.requestRejections[context.requestId] = {
            rejected: true,
            updatedAt: now,
            count: normalized.count,
            threshold: normalized.threshold,
            targets: normalized.targets,
            targetCount: normalized.targetCount,
        };
        delete state.toolApprovals[context.toolCallId];
        writeState(statePath, state);
    });
}

function handleApprove(args) {
    if (args.scope && args.scope !== 'turn') fail('approve requires scope turn');
    approveSafeDeleteBulkGuard(getContext(), args.scope);
}

function main() {
    const args = parseArgs(process.argv);
    if (args.command === 'check') return handleCheck(args);
    if (args.command === 'approve') return handleApprove(args);
    fail(`unknown command: ${args.command || '(empty)'}`);
}

module.exports = {
    approveSafeDeleteBulkGuard,
    checkSafeDeleteBulkGuard,
    createSafeDeleteBulkGuardContext,
    rejectSafeDeleteBulkGuard,
    DEFAULT_THRESHOLD,
    CONFIRM_MARKER,
    REJECTED_MARKER,
    ERROR_MARKER,
};

if (require.main === module) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`${ERROR_MARKER} ${error && error.message ? error.message : String(error)}\n`);
        process.exit(1);
    }
}
