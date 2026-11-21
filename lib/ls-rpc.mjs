/**
 * @fileoverview Language Server calls for Hangar. Every Hangar window polls /api/state from this
 * one Node process, so GetSidecars, GetAllCascadeTrajectories and GetAllPlugins are merged and
 * shared for a moment instead of being sent once per window per poll.
 */

import {
  callLsRpc,
  createConnectFrameAccumulator,
  createLsRpcCache,
  encodeConnectFrame,
  getLsConfig,
} from 'antigravity-sidecar-kit/rpc';

export const STATE_RPC_TTL_MS = 2_500;
// GetAllPlugins inlines the full text of every SKILL.md, and the plugin list only changes on an
// install, uninstall or toggle, so it's re-read far less often than the sidecar list
export const PLUGINS_RPC_TTL_MS = 30_000;
export const AUTH_STATUS_TTL_MS = 15_000;
export const JETBOX_STATE_TTL_MS = 10_000;

const stateReads = createLsRpcCache({
  ttlMs: {
    GetSidecars: STATE_RPC_TTL_MS,
    GetAllCascadeTrajectories: STATE_RPC_TTL_MS,
    GetAllPlugins: PLUGINS_RPC_TTL_MS,
    ListTerminals: STATE_RPC_TTL_MS,
  },
});

let lastTrajectories = null;
let summariesCache = { ts: 0, inFlight: null, value: null };
let authStatusCache = { ts: 0, inFlight: null, value: null };
let jetboxStateCache = { ts: 0, inFlight: null, value: null };
let summariesGen = 0;
let authStatusGen = 0;
let jetboxStateGen = 0;

export function invalidateStateReads(...methods) {
  if (
    methods.length === 0 ||
    methods.includes('GetAllCascadeTrajectories') ||
    methods.includes('JetboxSubscribeToSummaries')
  ) {
    summariesGen += 1;
    summariesCache = { ts: 0, inFlight: null, value: null };
  }
  if (methods.length === 0 || methods.includes('GetAuthStatus')) {
    authStatusGen += 1;
    authStatusCache = { ts: 0, inFlight: null, value: null };
  }
  if (
    methods.length === 0 ||
    methods.includes('JetboxSubscribeToState') ||
    methods.includes('JetboxWriteState')
  ) {
    jetboxStateGen += 1;
    jetboxStateCache = { ts: 0, inFlight: null, value: null };
  }
  if (methods.length === 0) {
    lastTrajectories = null;
  }
  stateReads.invalidate(
    ...methods.filter(
      (m) => m !== 'JetboxSubscribeToSummaries' && m !== 'GetAuthStatus' && m !== 'JetboxSubscribeToState'
    )
  );
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
]);

const TRAJECTORY_WRITE_METHODS = new Set([
  'StartCascade',
  'DeleteCascadeTrajectory',
  'ForkConversation',
  'UpdateConversationAnnotations',
  'SendUserCascadeMessage',
  'SendAgentMessage',
  'CancelCascadeInvocation',
  'CancelCascadeSteps',
  'ForceStopCascadeTree',
]);

const SIDECAR_PLUGIN_WRITE_METHODS = new Set([
  'ManageSidecar',
  'JetboxWriteState',
  'DeletePlugin',
  'InstallCustomization',
  'UpdateCustomization',
]);

/**
 * callLsRpc with the shared state reads. Read-only RPCs are cached or passed through without
 * invalidating stateReads; write RPCs (ManageSidecar, JetboxWriteState, DeletePlugin, terminal/trajectory mutations)
 * invalidate only the affected cached lists so the next poll sees the change.
 */
