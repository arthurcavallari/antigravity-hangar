/** @fileoverview Workspace layout persistence, tab ordering, split/merge orchestration, and context menu actions. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  const ACTIVE_TAB_KEY = 'hangar.activeTabId';
  const WS_LAYOUT_DEFAULTS = { pinnedTopSidecarId: 'context-monitor', topSplitTabIds: ['context-monitor'], tabOrder: [], closedTabIds: [], pinnedTabIds: [], splitViewEnabled: false };
  const WS_LAYOUT_KEYS = Object.keys(WS_LAYOUT_DEFAULTS);
  function pickNextTabAfterClose(beforeList = [], afterList = [], curActiveId = '', removedIds = []) {
    const [beforeIds, afterIds] = [beforeList, afterList].map((l) => l.map((t) => (typeof t === 'string' ? t : t.sidecarId)).filter(Boolean));
    const afterSet = new Set(afterIds), rmSet = new Set(removedIds);
    if (!afterIds.length || (curActiveId && afterSet.has(curActiveId) && !rmSet.has(curActiveId))) return afterIds.length ? curActiveId : '';
    const idx = beforeIds.indexOf(curActiveId && beforeIds.includes(curActiveId) ? curActiveId : beforeIds.find((id) => rmSet.has(id) || !afterSet.has(id)));
    return idx >= 0 ? (beforeIds.slice(idx + 1).find((id) => afterSet.has(id)) || afterIds.at(-1) || '') : (afterIds[0] || '');
  }
  function cleanTabList(arr, removedId, replaced) {
    if (!Array.isArray(arr)) return [];
    const { from, to } = replaced || {};
    const next = from && to ? arr.filter((id) => id !== to).map((id) => (id === from ? to : id)) : [...arr];
    return removedId && removedId !== to ? next.filter((id) => id !== removedId) : next;
  }
  ns.createLayoutController = function createLayoutController(ctx) {
    const { state, els, hangarConversationId, bumpLayoutSeq, getRenderedLists, renderAll, refreshHangarState } = ctx;
    const part = () => ns.partitionSplitTabs(state.sidecars, state.layout, state.terminals);
    const convId = () => (hangarConversationId !== '_new' ? hangarConversationId : '');
    const getWsStateKey = (wsPath = state.activeWorkspace?.workspacePath) => String(wsPath || '').trim().replace(/\\/g, '/').toLowerCase();
    const getActiveTabStorageKey = (wsKey = getWsStateKey()) => wsKey ? `${ACTIVE_TAB_KEY}:${wsKey}` : (hangarConversationId ? `${ACTIVE_TAB_KEY}:conv:${hangarConversationId}` : ACTIVE_TAB_KEY);
    const scrubOrder = (removedId = '', replaced = null) => {
      if (Array.isArray(state.layout.tabOrder)) state.layout.tabOrder = cleanTabList(state.layout.tabOrder, removedId, replaced);
      if (Array.isArray(state.layout.topSplitTabIds)) state.layout.topSplitTabIds = cleanTabList(state.layout.topSplitTabIds, removedId, replaced);
    };
    const buildSideChatLayoutPatch = (scStateObj = ns.serializeSideChatState?.()) => {
      const wsKey = getWsStateKey();
      const patch = { sideChatState: scStateObj, sideChatStateByWorkspace: { ...(state.layout.sideChatStateByWorkspace || {}), ...(wsKey ? { [wsKey]: scStateObj } : {}) } };
      Object.assign(state.layout, patch);
      return patch;
    };
    function saveLayoutUpdate(patch = {}) {
      const wsKey = getWsStateKey();
      if (!wsKey || !WS_LAYOUT_KEYS.some((k) => patch[k] !== undefined)) return ns.apiCall?.('/api/layout/update', { ...patch });
      const prevMap = state.layout.workspaceLayouts && typeof state.layout.workspaceLayouts === 'object' ? state.layout.workspaceLayouts : {};
      const snap = Object.fromEntries(WS_LAYOUT_KEYS.map((k) => [k, patch[k] !== undefined ? patch[k] : (prevMap[wsKey]?.[k] ?? state.layout[k] ?? WS_LAYOUT_DEFAULTS[k])]));
      state.layout.workspaceLayouts = { ...prevMap, [wsKey]: { ...WS_LAYOUT_DEFAULTS, ...(prevMap[wsKey] || {}), ...snap } };
      return ns.apiCall?.('/api/layout/update', { ...patch, workspaceLayouts: state.layout.workspaceLayouts });
    }
    const isTabValidForWindow = (id) => {
      const scPrefix = ns.SIDECHAT_TAB_PREFIX || 'sidechat__', termPrefix = ns.TERMINAL_TAB_PREFIX || 'terminal__';
      if (!id || (id === ns.SIDECHAT_TAB_ID && !ns.getSideChatState?.()?.isOpen)) return false;
      if (String(id).startsWith(scPrefix)) return Boolean(ns.getPoppedSideChatIds?.()?.has(String(id).slice(scPrefix.length)));
      if (String(id).startsWith(termPrefix)) return Boolean(ns.getPoppedTerminalIds?.()?.has(String(id).slice(termPrefix.length)) && state.terminals.some((t) => t.terminalId === String(id).slice(termPrefix.length)));
      return id !== ns.TERMINAL_TAB_ID || Boolean(ns.isMainTerminalOpen?.());
    };
    const rememberWindowActiveTab = (id, wsKey = getWsStateKey()) => {
      if (!id) return;
      try { sessionStorage[isTabValidForWindow(id) ? 'setItem' : 'removeItem'](getActiveTabStorageKey(wsKey), id); } catch { /* ignore */ }
    };
    const applyWorkspaceLayout = (raw = {}, wsKey = getWsStateKey()) => (!wsKey ? { ...raw } : { ...raw, ...WS_LAYOUT_DEFAULTS, ...(raw?.workspaceLayouts?.[wsKey] || {}) });
    const withWindowActiveTab = (layout, wsKey = getWsStateKey()) => {
      let w = '';
      try { w = sessionStorage.getItem(getActiveTabStorageKey(wsKey)) || ''; } catch { /* ignore */ }
      return isTabValidForWindow(w) ? { ...layout, pinnedTopSidecarId: w } : (layout?.pinnedTopSidecarId && !isTabValidForWindow(layout.pinnedTopSidecarId) ? { ...layout, pinnedTopSidecarId: 'context-monitor' } : layout);
    };
    function insertTabIntoOrder(sidecarId, { beforeTabId = '', afterTabId = '' } = {}) {
      const currentIds = part().workspaceTabs.map((t) => t.sidecarId);
      const base = [...currentIds, ...(state.layout.tabOrder || []).filter((id) => !currentIds.includes(id))].filter((id) => id !== sidecarId);
      if (beforeTabId && base.includes(beforeTabId)) base.splice(base.indexOf(beforeTabId), 0, sidecarId);
      else if (afterTabId && base.includes(afterTabId)) base.splice(base.indexOf(afterTabId) + 1, 0, sidecarId);
      else base.push(sidecarId);
      state.layout.tabOrder = base;
    }
    function activateTabInPane(targetTabId, pane) {
      if (state.layout.splitViewEnabled && pane === 'bottom') state.bottomActiveTabId = targetTabId;
      else state.layout.pinnedTopSidecarId = targetTabId;
      if (!state.layout.splitViewEnabled || !targetTabId) return;
      const top = (state.layout.topSplitTabIds || []).filter((id) => id !== targetTabId);
      state.layout.topSplitTabIds = pane === 'bottom' ? top : [...top, targetTabId];
    }
      const saveFullLayout = (extra = {}) => saveLayoutUpdate({ closedTabIds: state.layout.closedTabIds, tabOrder: state.layout.tabOrder, topSplitTabIds: state.layout.topSplitTabIds, pinnedTopSidecarId: state.layout.pinnedTopSidecarId, terminalState: ns.serializeTerminalState?.(), ...buildSideChatLayoutPatch(), ...extra });
      const renderAndSave = (patch = {}) => {
        renderAll();
        return saveLayoutUpdate(patch);
      };
      const renderAndSaveFull = (extra = {}) => renderAndSave({ closedTabIds: state.layout.closedTabIds, tabOrder: state.layout.tabOrder, topSplitTabIds: state.layout.topSplitTabIds, pinnedTopSidecarId: state.layout.pinnedTopSidecarId, terminalState: ns.serializeTerminalState?.(), ...buildSideChatLayoutPatch(), ...extra });
    const pickPaneNext = (isBot, removedId) => {
      const { workspaceTabs, topTabs, bottomTabs } = part();
      const { singleIds, topIds, bottomIds } = getRenderedLists();
      return pickNextTabAfterClose(isBot ? bottomIds : (state.layout.splitViewEnabled ? topIds : singleIds), isBot ? bottomTabs : (state.layout.splitViewEnabled ? topTabs : workspaceTabs), (isBot ? state.bottomActiveTabId : state.layout.pinnedTopSidecarId) || removedId || '', [removedId]);
    };
    async function createWorkspaceTerminal() {
      const created = await ns.apiCall?.('/api/terminal/create', { workspacePath: state.activeWorkspace?.workspacePath || '', conversationId: hangarConversationId });
      if (created?.terminalId) state.terminals = [...state.terminals.filter((t) => t.terminalId !== created.terminalId), Object.assign(created, { title: ns.formatTermTitle?.(created.title || 'pwsh') || created.title || 'pwsh' })];
      return created;
    }
    const reopenClosed = async (id) => {
      if (!state.layout.closedTabIds?.includes(id)) return;
      state.layout.closedTabIds = state.layout.closedTabIds.filter((x) => x !== id);
      await saveLayoutUpdate({ closedTabIds: state.layout.closedTabIds });
    };
    async function handleDropTab({ sidecarId, replacedSidecarId, targetPane, beforeTabId, afterTabId }) {
      bumpLayoutSeq();
      if (replacedSidecarId?.from && replacedSidecarId?.to) scrubOrder('', replacedSidecarId);
      insertTabIntoOrder(sidecarId, { beforeTabId, afterTabId });
      activateTabInPane(sidecarId, targetPane);
      if (state.layout.splitViewEnabled) state.layout.pinnedTopSidecarId = part().activeTopId;
      await renderAndSaveFull();
    }
    async function applyTerminalMergeLayout({ removedSidecarId, replacedSidecarId, targetInstanceTabId, targetPane }) {
      bumpLayoutSeq();
      state.layout.topSplitTabIds = Array.isArray(state.layout.topSplitTabIds) ? state.layout.topSplitTabIds : (state.layout.pinnedTopSidecarId ? [state.layout.pinnedTopSidecarId] : []);
      state.layout.tabOrder = Array.isArray(state.layout.tabOrder) ? state.layout.tabOrder : [];
      scrubOrder(removedSidecarId, replacedSidecarId);
      if (targetInstanceTabId && Array.isArray(state.layout.closedTabIds)) state.layout.closedTabIds = state.layout.closedTabIds.filter((id) => id !== targetInstanceTabId);
      if (replacedSidecarId?.from && replacedSidecarId?.to) {
        if (state.layout.pinnedTopSidecarId === replacedSidecarId.from) state.layout.pinnedTopSidecarId = replacedSidecarId.to;
        if (state.bottomActiveTabId === replacedSidecarId.from) state.bottomActiveTabId = replacedSidecarId.to;
      }
      const { bottomTabs, activeSingleId, activeTopId } = part();
      const isBottom = state.layout.splitViewEnabled && targetPane === 'bottom';
      const fallback = removedSidecarId ? pickPaneNext(isBottom, removedSidecarId) : (isBottom ? (bottomTabs[0]?.sidecarId || '') : (state.layout.splitViewEnabled ? activeTopId : activeSingleId));
      activateTabInPane(targetInstanceTabId || fallback, targetPane);
      if (state.layout.splitViewEnabled) state.layout.pinnedTopSidecarId = part().activeTopId;
      await renderAndSaveFull();
    }
    async function handleSideChatDock(scState) {
      const scPatch = buildSideChatLayoutPatch(scState?.sideChatState);
      const targetTabId = scState?.targetTabId || ns.SIDECHAT_TAB_ID, removedId = scState?.removedSidecarId || scState?.closedSidecarId || '';
      if (scState?.openTerminal) {
        const toBot = (scState.pane || 'top') !== 'bottom', srcId = scState.sourceTabId || ns.SIDECHAT_TAB_ID;
        if (!(ns.getInstanceTerminals?.(state.terminals, '') || []).length) {
          const created = await createWorkspaceTerminal().catch(() => null);
          if (created?.terminalId) ns.setActiveGroupId?.(ns.TERMINAL_TAB_ID, created.terminalId);
        }
        bumpLayoutSeq();
        ns.setMainTerminalOpen?.(true);
        const topSet = new Set(Array.isArray(state.layout.topSplitTabIds) ? state.layout.topSplitTabIds : (state.layout.pinnedTopSidecarId ? [state.layout.pinnedTopSidecarId] : []));
        topSet.add(toBot ? srcId : ns.TERMINAL_TAB_ID);
        topSet.delete(toBot ? ns.TERMINAL_TAB_ID : srcId);
        Object.assign(state.layout, { splitViewEnabled: true, closedTabIds: (state.layout.closedTabIds || []).filter((id) => id !== ns.TERMINAL_TAB_ID && id !== srcId), pinnedTopSidecarId: toBot ? srcId : ns.TERMINAL_TAB_ID, topSplitTabIds: [...topSet] });
        state.bottomActiveTabId = toBot ? ns.TERMINAL_TAB_ID : srcId;
        return void await renderAndSaveFull({ splitViewEnabled: true, ...scPatch });
      }
      if (scState?.activateTab || scState?.closedTab || scState?.closedSidecarId || !scState?.isOpen) {
        bumpLayoutSeq();
        const isAct = Boolean(scState?.activateTab);
        const closingId = isAct ? removedId : (scState?.closedSidecarId || (scState?.closedTab || !scState?.isOpen ? ns.SIDECHAT_TAB_ID : ''));
        state.layout.closedTabIds = (state.layout.closedTabIds || []).filter((id) => id !== closingId && (!isAct || id !== targetTabId));
        scrubOrder(closingId, isAct ? scState?.replacedSidecarId : null);
        if (isAct && scState.afterTabId) insertTabIntoOrder(targetTabId, { afterTabId: scState.afterTabId });
        if (isAct) activateTabInPane(targetTabId, scState.pane);
        else {
          state.layout.pinnedTopSidecarId = pickPaneNext(false, closingId);
          if (state.bottomActiveTabId === closingId) state.bottomActiveTabId = pickPaneNext(true, closingId);
        }
        return void await renderAndSave({ tabOrder: state.layout.tabOrder, closedTabIds: state.layout.closedTabIds, ...((!isAct || state.layout.splitViewEnabled) ? { topSplitTabIds: state.layout.topSplitTabIds } : {}), pinnedTopSidecarId: state.layout.pinnedTopSidecarId, ...scPatch });
      }
      await renderAndSave(scPatch);
    }
    async function handleTabContextAction({ action, sidecarId, targetIds = [], keepSidecarId = '', pane = 'single' }) {
      bumpLayoutSeq();
      const pinned = new Set(state.layout.pinnedTabIds || []), closed = new Set(state.layout.closedTabIds || []);
      if (action === 'toggle-pin' || action === 'reopen') {
        if (action === 'toggle-pin') {
          if (pinned.has(sidecarId)) pinned.delete(sidecarId);
          else {
            closed.delete(sidecarId);
            pinned.add(sidecarId);
          }
        } else {
          closed.delete(sidecarId);
          state.layout.pinnedTopSidecarId = sidecarId;
          if (sidecarId === ns.TERMINAL_TAB_ID) ns.setMainTerminalOpen?.(true);
          if (sidecarId === ns.SIDECHAT_TAB_ID) ns.openTerminalQuoteComposer?.(els.mainViewport, {}, { conversationId: convId(), skipActivate: true });
        }
        Object.assign(state.layout, { pinnedTabIds: [...pinned], closedTabIds: [...closed] });
        return void await renderAndSave({ pinnedTabIds: state.layout.pinnedTabIds, closedTabIds: state.layout.closedTabIds, ...(action === 'reopen' ? { pinnedTopSidecarId: sidecarId } : {}) });
      }
      if (action === 'toggle-global') {
        const sc = state.sidecars.find((s) => s.sidecarId === sidecarId);
        if (!sc) return;
        const isGlobal = sc.scope === 'global' || (sc.workspaces || []).includes('*');
        const wsPath = state.activeWorkspace?.workspacePath || '';
        const nextWs = isGlobal ? (wsPath ? [wsPath] : (sc.workspaces || []).filter((w) => w !== '*')) : Array.from(new Set(['*', ...(sc.workspaces || [])]));
        if (!nextWs.length) return;
        await ns.apiCall?.('/api/rules/update', { sidecarId, scope: nextWs.includes('*') ? 'global' : 'project', workspaces: nextWs });
        return void await refreshHangarState();
      }
      if (action === 'delete-sidechat') return void ns.closeSideChatDrawer?.({ deleteAll: true, notify: true });
      if (action === 'new-sidechat') {
        const unpoppedSc = ns.getInstanceSideChats?.() || [];
        const popOut = Boolean(ns.getSideChatState?.()?.isOpen && !closed.has(ns.SIDECHAT_TAB_ID) && unpoppedSc.length > 0);
        return void ns.openTerminalQuoteComposer?.(els.mainViewport, {}, { conversationId: convId(), forceNewThread: Boolean(popOut || !unpoppedSc.length), popOut, pane });
      }
      if (action === 'new-terminal') {
        const mainTerms = ns.getInstanceTerminals?.(state.terminals, '') || [];
        const wasMainOpen = Boolean(ns.isMainTerminalOpen?.() && !closed.has(ns.TERMINAL_TAB_ID));
        ns.setMainTerminalOpen?.(true);
        let targetTabId = ns.TERMINAL_TAB_ID;
        if (wasMainOpen || !mainTerms.length) {
          const created = await createWorkspaceTerminal();
          if (created?.terminalId && wasMainOpen && mainTerms.length > 0) {
            ns.setPoppedTerminalIds?.(new Set([...(ns.getPoppedTerminalIds?.() || []), created.terminalId]));
            targetTabId = `${ns.TERMINAL_TAB_PREFIX || 'terminal__'}${created.terminalId}`;
            ns.saveTabGroups?.(targetTabId, [{ groupId: created.terminalId, paneIds: [created.terminalId], focusedPaneId: created.terminalId }]);
          }
          if (created?.terminalId) ns.setActiveGroupId?.(targetTabId, created.terminalId);
        }
        closed.delete(targetTabId);
        state.layout.closedTabIds = [...closed];
        if (targetTabId !== ns.TERMINAL_TAB_ID) insertTabIntoOrder(targetTabId, { afterTabId: sidecarId || ns.TERMINAL_TAB_ID });
        activateTabInPane(targetTabId, pane);
        await renderAndSaveFull();
        return void await refreshHangarState();
      }
      const ids = action === 'close' ? targetIds.filter((id) => id && !pinned.has(id)) : [];
      if (!ids.length) return;
      const beforePart = part();
      const beforeTopIds = (state.layout.splitViewEnabled ? beforePart.topTabs : beforePart.workspaceTabs).map((t) => t.sidecarId);
      const beforeBottomIds = beforePart.bottomTabs.map((t) => t.sidecarId), prevTopAct = state.layout.splitViewEnabled ? beforePart.activeTopId : beforePart.activeSingleId;
      let closedTerm = false;
      for (const id of ids) {
        if (id === ns.SIDECHAT_TAB_ID) ns.closeSideChatDrawer?.({ deleteAll: false, notify: false });
        else if (id.startsWith(ns.SIDECHAT_TAB_PREFIX || 'sidechat__')) await ns.closeSideChatInstance?.(id);
        else if (id === ns.TERMINAL_TAB_ID) ns.setMainTerminalOpen?.(false);
        else if (id.startsWith('terminal__')) {
          closedTerm = true;
          await ns.closeTerminalInstance?.(id, state.terminals);
        }
        closed[id.startsWith('terminal__') || id.startsWith(ns.SIDECHAT_TAB_PREFIX || 'sidechat__') || (id === ns.TERMINAL_TAB_ID && !(ns.getInstanceTerminals?.(state.terminals, '') || []).length) ? 'delete' : 'add'](id);
      }
      state.layout.closedTabIds = [...closed];
      const removedPopped = new Set(ids.filter((id) => id.startsWith('terminal__') || id.startsWith(ns.SIDECHAT_TAB_PREFIX || 'sidechat__')));
      if (removedPopped.size && Array.isArray(state.layout.tabOrder)) state.layout.tabOrder = state.layout.tabOrder.filter((id) => !removedPopped.has(id));
      if (Array.isArray(state.layout.topSplitTabIds)) state.layout.topSplitTabIds = state.layout.topSplitTabIds.filter((id) => !removedPopped.has(id) && !ids.includes(id));
      const { workspaceTabs, topTabs, bottomTabs } = part();
      if (pane === 'bottom' && state.layout.splitViewEnabled) state.bottomActiveTabId = keepSidecarId && !closed.has(keepSidecarId) ? keepSidecarId : pickNextTabAfterClose(beforeBottomIds, bottomTabs, state.bottomActiveTabId, ids);
      else state.layout.pinnedTopSidecarId = keepSidecarId && !closed.has(keepSidecarId) ? keepSidecarId : pickNextTabAfterClose(beforeTopIds, state.layout.splitViewEnabled ? topTabs : workspaceTabs, prevTopAct, ids);
      await renderAndSaveFull();
      if (closedTerm) await refreshHangarState();
    }
    async function handleDropIntoTerminal({ sourceSidecarId, targetInstanceTabId, zone, index, targetPaneId, side, pane }) {
      const isSc = Boolean(ns.isSideChatTabId?.(sourceSidecarId));
      const ok = isSc ? ns.demoteSideChatTabIntoInstance?.(sourceSidecarId, { targetInstanceTabId, zone, index, pane }) : ns.demoteHangarTabIntoInstance?.(sourceSidecarId, { targetInstanceTabId, zone, index, targetPaneId, side });
      if (!ok) return void renderAll();
      const mainId = isSc ? ns.SIDECHAT_TAB_ID : ns.TERMINAL_TAB_ID, isMain = sourceSidecarId === mainId;
      await applyTerminalMergeLayout({ removedSidecarId: isMain ? targetInstanceTabId : sourceSidecarId, replacedSidecarId: isMain ? { from: targetInstanceTabId, to: mainId } : null, targetInstanceTabId: isMain ? mainId : targetInstanceTabId, targetPane: pane });
    }
    return { getWsStateKey, buildSideChatLayoutPatch, saveLayoutUpdate, saveFullLayout, rememberWindowActiveTab, applyWorkspaceLayout, withWindowActiveTab, insertTabIntoOrder, activateTabInPane, createWorkspaceTerminal, handleDropTab, applyTerminalMergeLayout, handleDropIntoTerminal, handleSideChatDock, handleTabContextAction, reopenClosed };
  };
})();
