/**
 * @fileoverview BOM-safe reader/writer for ~/.gemini/config/hangar.json,
 * child Gateway URL normalizer, and child sidecar.json workspace_uris synchronizer.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJsonSafe, writeJsonNoBom } from 'antigravity-sidecar-kit/config';
import { normalizeWorkspacePath } from 'antigravity-sidecar-kit/workspace';
import {
  DEFAULT_HANGAR_CONFIG,
  GLOBAL_SIDECARS_DIR,
  HANGAR_CONFIG_PATH,
  LEGACY_HUB_CONFIG_PATH,
  LEGACY_REGISTRY_URLS,
} from './constants.mjs';

// "https://host/path/registry.json/" and "https://host/path/" both mean base "https://host/path"
export function normalizeRegistryBaseUrl(url = '') {
  return String(url || '')
    .trim()
    .replace(/\/registry\.json\/?$/i, '')
    .replace(/\/+$/, '');
}

export { readJsonSafe, writeJsonNoBom };

// Ids become path segments under sidecars/; plugin sidecars use "plugin/name", so each "/"-separated
// segment must start with a letter or digit, which rules out "..", empty segments and backslashes.
const SIDECAR_ID_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;

export function assertValidSidecarId(sidecarId) {
  if (!sidecarId) throw new Error('sidecarId is required');
  if (!String(sidecarId).split('/').every((segment) => SIDECAR_ID_SEGMENT.test(segment))) {
    throw new Error(`Invalid sidecarId: "${sidecarId}"`);
  }
}

export function isTelemetryEnabled(config = {}, env = process.env) {
  if (config?.telemetry === false) return false;
  const dnt = String(env?.DO_NOT_TRACK || '').trim().toLowerCase();
  if (dnt === '1' || dnt === 'true') return false;
  const hangarTel = String(env?.HANGAR_TELEMETRY || '').trim().toLowerCase();
  if (hangarTel === '0' || hangarTel === 'false') return false;
  return true;
}

// Configs that fell back to defaults because hangar.json didn't parse; saving one would overwrite
// the user's file (sidecar rules, telemetry opt-out) with those defaults.
const unparseableConfigs = new WeakMap();

export function loadHangarConfig(configPath = HANGAR_CONFIG_PATH) {
  const effectivePath =
    configPath === HANGAR_CONFIG_PATH && !existsSync(HANGAR_CONFIG_PATH) && existsSync(LEGACY_HUB_CONFIG_PATH)
      ? LEGACY_HUB_CONFIG_PATH
      : configPath;
  const fileExists = existsSync(effectivePath);
  let raw = structuredClone(DEFAULT_HANGAR_CONFIG);
  let parsedCleanly = !fileExists;
  let parseError = '';
  if (fileExists) {
    try {
      raw = readJsonSafe(effectivePath, DEFAULT_HANGAR_CONFIG, { strict: true });
      parsedCleanly = true;
    } catch (err) {
      parsedCleanly = false;
      parseError = `${effectivePath} could not be parsed (${err?.message || 'invalid JSON'})`;
    }
  }

  const isLegacyRegistry =
    !raw.registryUrl || LEGACY_REGISTRY_URLS.includes(normalizeRegistryBaseUrl(raw.registryUrl));
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
    plugins: raw.plugins && typeof raw.plugins === 'object' && !Array.isArray(raw.plugins) ? { ...raw.plugins } : {},
    manuallyStopped: Array.isArray(raw.manuallyStopped)
      ? raw.manuallyStopped.filter((id) => typeof id === 'string' && id)
      : [],
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

  if (parseError) unparseableConfigs.set(config, parseError);
  return config;
}

export function assertHangarConfigSavable(config) {
  const parseError = unparseableConfigs.get(config);
  if (parseError) {
    throw new Error(
      `Refusing to save Hangar settings: ${parseError}. Saving now would replace it with defaults. ` +
        'Fix the JSON or remove the file, then retry.'
    );
  }
}

export function saveHangarConfig(config, configPath = HANGAR_CONFIG_PATH) {
  assertHangarConfigSavable(config);
  writeJsonNoBom(configPath, config);
  return config;
}

function slugifySidecarSegment(raw = '') {
  const slug = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  return slug || 'sidecar';
}

const normWinDrive = (p) => String(p || '').replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`);

export function discoverPluginSidecarEntries(pluginDir, pluginId = '') {
  if (!pluginDir || typeof pluginDir !== 'string' || !existsSync(pluginDir)) return [];
  const rootDir = normWinDrive(resolve(pluginDir));
  let realRootDir = rootDir;
  try {
    realRootDir = normWinDrive(realpathSync(rootDir));
  } catch {
    return [];
  }
  const rootPluginJson =
    readJsonSafe(join(rootDir, 'plugin.json'), null) ||
    readJsonSafe(join(rootDir, '.gemini-plugin', 'plugin.json'), null);
  const rawPluginId = String(pluginId || rootPluginJson?.name || basename(rootDir)).trim();
  if (!rawPluginId) return [];
  const effectivePluginId = SIDECAR_ID_SEGMENT.test(rawPluginId)
    ? rawPluginId
    : slugifySidecarSegment(rawPluginId);

  const seenDirs = new Set();
  const candidates = [];

  const addCandidate = (candidateDir, subSlug = '', isRoot = false) => {
    const absDir = normWinDrive(resolve(candidateDir));
    const relToRoot = relative(rootDir, absDir);
    if (relToRoot.startsWith('..') || isAbsolute(relToRoot)) return;
    let realCandidateDir = absDir;
    try {
      realCandidateDir = normWinDrive(realpathSync(absDir));
    } catch {
      return;
    }
    const realRel = relative(realRootDir, realCandidateDir);
    if (realRel.startsWith('..') || isAbsolute(realRel)) return;
    const seenAbsKey = process.platform === 'win32' ? absDir.toLowerCase() : absDir;
    const seenRealKey = process.platform === 'win32' ? realCandidateDir.toLowerCase() : realCandidateDir;
    if (seenDirs.has(seenAbsKey) || seenDirs.has(seenRealKey)) return;
    const manifestPath = join(absDir, 'sidecar.json');
    if (!existsSync(manifestPath)) return;
    try {
      const realManifest = normWinDrive(realpathSync(manifestPath));
      const relManifest = relative(realRootDir, realManifest);
      if (relManifest.startsWith('..') || isAbsolute(relManifest)) return;
    } catch {
      return;
    }
    const config = readJsonSafe(manifestPath, null);
    if (!config || typeof config !== 'object' || Array.isArray(config)) return;
    seenDirs.add(seenAbsKey);
    seenDirs.add(seenRealKey);
    candidates.push({ sidecarDir: absDir, subSlug, isRoot, config });
  };

  // 1. Scan <pluginDir>/sidecars/*/sidecar.json
  const sidecarsSubdir = join(rootDir, 'sidecars');
  if (existsSync(sidecarsSubdir)) {
    try {
      const entries = readdirSync(sidecarsSubdir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name)
      );
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        addCandidate(join(sidecarsSubdir, entry.name), entry.name, false);
      }
    } catch {
      // Ignore unreadable sidecars directory
    }
  }

  // 2. Scan relative paths in plugin.json#sidecars or .gemini-plugin/plugin.json#sidecars
  for (const manifestRel of ['plugin.json', join('.gemini-plugin', 'plugin.json')]) {
    const pJson = readJsonSafe(join(rootDir, manifestRel), null);
    if (!Array.isArray(pJson?.sidecars)) continue;
    for (const rawPath of pJson.sidecars) {
      if (typeof rawPath !== 'string' || !rawPath.trim()) continue;
      const cleaned = rawPath.trim().replace(/[/\\]sidecar\.json$/i, '');
      const candidateDir = normWinDrive(resolve(rootDir, cleaned || '.'));
      const isRoot = candidateDir === rootDir;
      let subSlug = '';
      if (!isRoot) {
        const base = basename(candidateDir);
        const parent = normWinDrive(dirname(candidateDir));
        subSlug =
          base.toLowerCase() === 'sidecar' && parent !== rootDir ? basename(parent) : base;
      }
      addCandidate(candidateDir, subSlug, isRoot);
    }
  }

  // 3. Check root <pluginDir>/sidecar.json (and legacy <pluginDir>/sidecar/sidecar.json)
  addCandidate(rootDir, '', true);
  if (candidates.length === 0 && existsSync(join(rootDir, 'sidecar', 'sidecar.json'))) {
    addCandidate(join(rootDir, 'sidecar'), '', true);
  }

  const isSingleRoot = candidates.length === 1 && candidates[0].isRoot;
  const usedIds = new Set();
  return candidates.map((c) => {
    const rawSubSlug =
      c.subSlug ||
      c.config?.id ||
      c.config?.name ||
      c.config?.title ||
      c.config?.display_name ||
      c.config?.displayName ||
      'main';
    const baseSubSlug = SIDECAR_ID_SEGMENT.test(String(rawSubSlug))
      ? String(rawSubSlug)
      : slugifySidecarSegment(rawSubSlug);
    let id = isSingleRoot ? effectivePluginId : `${effectivePluginId}/${baseSubSlug}`;
    if (usedIds.has(id)) {
      let suffix = 2;
      while (usedIds.has(`${id}-${suffix}`)) suffix += 1;
      id = `${id}-${suffix}`;
    }
    usedIds.add(id);
    return {
      id,
      parentPluginId: effectivePluginId,
      pluginName: String(rootPluginJson?.name || '').trim(),
      sidecarDir: c.sidecarDir,
      config: c.config,
    };
  });
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

