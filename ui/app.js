/**
 * @fileoverview Main Antigravity Hangar frontend state & event controller.
 */

(function () {
  const ns = (window.Hangar = window.Hangar || {});
  const urlParams = new URLSearchParams(window.location.search);
  // Antigravity opens a separate Hangar frame per conversation, so this frame's conversation never
  // changes. Its new-conversation screen opens frames with no id at all, so inside a host no id means
  // no conversation yet ('_new'); only a standalone browser tab guesses.
  const hangarConversationId = urlParams.get('conversationId') || (window.parent !== window ? '_new' : '');

  const state = {
    workspaceUris: [],
    activeWorkspace: { workspacePath: '', workspaceName: 'Detecting...' },
    // Empty until the first /api/state, so a render before then doesn't claim a tab for this window
    layout: { pinnedTopSidecarId: '', pinnedTopHeightPx: 185, splitViewEnabled: false },
    hangar: null,
    sidecars: [],
    plugins: [],
    suggestions: [],
    registryPackages: [],
    activeTabId: '',
    bottomActiveTabId: '',
    isResizingSplit: false,
  };

  const els = {
    tabStrip: document.getElementById('tab-strip'),
    topOverflowBtn: document.getElementById('top-overflow-btn'),
    bottomTabBar: document.getElementById('bottom-tab-bar'),
    bottomTabStrip: document.getElementById('bottom-tab-strip'),
    bottomOverflowBtn: document.getElementById('bottom-overflow-btn'),
    tabOverflowPopover: document.getElementById('tab-overflow-popover'),
    splitToggleBtn: document.getElementById('split-toggle-btn'),
    splitDividerGroup: document.getElementById('split-divider-group'),
    splitResizeHandle: document.getElementById('split-resize-handle'),
    mainViewport: document.getElementById('main-viewport'),
    emptyTopState: document.getElementById('empty-top-state'),
    emptyDeckState: document.getElementById('empty-deck-state'),
    storeView: document.getElementById('store-view'),
  };

  ns.initPostMessageRelayBridge?.();

  async function refreshRegistry() {
    try {
      const reg = await ns.apiCall?.('/api/store/registry', {});
      if (Array.isArray(reg?.packages)) state.registryPackages = reg.packages;
      if (reg?.hangar) state.hangar = reg.hangar;
      renderAll();
    } catch { /* keep existing registryPackages */ }
  }

  // The active tab belongs to this window: hangar.json is shared by every Antigravity window, so its
  // pinnedTopSidecarId only seeds a window that hasn't picked a tab yet. sessionStorage is per window.
  const ACTIVE_TAB_KEY = 'hangar.activeTabId';
  function readWindowActiveTab() {
    try { return sessionStorage.getItem(ACTIVE_TAB_KEY) || ''; } catch { return ''; }
  }
  function rememberWindowActiveTab(sidecarId) {
    try { if (sidecarId) sessionStorage.setItem(ACTIVE_TAB_KEY, sidecarId); } catch { /* storage unavailable */ }
  }
  function withWindowActiveTab(layout) {
    const windowTabId = readWindowActiveTab();
    return windowTabId ? { ...layout, pinnedTopSidecarId: windowTabId } : layout;
  }

  function renderAll() {
    const { apiCall } = ns;
    rememberWindowActiveTab(state.layout.pinnedTopSidecarId);
    ns.reconcileIframeDeck?.({ state, els });

    ns.renderTabBar?.({
      tabStripEl: els.tabStrip,
      topOverflowBtnEl: els.topOverflowBtn,
      bottomTabBarEl: els.bottomTabBar,
      bottomTabStripEl: els.bottomTabStrip,
      bottomOverflowBtnEl: els.bottomOverflowBtn,
      tabOverflowPopoverEl: els.tabOverflowPopover,
      splitBtnEl: els.splitToggleBtn,
      sidecars: state.sidecars,
      registryPackages: state.registryPackages,
      hangar: state.hangar,
      bottomActiveTabId: state.bottomActiveTabId,
      layout: state.layout,
      onSelectTopSplitTab: async (sidecarId) => {
        state.layout.pinnedTopSidecarId = sidecarId;
        renderAll();
        await apiCall?.('/api/layout/update', { pinnedTopSidecarId: sidecarId });
      },
      onSelectBottomSplitTab: (sidecarId) => {
        state.bottomActiveTabId = sidecarId;
        renderAll();
      },
      onDropTab: async ({ sidecarId, targetPane, beforeTabId }) => {
        const { workspaceTabs, topSet } = ns.partitionSplitTabs(state.sidecars, state.layout);
        const currentIds = workspaceTabs.map((t) => t.sidecarId);
        const existingOrder = Array.isArray(state.layout.tabOrder) ? state.layout.tabOrder : [];
        const baseOrder = [
          ...currentIds,
          ...existingOrder.filter((id) => !currentIds.includes(id)),
        ].filter((id) => id !== sidecarId);

        if (beforeTabId && baseOrder.includes(beforeTabId)) {
          baseOrder.splice(baseOrder.indexOf(beforeTabId), 0, sidecarId);
        } else {
          baseOrder.push(sidecarId);
        }
        state.layout.tabOrder = baseOrder;

        if (state.layout.splitViewEnabled) {
          if (targetPane === 'top') {
            topSet.add(sidecarId);
            state.layout.pinnedTopSidecarId = sidecarId;
          } else if (targetPane === 'bottom') {
            topSet.delete(sidecarId);
            state.bottomActiveTabId = sidecarId;
          }
          state.layout.topSplitTabIds = [...topSet];
          const { activeTopId } = ns.partitionSplitTabs(state.sidecars, state.layout);
          state.layout.pinnedTopSidecarId = activeTopId;
        } else {
          state.layout.pinnedTopSidecarId = sidecarId;
        }

        renderAll();
        await apiCall?.('/api/layout/update', {
          tabOrder: state.layout.tabOrder,
          topSplitTabIds: state.layout.topSplitTabIds,
          pinnedTopSidecarId: state.layout.pinnedTopSidecarId,
        });
      },
    });

    const { activeSingleId, activeTopId } = ns.partitionSplitTabs(state.sidecars, state.layout);
    const isExtensionsVisible = state.layout.splitViewEnabled
      ? state.bottomActiveTabId === ns.EXTENSIONS_TAB_ID || activeTopId === ns.EXTENSIONS_TAB_ID
      : activeSingleId === ns.EXTENSIONS_TAB_ID;

    if (isExtensionsVisible) {
      ns.renderExtensionsTab?.({
        storeViewEl: els.storeView,
        sidecars: state.sidecars,
        plugins: state.plugins,
        suggestions: state.suggestions,
        registryPackages: state.registryPackages,
        hangar: state.hangar,
        layout: state.layout,
        activeWorkspace: state.activeWorkspace,
        onCheckUpdates: async () => {
          await refreshRegistry();
          await refreshHangarState();
        },
        onSelfUpdate: async (payload) => {
          if (!apiCall) return;
          await apiCall('/api/store/self-update', payload);
          await new Promise((r) => setTimeout(r, 600));
          await refreshRegistry();
          await refreshHangarState();
        },
        onManageSidecar: async (sidecarId, action) => {
          if (!apiCall) return;
          await apiCall('/api/sidecar/manage', { sidecarId, action });
          await refreshHangarState();
        },
        onSaveWorkspaces: async (sc, patterns) => {
          if (!apiCall) return;
          await apiCall('/api/rules/update', {
            sidecarId: sc.sidecarId,
            scope: patterns.includes('*') ? 'global' : 'project',
            workspaces: patterns,
          });
          await refreshHangarState();
        },
        onToggleAutoHibernate: async (sc) => {
          if (!apiCall) return;
          await apiCall('/api/rules/update', { sidecarId: sc.sidecarId, autoHibernate: !sc.autoHibernate });
          await refreshHangarState();
        },
        onApplySuggestion: async (sug) => {
          if (!apiCall) return;
          const wsPath = state.activeWorkspace.workspacePath;
          if (sug.actionType === 'install') {
            // Installs go through Discover so the capability tier consent is always shown
            ns.setExtensionsSubTab?.('discover');
            ns.setDiscoverQuery?.(sug.sidecarId);
            renderAll();
            return;
          }
          const existingSc = state.sidecars.find((s) => s.sidecarId === sug.sidecarId);
          const curWs = (existingSc?.workspaces || []).filter((w) => w !== '*');
          const nextWs = wsPath ? Array.from(new Set([...curWs, wsPath])) : ['*'];
          await apiCall('/api/rules/update', { sidecarId: sug.sidecarId, scope: 'project', workspaces: nextWs });
          await apiCall('/api/sidecar/manage', { sidecarId: sug.sidecarId, action: 'SIDECAR_ACTION_ENABLE' });
          await refreshHangarState();
        },
        onInspectLocal: async (folderPath) => apiCall('/api/store/inspect', { folderPath }),
        onLinkLocal: async (payload) => {
          const res = await apiCall('/api/store/link-local', payload);
          await refreshRegistry();
          await refreshHangarState();
          return res;
        },
        onInstallRemote: async (payload) => {
          const res = await apiCall('/api/store/install', payload);
          await refreshRegistry();
          await refreshHangarState();
          return res;
        },
        onUninstallSidecar: async (sidecarId) => {
          await apiCall('/api/store/uninstall', { sidecarId });
          await refreshRegistry();
          await refreshHangarState();
        },
        onPreviewPlugin: async (payload) => apiCall('/api/store/port-preview', payload),
        onInstallPlugin: async (payload) => {
          const res = await apiCall('/api/store/install-plugin', payload);
          await refreshRegistry();
          await refreshHangarState();
          return res;
        },
        onUninstallPlugin: async (pluginId) => {
          await apiCall('/api/store/uninstall-plugin', { pluginId });
          await refreshRegistry();
          await refreshHangarState();
        },
      });
    }
  }

  let lastStateRefreshAt = 0;
  let stateRefresh = null;
  let stateRefreshAgain = false;

  // One /api/state request at a time. A refresh asked for mid-request (after a click, a workspace or
  // conversation change) runs once more when it ends, so whoever awaits it sees state from after their change.
  function refreshHangarState() {
    if (stateRefresh) {
      stateRefreshAgain = true;
      return stateRefresh;
    }
    stateRefresh = (async () => {
      do {
        stateRefreshAgain = false;
        await loadHangarState();
      } while (stateRefreshAgain);
    })().finally(() => {
      stateRefresh = null;
    });
    return stateRefresh;
  }

  async function loadHangarState() {
    if (ns.isPointerOnTab || state.isResizingSplit) return;
    lastStateRefreshAt = Date.now();
    try {
      const data = await ns.apiCall('/api/state', {
        workspaceUris: state.workspaceUris,
        conversationId: hangarConversationId,
      });
      if (ns.isPointerOnTab || state.isResizingSplit) return;
      if (data.theme) ns.applyThemePayload?.(data.theme, false);
      state.activeWorkspace = data.activeWorkspace || state.activeWorkspace;
      if (data.layout) state.layout = withWindowActiveTab(data.layout);
      if (data.hangar) state.hangar = data.hangar;
      state.sidecars = data.sidecars || [];
      state.plugins = data.plugins || [];
      state.suggestions = data.suggestions || [];
      renderAll();
    } catch (err) {
      console.error('[hangar] Failed to refresh state:', err);
    }
  }

  ns.bindSplitResizeHandle?.({
    state,
    els,
    onSaveHeight: (pinnedTopHeightPx) => ns.apiCall('/api/layout/update', { pinnedTopHeightPx }),
  });

  els.splitToggleBtn?.addEventListener('click', async () => {
    const nextSplit = !state.layout.splitViewEnabled;
    const { activeSingleId, activeTopId, topSet } = ns.partitionSplitTabs(state.sidecars, state.layout);
    const patch = { splitViewEnabled: nextSplit };
    if (nextSplit && activeSingleId && !topSet.has(activeSingleId)) {
      topSet.add(activeSingleId);
      patch.topSplitTabIds = [...topSet];
      patch.pinnedTopSidecarId = activeSingleId;
    } else if (!nextSplit && activeTopId) {
      patch.pinnedTopSidecarId = activeTopId;
    }
    rememberWindowActiveTab(patch.pinnedTopSidecarId);
    await ns.apiCall('/api/layout/update', patch);
    await refreshHangarState();
  });

  if (window.sidecar?.onWorkspaceChange) {
    window.sidecar.onWorkspaceChange((uris) => {
      state.workspaceUris = Array.isArray(uris) ? uris : [];
      refreshHangarState();
    });
  }

  // Poll every 3s while visible. While hidden, poll once a minute: often enough for idle hibernation to
  // keep working, without two Language Server calls every 3s for a window nobody is looking at.
  const VISIBLE_POLL_MS = 3000;
  const HIDDEN_POLL_MS = 60 * 1000;
  // Antigravity can keep an old conversation view mounted and hide it with CSS, where document.hidden
  // stays false; IntersectionObserver still sees this frame leave the viewport
  let inViewport = true;
  const isHidden = () => document.hidden || !inViewport;
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver((entries) => {
      const next = entries[entries.length - 1].isIntersecting;
      if (next === inViewport) return;
      inViewport = next;
      if (!isHidden()) refreshHangarState();
    }).observe(document.documentElement);
  }
  document.addEventListener('visibilitychange', () => {
    if (!isHidden()) refreshHangarState();
  });

  refreshRegistry();
  refreshHangarState();
  setInterval(() => {
    const intervalMs = isHidden() ? HIDDEN_POLL_MS : VISIBLE_POLL_MS;
    // A slow Language Server must not pile up polls behind the one still waiting
    if (!stateRefresh && Date.now() - lastStateRefreshAt >= intervalMs) refreshHangarState();
  }, VISIBLE_POLL_MS);
  setInterval(() => {
    if (!isHidden()) refreshRegistry();
  }, 15 * 60 * 1000);
})();
