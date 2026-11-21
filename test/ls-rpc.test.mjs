import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeConnectFrame } from 'antigravity-sidecar-kit/rpc';
import {
  STATE_RPC_TTL_MS,
  fetchJetboxSummaries,
  fetchMergedCascadeTrajectories,
  hangarRpc,
  invalidateStateReads,
  readJetboxStateSnapshot,
} from '../lib/ls-rpc.mjs';
import { fetchHangarState } from '../lib/state-orchestrator.mjs';

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
    await hangarRpc('InstallCustomization', { customizationId: 'demo' }, options);
    await listPlugins();
    await hangarRpc('UpdateCustomization', { customizationId: 'demo' }, options);
    await listPlugins();
    assert.deepEqual(calls, {
      GetAllPlugins: 5,
      JetboxWriteState: 1,
      DeletePlugin: 1,
      InstallCustomization: 1,
      UpdateCustomization: 1,
    });
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

  it('SH-06: merges JetboxSubscribeToSummaries persisted threads with resident GetAllCascadeTrajectories without RAM-eviction loss', async () => {
    invalidateStateReads();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encodeConnectFrame(
            {
              updates: {
                'cold-disk-1': {
                  summary: 'Cold Thread',
                  workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c:/proj/cold' }],
                },
                'ram-evicted-1': { summary: 'Evicted Thread' },
                'deleted-1': { summary: 'Soon Deleted' },
              },
              deletes: ['deleted-1'],
            },
            0
          )
        );
        // Leave stream open without end-of-stream flag to verify settle-timer abort on live LS streams
      },
    });
    const persisted = await fetchJetboxSummaries({
      noCache: true,
      lsAddress: '127.0.0.1:59994',
      csrfToken: 'tok',
      settleMs: 10,
      timeoutMs: 500,
      fetchFn: async () => ({ ok: true, status: 200, body: stream }),
    });
    assert.equal(persisted.ok, true);
    assert.deepEqual(Object.keys(persisted.summaries).sort(), ['cold-disk-1', 'ram-evicted-1']);
    assert.deepEqual(persisted.deletedIds, ['deleted-1']);

    const merged = await fetchMergedCascadeTrajectories({
      rpcFn: async () => ({
        trajectorySummaries: {
          'side-q-1': { summary: 'Side Question', trajectoryType: 22 },
        },
      }),
      summariesFn: async () => persisted,
    });
    assert.equal(merged.persistedComplete, true);
    assert.deepEqual(Object.keys(merged.trajectorySummaries).sort(), [
      'cold-disk-1',
      'ram-evicted-1',
      'side-q-1',
    ]);
    assert.deepEqual(merged.deletedIds, ['deleted-1']);

    const state = await fetchHangarState({
      conversationId: 'cold-disk-1',
      rpcFn: async () => ({ sidecars: [], trajectorySummaries: {} }),
      summariesFn: async () => persisted,
    });
    assert.match(state.activeWorkspace.workspacePath, /proj[\\/]cold/i);
  });

  it('SH-10: prefers trusted hangar runtime.json LS credentials over ANTIGRAVITY_AGENT=1 run_command token', async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { getLsConfig, manageSidecar } = await import('antigravity-sidecar-kit/rpc');

    const tmp = mkdtempSync(join(tmpdir(), 'hangar-sh10-'));
    try {
      const runtimeDir = join(tmp, 'hangar', 'data');
      mkdirSync(runtimeDir, { recursive: true });
      writeFileSync(
        join(runtimeDir, 'runtime.json'),
        JSON.stringify({ lsAddress: '127.0.0.1:59999', csrfToken: 'trusted-hangar-token' }),
        'utf8'
      );

      const agentEnv = {
        ANTIGRAVITY_AGENT: '1',
        ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:59999',
        ANTIGRAVITY_CSRF_TOKEN: 'restricted-run-command-token',
      };
      const cfg = getLsConfig({ sidecarDataRoot: tmp, sidecarId: 'hangar', env: agentEnv });
      assert.equal(cfg.csrfToken, 'trusted-hangar-token');

      const seenTokens = [];
      const fetchFn = async (_url, init) => {
        const tok = init.headers['x-codeium-csrf-token'];
        seenTokens.push(tok);
        if (tok === 'restricted-run-command-token') {
          return {
            ok: false,
            status: 403,
            text: async () => JSON.stringify({ code: 'permission_denied', message: 'principal "run_command" denied' }),
          };
        }
        return { ok: true, status: 200, text: async () => '{"sidecars":[]}' };
      };

      await manageSidecar('hangar', 'SIDECAR_ACTION_RESTART', {
        sidecarDataRoot: tmp,
        sidecarId: 'hangar',
        env: agentEnv,
        fetchFn,
      });
      await hangarRpc('CreateTerminal', { cwd: 'C:/proj' }, {
        sidecarDataRoot: tmp,
        env: agentEnv,
        fetchFn,
      });
      assert.deepEqual(seenTokens, ['trusted-hangar-token', 'trusted-hangar-token']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('SC-03: gives GetAuthStatus a 10s cold-boot budget, caches positive auth for 15s, never caches unauthenticated/errors, and propagates strict GetAuthStatus/GetUserStatus errors', async () => {
    const { registerJetboxProxyRoutes } = await import('../lib/jetbox-proxy.mjs');
    invalidateStateReads();
    let calls = 0;
    let mode = 'unauthed';
    const baseOpts = {
      lsAddress: '127.0.0.1:59995',
      csrfToken: 'tok',
      fetchFn: async (_url, init) => {
        calls += 1;
        assert.ok(init?.signal, 'GetAuthStatus should pass an AbortSignal with extended timeout');
        if (mode === 'error') {
          return { ok: false, status: 503, text: async () => 'upstream transient timeout' };
        }
        if (mode === 'unauthed') {
          return { ok: true, status: 200, text: async () => JSON.stringify({ authResult: { hasValidAuth: false } }) };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ authResult: { hasValidAuth: true, email: 'user@example.com' } }),
        };
      },
    };

    const neg1 = await hangarRpc('GetAuthStatus', {}, baseOpts);
    const neg2 = await hangarRpc('GetAuthStatus', {}, baseOpts);
    assert.equal(neg1.authResult.hasValidAuth, false);
    assert.equal(neg2.authResult.hasValidAuth, false);
    assert.equal(calls, 2, 'negative auth responses must never be cached');

    mode = 'error';
    await assert.rejects(() => hangarRpc('GetAuthStatus', {}, baseOpts), /503/);
    assert.equal(calls, 3);

    mode = 'authed';
    const [pos1, pos2] = await Promise.all([
      hangarRpc('GetAuthStatus', {}, baseOpts),
      hangarRpc('GetAuthStatus', {}, baseOpts),
    ]);
    const pos3 = await hangarRpc('GetAuthStatus', {}, baseOpts);
    assert.equal(pos1.authResult.hasValidAuth, true);
    assert.equal(pos2.authResult.hasValidAuth, true);
    assert.equal(pos3.authResult.hasValidAuth, true);
    assert.equal(calls, 4, 'positive auth responses must share in-flight and cache for 15s');

    const apis = new Map();
    registerJetboxProxyRoutes(
      { page() {}, api: (p, fn) => apis.set(p, fn) },
      { rpcFn: async (m) => { throw new Error(`${m} transient timeout`); } },
    );
    const lsRpc = apis.get('/api/terminal/ls-rpc');
    await assert.rejects(() => lsRpc({ method: 'GetAuthStatus', body: {} }), /GetAuthStatus transient timeout/);
    await assert.rejects(() => lsRpc({ method: 'GetUserStatus', body: {} }), /GetUserStatus transient timeout/);
  });

  it('SC-10: readJetboxStateSnapshot reads Frame 1 of JetboxSubscribeToState, aborts immediately, and caches for 10s', async () => {
    invalidateStateReads('JetboxSubscribeToState');
    let calls = 0;
    let streamAborted = false;
    const fetchFn = async (_url, init) => {
      calls += 1;
      init.signal.addEventListener('abort', () => {
        streamAborted = true;
      });
      const frame1 = encodeConnectFrame({
        appState: {
          customModelsConfig: {
            customModels: {
              'Claude 4.5 Custom (BYOM)': { modelId: 'MODEL_CLAUDE_4_SONNET' },
            },
          },
        },
      });
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(frame1);
        },
      });
      return { ok: true, status: 200, body: stream };
    };
    const snap1 = await readJetboxStateSnapshot({
      lsAddress: '127.0.0.1:59992',
      csrfToken: 'tok',
      fetchFn,
    });
    const snap2 = await readJetboxStateSnapshot({
      lsAddress: '127.0.0.1:59992',
      csrfToken: 'tok',
      fetchFn,
    });
    assert.equal(snap1.ok, true);
    assert.equal(streamAborted, true);
    assert.deepEqual(Object.keys(snap1.state.appState.customModelsConfig.customModels), ['Claude 4.5 Custom (BYOM)']);
    assert.equal(snap2.ok, true);
    assert.equal(calls, 1, 'second snapshot read within 10s must serve cached result');
  });

  it('invalidates GetAllCascadeTrajectories on SendUserCascadeMessage/Cancel, clears lastTrajectories, and guards fetchJetboxSummaries against pre-invalidation write-back', async () => {
    let trajStatus = 1;
    let failTraj = false;
    const calls = {};
    const options = {
      lsAddress: '127.0.0.1:59994',
      csrfToken: 'tok',
      fetchFn: async (url) => {
        const method = url.slice(url.lastIndexOf('/') + 1);
        calls[method] = (calls[method] || 0) + 1;
        if (method === 'GetAllCascadeTrajectories') {
          if (failTraj) return { ok: false, status: 503, text: async () => 'err' };
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ trajectorySummaries: { 'sq-1': { status: trajStatus } } }),
          };
        }
        return { ok: true, status: 200, text: async () => '{}' };
      },
    };
    invalidateStateReads();
    const first = await hangarRpc('GetAllCascadeTrajectories', {}, options);
    assert.equal(first.trajectorySummaries['sq-1'].status, 1);

    trajStatus = 2;
    await hangarRpc('SendUserCascadeMessage', { cascadeId: 'sq-1' }, options);
    const afterSend = await hangarRpc('GetAllCascadeTrajectories', {}, options);
    assert.equal(afterSend.trajectorySummaries['sq-1'].status, 2, 'SendUserCascadeMessage must bust cached trajectories');

    await hangarRpc('DeleteCascadeTrajectory', { cascadeId: 'sq-1' }, options);
    failTraj = true;
    const fallbackAfterDel = await hangarRpc('GetAllCascadeTrajectories', {}, options);
    assert.equal(
      fallbackAfterDel.trajectorySummaries['sq-1'],
      undefined,
      'DeleteCascadeTrajectory must scrub deleted cascadeId from lastTrajectories fallback',
    );
  });

  it('JetboxReadState forwards orchestratorModel and orchestratorExecutorModel from config.json userSettings while keeping themeMode: 1', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { registerJetboxProxyRoutes } = await import('../lib/jetbox-proxy.mjs');

    const tmp = mkdtempSync(join(tmpdir(), 'hangar-jetbox-cfg-'));
    try {
      const cfgPath = join(tmp, 'config.json');
      writeFileSync(
        cfgPath,
        JSON.stringify({
          userSettings: {
            themeMode: 2,
            orchestratorModel: 1018,
            orchestratorExecutorModel: 1026,
            unrelatedSetting: 'ignored',
          },
        }),
        'utf8',
      );
      const apis = new Map();
      registerJetboxProxyRoutes(
        { page() {}, api: (p, fn) => apis.set(p, fn) },
        { configPath: cfgPath },
      );
      const lsRpc = apis.get('/api/terminal/ls-rpc');
      assert.deepEqual(await lsRpc({ method: 'JetboxReadState' }), {
        appState: { agentOnboardingCompleted: 2 },
        userConfig: {
          userSettings: {
            themeMode: 1,
            orchestratorModel: 1018,
            orchestratorExecutorModel: 1026,
          },
        },
      });

      writeFileSync(cfgPath, JSON.stringify({ userSettings: { themeMode: 2 } }), 'utf8');
      assert.deepEqual(await lsRpc({ method: 'JetboxReadState' }), {
        appState: { agentOnboardingCompleted: 2 },
        userConfig: {
          userSettings: {
            themeMode: 1,
          },
        },
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