// Grants the rule's concrete workspace paths in the child's sidecar.json. previouslyGranted lists the
// URIs Hangar added last time, so a workspace removed from the rule is revoked while URIs the author
// shipped stay put. Returns the URIs Hangar now grants, or null when there is no readable sidecar.json.
export function syncChildWorkspacePermissions(
  sidecarId,
  workspaces = [],
  sidecarsDir = GLOBAL_SIDECARS_DIR,
  previouslyGranted = []
) {
  if (!sidecarId || sidecarId.includes('/')) return null;
  const manifestPath = join(sidecarsDir, sidecarId, 'sidecar.json');
  if (!existsSync(manifestPath)) return null;

  const manifest = readJsonSafe(manifestPath, null);
  if (!manifest || typeof manifest !== 'object') return null;

  const existingUris = Array.isArray(manifest.agent_permissions?.workspace_uris)
    ? manifest.agent_permissions.workspace_uris
    : [];
  const hangarGranted = new Set(previouslyGranted);
  const authorUris = existingUris.filter((uri) => !hangarGranted.has(uri));

  const wantedUris = new Set();
  for (const ws of workspaces) {
    const clean = String(ws || '').trim();
    if (!clean || clean.includes('*')) continue;
    try {
      const norm = normalizeWorkspacePath(clean);
      if (norm) wantedUris.add(pathToFileURL(norm).href.replace(/\/$/, ''));
    } catch {
      // Ignore invalid filesystem paths
    }
  }
  const granted = [...wantedUris].filter((uri) => !authorUris.includes(uri));
  const nextUris = [...authorUris, ...granted];

  // Skip the write when nothing changed, so a linked dev checkout's sidecar.json isn't rewritten
  const existingSet = new Set(existingUris);
  const unchanged = nextUris.length === existingSet.size && nextUris.every((uri) => existingSet.has(uri));
  if (!unchanged) {
    manifest.agent_permissions = {
      ...(manifest.agent_permissions || {}),
      workspace_uris: nextUris,
    };
    writeJsonNoBom(manifestPath, manifest);
  }
  return granted;
}

