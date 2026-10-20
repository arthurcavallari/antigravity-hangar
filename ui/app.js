/**
 * @fileoverview Main Antigravity Hangar frontend state & event controller.
 */

(function () {
  const ns = (window.Hangar = window.Hangar || {});
  const urlParams = new URLSearchParams(window.location.search);
  let hangarConversationId = urlParams.get('conversationId') || '';

  window.addEventListener('message', (e) => {
    if (e.data?.type === 'conversation-change' && typeof e.data?.payload?.conversationId === 'string') {
      hangarConversationId = e.data.payload.conversationId;
      refreshHangarState();
    }
  });

  const state = {
    workspaceUris: [],
    activeWorkspace: { workspacePath: '', workspaceName: 'Detecting...' },
    layout: { pinnedTopSidecarId: 'context-monitor', pinnedTopHeightPx: 185, splitViewEnabled: false },
    hangar: null,
    sidecars: [],
    suggestions: [],
    registryPackages: [],
    activeTabId: '',
    bottomActiveTabId: '',
    isResizingSplit: false,
  };

  const els = {
    workspaceName: document.getElementById('workspace-name'),
    tabStrip: document.getElementById('tab-strip'),
    topOverflowBtn: document.getElementById('top-overflow-btn'),
    bottomTabBar: document.getElementById('bottom-tab-bar'),
    bottomTabStrip: document.getElementById('bottom-tab-strip'),
    bottomOverflowBtn: document.getElementById('bottom-overflow-btn'),
    tabOverflowPopover: document.getElementById('tab-overflow-popover'),
    splitToggleBtn: document.getElementById('split-toggle-btn'),
    projectPopover: document.getElementById('project-popover'),
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

  function renderAll() {
    const { apiCall } = ns;
    ns.reconcileIframeDeck?.({ state, els });

    ns.renderTabBar?.({
      workspaceEl: els.workspaceName,
      tabStripEl: els.tabStrip,
      topOverflowBtnEl: els.topOverflowBtn,
      bottomTabBarEl: els.bottomTabBar,
      bottomTabStripEl: els.bottomTabStrip,
      bottomOverflowBtnEl: els.bottomOverflowBtn,
      tabOverflowPopoverEl: els.tabOverflowPopover,
      splitBtnEl: els.splitToggleBtn,
      activeWorkspace: state.activeWorkspace,
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

    ns.renderProjectPopover?.({
      popoverEl: els.projectPopover,
      activeWorkspace: state.activeWorkspace,
      sidecars: state.sidecars,
      suggestions: state.suggestions,
      onToggleWorkspaceRule: async (sc, wsPath) => {
        if (!wsPath || !apiCall) return;
        const current = sc.workspaces.filter((w) => w !== '*');
        const exists = current.some((w) => w.toLowerCase() === wsPath.toLowerCase());
        const next = exists
          ? current.filter((w) => w.toLowerCase() !== wsPath.toLowerCase())
          : [...current, wsPath];
        await apiCall('/api/rules/update', { sidecarId: sc.sidecarId, scope: 'project', workspaces: next });
        if (!exists && !sc.isRunning) {
          await apiCall('/api/sidecar/manage', { sidecarId: sc.sidecarId, action: 'SIDECAR_ACTION_ENABLE' });
        }
        await refreshHangarState();
      },
      onToggleGlobalPin: async (sc) => {
        if (!apiCall) return;
        const nextScope = sc.scope === 'global' ? 'project' : 'global';
        const nextWs = nextScope === 'global' ? ['*'] : state.activeWorkspace.workspacePath ? [state.activeWorkspace.workspacePath] : [];
        await apiCall('/api/rules/update', { sidecarId: sc.sidecarId, scope: nextScope, workspaces: nextWs });
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
          await apiCall('/api/store/install', {
            sidecarId: sug.sidecarId, gitRepo: sug.gitRepo, tarballUrl: sug.tarballUrl,
            version: sug.version, scope: 'project', workspaces: wsPath ? [wsPath] : ['*'],
          });
          await refreshRegistry();
        } else {
          const existingSc = state.sidecars.find((s) => s.sidecarId === sug.sidecarId);
          const curWs = (existingSc?.workspaces || []).filter((w) => w !== '*');
          const nextWs = wsPath ? Array.from(new Set([...curWs, wsPath])) : ['*'];
          await apiCall('/api/rules/update', { sidecarId: sug.sidecarId, scope: 'project', workspaces: nextWs });
          await apiCall('/api/sidecar/manage', { sidecarId: sug.sidecarId, action: 'SIDECAR_ACTION_ENABLE' });
        }
        await refreshHangarState();
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
      });
    }
  }

  async function refreshHangarState() {
    if (ns.isPointerOnTab || state.isResizingSplit) return;
    try {
      const data = await ns.apiCall('/api/state', {
        workspaceUris: state.workspaceUris,
        conversationId: hangarConversationId,
      });
      if (ns.isPointerOnTab || state.isResizingSplit) return;
      if (data.theme) ns.applyThemePayload?.(data.theme, false);
      state.activeWorkspace = data.activeWorkspace || state.activeWorkspace;
      if (data.layout) state.layout = data.layout;
      if (data.hangar) state.hangar = data.hangar;
      state.sidecars = data.sidecars || [];
      state.suggestions = data.suggestions || [];
      renderAll();
    } catch (err) {
      if (els.workspaceName) {
        els.workspaceName.textContent = 'Sync Error';
        els.workspaceName.parentElement.title = err.message;
      }
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
    await ns.apiCall('/api/layout/update', patch);
    await refreshHangarState();
  });

  if (window.sidecar?.onWorkspaceChange) {
    window.sidecar.onWorkspaceChange((uris) => {
      state.workspaceUris = Array.isArray(uris) ? uris : [];
      refreshHangarState();
    });
  }

  refreshRegistry();
  refreshHangarState();
  setInterval(refreshHangarState, 3000);
  setInterval(refreshRegistry, 15 * 60 * 1000);
})();
