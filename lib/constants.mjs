/**
 * @fileoverview Shared constants, filesystem paths, and default Hangar configuration.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_JSON_PATH,
  GLOBAL_CONFIG_DIR,
  GLOBAL_SIDECARS_DIR,
  HANGAR_DATA_DIR,
  HANGAR_PACKAGES_DIR,
} from 'antigravity-sidecar-kit/config';

const __dirname = realpathSync(dirname(fileURLToPath(import.meta.url)));

export {
  CONFIG_JSON_PATH,
  GLOBAL_CONFIG_DIR,
  GLOBAL_SIDECARS_DIR,
  HANGAR_DATA_DIR,
  HANGAR_PACKAGES_DIR,
};

// Where `agy plugin install` puts user plugins; a plugin's folder name is its plugin.json name
export const GLOBAL_PLUGINS_DIR = join(GLOBAL_CONFIG_DIR, 'plugins');
export const GLOBAL_BUILTIN_PLUGINS_DIR = join(homedir(), '.gemini', 'antigravity', 'builtin', 'plugins');

export const SIDECAR_ID = 'hangar';
export const LEGACY_SIDECAR_ID = 'sidecar-hub';
export const RESERVED_SIDECAR_IDS = new Set([SIDECAR_ID, LEGACY_SIDECAR_ID]);

export const REPO_ROOT = process.env.SIDECAR_REPO_ROOT
  ? resolve(process.env.SIDECAR_REPO_ROOT)
  : resolve(__dirname, '..');

const PKG_JSON = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
export const HANGAR_VERSION = String(PKG_JSON.version || '1.0.0');

export const LEGACY_HUB_CONFIG_PATH = join(GLOBAL_CONFIG_DIR, 'sidecar_hub.json');
export const HANGAR_CONFIG_PATH =
  process.env.HANGAR_CONFIG_PATH ||
  process.env.SIDECAR_HUB_CONFIG_PATH ||
  join(GLOBAL_CONFIG_DIR, 'hangar.json');

export const LEGACY_HUB_DATA_DIR = join(homedir(), '.gemini', 'sidecar-hub');

// The Worker serves registry.json and counts active installs; GitHub raw is the fallback when it's down.
// The GitHub URL was the default before the Worker existed, so configs that still hold it are migrated.
export const HANGAR_REGISTRY_URL = 'https://hangar.arthurcavallari.dev';
export const GITHUB_REGISTRY_URL = 'https://raw.githubusercontent.com/arthurcavallari/antigravity-hangar/main';
export const LEGACY_REGISTRY_URLS = ['https://registry.sidecarhub.dev/api/v1', GITHUB_REGISTRY_URL];

export const DEFAULT_HANGAR_CONFIG = {
  schemaVersion: 1,
  installId: '',
  telemetry: true,
  registryUrl: HANGAR_REGISTRY_URL,
  layout: {
    pinnedTopSidecarId: 'context-monitor',
    topSplitTabIds: ['context-monitor'],
    openTabIds: [],
    tabOrder: [],
    pinnedTopHeightPx: 185,
    splitViewEnabled: false,
    hibernateAfterIdleMinutes: 10,
    autoUpdate: false,
    extensionsDisplayMode: 'tab',
    terminalDisplayMode: 'tab',
    showExternalTerminals: true,
    hideHangarTerminals: true,
    showExternalSideQuestions: true,
    hideHangarSideQuestions: false,
    maxScrollbackBytes: 262144,
  },
  sidecars: {},
  // Plugins Hangar installed, by registry id: { dir, installedVersion, capabilityTier, portedFrom, ... }
  plugins: {},
  manuallyStopped: [],
};

export const SEED_REGISTRY = JSON.parse(
  readFileSync(join(REPO_ROOT, 'registry.json'), 'utf8')
);

export const BUILTIN_WORKSPACE_TRIGGERS = {
  'docker-ops': {
    name: 'Docker & Container Operations',
    files: ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'Dockerfile'],
  },
};

export const UI_SCRIPTS = Object.freeze([
  'core.js',
  'components/tab-bar.js',
  'components/marketplace-panes.js',
  'components/plugin-panes.js',
  'components/installed-pane.js',
  'components/extensions-tab.js',
  'components/iframe-deck.js',
  'components/terminal-emulator.js',
  'components/sidechat-store.js',
  'components/sidechat-strip.js',
  'components/sidechat-pane.js',
  'components/terminal-quote.js',
  'components/terminal-groups.js',
  'components/terminal-drag.js',
  'components/terminal-pane.js',
  'components/terminal-tab.js',
  'components/layout-controller.js',
  'app.js',
]);

export const HANGAR_REQUIRED_FILES = Object.freeze([
  'package.json',
  'sidecar.json',
  'registry.json',
  'launch.mjs',
  'server.mjs',
  'lib/constants.mjs',
  'lib/config-store.mjs',
  'lib/hibernation-manager.mjs',
  'lib/jetbox-audio.mjs',
  'lib/jetbox-proxy.mjs',
  'lib/jetbox-rpc-policy.mjs',
  'lib/jetbox-sidechat.mjs',
  'lib/jetbox-vcs.mjs',
  'lib/ls-rpc.mjs',
  'lib/package-installer.mjs',
  'lib/plugin-diagnostics.mjs',
  'lib/plugin-installer.mjs',
  'lib/registry-catalog.mjs',
  'lib/remote-source.mjs',
  'lib/sidecar-icons.mjs',
  'lib/state-orchestrator.mjs',
  'lib/terminal-manager.mjs',
  'lib/terminal-uris.mjs',
  'ui/index.html',
  'ui/styles.css',
  'ui/components.css',
  'ui/core.js',
  'ui/jetbox/jetbox-shared.css',
  'ui/jetbox/jetbox-chat.css',
  'ui/jetbox/jetbox-terminal.css',
  'ui/jetbox/jetbox-bootstrap.js',
  ...UI_SCRIPTS.filter((rel) => rel !== 'core.js').map((rel) => `ui/${rel}`),
]);