export function updateSidecarRule(
  sidecarId,
  patch = {},
  { configPath = HANGAR_CONFIG_PATH, sidecarsDir = GLOBAL_SIDECARS_DIR } = {}
) {
  assertValidSidecarId(sidecarId);
  const config = loadHangarConfig(configPath);
  // Checked before syncing so a refused save can't leave the child's sidecar.json ahead of hangar.json
  assertHangarConfigSavable(config);
  const inferredPluginId = sidecarId.includes('/')
    ? sidecarId.split('/')[0]
    : config.plugins?.[sidecarId]
      ? sidecarId
      : '';
  const existing = config.sidecars[sidecarId] || {
    scope: 'project',
    workspaces: [],
    autoHibernate: !inferredPluginId,
    order: Object.keys(config.sidecars).length + 1,
    installedVersion: '1.0.0',
    source: inferredPluginId ? `plugin:${inferredPluginId}` : 'local',
  };

  const nextWorkspaces = Array.isArray(patch.workspaces)
    ? patch.workspaces.map((w) => String(w).trim()).filter(Boolean)
    : existing.workspaces;
  const nextScope =
    patch.scope || (nextWorkspaces.includes('*') ? 'global' : 'project');

  const rule = {
    ...existing,
    ...patch,
    scope: nextScope,
    workspaces: nextScope === 'global' ? ['*'] : nextWorkspaces,
    autoHibernate:
      patch.autoHibernate !== undefined ? Boolean(patch.autoHibernate) : existing.autoHibernate,
  };
  const granted = syncChildWorkspacePermissions(
    sidecarId,
    rule.workspaces,
    sidecarsDir,
    existing.grantedWorkspaceUris || []
  );
  if (granted) rule.grantedWorkspaceUris = granted;

  config.sidecars[sidecarId] = rule;
  saveHangarConfig(config, configPath);
  return rule;
}

