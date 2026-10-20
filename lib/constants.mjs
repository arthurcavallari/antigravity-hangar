/**
 * @fileoverview Shared constants, filesystem paths, and default Hangar configuration.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_STORAGE_PATH,
  CONFIG_JSON_PATH,
  GLOBAL_CONFIG_DIR,
  GLOBAL_SIDECARS_DIR,
  HANGAR_DATA_DIR,
  HANGAR_PACKAGES_DIR,
} from 'antigravity-sidecar-kit/config';

const __dirname = realpathSync(dirname(fileURLToPath(import.meta.url)));

export {
  APP_STORAGE_PATH,
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

export const DEFAULT_HANGAR_CONFIG = {
  schemaVersion: 1,
  installId: '',
  telemetry: true,
  registryUrl: 'https://raw.githubusercontent.com/arthurcavallari/antigravity-hangar/main',
  layout: {
    pinnedTopSidecarId: 'context-monitor',
    topSplitTabIds: ['context-monitor'],
    tabOrder: [],
    pinnedTopHeightPx: 185,
    splitViewEnabled: false,
    hibernateAfterIdleMinutes: 10,
  },
  sidecars: {},
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
