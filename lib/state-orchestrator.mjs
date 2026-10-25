/**
 * @fileoverview Orchestrates Language Server GetSidecars + GetAllCascadeTrajectories + GetAllPlugins,
 * workspace rule evaluation, child iframe URL normalization, and process management.
 */

import { resolveHostTheme } from 'antigravity-sidecar-kit/theme';
import {
  matchesWorkspaceRule,
  resolveActiveWorkspace,
} from 'antigravity-sidecar-kit/workspace';
import {
  GLOBAL_PLUGINS_DIR, GLOBAL_SIDECARS_DIR, HANGAR_CONFIG_PATH, HANGAR_PACKAGES_DIR, RESERVED_SIDECAR_IDS,
} from './constants.mjs';
import {
  assertValidSidecarId,
  buildChildIframeUrl,
  loadHangarConfig,
  setManualStop,
} from './config-store.mjs';
import { defaultHibernator } from './hibernation-manager.mjs';
import { hangarRpc, invalidateStateReads } from './ls-rpc.mjs';
import { listInstalledPlugins } from './plugin-installer.mjs';
import {
  detectWorkspaceSuggestions,
  getCachedHangarUpdate,
  getCachedSidecarUpdate,
  readInstalledSidecarMetadata,
} from './registry-catalog.mjs';

export function enrichSidecarList(
  rawSidecars = [],
  hangarConfig = {},
  {
    activeWorkspacePath = '',
    conversationId = '',
    hibernator = defaultHibernator,
    sidecarsDir = GLOBAL_SIDECARS_DIR,
    packagesDir = HANGAR_PACKAGES_DIR,
    nowMs = Date.now(),
  } = {}
) {
  const rulesMap = hangarConfig.sidecars || {};
  const pinnedTopId = hangarConfig.layout?.pinnedTopSidecarId || '';
  const splitEnabled = Boolean(hangarConfig.layout?.splitViewEnabled);

  const filtered = rawSidecars.filter(
    (s) => s.sidecarId && !RESERVED_SIDECAR_IDS.has(s.sidecarId) && s.config?.hasWebUi !== false
  );

  const enriched = filtered.map((s, idx) => {
    const id = s.sidecarId;
    const isDefaultGlobal = id === 'context-monitor';
    const rule = rulesMap[id] || {
      scope: isDefaultGlobal ? 'global' : 'project',
      workspaces: isDefaultGlobal ? ['*'] : [],
      autoHibernate: false,
      order: isDefaultGlobal ? 1 : 100 + idx,
      installedVersion: '1.0.0',
      source: id.includes('/') ? `plugin:${id.split('/')[0]}` : 'local',
    };
    // A plugin's sidecar starts and stops with its plugin, so hibernating it would switch off the whole
    // plugin, its skills, hooks and MCP servers included. Only standalone sidecars hibernate.
    const isPluginSidecar = id.includes('/');
    const autoHibernate = Boolean(rule.autoHibernate) && !isPluginSidecar;

    const viewPath = s.config?.uiConfig?.views?.[0]?.path || '/';
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
      displayName:
        s.config?.uiConfig?.displayName ||
        s.config?.displayName ||
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
      matchesWorkspace,
      isPinnedTop,
      idleSeconds: hibernator ? hibernator.getIdleSeconds(id, nowMs) : 0,
    };
  });

  enriched.sort((a, b) => a.order - b.order || a.displayName.localeCompare(b.displayName));
  return enriched;
}

export async function fetchHangarState(
  {
    clientWorkspaceUris = [],
    conversationId = '',
    configPath = HANGAR_CONFIG_PATH,
    sidecarsDir = GLOBAL_SIDECARS_DIR,
    packagesDir = HANGAR_PACKAGES_DIR,
    pluginsDir = GLOBAL_PLUGINS_DIR,
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

  const resolvedConvId = activeWorkspace.conversationId || conversationId || '';
  let sidecars = enrichSidecarList(sidecarsRes?.sidecars || [], hangarConfig, {
    activeWorkspacePath: activeWorkspace.workspacePath,
    conversationId: resolvedConvId,
    sidecarsDir,
    packagesDir,
    hibernator,
  });

  const lifecycleEvents = await hibernator.reconcile(sidecars, {
    hibernateAfterIdleMinutes: hangarConfig.layout?.hibernateAfterIdleMinutes ?? 10,
    manageSidecarFn: (action, sidecarId) =>
      applySidecarAction(sidecarId, action, { rpcFn, rawSidecars: sidecarsRes?.sidecars }),
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
        hibernator,
      });
    }
  }

  const suggestions = detectWorkspaceSuggestions({
    activeWorkspacePath: activeWorkspace.workspacePath,
    sidecars,
  });

  return {
    timestamp: new Date().toISOString(),
    activeWorkspace,
    theme: resolveHostTheme(),
    layout: hangarConfig.layout,
    hangar: getCachedHangarUpdate(sidecarsDir),
    sidecars,
    plugins: listInstalledPlugins(pluginsRes, hangarConfig, { pluginsDir }),
    suggestions,
    lifecycleEvents,
  };
}

const pluginDirFromPath = (pluginPath, sidecarId) =>
  String(pluginPath || '').split(/[\\/]/).filter(Boolean).pop() || sidecarId.split('/')[0];

async function applySidecarAction(
  sidecarId,
  action,
  { rpcFn = hangarRpc, rawSidecars = null, pollMs = 80, maxWaitMs = 3000 } = {}
) {
  if (!sidecarId.includes('/') || action === 'SIDECAR_ACTION_RESTART') {
    await rpcFn('ManageSidecar', { action, sidecarId });
    return;
  }

  const enabled = action === 'SIDECAR_ACTION_ENABLE' || action === 'SIDECAR_ACTION_START';
  const lsAction = enabled ? 'SIDECAR_ACTION_ENABLE' : 'SIDECAR_ACTION_DISABLE';
  const list = rawSidecars ?? (await rpcFn('GetSidecars', {}).catch(() => null))?.sidecars ?? [];
  const current = list.find((s) => s.sidecarId === sidecarId);
  const pluginDir = pluginDirFromPath(current?.pluginPath, sidecarId);

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
      (s) => s.sidecarId === sidecarId
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
  { hibernator = defaultHibernator, rpcFn = hangarRpc, configPath = HANGAR_CONFIG_PATH, pollMs, maxWaitMs } = {}
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

  await applySidecarAction(sidecarId, action, { rpcFn, pollMs, maxWaitMs });
  return { ok: true, sidecarId, action };
}