// Persists a user's explicit stop so auto-wake leaves the sidecar off across Hangar restarts.
export function setManualStop(sidecarId, stopped, configPath = HANGAR_CONFIG_PATH) {
  assertValidSidecarId(sidecarId);
  const config = loadHangarConfig(configPath);
  const ids = new Set(config.manuallyStopped);
  if (ids.has(sidecarId) === Boolean(stopped)) return config.manuallyStopped;
  if (stopped) ids.add(sidecarId);
  else ids.delete(sidecarId);
  config.manuallyStopped = [...ids];
  saveHangarConfig(config, configPath);
  return config.manuallyStopped;
}

export function updateHangarLayout(patch = {}, configPath = HANGAR_CONFIG_PATH) {
  const config = loadHangarConfig(configPath);
  const prevWsLayouts =
    config.layout?.workspaceLayouts && typeof config.layout.workspaceLayouts === 'object'
      ? config.layout.workspaceLayouts
      : {};
  const prevScByWs =
    config.layout?.sideChatStateByWorkspace && typeof config.layout.sideChatStateByWorkspace === 'object'
      ? config.layout.sideChatStateByWorkspace
      : {};
  config.layout = {
    ...config.layout,
    ...patch,
  };
  if (patch.workspaceLayouts && typeof patch.workspaceLayouts === 'object') {
    config.layout.workspaceLayouts = { ...prevWsLayouts, ...patch.workspaceLayouts };
  }
  if (patch.sideChatStateByWorkspace && typeof patch.sideChatStateByWorkspace === 'object') {
    config.layout.sideChatStateByWorkspace = { ...prevScByWs, ...patch.sideChatStateByWorkspace };
  }
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
  if (patch.extensionsDisplayMode !== undefined) {
    config.layout.extensionsDisplayMode =
      patch.extensionsDisplayMode === 'button' ? 'button' : 'tab';
  }
  if (patch.terminalDisplayMode !== undefined) {
    config.layout.terminalDisplayMode =
      patch.terminalDisplayMode === 'button' ? 'button' : 'tab';
  }
  if (patch.autoUpdate !== undefined) {
    config.layout.autoUpdate = Boolean(patch.autoUpdate);
  }
  if (patch.showExternalTerminals !== undefined) {
    config.layout.showExternalTerminals = Boolean(patch.showExternalTerminals);
  }
  if (patch.maxScrollbackBytes !== undefined) {
    config.layout.maxScrollbackBytes = Math.max(
      4096,
      Math.min(16 * 1024 * 1024, Math.round(Number(patch.maxScrollbackBytes) || 262144))
    );
  }
  saveHangarConfig(config, configPath);
  return config.layout;
}
