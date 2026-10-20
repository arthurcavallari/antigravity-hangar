import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildChildIframeUrl,
  loadHangarConfig,
  updateSidecarRule,
  updateHangarLayout,
} from '../lib/config-store.mjs';
import { enrichSidecarList, fetchHangarState } from '../lib/state-orchestrator.mjs';

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
});
