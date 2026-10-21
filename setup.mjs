#!/usr/bin/env node
/**
 * @fileoverview Cross-machine setup, legacy sidecar-hub migration, and Language Server
 * registration script for Antigravity Hangar, backed by antigravity-sidecar-kit/setup.
 */

import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonSafe, writeJsonNoBom } from 'antigravity-sidecar-kit/config';
import { manageSidecar } from 'antigravity-sidecar-kit/rpc';
import { removeLinkOrDir, runSidecarSetup } from 'antigravity-sidecar-kit/setup';
import {
  CONFIG_JSON_PATH,
  DEFAULT_HANGAR_CONFIG,
  GLOBAL_SIDECARS_DIR,
  HANGAR_CONFIG_PATH,
  HANGAR_DATA_DIR,
  HANGAR_VERSION,
  LEGACY_HUB_CONFIG_PATH,
  LEGACY_HUB_DATA_DIR,
  LEGACY_SIDECAR_ID,
  REPO_ROOT,
  SIDECAR_ID,
} from './lib/constants.mjs';
import { loadHangarConfig } from './lib/config-store.mjs';

const LEGACY_JUNCTION_PATH = join(GLOBAL_SIDECARS_DIR, LEGACY_SIDECAR_ID);

async function migrateLegacySidecarHub() {
  if (!existsSync(HANGAR_CONFIG_PATH) && existsSync(LEGACY_HUB_CONFIG_PATH)) {
    const migrated = loadHangarConfig(LEGACY_HUB_CONFIG_PATH);
    writeJsonNoBom(HANGAR_CONFIG_PATH, migrated);
    removeLinkOrDir(LEGACY_HUB_CONFIG_PATH);
    console.log(`[${SIDECAR_ID}] Migrated ${LEGACY_HUB_CONFIG_PATH} -> ${HANGAR_CONFIG_PATH}`);
  } else if (existsSync(HANGAR_CONFIG_PATH) && existsSync(LEGACY_HUB_CONFIG_PATH)) {
    removeLinkOrDir(LEGACY_HUB_CONFIG_PATH);
  }

  if (!existsSync(HANGAR_DATA_DIR) && existsSync(LEGACY_HUB_DATA_DIR)) {
    cpSync(LEGACY_HUB_DATA_DIR, HANGAR_DATA_DIR, { recursive: true });
    removeLinkOrDir(LEGACY_HUB_DATA_DIR);
    console.log(`[${SIDECAR_ID}] Migrated ${LEGACY_HUB_DATA_DIR} -> ${HANGAR_DATA_DIR}`);
  }

  if (existsSync(LEGACY_JUNCTION_PATH)) {
    await manageSidecar(LEGACY_SIDECAR_ID, 'SIDECAR_ACTION_DISABLE').catch(() => {});
    removeLinkOrDir(LEGACY_JUNCTION_PATH);
    console.log(`[${SIDECAR_ID}] Removed legacy junction ${LEGACY_JUNCTION_PATH}`);
  }

  if (existsSync(CONFIG_JSON_PATH)) {
    const cfg = readJsonSafe(CONFIG_JSON_PATH, {});
    if (cfg.sidecars && typeof cfg.sidecars === 'object') {
      const legacyEntry = cfg.sidecars[LEGACY_SIDECAR_ID];
      if (legacyEntry) {
        cfg.sidecars[SIDECAR_ID] = {
          ...legacyEntry,
          ...(cfg.sidecars[SIDECAR_ID] || {}),
          enabled: true,
        };
        delete cfg.sidecars[LEGACY_SIDECAR_ID];
        writeJsonNoBom(CONFIG_JSON_PATH, cfg);
        console.log(
          `[${SIDECAR_ID}] Migrated config.json sidecars.${LEGACY_SIDECAR_ID} -> sidecars.${SIDECAR_ID}`
        );
      }
    }
  }
}

runSidecarSetup({
  sidecarId: SIDECAR_ID,
  repoRoot: REPO_ROOT,
  version: HANGAR_VERSION,
  requiredFiles: [
    'package.json',
    'sidecar.json',
    'registry.json',
    'server.mjs',
    'lib/constants.mjs',
    'lib/config-store.mjs',
    'lib/hibernation-manager.mjs',
    'lib/package-installer.mjs',
    'lib/registry-catalog.mjs',
    'lib/state-orchestrator.mjs',
    'ui/index.html',
    'ui/styles.css',
    'ui/components.css',
    'ui/core.js',
    'ui/app.js',
    'ui/components/tab-bar.js',
    'ui/components/project-popover.js',
    'ui/components/marketplace-panes.js',
    'ui/components/extensions-tab.js',
    'ui/components/iframe-deck.js',
  ],
  onBeforeSetup: async () => {
    await migrateLegacySidecarHub();
    if (!existsSync(HANGAR_CONFIG_PATH)) {
      writeJsonNoBom(HANGAR_CONFIG_PATH, DEFAULT_HANGAR_CONFIG);
      loadHangarConfig(HANGAR_CONFIG_PATH);
      console.log(`[${SIDECAR_ID}] Initialized default ${HANGAR_CONFIG_PATH}`);
    }
  },
  onUninstall: async ({ configJsonPath, removeLinkOrDir: rm }) => {
    rm(LEGACY_JUNCTION_PATH);
    if (existsSync(configJsonPath)) {
      const cfg = readJsonSafe(configJsonPath, {});
      if (cfg.sidecars && typeof cfg.sidecars === 'object' && cfg.sidecars[LEGACY_SIDECAR_ID]) {
        delete cfg.sidecars[LEGACY_SIDECAR_ID];
        writeJsonNoBom(configJsonPath, cfg);
      }
    }
  },
}).catch((err) => {
  console.error(`[${SIDECAR_ID}] Setup failed: ${err.message}`);
  process.exit(1);
});
