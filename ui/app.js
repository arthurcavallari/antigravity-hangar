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
    workspaceUris: [], activeWorkspace: { workspacePath: '', workspaceName: 'Detecting...' },
    // Empty until the first /api/state, so a render before then doesn't claim a tab for this window
    layout: { pinnedTopSidecarId: '', pinnedTopHeightPx: 185, splitViewEnabled: false },
    hangar: null, sidecars: [], terminals: [], plugins: [], suggestions: [], registryPackages: [],
    activeTabId: '', bottomActiveTabId: '', isResizingSplit: false,
  };

  const els = {
    tabStrip: document.getElementById('tab-strip'), topOverflowBtn: document.getElementById('top-overflow-btn'),
    bottomTabBar: document.getElementById('bottom-tab-bar'), bottomTabStrip: document.getElementById('bottom-tab-strip'),
    bottomOverflowBtn: document.getElementById('bottom-overflow-btn'), tabOverflowPopover: document.getElementById('tab-overflow-popover'),
    terminalToggleBtn: document.getElementById('terminal-toggle-btn'), extensionsToggleBtn: document.getElementById('extensions-toggle-btn'), splitToggleBtn: document.getElementById('split-toggle-btn'), splitDividerGroup: document.getElementById('split-divider-group'),
    splitResizeHandle: document.getElementById('split-resize-handle'), mainViewport: document.getElementById('main-viewport'),
    emptyTopState: document.getElementById('empty-top-state'), emptyDeckState: document.getElementById('empty-deck-state'),
    storeView: document.getElementById('store-view'), terminalTopView: document.getElementById('terminal-top-view'),
    terminalBottomView: document.getElementById('terminal-bottom-view'),
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

  // The active tab belongs to this project/window: hangar.json is shared by every Antigravity window, so
  // per-workspace layout and per-workspace sessionStorage keep tab selection isolated across projects.
  const ACTIVE_TAB_KEY = 'hangar.activeTabId';
  const WS_LAYOUT_DEFAULTS = { pinnedTopSidecarId: 'context-monitor', topSplitTabIds: ['context-monitor'], tabOrder: [], closedTabIds: [], pinnedTabIds: [], splitViewEnabled: false };
  const WS_LAYOUT_KEYS = Object.keys(WS_LAYOUT_DEFAULTS);
  let layoutSeq = 0, lastNonExtTabId = '', lastRenderedSingleIds = [], lastRenderedTopIds = [], lastRenderedBottomIds = [];
  function pickNextTabAfterClose(beforeList = [], afterList = [], curActiveId = '', removedIds = []) {
    const beforeIds = beforeList.map((t) => (typeof t === 'string' ? t : t.sidecarId)).filter(Boolean);
    const afterIds = afterList.map((t) => (typeof t === 'string' ? t : t.sidecarId)).filter(Boolean);
    if (!afterIds.length) return '';
    const afterSet = new Set(afterIds), rmSet = new Set(removedIds);
    if (curActiveId && afterSet.has(curActiveId) && !rmSet.has(curActiveId)) return curActiveId;
    const pivot = (curActiveId && beforeIds.includes(curActiveId)) ? curActiveId : beforeIds.find((id) => rmSet.has(id) || !afterSet.has(id));
    const idx = pivot ? beforeIds.indexOf(pivot) : -1;
    if (idx >= 0) return beforeIds.slice(idx + 1).find((id) => afterSet.has(id)) || afterIds[afterIds.length - 1] || '';
    return afterIds[0] || '';
  }
  const getWsStateKey = (wsPath = state.activeWorkspace?.workspacePath) => String(wsPath || '').trim().replace(/\\/g, '/').toLowerCase();
  const getActiveTabStorageKey = (wsKey = getWsStateKey()) => (wsKey ? `${ACTIVE_TAB_KEY}:${wsKey}` : (hangarConversationId ? `${ACTIVE_TAB_KEY}:conv:${hangarConversationId}` : ACTIVE_TAB_KEY));
  const buildSideChatLayoutPatch = (scStateObj) => {
    const sideChatState = scStateObj || ns.serializeSideChatState?.();
    const wsKey = getWsStateKey();
    const sideChatStateByWorkspace = { ...(state.layout.sideChatStateByWorkspace || {}) };
    if (wsKey) sideChatStateByWorkspace[wsKey] = sideChatState;
    state.layout.sideChatState = sideChatState;
    state.layout.sideChatStateByWorkspace = sideChatStateByWorkspace;
    return { sideChatState, sideChatStateByWorkspace };
  };
  function saveLayoutUpdate(patch = {}) {
    const wsKey = getWsStateKey();
    let finalPatch = { ...patch };
    if (wsKey && WS_LAYOUT_KEYS.some((k) => patch[k] !== undefined)) {
      const prevMap = state.layout.workspaceLayouts && typeof state.layout.workspaceLayouts === 'object' ? state.layout.workspaceLayouts : {};
      const prevWs = prevMap[wsKey] && typeof prevMap[wsKey] === 'object' ? prevMap[wsKey] : {};
      const wsEntryPatch = {};
      for (const k of WS_LAYOUT_KEYS) if (patch[k] !== undefined) wsEntryPatch[k] = patch[k];
      const nextWs = {
        ...WS_LAYOUT_DEFAULTS,
        pinnedTopSidecarId: state.layout.pinnedTopSidecarId || 'context-monitor',
        topSplitTabIds: Array.isArray(state.layout.topSplitTabIds) ? state.layout.topSplitTabIds : ['context-monitor'],
        tabOrder: Array.isArray(state.layout.tabOrder) ? state.layout.tabOrder : [],
        closedTabIds: Array.isArray(state.layout.closedTabIds) ? state.layout.closedTabIds : [],
        pinnedTabIds: Array.isArray(state.layout.pinnedTabIds) ? state.layout.pinnedTabIds : [],
        splitViewEnabled: Boolean(state.layout.splitViewEnabled),
        ...prevWs,
        ...wsEntryPatch,
      };
      const workspaceLayouts = { ...prevMap, [wsKey]: nextWs };
      state.layout.workspaceLayouts = workspaceLayouts;
      finalPatch = { ...finalPatch, workspaceLayouts };
    }
    return ns.apiCall?.('/api/layout/update', finalPatch);
  }
  const isTabValidForWindow = (id) => Boolean(
    id
    && (id !== ns.SIDECHAT_TAB_ID || ns.getSideChatState?.()?.isOpen)
    && (!String(id).startsWith(ns.SIDECHAT_TAB_PREFIX || 'sidechat__') || ns.getPoppedSideChatIds?.()?.has(String(id).slice((ns.SIDECHAT_TAB_PREFIX || 'sidechat__').length)))
    && (!String(id).startsWith(ns.TERMINAL_TAB_PREFIX || 'terminal__') || (ns.getPoppedTerminalIds?.()?.has(String(id).slice((ns.TERMINAL_TAB_PREFIX || 'terminal__').length)) && state.terminals.some((t) => t.terminalId === String(id).slice((ns.TERMINAL_TAB_PREFIX || 'terminal__').length))))
    && (id !== ns.TERMINAL_TAB_ID || ns.isMainTerminalOpen?.()),
  );
  function readWindowActiveTab(wsKey = getWsStateKey()) { try { return sessionStorage.getItem(getActiveTabStorageKey(wsKey)) || ''; } catch { return ''; } }
  function rememberWindowActiveTab(sidecarId, wsKey = getWsStateKey()) { if (!sidecarId) return; try { const k = getActiveTabStorageKey(wsKey); if (isTabValidForWindow(sidecarId)) sessionStorage.setItem(k, sidecarId); else sessionStorage.removeItem(k); } catch {} }
  function applyWorkspaceLayout(rawLayout = {}, wsKey = getWsStateKey()) {
    if (!wsKey) return { ...rawLayout };
    const wsEntry = rawLayout?.workspaceLayouts?.[wsKey];
    return wsEntry && typeof wsEntry === 'object' ? { ...rawLayout, ...WS_LAYOUT_DEFAULTS, ...wsEntry } : { ...rawLayout, ...WS_LAYOUT_DEFAULTS };
  }
  function withWindowActiveTab(layout, wsKey = getWsStateKey()) {
    const w = readWindowActiveTab(wsKey);
    if (isTabValidForWindow(w)) return { ...layout, pinnedTopSidecarId: w };
    if (layout?.pinnedTopSidecarId && !isTabValidForWindow(layout.pinnedTopSidecarId)) return { ...layout, pinnedTopSidecarId: 'context-monitor' };
    return layout;
  }

  function insertTabIntoOrder(sidecarId, { beforeTabId = '', afterTabId = '' } = {}) {
    const { workspaceTabs } = ns.partitionSplitTabs(state.sidecars, state.layout, state.terminals);
    const currentIds = workspaceTabs.map((t) => t.sidecarId), existingOrder = Array.isArray(state.layout.tabOrder) ? state.layout.tabOrder : [];
    const baseOrder = [...currentIds, ...existingOrder.filter((id) => !currentIds.includes(id))].filter((id) => id !== sidecarId);
    if (beforeTabId && baseOrder.includes(beforeTabId)) baseOrder.splice(baseOrder.indexOf(beforeTabId), 0, sidecarId);
    else if (afterTabId && baseOrder.includes(afterTabId)) baseOrder.splice(baseOrder.indexOf(afterTabId) + 1, 0, sidecarId);
    else baseOrder.push(sidecarId);
    state.layout.tabOrder = baseOrder;
  }

  async function handleDropTab({ sidecarId, replacedSidecarId, targetPane, beforeTabId, afterTabId }) {
    ++layoutSeq;
    if (replacedSidecarId?.from && replacedSidecarId?.to) {
      if (Array.isArray(state.layout.tabOrder)) state.layout.tabOrder = state.layout.tabOrder.map((id) => (id === replacedSidecarId.from ? replacedSidecarId.to : id));
      if (Array.isArray(state.layout.topSplitTabIds)) state.layout.topSplitTabIds = state.layout.topSplitTabIds.map((id) => (id === replacedSidecarId.from ? replacedSidecarId.to : id));
    }
    const { topSet } = ns.partitionSplitTabs(state.sidecars, state.layout, state.terminals);
    insertTabIntoOrder(sidecarId, { beforeTabId, afterTabId });
    if (state.layout.splitViewEnabled) {
      if (targetPane === 'top') { topSet.add(sidecarId); state.layout.pinnedTopSidecarId = sidecarId; }
      else if (targetPane === 'bottom') { topSet.delete(sidecarId); state.bottomActiveTabId = sidecarId; }
      state.layout.topSplitTabIds = [...topSet];
      state.layout.pinnedTopSidecarId = ns.partitionSplitTabs(state.sidecars, state.layout, state.terminals).activeTopId;
    } else state.layout.pinnedTopSidecarId = sidecarId;
    renderAll();
    await saveLayoutUpdate({
      tabOrder: state.layout.tabOrder,
      topSplitTabIds: state.layout.topSplitTabIds,
      pinnedTopSidecarId: state.layout.pinnedTopSidecarId,
      terminalState: ns.serializeTerminalState?.(),
      ...buildSideChatLayoutPatch(),
    });
  }

  async function applyTerminalMergeLayout({ removedSidecarId, replacedSidecarId, targetInstanceTabId, targetPane }) {
    ++layoutSeq;
    const curOrder = Array.isArray(state.layout.tabOrder) ? state.layout.tabOrder : [];
    const curTop = Array.isArray(state.layout.topSplitTabIds) ? state.layout.topSplitTabIds : (state.layout.pinnedTopSidecarId ? [state.layout.pinnedTopSidecarId] : []);
    const { from, to } = replacedSidecarId || {};
    const clean = (arr) => {
      const next = from && to ? arr.filter((id) => id !== to).map((id) => (id === from ? to : id)) : [...arr];
      return removedSidecarId && removedSidecarId !== to ? next.filter((id) => id !== removedSidecarId) : next;
    };
    state.layout.tabOrder = clean(curOrder); state.layout.topSplitTabIds = clean(curTop);
    if (targetInstanceTabId && Array.isArray(state.layout.closedTabIds)) {
      state.layout.closedTabIds = state.layout.closedTabIds.filter((id) => id !== targetInstanceTabId);
    }
    if (from && to) {
      if (state.layout.pinnedTopSidecarId === from) state.layout.pinnedTopSidecarId = to;
      if (state.bottomActiveTabId === from) state.bottomActiveTabId = to;
    }
    const { workspaceTabs, topTabs, bottomTabs, activeSingleId, activeTopId } = ns.partitionSplitTabs(state.sidecars, state.layout, state.terminals);
    const isBottom = state.layout.splitViewEnabled && targetPane === 'bottom';
    const beforeList = isBottom ? lastRenderedBottomIds : (state.layout.splitViewEnabled ? lastRenderedTopIds : lastRenderedSingleIds);
    const afterList = isBottom ? bottomTabs : (state.layout.splitViewEnabled ? topTabs : workspaceTabs);
    const curAct = isBottom ? state.bottomActiveTabId : (state.layout.pinnedTopSidecarId || removedSidecarId || '');
    const fallbackTarget = removedSidecarId
      ? pickNextTabAfterClose(beforeList, afterList, curAct, [removedSidecarId])
      : (isBottom ? (bottomTabs[0]?.sidecarId || '') : (state.layout.splitViewEnabled ? activeTopId : activeSingleId));
    const resolvedTarget = targetInstanceTabId || fallbackTarget;
    if (state.layout.splitViewEnabled && targetPane === 'bottom') {
      if (resolvedTarget) state.layout.topSplitTabIds = state.layout.topSplitTabIds.filter((id) => id !== resolvedTarget);
      state.bottomActiveTabId = resolvedTarget;
    } else {
      if (state.layout.splitViewEnabled && targetPane === 'top' && resolvedTarget && !state.layout.topSplitTabIds.includes(resolvedTarget)) state.layout.topSplitTabIds.push(resolvedTarget);
      state.layout.pinnedTopSidecarId = resolvedTarget;
    }
    if (state.layout.splitViewEnabled) state.layout.pinnedTopSidecarId = ns.partitionSplitTabs(state.sidecars, state.layout, state.terminals).activeTopId;
    renderAll();
    await saveLayoutUpdate({
      closedTabIds: state.layout.closedTabIds,
      tabOrder: state.layout.tabOrder,
      topSplitTabIds: state.layout.topSplitTabIds,
      pinnedTopSidecarId: state.layout.pinnedTopSidecarId,
      terminalState: ns.serializeTerminalState?.(),
      ...buildSideChatLayoutPatch(),
    });
  }

  const reopenClosed = async (id) => {
    if (state.layout.closedTabIds?.includes(id)) { state.layout.closedTabIds = state.layout.closedTabIds.filter((x) => x !== id); await saveLayoutUpdate({ closedTabIds: state.layout.closedTabIds }); }
  };

  async function handleTabContextAction({ action, sidecarId, targetIds = [], keepSidecarId = '', pane = 'single' }) {
    ++layoutSeq;
    const pinned = new Set(Array.isArray(state.layout.pinnedTabIds) ? state.layout.pinnedTabIds : []), closed = new Set(Array.isArray(state.layout.closedTabIds) ? state.layout.closedTabIds : []);
    if (action === 'toggle-pin') {
      if (pinned.has(sidecarId)) pinned.delete(sidecarId); else { pinned.add(sidecarId); closed.delete(sidecarId); }
      state.layout.pinnedTabIds = [...pinned]; state.layout.closedTabIds = [...closed]; renderAll();
      await saveLayoutUpdate({ pinnedTabIds: state.layout.pinnedTabIds, closedTabIds: state.layout.closedTabIds }); return;
    }
    if (action === 'toggle-global') {
      const sc = state.sidecars.find((s) => s.sidecarId === sidecarId); if (!sc) return;
      const isGlobal = sc.scope === 'global' || (sc.workspaces || []).includes('*'), wsPath = state.activeWorkspace?.workspacePath || '';
      const nextWs = isGlobal ? (wsPath ? [wsPath] : (sc.workspaces || []).filter((w) => w !== '*')) : Array.from(new Set(['*', ...(sc.workspaces || [])]));
      if (!nextWs.length) return;
      await ns.apiCall?.('/api/rules/update', { sidecarId, scope: nextWs.includes('*') ? 'global' : 'project', workspaces: nextWs });
      await refreshHangarState(); return;
    }
    if (action === 'reopen') {
      closed.delete(sidecarId); state.layout.closedTabIds = [...closed]; state.layout.pinnedTopSidecarId = sidecarId;
      if (sidecarId === ns.TERMINAL_TAB_ID) ns.setMainTerminalOpen?.(true);
      if (sidecarId === ns.SIDECHAT_TAB_ID) {
        ns.openTerminalQuoteComposer?.(els.mainViewport, {}, { conversationId: hangarConversationId !== '_new' ? hangarConversationId : '', skipActivate: true });
      }
      renderAll();
      await saveLayoutUpdate({ closedTabIds: state.layout.closedTabIds, pinnedTopSidecarId: sidecarId }); return;
    }
    if (action === 'delete-sidechat') {
      ns.closeSideChatDrawer?.({ deleteAll: true, notify: true });
      return;
    }
    if (action === 'new-sidechat') {
      const unpoppedSc = ns.getInstanceSideChats?.() || [];
      const wasMainOpen = Boolean(ns.getSideChatState?.()?.isOpen && !closed.has(ns.SIDECHAT_TAB_ID));
      const popOut = Boolean(wasMainOpen && unpoppedSc.length > 0);
      const forceNewThread = Boolean(popOut || unpoppedSc.length === 0);
      ns.openTerminalQuoteComposer?.(els.mainViewport, {}, {
        conversationId: hangarConversationId !== '_new' ? hangarConversationId : '',
        forceNewThread,
        popOut,
        pane,
      });
      return;
    }
    if (action === 'new-terminal') {
      const wsPath = state.activeWorkspace?.workspacePath || '';
      const mainTerms = ns.getInstanceTerminals?.(state.terminals, '') || [];
      const wasMainOpen = Boolean(ns.isMainTerminalOpen?.() && !closed.has(ns.TERMINAL_TAB_ID));
      ns.setMainTerminalOpen?.(true);
      let targetTabId = ns.TERMINAL_TAB_ID;
      if (!wasMainOpen && mainTerms.length > 0) {
        targetTabId = ns.TERMINAL_TAB_ID;
      } else {
        const created = await ns.apiCall?.('/api/terminal/create', { workspacePath: wsPath, conversationId: hangarConversationId });
        if (created?.terminalId) {
          created.title = ns.formatTermTitle?.(created.title || 'pwsh') || created.title || 'pwsh';
          state.terminals = [...state.terminals.filter((t) => t.terminalId !== created.terminalId), created];
          if (wasMainOpen && mainTerms.length > 0) {
            const popped = ns.getPoppedTerminalIds?.() || new Set();
            popped.add(created.terminalId);
            ns.setPoppedTerminalIds?.(popped);
            targetTabId = `${ns.TERMINAL_TAB_PREFIX || 'terminal__'}${created.terminalId}`;
            ns.saveTabGroups?.(targetTabId, [{ groupId: created.terminalId, paneIds: [created.terminalId], focusedPaneId: created.terminalId }]);
          }
          ns.setActiveGroupId?.(targetTabId, created.terminalId);
        }
      }
      closed.delete(targetTabId);
      state.layout.closedTabIds = [...closed];
      if (targetTabId !== ns.TERMINAL_TAB_ID) insertTabIntoOrder(targetTabId, { afterTabId: sidecarId || ns.TERMINAL_TAB_ID });
      if (state.layout.splitViewEnabled && pane === 'bottom') {
        state.layout.topSplitTabIds = (state.layout.topSplitTabIds || []).filter((id) => id !== targetTabId);
        state.bottomActiveTabId = targetTabId;
      } else {
        if (state.layout.splitViewEnabled && !state.layout.topSplitTabIds?.includes(targetTabId)) {
          state.layout.topSplitTabIds = [...(state.layout.topSplitTabIds || []), targetTabId];
        }
        state.layout.pinnedTopSidecarId = targetTabId;
      }
      renderAll();
      await saveLayoutUpdate({
        closedTabIds: state.layout.closedTabIds,
        tabOrder: state.layout.tabOrder,
        topSplitTabIds: state.layout.topSplitTabIds,
        pinnedTopSidecarId: state.layout.pinnedTopSidecarId,
        terminalState: ns.serializeTerminalState?.(),
      });
      await refreshHangarState();
      return;
    }
    if (action !== 'close') return;
    const ids = targetIds.filter((id) => id && !pinned.has(id)); if (!ids.length) return;
    const beforePart = ns.partitionSplitTabs(state.sidecars, state.layout, state.terminals);
    const beforeTopIds = (state.layout.splitViewEnabled ? beforePart.topTabs : beforePart.workspaceTabs).map((t) => t.sidecarId);
    const beforeBottomIds = beforePart.bottomTabs.map((t) => t.sidecarId);
    const prevTopAct = state.layout.splitViewEnabled ? beforePart.activeTopId : beforePart.activeSingleId;
    const prevBottomAct = state.bottomActiveTabId;
    let closedTerm = false;
    for (const id of ids) {
      if (id === ns.SIDECHAT_TAB_ID) { ns.closeSideChatDrawer?.({ deleteAll: false, notify: false }); closed.add(id); }
      else if (id.startsWith(ns.SIDECHAT_TAB_PREFIX || 'sidechat__')) { await ns.closeSideChatInstance?.(id); closed.delete(id); }
      else if (id === ns.TERMINAL_TAB_ID) {
        ns.setMainTerminalOpen?.(false);
        if ((ns.getInstanceTerminals?.(state.terminals, '') || []).length > 0) closed.add(id);
        else closed.delete(id);
      }
      else if (id.startsWith('terminal__')) { closedTerm = true; await ns.closeTerminalInstance?.(id, state.terminals); }
      else closed.add(id);
    }
    state.layout.closedTabIds = [...closed];
    const removedPopped = new Set(ids.filter((id) => id.startsWith('terminal__') || id.startsWith(ns.SIDECHAT_TAB_PREFIX || 'sidechat__')));
    if (removedPopped.size && Array.isArray(state.layout.tabOrder)) state.layout.tabOrder = state.layout.tabOrder.filter((id) => !removedPopped.has(id));
    if (Array.isArray(state.layout.topSplitTabIds)) state.layout.topSplitTabIds = state.layout.topSplitTabIds.filter((id) => !removedPopped.has(id) && !ids.includes(id));
    const { workspaceTabs, topTabs, bottomTabs } = ns.partitionSplitTabs(state.sidecars, state.layout, state.terminals);
    if (pane === 'bottom' && state.layout.splitViewEnabled) {
      state.bottomActiveTabId = keepSidecarId && !closed.has(keepSidecarId)
        ? keepSidecarId
        : pickNextTabAfterClose(beforeBottomIds, bottomTabs, prevBottomAct, ids);
    } else {
      const afterTopList = state.layout.splitViewEnabled ? topTabs : workspaceTabs;
      state.layout.pinnedTopSidecarId = keepSidecarId && !closed.has(keepSidecarId)
        ? keepSidecarId
        : pickNextTabAfterClose(beforeTopIds, afterTopList, prevTopAct, ids);
    }
    renderAll();
    await saveLayoutUpdate({
      closedTabIds: state.layout.closedTabIds,
      tabOrder: state.layout.tabOrder,
      topSplitTabIds: state.layout.topSplitTabIds,
      pinnedTopSidecarId: state.layout.pinnedTopSidecarId,
      terminalState: ns.serializeTerminalState?.(),
      ...buildSideChatLayoutPatch(),
    });
    if (closedTerm) await refreshHangarState();
  }

  function renderAll() {
    const { apiCall } = ns;
    rememberWindowActiveTab(state.layout.pinnedTopSidecarId);
    ns.reconcileIframeDeck?.({ state, els });
    const visibleTerminals = state.layout.showExternalTerminals === false ? state.terminals.filter((t) => !t?.isExternal) : state.terminals;
    const { workspaceTabs, topTabs, bottomTabs, activeSingleId, activeTopId } = ns.partitionSplitTabs(state.sidecars, state.layout, visibleTerminals);
    lastRenderedSingleIds = workspaceTabs.map((t) => t.sidecarId);
    lastRenderedTopIds = topTabs.map((t) => t.sidecarId);
    lastRenderedBottomIds = bottomTabs.map((t) => t.sidecarId);
    const topSlotId = state.layout.splitViewEnabled ? activeTopId : activeSingleId;
    if (topSlotId && topSlotId !== ns.EXTENSIONS_TAB_ID && !ns.isSideChatTabId?.(topSlotId) && !(state.layout.terminalDisplayMode === 'button' && topSlotId === ns.TERMINAL_TAB_ID)) lastNonExtTabId = topSlotId;
    const selectSlotTab = async (tabId, slotKey) => {
      ++layoutSeq;
      if (slotKey === 'bottom' && state.layout.splitViewEnabled) { state.bottomActiveTabId = tabId; renderAll(); }
      else { state.layout.pinnedTopSidecarId = tabId; renderAll(); await saveLayoutUpdate({ pinnedTopSidecarId: tabId }); }
    };
    const termProps = {
      splitEnabled: Boolean(state.layout.splitViewEnabled), terminals: visibleTerminals,
      workspacePath: state.activeWorkspace?.workspacePath || '', conversationId: hangarConversationId,
      onRefreshState: () => refreshHangarState(), onSelectTab: selectSlotTab, onPromoteToHangarTab: handleDropTab, onCrossInstanceMerge: applyTerminalMergeLayout, onSessionChange: () => renderAll(),
    };
    const onPreviewTerminalSlot = (previewTabId, pane) => {
      if (!previewTabId) { renderAll(); return; }
      const isBottom = pane === 'bottom' && state.layout.splitViewEnabled, slotCls = isBottom ? 'slot-bottom' : 'slot-top';
      if (previewTabId === (isBottom ? topSlotId : state.bottomActiveTabId)) return;
      if (els.storeView?.classList.contains(slotCls)) els.storeView.classList.add('hidden');
      (isBottom ? els.emptyDeckState : els.emptyTopState)?.classList.add('hidden');
      document.querySelectorAll(`.child-sidecar-frame.visible.${slotCls}`).forEach((f) => f.classList.remove('visible'));
      ns.renderTerminalSlots?.({ topTermEl: els.terminalTopView, bottomTermEl: els.terminalBottomView, topSlotId: isBottom ? topSlotId : previewTabId, bottomSlotId: isBottom ? previewTabId : state.bottomActiveTabId, ...termProps });
      ns.renderSideChatSlot?.({ viewportEl: els.mainViewport, topSlotId: isBottom ? topSlotId : previewTabId, bottomSlotId: isBottom ? previewTabId : state.bottomActiveTabId, splitEnabled: Boolean(state.layout.splitViewEnabled), conversationId: hangarConversationId });
    };
    ns.bindHangarChromeDropZone?.({ onPreviewTerminalSlot });
    ns.renderTabBar?.({
      tabStripEl: els.tabStrip, topOverflowBtnEl: els.topOverflowBtn, bottomTabBarEl: els.bottomTabBar, bottomTabStripEl: els.bottomTabStrip,
      bottomOverflowBtnEl: els.bottomOverflowBtn, tabOverflowPopoverEl: els.tabOverflowPopover, terminalBtnEl: els.terminalToggleBtn, extensionsBtnEl: els.extensionsToggleBtn, splitBtnEl: els.splitToggleBtn,
      sidecars: state.sidecars, terminals: visibleTerminals, registryPackages: state.registryPackages, hangar: state.hangar,
      bottomActiveTabId: state.bottomActiveTabId, layout: state.layout, hasActiveWorkspace: Boolean(state.activeWorkspace?.workspacePath),
      onSelectTopSplitTab: (sidecarId) => selectSlotTab(sidecarId, 'top'), onSelectBottomSplitTab: (sidecarId) => selectSlotTab(sidecarId, 'bottom'),
      onDropTab: handleDropTab, onPreviewTerminalSlot, onContextAction: handleTabContextAction,
      onDropIntoTerminal: async ({ sourceSidecarId, targetInstanceTabId, zone, index, targetPaneId, side, pane }) => {
        if (ns.isSideChatTabId?.(sourceSidecarId)) {
          if (!ns.demoteSideChatTabIntoInstance?.(sourceSidecarId, { targetInstanceTabId, zone, index, pane })) { renderAll(); return; }
          const isMain = sourceSidecarId === ns.SIDECHAT_TAB_ID;
          await applyTerminalMergeLayout({
            removedSidecarId: isMain ? targetInstanceTabId : sourceSidecarId,
            replacedSidecarId: isMain ? { from: targetInstanceTabId, to: ns.SIDECHAT_TAB_ID } : null,
            targetInstanceTabId: isMain ? ns.SIDECHAT_TAB_ID : targetInstanceTabId,
            targetPane: pane,
          });
          return;
        }
        if (!ns.demoteHangarTabIntoInstance?.(sourceSidecarId, { targetInstanceTabId, zone, index, targetPaneId, side })) { renderAll(); return; }
        const isMain = sourceSidecarId === ns.TERMINAL_TAB_ID;
        await applyTerminalMergeLayout({
          removedSidecarId: isMain ? targetInstanceTabId : sourceSidecarId, replacedSidecarId: isMain ? { from: targetInstanceTabId, to: ns.TERMINAL_TAB_ID } : null,
          targetInstanceTabId: isMain ? ns.TERMINAL_TAB_ID : targetInstanceTabId, targetPane: pane,
        });
      },
    });
    ns.renderTerminalSlots?.({ topTermEl: els.terminalTopView, bottomTermEl: els.terminalBottomView, topSlotId, bottomSlotId: state.bottomActiveTabId, ...termProps });
    ns.renderSideChatSlot?.({ viewportEl: els.mainViewport, topSlotId, bottomSlotId: state.bottomActiveTabId, splitEnabled: Boolean(state.layout.splitViewEnabled), conversationId: hangarConversationId });
    const isExtensionsVisible = state.layout.splitViewEnabled ? state.bottomActiveTabId === ns.EXTENSIONS_TAB_ID || activeTopId === ns.EXTENSIONS_TAB_ID : activeSingleId === ns.EXTENSIONS_TAB_ID;
    if (isExtensionsVisible) {
      ns.renderExtensionsTab?.({
        storeViewEl: els.storeView, sidecars: state.sidecars, plugins: state.plugins, suggestions: state.suggestions,
        registryPackages: state.registryPackages, hangar: state.hangar, layout: state.layout, activeWorkspace: state.activeWorkspace,
        onCheckUpdates: async () => { await refreshRegistry(); await refreshHangarState(); },
        onUpdateSettings: async (patch) => {
          if (!apiCall) return;
          ++layoutSeq;
          if (patch?.extensionsDisplayMode !== undefined || patch?.terminalDisplayMode !== undefined || patch?.showExternalTerminals !== undefined) {
            if (patch.extensionsDisplayMode !== undefined) state.layout.extensionsDisplayMode = patch.extensionsDisplayMode;
            if (patch.terminalDisplayMode !== undefined) state.layout.terminalDisplayMode = patch.terminalDisplayMode;
            if (patch.showExternalTerminals !== undefined) state.layout.showExternalTerminals = patch.showExternalTerminals;
            state.layout.pinnedTopSidecarId = ns.EXTENSIONS_TAB_ID;
            patch = { ...patch, pinnedTopSidecarId: ns.EXTENSIONS_TAB_ID };
          }
          await saveLayoutUpdate(patch);
          if (patch?.autoUpdate) await refreshRegistry();
          await refreshHangarState();
        },
        onSelfUpdate: async (payload) => { if (!apiCall) return; await apiCall('/api/store/self-update', payload); await new Promise((r) => setTimeout(r, 600)); await refreshRegistry(); await refreshHangarState(); },
        onManageSidecar: async (sidecarId, action) => { if (!apiCall) return; if (action !== 'SIDECAR_ACTION_DISABLE') await reopenClosed(sidecarId); await apiCall('/api/sidecar/manage', { sidecarId, action }); await refreshHangarState(); },
        onSaveWorkspaces: async (sc, patterns) => { if (!apiCall) return; if (patterns.length) await reopenClosed(sc.sidecarId); await apiCall('/api/rules/update', { sidecarId: sc.sidecarId, scope: patterns.includes('*') ? 'global' : 'project', workspaces: patterns }); await refreshHangarState(); },
        onToggleAutoHibernate: async (sc) => { if (!apiCall) return; await apiCall('/api/rules/update', { sidecarId: sc.sidecarId, autoHibernate: !sc.autoHibernate }); await refreshHangarState(); },
        onApplySuggestion: async (sug) => {
          if (!apiCall) return;
          const wsPath = state.activeWorkspace.workspacePath;
          if (sug.actionType === 'install') {
            // Installs go through Discover so the capability tier consent is always shown
            ns.setExtensionsSubTab?.('discover'); ns.setDiscoverQuery?.(sug.sidecarId); renderAll(); return;
          }
          await reopenClosed(sug.sidecarId);
          const existingSc = state.sidecars.find((s) => s.sidecarId === sug.sidecarId), curWs = (existingSc?.workspaces || []).filter((w) => w !== '*');
          const nextWs = wsPath ? Array.from(new Set([...curWs, wsPath])) : ['*'];
          await apiCall('/api/rules/update', { sidecarId: sug.sidecarId, scope: 'project', workspaces: nextWs });
          await apiCall('/api/sidecar/manage', { sidecarId: sug.sidecarId, action: 'SIDECAR_ACTION_ENABLE' });
          await refreshHangarState();
        },
        onInspectLocal: async (folderPath) => apiCall('/api/store/inspect', { folderPath }),
        onLinkLocal: async (payload) => { const res = await apiCall('/api/store/link-local', payload); await refreshRegistry(); await refreshHangarState(); return res; },
        onInstallRemote: async (payload) => { const res = await apiCall('/api/store/install', payload); await refreshRegistry(); await refreshHangarState(); return res; },
        onUninstallSidecar: async (sidecarId) => { await apiCall('/api/store/uninstall', { sidecarId }); await refreshRegistry(); await refreshHangarState(); },
        onPreviewPlugin: async (payload) => apiCall('/api/store/port-preview', payload),
        onInstallPlugin: async (payload) => { const res = await apiCall('/api/store/install-plugin', payload); await refreshRegistry(); await refreshHangarState(); return res; },
        onUninstallPlugin: async (pluginId) => { await apiCall('/api/store/uninstall-plugin', { pluginId }); await refreshRegistry(); await refreshHangarState(); },
      });
    }
  }

  let lastStateRefreshAt = 0, stateRefresh = null, stateRefreshAgain = false, knownBootId = '';

  // One /api/state request at a time. A refresh asked for mid-request (after a click, a workspace or
  // conversation change) runs once more when it ends, so whoever awaits it sees state from after their change.
  function refreshHangarState() {
    if (stateRefresh) { stateRefreshAgain = true; return stateRefresh; }
    stateRefresh = (async () => { do { stateRefreshAgain = false; await loadHangarState(); } while (stateRefreshAgain); })().finally(() => { stateRefresh = null; });
    return stateRefresh;
  }

  async function loadHangarState() {
    if (ns.isPointerOnTab || ns.activeTermDrag || state.isResizingSplit) return;
    const seq = layoutSeq;
    lastStateRefreshAt = Date.now();
    try {
      const data = await ns.apiCall('/api/state', { workspaceUris: state.workspaceUris, conversationId: hangarConversationId });
      if (data.bootId) { if (knownBootId && knownBootId !== data.bootId) { window.location?.reload?.(); return; } knownBootId = data.bootId; }
      if (ns.isPointerOnTab || ns.activeTermDrag || state.isResizingSplit) return;
      if (data.theme) ns.applyThemePayload?.(data.theme, false);
      const prevWsKey = getWsStateKey();
      state.activeWorkspace = data.activeWorkspace || state.activeWorkspace;
      const nextWsKey = getWsStateKey();
      const wsChanged = Boolean(prevWsKey && nextWsKey && prevWsKey !== nextWsKey);
      if (wsChanged) { lastNonExtTabId = ''; state.bottomActiveTabId = ''; }
      if (data.hangar) state.hangar = data.hangar;
      state.sidecars = data.sidecars || []; state.terminals = data.terminals || [];
      state.plugins = data.plugins || []; state.suggestions = data.suggestions || [];
      const wsPath = state.activeWorkspace?.workspacePath || '';
      if (data.layout && (seq === layoutSeq || wsChanged)) {
        const wsLayout = applyWorkspaceLayout(data.layout, nextWsKey);
        ns.hydrateTerminalStateFromLayout?.(wsLayout, state.terminals, wsPath);
        ns.hydrateSideChatStateFromLayout?.(wsLayout, wsPath);
        state.layout = withWindowActiveTab(wsLayout, nextWsKey);
      } else {
        ns.hydrateTerminalStateFromLayout?.(state.layout, state.terminals, wsPath);
        ns.hydrateSideChatStateFromLayout?.(state.layout, wsPath);
      }
      renderAll();
    } catch (err) {
      console.error('[hangar] Failed to refresh state:', err);
    }
  }

  ns.bindSplitResizeHandle?.({ state, els, onSaveHeight: (pinnedTopHeightPx) => saveLayoutUpdate({ pinnedTopHeightPx }) });
  ns.bindHangarChromeDropZone?.({ chromeBarEl: document.getElementById('chrome-bar'), bottomBarEl: els.bottomTabBar, onPromoteToHangarTab: handleDropTab, onMergeIntoTerminalTab: applyTerminalMergeLayout });
  ns.setTerminalPersistCallback?.((terminalState) => {
    ++layoutSeq;
    state.layout.terminalState = terminalState;
    saveLayoutUpdate({ terminalState });
  });
  ns.setSideChatDockCallback?.(async (scState) => {
    const scPatch = buildSideChatLayoutPatch(scState?.sideChatState);
    const targetTabId = scState?.targetTabId || ns.SIDECHAT_TAB_ID;
    const removedId = scState?.removedSidecarId || scState?.closedSidecarId || '';
    const { from: repFrom, to: repTo } = scState?.replacedSidecarId || {};
    const cleanArr = (arr) => {
      if (!Array.isArray(arr)) return [];
      const next = repFrom && repTo ? arr.filter((id) => id !== repTo).map((id) => (id === repFrom ? repTo : id)) : [...arr];
      return removedId && removedId !== repTo ? next.filter((id) => id !== removedId) : next;
    };
    if (scState?.activateTab) {
      ++layoutSeq;
      state.layout.closedTabIds = (state.layout.closedTabIds || []).filter((id) => id !== targetTabId && id !== removedId);
      if (Array.isArray(state.layout.tabOrder)) state.layout.tabOrder = cleanArr(state.layout.tabOrder);
      if (scState.afterTabId) insertTabIntoOrder(targetTabId, { afterTabId: scState.afterTabId });
      if (Array.isArray(state.layout.topSplitTabIds)) state.layout.topSplitTabIds = cleanArr(state.layout.topSplitTabIds);
      if (state.layout.splitViewEnabled) {
        if (scState.pane === 'top') {
          const topIds = new Set(Array.isArray(state.layout.topSplitTabIds) ? state.layout.topSplitTabIds : (state.layout.pinnedTopSidecarId ? [state.layout.pinnedTopSidecarId] : []));
          topIds.add(targetTabId);
          state.layout.topSplitTabIds = [...topIds];
          state.layout.pinnedTopSidecarId = targetTabId;
        } else {
          state.layout.topSplitTabIds = (state.layout.topSplitTabIds || []).filter((id) => id !== targetTabId);
          state.bottomActiveTabId = targetTabId;
        }
        renderAll();
        await saveLayoutUpdate({ tabOrder: state.layout.tabOrder, closedTabIds: state.layout.closedTabIds, topSplitTabIds: state.layout.topSplitTabIds, pinnedTopSidecarId: state.layout.pinnedTopSidecarId, ...scPatch });
      } else {
        state.layout.pinnedTopSidecarId = targetTabId;
        renderAll();
        await saveLayoutUpdate({ tabOrder: state.layout.tabOrder, closedTabIds: state.layout.closedTabIds, pinnedTopSidecarId: targetTabId, ...scPatch });
      }
    } else if (scState?.closedTab || scState?.closedSidecarId || !scState?.isOpen) {
      ++layoutSeq;
      const closingId = scState?.closedSidecarId || (scState?.closedTab || !scState?.isOpen ? ns.SIDECHAT_TAB_ID : '');
      state.layout.closedTabIds = (state.layout.closedTabIds || []).filter((id) => id !== closingId);
      if (Array.isArray(state.layout.tabOrder)) state.layout.tabOrder = state.layout.tabOrder.filter((id) => id !== closingId);
      if (Array.isArray(state.layout.topSplitTabIds)) {
        state.layout.topSplitTabIds = state.layout.topSplitTabIds.filter((id) => id !== closingId);
      }
      const { workspaceTabs, topTabs, bottomTabs } = ns.partitionSplitTabs(state.sidecars, state.layout, state.terminals);
      const beforeTopList = state.layout.splitViewEnabled ? lastRenderedTopIds : lastRenderedSingleIds;
      const afterTopList = state.layout.splitViewEnabled ? topTabs : workspaceTabs;
      state.layout.pinnedTopSidecarId = pickNextTabAfterClose(beforeTopList, afterTopList, state.layout.pinnedTopSidecarId || closingId, [closingId]);
      if (state.bottomActiveTabId === closingId) {
        state.bottomActiveTabId = pickNextTabAfterClose(lastRenderedBottomIds, bottomTabs, closingId, [closingId]);
      }
      renderAll();
      await saveLayoutUpdate({ tabOrder: state.layout.tabOrder, closedTabIds: state.layout.closedTabIds, topSplitTabIds: state.layout.topSplitTabIds, pinnedTopSidecarId: state.layout.pinnedTopSidecarId, ...scPatch });
    } else {
      renderAll();
      await saveLayoutUpdate(scPatch);
    }
  });

  const toggleTopChromeBtn = (targetTabId) => async () => {
    ++layoutSeq;
    if (targetTabId === ns.TERMINAL_TAB_ID) ns.setMainTerminalOpen?.(true);
    const { workspaceTabs, topTabs, activeSingleId, activeTopId } = ns.partitionSplitTabs(state.sidecars, state.layout, state.terminals);
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
      topSet.add(activeSingleId); patch.topSplitTabIds = [...topSet]; patch.pinnedTopSidecarId = activeSingleId;
    } else if (!nextSplit && activeTopId) patch.pinnedTopSidecarId = activeTopId;
    rememberWindowActiveTab(patch.pinnedTopSidecarId);
    await saveLayoutUpdate(patch);
    await refreshHangarState();
  });

    if (targetTabId === ns.TERMINAL_TAB_ID && (ns.getInstanceTerminals?.(state.terminals, '') || []).length === 0) {
      await handleTabContextAction({ action: 'new-terminal', pane: 'top' });
      return;
    }
  if (window.sidecar?.onWorkspaceChange) {
    window.sidecar.onWorkspaceChange((uris) => { state.workspaceUris = Array.isArray(uris) ? uris : []; refreshHangarState(); });
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
    state.layout.splitViewEnabled = nextSplit;
    if (patch.topSplitTabIds) state.layout.topSplitTabIds = patch.topSplitTabIds;
    if (patch.pinnedTopSidecarId) state.layout.pinnedTopSidecarId = patch.pinnedTopSidecarId;

  refreshRegistry();
  refreshHangarState();
  ns.subscribeStateSyncEvents?.({ getConversationId: () => hangarConversationId, onStateEvent: () => refreshHangarState() });
  setInterval(() => {
    const intervalMs = isHidden() ? HIDDEN_POLL_MS : VISIBLE_POLL_MS;
    if (!stateRefresh && Date.now() - lastStateRefreshAt >= intervalMs) refreshHangarState();
  }, VISIBLE_POLL_MS);
  setInterval(() => { if (!isHidden()) refreshRegistry(); }, 15 * 60 * 1000);
})();
