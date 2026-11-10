/** @fileoverview Main Antigravity Hangar frontend state & event controller. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  const urlParams = new URLSearchParams(window.location.search);
  const hangarConversationId = urlParams.get('conversationId') || (window.parent !== window ? '_new' : '');
  const state = {
    workspaceUris: [],
    activeWorkspace: { workspacePath: '', workspaceName: 'Detecting...' },
    layout: { pinnedTopSidecarId: '', pinnedTopHeightPx: 185, splitViewEnabled: false },
    hangar: null,
    sidecars: [],
    terminals: [],
    plugins: [],
    pluginDiagnostics: [],
    suggestions: [],
    registryPackages: [],
    activeTabId: '',
    bottomActiveTabId: '',
    isResizingSplit: false,
  };
  const byId = (id) => document.getElementById(id);
  const els = {
    tabStrip: byId('tab-strip'),
    topOverflowBtn: byId('top-overflow-btn'),
    bottomTabBar: byId('bottom-tab-bar'),
    bottomTabStrip: byId('bottom-tab-strip'),
    bottomOverflowBtn: byId('bottom-overflow-btn'),
    tabOverflowPopover: byId('tab-overflow-popover'),
    terminalToggleBtn: byId('terminal-toggle-btn'),
    extensionsToggleBtn: byId('extensions-toggle-btn'),
    splitToggleBtn: byId('split-toggle-btn'),
    splitDividerGroup: byId('split-divider-group'),
    splitResizeHandle: byId('split-resize-handle'),
    mainViewport: byId('main-viewport'),
    emptyTopState: byId('empty-top-state'),
    emptyDeckState: byId('empty-deck-state'),
    storeView: byId('store-view'),
    terminalTopView: byId('terminal-top-view'),
    terminalBottomView: byId('terminal-bottom-view'),
  };
  ns.initPostMessageRelayBridge?.();

  async function refreshRegistry() {
    try {
      const reg = await ns.apiCall?.('/api/store/registry', {});
      if (Array.isArray(reg?.packages)) state.registryPackages = reg.packages;
      if (reg?.hangar) state.hangar = reg.hangar;
      renderAll();
    } catch {
      /* keep existing registryPackages */
    }
  }

  let layoutSeq = 0;
  let lastNonExtTabId = '';
  const renderedLists = { singleIds: [], topIds: [], bottomIds: [] };
  const bumpLayoutSeq = () => ++layoutSeq;
  const layoutCtrl = ns.createLayoutController?.({
    state,
    els,
    hangarConversationId,
    bumpLayoutSeq,
    getRenderedLists: () => renderedLists,
    renderAll: () => renderAll(),
    refreshHangarState: () => refreshHangarState(),
  }) || {};
  const {
    getWsStateKey = () => '',
    buildSideChatLayoutPatch = () => ({}),
    saveLayoutUpdate = async () => {},
    rememberWindowActiveTab = () => {},
    applyWorkspaceLayout = (l) => ({ ...l }),
    withWindowActiveTab = (l) => l,
    handleDropTab,
    applyTerminalMergeLayout,
    handleDropIntoTerminal,
    handleSideChatDock,
    handleTabContextAction,
    reopenClosed,
  } = layoutCtrl;

  function renderAll() {
    rememberWindowActiveTab(state.layout.pinnedTopSidecarId);
    ns.reconcileIframeDeck?.({ state, els, onRefreshState: refreshHangarState });
    const visibleTerminals = state.layout.showExternalTerminals === false
      ? state.terminals.filter((t) => !t?.isExternal)
      : state.terminals;
    const { workspaceTabs, topTabs, bottomTabs, activeSingleId, activeTopId } = ns.partitionSplitTabs(
      state.sidecars,
      state.layout,
      visibleTerminals,
    );
    Object.assign(renderedLists, {
      singleIds: workspaceTabs.map((t) => t.sidecarId),
      topIds: topTabs.map((t) => t.sidecarId),
      bottomIds: bottomTabs.map((t) => t.sidecarId),
    });
    const topSlotId = state.layout.splitViewEnabled ? activeTopId : activeSingleId;
    const isBtnTerminal = state.layout.terminalDisplayMode === 'button' && topSlotId === ns.TERMINAL_TAB_ID;
    if (topSlotId && topSlotId !== ns.EXTENSIONS_TAB_ID && !ns.isSideChatTabId?.(topSlotId) && !isBtnTerminal) {
      lastNonExtTabId = topSlotId;
    }
    const selectSlotTab = async (tabId, slotKey) => {
      ++layoutSeq;
      if (tabId === ns.SIDECHAT_TAB_ID) {
        if (ns._sc) ns._sc.isOpen = true;
        if (Array.isArray(state.layout.closedTabIds)) {
          state.layout.closedTabIds = state.layout.closedTabIds.filter((id) => id !== ns.SIDECHAT_TAB_ID);
        }
        if ((ns.getInstanceSideChats?.() || []).length === 0) {
          ns.openTerminalQuoteComposer?.(
            els.mainViewport,
            {},
            { conversationId: hangarConversationId !== '_new' ? hangarConversationId : '', skipActivate: true },
          );
        }
      }
      if (slotKey === 'bottom' && state.layout.splitViewEnabled) {
        state.bottomActiveTabId = tabId;
      } else {
        state.layout.pinnedTopSidecarId = tabId;
      }
      renderAll();
      if (slotKey !== 'bottom' || !state.layout.splitViewEnabled) {
        const patch = { pinnedTopSidecarId: tabId };
        if (tabId === ns.SIDECHAT_TAB_ID) {
          Object.assign(patch, { closedTabIds: state.layout.closedTabIds, ...buildSideChatLayoutPatch() });
        }
        await saveLayoutUpdate(patch);
      } else if (tabId === ns.SIDECHAT_TAB_ID) {
        await saveLayoutUpdate({ closedTabIds: state.layout.closedTabIds, ...buildSideChatLayoutPatch() });
      }
    };
    const termProps = {
      splitEnabled: Boolean(state.layout.splitViewEnabled),
      terminals: visibleTerminals,
      workspacePath: state.activeWorkspace?.workspacePath || '',
      conversationId: hangarConversationId,
      onRefreshState: () => refreshHangarState(),
      onSelectTab: selectSlotTab,
      onPromoteToHangarTab: handleDropTab,
      onCrossInstanceMerge: applyTerminalMergeLayout,
      onSessionChange: () => renderAll(),
    };
    const renderSlots = (topId, bottomId) => {
      ns.renderTerminalSlots?.({
        topTermEl: els.terminalTopView,
        bottomTermEl: els.terminalBottomView,
        topSlotId: topId,
        bottomSlotId: bottomId,
        ...termProps,
      });
      ns.renderSideChatSlot?.({
        viewportEl: els.mainViewport,
        topSlotId: topId,
        bottomSlotId: bottomId,
        splitEnabled: Boolean(state.layout.splitViewEnabled),
        conversationId: hangarConversationId,
      });
    };
    const onPreviewTerminalSlot = (previewTabId, pane) => {
      if (!previewTabId) {
        renderAll();
        return;
      }
      const isBottom = pane === 'bottom' && state.layout.splitViewEnabled;
      const slotCls = isBottom ? 'slot-bottom' : 'slot-top';
      if (previewTabId === (isBottom ? topSlotId : state.bottomActiveTabId)) return;
      if (els.storeView?.classList.contains(slotCls)) els.storeView.classList.add('hidden');
      (isBottom ? els.emptyDeckState : els.emptyTopState)?.classList.add('hidden');
      document.querySelectorAll(`.child-sidecar-frame.visible.${slotCls}`).forEach((f) => f.classList.remove('visible'));
      renderSlots(isBottom ? topSlotId : previewTabId, isBottom ? previewTabId : state.bottomActiveTabId);
    };
    ns.bindHangarChromeDropZone?.({ onPreviewTerminalSlot });
    ns.renderTabBar?.({
      tabStripEl: els.tabStrip,
      topOverflowBtnEl: els.topOverflowBtn,
      bottomTabBarEl: els.bottomTabBar,
      bottomTabStripEl: els.bottomTabStrip,
      bottomOverflowBtnEl: els.bottomOverflowBtn,
      tabOverflowPopoverEl: els.tabOverflowPopover,
      terminalBtnEl: els.terminalToggleBtn,
      extensionsBtnEl: els.extensionsToggleBtn,
      splitBtnEl: els.splitToggleBtn,
      sidecars: state.sidecars,
      terminals: visibleTerminals,
      registryPackages: state.registryPackages,
      plugins: state.plugins,
      hangar: state.hangar,
      bottomActiveTabId: state.bottomActiveTabId,
      layout: state.layout,
      hasActiveWorkspace: Boolean(state.activeWorkspace?.workspacePath),
      onSelectTopSplitTab: (id) => selectSlotTab(id, 'top'),
      onSelectBottomSplitTab: (id) => selectSlotTab(id, 'bottom'),
      onDropTab: handleDropTab,
      onPreviewTerminalSlot,
      onContextAction: handleTabContextAction,
      onDropIntoTerminal: handleDropIntoTerminal,
    });
    renderSlots(topSlotId, state.bottomActiveTabId);
    const extVisible = state.layout.splitViewEnabled
      ? (state.bottomActiveTabId === ns.EXTENSIONS_TAB_ID || activeTopId === ns.EXTENSIONS_TAB_ID)
      : activeSingleId === ns.EXTENSIONS_TAB_ID;
    if (extVisible) {
      const extActions = ns.createExtensionsActions?.({
        state,
        apiCall: ns.apiCall,
        bumpLayoutSeq,
        saveLayoutUpdate,
        reopenClosed,
        refreshRegistry,
        refreshHangarState,
        renderAll,
      }) || {};
      ns.renderExtensionsTab?.({
        storeViewEl: els.storeView,
        sidecars: state.sidecars,
        plugins: state.plugins,
        pluginDiagnostics: state.pluginDiagnostics,
        suggestions: state.suggestions,
        registryPackages: state.registryPackages,
        hangar: state.hangar,
        layout: state.layout,
        activeWorkspace: state.activeWorkspace,
        ...extActions,
      });
    }
  }

  let lastStateRefreshAt = 0;
  let stateRefresh = null;
  let stateRefreshAgain = false;
  let knownBootId = '';

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
    if (ns.isPointerOnTab || ns.activeTermDrag || state.isResizingSplit) return;
    const seq = layoutSeq;
    lastStateRefreshAt = Date.now();
    try {
      const data = await ns.apiCall('/api/state', {
        workspaceUris: state.workspaceUris,
        conversationId: hangarConversationId,
      });
      if (data.bootId) {
        if (knownBootId && knownBootId !== data.bootId) {
          window.location?.reload?.();
          return;
        }
        knownBootId = data.bootId;
      }
      if (ns.isPointerOnTab || ns.activeTermDrag || state.isResizingSplit) return;
      if (data.theme) ns.applyThemePayload?.(data.theme, false);
      const prevWsKey = getWsStateKey();
      const userTabDuringBoot = !prevWsKey && (seq !== layoutSeq || layoutSeq > 0) ? state.layout.pinnedTopSidecarId : '';
      if (
        data.activeWorkspace &&
        (data.activeWorkspace.workspacePath ||
          !state.activeWorkspace?.workspacePath ||
          data.activeWorkspace.workspaceName !== 'Detecting...')
      ) {
        state.activeWorkspace = data.activeWorkspace;
      }
      const nextWsKey = getWsStateKey();
      const wsChanged = Boolean(prevWsKey !== nextWsKey && (prevWsKey || nextWsKey));
      const wsFirstResolved = Boolean(!prevWsKey && nextWsKey);
      if (wsChanged) {
        lastNonExtTabId = '';
        state.bottomActiveTabId = '';
      }
      if (data.hangar) state.hangar = data.hangar;
      state.sidecars = data.sidecars || [];
      const incomingTerms = data.terminals || [];
      state.terminals = (seq === layoutSeq || wsChanged)
        ? incomingTerms
        : [
          ...incomingTerms,
          ...state.terminals.filter(
            (t) => t?.terminalId && !incomingTerms.some((x) => x.terminalId === t.terminalId) && !ns.isTerminalClosing?.(t.terminalId),
          ),
        ];
      Object.assign(state, {
        plugins: data.plugins || [],
        pluginDiagnostics: data.pluginDiagnostics || [],
        suggestions: data.suggestions || [],
      });
      const wsPath = state.activeWorkspace?.workspacePath || '';
      const targetLayout = (data.layout && (seq === layoutSeq || wsChanged || wsFirstResolved))
        ? applyWorkspaceLayout(data.layout, nextWsKey)
        : state.layout;
      if (wsFirstResolved && userTabDuringBoot) {
        targetLayout.pinnedTopSidecarId = userTabDuringBoot;
        if (userTabDuringBoot === ns.SIDECHAT_TAB_ID && Array.isArray(targetLayout.closedTabIds)) {
          targetLayout.closedTabIds = targetLayout.closedTabIds.filter((id) => id !== ns.SIDECHAT_TAB_ID);
        }
      }
      ns.hydrateTerminalStateFromLayout?.(targetLayout, state.terminals, wsPath, hangarConversationId);
      ns.hydrateSideChatStateFromLayout?.(targetLayout, wsPath, hangarConversationId);
      if (wsFirstResolved && userTabDuringBoot) {
        rememberWindowActiveTab(userTabDuringBoot, nextWsKey);
      }
      if (targetLayout !== state.layout) {
        state.layout = withWindowActiveTab(targetLayout, nextWsKey);
      }
      renderAll();
    } catch (err) {
      console.error('[hangar] Failed to refresh state:', err);
    }
  }

  window.addEventListener('resize', () => {
    if (state.layout?.splitViewEnabled && !state.isResizingSplit && els.mainViewport) {
      els.mainViewport.style.setProperty('--split-top-height', `${ns.clampSplitHeight(state.layout.pinnedTopHeightPx)}px`);
    }
  });
  if (els.splitResizeHandle && els.mainViewport) {
    let startY = 0;
    let startH = 185;
    window.AgyUI?.bindSplitResize?.(els.splitResizeHandle, {
      direction: 'vertical',
      containerEl: () => els.mainViewport,
      minRatio: 0.1,
      maxRatio: 0.85,
      onResizeStart: (e) => {
        state.isResizingSplit = true;
        startY = e?.clientY || 0;
        const topEl = els.mainViewport.querySelector('.slot-top.visible, .slot-top:not(.hidden)');
        startH = topEl?.getBoundingClientRect().height || state.layout.pinnedTopHeightPx || 185;
      },
      onResize: (_r, e) => {
        state.isResizingSplit = true;
        state.layout.pinnedTopHeightPx = ns.clampSplitHeight(startH + ((e?.clientY || 0) - startY));
        els.mainViewport.style.setProperty('--split-top-height', `${state.layout.pinnedTopHeightPx}px`);
      },
      onResizeEnd: async () => {
        state.isResizingSplit = false;
        await saveLayoutUpdate({ pinnedTopHeightPx: state.layout.pinnedTopHeightPx });
      },
    });
  }
  ns.bindHangarChromeDropZone?.({
    chromeBarEl: byId('chrome-bar'),
    bottomBarEl: els.bottomTabBar,
    onPromoteToHangarTab: handleDropTab,
    onMergeIntoTerminalTab: applyTerminalMergeLayout,
  });
  ns.setTerminalPersistCallback?.((terminalState) => {
    ++layoutSeq;
    state.layout.terminalState = terminalState;
    saveLayoutUpdate({ terminalState });
  });
  ns.setSideChatDockCallback?.(handleSideChatDock);
  const toggleTopChromeBtn = (targetTabId) => async () => {
    if (targetTabId === ns.TERMINAL_TAB_ID && (ns.getInstanceTerminals?.(state.terminals, '') || []).length === 0) {
      await handleTabContextAction({ action: 'new-terminal', pane: 'top' });
      return;
    }
    ++layoutSeq;
    if (targetTabId === ns.TERMINAL_TAB_ID) ns.setMainTerminalOpen?.(true);
    const { workspaceTabs, topTabs, activeSingleId, activeTopId } = ns.partitionSplitTabs(
      state.sidecars,
      state.layout,
      state.terminals,
    );
    const curTopId = state.layout.splitViewEnabled ? activeTopId : activeSingleId;
    const pool = state.layout.splitViewEnabled ? topTabs : workspaceTabs;
    const nextId = curTopId === targetTabId
      ? (pool.find((t) => t.sidecarId === lastNonExtTabId)?.sidecarId || pool[0]?.sidecarId || '')
      : targetTabId;
    state.layout.pinnedTopSidecarId = nextId;
    renderAll();
    await saveLayoutUpdate({ pinnedTopSidecarId: nextId });
  };
  els.terminalToggleBtn?.addEventListener('click', toggleTopChromeBtn(ns.TERMINAL_TAB_ID));
  els.extensionsToggleBtn?.addEventListener('click', toggleTopChromeBtn(ns.EXTENSIONS_TAB_ID));
  els.splitToggleBtn?.addEventListener('click', async () => {
    ++layoutSeq;
    const nextSplit = !state.layout.splitViewEnabled;
    const { activeSingleId, activeTopId, topSet } = ns.partitionSplitTabs(state.sidecars, state.layout, state.terminals);
    const patch = { splitViewEnabled: nextSplit };
    if (nextSplit && activeSingleId && !topSet.has(activeSingleId)) {
      topSet.add(activeSingleId);
      Object.assign(patch, { topSplitTabIds: [...topSet], pinnedTopSidecarId: activeSingleId });
    } else if (!nextSplit && activeTopId) {
      patch.pinnedTopSidecarId = activeTopId;
    }
    Object.assign(state.layout, patch);
    rememberWindowActiveTab(patch.pinnedTopSidecarId);
    await saveLayoutUpdate(patch);
    await refreshHangarState();
  });

  let lastFocusedSlot = 'top';
  const resolveElementSlot = (node) => {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el || typeof el.closest !== 'function') return '';
    if (el.closest('#bottom-tab-bar, #terminal-bottom-view, #empty-deck-state, .slot-bottom')) return 'bottom';
    if (el.closest('#chrome-bar, #terminal-top-view, #empty-top-state, .slot-top')) return 'top';
    return '';
  };
  const resolveWindowSlot = (sourceWin) => {
    if (!sourceWin) return '';
    for (const frame of document.querySelectorAll?.('iframe') || []) {
      if (frame.contentWindow === sourceWin) {
        return resolveElementSlot(frame);
      }
    }
    return '';
  };
  ['pointerdown', 'focusin'].forEach((ev) => {
    document.addEventListener?.(
      ev,
      (e) => {
        const slot = resolveElementSlot(e.target);
        if (slot) lastFocusedSlot = slot;
      },
      true,
    );
  });
  window.addEventListener?.('blur', () => {
    const slot = resolveElementSlot(document.activeElement);
    if (slot) lastFocusedSlot = slot;
  });
  window.addEventListener?.('message', (e) => {
    if (e?.data?.type === 'hangar-jetbox-pane-focused') {
      const slot = resolveWindowSlot(e.source);
      if (slot) lastFocusedSlot = slot;
    }
  });
  window.AgyUI?.bindGlobalTabCycleKeydown?.(
    (sourceWin) => {
      const fromWin = resolveWindowSlot(sourceWin);
      if (fromWin) lastFocusedSlot = fromWin;
      else {
        const fromActive = resolveElementSlot(document.activeElement);
        if (fromActive) lastFocusedSlot = fromActive;
      }
      if (state.layout?.splitViewEnabled && lastFocusedSlot === 'bottom' && els.bottomTabStrip) {
        return els.bottomTabStrip;
      }
      return els.tabStrip;
    },
    {
      isTrustedMessage: (e) => ns.isTrustedSidecarOrigin?.(e?.origin) !== false,
      onCycle: () => {
        const activeEl = document.activeElement;
        const isHiddenFrame =
          activeEl?.tagName === 'IFRAME' &&
          ((activeEl.classList?.contains?.('child-sidecar-frame') && !activeEl.classList?.contains?.('visible')) ||
            Boolean(activeEl.closest?.('.hidden')));
        if (isHiddenFrame) activeEl.blur?.();
        window.focus?.();
      },
    },
  );
  window.sidecar?.onWorkspaceChange?.((uris) => {
    state.workspaceUris = Array.isArray(uris) ? uris : [];
    refreshHangarState();
  });
  const VISIBLE_POLL_MS = 3000;
  const HIDDEN_POLL_MS = 60 * 1000;
  let inViewport = true;
  const isHidden = () => Boolean(document.hidden || !inViewport);
  ns.isHostHidden = isHidden;
  const syncHostVisibility = () => {
    ns.syncDeckVisibility?.();
    ns.syncSideChatVisibility?.();
    ns.syncTerminalVisibility?.();
    if (!isHidden()) refreshHangarState();
  };
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver((entries) => {
      const next = entries[entries.length - 1].isIntersecting;
      if (next === inViewport) return;
      inViewport = next;
      syncHostVisibility();
    }).observe(document.documentElement);
  }
  document.addEventListener('visibilitychange', syncHostVisibility);
  refreshRegistry();
  refreshHangarState();
  ns.subscribeStateSyncEvents?.({
    getConversationId: () => hangarConversationId,
    onStateEvent: () => {
      if (!isHidden()) refreshHangarState();
    },
  });
  setInterval(() => {
    const interval = isHidden() ? HIDDEN_POLL_MS : VISIBLE_POLL_MS;
    if (!stateRefresh && Date.now() - lastStateRefreshAt >= interval) {
      refreshHangarState();
    }
  }, VISIBLE_POLL_MS);
  setInterval(() => {
    if (!isHidden()) refreshRegistry();
  }, 15 * 60 * 1000);
})();
