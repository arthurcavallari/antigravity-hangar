/**
 * @fileoverview Language Server calls for Hangar. Every Hangar window polls /api/state from this
 * one Node process, so GetSidecars, GetAllCascadeTrajectories and GetAllPlugins are merged and
 * shared for a moment instead of being sent once per window per poll.
 */

import { callLsRpc, createLsRpcCache } from 'antigravity-sidecar-kit/rpc';

export const STATE_RPC_TTL_MS = 2_000;
// GetAllPlugins inlines the full text of every SKILL.md, and the plugin list only changes on an
// install, uninstall or toggle, so it's re-read far less often than the sidecar list
export const PLUGINS_RPC_TTL_MS = 30_000;

const stateReads = createLsRpcCache({
  ttlMs: {
    GetSidecars: STATE_RPC_TTL_MS,
    GetAllCascadeTrajectories: STATE_RPC_TTL_MS,
    GetAllPlugins: PLUGINS_RPC_TTL_MS,
  },
});

export function invalidateStateReads() {
  stateReads.invalidate();
}

/**
 * callLsRpc with the shared state reads. Any other method is a write (ManageSidecar, JetboxWriteState,
 * DeletePlugin), and once it finishes the cached sidecar and plugin lists are dropped so the next poll
 * sees the change.
 */
export function hangarRpc(method, body = {}, options = {}) {
  if (method === 'GetSidecars' || method === 'GetAllCascadeTrajectories' || method === 'GetAllPlugins') {
    return stateReads.call(method, body, options);
  }
  return callLsRpc(method, body, options).finally(() => stateReads.invalidate('GetSidecars', 'GetAllPlugins'));
}
