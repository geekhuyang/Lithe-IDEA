/**
 * CodeBuddy Node language shim
 *
 * The single NODE_OPTIONS --require entry. It loads the safe-delete hooks.
 * Phase 3 brokered fs hooks have been removed.
 */

'use strict';

const SESSION_ID = process.env.CODEBUDDY_SESSION_ID
    || process.env.CLAUDE_SESSION_ID;

if (!SESSION_ID) {
    return;
}

if (global.__CODEBUDDY_NODE_LANGUAGE_SHIM_LOADED__) {
    return;
}
global.__CODEBUDDY_NODE_LANGUAGE_SHIM_LOADED__ = true;

const safeDeleteEnabled = process.env.CODEBUDDY_SAFE_DELETE_ENABLED !== '0';

if (safeDeleteEnabled) {
    require('./node-safe-delete-shim.cjs');
}
