import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRegistryHeaders,
  detectWorkspaceSuggestions,
  fetchRegistry,
  isNewerSemver,
} from '../lib/registry-catalog.mjs';
import { loadHangarConfig, readJsonSafe, writeJsonNoBom } from '../lib/config-store.mjs';
import { HANGAR_VERSION } from '../lib/constants.mjs';

describe('marketplace registry catalog and workspace trigger advisor', () => {
  it('compares semver versions and merges remote registry packages with local install rules', async () => {
    assert.equal(isNewerSemver('1.0.0', '1.1.0'), true);
    assert.equal(isNewerSemver('1.2.0', '1.0.0'), false);
    assert.equal(isNewerSemver('1.0.0', '1.0.0'), false);

    const dir = mkdtempSync(join(tmpdir(), 'hangar-registry-test-'));
    try {
      const cfgPath = join(dir, 'hangar.json');
      writeJsonNoBom(cfgPath, {
        schemaVersion: 1,
        registryUrl: 'https://example.invalid',
        sidecars: {
          'context-monitor': {
            scope: 'global',
            workspaces: ['*'],
            installedVersion: '1.0.0',
          },
        },
      });

      const sidecarsDir = join(dir, 'sidecars');
      // Before sidecar.json exists on disk, stale hangar.json rule must not mark package as installed
      const catalogNotOnDisk = await fetchRegistry({
        configPath: cfgPath,
        sidecarsDir,
        fetchFn: async () => ({
          ok: true,
          json: async () => ({
            packages: [{ id: 'context-monitor', name: 'Context & Quota Monitor', latestVersion: '1.2.0' }],
          }),
        }),
      });
      assert.equal(catalogNotOnDisk.packages.find((p) => p.id === 'context-monitor').isInstalled, false);

      mkdirSync(join(sidecarsDir, 'context-monitor'), { recursive: true });
      writeFileSync(join(sidecarsDir, 'context-monitor', 'sidecar.json'), '{"command":"node"}', 'utf8');

      const catalog = await fetchRegistry({
        configPath: cfgPath,
        sidecarsDir,
        fetchFn: async () => ({
          ok: true,
          json: async () => ({
            packages: [
              {
                id: 'context-monitor',
                name: 'Context & Quota Monitor',
                latestVersion: '1.2.0',
              },
            ],
          }),
        }),
      });

      const ctxPkg = catalog.packages.find((p) => p.id === 'context-monitor');
      assert.equal(ctxPkg.isInstalled, true);
      assert.equal(ctxPkg.installedVersion, '1.0.0');
      assert.equal(ctxPkg.updateAvailable, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generates and persists a stable anonymous installId and injects or omits X-Hangar-* headers based on opt-out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-telemetry-test-'));
    try {
      const cfgPath = join(dir, 'hangar.json');
      writeJsonNoBom(cfgPath, {
        schemaVersion: 1,
        registryUrl: 'https://registry.example.test',
        sidecars: {
          'context-monitor': { scope: 'global', workspaces: ['*'], installedVersion: '1.0.0' },
          'docker-ops': { scope: 'project', workspaces: ['c:/app'], installedVersion: '1.0.0' },
        },
      });

      const firstLoad = loadHangarConfig(cfgPath);
      assert.match(firstLoad.installId, /^[0-9a-f-]{36}$/i);
      assert.equal(firstLoad.telemetry, true);

      const persistedRaw = readJsonSafe(cfgPath, {});
      assert.equal(persistedRaw.installId, firstLoad.installId);

      const secondLoad = loadHangarConfig(cfgPath);
      assert.equal(secondLoad.installId, firstLoad.installId);

      let capturedUrl = '';
      let capturedOpts = null;
      await fetchRegistry({
        configPath: cfgPath,
        env: {},
        platform: 'win32',
        fetchFn: async (url, opts) => {
          capturedUrl = url;
          capturedOpts = opts;
          return { ok: true, json: async () => ({ packages: [] }) };
        },
      });

      assert.equal(capturedUrl, 'https://registry.example.test/registry.json');
      assert.deepEqual(capturedOpts.headers, {
        'X-Hangar-Install-Id': firstLoad.installId,
        'X-Hangar-Version': HANGAR_VERSION,
        'X-Hangar-OS': 'win32',
        'X-Hangar-Sidecars': '2',
      });

      // Opt-out via DO_NOT_TRACK=1
      let dntOpts = null;
      await fetchRegistry({
        configPath: cfgPath,
        env: { DO_NOT_TRACK: '1' },
        platform: 'win32',
        fetchFn: async (_url, opts) => {
          dntOpts = opts;
          return { ok: true, json: async () => ({ packages: [] }) };
        },
      });
      assert.equal(dntOpts.headers, undefined);

      // Opt-out via HANGAR_TELEMETRY=0
      assert.deepEqual(
        buildRegistryHeaders(firstLoad, { env: { HANGAR_TELEMETRY: '0' }, platform: 'linux' }),
        {}
      );

      // Opt-out via hangar.json telemetry: false
      writeJsonNoBom(cfgPath, {
        ...persistedRaw,
        telemetry: false,
      });
      let cfgOptOutOpts = null;
      await fetchRegistry({
        configPath: cfgPath,
        env: {},
        platform: 'darwin',
        fetchFn: async (_url, opts) => {
          cfgOptOutOpts = opts;
          return { ok: true, json: async () => ({ packages: [] }) };
        },
      });
      assert.equal(cfgOptOutOpts.headers, undefined);
      // Regression: malformed JSON in hangar.json must not be clobbered on disk by installId persistence
      const corruptText = '{ "telemetry": false, ';
      writeFileSync(cfgPath, corruptText, 'utf8');
      const fallbackCfg = loadHangarConfig(cfgPath);
      assert.match(fallbackCfg.installId, /^[0-9a-f-]{36}$/i);
      const afterCorruptDisk = readJsonSafe(cfgPath, { sentinel: 'preserved' });
      assert.equal(afterCorruptDisk.sentinel, 'preserved');

      // Regression: registryUrl ending with /registry.json does not double-append /registry.json
      writeJsonNoBom(cfgPath, {
        ...persistedRaw,
        registryUrl: 'https://registry.example.test/api/v1/registry.json',
        telemetry: true,
      });
      let normalizedUrl = '';
      await fetchRegistry({
        configPath: cfgPath,
        env: {},
        platform: 'linux',
        fetchFn: async (url) => {
          normalizedUrl = url;
          return { ok: true, json: async () => ({ packages: [] }) };
        },
      });
      assert.equal(normalizedUrl, 'https://registry.example.test/api/v1/registry.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects workspace suggestions from trigger files like docker-compose.yml', () => {
    const wsDir = mkdtempSync(join(tmpdir(), 'hangar-ws-trigger-'));
    try {
      writeFileSync(join(wsDir, 'docker-compose.yml'), 'services: {}', 'utf8');

      // Case 1: custom registry package with docker-compose.yml trigger not installed -> suggests install
      const s1 = detectWorkspaceSuggestions({
        activeWorkspacePath: wsDir,
        sidecars: [],
        registryPackages: [
          {
            id: 'compose-viewer',
            name: 'Compose Viewer',
            latestVersion: '1.0.0',
            workspaceTriggers: { files: ['docker-compose.yml'] },
            release: { gitRepo: 'https://github.com/example/compose-viewer' },
          },
        ],
      });
      assert.equal(s1.length, 1);
      assert.equal(s1[0].sidecarId, 'compose-viewer');
      assert.equal(s1[0].actionType, 'install');

      // Case 2: local docker-ops installed (via BUILTIN_WORKSPACE_TRIGGERS) but not enabled for this workspace -> suggests enable
      const s2 = detectWorkspaceSuggestions({
        activeWorkspacePath: wsDir,
        sidecars: [
          {
            sidecarId: 'docker-ops',
            displayName: 'Docker Ops',
            matchesWorkspace: false,
            isRunning: true,
          },
        ],
      });
      assert.equal(s2.length, 1);
      assert.equal(s2[0].sidecarId, 'docker-ops');
      assert.equal(s2[0].actionType, 'enable');

      // Case 3: docker-ops already running & matched for workspace -> no suggestion
      const s3 = detectWorkspaceSuggestions({
        activeWorkspacePath: wsDir,
        sidecars: [
          {
            sidecarId: 'docker-ops',
            displayName: 'Docker Ops',
            matchesWorkspace: true,
            isRunning: true,
          },
        ],
      });
      assert.equal(s3.length, 0);
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
    }
  });
});
