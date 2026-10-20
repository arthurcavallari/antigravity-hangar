/**
 * @fileoverview Orchestrates Language Server GetSidecars + GetAllCascadeTrajectories,
 * workspace rule evaluation, child iframe URL normalization, and process management.
 */

import { HANGAR_CONFIG_PATH, RESERVED_SIDECAR_IDS } from './constants.mjs';
import { callLsRpc } from './rpc-client.mjs';
import {
  matchesWorkspaceRule,
  resolveActiveWorkspace,
} from './workspace-resolver.mjs';
import {
  buildChildIframeUrl,
  loadHangarConfig,
} from './config-store.mjs';
import { resolveHostTheme } from './theme.mjs';
import { defaultHibernator } from './hibernation-manager.mjs';
import { detectWorkspaceSuggestions } from './registry-catalog.mjs';

export function enrichSidecarList(
  rawSidecars = [],
  hangarConfig = {},
  { activeWorkspacePath = '', conversationId = '', hibernator = defaultHibernator, nowMs = Date.now() } = {}
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
          : isStopped && rule.autoHibernate && !matchesWorkspace
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
      autoHibernate: Boolean(rule.autoHibernate),
      order: Number(rule.order ?? 100 + idx),
      source: rule.source || 'local',
      installedVersion: rule.installedVersion || '1.0.0',
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
    hibernator = defaultHibernator,
    rpcFn = callLsRpc,
  } = {}
) {
  const hangarConfig = loadHangarConfig(configPath);

  const [sidecarsRes, trajectoriesRes] = await Promise.all([
    rpcFn('GetSidecars', {}).catch(() => ({ sidecars: [] })),
    rpcFn('GetAllCascadeTrajectories', {}).catch(() => ({ trajectorySummaries: {} })),
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
    hibernator,
  });

  const lifecycleEvents = await hibernator.reconcile(sidecars, {
    hibernateAfterIdleMinutes: hangarConfig.layout?.hibernateAfterIdleMinutes ?? 10,
    manageSidecarFn: (action, sidecarId) => rpcFn('ManageSidecar', { action, sidecarId }),
  });

  // If any sidecar was auto-enabled or auto-disabled, re-fetch GetSidecars once for fresh URLs
  if (lifecycleEvents.length > 0) {
    const refreshed = await rpcFn('GetSidecars', {}).catch(() => null);
    if (refreshed?.sidecars) {
      sidecars = enrichSidecarList(refreshed.sidecars, hangarConfig, {
        activeWorkspacePath: activeWorkspace.workspacePath,
        conversationId: resolvedConvId,
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
    sidecars,
    suggestions,
    lifecycleEvents,
  };
}

export async function manageChildSidecar(
  sidecarId,
  action,
  { hibernator = defaultHibernator, rpcFn = callLsRpc } = {}
) {
  if (!sidecarId) throw new Error('sidecarId is required');
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

  if (action === 'SIDECAR_ACTION_DISABLE' || action === 'SIDECAR_ACTION_STOP') {
    hibernator?.markManualStop(sidecarId, true);
  } else if (action === 'SIDECAR_ACTION_ENABLE' || action === 'SIDECAR_ACTION_START') {
    hibernator?.markManualStop(sidecarId, false);
  }

  await rpcFn('ManageSidecar', { action, sidecarId });
  return { ok: true, sidecarId, action };
}
