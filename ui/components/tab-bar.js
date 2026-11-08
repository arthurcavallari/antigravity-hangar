/** @fileoverview Renders top and bottom Chrome tab bars for Antigravity Hangar via AgyUI.reconcileTabStrip. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  ns.EXTENSIONS_TAB_ID = '__extensions__';
  ns.TERMINAL_TAB_ID = ns.TERMINAL_TAB_ID || '__terminal__';
  ns.SIDECHAT_TAB_ID = ns.SIDECHAT_TAB_ID || '__sidechat__';
  ns.SIDECHAT_TAB_PREFIX = ns.SIDECHAT_TAB_PREFIX || 'sidechat__';
  ns.isSideChatTabId = ns.isSideChatTabId || ((tabId = '') => (
    tabId === ns.SIDECHAT_TAB_ID || String(tabId || '').startsWith(ns.SIDECHAT_TAB_PREFIX)
  ));
  const TERMINAL_TAB = {
    sidecarId: ns.TERMINAL_TAB_ID,
    displayName: 'Terminal',
    statusBadge: 'TERMINAL',
    isVirtual: true,
    isTerminal: true,
    matchesWorkspace: true,
  };
  const EXTENSIONS_TAB = {
    sidecarId: ns.EXTENSIONS_TAB_ID,
    displayName: 'Extensions',
    statusBadge: 'MANAGER',
    isVirtual: true,
    matchesWorkspace: true,
  };
  const SIDECHAT_TAB = {
    sidecarId: ns.SIDECHAT_TAB_ID,
    displayName: 'Side Chat',
    statusBadge: 'RUNNING',
    isVirtual: true,
    isSideChat: true,
    matchesWorkspace: true,
  };

  ns.partitionSplitTabs = function partitionSplitTabs(sidecars = [], layout = {}, terminals = null) {
    const popped = ns.getPoppedTerminalIds?.() || new Set();
    const customTitles = ns.readCustomTermTitles?.() || {};
    const grpMap = ns.readGroupMap?.() || {};
    const poppedSc = ns.getPoppedSideChatIds?.() || new Set();
    const customScTitles = ns.readCustomSideChatTitles?.() || {};
    const scGrpMap = ns.getSideChatGroupMap?.() || {};
    const pinnedSet = new Set(Array.isArray(layout?.pinnedTabIds) ? layout.pinnedTabIds : []);
    const closedSet = new Set(
      Array.isArray(layout?.closedTabIds) ? layout.closedTabIds.filter((id) => !pinnedSet.has(id)) : [],
    );
    const visibleTerms = Array.isArray(terminals)
      ? (layout?.showExternalTerminals === false ? terminals.filter((t) => !t?.isExternal) : terminals)
      : [];
    const termById = new Map(visibleTerms.map((t) => [t.terminalId, t]));
    const poppedList = Array.isArray(terminals)
      ? [...popped].filter((id) => termById.has(id)).map((id) => termById.get(id))
      : [...popped].map((terminalId) => ({ terminalId, title: 'Terminal' }));
    const poppedTabs = poppedList.map((t, idx) => {
      const sidecarId = `terminal__${t.terminalId}`;
      const grps = ns.readTabGroups?.(sidecarId) || [];
      const actGrp = grps.find((g) => g.groupId === (ns.getActiveGroupId?.(sidecarId) || '')) || grps[0] || null;
      const focTid = actGrp?.focusedPaneId || actGrp?.paneIds?.[0] || t.terminalId;
      const base = customTitles[focTid] || `Terminal ${idx + 2}`;
      const cnt = 1 + visibleTerms.filter((x) => x.terminalId !== t.terminalId && grpMap[x.terminalId] === t.terminalId).length;
      const isExternal = Boolean(
        t.isExternal || visibleTerms.some((x) => grpMap[x.terminalId] === t.terminalId && x.isExternal),
      );
      return {
        sidecarId,
        terminalId: t.terminalId,
        focusedTerminalId: focTid,
        displayName: cnt > 1 ? `${base} (${cnt})` : base,
        statusBadge: 'RUNNING',
        isVirtual: true,
        isTerminal: true,
        isExternal,
        matchesWorkspace: true,
      };
    });
    const scState = ns.getSideChatState?.();
    const allScThreads = scState?.threads || [];
    const poppedScTabs = [...poppedSc].map((rootId, idx) => {
      const sidecarId = `${ns.SIDECHAT_TAB_PREFIX}${rootId}`;
      const instThreads = allScThreads.filter((t) => t.cascadeId === rootId || scGrpMap[t.cascadeId] === rootId);
      const actCid = ns.getActiveSideChatId?.(sidecarId) || instThreads[0]?.cascadeId || rootId;
      const actThread = instThreads.find((t) => t.cascadeId === actCid) || instThreads[0] || null;
      const base = customScTitles[actCid] || actThread?.title || `Side Chat ${idx + 2}`;
      const cnt = Math.max(1, instThreads.length);
      return {
        sidecarId,
        sideChatId: rootId,
        activeSideChatId: actCid,
        displayName: cnt > 1 ? `${base} (${cnt})` : base,
        statusBadge: 'RUNNING',
        isVirtual: true,
        isSideChat: true,
        matchesWorkspace: true,
      };
    });
    const isTermBtn = layout?.terminalDisplayMode === 'button';
    const isExtBtn = layout?.extensionsDisplayMode === 'button';
    const unpoppedSc = ns.getInstanceSideChats ? ns.getInstanceSideChats(allScThreads, '') : allScThreads;
    const hasSideChat = Boolean(
      (scState?.isOpen || closedSet.has(ns.SIDECHAT_TAB_ID) || pinnedSet.has(ns.SIDECHAT_TAB_ID) || unpoppedSc.length > 0) &&
      (unpoppedSc.length > 0 || !poppedScTabs.length),
    );
    const hasMainTerm = typeof ns.isMainTerminalOpen === 'function'
      ? Boolean(ns.isMainTerminalOpen() || closedSet.has(ns.TERMINAL_TAB_ID) || pinnedSet.has(ns.TERMINAL_TAB_ID))
      : true;
    const virtualTabs = [
      ...(!isTermBtn && hasMainTerm ? [TERMINAL_TAB] : []),
      ...poppedTabs,
      ...(hasSideChat ? [SIDECHAT_TAB] : []),
      ...poppedScTabs,
      ...(isExtBtn ? [] : [EXTENSIONS_TAB]),
    ];
    const allTabs = [...sidecars.filter((sc) => sc.matchesWorkspace), ...virtualTabs].map((sc) => ({
      ...sc,
      isPinned: pinnedSet.has(sc.sidecarId),
      canClose: Boolean(sc.terminalId || sc.sideChatId || sc.isTerminal || sc.isSideChat),
    }));
    const orderIndex = new Map((Array.isArray(layout?.tabOrder) ? layout.tabOrder : []).map((id, idx) => [id, idx]));
    if (orderIndex.size > 0) {
      allTabs.sort((a, b) => (orderIndex.get(a.sidecarId) ?? 9999) - (orderIndex.get(b.sidecarId) ?? 9999));
    }
    const openTabs = allTabs.filter((sc) => !closedSet.has(sc.sidecarId));
    const closedTabs = allTabs.filter((sc) => closedSet.has(sc.sidecarId));
    const workspaceTabs = [...openTabs.filter((sc) => sc.isPinned), ...openTabs.filter((sc) => !sc.isPinned)];
    const defaultTopIds = layout?.pinnedTopSidecarId
      ? [layout.pinnedTopSidecarId]
      : (workspaceTabs[0] ? [workspaceTabs[0].sidecarId] : []);
    const topSet = new Set(Array.isArray(layout?.topSplitTabIds) ? layout.topSplitTabIds : defaultTopIds);
    const topTabs = workspaceTabs.filter((sc) => topSet.has(sc.sidecarId));
    const bottomTabs = workspaceTabs.filter((sc) => !topSet.has(sc.sidecarId));
    const specialBtnId = (isExtBtn && layout?.pinnedTopSidecarId === ns.EXTENSIONS_TAB_ID) ||
      (isTermBtn && hasMainTerm && layout?.pinnedTopSidecarId === ns.TERMINAL_TAB_ID)
      ? layout.pinnedTopSidecarId
      : '';
    const activeSingleId = specialBtnId ||
      workspaceTabs.find((sc) => sc.sidecarId === layout?.pinnedTopSidecarId)?.sidecarId ||
      workspaceTabs[0]?.sidecarId ||
      '';
    const activeTopId = specialBtnId ||
      topTabs.find((sc) => sc.sidecarId === layout?.pinnedTopSidecarId)?.sidecarId ||
      topTabs[0]?.sidecarId ||
      '';
    return { workspaceTabs, topTabs, bottomTabs, closedTabs, activeSingleId, activeTopId, topSet, pinnedSet, closedSet };
  };

  function buildStripItem(sc, activeId, opts) {
    const updCount = Number(opts.updateCount || 0);
    const badgeInfo = !sc.isVirtual && !sc.isTerminal && !sc.isSideChat
      ? ns.formatStatusBadge(sc.statusBadge, sc.isRunning, sc.isErrored)
      : null;
    const icon = sc.isTerminal
      ? 'terminal'
      : sc.isSideChat
        ? 'chat'
        : sc.isVirtual
          ? 'extension'
          : (sc.scope === 'global' ? 'globe' : 'folder');
    const pinSuffix = sc.isPinned ? ' · Pinned' : '';
    const title = sc.isTerminal
      ? `${sc.terminalId ? `${sc.displayName} (Terminal Session)` : 'Interactive Terminal'}${sc.isExternal ? ' · Opened outside Hangar (shared with Antigravity)' : ''}${pinSuffix}`
      : sc.isSideChat
        ? `${sc.displayName} (Tool-Enabled Terminal Side Chat)${pinSuffix}`
        : sc.isVirtual
          ? `${updCount > 0 ? `${sc.displayName} (${updCount} update${updCount === 1 ? '' : 's'} available)` : sc.displayName}${pinSuffix}`
          : `${sc.displayName} (${badgeInfo.label} · ${sc.scope === 'global' ? 'Global' : 'Workspace'}${pinSuffix})`;
    const statusDot = sc.isTerminal
      ? ''
      : sc.isSideChat
        ? 'running'
        : sc.isVirtual
          ? (updCount > 0 ? 'update' : '')
          : (badgeInfo.state || badgeInfo.cls || '');
    const isPoppedTerm = String(sc.sidecarId).startsWith('terminal__');
    const isPoppedSc = String(sc.sidecarId).startsWith(ns.SIDECHAT_TAB_PREFIX || 'sidechat__');
    const targetId = isPoppedTerm ? (sc.focusedTerminalId || sc.terminalId) : (sc.activeSideChatId || sc.sideChatId);
    const baseName = String(sc.displayName || '').replace(/\s+\(\d+\)$/, '');
    const renameValue = (isPoppedTerm ? ns.readCustomTermTitles?.()?.[targetId] : ns.readCustomSideChatTitles?.()?.[targetId]) || baseName;
    return {
      id: sc.sidecarId,
      sc,
      targetId,
      isPoppedTerm,
      isPoppedSc,
      displayName: sc.displayName,
      label: sc.displayName,
      icon,
      iconSize: sc.isTerminal || (sc.isVirtual && !sc.isSideChat) ? 16 : 15,
      active: sc.sidecarId === activeId,
      pinned: Boolean(sc.isPinned),
      closable: Boolean(sc.canClose && !sc.isPinned),
      closeTitle: ((sc.isSideChat && !sc.sideChatId) || (sc.isTerminal && !sc.terminalId)) ? 'Hide Tab' : 'Close Tab',
      externalBadge: Boolean(sc.isTerminal && sc.isExternal),
      externalTitle: 'Opened outside Hangar (shared with Antigravity)',
      statusDot,
      renamable: isPoppedTerm || isPoppedSc,
      renameValue,
      title,
      dataset: {
        sidecarId: sc.sidecarId,
        pane: opts.pane || 'single',
        pinned: sc.isPinned ? 'true' : 'false',
        testid: `tab-${sc.sidecarId}`,
      },
    };
  }

  function populateStrip(stripEl, tabs, activeId, opts) {
    if (!stripEl) return;
    const stripOpts = { ...opts, stripTabs: tabs };
    const items = tabs.map((sc) => buildStripItem(sc, activeId, stripOpts));
    const act = (payload) => stripOpts.onContextAction?.(payload);
    window.AgyUI?.reconcileTabStrip?.(stripEl, items, {
      idDatasetKey: 'sidecarId',
      emptyHint: 'Drag a tab here',
      addButton: {
        role: 'hub-add-tab',
        testId: 'hangar-new-tab-button',
        title: 'Open Terminal or Side Chat',
        onClick: (e, addBtn) => {
          e?.stopPropagation?.();
          const r = addBtn?.getBoundingClientRect?.() || { left: e?.clientX || 40, bottom: e?.clientY || 36 };
          const pane = stripOpts.pane || 'single';
          (window.AgyUI?.openContextMenu || ns.openTabContextMenu)?.(
            { clientX: r.left, clientY: (r.bottom || 36) + 4, target: addBtn, preventDefault() {}, stopPropagation() {} },
            [
              { id: 'new-terminal', icon: 'terminal', label: 'New Terminal', onClick: () => act({ action: 'new-terminal', pane }) },
              { id: 'new-sidechat', icon: 'chat', label: 'New Side Chat', onClick: () => act({ action: 'new-sidechat', pane }) },
            ],
          );
        },
      },
      onSelect: (id) => stripOpts.onClick?.(id),
      onUnpin: (id) => act({ action: 'toggle-pin', sidecarId: id }),
      onClose: (id) => act({ action: 'close', targetIds: [id], pane: stripOpts.pane || 'single' }),
      onRenameStart: () => ns._cancelTermFocus?.(),
      onRename: async (_id, next, item) => {
        if (item.isPoppedTerm) {
          ns.saveCustomTermTitle?.(item.targetId, next);
          await ns.apiCall('/api/terminal/rename', { terminalId: item.targetId, title: next }).catch(() => {});
        } else if (item.isPoppedSc) {
          ns.saveCustomSideChatTitle?.(item.targetId, next);
          await ns.apiCall('/api/sidechat/rename', { cascadeId: item.targetId, title: next }).catch(() => {});
        }
        ns.renderTabs?.();
      },
      onContextMenu: (curId, item, e) => {
        const curSc = item.sc;
        const isPinned = Boolean(curSc.isPinned);
        const isGlobal = curSc.scope === 'global';
        const pane = stripOpts.pane || 'single';
        const idx = tabs.findIndex((t) => t.sidecarId === curId);
        const others = tabs.filter((t) => t.sidecarId !== curId && !t.isPinned).map((t) => t.sidecarId);
        const right = (idx >= 0 ? tabs.slice(idx + 1) : []).filter((t) => !t.isPinned).map((t) => t.sidecarId);
        const scopeItems = !curSc.isVirtual && !curSc.isTerminal
          ? [
            {
              id: 'toggle-global',
              label: isGlobal ? 'Restrict to Current Workspace' : 'Show in All Workspaces (Global)',
              disabled: isGlobal && !stripOpts.hasActiveWorkspace,
              onClick: () => act({ action: 'toggle-global', sidecarId: curId }),
            },
            { separator: true },
          ]
          : [];
        const isDestructive = Boolean(
          curSc.canClose && !(curSc.isSideChat && !curSc.sideChatId) && !(curSc.isTerminal && !curSc.terminalId),
        );
        (window.AgyUI?.openContextMenu || ns.openTabContextMenu)?.(e, [
          {
            id: isPinned ? 'unpin-tab' : 'pin-tab',
            label: isPinned ? 'Unpin Tab' : 'Pin Tab',
            onClick: () => act({ action: 'toggle-pin', sidecarId: curId }),
          },
          ...scopeItems,
          {
            id: isDestructive ? 'close-tab' : 'hide-tab',
            label: isDestructive ? 'Close Tab' : 'Hide Tab',
            disabled: isPinned,
            onClick: () => act({ action: 'close', targetIds: [curId], pane }),
          },
          ...(curSc.isSideChat && !curSc.sideChatId
            ? [{ id: 'delete-sidechat', label: 'Delete Side Chat', onClick: () => act({ action: 'delete-sidechat', pane }) }]
            : []),
          {
            id: 'close-other-tabs',
            label: 'Close Other Tabs',
            disabled: !others.length,
            onClick: () => act({ action: 'close', targetIds: others, keepSidecarId: curId, pane }),
          },
          {
            id: 'close-tabs-to-the-right',
            label: 'Close Tabs to the Right',
            disabled: !right.length,
            onClick: () => act({ action: 'close', targetIds: right, keepSidecarId: curId, pane }),
          },
        ]);
      },
      bindDrag: (btn, item) => {
        Object.assign(btn, { _sc: item.sc, _opts: { ...btn._opts, ...stripOpts } });
        ns.bindHangarTabDrag?.(btn, item.sc);
      },
    });
    for (const ch of Array.from(stripEl.children || [])) {
      if (ch._item?.sc) Object.assign(ch, { _sc: ch._item.sc, _opts: { ...ch._opts, ...stripOpts } });
    }
    if (stripEl._lastActiveId !== activeId) {
      stripEl._lastActiveId = activeId;
      stripEl.querySelector?.('.agy-tab.active[data-sidecar-id]')?.scrollIntoView?.({
        inline: 'nearest',
        block: 'nearest',
        behavior: 'smooth',
      });
    }
    return items;
  }

  ns.renderTabBar = function renderTabBar(props) {
    if (ns.isPointerOnTab) return;
    const {
      tabStripEl,
      topOverflowBtnEl,
      bottomTabBarEl,
      bottomTabStripEl,
      bottomOverflowBtnEl,
      tabOverflowPopoverEl,
      terminalBtnEl,
      extensionsBtnEl,
      splitBtnEl,
      sidecars,
      terminals,
      registryPackages,
      hangar,
      bottomActiveTabId,
      layout,
      hasActiveWorkspace,
      onSelectTopSplitTab,
      onSelectBottomSplitTab,
      onDropTab,
      onPreviewTerminalSlot,
      onDropIntoTerminal,
      onContextAction,
    } = props;
    const splitEnabled = Boolean(layout?.splitViewEnabled);
    const regMap = new Map((registryPackages || []).map((p) => [p.id, p]));
    if (splitBtnEl) {
      splitBtnEl.classList.toggle('active', splitEnabled);
      splitBtnEl.setAttribute?.('aria-pressed', String(splitEnabled));
    }
    const updateCount = (sidecars || []).filter((s) => s.updateAvailable || regMap.get(s.sidecarId)?.updateAvailable).length +
      (hangar?.updateAvailable ? 1 : 0);
    const { workspaceTabs, topTabs, bottomTabs, closedTabs, activeSingleId, activeTopId } = ns.partitionSplitTabs(
      sidecars || [],
      layout,
      terminals || [],
    );
    const syncChromeBtn = (btnEl, isBtnMode, tabId) => {
      if (!btnEl) return;
      const isAct = (splitEnabled ? activeTopId : activeSingleId) === tabId || (splitEnabled && bottomActiveTabId === tabId);
      btnEl.classList.toggle('hidden', !isBtnMode);
      btnEl.classList.toggle('active', isBtnMode && isAct);
      btnEl.setAttribute?.('aria-pressed', String(Boolean(isBtnMode && isAct)));
    };
    syncChromeBtn(terminalBtnEl, layout?.terminalDisplayMode === 'button', ns.TERMINAL_TAB_ID);
    syncChromeBtn(extensionsBtnEl, layout?.extensionsDisplayMode === 'button', ns.EXTENSIONS_TAB_ID);
    if (extensionsBtnEl) {
      extensionsBtnEl.title = updateCount > 0
        ? `Extensions (${updateCount} update${updateCount === 1 ? '' : 's'} available)`
        : 'Extensions';
    }
    const baseOpts = {
      updateCount,
      hasActiveWorkspace: Boolean(hasActiveWorkspace),
      onDropTab,
      onPreviewTerminalSlot,
      onDropIntoTerminal,
      onContextAction,
    };
    const scrollFn = window.AgyUI?.setupStripScroll || ns.setupStripScroll;
    const syncStrip = (stripEl, overBtn, list, actId, pane, onClick) => {
      const stripOpts = { ...baseOpts, pane, splitEnabled, onClick };
      const items = populateStrip(stripEl, list, actId, stripOpts) || [];
      const closedItems = (closedTabs || []).map((sc) => buildStripItem(sc, actId, stripOpts));
      scrollFn?.(
        stripEl,
        overBtn,
        () => items,
        onClick,
        tabOverflowPopoverEl,
        () => closedItems,
        (sidecarId) => onContextAction?.({ action: 'reopen', sidecarId, pane }),
        { idDatasetKey: 'sidecarId' },
      );
    };
    if (!splitEnabled) {
      bottomTabBarEl?.classList.add('hidden');
      bottomOverflowBtnEl?.classList.add('hidden');
      syncStrip(tabStripEl, topOverflowBtnEl, workspaceTabs, activeSingleId, 'single', onSelectTopSplitTab);
    } else {
      syncStrip(tabStripEl, topOverflowBtnEl, topTabs, activeTopId, 'top', onSelectTopSplitTab);
      if (bottomTabBarEl && bottomTabStripEl) {
        bottomTabBarEl.classList.remove('hidden');
        syncStrip(bottomTabStripEl, bottomOverflowBtnEl, bottomTabs, bottomActiveTabId, 'bottom', onSelectBottomSplitTab);
      }
    }
  };
})();
