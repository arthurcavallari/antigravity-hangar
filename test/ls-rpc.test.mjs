import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { STATE_RPC_TTL_MS, hangarRpc, invalidateStateReads } from '../lib/ls-rpc.mjs';

describe('hangarRpc shared state reads', () => {
  it('sets STATE_RPC_TTL_MS >= 2500ms and does not invalidate cached state when Jetbox read RPCs run', async () => {
    assert.ok(STATE_RPC_TTL_MS >= 2500, 'STATE_RPC_TTL_MS must cover the 2500ms Jetbox summaries poll cadence');
    const calls = {};
    const options = {
      lsAddress: '127.0.0.1:59993',
      csrfToken: 'tok',
      fetchFn: async (url) => {
        const method = url.slice(url.lastIndexOf('/') + 1);
        calls[method] = (calls[method] || 0) + 1;
        return { ok: true, status: 200, text: async () => '{"plugins":[],"sidecars":[],"terminals":[]}' };
      },
    };
    invalidateStateReads();
    await Promise.all([
      hangarRpc('GetSidecars', {}, options),
      hangarRpc('GetAllPlugins', { workspaceUris: [] }, options),
      hangarRpc('ListTerminals', {}, options),
      hangarRpc('GetAllCascadeTrajectories', {}, options),
    ]);
    assert.deepEqual(calls, {
      GetSidecars: 1,
      GetAllPlugins: 1,
      ListTerminals: 1,
      GetAllCascadeTrajectories: 1,
    });

    // Jetbox read-only RPCs must pass through without wiping out GetSidecars, GetAllPlugins, or ListTerminals caches
    for (const readMethod of [
      'GetWorkspaceInfos',
      'GetCascadeModelConfigData',
      'GetAllSkills',
      'GetAllRules',
      'GetMcpServerStates',
      'RequestAgentStatePageUpdate',
    ]) {
      await hangarRpc(readMethod, {}, options);
    }

    await Promise.all([
      hangarRpc('GetSidecars', {}, options),
      hangarRpc('GetAllPlugins', { workspaceUris: [] }, options),
      hangarRpc('ListTerminals', {}, options),
      hangarRpc('GetAllCascadeTrajectories', {}, options),
    ]);
    assert.equal(calls.GetSidecars, 1, 'GetSidecars cache must survive Jetbox read RPCs');
    assert.equal(calls.GetAllPlugins, 1, 'GetAllPlugins 30s cache must survive Jetbox read RPCs');
    assert.equal(calls.ListTerminals, 1, 'ListTerminals cache must survive Jetbox read RPCs');
    assert.equal(calls.GetAllCascadeTrajectories, 1, 'GetAllCascadeTrajectories cache must survive Jetbox read RPCs');

    // Trajectory mutations invalidate GetAllCascadeTrajectories without wiping GetAllPlugins
    await hangarRpc('UpdateConversationAnnotations', { cascadeId: 'c-1' }, options);
    await Promise.all([
      hangarRpc('GetAllPlugins', { workspaceUris: [] }, options),
      hangarRpc('GetAllCascadeTrajectories', {}, options),
    ]);
    assert.equal(calls.GetAllPlugins, 1, 'GetAllPlugins cache must survive trajectory annotation updates');
    assert.equal(calls.GetAllCascadeTrajectories, 2, 'GetAllCascadeTrajectories must refresh after trajectory mutation');
  });

  it('shares GetSidecars/GetAllCascadeTrajectories between windows and drops GetSidecars after a write', async () => {
    const calls = {};
    const options = {
      lsAddress: '127.0.0.1:59990',
      csrfToken: 'tok',
      fetchFn: async (url) => {
        const method = url.slice(url.lastIndexOf('/') + 1);
        calls[method] = (calls[method] || 0) + 1;
        return { ok: true, status: 200, text: async () => '{}' };
      },
    };
    invalidateStateReads();
    // Two Hangar windows polling /api/state at once
    const poll = () =>
      Promise.all([hangarRpc('GetSidecars', {}, options), hangarRpc('GetAllCascadeTrajectories', {}, options)]);
    await Promise.all([poll(), poll()]);
    await poll();
    assert.deepEqual(calls, { GetSidecars: 1, GetAllCascadeTrajectories: 1 });

    // Writes are never merged or cached, and the next poll sees the new sidecar status
    await hangarRpc('ManageSidecar', { action: 'SIDECAR_ACTION_STOP', sidecarId: 'x' }, options);
    await hangarRpc('ManageSidecar', { action: 'SIDECAR_ACTION_STOP', sidecarId: 'x' }, options);
    await poll();
    assert.deepEqual(calls, { GetSidecars: 2, GetAllCascadeTrajectories: 1, ManageSidecar: 2 });

    invalidateStateReads();
    await poll();
    assert.deepEqual(calls, { GetSidecars: 3, GetAllCascadeTrajectories: 2, ManageSidecar: 2 });
  });

  it('keeps GetAllPlugins across polls and drops it after a plugin write', async () => {
    const calls = {};
    const options = {
      lsAddress: '127.0.0.1:59991',
      csrfToken: 'tok',
      fetchFn: async (url) => {
        const method = url.slice(url.lastIndexOf('/') + 1);
        calls[method] = (calls[method] || 0) + 1;
        return { ok: true, status: 200, text: async () => '{"plugins":[]}' };
      },
    };
    invalidateStateReads();
    const listPlugins = () => hangarRpc('GetAllPlugins', { workspaceUris: [] }, options);
    await Promise.all([listPlugins(), listPlugins()]);
    await listPlugins();
    assert.deepEqual(calls, { GetAllPlugins: 1 });

    await hangarRpc('JetboxWriteState', { userConfig: { plugins: { demo: { enabled: true } } } }, options);
    await listPlugins();
    await hangarRpc('DeletePlugin', { pluginId: 'demo' }, options);
    await listPlugins();
    assert.deepEqual(calls, { GetAllPlugins: 3, JetboxWriteState: 1, DeletePlugin: 1 });
  });

  it('caches ListTerminals without invalidating GetSidecars/GetAllPlugins, ignores SendTerminalInput for cache invalidation, and falls back to lastTrajectories on transient error', async () => {
    const calls = {};
    let failTrajectories = false;
    const options = {
      lsAddress: '127.0.0.1:59992',
      csrfToken: 'tok',
      fetchFn: async (url) => {
        const method = url.slice(url.lastIndexOf('/') + 1);
        calls[method] = (calls[method] || 0) + 1;
        if (method === 'GetAllCascadeTrajectories') {
          if (failTrajectories) {
            return { ok: false, status: 503, text: async () => 'timeout' };
          }
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ trajectorySummaries: { 'conv-1': { summary: 'Test' } } }),
          };
        }
        return { ok: true, status: 200, text: async () => '{"terminals":[]}' };
      },
    };
    invalidateStateReads();

    const pollFullState = async () => {
      await Promise.all([
        hangarRpc('GetSidecars', {}, options),
        hangarRpc('GetAllCascadeTrajectories', {}, options),
        hangarRpc('GetAllPlugins', { workspaceUris: [] }, options),
      ]);
      await hangarRpc('ListTerminals', {}, options);
    };

    await pollFullState();
    await pollFullState();
    assert.deepEqual(calls, {
      GetSidecars: 1,
      GetAllCascadeTrajectories: 1,
      GetAllPlugins: 1,
      ListTerminals: 1,
    });

    await hangarRpc('SendTerminalInput', { terminalId: 't-1', data: 'ZGly' }, options);
    await pollFullState();
    assert.deepEqual(calls, {
      GetSidecars: 1,
      GetAllCascadeTrajectories: 1,
      GetAllPlugins: 1,
      ListTerminals: 1,
      SendTerminalInput: 1,
    });

    await hangarRpc('CreateTerminal', { terminalId: 't-2' }, options);
    await pollFullState();
    assert.deepEqual(calls, {
      GetSidecars: 1,
      GetAllCascadeTrajectories: 1,
      GetAllPlugins: 1,
      ListTerminals: 2,
      SendTerminalInput: 1,
      CreateTerminal: 1,
    });

    invalidateStateReads('GetAllCascadeTrajectories');
    failTrajectories = true;
    const fallbackTraj = await hangarRpc('GetAllCascadeTrajectories', {}, options);
    assert.deepEqual(fallbackTraj, { trajectorySummaries: { 'conv-1': { summary: 'Test' } } });
  });
});
