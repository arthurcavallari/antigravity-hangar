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
    featuredIds: [],
    registryPackages: [],
    bottomActiveTabId: '',
    isResizingSplit: false,
  };
  ns.getActiveWorkspacePath = () => state.activeWorkspace?.workspacePath || state.workspaceUris?.[0] || '';
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

  const VALID_EXT_SUBTABS = new Set(['installed', 'discover', 'sideload', 'settings']);
  const RESERVED_QUERY_KEYS = new Set(['token', 'entrypoint', 'conversationId', 'urlSync', 'initSubpath']);
  function fallbackSanitizeSubpath(raw) {
    if (typeof raw !== 'string' || raw.length > 8192 || /[?#\\\x00-\x1f\x7f]/.test(raw)) return undefined;
    const trimmed = raw.replace(/^\/+|\/+$/g, '');
    if (!trimmed) return '';
    for (const seg of trimmed.split('/')) {
      if (!seg || seg === '.' || seg === '..') return undefined;
      let dec = '';
      try {
        dec = decodeURIComponent(seg);
      } catch {
        return undefined;
      }
      if (/[\\\x00-\x1f\x7f]/.test(dec)) return undefined;
      if (dec.split('/').some((s) => s === '.' || s === '..')) return undefined;
      const qRaw = seg.startsWith('~q=')
        ? seg.slice(3).replace(/%2F/gi, '/').replace(/%25/g, '%')
        : (dec.startsWith('~q=') ? dec.slice(3) : '');
      if (qRaw && Array.from(new URLSearchParams(qRaw).keys()).some((k) => RESERVED_QUERY_KEYS.has(k))) {
        return undefined;
      }
    }
    return trimmed;
  }
  const sanitizeSubpath = (raw) => {
    const fn = window.AgyShell?.sanitizeSyncSubpath || ns.sanitizeSyncSubpath || fallbackSanitizeSubpath;
    return fn(raw);
  };
  ns.encodeHangarSubpath = function encodeHangarSubpath(activeTabId, extSubTab) {
    if (typeof activeTabId !== 'string') return '';
    const termId = ns.TERMINAL_TAB_ID || '__terminal__';
    const scId = ns.SIDECHAT_TAB_ID || '__sidechat__';
    const extId = ns.EXTENSIONS_TAB_ID || '__extensions__';
    const trimmed = activeTabId.trim();
    const id = ns.normalizeLegacySideChatTabId ? ns.normalizeLegacySideChatTabId(trimmed) : trimmed;
    if (!id) return '';
    if (id === termId) return 'terminal';
    if (id.startsWith('terminal__')) {
      const tid = id.slice('terminal__'.length).trim();
      if (!tid) return '';
      return sanitizeSubpath(`terminal/${encodeURIComponent(tid)}`) ?? '';
    }
    if (id === scId) return 'sidechat';
    if (id === extId) {
      return extSubTab && extSubTab !== 'installed' && VALID_EXT_SUBTABS.has(extSubTab)
        ? `extensions/${extSubTab}`
        : 'extensions';
    }
    if (id.startsWith('/') || id.endsWith('/') || id.includes('//')) return '';
    return sanitizeSubpath(`tab/${encodeURIComponent(id)}`) ?? '';
  };
  ns.decodeHangarSubpath = function decodeHangarSubpath(subpath) {
    const clean = sanitizeSubpath(subpath);
    if (!clean) return null;
    const parts = clean.split('/');
    const termId = ns.TERMINAL_TAB_ID || '__terminal__';
    const scId = ns.SIDECHAT_TAB_ID || '__sidechat__';
    const extId = ns.EXTENSIONS_TAB_ID || '__extensions__';
    if (parts[0] === 'terminal') {
      if (parts.length === 1) return { activeTabId: termId };
      if (parts.length !== 2) return null;
      let tid = '';
      try {
        tid = decodeURIComponent(parts[1]);
      } catch {
        return null;
      }
      return tid.trim() ? { activeTabId: `terminal__${tid}` } : null;
    }
    if (parts[0] === 'sidechat') {
      return parts.length === 1 ? { activeTabId: scId } : null;
    }
    if (parts[0] === 'extensions') {
      if (parts.length === 1) return { activeTabId: extId, extSubTab: 'installed' };
      if (parts.length === 2 && VALID_EXT_SUBTABS.has(parts[1])) {
        return { activeTabId: extId, extSubTab: parts[1] };
      }
      return null;
    }
    if (parts[0] === 'tab') {
      if (parts.length !== 2) return null;
      let id = '';
      try {
        id = decodeURIComponent(parts[1]);
      } catch {
        return null;
      }
      if (!id.trim() || id.startsWith('/') || id.endsWith('/') || id.includes('//')) return null;
      return { activeTabId: id };
    }
    return null;
  };

  let urlForcedTabId = '';
  let didInitialUrlSync = false;
  let lastSyncedSubpath = '';
  let isBootRender = false;
  let applyingHostSubpath = false;
  let isHydratingState = false;
  let hasHydratedState = false;
  let pendingWsReplaceSync = false;
  let didInitialWorkspaceHydrate = false;

  async function refreshRegistry() {
    try {
      const reg = await ns.apiCall?.('/api/store/registry', {});
      if (Array.isArray(reg?.packages)) state.registryPackages = reg.packages;
      if (Array.isArray(reg?.featuredIds)) state.featuredIds = reg.featuredIds;
      if (reg?.hangar) state.hangar = reg.hangar;
      isHydratingState = true;
      try {
        renderAll();
      } finally {
        isHydratingState = false;
      }
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
    openSidecar,
    reopenClosed,
  } = layoutCtrl;

  function ensureRouteTabOpen(tabId, layoutObj = state.layout) {
    if (!tabId || !layoutObj) return;
    if (Array.isArray(layoutObj.closedTabIds) && layoutObj.closedTabIds.includes(tabId)) {
      layoutObj.closedTabIds = layoutObj.closedTabIds.filter((id) => id !== tabId);
    }
    const routeSc = (state.sidecars || []).find((s) => s.sidecarId === tabId);
    if (routeSc && !routeSc.matchesWorkspace) {
      layoutObj.openTabIds = [...new Set([...(layoutObj.openTabIds || []), tabId])];
    }
    if (layoutObj.splitViewEnabled && Array.isArray(layoutObj.topSplitTabIds) && !layoutObj.topSplitTabIds.includes(tabId)) {
      layoutObj.topSplitTabIds = [...layoutObj.topSplitTabIds, tabId];
    }
    if (tabId === ns.TERMINAL_TAB_ID) {
      ns.setMainTerminalOpen?.(true);
    } else if (tabId.startsWith('terminal__')) {
      const tid = tabId.slice('terminal__'.length);
      if (
        tid &&
        state.terminals.some((t) => t?.terminalId === tid) &&
        ns.getPoppedTerminalIds &&
        ns.setPoppedTerminalIds &&
        !ns.getPoppedTerminalIds().has(tid)
      ) {
        ns.setPoppedTerminalIds(new Set([...ns.getPoppedTerminalIds(), tid]));
      }
    } else if (tabId === ns.SIDECHAT_TAB_ID && ns._sc) {
      ns._sc.isOpen = true;
    }
  }

  function applyDecodedRoute(route) {
    if (!route?.activeTabId) return false;
    if (route.activeTabId === ns.EXTENSIONS_TAB_ID) {
      ns.setExtensionsSubTab?.(route.extSubTab || 'installed');
    }
    urlForcedTabId = route.activeTabId;
    ensureRouteTabOpen(route.activeTabId, state.layout);
    state.layout.pinnedTopSidecarId = route.activeTabId;
    rememberWindowActiveTab(route.activeTabId);
    return true;
  }

  function handleHostSubpathChange(subpath) {
    const route = ns.decodeHangarSubpath(subpath);
    if (!route) {
      lastSyncedSubpath = subpath;
      return;
    }
    lastSyncedSubpath = ns.encodeHangarSubpath(route.activeTabId, route.extSubTab) || subpath;
    applyingHostSubpath = true;
    try {
      applyDecodedRoute(route);
      didInitialUrlSync = true;
      renderAll();
    } finally {
      applyingHostSubpath = false;
    }
  }

  const createUrlSync = window.AgyShell?.createUrlSyncBridge || ns.createUrlSyncBridge;
  const urlSync = typeof createUrlSync === 'function'
    ? createUrlSync({ onSubpathChange: handleHostSubpathChange })
    : {
        enabled: false,
        getInitialSubpath: () => '',
        pushSubpath: () => false,
        stepHistory: () => false,
        destroy: () => {},
      };

  function syncUrlSubpath(activeTabId, { replace = false } = {}) {
    if (!urlSync.enabled || isBootRender || applyingHostSubpath) return;
    const nextSubpath = ns.encodeHangarSubpath(activeTabId, ns.getExtensionsSubTab?.());
    if (!nextSubpath || nextSubpath === lastSyncedSubpath) return;
    lastSyncedSubpath = nextSubpath;
    didInitialUrlSync = true;
    urlSync.pushSubpath(nextSubpath, { replace });
  }

  function renderAll() {
    ns.setHideHangarSideQuestions?.(state.layout?.hideHangarSideQuestions === true);
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
          const effConvId = state.activeWorkspace?.conversationId || (hangarConversationId !== '_new' ? hangarConversationId : '');
          ns.openTerminalQuoteComposer?.(
            els.mainViewport,
            {},
            { conversationId: effConvId, skipActivate: true },
          );
        }
      }
      if (slotKey === 'bottom' && state.layout.splitViewEnabled) {
        state.bottomActiveTabId = tabId;
      } else {
        urlForcedTabId = '';
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
        conversationId: state.activeWorkspace?.conversationId || (hangarConversationId !== '_new' ? hangarConversationId : ''),
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
    const effectiveTopId = topSlotId || state.layout.pinnedTopSidecarId;
    const handleExtSubTabChange = () => {
      if ((topSlotId || state.layout.pinnedTopSidecarId) === ns.EXTENSIONS_TAB_ID && !isHydratingState) {
        syncUrlSubpath(ns.EXTENSIONS_TAB_ID, { replace: false });
      }
    };
    const extVisible = state.layout.splitViewEnabled
      ? (state.bottomActiveTabId === ns.EXTENSIONS_TAB_ID || activeTopId === ns.EXTENSIONS_TAB_ID)
      : activeSingleId === ns.EXTENSIONS_TAB_ID;
    if (extVisible) {
      const extActions = ns.createExtensionsActions?.({
        state,
        apiCall: ns.apiCall,
        bumpLayoutSeq,
        saveLayoutUpdate,
        openSidecar,
        handleTabContextAction,
        reopenClosed,
        refreshRegistry,
        refreshHangarState,
        renderAll,
        onSubTabChange: handleExtSubTabChange,
      }) || {};
      ns.renderExtensionsTab?.({
        storeViewEl: els.storeView,
        sidecars: state.sidecars,
        plugins: state.plugins,
        pluginDiagnostics: state.pluginDiagnostics,
        suggestions: state.suggestions,
        featuredIds: state.featuredIds,
        registryPackages: state.registryPackages,
        hangar: state.hangar,
        layout: state.layout,
        activeWorkspace: state.activeWorkspace,
        onSubTabChange: handleExtSubTabChange,
        ...extActions,
      });
    }
    const wsHydrated = hasHydratedState && Boolean(getWsStateKey() || !window.sidecar?.onWorkspaceChange || didInitialWorkspaceHydrate);
    let reconciledStaleHydration = false;
    if (!isBootRender && urlForcedTabId) {
      if (applyingHostSubpath || isHydratingState) {
        if (wsHydrated && effectiveTopId && effectiveTopId !== urlForcedTabId) {
          urlForcedTabId = '';
          state.layout.pinnedTopSidecarId = effectiveTopId;
          rememberWindowActiveTab(effectiveTopId);
          if (applyingHostSubpath) {
            lastSyncedSubpath = ns.encodeHangarSubpath(effectiveTopId, ns.getExtensionsSubTab?.()) || lastSyncedSubpath;
          } else {
            reconciledStaleHydration = true;
          }
        }
      } else if (effectiveTopId !== urlForcedTabId || state.layout.closedTabIds?.includes(urlForcedTabId)) {
        urlForcedTabId = '';
      }
    }
    if (urlSync.enabled && !isBootRender && !applyingHostSubpath) {
      if (isHydratingState) {
        if (reconciledStaleHydration || (hasHydratedState && (!didInitialUrlSync || pendingWsReplaceSync))) {
          pendingWsReplaceSync = false;
          syncUrlSubpath(effectiveTopId, { replace: true });
        }
      } else {
        syncUrlSubpath(effectiveTopId, { replace: false });
      }
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
      if (wsChanged && !wsFirstResolved) {
        urlForcedTabId = '';
        pendingWsReplaceSync = true;
      } else if (wsFirstResolved && !urlForcedTabId && !userTabDuringBoot) {
        pendingWsReplaceSync = true;
      }
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
      const activeOverrideTabId = urlForcedTabId || (wsFirstResolved ? userTabDuringBoot : '');
      if (activeOverrideTabId) {
        targetLayout.pinnedTopSidecarId = activeOverrideTabId;
        ensureRouteTabOpen(activeOverrideTabId, targetLayout);
      }
      const effHydrateConvId = state.activeWorkspace?.conversationId || hangarConversationId;
      ns.setHideHangarSideQuestions?.(targetLayout?.hideHangarSideQuestions === true);
      ns.hydrateTerminalStateFromLayout?.(targetLayout, state.terminals, wsPath, effHydrateConvId);
      ns.hydrateSideChatStateFromLayout?.(targetLayout, wsPath, effHydrateConvId);
      const scSynced = Boolean(
        (data.nativeSideQuestions || data.sideQuestionMeta || targetLayout?.showExternalSideQuestions === false) &&
          ns.syncNativeSideQuestions?.(data.nativeSideQuestions, targetLayout, data.sideQuestionMeta),
      );
      if (activeOverrideTabId) {
        ensureRouteTabOpen(activeOverrideTabId, targetLayout);
        rememberWindowActiveTab(activeOverrideTabId, nextWsKey);
      }
      if (targetLayout !== state.layout) {
        state.layout = withWindowActiveTab(targetLayout, nextWsKey);
      } else if (scSynced && !ns.getSideChatState?.()?.isOpen && state.layout.pinnedTopSidecarId === ns.SIDECHAT_TAB_ID) {
        state.layout = withWindowActiveTab(state.layout, nextWsKey);
      }
      if (activeOverrideTabId) {
        state.layout.pinnedTopSidecarId = activeOverrideTabId;
        ensureRouteTabOpen(activeOverrideTabId, state.layout);
      }
      if (scSynced) {
        const scPatch = buildSideChatLayoutPatch();
        saveLayoutUpdate(scPatch);
        document.querySelector?.('.term-mini-composer')?._syncSideChatBtn?.();
      }
      hasHydratedState = true;
      isHydratingState = true;
      try {
        renderAll();
      } finally {
        isHydratingState = false;
      }
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
    urlForcedTabId = '';
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
    urlForcedTabId = '';
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
    didInitialWorkspaceHydrate = true;
    state.workspaceUris = Array.isArray(uris) ? uris : [];
    refreshHangarState();
  });
  const VISIBLE_POLL_MS = 3000;
  const HIDDEN_POLL_MS = 60 * 1000;
  let hostVisible = true;
  let inViewport = true;
  const isHidden = () => Boolean(document.hidden || !inViewport || !hostVisible);
  ns.isHostHidden = isHidden;
  const syncHostVisibility = () => {
    ns.syncDeckVisibility?.();
    ns.syncSideChatVisibility?.();
    ns.syncTerminalVisibility?.();
    if (!isHidden()) refreshHangarState();
  };
  window.addEventListener?.('message', (e) => {
    if (e?.data?.type !== 'sidecar-visibility') return;
    if (ns.isHostMessage && !ns.isHostMessage(e.source)) return;
    const raw = e.data.payload?.visible ?? e.data.visible;
    if (typeof raw !== 'boolean' || raw === hostVisible) return;
    hostVisible = raw;
    syncHostVisibility();
  });
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver((entries) => {
      const next = entries[entries.length - 1].isIntersecting;
      if (next === inViewport) return;
      inViewport = next;
      syncHostVisibility();
    }).observe(document.documentElement);
  }
  document.addEventListener('visibilitychange', syncHostVisibility);
  if (urlSync.enabled) {
    const handledHistoryEvents = new WeakSet();
    const isEditableTarget = (node) => {
      const el = node?.nodeType === 1 ? node : node?.parentElement || node;
      if (!el) return false;
      const tag = String(el.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable || el.contentEditable === 'true') return true;
      return typeof el.closest === 'function'
        && Boolean(el.closest('input, textarea, select, [contenteditable="true"]'));
    };
    const onHistoryKeydown = (e) => {
      if (!e || e.defaultPrevented || handledHistoryEvents.has(e)) return;
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.getModifierState?.('AltGraph')) return;
      const delta = e.key === 'ArrowLeft' ? -1 : (e.key === 'ArrowRight' ? 1 : 0);
      if (!delta) return;
      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;
      handledHistoryEvents.add(e);
      e.preventDefault?.();
      urlSync.stepHistory(delta);
    };
    document.addEventListener?.('keydown', onHistoryKeydown);
    window.addEventListener?.('keydown', onHistoryKeydown);
    const rawInit = urlSync.getInitialSubpath();
    const initRoute = rawInit ? ns.decodeHangarSubpath(rawInit) : null;
    if (initRoute) {
      lastSyncedSubpath = ns.encodeHangarSubpath(initRoute.activeTabId, initRoute.extSubTab) || rawInit;
      didInitialUrlSync = true;
      isBootRender = true;
      try {
        applyDecodedRoute(initRoute);
        renderAll();
      } finally {
        isBootRender = false;
      }
    }
  }
  refreshRegistry();
  if (typeof window.sidecar?.getWorkspaceUris === 'function') {
    Promise.resolve(window.sidecar.getWorkspaceUris())
      .catch(() => null)
      .then((uris) => {
        if (!didInitialWorkspaceHydrate) {
          didInitialWorkspaceHydrate = true;
          if (Array.isArray(uris)) state.workspaceUris = uris;
          refreshHangarState();
        }
      });
  } else {
    refreshHangarState();
  }
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
