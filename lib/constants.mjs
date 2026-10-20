/**
 * @fileoverview Shared constants, filesystem paths, and default Hangar configuration.
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = realpathSync(dirname(fileURLToPath(import.meta.url)));

export const SIDECAR_ID = 'hangar';
export const HANGAR_VERSION = '1.0.0';
export const LEGACY_SIDECAR_ID = 'sidecar-hub';
export const RESERVED_SIDECAR_IDS = new Set([SIDECAR_ID, LEGACY_SIDECAR_ID]);

export const REPO_ROOT = process.env.SIDECAR_REPO_ROOT
  ? resolve(process.env.SIDECAR_REPO_ROOT)
  : resolve(__dirname, '..');

export const GLOBAL_CONFIG_DIR = join(homedir(), '.gemini', 'config');
export const GLOBAL_SIDECARS_DIR = join(GLOBAL_CONFIG_DIR, 'sidecars');
export const CONFIG_JSON_PATH = join(GLOBAL_CONFIG_DIR, 'config.json');
export const APP_STORAGE_PATH =
  process.platform === 'win32'
    ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Antigravity', 'app_storage.json')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Antigravity', 'app_storage.json')
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Antigravity', 'app_storage.json');

export const LEGACY_HUB_CONFIG_PATH = join(GLOBAL_CONFIG_DIR, 'sidecar_hub.json');
export const HANGAR_CONFIG_PATH =
  process.env.HANGAR_CONFIG_PATH ||
  process.env.SIDECAR_HUB_CONFIG_PATH ||
  join(GLOBAL_CONFIG_DIR, 'hangar.json');

export const LEGACY_HUB_DATA_DIR = join(homedir(), '.gemini', 'sidecar-hub');
export const HANGAR_DATA_DIR =
  process.env.HANGAR_DATA_DIR ||
  process.env.SIDECAR_HUB_DATA_DIR ||
  join(homedir(), '.gemini', 'hangar');
export const HANGAR_PACKAGES_DIR = join(HANGAR_DATA_DIR, 'packages');

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
  sidecars: {
    'context-monitor': {
      scope: 'global',
      workspaces: ['*'],
      autoHibernate: false,
      order: 1,
      installedVersion: '1.0.0',
      source: 'registry',
    },
  },
};

export const SEED_REGISTRY = {
  generatedAt: '2026-10-20T00:00:00Z',
  featuredIds: ['context-monitor'],
  packages: [
    {
      id: 'context-monitor',
      name: 'Context & Quota Monitor',
      tagline:
        'Real-time Claude-style context window breakdown, prompt & thinking effort advisor, MCP server controller, and 5h/weekly quota tracker.',
      author: { name: 'Arthur Cavallari', github: 'arthurcavallari', verified: true },
      latestVersion: '1.0.0',
      pricing: 'free',
      categories: ['telemetry', 'productivity'],
      capabilityTier: 'TIER_1_TELEMETRY',
      securityScan: {
        passed: true,
        hasPostInstallScripts: false,
        externalDependencies: 0,
      },
      workspaceTriggers: { files: ['*'] },
      release: {
        gitRepo: 'https://github.com/arthurcavallari/antigravity-context-monitor',
      },
    },
  ],
};

export const BUILTIN_WORKSPACE_TRIGGERS = {
  'docker-ops': {
    name: 'Docker & Container Operations',
    files: ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'Dockerfile'],
  },
};
