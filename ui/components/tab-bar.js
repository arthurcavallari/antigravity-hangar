/** @fileoverview Renders top and bottom Chrome tab bars for Antigravity Hangar via AgyUI.reconcileTabStrip. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  ns.EXTENSIONS_TAB_ID = '__extensions__';
  ns.TERMINAL_TAB_ID = ns.TERMINAL_TAB_ID || '__terminal__';
  ns.SIDECHAT_TAB_ID = ns.SIDECHAT_TAB_ID || '__sidechat__';
  ns.isSideChatTabId = ns.isSideChatTabId || ((tabId = '') => tabId === ns.SIDECHAT_TAB_ID);
  const normScTabId = ns.normalizeLegacySideChatTabId || ((id = '') => (
    String(id || '').startsWith('sidechat__') ? ns.SIDECHAT_TAB_ID : String(id || '')
  ));
  const normScTabList = ns.normalizeLegacySideChatTabList || ((arr) => (
    Array.isArray(arr) ? [...new Set(arr.map(normScTabId).filter(Boolean))] : []
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
    displayName: 'Side Questions',
    statusBadge: 'RUNNING',
    isVirtual: true,
    isSideChat: true,
    matchesWorkspace: true,
  };

  // What the Extensions tab and the top-bar button flag: a Hangar update, sidecar updates, and updates to plugins
  // Hangar installed. A plugin's registry entry has updateAvailable while it's behind the listed version or pin,
  // which also covers an automatic update that failed; a recorded failure counts even if the registry moved on.
  ns.countUpdates = function countUpdates({ sidecars = [], registryPackages = [], plugins = [], hangar = null } = {}) {
    const regMap = new Map((registryPackages || []).map((p) => [p.id, p]));
    const sidecarCount = (sidecars || []).filter((s) => s.updateAvailable || regMap.get(s.sidecarId)?.updateAvailable).length;
    const pluginIds = new Set(
      (registryPackages || []).filter((p) => p.kind === 'plugin' && p.updateAvailable).map((p) => p.id)
    );
    for (const p of plugins || []) if (p.updateError && p.pluginId) pluginIds.add(p.pluginId);
    return sidecarCount + pluginIds.size + (hangar?.updateAvailable ? 1 : 0);
  };

  // The top-bar button's version of the tab's blue dot, with the count in its spoken label too
  ns.syncUpdateIndicator = function syncUpdateIndicator(btnEl, updateCount = 0) {
    if (!btnEl) return;
    const label = updateCount > 0
      ? `Extensions (${updateCount} update${updateCount === 1 ? '' : 's'} available)`
      : 'Extensions';
    btnEl.classList.toggle('has-update', updateCount > 0);
    btnEl.title = label;
    btnEl.setAttribute?.('aria-label', label);
  };

  ns.partitionSplitTabs = function partitionSplitTabs(sidecars = [], layout = {}, terminals = null) {
    const popped = ns.getPoppedTerminalIds?.() || new Set();
    const customTitles = ns.readCustomTermTitles?.() || {};
    const grpMap = ns.readGroupMap?.() || {};
    const pinnedSet = new Set(normScTabList(layout?.pinnedTabIds));
    const closedSet = new Set(
      Array.isArray(layout?.closedTabIds)
        ? layout.closedTabIds
            .filter((id) => !String(id || '').startsWith('sidechat__'))
            .filter((id) => !pinnedSet.has(id))
        : [],
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
    const closedScThreads = scState?.closedThreads || [];
    const isTermBtn = layout?.terminalDisplayMode === 'button';
    const isExtBtn = layout?.extensionsDisplayMode === 'button';
    const hasSideChat = Boolean(
      scState?.isOpen ||
        closedSet.has(ns.SIDECHAT_TAB_ID) ||
        pinnedSet.has(ns.SIDECHAT_TAB_ID) ||
        allScThreads.length > 0 ||
        closedScThreads.length > 0,
    );
    const hasMainTerm = typeof ns.isMainTerminalOpen === 'function'
      ? Boolean(ns.isMainTerminalOpen() || closedSet.has(ns.TERMINAL_TAB_ID) || pinnedSet.has(ns.TERMINAL_TAB_ID))
      : true;
    const virtualTabs = [
      ...(!isTermBtn && hasMainTerm ? [TERMINAL_TAB] : []),
      ...poppedTabs,
      ...(hasSideChat ? [SIDECHAT_TAB] : []),
      ...(isExtBtn ? [] : [EXTENSIONS_TAB]),
    ];
    const allTabs = [...sidecars.filter((sc) => sc.matchesWorkspace), ...virtualTabs].map((sc) => ({
      ...sc,
      isPinned: pinnedSet.has(sc.sidecarId),
      canClose: Boolean(sc.terminalId || sc.isTerminal || sc.isSideChat),
    }));
    const orderIndex = new Map(normScTabList(layout?.tabOrder).map((id, idx) => [id, idx]));
    if (orderIndex.size > 0) {
      allTabs.sort((a, b) => (orderIndex.get(a.sidecarId) ?? 9999) - (orderIndex.get(b.sidecarId) ?? 9999));
    }
    const openTabs = allTabs.filter((sc) => !closedSet.has(sc.sidecarId));
    const closedTabs = allTabs.filter((sc) => closedSet.has(sc.sidecarId));
    const workspaceTabs = [...openTabs.filter((sc) => sc.isPinned), ...openTabs.filter((sc) => !sc.isPinned)];
    const effectivePinnedTop = normScTabId(layout?.pinnedTopSidecarId);
    const defaultTopIds = effectivePinnedTop
      ? [effectivePinnedTop]
      : (workspaceTabs[0] ? [workspaceTabs[0].sidecarId] : []);
    const topSet = new Set(Array.isArray(layout?.topSplitTabIds) ? normScTabList(layout.topSplitTabIds) : defaultTopIds);
    const topTabs = workspaceTabs.filter((sc) => topSet.has(sc.sidecarId));
    const bottomTabs = workspaceTabs.filter((sc) => !topSet.has(sc.sidecarId));
    const specialBtnId = (isExtBtn && effectivePinnedTop === ns.EXTENSIONS_TAB_ID) ||
      (isTermBtn && hasMainTerm && effectivePinnedTop === ns.TERMINAL_TAB_ID)
      ? effectivePinnedTop
      : '';
    const activeSingleId = specialBtnId ||
      workspaceTabs.find((sc) => sc.sidecarId === effectivePinnedTop)?.sidecarId ||
      workspaceTabs[0]?.sidecarId ||
      '';
    const activeTopId = specialBtnId ||
      topTabs.find((sc) => sc.sidecarId === effectivePinnedTop)?.sidecarId ||
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
        ? `${sc.displayName} (Tool-Enabled Side Question Threads)${pinSuffix}`
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
    const targetId = isPoppedTerm ? (sc.focusedTerminalId || sc.terminalId) : '';
    const baseName = String(sc.displayName || '').replace(/\s+\(\d+\)$/, '');
    const renameValue = (isPoppedTerm ? ns.readCustomTermTitles?.()?.[targetId] : '') || baseName;
    return {
      id: sc.sidecarId,
      sc,
      targetId,
      isPoppedTerm,
      displayName: sc.displayName,
      label: sc.displayName,
      icon,
      iconSize: 16,
      active: sc.sidecarId === activeId,
      pinned: Boolean(sc.isPinned),
      closable: Boolean(sc.canClose && !sc.isPinned),
      closeTitle: (sc.isSideChat || (sc.isTerminal && !sc.terminalId)) ? 'Hide Tab' : 'Close Tab',
      externalBadge: Boolean(sc.isTerminal && sc.isExternal),
      externalTitle: 'Opened outside Hangar (shared with Antigravity)',
      statusDot,
      renamable: isPoppedTerm,
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
        title: 'Open Terminal or Side Question',
        onClick: (e, addBtn) => {
          e?.stopPropagation?.();
          const r = addBtn?.getBoundingClientRect?.() || { left: e?.clientX || 40, bottom: e?.clientY || 36 };
          const pane = stripOpts.pane || 'single';
          (window.AgyUI?.openContextMenu || ns.openTabContextMenu)?.(
            { clientX: r.left, clientY: (r.bottom || 36) + 4, target: addBtn, preventDefault() {}, stopPropagation() {} },
            [
              { id: 'new-terminal', icon: 'terminal', label: 'New Terminal', onClick: () => act({ action: 'new-terminal', pane }) },
              { id: 'new-sidechat', icon: 'chat', label: 'New Side Question', onClick: () => act({ action: 'new-sidechat', pane }) },
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
          curSc.canClose && !curSc.isSideChat && !(curSc.isTerminal && !curSc.terminalId),
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
      plugins,
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
    if (splitBtnEl) {
      splitBtnEl.classList.toggle('active', splitEnabled);
      splitBtnEl.setAttribute?.('aria-pressed', String(splitEnabled));
    }
    const updateCount = ns.countUpdates({ sidecars, registryPackages, plugins, hangar });
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
    ns.syncUpdateIndicator(extensionsBtnEl, updateCount);
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
