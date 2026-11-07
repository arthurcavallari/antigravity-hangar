/**
 * @fileoverview Language Server calls for Hangar. Every Hangar window polls /api/state from this
 * one Node process, so GetSidecars, GetAllCascadeTrajectories and GetAllPlugins are merged and
 * shared for a moment instead of being sent once per window per poll.
 */

import { callLsRpc, createLsRpcCache } from 'antigravity-sidecar-kit/rpc';

export const STATE_RPC_TTL_MS = 2_500;
// GetAllPlugins inlines the full text of every SKILL.md, and the plugin list only changes on an
// install, uninstall or toggle, so it's re-read far less often than the sidecar list
export const PLUGINS_RPC_TTL_MS = 30_000;

const stateReads = createLsRpcCache({
  ttlMs: {
    GetSidecars: STATE_RPC_TTL_MS,
    GetAllCascadeTrajectories: STATE_RPC_TTL_MS,
    GetAllPlugins: PLUGINS_RPC_TTL_MS,
    ListTerminals: STATE_RPC_TTL_MS,
  },
});

let lastTrajectories = null;

export function invalidateStateReads(...methods) {
  if (methods.length === 0) {
    lastTrajectories = null;
  }
  stateReads.invalidate(...methods);
}

const CACHED_READ_METHODS = new Set([
  'GetSidecars',
  'GetAllCascadeTrajectories',
  'GetAllPlugins',
  'ListTerminals',
]);

const TERMINAL_WRITE_METHODS = new Set([
  'CreateTerminal',
  'CloseTerminal',
  'RenameTerminal',
]);

const TRAJECTORY_WRITE_METHODS = new Set([
  'StartCascade',
  'DeleteCascadeTrajectory',
  'ForkConversation',
  'UpdateConversationAnnotations',
]);

const SIDECAR_PLUGIN_WRITE_METHODS = new Set([
  'ManageSidecar',
  'JetboxWriteState',
  'DeletePlugin',
  'InstallPlugin',
  'UpdatePlugin',
]);

/**
 * callLsRpc with the shared state reads. Read-only RPCs are cached or passed through without
 * invalidating stateReads; write RPCs (ManageSidecar, JetboxWriteState, DeletePlugin, terminal/trajectory mutations)
 * invalidate only the affected cached lists so the next poll sees the change.
 */
export function hangarRpc(method, body = {}, options = {}) {
  if (CACHED_READ_METHODS.has(method)) {
    const p = stateReads.call(method, body, options);
    if (method === 'GetAllCascadeTrajectories') {
      return p.then(
        (res) => {
          if (res?.trajectorySummaries && Object.keys(res.trajectorySummaries).length > 0) {
            lastTrajectories = res;
          }
          return res;
        },
        (err) => {
          if (lastTrajectories) return lastTrajectories;
          throw err;
        },
      );
    }
    return p;
  }
  if (TERMINAL_WRITE_METHODS.has(method)) {
    return callLsRpc(method, body, options).finally(() => stateReads.invalidate('ListTerminals'));
  }
  if (TRAJECTORY_WRITE_METHODS.has(method)) {
    return callLsRpc(method, body, options).finally(() => stateReads.invalidate('GetAllCascadeTrajectories'));
  }
  if (SIDECAR_PLUGIN_WRITE_METHODS.has(method)) {
    return callLsRpc(method, body, options).finally(() => stateReads.invalidate('GetSidecars', 'GetAllPlugins'));
  }
  return callLsRpc(method, body, options);
}
