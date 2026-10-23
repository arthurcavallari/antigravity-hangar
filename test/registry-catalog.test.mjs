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
  probeUpstreamVersion,
  readInstalledSidecarVersion,
} from '../lib/registry-catalog.mjs';
import { enrichSidecarList } from '../lib/state-orchestrator.mjs';
import { loadHangarConfig, readJsonSafe, writeJsonNoBom } from '../lib/config-store.mjs';
import { GITHUB_REGISTRY_URL, HANGAR_REGISTRY_URL, HANGAR_VERSION } from '../lib/constants.mjs';
import { createSidecarLink } from 'antigravity-sidecar-kit/setup';

// Installs the way Hangar and npx do: a copy under packagesDir, linked from sidecars/<id>
function installManagedCopy(sidecarsDir, packagesDir, id) {
  const copyDir = join(packagesDir, `${id}@test`);
  mkdirSync(copyDir, { recursive: true });
  createSidecarLink(copyDir, join(sidecarsDir, id));
  return copyDir;
}

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
      const packagesDir = join(dir, 'packages');
      // Before sidecar.json exists on disk, stale hangar.json rule must not mark package as installed
      const catalogNotOnDisk = await fetchRegistry({
        configPath: cfgPath,
        sidecarsDir,
        packagesDir,
        fetchFn: async () => ({
          ok: true,
          json: async () => ({
            packages: [{ id: 'context-monitor', name: 'Context & Quota Monitor', latestVersion: '1.2.0' }],
          }),
        }),
      });
      assert.equal(catalogNotOnDisk.packages.find((p) => p.id === 'context-monitor').isInstalled, false);

      installManagedCopy(sidecarsDir, packagesDir, 'context-monitor');
      writeFileSync(join(sidecarsDir, 'context-monitor', 'sidecar.json'), '{"command":"node"}', 'utf8');

      const catalog = await fetchRegistry({
        configPath: cfgPath,
        sidecarsDir,
        packagesDir,
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

      // When package.json on disk is upgraded via npx/CLI to 1.2.0, on-disk version takes precedence over stale hangar.json
      writeJsonNoBom(join(sidecarsDir, 'context-monitor', 'package.json'), {
        name: 'antigravity-context-monitor',
        version: '1.2.0',
      });
      assert.equal(readInstalledSidecarVersion('context-monitor', sidecarsDir), '1.2.0');

      const catalogAfterUpgrade = await fetchRegistry({
        configPath: cfgPath,
        sidecarsDir,
        packagesDir,
        fetchFn: async () => ({
          ok: true,
          json: async () => ({
            packages: [{ id: 'context-monitor', name: 'Context & Quota Monitor', latestVersion: '1.2.0' }],
          }),
        }),
      });
      const upgradedPkg = catalogAfterUpgrade.packages.find((p) => p.id === 'context-monitor');
      assert.equal(upgradedPkg.installedVersion, '1.2.0');
      assert.equal(upgradedPkg.updateAvailable, false);

      const enriched = enrichSidecarList(
        [{ sidecarId: 'context-monitor', status: 'SIDECAR_STATUS_RUNNING', config: { hasWebUi: true } }],
        loadHangarConfig(cfgPath),
        { sidecarsDir, packagesDir }
      );
      assert.equal(enriched[0].installedVersion, '1.2.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists plugin entries without probing upstream, and offers updates only for plugins Hangar installed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-registry-plugin-test-'));
    try {
      const cfgPath = join(dir, 'hangar.json');
      const pluginsDir = join(dir, 'plugins');
      writeJsonNoBom(cfgPath, {
        schemaVersion: 1,
        telemetry: false,
        registryUrl: 'https://example.invalid',
        plugins: {
          'review-port': { dir: 'review-port', installedVersion: '1.0.0', ref: 'v1.0.0' },
          repinned: { dir: 'repinned', installedVersion: '2.0.0', ref: 'a'.repeat(40) },
        },
      });
      for (const id of ['review-port', 'repinned', 'theirs']) {
        mkdirSync(join(pluginsDir, id), { recursive: true });
        writeJsonNoBom(join(pluginsDir, id, 'plugin.json'), { name: id, version: '0.0.1' });
      }
      const repo = 'https://github.com/acme/plugins';
      const fetched = [];
      const catalog = await fetchRegistry({
        configPath: cfgPath,
        sidecarsDir: join(dir, 'sidecars'),
        packagesDir: join(dir, 'packages'),
        pluginsDir,
        probeUpstream: true,
        fetchFn: async (url) => {
          fetched.push(url);
          if (!url.endsWith('/registry.json')) return { ok: false };
          return {
            ok: true,
            json: async () => ({
              packages: [
                { id: 'review-port', kind: 'plugin', npmPackage: 'review-port', port: { from: 'claude' }, latestVersion: '1.1.0', release: { gitRepo: repo, ref: 'v1.1.0', path: 'plugins/review' } },
                { id: 'repinned', kind: 'plugin', latestVersion: '2.0.0', release: { gitRepo: repo, ref: 'b'.repeat(40) } },
                { id: 'theirs', kind: 'plugin', latestVersion: '9.0.0', release: { gitRepo: repo } },
                { id: 'not-installed', kind: 'plugin', latestVersion: '1.0.0', release: { gitRepo: repo } },
              ],
            }),
          };
        },
      });
      const byId = Object.fromEntries(catalog.packages.map((p) => [p.id, p]));

      assert.equal(byId['review-port'].isInstalled, true);
      assert.equal(byId['review-port'].installedVersion, '1.0.0');
      assert.equal(byId['review-port'].updateAvailable, true);
      assert.deepEqual(byId['review-port'].port, { from: 'claude' });
      assert.equal(byId['review-port'].release.path, 'plugins/review');
      assert.equal(byId.repinned.updateAvailable, true, 'a new pin at the same version is still an update');
      assert.equal(byId.theirs.isInstalled, true);
      assert.equal(byId.theirs.updateAvailable, false, "a plugin Hangar didn't install is never updated by it");
      assert.equal(byId['not-installed'].isInstalled, false);
      assert.equal(fetched.some((u) => u.includes('acme') || u.includes('review-port')), false, 'plugins are never probed');
      assert.deepEqual(Object.keys(catalog.sidecarUpdates).filter((id) => byId[id]?.kind === 'plugin'), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pins sidecars with release.ref or release.path to their registry version, and keeps sha256 only with its own tarball', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-registry-pinned-test-'));
    try {
      const cfgPath = join(dir, 'hangar.json');
      const sidecarsDir = join(dir, 'sidecars');
      const packagesDir = join(dir, 'packages');
      writeJsonNoBom(cfgPath, {
        schemaVersion: 1,
        telemetry: false,
        registryUrl: 'https://example.invalid',
        sidecars: {
          cockpit: { installedVersion: '0.1.0', source: 'github', gitRepo: 'https://github.com/acme/porter', ref: 'v0.1.0', path: 'cockpit' },
          dropped: { installedVersion: '1.0.0', source: 'github', gitRepo: 'https://github.com/acme/dropped', ref: 'v1.0.0' },
        },
      });
      for (const [id, version] of [['cockpit', '0.1.0'], ['dropped', '1.0.0']]) {
        const copyDir = installManagedCopy(sidecarsDir, packagesDir, id);
        writeJsonNoBom(join(copyDir, 'sidecar.json'), { command: 'node', args: ['server.mjs'] });
        writeJsonNoBom(join(copyDir, 'package.json'), { name: id, version });
      }
      const fetched = [];
      const npmLatest = {
        hashed: { version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/hashed/-/hashed-1.0.0.tgz' } },
        stale: { version: '1.1.0', dist: { tarball: 'https://registry.npmjs.org/stale/-/stale-1.1.0.tgz' } },
      };
      const catalog = await fetchRegistry({
        configPath: cfgPath,
        sidecarsDir,
        packagesDir,
        probeUpstream: true,
        fetchFn: async (url) => {
          fetched.push(url);
          if (url.endsWith('/registry.json')) {
            return {
              ok: true,
              json: async () => ({
                packages: [
                  { id: 'cockpit', npmPackage: 'porter-cockpit', latestVersion: '0.2.0', release: { gitRepo: 'https://github.com/acme/porter', ref: 'v0.2.0', path: 'cockpit' } },
                  { id: 'hashed', npmPackage: 'hashed', latestVersion: '1.0.0', release: { tarballUrl: 'https://registry.example.test/hashed-1.0.0.tgz', sha256: 'a'.repeat(64) } },
                  { id: 'stale', npmPackage: 'stale', latestVersion: '1.0.0', release: { tarballUrl: 'https://registry.example.test/stale-1.0.0.tgz', sha256: 'b'.repeat(64) } },
                ],
              }),
            };
          }
          const npmPkg = Object.keys(npmLatest).find((name) => url === `https://registry.npmjs.org/${name}/latest`);
          return npmPkg ? { ok: true, json: async () => npmLatest[npmPkg] } : { ok: false };
        },
      });
      const byId = Object.fromEntries(catalog.packages.map((p) => [p.id, p]));

      assert.equal(fetched.some((u) => /acme\/porter|porter-cockpit|acme\/dropped/.test(u)), false, 'pinned sidecars are never probed');
      assert.equal(byId.cockpit.latestVersion, '0.2.0');
      assert.equal(byId.cockpit.updateAvailable, true);
      assert.deepEqual(byId.cockpit.release, { gitRepo: 'https://github.com/acme/porter', ref: 'v0.2.0', path: 'cockpit' });
      assert.equal(catalog.sidecarUpdates.dropped, undefined, 'nor is a pinned install the registry no longer lists');

      assert.equal(byId.hashed.release.tarballUrl, 'https://registry.example.test/hashed-1.0.0.tgz');
      assert.equal(byId.hashed.release.sha256, 'a'.repeat(64));
      // A newer npm tarball replaces the registry's, so the registry's hash must not travel with it
      assert.equal(byId.stale.latestVersion, '1.1.0');
      assert.equal(byId.stale.release.tarballUrl, 'https://registry.npmjs.org/stale/-/stale-1.1.0.tgz');
      assert.equal('sha256' in byId.stale.release, false);
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

  it('probes hybrid upstream sources (npm registry + raw GitHub package.json) for Hangar itself and both catalog and sideloaded sidecars', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-hybrid-update-test-'));
    try {
      const cfgPath = join(dir, 'hangar.json');
      const sidecarsDir = join(dir, 'sidecars');
      const packagesDir = join(dir, 'packages');

      // 1. Install context-monitor v1.0.2 and a sideloaded GitHub sidecar custom-metrics v0.4.0
      installManagedCopy(sidecarsDir, packagesDir, 'context-monitor');
      writeJsonNoBom(join(sidecarsDir, 'context-monitor', 'sidecar.json'), { command: 'node' });
      writeJsonNoBom(join(sidecarsDir, 'context-monitor', 'package.json'), {
        name: 'antigravity-context-monitor',
        version: '1.0.2',
      });

      installManagedCopy(sidecarsDir, packagesDir, 'custom-metrics');
      writeJsonNoBom(join(sidecarsDir, 'custom-metrics', 'sidecar.json'), {
        command: 'node',
        version: '0.4.0',
      });

      writeJsonNoBom(cfgPath, {
        schemaVersion: 1,
        registryUrl: 'https://registry.example.test',
        sidecars: {
          'context-monitor': {
            scope: 'global',
            workspaces: ['*'],
            installedVersion: '1.0.2',
          },
          'custom-metrics': {
            scope: 'project',
            workspaces: ['C:/Projects/App'],
            installedVersion: '0.4.0',
            source: 'github',
            gitRepo: 'https://github.com/acme/custom-metrics',
          },
        },
      });

      const mockFetch = async (url) => {
        if (url === 'https://registry.example.test/registry.json') {
          return {
            ok: true,
            json: async () => ({
              hangar: { id: 'hangar', latestVersion: HANGAR_VERSION },
              packages: [
                {
                  id: 'context-monitor',
                  name: 'Context & Quota Monitor',
                  npmPackage: 'antigravity-context-monitor',
                  latestVersion: '1.0.2',
                  release: { gitRepo: 'https://github.com/arthurcavallari/antigravity-context-monitor' },
                },
              ],
            }),
          };
        }
        // npm reports newer versions for Hangar (9.9.0) and context-monitor (1.4.0)
        if (url === 'https://registry.npmjs.org/antigravity-hangar/latest') {
          return {
            ok: true,
            json: async () => ({
              version: '9.9.0',
              dist: { tarball: 'https://registry.npmjs.org/antigravity-hangar/-/antigravity-hangar-9.9.0.tgz' },
            }),
          };
        }
        if (url === 'https://registry.npmjs.org/antigravity-context-monitor/latest') {
          return {
            ok: true,
            json: async () => ({ version: '1.4.0' }),
          };
        }
        // Sideloaded GitHub repo has no package.json (404), falls back to HEAD/sidecar.json with v0.5.0
        if (url === 'https://raw.githubusercontent.com/acme/custom-metrics/HEAD/package.json') {
          return { ok: false, status: 404 };
        }
        if (url === 'https://raw.githubusercontent.com/acme/custom-metrics/HEAD/sidecar.json') {
          return {
            ok: true,
            json: async () => ({ command: 'node', version: '0.5.0' }),
          };
        }
        return { ok: false, status: 404 };
      };

      const catalog = await fetchRegistry({
        configPath: cfgPath,
        sidecarsDir,
        packagesDir,
        fetchFn: mockFetch,
        probeUpstream: true,
      });

      // Hangar self-update detected via npm
      assert.equal(catalog.hangar.installedVersion, HANGAR_VERSION);
      assert.equal(catalog.hangar.latestVersion, '9.9.0');
      assert.equal(catalog.hangar.updateAvailable, true);
      assert.equal(
        catalog.hangar.tarballUrl,
        'https://registry.npmjs.org/antigravity-hangar/-/antigravity-hangar-9.9.0.tgz'
      );

      // Catalog sidecar update detected via npm even though registry.json was still 1.0.2
      const ctxPkg = catalog.packages.find((p) => p.id === 'context-monitor');
      assert.equal(ctxPkg.installedVersion, '1.0.2');
      assert.equal(ctxPkg.latestVersion, '1.4.0');
      assert.equal(ctxPkg.updateAvailable, true);

      // Sideloaded non-catalog sidecar update detected via raw GitHub sidecar.json fallback
      assert.equal(catalog.sidecarUpdates['custom-metrics'].installedVersion, '0.4.0');
      assert.equal(catalog.sidecarUpdates['custom-metrics'].latestVersion, '0.5.0');
      assert.equal(catalog.sidecarUpdates['custom-metrics'].updateAvailable, true);

      // enrichSidecarList propagates updateAvailable and latestVersion to both catalog and sideloaded sidecars
      const enriched = enrichSidecarList(
        [
          { sidecarId: 'context-monitor', status: 'SIDECAR_STATUS_RUNNING', config: { hasWebUi: true } },
          { sidecarId: 'custom-metrics', status: 'SIDECAR_STATUS_RUNNING', config: { hasWebUi: true } },
        ],
        loadHangarConfig(cfgPath),
        { sidecarsDir, packagesDir }
      );
      const enrichedCtx = enriched.find((s) => s.sidecarId === 'context-monitor');
      const enrichedCustom = enriched.find((s) => s.sidecarId === 'custom-metrics');
      assert.equal(enrichedCtx.updateAvailable, true);
      assert.equal(enrichedCtx.latestVersion, '1.4.0');
      assert.equal(enrichedCustom.updateAvailable, true);
      assert.equal(enrichedCustom.latestVersion, '0.5.0');
      assert.equal(enrichedCustom.gitRepo, 'https://github.com/acme/custom-metrics');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never pairs a newer latestVersion with an older tarball when GitHub HEAD is ahead of npm', async () => {
    const npmTarball = (name, ver) => `https://registry.npmjs.org/${name}/-/${name}-${ver}.tgz`;
    const makeFetch = (routes) => async (url) => {
      const body = routes[url];
      return body ? { ok: true, json: async () => body } : { ok: false, status: 404 };
    };

    // npm 1.0.2 (with tarball) is resolved first, then GitHub HEAD reports 1.0.3 (no tarball)
    const probed = await probeUpstreamVersion({
      npmPackage: 'acme-widget',
      gitRepo: 'https://github.com/acme/widget',
      currentVersion: '1.0.0',
      fetchFn: makeFetch({
        'https://registry.npmjs.org/acme-widget/latest': {
          version: '1.0.2',
          dist: { tarball: npmTarball('acme-widget', '1.0.2') },
        },
        'https://raw.githubusercontent.com/acme/widget/HEAD/package.json': { version: '1.0.3' },
      }),
    });
    assert.equal(probed.latestVersion, '1.0.3');
    assert.equal(probed.tarballUrl, '');

    // When npm has caught up, its tarball for the same version is kept
    const caughtUp = await probeUpstreamVersion({
      npmPackage: 'acme-widget',
      gitRepo: 'https://github.com/acme/widget',
      currentVersion: '1.0.0',
      fetchFn: makeFetch({
        'https://registry.npmjs.org/acme-widget/latest': {
          version: '1.0.3',
          dist: { tarball: npmTarball('acme-widget', '1.0.3') },
        },
        'https://raw.githubusercontent.com/acme/widget/HEAD/package.json': { version: '1.0.3' },
      }),
    });
    assert.equal(caughtUp.latestVersion, '1.0.3');
    assert.equal(caughtUp.tarballUrl, npmTarball('acme-widget', '1.0.3'));

    const dir = mkdtempSync(join(tmpdir(), 'hangar-tarball-pairing-test-'));
    try {
      const cfgPath = join(dir, 'hangar.json');
      const sidecarsDir = join(dir, 'sidecars');
      const packagesDir = join(dir, 'packages');
      installManagedCopy(sidecarsDir, packagesDir, 'ctx-pkg');
      writeJsonNoBom(join(sidecarsDir, 'ctx-pkg', 'sidecar.json'), { command: 'node', version: '1.0.0' });
      installManagedCopy(sidecarsDir, packagesDir, 'side-pkg');
      writeJsonNoBom(join(sidecarsDir, 'side-pkg', 'sidecar.json'), { command: 'node', version: '0.4.0' });
      writeJsonNoBom(cfgPath, {
        schemaVersion: 1,
        registryUrl: 'https://registry.example.test',
        sidecars: {
          // Tarballs recorded at install time belong to the installed versions
          'ctx-pkg': { scope: 'global', workspaces: ['*'], tarballUrl: 'https://cdn.example.test/ctx-pkg-1.0.0.tgz' },
          'side-pkg': {
            scope: 'global',
            workspaces: ['*'],
            source: 'github',
            gitRepo: 'https://github.com/acme/side-pkg',
            tarballUrl: 'https://cdn.example.test/side-pkg-0.4.0.tgz',
          },
        },
      });

      const catalog = await fetchRegistry({
        configPath: cfgPath,
        sidecarsDir,
        packagesDir,
        probeUpstream: true,
        fetchFn: makeFetch({
          'https://registry.example.test/registry.json': {
            hangar: {
              id: 'hangar',
              npmPackage: 'acme-hangar',
              latestVersion: '50.0.0',
              release: {
                gitRepo: 'https://github.com/acme/hangar',
                tarballUrl: npmTarball('acme-hangar', '50.0.0'),
              },
            },
            packages: [
              {
                id: 'ctx-pkg',
                name: 'Ctx Pkg',
                npmPackage: 'acme-ctx-pkg',
                latestVersion: '1.0.2',
                release: {
                  gitRepo: 'https://github.com/acme/ctx-pkg',
                  tarballUrl: npmTarball('acme-ctx-pkg', '1.0.2'),
                },
              },
            ],
          },
          'https://registry.npmjs.org/acme-hangar/latest': {
            version: '50.0.0',
            dist: { tarball: npmTarball('acme-hangar', '50.0.0') },
          },
          'https://raw.githubusercontent.com/acme/hangar/HEAD/package.json': { version: '50.0.1' },
          'https://registry.npmjs.org/acme-ctx-pkg/latest': {
            version: '1.0.2',
            dist: { tarball: npmTarball('acme-ctx-pkg', '1.0.2') },
          },
          'https://raw.githubusercontent.com/acme/ctx-pkg/HEAD/package.json': { version: '1.0.3' },
          'https://raw.githubusercontent.com/acme/side-pkg/HEAD/package.json': { version: '0.5.0' },
        }),
      });

      // Hangar self-update: GitHub 50.0.1 must not reuse the registry/npm 50.0.0 tarball
      assert.equal(catalog.hangar.latestVersion, '50.0.1');
      assert.equal(catalog.hangar.tarballUrl, '');

      // Catalog merge: GitHub 1.0.3 must not reuse the 1.0.2 release tarball or the installed 1.0.0 one
      const ctxPkg = catalog.packages.find((p) => p.id === 'ctx-pkg');
      assert.equal(ctxPkg.latestVersion, '1.0.3');
      assert.equal(ctxPkg.release.tarballUrl, undefined);
      assert.equal(catalog.sidecarUpdates['ctx-pkg'].tarballUrl, '');

      // Sideloaded sidecar: GitHub 0.5.0 must not reuse the installed 0.4.0 tarball
      assert.equal(catalog.sidecarUpdates['side-pkg'].latestVersion, '0.5.0');
      assert.equal(catalog.sidecarUpdates['side-pkg'].tarballUrl, '');

      // The Installed pane's Update button reads sc.tarballUrl, which must not fall back to the installed tarball
      const enriched = enrichSidecarList(
        [
          { sidecarId: 'ctx-pkg', status: 'SIDECAR_STATUS_RUNNING', config: { hasWebUi: true } },
          { sidecarId: 'side-pkg', status: 'SIDECAR_STATUS_RUNNING', config: { hasWebUi: true } },
        ],
        loadHangarConfig(cfgPath),
        { sidecarsDir, packagesDir }
      );
      for (const sc of enriched) {
        assert.equal(sc.updateAvailable, true, sc.sidecarId);
        assert.equal(sc.tarballUrl, '', sc.sidecarId);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never offers updates for a user's own folder, and never takes npm tarballs for GitHub clones", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-update-scope-test-'));
    try {
      const cfgPath = join(dir, 'hangar.json');
      const sidecarsDir = join(dir, 'sidecars');
      const packagesDir = join(dir, 'packages');
      const writeSidecar = (folder, pkgJson) => {
        mkdirSync(folder, { recursive: true });
        writeJsonNoBom(join(folder, 'sidecar.json'), { command: 'node' });
        writeJsonNoBom(join(folder, 'package.json'), pkgJson);
      };

      // Dev checkout linked from sidecars/ whose package.json name collides with an unrelated npm package
      const devCheckout = join(dir, 'projects', 'dev-tool');
      writeSidecar(devCheckout, { name: 'left-pad', version: '1.0.0' });
      createSidecarLink(devCheckout, join(sidecarsDir, 'dev-tool'));
      // Hand-placed real folder in sidecars/
      writeSidecar(join(sidecarsDir, 'hand-placed'), {
        name: 'hand-placed-pkg',
        version: '1.0.0',
        repository: 'github:acme/hand-placed',
      });
      // Dev checkout of a catalog sidecar, linked under the catalog's id
      const ctxCheckout = join(dir, 'projects', 'antigravity-context-monitor');
      writeSidecar(ctxCheckout, { name: 'antigravity-context-monitor', version: '1.0.0' });
      createSidecarLink(ctxCheckout, join(sidecarsDir, 'context-monitor'));
      // Hangar-managed GitHub clone whose package.json name also collides with left-pad on npm
      installManagedCopy(sidecarsDir, packagesDir, 'gh-clone');
      writeJsonNoBom(join(sidecarsDir, 'gh-clone', 'sidecar.json'), { command: 'node' });
      writeJsonNoBom(join(sidecarsDir, 'gh-clone', 'package.json'), { name: 'left-pad', version: '0.1.0' });

      writeJsonNoBom(cfgPath, {
        schemaVersion: 1,
        registryUrl: 'https://registry.example.test',
        sidecars: {
          'dev-tool': { scope: 'global', workspaces: ['*'], source: 'local' },
          'gh-clone': { scope: 'global', workspaces: ['*'], source: 'github', gitRepo: 'https://github.com/acme/gh-clone' },
        },
      });

      const requested = [];
      const routes = {
        'https://registry.example.test/registry.json': {
          packages: [{ id: 'context-monitor', name: 'Context Monitor', npmPackage: 'antigravity-context-monitor', latestVersion: '1.2.0' }],
        },
        'https://registry.npmjs.org/left-pad/latest': {
          version: '9.9.9',
          dist: { tarball: 'https://registry.npmjs.org/left-pad/-/left-pad-9.9.9.tgz' },
        },
        'https://raw.githubusercontent.com/acme/gh-clone/HEAD/package.json': { version: '0.2.0' },
      };
      const catalog = await fetchRegistry({
        configPath: cfgPath,
        sidecarsDir,
        packagesDir,
        probeUpstream: true,
        fetchFn: async (url) => {
          requested.push(url);
          return routes[url] ? { ok: true, json: async () => routes[url] } : { ok: false, status: 404 };
        },
      });

      assert.ok(!requested.includes('https://registry.npmjs.org/left-pad/latest'), 'no npm lookup by a colliding name');
      assert.ok(!requested.some((u) => u.includes('acme/hand-placed')), "user's own folders are never probed");
      assert.equal(catalog.sidecarUpdates['dev-tool'], undefined);
      assert.equal(catalog.sidecarUpdates['hand-placed'], undefined);
      assert.equal(catalog.sidecarUpdates['gh-clone'].latestVersion, '0.2.0');
      assert.equal(catalog.sidecarUpdates['gh-clone'].tarballUrl, '');

      const ctxPkg = catalog.packages.find((p) => p.id === 'context-monitor');
      assert.equal(ctxPkg.isInstalled, true);
      assert.equal(ctxPkg.updateAvailable, false, 'a dev checkout under a catalog id is not replaced');

      const enriched = enrichSidecarList(
        ['dev-tool', 'hand-placed', 'context-monitor', 'gh-clone'].map((sidecarId) => ({
          sidecarId, status: 'SIDECAR_STATUS_RUNNING', config: { hasWebUi: true },
        })),
        loadHangarConfig(cfgPath),
        { sidecarsDir, packagesDir }
      );
      const updatable = Object.fromEntries(enriched.map((s) => [s.sidecarId, s.updateAvailable]));
      assert.deepEqual(updatable, { 'dev-tool': false, 'hand-placed': false, 'context-monitor': false, 'gh-clone': true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates the old GitHub registryUrl to the Worker, keeps custom URLs, and falls back to GitHub without telemetry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-registry-url-test-'));
    try {
      const cfgPath = join(dir, 'hangar.json');
      for (const old of [GITHUB_REGISTRY_URL, `${GITHUB_REGISTRY_URL}/`, `${GITHUB_REGISTRY_URL}/registry.json`]) {
        writeJsonNoBom(cfgPath, { schemaVersion: 1, installId: 'keep', registryUrl: old });
        assert.equal(loadHangarConfig(cfgPath).registryUrl, HANGAR_REGISTRY_URL, old);
      }
      writeJsonNoBom(cfgPath, { schemaVersion: 1, installId: 'keep', registryUrl: 'https://my-mirror.example.test' });
      assert.equal(loadHangarConfig(cfgPath).registryUrl, 'https://my-mirror.example.test');

      // Worker unreachable: the catalog still comes from GitHub, and GitHub never sees the telemetry headers
      writeJsonNoBom(cfgPath, { schemaVersion: 1, installId: '11111111-2222-4333-8444-555555555555' });
      const calls = [];
      const catalog = await fetchRegistry({
        configPath: cfgPath,
        sidecarsDir: join(dir, 'sidecars'),
        env: {},
        fetchFn: async (url, opts) => {
          calls.push({ url, headers: opts?.headers });
          if (url.startsWith(HANGAR_REGISTRY_URL)) throw new Error('getaddrinfo ENOTFOUND');
          return { ok: true, json: async () => ({ packages: [{ id: 'from-github', name: 'From GitHub' }] }) };
        },
      });
      assert.deepEqual(calls.map((c) => c.url), [`${HANGAR_REGISTRY_URL}/registry.json`, `${GITHUB_REGISTRY_URL}/registry.json`]);
      assert.equal(calls[0].headers['X-Hangar-Install-Id'], '11111111-2222-4333-8444-555555555555');
      assert.equal(calls[1].headers, undefined);
      assert.ok(catalog.packages.some((p) => p.id === 'from-github'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
