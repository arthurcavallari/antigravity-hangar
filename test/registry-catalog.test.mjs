import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectWorkspaceSuggestions,
  fetchRegistry,
  isNewerSemver,
} from '../lib/registry-catalog.mjs';
import { writeJsonNoBom } from '../lib/config-store.mjs';

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

      const catalog = await fetchRegistry({
        configPath: cfgPath,
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
