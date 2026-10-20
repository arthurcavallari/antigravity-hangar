#!/usr/bin/env node
/**
 * @fileoverview Cross-machine setup, legacy sidecar-hub migration, and Language Server
 * registration script for Antigravity Hangar.
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  CONFIG_JSON_PATH,
  DEFAULT_HANGAR_CONFIG,
  GLOBAL_SIDECARS_DIR,
  HANGAR_CONFIG_PATH,
  HANGAR_DATA_DIR,
  HANGAR_PACKAGES_DIR,
  HANGAR_VERSION,
  LEGACY_HUB_CONFIG_PATH,
  LEGACY_HUB_DATA_DIR,
  LEGACY_SIDECAR_ID,
  REPO_ROOT,
  SIDECAR_ID,
} from './lib/constants.mjs';
import { loadHangarConfig, readJsonSafe, writeJsonNoBom } from './lib/config-store.mjs';

const JUNCTION_PATH = join(GLOBAL_SIDECARS_DIR, SIDECAR_ID);
const LEGACY_JUNCTION_PATH = join(GLOBAL_SIDECARS_DIR, LEGACY_SIDECAR_ID);
const args = new Set(process.argv.slice(2));
const isUninstall = args.has('--uninstall');
const skipTests = args.has('--skip-tests');

function resolvePermanentLinkSource(repoRoot) {
  if (!/[\\/]_npx[\\/]|[\\/]node_modules[\\/]/i.test(repoRoot)) {
    return repoRoot;
  }
  const destDir = join(HANGAR_PACKAGES_DIR, `${SIDECAR_ID}@${HANGAR_VERSION}`);
  mkdirSync(HANGAR_PACKAGES_DIR, { recursive: true });
  rmSync(destDir, { recursive: true, force: true });
  cpSync(repoRoot, destDir, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(repoRoot.length);
      return !/[\\/]\.git([\\/]|$)|[\\/]node_modules([\\/]|$)/.test(rel);
    },
  });
  return realpathSync(destDir);
}

function removeLinkOrDir(targetPath) {
  let stat;
  try {
    stat = lstatSync(targetPath);
  } catch {
    return false;
  }
  try {
    if (stat.isSymbolicLink()) {
      unlinkSync(targetPath);
    } else {
      rmSync(targetPath, { recursive: true, force: true });
    }
  } catch {
    rmSync(targetPath, { recursive: true, force: true });
  }
  return true;
}

async function callManageSidecar(action, sidecarId = SIDECAR_ID) {
  const lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddress || !csrfToken) {
    return {
      notified: false,
      reason: 'linked & enabled in config.json — select Hangar in the Antigravity Auxiliary Pane',
    };
  }

  const url = `http://${lsAddress}/exa.language_server_pb.LanguageServerService/ManageSidecar`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-codeium-csrf-token': csrfToken,
    },
    body: JSON.stringify({ action, sidecarId }),
  });
  const body = await res.json().catch(() => ({}));
  return { notified: res.ok, status: res.status, body };
}

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
    await callManageSidecar('SIDECAR_ACTION_DISABLE', LEGACY_SIDECAR_ID).catch(() => {});
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
        console.log(`[${SIDECAR_ID}] Migrated config.json sidecars.${LEGACY_SIDECAR_ID} -> sidecars.${SIDECAR_ID}`);
      }
    }
  }
}

async function main() {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 20) {
    throw new Error(
      `Node.js >= 20.0.0 is required (current: ${process.version}). Switch Node versions (e.g. "nvm use 22") and try again.`
    );
  }
  console.log(`[${SIDECAR_ID}] Repository root: ${REPO_ROOT}`);

  if (isUninstall) {
    removeLinkOrDir(JUNCTION_PATH);
    removeLinkOrDir(LEGACY_JUNCTION_PATH);
    if (existsSync(CONFIG_JSON_PATH)) {
      const cfg = readJsonSafe(CONFIG_JSON_PATH, {});
      if (cfg.sidecars && typeof cfg.sidecars === 'object') {
        if (cfg.sidecars[SIDECAR_ID]) cfg.sidecars[SIDECAR_ID].enabled = false;
        delete cfg.sidecars[LEGACY_SIDECAR_ID];
      }
      writeJsonNoBom(CONFIG_JSON_PATH, cfg);
    }
    await callManageSidecar('SIDECAR_ACTION_DISABLE', SIDECAR_ID).catch(() => {});
    console.log(`[${SIDECAR_ID}] Uninstalled cleanly.`);
    return;
  }

  const requiredFiles = [
    'package.json',
    'sidecar.json',
    'registry.json',
    'server.mjs',
    'lib/constants.mjs',
    'lib/rpc-client.mjs',
    'lib/theme.mjs',
    'lib/config-store.mjs',
    'lib/workspace-resolver.mjs',
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
  ];

  for (const rel of requiredFiles) {
    const full = join(REPO_ROOT, rel);
    if (!existsSync(full)) {
      throw new Error(`Missing required file: ${full}`);
    }
  }

  await migrateLegacySidecarHub();

  if (!existsSync(HANGAR_CONFIG_PATH)) {
    writeJsonNoBom(HANGAR_CONFIG_PATH, DEFAULT_HANGAR_CONFIG);
    loadHangarConfig(HANGAR_CONFIG_PATH);
    console.log(`[${SIDECAR_ID}] Initialized default ${HANGAR_CONFIG_PATH}`);
  }

  if (!skipTests) {
    console.log(`[${SIDECAR_ID}] Running unit tests...`);
    execFileSync(
      process.execPath,
      [
        '--test',
        join(REPO_ROOT, 'test', 'config-store.test.mjs'),
        join(REPO_ROOT, 'test', 'theme.test.mjs'),
        join(REPO_ROOT, 'test', 'workspace-resolver.test.mjs'),
        join(REPO_ROOT, 'test', 'hibernation-manager.test.mjs'),
        join(REPO_ROOT, 'test', 'package-installer.test.mjs'),
        join(REPO_ROOT, 'test', 'registry-catalog.test.mjs'),
      ],
      { cwd: REPO_ROOT, stdio: 'inherit' }
    );
  }

  const targetSourceDir = resolvePermanentLinkSource(REPO_ROOT);
  mkdirSync(GLOBAL_SIDECARS_DIR, { recursive: true });
  const alreadyLinked =
    existsSync(JUNCTION_PATH) && realpathSync(JUNCTION_PATH) === targetSourceDir;
  if (!alreadyLinked) {
    removeLinkOrDir(JUNCTION_PATH);
    symlinkSync(
      targetSourceDir,
      JUNCTION_PATH,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
  }
  console.log(`[${SIDECAR_ID}] Linked ${JUNCTION_PATH} -> ${realpathSync(JUNCTION_PATH)}`);

  if (existsSync(CONFIG_JSON_PATH)) {
    const cfg = readJsonSafe(CONFIG_JSON_PATH, {});
    cfg.sidecars = cfg.sidecars && typeof cfg.sidecars === 'object' ? cfg.sidecars : {};
    if (cfg.sidecars[SIDECAR_ID]?.enabled !== true) {
      cfg.sidecars[SIDECAR_ID] = { ...(cfg.sidecars[SIDECAR_ID] || {}), enabled: true };
      writeJsonNoBom(CONFIG_JSON_PATH, cfg);
    }
  }

  let rpcRes = await callManageSidecar('SIDECAR_ACTION_RESTART').catch((err) => ({
    notified: false,
    reason: err.message,
  }));
  if (!rpcRes.notified) {
    await new Promise((r) => setTimeout(r, 350));
    rpcRes = await callManageSidecar('SIDECAR_ACTION_ENABLE').catch((err) => ({
      notified: false,
      reason: err.message,
    }));
  }
  console.log(
    rpcRes.notified
      ? `[${SIDECAR_ID}] Enabled and started via Language Server RPC.`
      : `[${SIDECAR_ID}] Setup complete (${rpcRes.reason || 'ready'}).`
  );
}

main().catch((err) => {
  console.error(`[${SIDECAR_ID}] Setup failed: ${err.message}`);
  process.exit(1);
});