export function hangarRpc(method, body = {}, options = {}) {
  const rpcOpts = options.sidecarId ? options : { ...options, sidecarId: 'hangar' };
  if (method === 'GetAuthStatus') {
    const now = Date.now();
    if (!options.noCache) {
      if (authStatusCache.inFlight) return authStatusCache.inFlight;
      if (authStatusCache.value && now - authStatusCache.ts < AUTH_STATUS_TTL_MS) {
        return Promise.resolve(authStatusCache.value);
      }
    }
    const authOpts = { ...rpcOpts, timeoutMs: options.timeoutMs ?? 10_000 };
    const reqGen = authStatusGen;
    const run = callLsRpc('GetAuthStatus', body, authOpts)
      .then((res) => {
        if (!options.noCache && reqGen === authStatusGen && Boolean(res?.authResult?.hasValidAuth)) {
          authStatusCache = { ts: Date.now(), inFlight: null, value: res };
        }
        return res;
      })
      .finally(() => {
        if (authStatusCache.inFlight === run) {
          authStatusCache.inFlight = null;
        }
      });
    if (!options.noCache) {
      authStatusCache.inFlight = run;
    }
    return run;
  }
  if (CACHED_READ_METHODS.has(method)) {
    const p = stateReads.call(method, body, rpcOpts);
    if (method === 'GetAllCascadeTrajectories') {
      return p.then(
        (res) => {
          if (res?.trajectorySummaries && typeof res.trajectorySummaries === 'object') {
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
    return callLsRpc(method, body, rpcOpts).finally(() => stateReads.invalidate('ListTerminals'));
  }
  if (TRAJECTORY_WRITE_METHODS.has(method)) {
    const delCid = method === 'DeleteCascadeTrajectory' ? String(body?.cascadeId || '').trim() : '';
    if (delCid && lastTrajectories?.trajectorySummaries) {
      delete lastTrajectories.trajectorySummaries[delCid];
    }
    return callLsRpc(method, body, rpcOpts).finally(() =>
      invalidateStateReads('GetAllCascadeTrajectories', 'JetboxSubscribeToSummaries')
    );
  }
  if (SIDECAR_PLUGIN_WRITE_METHODS.has(method)) {
    return callLsRpc(method, body, rpcOpts).finally(() =>
      invalidateStateReads('GetSidecars', 'GetAllPlugins', 'JetboxSubscribeToState')
    );
  }
  return callLsRpc(method, body, rpcOpts);
}

/**
 * Reads the initial snapshot from Antigravity's server-streaming `JetboxSubscribeToSummaries` RPC so
 * persisted on-disk conversations unloaded from LS RAM remain visible alongside resident trajectories.
 */
export function fetchJetboxSummaries(options = {}) {
  const now = Date.now();
  if (!options.noCache) {
    if (summariesCache.inFlight) return summariesCache.inFlight;
    if (summariesCache.value && now - summariesCache.ts < STATE_RPC_TTL_MS) {
      return Promise.resolve(summariesCache.value);
    }
  }
  const rpcOpts = options.sidecarId ? options : { ...options, sidecarId: 'hangar' };
  const { lsAddress, csrfToken } = getLsConfig(rpcOpts);
  const fetchFn = options.fetchFn || globalThis.fetch;
  if (!lsAddress || !csrfToken || typeof fetchFn !== 'function') {
    return Promise.resolve({ ok: false, summaries: {}, deletedIds: [] });
  }
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 1500;
  const settleMs = Number(options.settleMs) >= 0 ? Number(options.settleMs) : 25;
  const reqGen = summariesGen;

  const run = (async () => {
    const summaries = {};
    const deletedSet = new Set();
    let sawFrame = false;
    let ok = false;
    const ac = new AbortController();
    let settleTimer = null;
    const hardTimer = setTimeout(() => ac.abort(), timeoutMs);
    let reader = null;
    try {
      const res = await fetchFn(
        `http://${lsAddress}/exa.language_server_pb.LanguageServerService/JetboxSubscribeToSummaries`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/connect+json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': csrfToken,
          },
          body: encodeConnectFrame({}),
          signal: ac.signal,
        }
      );
      if (!res?.ok || !res.body?.getReader) {
        return { ok: false, summaries: {}, deletedIds: [] };
      }
      ok = true;
      reader = res.body.getReader();
      const abortRead = new Promise((resolve) => {
        if (ac.signal.aborted) {
          resolve({ done: true, value: undefined });
          return;
        }
        ac.signal.addEventListener(
          'abort',
          () => {
            try {
              reader?.cancel?.().catch?.(() => {});
            } catch {}
            resolve({ done: true, value: undefined });
          },
          { once: true }
        );
      });
      const acc = createConnectFrameAccumulator();
      while (!ac.signal.aborted) {
        const { done, value } = await Promise.race([reader.read(), abortRead]);
        if (done || ac.signal.aborted) break;
        for (const frame of acc.push(value)) {
          if (frame.flags === 0 && frame.data && typeof frame.data === 'object') {
            sawFrame = true;
            const updates = frame.data.updates && typeof frame.data.updates === 'object' ? frame.data.updates : {};
            const batchSize = Object.keys(updates).length;
            for (const [cid, info] of Object.entries(updates)) {
              summaries[cid] = info;
              deletedSet.delete(cid);
            }
            if (Array.isArray(frame.data.deletes)) {
              for (const delId of frame.data.deletes) {
                delete summaries[delId];
                deletedSet.add(delId);
              }
            }
            if (settleTimer) clearTimeout(settleTimer);
            if (batchSize < 100) {
              settleTimer = setTimeout(() => ac.abort(), settleMs);
            }
          } else if ((frame.flags & 2) === 2) {
            if (frame.data?.error) ok = sawFrame;
            ac.abort();
            break;
          }
        }
        if (ac.signal.aborted) break;
      }
    } catch {
      // Expected when aborting open-ended Connect server stream after initial snapshot settles
    } finally {
      clearTimeout(hardTimer);
      if (settleTimer) clearTimeout(settleTimer);
      try {
        reader?.releaseLock();
      } catch {}
    }
    const result = { ok: ok && (sawFrame || Object.keys(summaries).length === 0), summaries, deletedIds: [...deletedSet] };
    if (result.ok && !options.noCache && reqGen === summariesGen) {
      summariesCache = { ts: Date.now(), inFlight: null, value: result };
    }
    return result;
  })().finally(() => {
    if (summariesCache.inFlight === run) {
      summariesCache.inFlight = null;
    }
  });

  if (!options.noCache) {
    summariesCache.inFlight = run;
  }
  return run;
}

/**
 * Combines `JetboxSubscribeToSummaries` (all persisted disk conversations) with `GetAllCascadeTrajectories`
 * (in-memory trajectories, including `SIDE_QUESTION` threads excluded from `JetboxSubscribeToSummaries`).
 */
export async function fetchMergedCascadeTrajectories({
  rpcFn = hangarRpc,
  summariesFn = fetchJetboxSummaries,
  ...options
} = {}) {
  const [resident, persisted] = await Promise.all([
    Promise.resolve(rpcFn('GetAllCascadeTrajectories', {}, options)).catch(() => ({ trajectorySummaries: {} })),
    Promise.resolve(summariesFn(options)).catch(() => ({ ok: false, summaries: {}, deletedIds: [] })),
  ]);
  const merged = {
    ...(persisted?.summaries && typeof persisted.summaries === 'object' ? persisted.summaries : {}),
    ...(resident?.trajectorySummaries && typeof resident.trajectorySummaries === 'object'
      ? resident.trajectorySummaries
      : {}),
  };
  const deletedIds = Array.isArray(persisted?.deletedIds) ? persisted.deletedIds : [];
  for (const delId of deletedIds) {
    delete merged[delId];
  }
  return {
    trajectorySummaries: merged,
    deletedIds,
    persistedComplete: Boolean(persisted?.ok),
  };
}

/**
 * Reads Frame 1 of `JetboxSubscribeToState` (including BYOM `appState.customModelsConfig`) and aborts immediately.
 */
export function readJetboxStateSnapshot(options = {}) {
  const now = Date.now();
  if (!options.noCache) {
    if (jetboxStateCache.inFlight) return jetboxStateCache.inFlight;
    if (jetboxStateCache.value && now - jetboxStateCache.ts < JETBOX_STATE_TTL_MS) {
      return Promise.resolve(jetboxStateCache.value);
    }
  }
  const rpcOpts = options.sidecarId ? options : { ...options, sidecarId: 'hangar' };
  const { lsAddress, csrfToken } = getLsConfig(rpcOpts);
  const fetchFn = options.fetchFn || globalThis.fetch;
  if (!lsAddress || !csrfToken || typeof fetchFn !== 'function') {
    return Promise.resolve({ ok: false, state: {} });
  }
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 1500;
  const reqGen = jetboxStateGen;
  const run = (async () => {
    let snapshot = null;
    const ac = new AbortController();
    const hardTimer = setTimeout(() => ac.abort(), timeoutMs);
    let reader = null;
    try {
      const res = await fetchFn(
        `http://${lsAddress}/exa.language_server_pb.LanguageServerService/JetboxSubscribeToState`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/connect+json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': csrfToken,
          },
          body: encodeConnectFrame({}),
          signal: ac.signal,
        }
      );
      if (!res?.ok || !res.body?.getReader) {
        return { ok: false, state: {} };
      }
      reader = res.body.getReader();
      const abortRead = new Promise((resolve) => {
        if (ac.signal.aborted) {
          resolve({ done: true, value: undefined });
          return;
        }
        ac.signal.addEventListener(
          'abort',
          () => {
            try { reader?.cancel?.().catch?.(() => {}); } catch {}
            resolve({ done: true, value: undefined });
          },
          { once: true }
        );
      });
      const acc = createConnectFrameAccumulator();
      while (!ac.signal.aborted) {
        const { done, value } = await Promise.race([reader.read(), abortRead]);
        if (done || ac.signal.aborted) break;
        for (const frame of acc.push(value)) {
          if (frame.flags === 0 && frame.data && typeof frame.data === 'object') {
            snapshot = frame.data;
            ac.abort();
            break;
          } else if ((frame.flags & 2) === 2) {
            ac.abort();
            break;
          }
        }
      }
    } catch {
      // Expected on immediate stream abort after Frame 1
    } finally {
      clearTimeout(hardTimer);
      try { reader?.releaseLock(); } catch {}
    }
    const result = { ok: Boolean(snapshot), state: snapshot || {} };
    if (result.ok && !options.noCache && reqGen === jetboxStateGen) {
      jetboxStateCache = { ts: Date.now(), inFlight: null, value: result };
    }
    return result;
  })().finally(() => {
    if (jetboxStateCache.inFlight === run) {
      jetboxStateCache.inFlight = null;
    }
  });
  if (!options.noCache) {
    jetboxStateCache.inFlight = run;
  }
  return run;
}
