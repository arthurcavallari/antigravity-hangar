/**
 * @fileoverview Language Server calls for Hangar. Every Hangar window polls /api/state from this
 * one Node process, so GetSidecars and GetAllCascadeTrajectories are merged and shared for a
 * moment instead of being sent once per window per poll.
 */

import { callLsRpc, createLsRpcCache } from 'antigravity-sidecar-kit/rpc';

export const STATE_RPC_TTL_MS = 2_000;

const stateReads = createLsRpcCache({
  ttlMs: { GetSidecars: STATE_RPC_TTL_MS, GetAllCascadeTrajectories: STATE_RPC_TTL_MS },
});

export function invalidateStateReads() {
  stateReads.invalidate();
}

/**
 * callLsRpc with the shared state reads. Any other method is a write (ManageSidecar), and once it
 * finishes the cached sidecar list is dropped so the next poll sees the new status.
 */
export function hangarRpc(method, body = {}, options = {}) {
  if (method === 'GetSidecars' || method === 'GetAllCascadeTrajectories') {
    return stateReads.call(method, body, options);
  }
  return callLsRpc(method, body, options).finally(() => stateReads.invalidate('GetSidecars'));
}
