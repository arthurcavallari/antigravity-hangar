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
    tabOrder: [],
    pinnedTopHeightPx: 185,
    splitViewEnabled: false,
    hibernateAfterIdleMinutes: 10,
  },
  sidecars: {},
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
