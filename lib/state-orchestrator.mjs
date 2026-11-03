/**
 * @fileoverview Orchestrates Language Server GetSidecars + GetAllCascadeTrajectories + GetAllPlugins,
 * workspace rule evaluation, child iframe URL normalization, and process management.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveHostTheme } from 'antigravity-sidecar-kit/theme';
import {
  matchesWorkspaceRule,
  normalizeWorkspacePath,
  resolveActiveWorkspace,
} from 'antigravity-sidecar-kit/workspace';
import {
  GLOBAL_PLUGINS_DIR, GLOBAL_SIDECARS_DIR, HANGAR_CONFIG_PATH, HANGAR_PACKAGES_DIR, RESERVED_SIDECAR_IDS,
} from './constants.mjs';
import {
  assertValidSidecarId,
  buildChildIframeUrl,
  discoverPluginSidecarEntries,
  loadHangarConfig,
  setManualStop,
} from './config-store.mjs';
import { defaultHibernator } from './hibernation-manager.mjs';
import { hangarRpc, invalidateStateReads } from './ls-rpc.mjs';
import { inspectInstalledPluginHealth } from './plugin-diagnostics.mjs';
import { listInstalledPlugins } from './plugin-installer.mjs';
import {
  detectWorkspaceSuggestions,
  getCachedHangarUpdate,
  getCachedSidecarUpdate,
  readInstalledSidecarMetadata,
} from './registry-catalog.mjs';
import { listWorkspaceTerminals } from './terminal-manager.mjs';

function discoverInstalledPluginSidecars({ pluginsDir = '', pluginsRes = null, hangarConfig = {} } = {}) {
  const pluginRoots = new Map();
  const registerRoot = (dir, pluginId = '', disabled = false) => {
    if (!dir || !existsSync(dir)) return;
    const abs = resolve(dir).replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`);
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    if (!pluginRoots.has(key)) {
      pluginRoots.set(key, { rootDir: abs, pluginId, disabled: Boolean(disabled) });
    } else if (pluginId && !pluginRoots.get(key).pluginId) {
      pluginRoots.get(key).pluginId = pluginId;
    }
  };

  if (Array.isArray(pluginsRes?.plugins)) {
    for (const p of pluginsRes.plugins) {
      const rawPath = String(p?.path || '').trim();
      const dirName = rawPath.split(/[\\/]/).filter(Boolean).pop() || String(p?.name || '').trim();
      const pluginId = String(p?.name || dirName).trim();
      let fsPath = '';
      if (rawPath) {
        try {
          fsPath = normalizeWorkspacePath(rawPath) || rawPath;
        } catch {
          fsPath = rawPath;
        }
      }
      if (fsPath && existsSync(fsPath)) {
        registerRoot(fsPath, pluginId, p?.disabled);
      } else if (pluginsDir && dirName && existsSync(join(pluginsDir, dirName))) {
        registerRoot(join(pluginsDir, dirName), pluginId, p?.disabled);
      }
    }
  }

  if (pluginsDir && hangarConfig?.plugins && typeof hangarConfig.plugins === 'object') {
    for (const [pluginId, record] of Object.entries(hangarConfig.plugins)) {
      const dirName = record?.dir || pluginId;
      if (dirName) registerRoot(join(pluginsDir, dirName), pluginId, false);
    }
  }

  if (pluginsDir && existsSync(pluginsDir)) {
    try {
      for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          registerRoot(join(pluginsDir, entry.name), '', false);
        }
      }
    } catch {
      // Ignore unreadable plugins directory
    }
  }

  const discovered = [];
  for (const { rootDir, ...meta } of pluginRoots.values()) {
    const entries = discoverPluginSidecarEntries(rootDir, meta.pluginId);
    for (const entry of entries) {
      discovered.push({
        ...entry,
        sidecarId: entry.id,
        pluginPath: rootDir,
        disabled: meta.disabled,
      });
    }
  }
  return discovered;
}

export function enrichSidecarList(
  rawSidecars = [],
  hangarConfig = {},
  {
    activeWorkspacePath = '',
    conversationId = '',
    hibernator = defaultHibernator,
    sidecarsDir = GLOBAL_SIDECARS_DIR,
    packagesDir = HANGAR_PACKAGES_DIR,
    pluginsDir = '',
    pluginsRes = null,
    nowMs = Date.now(),
  } = {}
) {
  const rulesMap = hangarConfig.sidecars || {};
  const wsKey = String(activeWorkspacePath || '').trim().replace(/\\/g, '/').toLowerCase();
  const wsLayout = wsKey ? hangarConfig.layout?.workspaceLayouts?.[wsKey] : null;
  const pinnedTopId = (wsLayout?.pinnedTopSidecarId ?? hangarConfig.layout?.pinnedTopSidecarId) || '';
  const splitEnabled = Boolean(wsLayout?.splitViewEnabled ?? hangarConfig.layout?.splitViewEnabled);

  const mergedRaw = rawSidecars.map((s) => ({
    ...s,
    sidecarId: s.sidecarId || s.id,
  }));
  const discoveredPluginSidecars = discoverInstalledPluginSidecars({
    pluginsDir,
    pluginsRes,
    hangarConfig,
  });
  for (const entry of discoveredPluginSidecars) {
    const existing = mergedRaw.find((s) => s.sidecarId === entry.id);
    if (existing) {
      existing.parentPluginId ||= entry.parentPluginId;
      existing.sidecarDir ||= entry.sidecarDir;
      existing.pluginPath ||= entry.pluginPath;
      existing.config ||= entry.config;
    } else {
      mergedRaw.push({
        sidecarId: entry.id,
        id: entry.id,
        parentPluginId: entry.parentPluginId,
        sidecarDir: entry.sidecarDir,
        pluginPath: entry.pluginPath,
        status: 'SIDECAR_STATUS_STOPPED',
        userConfig: { enabled: !entry.disabled },
        config: entry.config,
      });
    }
  }

  const filtered = mergedRaw.filter(
    (s) =>
      s.sidecarId &&
      !RESERVED_SIDECAR_IDS.has(s.sidecarId) &&
      s.config?.hasWebUi !== false &&
      s.config?.has_web_ui !== false
  );

  const enriched = filtered.map((s, idx) => {
    const id = s.sidecarId;
    const isDefaultGlobal = id === 'context-monitor';
    const inferredParentPluginId =
      s.parentPluginId || (id.includes('/') ? id.split('/')[0] : '');
    const rule = rulesMap[id] || {
      scope: isDefaultGlobal ? 'global' : 'project',
      workspaces: isDefaultGlobal ? ['*'] : [],
      autoHibernate: false,
      order: isDefaultGlobal ? 1 : 100 + idx,
      installedVersion: '1.0.0',
      source: inferredParentPluginId ? `plugin:${inferredParentPluginId}` : 'local',
    };
    const parentPluginId =
      inferredParentPluginId ||
      (typeof rule.source === 'string' && rule.source.startsWith('plugin:')
        ? rule.source.slice('plugin:'.length)
        : '');
    // A plugin's sidecar starts and stops with its plugin, so hibernating it would switch off the whole
    // plugin, its skills, hooks and MCP servers included. Only standalone sidecars hibernate.
    const isPluginSidecar = Boolean(parentPluginId) || id.includes('/');
    const autoHibernate = Boolean(rule.autoHibernate) && !isPluginSidecar;

    const uiConfig = s.config?.uiConfig || s.config?.ui_config;
    const viewPath = uiConfig?.views?.[0]?.path || '/';
    const status = s.status || 'SIDECAR_STATUS_UNKNOWN';
    const isRunning = status === 'SIDECAR_STATUS_RUNNING';
    const isErrored = status === 'SIDECAR_STATUS_ERRORED';
    const isStopped = status === 'SIDECAR_STATUS_STOPPED';

    const matchesWorkspace =
      rule.scope === 'global' ||
      matchesWorkspaceRule(activeWorkspacePath, rule.workspaces);

    const isPinnedTop = splitEnabled && pinnedTopId === id;
    const iframeUrl = isRunning
      ? buildChildIframeUrl(s.baseUrl, viewPath, conversationId, s.webPort)
      : '';

    const diskMeta = readInstalledSidecarMetadata(id, sidecarsDir, rule, packagesDir);
    const installedVersion = diskMeta.version || rule.installedVersion || '1.0.0';
    const cachedUpd = getCachedSidecarUpdate(id, installedVersion);

    return {
      sidecarId: id,
      parentPluginId,
      displayName:
        uiConfig?.displayName ||
        uiConfig?.display_name ||
        s.config?.displayName ||
        s.config?.display_name ||
        id,
      description: s.config?.description || '',
      status,
      statusBadge: isRunning
        ? 'RUNNING'
        : isErrored
          ? 'ERRORED'
          : isStopped && autoHibernate && !matchesWorkspace
            ? 'HIBERNATED'
            : isStopped
              ? 'STOPPED'
              : status.replace('SIDECAR_STATUS_', ''),
      isRunning,
      isErrored,
      isStopped,
      webPort: s.webPort || 0,
      viewPath,
      iframeUrl,
      scope: rule.scope || 'project',
      workspaces: Array.isArray(rule.workspaces) ? rule.workspaces : [],
      autoHibernate,
      autoHibernateLocked: isPluginSidecar,
      order: Number(rule.order ?? 100 + idx),
      source: rule.source || 'local',
      capabilityTier: rule.capabilityTier || '',
      installedVersion,
      latestVersion: cachedUpd?.latestVersion || installedVersion,
      // Only copies Hangar manages under packagesDir may be replaced; never a user's own folder
      updateAvailable: Boolean(diskMeta.managed && cachedUpd?.updateAvailable),
      gitRepo: cachedUpd?.gitRepo || diskMeta.gitRepo || rule.gitRepo || '',
      // The installed copy's tarball would reinstall the old version, so updates only use the probed one
      tarballUrl: cachedUpd?.updateAvailable
        ? cachedUpd.tarballUrl || ''
        : cachedUpd?.tarballUrl || diskMeta.tarballUrl || rule.tarballUrl || '',
      sha256: cachedUpd?.sha256 || '',
      matchesWorkspace,
      isPinnedTop,
      idleSeconds: hibernator ? hibernator.getIdleSeconds(id, nowMs) : 0,
    };
  });

  enriched.sort((a, b) => a.order - b.order || a.displayName.localeCompare(b.displayName));
  return enriched;
}

const HANGAR_BOOT_ID = String(Date.now());

export async function fetchHangarState(
  {
    clientWorkspaceUris = [],
    conversationId = '',
    configPath = HANGAR_CONFIG_PATH,
    sidecarsDir = GLOBAL_SIDECARS_DIR,
    packagesDir = HANGAR_PACKAGES_DIR,
    pluginsDir = configPath === HANGAR_CONFIG_PATH && sidecarsDir === GLOBAL_SIDECARS_DIR ? GLOBAL_PLUGINS_DIR : '',
    hibernator = defaultHibernator,
    rpcFn = hangarRpc,
  } = {}
) {
  const hangarConfig = loadHangarConfig(configPath);
  hibernator.syncManualStops?.(hangarConfig.manuallyStopped);

  // Workspace URIs let GetAllPlugins find workspace-scoped plugins too
  const workspaceUris = clientWorkspaceUris.filter((u) => typeof u === 'string' && u);
  const [sidecarsRes, trajectoriesRes, pluginsRes] = await Promise.all([
    rpcFn('GetSidecars', {}).catch(() => ({ sidecars: [] })),
    rpcFn('GetAllCascadeTrajectories', {}).catch(() => ({ trajectorySummaries: {} })),
    rpcFn('GetAllPlugins', { workspaceUris }).catch(() => null),
  ]);

  const activeWorkspace = resolveActiveWorkspace({
    clientWorkspaceUris,
    trajectoriesResponse: trajectoriesRes,
    requestedConversationId: conversationId,
  });

  // A real id comes back as is. '_new' resolves to '' and is passed on unchanged, so child sidecars
  // also see a new-conversation pane. Only a Hangar opened without an id gets the kit's guess.
  const resolvedConvId = activeWorkspace.conversationId || conversationId || '';
  let sidecars = enrichSidecarList(sidecarsRes?.sidecars || [], hangarConfig, {
    activeWorkspacePath: activeWorkspace.workspacePath,
    conversationId: resolvedConvId,
    sidecarsDir,
    packagesDir,
    pluginsDir,
    pluginsRes,
    hibernator,
  });

  const lifecycleEvents = await hibernator.reconcile(sidecars, {
    hibernateAfterIdleMinutes: hangarConfig.layout?.hibernateAfterIdleMinutes ?? 10,
    manageSidecarFn: (action, sidecarId) =>
      applySidecarAction(sidecarId, action, {
        rpcFn,
        rawSidecars: sidecarsRes?.sidecars,
        pluginsDir,
        pluginsRes,
      }),
  });

  // If any sidecar was auto-enabled or auto-disabled, re-fetch GetSidecars once for fresh URLs
  if (lifecycleEvents.length > 0) {
    const refreshed = await rpcFn('GetSidecars', {}).catch(() => null);
    if (refreshed?.sidecars) {
      sidecars = enrichSidecarList(refreshed.sidecars, hangarConfig, {
        activeWorkspacePath: activeWorkspace.workspacePath,
        conversationId: resolvedConvId,
        sidecarsDir,
        packagesDir,
        pluginsDir,
        pluginsRes,
        hibernator,
      });
    }
  }

  const suggestions = detectWorkspaceSuggestions({
    activeWorkspacePath: activeWorkspace.workspacePath,
    sidecars,
  });
  const terminals = await listWorkspaceTerminals({
    workspacePath: activeWorkspace.workspacePath,
    conversationId: resolvedConvId,
    showExternalTerminals: hangarConfig.layout?.showExternalTerminals !== false,
    rpcFn,
  }).catch(() => []);

  return {
    bootId: HANGAR_BOOT_ID,
    timestamp: new Date().toISOString(),
    activeWorkspace,
    theme: resolveHostTheme(),
    layout: hangarConfig.layout,
    hangar: getCachedHangarUpdate(sidecarsDir),
    sidecars,
    terminals,
    plugins: listInstalledPlugins(pluginsRes, hangarConfig, { pluginsDir }),
    pluginDiagnostics: inspectInstalledPluginHealth(pluginsDir),
    suggestions,
    lifecycleEvents,
  };
}

function resolvePluginStateKey(entry, sidecarId) {
  const pluginPath = String(entry?.pluginPath || '');
  const pluginsSegment = pluginPath.match(/[\\/]plugins[\\/]([^\\/]+)/);
  if (pluginsSegment?.[1]) return pluginsSegment[1];
  if (entry?.parentPluginId) return entry.parentPluginId;
  const lastSegment = pluginPath.split(/[\\/]/).filter(Boolean).pop();
  if (lastSegment) return lastSegment;
  return String(entry?.parentPluginId || entry?.id || sidecarId).split('/')[0];
}

async function applySidecarAction(
  sidecarId,
  action,
  { rpcFn = hangarRpc, rawSidecars = null, pluginsDir = '', pluginsRes = null, pollMs = 80, maxWaitMs = 3000 } = {}
) {
  const preloaded =
    rawSidecars?.find((s) => (s.sidecarId || s.id) === sidecarId) ||
    (pluginsDir || pluginsRes
      ? discoverInstalledPluginSidecars({ pluginsDir, pluginsRes }).find((s) => s.id === sidecarId)
      : null);

  if (
    action === 'SIDECAR_ACTION_RESTART' ||
    (!sidecarId.includes('/') && !preloaded?.parentPluginId && !preloaded?.pluginPath)
  ) {
    await rpcFn('ManageSidecar', { action, sidecarId });
    return;
  }

  const enabled = action === 'SIDECAR_ACTION_ENABLE' || action === 'SIDECAR_ACTION_START';
  const lsAction = enabled ? 'SIDECAR_ACTION_ENABLE' : 'SIDECAR_ACTION_DISABLE';
  const list = rawSidecars ?? (await rpcFn('GetSidecars', {}).catch(() => null))?.sidecars ?? [];
  const current = list.find((s) => (s.sidecarId || s.id) === sidecarId) || preloaded;
  const pluginDir = resolvePluginStateKey(current, sidecarId);

  // Antigravity's SidecarManager.loadPlugin overwrites sidecar.userConfig.enabled with !plugin.disabled
  // on every reload, so plugin-bundled sidecars can only be enabled or disabled through their plugin entry.
  await rpcFn('JetboxWriteState', {
    userConfig: { plugins: { [pluginDir]: { enabled } } },
  });
  await rpcFn('ManageSidecar', { action: lsAction, sidecarId });

  if (typeof current?.userConfig?.enabled !== 'boolean') return;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    invalidateStateReads();
    const next = (await rpcFn('GetSidecars', {}).catch(() => null))?.sidecars?.find(
      (s) => (s.sidecarId || s.id) === sidecarId
    );
    if (!next) break;
    const settled = enabled
      ? next.status === 'SIDECAR_STATUS_RUNNING' ||
        next.status === 'SIDECAR_STATUS_ERRORED' ||
        next.status === 'SIDECAR_STATUS_BACKOFF'
      : next.status !== 'SIDECAR_STATUS_RUNNING';
    if (next.userConfig?.enabled === enabled && settled) break;
  }
  invalidateStateReads();
}

export async function manageChildSidecar(
  sidecarId,
  action,
  {
    hibernator = defaultHibernator,
    rpcFn = hangarRpc,
    configPath = HANGAR_CONFIG_PATH,
    rawSidecars = null,
    pluginsDir = configPath === HANGAR_CONFIG_PATH ? GLOBAL_PLUGINS_DIR : '',
    pluginsRes = null,
    pollMs,
    maxWaitMs,
  } = {}
) {
  assertValidSidecarId(sidecarId);
  const validActions = new Set([
    'SIDECAR_ACTION_ENABLE',
    'SIDECAR_ACTION_DISABLE',
    'SIDECAR_ACTION_RESTART',
    'SIDECAR_ACTION_START',
    'SIDECAR_ACTION_STOP',
  ]);
  if (!validActions.has(action)) {
    throw new Error(`Invalid ManageSidecar action: ${action}`);
  }

  // Persisted before the RPC so a poll that lands mid-call already sees the stop and won't auto-wake it
  const stopped = action === 'SIDECAR_ACTION_DISABLE' || action === 'SIDECAR_ACTION_STOP';
  setManualStop(sidecarId, stopped, configPath);
  hibernator?.markManualStop(sidecarId, stopped);

  await applySidecarAction(sidecarId, action, {
    rpcFn,
    rawSidecars,
    pluginsDir,
    pluginsRes,
    pollMs,
    maxWaitMs,
  });
  return { ok: true, sidecarId, action };
}
