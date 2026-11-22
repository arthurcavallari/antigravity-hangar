/**
 * @fileoverview Orchestrates Language Server GetSidecars + GetAllCascadeTrajectories + GetAllPlugins,
 * workspace rule evaluation, child iframe URL normalization, and process management.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { APP_STORAGE_PATH, readJsonSafe } from 'antigravity-sidecar-kit/config';
import { resolveHostTheme } from 'antigravity-sidecar-kit/theme';
import {
  matchesWorkspaceRule,
  normalizeWorkspacePath,
  resolveActiveWorkspace,
} from 'antigravity-sidecar-kit/workspace';
import {
  GLOBAL_BUILTIN_PLUGINS_DIR,
  GLOBAL_PLUGINS_DIR,
  GLOBAL_SIDECARS_DIR,
  HANGAR_CONFIG_PATH,
  HANGAR_PACKAGES_DIR,
  RESERVED_SIDECAR_IDS,
} from './constants.mjs';
import {
  assertValidSidecarId,
  buildChildIframeUrl,
  discoverPluginSidecarEntries,
  loadHangarConfig,
  setManualStop,
} from './config-store.mjs';
import { defaultHibernator } from './hibernation-manager.mjs';
import {
  isDeletedSideChatId,
  markHangarSideChatIds,
  noteObservedLiveSideChatIds,
} from './jetbox-sidechat.mjs';
import { fetchJetboxSummaries, hangarRpc, invalidateStateReads } from './ls-rpc.mjs';
import {
  getPluginDiagnosticsCacheGen,
  inspectInstalledPluginHealth,
  resolveEffectivePluginRoot,
} from './plugin-diagnostics.mjs';
import { listInstalledPlugins, pluginDirOf } from './plugin-installer.mjs';
import {
  detectWorkspaceSuggestions,
  getCachedHangarUpdate,
  getCachedSidecarUpdate,
  readInstalledSidecarMetadata,
} from './registry-catalog.mjs';
import { resolveSidecarIconUrl, serveSidecarIcon } from './sidecar-icons.mjs';
import { listWorkspaceTerminals } from './terminal-manager.mjs';

export { serveSidecarIcon };

const PLUGIN_SIDECAR_CACHE_TTL_MS = 5_000;
const pluginSidecarEntriesCache = new Map();
let lastPluginSidecarCacheGen = -1;
let cachedHostTheme = { ts: 0, value: null };

function getCachedHostTheme(appStoragePath = APP_STORAGE_PATH) {
  const isDefault = appStoragePath === APP_STORAGE_PATH;
  const now = Date.now();
  if (isDefault && cachedHostTheme.value && now - cachedHostTheme.ts < 3_000) {
    return cachedHostTheme.value;
  }
  const base = resolveHostTheme();
  const storage = readJsonSafe(appStoragePath, {}) || {};
  const rawFs = Number(storage['jetski.fontSize']);
  const cssVariables = { ...(base?.cssVariables || {}) };
  if (rawFs === 12 || rawFs === 16) {
    cssVariables['--app-font-scale'] = String(Number((rawFs / 14).toFixed(6)));
    cssVariables['--font-size'] = `${rawFs}px`;
  } else {
    delete cssVariables['--app-font-scale'];
    delete cssVariables['--font-size'];
  }
  const value = { ...base, cssVariables };
  if (isDefault) cachedHostTheme = { ts: now, value };
  return value;
}

function normalizePluginRootKey(rawPath = '') {
  const raw = String(rawPath || '').trim();
  if (!raw) return '';
  let fsPath = raw;
  try {
    fsPath = normalizeWorkspacePath(raw) || raw;
  } catch {
    fsPath = raw;
  }
  const abs = resolve(fsPath).replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function sidecarSubSlug(id = '') {
  const s = String(id || '');
  const slash = s.indexOf('/');
  return slash >= 0 ? s.slice(slash + 1) : '';
}

function discoverInstalledPluginSidecars({ pluginsDir = '', pluginsRes = null, hangarConfig = {} } = {}) {
  const useCache = pluginsDir === GLOBAL_PLUGINS_DIR;
  const currentGen = getPluginDiagnosticsCacheGen();
  if (currentGen !== lastPluginSidecarCacheGen) {
    pluginSidecarEntriesCache.clear();
    lastPluginSidecarCacheGen = currentGen;
  }
  const now = Date.now();
  const pluginRoots = new Map();
  const recordIdByDir = new Map();
  if (hangarConfig?.plugins && typeof hangarConfig.plugins === 'object') {
    for (const [pluginId, record] of Object.entries(hangarConfig.plugins)) {
      const dirName = record?.dir || pluginId;
      if (dirName) recordIdByDir.set(dirName, pluginId);
    }
  }
  const registerRoot = (dir, pluginId = '', disabled = false) => {
    if (!dir || !existsSync(dir)) return;
    const effective = resolveEffectivePluginRoot(dir);
    if (!effective || !existsSync(effective)) return;
    const abs = resolve(effective).replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`);
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
      const dirName = pluginDirOf(p) || String(p?.name || '').trim();
      const baseDirName = dirName.split('@')[0];
      const pluginId = String(
        recordIdByDir.get(dirName) || recordIdByDir.get(baseDirName) || dirName || p?.name || ''
      ).trim();
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

  if (pluginsDir && recordIdByDir.size > 0) {
    for (const [dirName, pluginId] of recordIdByDir.entries()) {
      registerRoot(join(pluginsDir, dirName), pluginId, false);
    }
  }

  if (pluginsDir && existsSync(pluginsDir)) {
    try {
      for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          const baseName = entry.name.split('@')[0];
          registerRoot(
            join(pluginsDir, entry.name),
            recordIdByDir.get(entry.name) || recordIdByDir.get(baseName) || entry.name,
            false
          );
        }
      }
    } catch {
      // Ignore unreadable plugins directory
    }
  }

  const discovered = [];
  for (const { rootDir, ...meta } of pluginRoots.values()) {
    const cacheKey = `${rootDir}\0${meta.pluginId}`;
    let entries;
    const cached = useCache ? pluginSidecarEntriesCache.get(cacheKey) : null;
    if (cached && now - cached.ts < PLUGIN_SIDECAR_CACHE_TTL_MS) {
      entries = cached.entries;
    } else {
      entries = discoverPluginSidecarEntries(rootDir, meta.pluginId);
      if (useCache) {
        pluginSidecarEntriesCache.set(cacheKey, { ts: now, entries });
      }
    }
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

export function isBuiltinSidecarEntry(entry, sidecarId = entry?.sidecarId || entry?.id || '') {
  const id = String(sidecarId || '');
  if (id === 'swarm/swarm_board' || id.startsWith('swarm/')) return true;
  return /[\\/]builtin[\\/]plugins[\\/]/i.test(String(entry?.pluginPath || ''));
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
    builtinPluginsDir = pluginsDir === GLOBAL_PLUGINS_DIR ? GLOBAL_BUILTIN_PLUGINS_DIR : '',
    pluginsRes = null,
    nowMs = Date.now(),
  } = {}
) {
  const rulesMap = hangarConfig.sidecars || {};
  const wsNorm = String(activeWorkspacePath || '').trim().replace(/\\/g, '/').toLowerCase();
  const convNorm = String(conversationId || '').trim();
  const wsKey = wsNorm || (convNorm ? `conv:${convNorm}` : '');
  const wsLayout = wsKey ? hangarConfig.layout?.workspaceLayouts?.[wsKey] : null;
  const hasScopedLayouts = Boolean(
    hangarConfig.layout?.workspaceLayouts && Object.keys(hangarConfig.layout.workspaceLayouts).length > 0
  );
  const effectiveLayout = wsLayout || (!wsNorm && hasScopedLayouts ? null : hangarConfig.layout) || null;
  const openSet = new Set(Array.isArray(effectiveLayout?.openTabIds) ? effectiveLayout.openTabIds : []);
  const pinnedSet = new Set(Array.isArray(effectiveLayout?.pinnedTabIds) ? effectiveLayout.pinnedTabIds : []);
  const closedSet = new Set(
    Array.isArray(effectiveLayout?.closedTabIds)
      ? effectiveLayout.closedTabIds.filter((id) => !pinnedSet.has(id))
      : []
  );
  const fallbackPinnedTop = !wsNorm && hasScopedLayouts ? 'context-monitor' : hangarConfig.layout?.pinnedTopSidecarId;
  const fallbackSplit = !wsNorm && hasScopedLayouts ? false : hangarConfig.layout?.splitViewEnabled;
  const pinnedTopId = (wsLayout?.pinnedTopSidecarId ?? fallbackPinnedTop) || '';
  const splitEnabled = Boolean(wsLayout?.splitViewEnabled ?? fallbackSplit);

  const mergedRaw = rawSidecars.map((s) => ({
    ...s,
    sidecarId: s.sidecarId || s.id,
  }));
  const discoveredPluginSidecars = discoverInstalledPluginSidecars({
    pluginsDir,
    pluginsRes,
    hangarConfig,
  });
  const discoveredBuiltinSidecars = builtinPluginsDir
    ? discoverInstalledPluginSidecars({ pluginsDir: builtinPluginsDir, pluginsRes: null, hangarConfig })
    : [];
  for (const entry of [...discoveredPluginSidecars, ...discoveredBuiltinSidecars]) {
    const entryRootKey = normalizePluginRootKey(entry.pluginPath);
    const entrySubSlug = sidecarSubSlug(entry.id);
    const existing =
      mergedRaw.find((s) => s.sidecarId === entry.id) ||
      (entryRootKey
        ? mergedRaw.find(
            (s) =>
              s.pluginPath &&
              normalizePluginRootKey(s.pluginPath) === entryRootKey &&
              sidecarSubSlug(s.sidecarId) === entrySubSlug
          )
        : null);
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
    const isBuiltinSidecar = isBuiltinSidecarEntry(s, id);
    const isDefaultGlobal = id === 'context-monitor' || isBuiltinSidecar;
    const inferredParentPluginId =
      s.parentPluginId || (id.includes('/') ? id.split('/')[0] : '');
    const rule = rulesMap[id] || {
      scope: isDefaultGlobal ? 'global' : 'project',
      workspaces: isDefaultGlobal ? ['*'] : [],
      autoHibernate: false,
      order: id === 'context-monitor' ? 1 : 100 + idx,
      installedVersion: '1.0.0',
      source: isBuiltinSidecar ? 'builtin' : (inferredParentPluginId ? `plugin:${inferredParentPluginId}` : 'local'),
    };
    const parentPluginId =
      inferredParentPluginId ||
      (typeof rule.source === 'string' && rule.source.startsWith('plugin:')
        ? rule.source.slice('plugin:'.length)
        : '');
    // A plugin's sidecar starts and stops with its plugin, so hibernating it would switch off the whole
    // plugin, its skills, hooks and MCP servers included. Only standalone sidecars hibernate.
    const isPluginSidecar = Boolean(parentPluginId) || id.includes('/');
    const autoHibernate = Boolean(rule.autoHibernate) && !isPluginSidecar && !isBuiltinSidecar;

    const uiConfig = s.config?.uiConfig || s.config?.ui_config;
    const viewPath = uiConfig?.views?.[0]?.path || '/';
    const status = s.status || 'SIDECAR_STATUS_UNKNOWN';
    const isRunning = status === 'SIDECAR_STATUS_RUNNING';
    const isErrored = status === 'SIDECAR_STATUS_ERRORED';
    const isStopped = status === 'SIDECAR_STATUS_STOPPED';

    const matchesWorkspace =
      rule.scope === 'global' ||
      matchesWorkspaceRule(activeWorkspacePath, rule.workspaces);
    const isOpenInWorkspace = Boolean(
      openSet.has(id) ||
        pinnedSet.has(id) ||
        (matchesWorkspace && !closedSet.has(id))
    );

    const isPinnedTop = splitEnabled && pinnedTopId === id;
    const iframeUrl = isRunning
      ? buildChildIframeUrl(s.baseUrl, viewPath, conversationId, s.webPort)
      : '';

    const diskMeta = readInstalledSidecarMetadata(id, sidecarsDir, rule, packagesDir);
    const installedVersion = diskMeta.version || rule.installedVersion || '1.0.0';
    const cachedUpd = getCachedSidecarUpdate(id, installedVersion);
    const iconUrl = resolveSidecarIconUrl(
      { ...s, sidecarId: id, parentPluginId },
      { sidecarsDir, pluginsDir, builtinPluginsDir }
    );

    return {
      sidecarId: id,
      parentPluginId,
      iconUrl,
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
          : isStopped && autoHibernate && !isOpenInWorkspace
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
      savedGlobs: Array.isArray(rule.savedGlobs) ? rule.savedGlobs : [],
      autoHibernate,
      autoHibernateLocked: isPluginSidecar || isBuiltinSidecar,
      builtin: isBuiltinSidecar,
      order: Number(rule.order ?? 100 + idx),
      source: isBuiltinSidecar ? 'builtin' : (rule.source || 'local'),
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
      isOpenInWorkspace,
      isPinnedTop,
      idleSeconds: hibernator ? hibernator.getIdleSeconds(id, nowMs) : 0,
    };
  });

  enriched.sort((a, b) => a.order - b.order || a.displayName.localeCompare(b.displayName));
  return enriched;
}

const HANGAR_BOOT_ID = String(Date.now());

export function extractNativeSideQuestions(trajectoriesRes, conversationId = '') {
  const convId = String(conversationId || '').trim();
  if (!convId || convId === '_new') return null;
  const summaries = trajectoriesRes?.trajectorySummaries;
  const parentSummary = summaries && typeof summaries === 'object' ? summaries[convId] : null;
  if (!parentSummary || typeof parentSummary !== 'object') return null;
  const ann = parentSummary.annotations && typeof parentSummary.annotations === 'object'
    ? parentSummary.annotations
    : {};
  const rawIds = Array.isArray(ann.sideQuestionCascadeIds)
    ? ann.sideQuestionCascadeIds
    : (Array.isArray(ann.side_question_cascade_ids) ? ann.side_question_cascade_ids : []);
  const deletedSet = new Set(
    Array.isArray(trajectoriesRes?.deletedIds) ? trajectoriesRes.deletedIds : []
  );
  const cascadeIds = [
    ...new Set(
      rawIds
        .map((id) => String(id || '').trim())
        .filter((id) => id && !isDeletedSideChatId(id) && !deletedSet.has(id))
    ),
  ];
  noteObservedLiveSideChatIds(cascadeIds.filter((id) => summaries?.[id]));
  const rawTitles = ann.sideQuestionTitles && typeof ann.sideQuestionTitles === 'object'
    ? ann.sideQuestionTitles
    : (ann.side_question_titles && typeof ann.side_question_titles === 'object' ? ann.side_question_titles : {});
  const titles = {};
  for (const [k, v] of Object.entries(rawTitles)) {
    const cid = String(k || '').trim();
    const clean = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
    if (cid && clean) titles[cid] = clean;
  }
  for (const cid of cascadeIds) {
    if (!titles[cid] && summaries?.[cid] && typeof summaries[cid] === 'object') {
      const childSummary = summaries[cid];
      const fallback = String(childSummary.annotations?.title || childSummary.summary || '').replace(/\s+/g, ' ').trim();
      if (fallback) titles[cid] = fallback;
    }
  }
  return {
    conversationId: convId,
    cascadeIds,
    titles,
  };
}

function isRunningCascadeSummary(info) {
  if (!info || info.killed) return false;
  const st = info.status;
  return Boolean(
    info.notFullyIdle ||
    st === 2 ||
    st === 3 ||
    st === 4 ||
    st === 'CASCADE_RUN_STATUS_RUNNING' ||
    st === 'CASCADE_RUN_STATUS_BUSY' ||
    st === 'CASCADE_RUN_STATUS_CANCELING' ||
    (info.waitingSteps?.length ?? 0) > 0 ||
    (info.backgroundTaskCount ?? 0) > 0
  );
}

export function extractSideQuestionMeta(trajectoriesRes, nativeSideQuestions = null) {
  const summaries = trajectoriesRes?.trajectorySummaries;
  if (!summaries || typeof summaries !== 'object') return {};
  const nativeSet = new Set(
    Array.isArray(nativeSideQuestions?.cascadeIds) ? nativeSideQuestions.cascadeIds : []
  );
  const out = {};
  for (const [rawId, info] of Object.entries(summaries)) {
    const cid = String(rawId || '').trim();
    if (!cid || !info || typeof info !== 'object') continue;
    const isSqType =
      info.trajectoryType === 22 ||
      info.trajectoryType === 'CORTEX_TRAJECTORY_TYPE_SIDE_QUESTION';
    if (!isSqType && !nativeSet.has(cid)) continue;
    const title = String(info.annotations?.title || info.summary || '').replace(/\s+/g, ' ').trim();
    out[cid] = {
      isRunning: isRunningCascadeSummary(info),
      stepCount: Math.max(0, Number(info.stepCount) || 0),
      title,
    };
  }
  noteObservedLiveSideChatIds(Object.keys(out));
  return out;
}

export async function fetchHangarState(
  {
    clientWorkspaceUris = [],
    conversationId = '',
    configPath = HANGAR_CONFIG_PATH,
    sidecarsDir = GLOBAL_SIDECARS_DIR,
    packagesDir = HANGAR_PACKAGES_DIR,
    pluginsDir = configPath === HANGAR_CONFIG_PATH && sidecarsDir === GLOBAL_SIDECARS_DIR ? GLOBAL_PLUGINS_DIR : '',
    appStoragePath = APP_STORAGE_PATH,
    hibernator = defaultHibernator,
    rpcFn = hangarRpc,
    summariesFn = null,
  } = {}
) {
  const hangarConfig = loadHangarConfig(configPath);
  hibernator.syncManualStops?.(hangarConfig.manuallyStopped);

  // Workspace URIs let GetAllPlugins find workspace-scoped plugins too
  const workspaceUris = clientWorkspaceUris.filter((u) => typeof u === 'string' && u);
  const [sidecarsRes, rawTrajectoriesRes, pluginsRes] = await Promise.all([
    rpcFn('GetSidecars', {}).catch(() => ({ sidecars: [] })),
    rpcFn('GetAllCascadeTrajectories', {}).catch(() => ({ trajectorySummaries: {} })),
    rpcFn('GetAllPlugins', { workspaceUris }).catch(() => null),
  ]);
  let trajectoriesRes = rawTrajectoriesRes;
  if (
    conversationId &&
    conversationId !== '_new' &&
    !trajectoriesRes?.trajectorySummaries?.[conversationId] &&
    (typeof summariesFn === 'function' || rpcFn === hangarRpc)
  ) {
    const persisted = await Promise.resolve((summariesFn || fetchJetboxSummaries)()).catch(() => null);
    if (persisted?.summaries && Object.keys(persisted.summaries).length > 0) {
      trajectoriesRes = {
        ...trajectoriesRes,
        trajectorySummaries: {
          ...persisted.summaries,
          ...(trajectoriesRes?.trajectorySummaries || {}),
        },
      };
    }
  }

  const activeWorkspace = resolveActiveWorkspace({
    clientWorkspaceUris,
    trajectoriesResponse: trajectoriesRes,
    requestedConversationId: conversationId,
  });

  // A real id comes back as is. '_new' resolves to '' and must NOT leak into child sidecar iframe URLs
  // (where child sidecars calling GetCascadeTrajectory("_new") trigger LS "LoadUnsafe failed for _new").
  const safeConversationId = conversationId && conversationId !== '_new' ? conversationId : '';
  const resolvedConvId = activeWorkspace.conversationId || safeConversationId || '';
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
    hideHangarTerminals: hangarConfig.layout?.hideHangarTerminals !== false,
    maxScrollbackBytes: hangarConfig.layout?.maxScrollbackBytes,
    rpcFn,
  }).catch(() => []);

  const pluginDiagnostics = inspectInstalledPluginHealth(pluginsDir);
  const scByWs = hangarConfig.layout?.sideChatStateByWorkspace;
  if (scByWs && typeof scByWs === 'object') {
    for (const wsState of Object.values(scByWs)) {
      if (Array.isArray(wsState?.hangarCascadeIds)) {
        markHangarSideChatIds(wsState.hangarCascadeIds);
      }
    }
  }
  const nativeSideQuestions = extractNativeSideQuestions(trajectoriesRes, resolvedConvId);
  const sideQuestionMeta = extractSideQuestionMeta(trajectoriesRes, nativeSideQuestions);

  return {
    bootId: HANGAR_BOOT_ID,
    timestamp: new Date().toISOString(),
    activeWorkspace,
    nativeSideQuestions,
    sideQuestionMeta,
    theme: getCachedHostTheme(appStoragePath),
    layout: hangarConfig.layout,
    hangar: getCachedHangarUpdate(sidecarsDir),
    sidecars,
    terminals,
    plugins: listInstalledPlugins(pluginsRes, hangarConfig, { pluginsDir, pluginDiagnostics, configPath }),
    pluginDiagnostics,
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
      ? discoverInstalledPluginSidecars({ pluginsDir, pluginsRes }).find(
          (s) => s.id === sidecarId || (!s.id.includes('/') && !sidecarId.includes('/') && s.pluginName === sidecarId)
        )
      : null);

  if (
    (action === 'SIDECAR_ACTION_DISABLE' || action === 'SIDECAR_ACTION_STOP') &&
    isBuiltinSidecarEntry(preloaded, sidecarId)
  ) {
    throw new Error(`Built-in Antigravity sidecar "${sidecarId}" is managed by the IDE and cannot be disabled`);
  }

  if (
    action === 'SIDECAR_ACTION_RESTART' ||
    (!sidecarId.includes('/') && !preloaded?.parentPluginId && !preloaded?.pluginPath)
  ) {
    try {
      await rpcFn('ManageSidecar', { action, sidecarId });
    } catch (err) {
      if (action !== 'SIDECAR_ACTION_ENABLE' || !/project name already exists/i.test(String(err?.message || ''))) {
        throw err;
      }
      invalidateStateReads();
      const cur = (await rpcFn('GetSidecars', {}).catch(() => null))?.sidecars?.find(
        (s) => (s.sidecarId || s.id) === sidecarId
      );
      if (cur && cur.status !== 'SIDECAR_STATUS_RUNNING' && cur.status !== 2) {
        await rpcFn('ManageSidecar', { action: 'SIDECAR_ACTION_RESTART', sidecarId }).catch(() => {});
      }
    }
    invalidateStateReads();
    return;
  }

  const enabled = action === 'SIDECAR_ACTION_ENABLE' || action === 'SIDECAR_ACTION_START';
  const list = rawSidecars ?? (await rpcFn('GetSidecars', {}).catch(() => null))?.sidecars ?? [];
  const current = list.find((s) => (s.sidecarId || s.id) === sidecarId) || preloaded;
  if (!enabled && isBuiltinSidecarEntry(current, sidecarId)) {
    throw new Error(`Built-in Antigravity sidecar "${sidecarId}" is managed by the IDE and cannot be disabled`);
  }
  const pluginDir = resolvePluginStateKey(current, sidecarId);

  // A plugin-bundled sidecar is switched on or off only through its plugin entry, which also starts or stops it.
  // Antigravity's SidecarManager.loadPlugin overwrites sidecar.userConfig.enabled with !plugin.disabled on every
  // reload, and the Language Server refuses ManageSidecar for these sidecars ("plugin sidecars cannot be enabled
  // or disabled individually; enable or disable the plugin instead", seen live on 2.29).
  await rpcFn('JetboxWriteState', {
    userConfig: { plugins: { [pluginDir]: { enabled } } },
  });

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
  const knownEntry = rawSidecars?.find((s) => (s.sidecarId || s.id) === sidecarId);
  if (stopped && isBuiltinSidecarEntry(knownEntry, sidecarId)) {
    throw new Error(`Built-in Antigravity sidecar "${sidecarId}" is managed by the IDE and cannot be disabled`);
  }
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
