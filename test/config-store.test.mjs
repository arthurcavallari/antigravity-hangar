import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertValidSidecarId,
  buildChildIframeUrl,
  loadHangarConfig,
  readJsonSafe,
  saveHangarConfig,
  updateSidecarRule,
  updateHangarLayout,
  writeJsonNoBom,
} from '../lib/config-store.mjs';
import { HibernationManager } from '../lib/hibernation-manager.mjs';
import { enrichSidecarList, fetchHangarState, manageChildSidecar } from '../lib/state-orchestrator.mjs';

describe('config-store and child iframe URL normalization', () => {
  it('targets child raw webPort on 127.0.0.1 with Gateway token and forwards conversationId', () => {
    const url = buildChildIframeUrl(
      'http://localhost:60922?token=secret123',
      '/ui.html',
      'conv-abc-999',
      60920
    );
    assert.equal(
      url,
      'http://127.0.0.1:60920/ui.html?token=secret123&conversationId=conv-abc-999'
    );
  });

  it('persists rule updates and layout updates without BOM', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-config-test-'));
    try {
      const cfgPath = join(dir, 'hangar.json');
      updateSidecarRule(
        'db-inspector',
        { scope: 'project', workspaces: ['c:/Projects/App', 'c:/Test'], autoHibernate: true },
        { configPath: cfgPath, sidecarsDir: dir }
      );
      updateHangarLayout({ splitViewEnabled: true, pinnedTopHeightPx: 210 }, cfgPath);

      const loaded = loadHangarConfig(cfgPath);
      assert.equal(loaded.layout.splitViewEnabled, true);
      assert.equal(loaded.layout.pinnedTopHeightPx, 210);
      assert.deepEqual(loaded.sidecars['db-inspector'].workspaces, ['c:/Projects/App', 'c:/Test']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an unparseable hangar.json with defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-config-corrupt-test-'));
    try {
      const cfgPath = join(dir, 'hangar.json');
      // Hand-edited file with a trailing comma: telemetry opt-out and a sidecar rule must survive
      const corrupt = `{
  "schemaVersion": 1,
  "installId": "keep-me",
  "telemetry": false,
  "sidecars": { "db-inspector": { "scope": "global", "workspaces": ["*"] } },
}
`;
      writeFileSync(cfgPath, corrupt, 'utf8');

      const loaded = loadHangarConfig(cfgPath);
      assert.equal(loaded.telemetry, true, 'reads still fall back to defaults');

      assert.throws(
        () => updateHangarLayout({ splitViewEnabled: true }, cfgPath),
        /Refusing to save Hangar settings: .*hangar\.json could not be parsed/
      );
      assert.throws(
        () => updateSidecarRule('db-inspector', { workspaces: ['c:/Other'] }, { configPath: cfgPath, sidecarsDir: dir }),
        /Refusing to save Hangar settings/
      );
      assert.throws(() => saveHangarConfig(loaded, cfgPath), /Refusing to save Hangar settings/);
      assert.equal(readFileSync(cfgPath, 'utf8'), corrupt);

      // Once the user fixes the file, saves go through and keep their settings
      writeFileSync(cfgPath, corrupt.replace('} },\n}', '} }\n}'), 'utf8');
      updateHangarLayout({ splitViewEnabled: true }, cfgPath);
      const fixed = loadHangarConfig(cfgPath);
      assert.equal(fixed.telemetry, false);
      assert.equal(fixed.layout.splitViewEnabled, true);
      assert.deepEqual(fixed.sidecars['db-inspector'].workspaces, ['*']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('filters out hangar and legacy sidecar-hub to prevent recursive self-embedding', () => {
    const rawSidecars = [
      {
        sidecarId: 'hangar',
        status: 'SIDECAR_STATUS_RUNNING',
        webPort: 61000,
        baseUrl: 'http://localhost:61001?token=hangar',
        config: { displayName: 'Hangar', hasWebUi: true },
      },
      {
        sidecarId: 'sidecar-hub',
        status: 'SIDECAR_STATUS_RUNNING',
        webPort: 61002,
        baseUrl: 'http://localhost:61003?token=hub',
        config: { displayName: 'Sidecar Hub', hasWebUi: true },
      },
      {
        sidecarId: 'context-monitor',
        status: 'SIDECAR_STATUS_RUNNING',
        webPort: 60920,
        baseUrl: 'http://localhost:60922?token=ctx',
        config: {
          displayName: 'Context Monitor',
          hasWebUi: true,
          uiConfig: { views: [{ path: '/' }] },
        },
      },
    ];

    const hangarConfig = loadHangarConfig(join(tmpdir(), 'nonexistent-hangar-cfg.json'));
    const enriched = enrichSidecarList(rawSidecars, hangarConfig, {
      activeWorkspacePath: 'c:/Projects/App',
      conversationId: 'conv-1',
      sidecarsDir: join(tmpdir(), 'nonexistent-sidecars-dir'),
    });

    assert.equal(enriched.length, 1);
    assert.equal(enriched[0].sidecarId, 'context-monitor');
    assert.equal(
      enriched[0].iframeUrl,
      'http://127.0.0.1:60920/?token=ctx&conversationId=conv-1'
    );
  });

  it('never hibernates a plugin sidecar, since that would switch off the whole plugin', async () => {
    const rule = { scope: 'project', workspaces: ['c:/Elsewhere'], autoHibernate: true, installedVersion: '1.0.0' };
    const hangarConfig = {
      layout: {},
      sidecars: { 'acme/viewer': { ...rule, source: 'plugin:acme' }, 'db-inspector': { ...rule, source: 'local' } },
    };
    const raw = (sidecarId, status) => ({ sidecarId, status, webPort: 61000, baseUrl: 'http://localhost:61001?token=t', config: { displayName: sidecarId, hasWebUi: true } });
    const list = (status) => enrichSidecarList([raw('acme/viewer', status), raw('db-inspector', status)], hangarConfig, {
      activeWorkspacePath: 'c:/Projects/App',
      sidecarsDir: join(tmpdir(), 'nonexistent-sidecars-dir'),
    });

    const running = list('SIDECAR_STATUS_RUNNING');
    const [plugin, standalone] = [running.find((s) => s.sidecarId === 'acme/viewer'), running.find((s) => s.sidecarId === 'db-inspector')];
    assert.equal(plugin.autoHibernate, false);
    assert.equal(plugin.autoHibernateLocked, true);
    assert.equal(standalone.autoHibernate, true);
    assert.equal(standalone.autoHibernateLocked, false);

    const stopped = list('SIDECAR_STATUS_STOPPED');
    assert.equal(stopped.find((s) => s.sidecarId === 'acme/viewer').statusBadge, 'STOPPED');
    assert.equal(stopped.find((s) => s.sidecarId === 'db-inspector').statusBadge, 'HIBERNATED');

    // Idle for longer than the timeout: only the standalone sidecar is disabled
    const hibernator = new HibernationManager();
    const calls = [];
    const manageSidecarFn = async (action, id) => calls.push(`${action} ${id}`);
    const t0 = 1_700_000_000_000;
    await hibernator.reconcile(running, { hibernateAfterIdleMinutes: 10, nowMs: t0, manageSidecarFn });
    await hibernator.reconcile(running, { hibernateAfterIdleMinutes: 10, nowMs: t0 + 11 * 60 * 1000, manageSidecarFn });
    assert.deepEqual(calls, ['SIDECAR_ACTION_DISABLE db-inspector']);
  });

  it('forwards dynamic conversationId from GetAllCascadeTrajectories into child iframeUrl via fetchHangarState', async () => {
    const trajectoriesResponse = {
      trajectorySummaries: {
        'conv-old': {
          annotations: { lastUserViewTime: '2026-10-17T05:00:00Z' },
          workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c:/OldProject' }],
        },
        'conv-latest': {
          annotations: { lastUserViewTime: '2026-10-17T07:00:00Z' },
          workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c%3A/Projects/ActiveApp' }],
        },
      },
    };

    const hangarState = await fetchHangarState({
      conversationId: 'conv-old',
      configPath: join(tmpdir(), 'nonexistent-hangar-cfg.json'),
      sidecarsDir: join(tmpdir(), 'nonexistent-sidecars-dir'),
      rpcFn: async (method) =>
        method === 'GetSidecars'
          ? {
              sidecars: [
                {
                  sidecarId: 'context-monitor',
                  status: 'SIDECAR_STATUS_RUNNING',
                  webPort: 51234,
                  config: { hasWebUi: true },
                },
              ],
            }
          : trajectoriesResponse,
    });
    assert.equal(hangarState.activeWorkspace.conversationId, 'conv-latest');
    assert.equal(
      hangarState.sidecars[0].iframeUrl,
      'http://127.0.0.1:51234/?conversationId=conv-latest'
    );
  });

  it("revokes workspaces removed from a rule, keeps the author's permissions, and skips no-op writes", () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-permissions-test-'));
    try {
      const cfgPath = join(dir, 'hangar.json');
      const sidecarsDir = join(dir, 'sidecars');
      const manifestPath = join(sidecarsDir, 'child', 'sidecar.json');
      mkdirSync(join(sidecarsDir, 'child'), { recursive: true });
      writeJsonNoBom(manifestPath, {
        command: 'node',
        agent_permissions: { workspace_uris: ['file:///author/declared'], allows_user_interactions: false },
      });
      const opts = { configPath: cfgPath, sidecarsDir };
      const uris = () => readJsonSafe(manifestPath, {}).agent_permissions.workspace_uris;
      const grants = (name) => uris().some((u) => u.endsWith(`/Projects/${name}`));

      const rule = updateSidecarRule('child', { scope: 'project', workspaces: ['C:/Projects/a', 'C:/Projects/b'] }, opts);
      assert.equal(uris().length, 3);
      assert.ok(grants('a') && grants('b'));
      assert.equal(rule.grantedWorkspaceUris.length, 2);
      assert.equal(readJsonSafe(manifestPath, {}).agent_permissions.allows_user_interactions, false);

      updateSidecarRule('child', { workspaces: ['C:/Projects/a'] }, opts);
      assert.ok(grants('a'));
      assert.ok(!grants('b'), 'removed workspace is revoked');
      assert.ok(uris().includes('file:///author/declared'), "author's own URI is kept");

      // Re-saving the same rule must not rewrite the file (it may be a linked dev checkout)
      const compact = JSON.stringify(readJsonSafe(manifestPath, {}));
      writeFileSync(manifestPath, compact, 'utf8');
      updateSidecarRule('child', { workspaces: ['C:/Projects/a'] }, opts);
      assert.equal(readFileSync(manifestPath, 'utf8'), compact);

      updateSidecarRule('child', { scope: 'global', workspaces: ['*'] }, opts);
      assert.deepEqual(uris(), ['file:///author/declared']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a manually stopped sidecar off after Hangar restarts, and auto-wakes it once re-enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-manual-stop-test-'));
    try {
      const cfgPath = join(dir, 'hangar.json');
      writeJsonNoBom(cfgPath, {
        schemaVersion: 1,
        sidecars: { db: { scope: 'global', workspaces: ['*'], autoHibernate: true } },
      });
      const manageCalls = [];
      const rpcFn = async (method, payload) => {
        if (method === 'ManageSidecar') manageCalls.push(payload.action);
        if (method === 'GetSidecars') {
          return { sidecars: [{ sidecarId: 'db', status: 'SIDECAR_STATUS_STOPPED', config: { hasWebUi: true } }] };
        }
        return { trajectorySummaries: {} };
      };
      const poll = (hibernator) =>
        fetchHangarState({ configPath: cfgPath, sidecarsDir: join(dir, 'sidecars'), hibernator, rpcFn });

      await manageChildSidecar('db', 'SIDECAR_ACTION_DISABLE', {
        hibernator: new HibernationManager(), rpcFn, configPath: cfgPath,
      });
      assert.deepEqual(loadHangarConfig(cfgPath).manuallyStopped, ['db']);

      // A fresh HibernationManager stands in for a restarted Hangar process
      manageCalls.length = 0;
      await poll(new HibernationManager());
      assert.deepEqual(manageCalls, [], 'manually stopped sidecar must not be auto-woken');

      await manageChildSidecar('db', 'SIDECAR_ACTION_ENABLE', {
        hibernator: new HibernationManager(), rpcFn, configPath: cfgPath,
      });
      assert.deepEqual(loadHangarConfig(cfgPath).manuallyStopped, []);
      manageCalls.length = 0;
      await poll(new HibernationManager());
      assert.deepEqual(manageCalls, ['SIDECAR_ACTION_ENABLE']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disables and re-enables plugin-bundled sidecars via JetboxWriteState and waits for GetSidecars to settle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-plugin-sidecar-test-'));
    try {
      const cfgPath = join(dir, 'hangar.json');
      const id = 'science/biomolecular_structure_viewer';
      let getCount = 0;
      let currentStatus = 'SIDECAR_STATUS_RUNNING';
      let currentEnabled = true;
      const calls = [];

      const rpcFn = async (method, payload) => {
        if (method === 'GetSidecars') {
          getCount++;
          // Simulate Language Server's asynchronous scanAndReload settling on the second poll after write
          if (getCount >= 3 && calls.some((c) => c[0] === 'JetboxWriteState')) {
            const target = calls.findLast((c) => c[0] === 'JetboxWriteState')[1].userConfig.plugins['-1870732469773246571'].enabled;
            currentEnabled = target;
            currentStatus = target ? 'SIDECAR_STATUS_RUNNING' : 'SIDECAR_STATUS_STOPPED';
          }
          return {
            sidecars: [
              {
                sidecarId: id,
                pluginPath: 'file:///C:/Users/test/.gemini/config/plugins/-1870732469773246571',
                status: currentStatus,
                userConfig: { enabled: currentEnabled },
                config: { hasWebUi: true },
              },
            ],
          };
        }
        calls.push([method, payload]);
        return {};
      };

      await manageChildSidecar(id, 'SIDECAR_ACTION_DISABLE', {
        hibernator: new HibernationManager(),
        rpcFn,
        configPath: cfgPath,
        pollMs: 1,
        maxWaitMs: 200,
      });

      assert.deepEqual(calls, [
        ['JetboxWriteState', { userConfig: { plugins: { '-1870732469773246571': { enabled: false } } } }],
        ['ManageSidecar', { action: 'SIDECAR_ACTION_DISABLE', sidecarId: id }],
      ]);
      assert.equal(currentStatus, 'SIDECAR_STATUS_STOPPED');
      assert.deepEqual(loadHangarConfig(cfgPath).manuallyStopped, [id]);

      calls.length = 0;
      getCount = 0;
      await manageChildSidecar(id, 'SIDECAR_ACTION_ENABLE', {
        hibernator: new HibernationManager(),
        rpcFn,
        configPath: cfgPath,
        pollMs: 1,
        maxWaitMs: 200,
      });

      assert.deepEqual(calls, [
        ['JetboxWriteState', { userConfig: { plugins: { '-1870732469773246571': { enabled: true } } } }],
        ['ManageSidecar', { action: 'SIDECAR_ACTION_ENABLE', sidecarId: id }],
      ]);
      assert.equal(currentStatus, 'SIDECAR_STATUS_RUNNING');
      assert.deepEqual(loadHangarConfig(cfgPath).manuallyStopped, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects sidecar ids that could escape sidecars/ before touching config or the Language Server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-id-validation-test-'));
    try {
      const cfgPath = join(dir, 'hangar.json');
      for (const bad of ['..\\..\\evil', '../evil', '/evil', 'evil/', 'a//b', '.hidden', 'a/..']) {
        assert.throws(() => assertValidSidecarId(bad), /Invalid sidecarId/, bad);
      }
      for (const good of ['context-monitor', 'plugin/name', 'My.Sidecar_2']) {
        assert.doesNotThrow(() => assertValidSidecarId(good), good);
      }

      assert.throws(
        () => updateSidecarRule('..\\..\\evil', { workspaces: ['C:/x'] }, { configPath: cfgPath, sidecarsDir: dir }),
        /Invalid sidecarId/
      );
      const rpcCalls = [];
      await assert.rejects(
        manageChildSidecar('..\\evil', 'SIDECAR_ACTION_STOP', {
          rpcFn: async (...args) => rpcCalls.push(args), configPath: cfgPath,
        }),
        /Invalid sidecarId/
      );
      assert.equal(rpcCalls.length, 0);
      assert.equal(readJsonSafe(cfgPath, null), null, 'hangar.json is not written');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
