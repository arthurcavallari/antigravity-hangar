import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertValidSidecarId, discoverPluginSidecarEntries } from '../lib/config-store.mjs';
import { enrichSidecarList, fetchHangarState, manageChildSidecar } from '../lib/state-orchestrator.mjs';

describe('Hangar multi-sidecar plugin discovery and security sanitization', () => {
  it('discoverPluginSidecarEntries finds multiple sidecars under sidecars/<subId>/sidecar.json, root sidecar.json, and plugin.json#sidecars', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hangar-multi-sidecar-'));
    try {
      const androidDir = join(tmp, 'android-cli-plugin');
      mkdirSync(join(androidDir, 'sidecars', 'compose-preview'), { recursive: true });
      mkdirSync(join(androidDir, 'sidecars', 'device-hub'), { recursive: true });
      writeFileSync(
        join(androidDir, 'plugin.json'),
        JSON.stringify({ name: 'android-cli-plugin', displayName: 'Android CLI' }),
        'utf8'
      );
      writeFileSync(
        join(androidDir, 'sidecars', 'compose-preview', 'sidecar.json'),
        JSON.stringify({ display_name: 'Android Compose Preview', has_web_ui: true }),
        'utf8'
      );
      writeFileSync(
        join(androidDir, 'sidecars', 'device-hub', 'sidecar.json'),
        JSON.stringify({ display_name: 'Android Device Hub', has_web_ui: true }),
        'utf8'
      );

      const androidEntries = discoverPluginSidecarEntries(androidDir, 'android-cli-plugin');
      assert.equal(androidEntries.length, 2);
      assert.deepEqual(
        androidEntries.map((e) => e.id).sort(),
        ['android-cli-plugin/compose-preview', 'android-cli-plugin/device-hub']
      );
      assert.ok(androidEntries.every((e) => e.parentPluginId === 'android-cli-plugin'));
      assert.ok(androidEntries.every((e) => e.sidecarDir && typeof e.config === 'object'));

      const manifestListedDir = join(tmp, 'custom-multi');
      mkdirSync(join(manifestListedDir, 'skills', 'alpha', 'sidecar'), { recursive: true });
      mkdirSync(join(manifestListedDir, 'panes', 'beta'), { recursive: true });
      writeFileSync(
        join(manifestListedDir, 'plugin.json'),
        JSON.stringify({
          name: 'custom-multi',
          sidecars: ['./skills/alpha/sidecar', './panes/beta'],
        }),
        'utf8'
      );
      writeFileSync(
        join(manifestListedDir, 'skills', 'alpha', 'sidecar', 'sidecar.json'),
        JSON.stringify({ displayName: 'Alpha Pane', hasWebUi: true }),
        'utf8'
      );
      writeFileSync(
        join(manifestListedDir, 'panes', 'beta', 'sidecar.json'),
        JSON.stringify({ displayName: 'Beta Pane', hasWebUi: true }),
        'utf8'
      );

      const listedEntries = discoverPluginSidecarEntries(manifestListedDir, 'custom-multi');
      assert.equal(listedEntries.length, 2);
      assert.deepEqual(
        listedEntries.map((e) => e.id).sort(),
        ['custom-multi/alpha', 'custom-multi/beta']
      );
      assert.ok(listedEntries.every((e) => e.parentPluginId === 'custom-multi'));

      const singleRootDir = join(tmp, 'single-root');
      mkdirSync(singleRootDir, { recursive: true });
      writeFileSync(
        join(singleRootDir, 'sidecar.json'),
        JSON.stringify({ displayName: 'Single Root Sidecar', hasWebUi: true }),
        'utf8'
      );
      const singleEntries = discoverPluginSidecarEntries(singleRootDir, 'single-root');
      assert.equal(singleEntries.length, 1);
      assert.equal(singleEntries[0].id, 'single-root');
      assert.equal(singleEntries[0].parentPluginId, 'single-root');
      assert.equal(singleEntries[0].sidecarDir, singleRootDir);
      assert.equal(singleEntries[0].config.displayName, 'Single Root Sidecar');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('state-orchestrator discovers all sub-sidecars from multi-sidecar plugins and syncs JetboxWriteState via parentPluginId', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hangar-orch-multi-'));
    try {
      const pluginsDir = join(tmp, 'plugins');
      const androidDir = join(pluginsDir, 'android-cli-plugin');
      const cfgPath = join(tmp, 'hangar.json');
      mkdirSync(join(androidDir, 'sidecars', 'compose-preview'), { recursive: true });
      mkdirSync(join(androidDir, 'sidecars', 'device-hub'), { recursive: true });
      writeFileSync(
        join(androidDir, 'plugin.json'),
        JSON.stringify({ name: 'android-cli-plugin', displayName: 'Android CLI' }),
        'utf8'
      );
      writeFileSync(
        join(androidDir, 'sidecars', 'compose-preview', 'sidecar.json'),
        JSON.stringify({ display_name: 'Android Compose Preview', has_web_ui: true }),
        'utf8'
      );
      writeFileSync(
        join(androidDir, 'sidecars', 'device-hub', 'sidecar.json'),
        JSON.stringify({ display_name: 'Android Device Hub', has_web_ui: true }),
        'utf8'
      );

      const enriched = enrichSidecarList([], {}, {
        pluginsDir,
        sidecarsDir: join(tmp, 'sidecars'),
      });
      assert.deepEqual(
        enriched.map((s) => s.sidecarId).sort(),
        ['android-cli-plugin/compose-preview', 'android-cli-plugin/device-hub']
      );
      assert.ok(enriched.every((s) => s.parentPluginId === 'android-cli-plugin'));

      const rpcCalls = [];
      const rpcFn = async (method, payload) => {
        rpcCalls.push([method, payload]);
        if (method === 'GetAllPlugins') {
          return { plugins: [{ name: 'android-cli-plugin', path: androidDir }] };
        }
        return { sidecars: [], trajectorySummaries: {} };
      };

      const state = await fetchHangarState({
        configPath: cfgPath,
        sidecarsDir: join(tmp, 'sidecars'),
        pluginsDir,
        rpcFn,
      });
      assert.deepEqual(
        state.sidecars.map((s) => s.sidecarId).sort(),
        ['android-cli-plugin/compose-preview', 'android-cli-plugin/device-hub']
      );

      rpcCalls.length = 0;
      const entries = discoverPluginSidecarEntries(androidDir, 'android-cli-plugin');
      await manageChildSidecar('android-cli-plugin/compose-preview', 'SIDECAR_ACTION_DISABLE', {
        rpcFn,
        configPath: cfgPath,
        rawSidecars: entries,
        pollMs: 1,
        maxWaitMs: 10,
      });

      // Only the plugin entry: the Language Server refuses ManageSidecar for a plugin's sidecars
      assert.deepEqual(rpcCalls, [
        ['JetboxWriteState', { userConfig: { plugins: { 'android-cli-plugin': { enabled: false } } } }],
      ]);

      const singleDir = join(pluginsDir, 'single-plugin');
      mkdirSync(singleDir, { recursive: true });
      writeFileSync(join(singleDir, 'plugin.json'), JSON.stringify({ name: 'single-plugin' }), 'utf8');
      writeFileSync(join(singleDir, 'sidecar.json'), JSON.stringify({ displayName: 'Single', hasWebUi: true }), 'utf8');
      rpcCalls.length = 0;
      await manageChildSidecar('single-plugin', 'SIDECAR_ACTION_DISABLE', {
        rpcFn,
        configPath: cfgPath,
        pluginsDir,
        pollMs: 1,
        maxWaitMs: 10,
      });
      assert.deepEqual(rpcCalls, [
        ['GetSidecars', {}],
        ['JetboxWriteState', { userConfig: { plugins: { 'single-plugin': { enabled: false } } } }],
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('sanitizes invalid subSlugs, deduplicates colliding sidecar IDs, and blocks symlink escapes in discoverPluginSidecarEntries (HUB-05)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hangar-discover-sec-'));
    try {
      const outsideDir = join(tmp, 'outside-secret');
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, 'sidecar.json'), JSON.stringify({ displayName: 'Escaped' }), 'utf8');

      const pluginDir = join(tmp, 'my-plugin');
      mkdirSync(join(pluginDir, 'sidecars', '_leading-underscore'), { recursive: true });
      mkdirSync(join(pluginDir, 'sidecars', 'viewer'), { recursive: true });
      mkdirSync(join(pluginDir, 'panes', 'viewer'), { recursive: true });
      writeFileSync(
        join(pluginDir, 'plugin.json'),
        JSON.stringify({ name: 'my-plugin', sidecars: ['./panes/viewer'] }),
        'utf8'
      );
      writeFileSync(
        join(pluginDir, 'sidecars', '_leading-underscore', 'sidecar.json'),
        JSON.stringify({ displayName: 'Underscore' }),
        'utf8'
      );
      writeFileSync(
        join(pluginDir, 'sidecars', 'viewer', 'sidecar.json'),
        JSON.stringify({ displayName: 'Viewer 1' }),
        'utf8'
      );
      writeFileSync(
        join(pluginDir, 'panes', 'viewer', 'sidecar.json'),
        JSON.stringify({ displayName: 'Viewer 2' }),
        'utf8'
      );
      symlinkSync(
        outsideDir,
        join(pluginDir, 'sidecars', 'escaped'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );

      const entries = discoverPluginSidecarEntries(pluginDir, 'my-plugin');
      const ids = entries.map((e) => e.id);
      assert.deepEqual(ids, ['my-plugin/leading-underscore', 'my-plugin/viewer', 'my-plugin/viewer-2']);
      for (const id of ids) {
        assert.doesNotThrow(() => assertValidSidecarId(id));
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
