/** @fileoverview Dual-engine Interactive Terminal view (Direct VT100 + Native jetbox_web) with TabGroups and split panes. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  const instanceControllers = ns._termInstances, sharedPanes = ns._termSharedPanes;
  function createInstanceController(instanceTabId, rootId = '') {
    let tabGroups = ns.readTabGroups(instanceTabId), activeGroupId = tabGroups[0]?.groupId || rootId || '', pendingSplit = null, engineMode = ns.readEngineMode(), terminals = [], workspacePath = '', conversationId = '', callbacks = {}, pollBusy = false, isVisible = false, pendingFocus = false, slotKey = 'top', isRenaming = false;
    const rootEl = Object.assign(document.createElement('div'), { className: 'term-shell' });
    rootEl.dataset.instanceTabId = instanceTabId;
    ns.setHtml(rootEl, ns.html`<div class="term-toolbar"><agy-tab-strip class="agy-tab-strip" data-role="sessions"></agy-tab-strip><div class="term-toolbar-actions"><button type="button" class="agy-icon-btn" data-action="split" data-testid="terminal-split-button" title="Split Terminal">${ns.iconSvg('splitscreen_vertical_add', 15)}</button><button type="button" class="agy-icon-btn" data-action="popout" title="${rootId ? 'Merge back into main Terminal tab' : 'Pin Terminal Tab to Top Bar'}">${ns.iconSvg('dock_to_right', 14)}</button></div></div><div class="term-stage" data-role="stage"></div>`);
    const toolbarEl = rootEl.querySelector('.term-toolbar'), actionsEl = rootEl.querySelector('.term-toolbar-actions'), sessionsEl = rootEl.querySelector('[data-role="sessions"]'), stageEl = rootEl.querySelector('[data-role="stage"]'), popoutBtn = rootEl.querySelector('[data-action="popout"]'), splitBtn = rootEl.querySelector('[data-action="split"]');
    const getActiveGroup = () => tabGroups.find((g) => g.groupId === activeGroupId) || tabGroups[0] || null;
    const getActiveTid = () => getActiveGroup()?.focusedPaneId || terminals[0]?.terminalId || '';
    const getActiveTerm = () => terminals.find((t) => t.terminalId === getActiveTid()) || terminals[0] || null;
    const getVisibleIds = () => getActiveGroup()?.paneIds || [];
    const resolveTitle = (tid, fb = 'pwsh') => ns.readCustomTermTitles?.()?.[tid] || ns.formatTermTitle(sharedPanes.get(tid)?.title || terminals.find((x) => x.terminalId === tid)?.title || fb);
    const saveGroups = () => {
      ns.setActiveGroupId?.(instanceTabId, activeGroupId);
      ns.saveTabGroups(instanceTabId, tabGroups);
    };
    const refreshView = (notify = false) => {
      renderToolbar();
      renderStage();
      if (notify && rootId) callbacks.onSessionChange?.();
    };
    const focusPane = (tid) => ns._focusTermPane(tid, engineMode);
    const applyDropResult = (drag, dropTarget) => {
      if (drag?.instanceTabId && drag.instanceTabId !== instanceTabId) return void callbacks.onCrossInstanceMerge?.(ns.mergeTermDragIntoInstance?.(drag, { ...dropTarget, targetInstanceTabId: instanceTabId, pane: slotKey }));
      const res = ns.applyTerminalDrop(tabGroups, drag, dropTarget);
      tabGroups = res.groups;
      activeGroupId = res.activeGroupId || activeGroupId;
      saveGroups();
      refreshView(true);
      focusPane(getActiveTid());
      pollVisiblePanes();
    };
    sessionsEl.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && sessionsEl.scrollWidth > sessionsEl.clientWidth) e.preventDefault();
      if (e.defaultPrevented) sessionsEl.scrollLeft += e.deltaY;
    }, { passive: false });
    function normalizeGroupState() {
      const prevIds = tabGroups.map((g) => g.groupId), prevAct = activeGroupId || ns.getActiveGroupId?.(instanceTabId) || '';
      const res = ns.reconcileTabGroups(ns.readTabGroups(instanceTabId), terminals, pendingSplit), storedAct = ns.getActiveGroupId?.(instanceTabId);
      tabGroups = res.groups;
      if (res.consumedPending) pendingSplit = null;
      const nextSet = new Set(tabGroups.map((g) => g.groupId)), idx = prevAct ? prevIds.indexOf(prevAct) : -1;
      activeGroupId = (storedAct && nextSet.has(storedAct)) ? storedAct : (activeGroupId && nextSet.has(activeGroupId) ? activeGroupId : ((idx >= 0 ? prevIds.slice(idx + 1).find((id) => nextSet.has(id)) : '') || tabGroups[idx >= 0 ? tabGroups.length - 1 : 0]?.groupId || ''));
      saveGroups();
    }
    function setFocusedPane(tid, focusInput = false) {
      const g = tabGroups.find((grp) => grp.paneIds.includes(tid));
      if (!g) return;
      const changed = activeGroupId !== g.groupId || g.focusedPaneId !== tid;
      activeGroupId = Object.assign(g, { focusedPaneId: tid }).groupId;
      saveGroups();
      const vis = getVisibleIds();
      vis.forEach((id) => sharedPanes.get(id)?.wrap.classList.toggle('is-focused-pane', id === tid && vis.length > 1));
      vis.forEach((id) => sharedPanes.get(id)?.dotEl?.classList.toggle('active', id === tid));
      if (changed) refreshView(true);
      if (focusInput) focusPane(tid);
    }
    const closeTerminalsByIds = (tids = []) => ns._closeInstanceTerminalsByIds(tids, { rootId, instanceTabId, slotKey: () => slotKey, getTerminals: () => terminals, setTerminals: (next) => (terminals = next), normalizeGroupState, refreshView, getActiveTid, focusPane, callbacks: () => callbacks });
    const commitRename = (tid, rawNext) => {
      const next = String(rawNext || '').trim();
      isRenaming = false;
      ns.saveCustomTermTitle?.(tid, next);
      ns.apiCall?.('/api/terminal/rename', { terminalId: tid, title: next })?.catch?.(() => {});
      refreshView(true);
    };
    const ensureDirectPane = (tid) => ns._ensureDirectTermPane(tid, {
      instanceTabId, sessionsEl, stageEl, close: closeTerminalsByIds, focus: setFocusedPane, getTitle: resolveTitle, getEngineMode: () => engineMode,
      getConversationId: () => (conversationId && conversationId !== '_new' ? conversationId : ''), getActiveGroupId: () => getActiveGroup()?.groupId || '', getSlotKey: () => slotKey, onSameInstanceDrop: applyDropResult,
      onTitle: (id, next) => renderToolbar(Object.assign(terminals.find((x) => x.terminalId === id) || {}, { title: next })),
    });
    function renderToolbar() {
      if (ns.activeTermDrag?.instanceTabId === instanceTabId || ns.pointerTermInstanceId === instanceTabId || isRenaming) return;
      engineMode = ns.readEngineMode();
      const activeGrp = getActiveGroup(), visibleIds = getVisibleIds(), hasSessions = tabGroups.length > 0;
      [toolbarEl, actionsEl].forEach((el) => el?.classList.toggle('hidden', !hasSessions));
      popoutBtn?.classList.toggle('active', Boolean(rootId));
      splitBtn?.classList.toggle('active', visibleIds.length > 1);
      const togglePin = (grp) => {
        grp.pinned = !grp.pinned;
        tabGroups = [...tabGroups.filter((g) => g.pinned), ...tabGroups.filter((g) => !g.pinned)];
        ns.saveTabGroups(instanceTabId, tabGroups);
        renderToolbar();
      };
      const startRename = (pill, tid) => {
        const live = pill?.isConnected === false ? Array.from(sessionsEl.children || sessionsEl.childNodes || []).find((c) => c.dataset?.termTid === tid) : pill;
        const lbl = !isRenaming && live?.isConnected !== false ? (live?._slots?.labelEl || live?.querySelector?.('.agy-tab-label')) : null;
        if (lbl && (isRenaming = true)) ns.startInlineRename?.(live, lbl, { initialValue: resolveTitle(tid), inputClassName: 'agy-rename-input', onCommit: (v) => commitRename(tid, v), onCancel: () => refreshView((isRenaming = false)) });
      };
      const stripItems = tabGroups.map((grp, gIdx) => {
        const focTid = grp.focusedPaneId || grp.paneIds[0], isPinned = Boolean(grp.pinned);
        const t = terminals.find((x) => x.terminalId === focTid), isExt = grp.paneIds.some((pid) => terminals.find((x) => x.terminalId === pid)?.isExternal), cleanTitle = resolveTitle(focTid, t?.title || 'pwsh');
        return {
          id: focTid, grp, gIdx, label: cleanTitle, icon: 'terminal', iconSize: 16, active: grp.groupId === activeGrp?.groupId, pinned: isPinned, closable: !isPinned, renamable: true, badgeText: grp.paneIds.length > 1 ? `(${grp.paneIds.length})` : '', externalBadge: isExt,
          title: `${cleanTitle}${t?.cwd ? ` — ${t.cwd}` : ''}${isExt ? ' · Opened outside Hangar (shared with Antigravity)' : ''}${isPinned ? ' · Pinned' : ''} (Drag to reorder, split, or move across Hangar)`,
          dataset: { termTid: focTid, pinned: isPinned ? 'true' : 'false', external: isExt ? 'true' : 'false', testid: `terminal-tab-${focTid}` },
        };
      });
      const toggleEngine = () => refreshView(ns.saveEngineMode(engineMode === 'jetbox' ? 'direct' : 'jetbox'));
      const closeOthers = (grpId, others) => {
        ns.setActiveGroupId?.(instanceTabId, (activeGroupId = grpId));
        closeTerminalsByIds(others.flatMap((g) => g.paneIds));
      };
      const selectGroup = (grp, pill) => {
        if (!grp) return;
        if (activeGroupId !== grp.groupId) {
          ns.setActiveGroupId?.(instanceTabId, (activeGroupId = grp.groupId));
          Array.from(sessionsEl.children || sessionsEl.childNodes || []).forEach((c) => c.classList?.toggle?.('active', c === pill || c._item?.grp?.groupId === grp.groupId));
          renderStage();
          if (rootId) callbacks.onSessionChange?.();
        }
        focusPane(getActiveTid());
        pollVisiblePanes();
      };
      window.AgyUI?.reconcileTabStrip?.(sessionsEl, stripItems, {
        idDatasetKey: 'termTid', emptyHint: 'Drop a terminal tab here',
        addButton: hasSessions ? { role: 'term-add-tab', testId: 'aux-pane-new-tab-button', title: 'New Terminal Tab', onClick: () => spawnTerminal('') } : null,
        onSelect: (_id, item, _e, pill) => selectGroup(item?.grp, pill),
        onClose: (_id, item) => closeTerminalsByIds(item.grp.paneIds), onUnpin: (_id, item) => togglePin(item.grp),
        onRenameStart: () => (isRenaming = true), onRenameCancel: () => (isRenaming = false), onRename: commitRename,
        onContextMenu: (_id, item, e, pill) => {
          const grp = item.grp, focTid = grp.focusedPaneId || grp.paneIds[0], isPinned = Boolean(grp.pinned);
          const t = terminals.find((x) => x.terminalId === focTid), others = tabGroups.filter((g) => g.groupId !== grp.groupId && !g.pinned), right = tabGroups.slice(item.gIdx + 1).filter((g) => !g.pinned);
          const getQuote = () => ns.copyTerminalQuoteToClipboard({ terminalId: focTid, title: resolveTitle(focTid, t?.title || 'pwsh'), selectionContent: (engineMode === 'jetbox' ? sharedPanes.get(focTid)?.jetboxSelection : sharedPanes.get(focTid)?.emu?.getSelection()) || '' });
          ns.openTabContextMenu?.(e, [
            { id: isPinned ? 'unpin-tab' : 'pin-tab', label: isPinned ? 'Unpin Tab' : 'Pin Tab', onClick: () => togglePin(grp) },
            { id: 'rename-tab', label: 'Rename Terminal…', onClick: () => startRename(pill, focTid) },
            { id: 'split-tab', label: 'Split Terminal Right', onClick: () => spawnTerminal(focTid) },
            { id: 'quote-tab', label: 'Quote Terminal in Chat', onClick: () => ns.showTerminalQuoteToast?.(rootEl, `Copied @${getQuote().cleanName} mention pill — press Ctrl+V in chat`) },
            { id: 'quote-ask-tab', label: 'Quote & Ask Agent…', onClick: () => ns.openTerminalQuoteComposer?.(rootEl, getQuote(), { conversationId: conversationId && conversationId !== '_new' ? conversationId : (t?.conversationId || '') }) },
            { id: 'toggle-engine', label: engineMode === 'jetbox' ? 'Switch to Direct VT100 Engine' : 'Switch to Native Terminal Engine', onClick: toggleEngine },
            { separator: true },
            { id: 'close-tab', label: 'Close Tab', disabled: isPinned, onClick: () => closeTerminalsByIds(grp.paneIds) },
            { id: 'close-other-tabs', label: 'Close Other Tabs', disabled: !others.length, onClick: () => closeOthers(grp.groupId, others) },
            { id: 'close-tabs-to-the-right', label: 'Close Tabs to the Right', disabled: !right.length, onClick: () => closeTerminalsByIds(right.flatMap((g) => g.paneIds)) },
          ]);
        },
        bindDrag: (pill, item) => ns.bindTermPointerDrag?.(pill, {
          kind: 'tab', groupId: () => (pill._item || item).grp.groupId, terminalId: item.id, instanceTabId, sessionsEl, stageEl, getActiveGroupId: () => getActiveGroup()?.groupId || '', getSlotKey: () => slotKey,
          onClick: () => selectGroup((pill._item || item).grp, pill),
          onSameInstanceDrop: applyDropResult,
        }),
      });
    }
    const renderStage = () => ns._renderTermStagePanes({ stageEl, active: getActiveTerm(), activeTid: getActiveTid(), visibleIds: getVisibleIds(), terminals, engineMode, conversationId, isVisible: () => isVisible, getActiveTid, resolveTitle, focusPane, ensurePane: ensureDirectPane, onSpawnEmpty: () => spawnTerminal() });
    async function spawnTerminal(splitFromId = '') {
      const activeTid = getActiveTid(), activeGrp = getActiveGroup(), sRect = stageEl.getBoundingClientRect?.() || { width: 0, height: 0 };
      const paneW = sRect.width > 80 ? (splitFromId ? sRect.width / ((activeGrp?.paneIds?.length || 1) + 1) : sRect.width) : 0;
      const dims = engineMode === 'direct' && sharedPanes.get(activeTid)?.emu ? sharedPanes.get(activeTid).emu.getDimensions() : { cols: paneW ? Math.max(24, Math.min(240, Math.floor((paneW - 24) / 7.6))) : 0, rows: sRect.height > 40 ? Math.max(6, Math.min(120, Math.floor((sRect.height - 16) / 17))) : 0 };
      if (splitFromId && activeGrp) pendingSplit = { groupId: activeGrp.groupId, afterPaneId: splitFromId };
      const created = await ns.apiCall('/api/terminal/create', { workspacePath, conversationId, splitFromTerminalId: splitFromId || '', cols: dims.cols, rows: dims.rows });
      if (!created?.terminalId) return void (pendingSplit = null);
      created.title = ns.formatTermTitle(created.title || 'pwsh');
      if (rootId) ns.saveGroupMap({ ...ns.readGroupMap(), [created.terminalId]: rootId });
      terminals = [...terminals.filter((t) => t.terminalId !== created.terminalId), created];
      if (splitFromId && activeGrp) {
        tabGroups = ns.insertSplitPane(tabGroups, (activeGroupId = activeGrp.groupId), splitFromId, created.terminalId);
        pendingSplit = null;
        saveGroups();
      } else {
        ns.setActiveGroupId?.(instanceTabId, (activeGroupId = created.terminalId));
        normalizeGroupState();
      }
      refreshView();
      focusPane(created.terminalId);
      pollVisiblePanes();
      await callbacks.onRefreshState?.();
    }
    splitBtn?.addEventListener('click', () => getActiveTid() && spawnTerminal(getActiveTid()));
    popoutBtn?.addEventListener('click', () => {
      const activeGrp = getActiveGroup();
      if (!activeGrp?.paneIds.length) return;
      if (rootId) {
        ns.demoteHangarTabIntoInstance(instanceTabId, { targetInstanceTabId: ns.TERMINAL_TAB_ID, zone: 'strip' });
        return void (callbacks.onCrossInstanceMerge ? callbacks.onCrossInstanceMerge({ removedSidecarId: instanceTabId, targetInstanceTabId: ns.TERMINAL_TAB_ID, targetPane: slotKey }) : callbacks.onSelectTab?.(ns.TERMINAL_TAB_ID, slotKey));
      }
      const paneSet = new Set(activeGrp.paneIds), res = ns.promoteDragToHangarBar({ kind: 'tab', groupId: activeGrp.groupId, terminalId: getActiveTid(), instanceTabId });
      paneSet.forEach((tid) => {
        if (sharedPanes.get(tid)?.wrap) sharedPanes.get(tid).wrap._mountedParent = null;
        sharedPanes.get(tid)?.wrap?.remove?.();
      });
      terminals = terminals.filter((t) => !paneSet.has(t.terminalId));
      normalizeGroupState();
      refreshView();
      if (res?.newSidecarId) (callbacks.onPromoteToHangarTab ? callbacks.onPromoteToHangarTab({ sidecarId: res.newSidecarId, replacedSidecarId: res.replacedSidecarId, targetPane: slotKey, afterTabId: instanceTabId }) : callbacks.onSelectTab?.(res.newSidecarId, slotKey));
    });
    async function pollVisiblePanes() {
      if (pollBusy || !isVisible || engineMode !== 'direct') return;
      pollBusy = true;
      try { await ns._pollVisibleTermPanes({ visibleIds: getVisibleIds(), terminals, resolveTitle, renderToolbar }); } finally { pollBusy = false; }
    }
    const pollTimer = setInterval(pollVisiblePanes, 70);
    return {
      rootEl,
      setVisible: (vis) => {
        pendingFocus = Boolean(pendingFocus || (vis && !isVisible));
        isVisible = Boolean(vis);
      },
      focusTerminal: (tid) => {
        tabGroups = ns.readTabGroups(instanceTabId);
        const g = tabGroups.find((grp) => grp.paneIds.includes(tid));
        if (g && Object.assign(g, { focusedPaneId: tid }) && (activeGroupId = g.groupId) && (pendingFocus = true)) saveGroups();
      },
      mountInto: (slotEl, nextSlotKey) => {
        slotKey = nextSlotKey;
        if (!slotEl.contains?.(rootEl)) slotEl.appendChild(rootEl);
        Array.from(slotEl.children || []).forEach((ch) => ch.classList?.toggle?.('hidden', ch !== rootEl));
      },
      sync: ({ nextTerminals, nextWorkspacePath = '', nextConversationId = '', cb = {} }) => {
        terminals = (Array.isArray(nextTerminals) ? nextTerminals : []).map((t) => ({ ...t, title: sharedPanes.get(t.terminalId) && t.title ? (sharedPanes.get(t.terminalId).title = ns.formatTermTitle(t.title || 'pwsh')) : ns.formatTermTitle(t.title || 'pwsh') }));
        workspacePath = nextWorkspacePath;
        conversationId = (callbacks = cb) && nextConversationId;
        normalizeGroupState();
        refreshView();
        if (pendingFocus && isVisible && !(pendingFocus = false) && getActiveTid()) focusPane(getActiveTid());
        pollVisiblePanes();
      },
      handleJetboxEvent: (type, payload = {}, sourceWin) => ns._handleJetboxTermEvent(type, payload, sourceWin, { visibleIds: getVisibleIds(), terminals, rootEl, conversationId, getActiveTerm, setFocusedPane, resolveTitle, renderToolbar }),
      dispose: () => {
        clearInterval(pollTimer);
        rootEl.remove?.();
      },
    };
  }
  ns.renderTerminalSlots = function renderTerminalSlots({ topTermEl, bottomTermEl, topSlotId, bottomSlotId, splitEnabled, terminals = [], workspacePath = '', conversationId = '', ...cb }) {
    const liveTerms = (terminals || []).filter((t) => !ns.isTerminalClosing(t.terminalId)), activeTabIds = new Set(), popped = ns.getPoppedTerminalIds(), liveIds = new Set(liveTerms.map((t) => t.terminalId));
    if (liveTerms.length > 0) ns._disposeTermPanes([...sharedPanes.keys()].filter((tid) => !liveIds.has(tid)));
    const slots = [{ key: 'top', el: topTermEl, tabId: topSlotId, slotClass: 'slot-top' }, { key: 'bottom', el: bottomTermEl, tabId: splitEnabled && bottomSlotId !== topSlotId ? bottomSlotId : '', slotClass: 'slot-bottom' }];
    for (const s of slots) {
      if (!s.el) continue;
      const vis = ns.isTerminalTabId(s.tabId);
      s.el.classList.toggle('hidden', !vis);
      s.el.classList.toggle(s.slotClass, vis);
      if (!vis) continue;
      activeTabIds.add(s.tabId);
      const rootId = String(s.tabId).startsWith(ns.TERMINAL_TAB_PREFIX) ? String(s.tabId).slice(ns.TERMINAL_TAB_PREFIX.length) : '';
      if (!instanceControllers.has(s.tabId)) instanceControllers.set(s.tabId, createInstanceController(s.tabId, rootId));
      const ctrl = instanceControllers.get(s.tabId);
      ctrl.mountInto(s.el, s.key);
      ctrl.setVisible(true);
      ctrl.sync({ nextTerminals: ns.getInstanceTerminals(liveTerms, rootId), nextWorkspacePath: workspacePath, nextConversationId: conversationId, cb });
    }
    for (const [tabId, ctrl] of instanceControllers.entries()) {
      if (!activeTabIds.has(tabId)) ctrl.setVisible(false);
      if (!activeTabIds.has(tabId) && tabId !== ns.TERMINAL_TAB_ID && !popped.has(tabId.slice(ns.TERMINAL_TAB_PREFIX.length))) ns.disposeTerminalInstance(tabId);
    }
  };
})();
