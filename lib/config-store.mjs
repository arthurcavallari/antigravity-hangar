/**
 * @fileoverview BOM-safe reader/writer for ~/.gemini/config/hangar.json,
 * child Gateway URL normalizer, and child sidecar.json workspace_uris synchronizer.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_HANGAR_CONFIG,
  GLOBAL_SIDECARS_DIR,
  HANGAR_CONFIG_PATH,
  LEGACY_HUB_CONFIG_PATH,
} from './constants.mjs';
import { normalizeWorkspacePath } from './workspace-resolver.mjs';

export function readJsonSafe(filePath, fallback = {}) {
  if (!existsSync(filePath)) return structuredClone(fallback);
  try {
    const raw = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim();
    return raw ? JSON.parse(raw) : structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
}

export function writeJsonNoBom(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function isTelemetryEnabled(config = {}, env = process.env) {
  if (config?.telemetry === false) return false;
  const dnt = String(env?.DO_NOT_TRACK || '').trim().toLowerCase();
  if (dnt === '1' || dnt === 'true') return false;
  const hangarTel = String(env?.HANGAR_TELEMETRY || '').trim().toLowerCase();
  if (hangarTel === '0' || hangarTel === 'false') return false;
  return true;
}

export function loadHangarConfig(configPath = HANGAR_CONFIG_PATH) {
  const effectivePath =
    configPath === HANGAR_CONFIG_PATH && !existsSync(HANGAR_CONFIG_PATH) && existsSync(LEGACY_HUB_CONFIG_PATH)
      ? LEGACY_HUB_CONFIG_PATH
      : configPath;
  const fileExists = existsSync(effectivePath);
  let raw = structuredClone(DEFAULT_HANGAR_CONFIG);
  let parsedCleanly = !fileExists;
  if (fileExists) {
    try {
      const text = readFileSync(effectivePath, 'utf8').replace(/^\uFEFF/, '').trim();
      if (text) {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          raw = parsed;
          parsedCleanly = true;
        } else {
          parsedCleanly = false;
        }
      } else {
        parsedCleanly = true;
      }
    } catch {
      parsedCleanly = false;
    }
  }

  const isLegacyRegistry =
    !raw.registryUrl || raw.registryUrl === 'https://registry.sidecarhub.dev/api/v1';
  const mergedLayout = {
    ...DEFAULT_HANGAR_CONFIG.layout,
    ...(raw.layout || {}),
  };
  delete mergedLayout.hideManagedFromNativeAuxDropdown;

  const existingInstallId = typeof raw.installId === 'string' ? raw.installId.trim() : '';
  const installId = existingInstallId || randomUUID();
  const telemetry = raw.telemetry !== false;

  const config = {
    schemaVersion: raw.schemaVersion || 1,
    installId,
    telemetry,
    registryUrl: isLegacyRegistry ? DEFAULT_HANGAR_CONFIG.registryUrl : raw.registryUrl,
    layout: mergedLayout,
    sidecars: {
      ...DEFAULT_HANGAR_CONFIG.sidecars,
      ...(raw.sidecars || {}),
    },
  };

  const shouldPersistInstallId =
    !existingInstallId &&
    parsedCleanly &&
    (fileExists || configPath === HANGAR_CONFIG_PATH);

  if (shouldPersistInstallId) {
    try {
      writeJsonNoBom(configPath, config);
    } catch {
      // Non-fatal if read-only filesystem
    }
  }

  return config;
}

export function saveHangarConfig(config, configPath = HANGAR_CONFIG_PATH) {
  writeJsonNoBom(configPath, config);
  return config;
}

export function buildChildIframeUrl(
  baseUrl = '',
  viewPath = '/',
  conversationId = '',
  webPort = 0
) {
  if (!baseUrl && !webPort) return '';
  try {
    const parsed = baseUrl
      ? new URL(baseUrl)
      : new URL(`http://127.0.0.1:${webPort}`);
    // Target raw SidecarApp webPort when available so nested child iframes never suffer
    // Gateway SameSite=Lax 401 drops on GET /preload.js or /styles.css subresources
    if (webPort && Number(webPort) > 0) {
      parsed.hostname = '127.0.0.1';
      parsed.port = String(webPort);
    } else {
      parsed.hostname = 'localhost';
    }
    const cleanViewPath = viewPath && viewPath.startsWith('/') ? viewPath : `/${viewPath || ''}`;
    parsed.pathname = cleanViewPath;
    if (conversationId) {
      parsed.searchParams.set('conversationId', conversationId);
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

export function syncChildWorkspacePermissions(
  sidecarId,
  workspaces = [],
  sidecarsDir = GLOBAL_SIDECARS_DIR
) {
  if (!sidecarId || sidecarId.includes('/')) return false;
  const manifestPath = join(sidecarsDir, sidecarId, 'sidecar.json');
  if (!existsSync(manifestPath)) return false;

  const manifest = readJsonSafe(manifestPath, null);
  if (!manifest || typeof manifest !== 'object') return false;

  const existingUris = Array.isArray(manifest.agent_permissions?.workspace_uris)
    ? manifest.agent_permissions.workspace_uris
    : [];
  const uriSet = new Set(existingUris);

  for (const ws of workspaces) {
    const clean = String(ws || '').trim();
    if (!clean || clean.includes('*')) continue;
    try {
      const norm = normalizeWorkspacePath(clean);
      if (norm) {
        const fileUri = pathToFileURL(norm).href.replace(/\/$/, '');
        uriSet.add(fileUri);
      }
    } catch {
      // Ignore invalid filesystem paths
    }
  }

  manifest.agent_permissions = {
    ...(manifest.agent_permissions || {}),
    workspace_uris: [...uriSet],
    allows_user_interactions: true,
  };
  writeJsonNoBom(manifestPath, manifest);
  return true;
}

export function updateSidecarRule(
  sidecarId,
  patch = {},
  { configPath = HANGAR_CONFIG_PATH, sidecarsDir = GLOBAL_SIDECARS_DIR } = {}
) {
  if (!sidecarId) throw new Error('sidecarId is required');
  const config = loadHangarConfig(configPath);
  const existing = config.sidecars[sidecarId] || {
    scope: 'project',
    workspaces: [],
    autoHibernate: true,
    order: Object.keys(config.sidecars).length + 1,
    installedVersion: '1.0.0',
    source: 'local',
  };

  const nextWorkspaces = Array.isArray(patch.workspaces)
    ? patch.workspaces.map((w) => String(w).trim()).filter(Boolean)
    : existing.workspaces;
  const nextScope =
    patch.scope || (nextWorkspaces.includes('*') ? 'global' : 'project');

  config.sidecars[sidecarId] = {
    ...existing,
    ...patch,
    scope: nextScope,
    workspaces: nextScope === 'global' ? ['*'] : nextWorkspaces,
    autoHibernate:
      patch.autoHibernate !== undefined ? Boolean(patch.autoHibernate) : existing.autoHibernate,
  };

  saveHangarConfig(config, configPath);
  syncChildWorkspacePermissions(sidecarId, config.sidecars[sidecarId].workspaces, sidecarsDir);
  return config.sidecars[sidecarId];
}

export function updateHangarLayout(patch = {}, configPath = HANGAR_CONFIG_PATH) {
  const config = loadHangarConfig(configPath);
  config.layout = {
    ...config.layout,
    ...patch,
  };
  if (patch.pinnedTopHeightPx !== undefined) {
    config.layout.pinnedTopHeightPx = Math.max(
      80,
      Math.min(900, Number(patch.pinnedTopHeightPx) || 185)
    );
  }
  if (patch.hibernateAfterIdleMinutes !== undefined) {
    config.layout.hibernateAfterIdleMinutes = Math.max(
      1,
      Math.min(240, Number(patch.hibernateAfterIdleMinutes) || 10)
    );
  }
  saveHangarConfig(config, configPath);
  return config.layout;
}
