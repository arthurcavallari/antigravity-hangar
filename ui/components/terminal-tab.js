/** @fileoverview Dual-engine Interactive Terminal view (Direct VT100 + Native jetbox_web) with TabGroups and split panes. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  const termStore = ns.terminalStore;
  const instanceControllers = termStore?.instances || ns._termInstances;
  const sharedPanes = termStore?.sharedPanes || ns._termSharedPanes;

  function createInstanceController(instanceTabId, rootId = '') {
    let tabGroups = ns.readTabGroups(instanceTabId);
    let activeGroupId = tabGroups[0]?.groupId || rootId || '';
    let pendingSplit = null;
    let engineMode = ns.readEngineMode();
    let terminals = [];
    let workspacePath = '';
    let conversationId = '';
    let callbacks = {};
    let pollBusy = false;
    let isVisible = null;
    let pendingFocus = false;
    let slotKey = 'top';
    let isRenaming = false;

    const rootEl = Object.assign(document.createElement('div'), { className: 'term-shell' });
    rootEl.dataset.instanceTabId = instanceTabId;
    ns.setHtml(
      rootEl,
      ns.html`
        <div class="term-toolbar">
          <agy-tab-strip class="agy-tab-strip" data-role="sessions" aria-label="Terminal sessions"></agy-tab-strip>
          <div class="term-toolbar-actions">
            <button
              type="button"
              class="agy-icon-btn"
              data-action="split"
              data-testid="terminal-split-button"
              title="Split Terminal"
            >${ns.iconSvg('splitscreen_vertical_add', 15)}</button>
            <button
              type="button"
              class="agy-icon-btn"
              data-action="popout"
              title="${rootId ? 'Merge back into main Terminal tab' : 'Pin Terminal Tab to Top Bar'}"
            >${ns.iconSvg('dock_to_right', 14)}</button>
          </div>
        </div>
        <div class="term-stage" data-role="stage"></div>
      `
    );

    const toolbarEl = rootEl.querySelector('.term-toolbar');
    const actionsEl = rootEl.querySelector('.term-toolbar-actions');
    const sessionsEl = rootEl.querySelector('[data-role="sessions"]');
    const stageEl = rootEl.querySelector('[data-role="stage"]');
    const popoutBtn = rootEl.querySelector('[data-action="popout"]');
    const splitBtn = rootEl.querySelector('[data-action="split"]');

    const getActiveGroup = () => tabGroups.find((g) => g.groupId === activeGroupId) || tabGroups[0] || null;
    const getActiveTid = () => getActiveGroup()?.focusedPaneId || terminals[0]?.terminalId || '';
    const getActiveTerm = () => terminals.find((t) => t.terminalId === getActiveTid()) || terminals[0] || null;
    const getVisibleIds = () => getActiveGroup()?.paneIds || [];
    const resolveTitle = (tid, fb = 'pwsh') => {
      const custom = ns.readCustomTermTitles?.()?.[tid];
      if (custom) return custom;
      const raw = sharedPanes.get(tid)?.title || terminals.find((x) => x.terminalId === tid)?.title || fb;
      return ns.formatTermTitle(raw);
    };

    const saveGroups = () => {
      ns.setActiveGroupId?.(instanceTabId, activeGroupId);
      ns.saveTabGroups(instanceTabId, tabGroups);
    };

    const refreshView = (notify = false) => {
      engineMode = ns.readEngineMode();
      renderToolbar();
      renderStage();
      if (notify && rootId) {
        callbacks.onSessionChange?.();
      }
    };

    const focusPane = (tid, delayMs = 0) => ns._focusTermPane(tid, engineMode, delayMs);

    const applyDropResult = (drag, dropTarget) => {
      if (drag?.instanceTabId && drag.instanceTabId !== instanceTabId) {
        const merged = ns.mergeTermDragIntoInstance?.(drag, {
          ...dropTarget,
          targetInstanceTabId: instanceTabId,
          pane: slotKey,
        });
        callbacks.onCrossInstanceMerge?.(merged);
        return;
      }
      const res = ns.applyTerminalDrop(tabGroups, drag, dropTarget);
      tabGroups = res.groups;
      activeGroupId = res.activeGroupId || activeGroupId;
      saveGroups();
      refreshView(true);
      focusPane(getActiveTid());
      pollVisiblePanes();
    };

    sessionsEl.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && sessionsEl.scrollWidth > sessionsEl.clientWidth) {
        e.preventDefault();
      }
      if (e.defaultPrevented) {
        sessionsEl.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    function normalizeGroupState() {
      const prevIds = tabGroups.map((g) => g.groupId);
      const prevAct = activeGroupId || ns.getActiveGroupId?.(instanceTabId) || '';
      const res = ns.reconcileTabGroups(ns.readTabGroups(instanceTabId), terminals, pendingSplit);
      const storedAct = ns.getActiveGroupId?.(instanceTabId);
      tabGroups = res.groups;
      if (res.consumedPending) {
        pendingSplit = null;
      }
      const nextSet = new Set(tabGroups.map((g) => g.groupId));
      const idx = prevAct ? prevIds.indexOf(prevAct) : -1;
      if (storedAct && nextSet.has(storedAct)) {
        activeGroupId = storedAct;
      } else if (activeGroupId && nextSet.has(activeGroupId)) {
        // keep current activeGroupId
      } else {
        const nextAfterPrev = idx >= 0 ? prevIds.slice(idx + 1).find((id) => nextSet.has(id)) : '';
        const fallbackIdx = idx >= 0 ? tabGroups.length - 1 : 0;
        activeGroupId = nextAfterPrev || tabGroups[fallbackIdx]?.groupId || '';
      }
      saveGroups();
    }

    function setFocusedPane(tid, focusInput = false) {
      const g = tabGroups.find((grp) => grp.paneIds.includes(tid));
      if (!g) return;
      const changed = activeGroupId !== g.groupId || g.focusedPaneId !== tid;
      g.focusedPaneId = tid;
      activeGroupId = g.groupId;
      saveGroups();
      const vis = getVisibleIds();
      vis.forEach((id) => {
        sharedPanes.get(id)?.wrap.classList.toggle('is-focused-pane', id === tid && vis.length > 1);
        sharedPanes.get(id)?.dotEl?.classList.toggle('active', id === tid);
      });
      if (changed) {
        refreshView(true);
      }
      if (focusInput) {
        focusPane(tid);
      }
    }

    const closeTerminalsByIds = (tids = []) =>
      ns._closeInstanceTerminalsByIds(tids, {
        rootId,
        instanceTabId,
        slotKey: () => slotKey,
        getTerminals: () => terminals,
        setTerminals: (next) => {
          terminals = next;
        },
        normalizeGroupState,
        refreshView,
        getActiveTid,
        focusPane,
        callbacks: () => callbacks,
      });

    const commitRename = (tid, rawNext) => {
      const next = String(rawNext || '').trim();
      isRenaming = false;
      ns.saveCustomTermTitle?.(tid, next);
      ns.apiCall?.('/api/terminal/rename', { terminalId: tid, title: next })?.catch?.(() => {});
      refreshView(true);
      focusPane(getActiveTid());
    };

    const ensureDirectPane = (tid) =>
      ns._ensureDirectTermPane(tid, {
        instanceTabId,
        sessionsEl,
        stageEl,
        close: closeTerminalsByIds,
        focus: setFocusedPane,
        getTitle: resolveTitle,
        getEngineMode: () => engineMode,
        getConversationId: () => (conversationId && conversationId !== '_new' ? conversationId : ''),
        getActiveGroupId: () => getActiveGroup()?.groupId || '',
        getSlotKey: () => slotKey,
        onSameInstanceDrop: applyDropResult,
        onTitle: (id, next) => {
          const term = terminals.find((x) => x.terminalId === id);
          if (term) {
            term.title = next;
          }
          renderToolbar();
        },
      });

    function renderToolbar() {
      engineMode = ns.readEngineMode();
      if (
        ns.activeTermDrag?.instanceTabId === instanceTabId ||
        ns.pointerTermInstanceId === instanceTabId ||
        isRenaming
      ) {
        return;
      }
      const activeGrp = getActiveGroup();
      const visibleIds = getVisibleIds();
      const hasSessions = tabGroups.length > 0;
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
        ns._cancelTermFocus?.();
        const live = pill?.isConnected === false
          ? Array.from(sessionsEl.children || sessionsEl.childNodes || []).find((c) => c.dataset?.termTid === tid)
          : pill;
        const lbl = !isRenaming && live?.isConnected !== false
          ? (live?._slots?.labelEl || live?.querySelector?.('.agy-tab-label'))
          : null;
        if (!lbl) return;
        isRenaming = true;
        ns.startInlineRename?.(live, lbl, {
          initialValue: resolveTitle(tid),
          inputClassName: 'agy-rename-input',
          onCommit: (v) => commitRename(tid, v),
          onCancel: () => {
            isRenaming = false;
            refreshView(false);
          },
        });
      };

      const stripItems = tabGroups.map((grp, gIdx) => {
        const focTid = grp.focusedPaneId || grp.paneIds[0];
        const isPinned = Boolean(grp.pinned);
        const t = terminals.find((x) => x.terminalId === focTid);
        const isExt = grp.paneIds.some((pid) => terminals.find((x) => x.terminalId === pid)?.isExternal);
        const cleanTitle = resolveTitle(focTid, t?.title || 'pwsh');
        return {
          id: focTid,
          grp,
          gIdx,
          label: cleanTitle,
          icon: 'terminal',
          iconSize: 16,
          active: grp.groupId === activeGrp?.groupId,
          pinned: isPinned,
          closable: !isPinned,
          renamable: true,
          badgeText: grp.paneIds.length > 1 ? `(${grp.paneIds.length})` : '',
          externalBadge: isExt,
          title: `${cleanTitle}${t?.cwd ? ` — ${t.cwd}` : ''}${isExt ? ' · Opened outside Hangar (shared with Antigravity)' : ''}${isPinned ? ' · Pinned' : ''} (Drag to reorder, split, or move across Hangar)`,
          dataset: {
            termTid: focTid,
            pinned: isPinned ? 'true' : 'false',
            external: isExt ? 'true' : 'false',
            testid: `terminal-tab-${focTid}`,
          },
        };
      });

      const toggleEngine = () => {
        ns.saveEngineMode(engineMode === 'jetbox' ? 'direct' : 'jetbox');
        refreshView();
        schedulePollLoop();
      };

      const closeOthers = (grpId, others) => {
        activeGroupId = grpId;
        ns.setActiveGroupId?.(instanceTabId, activeGroupId);
        closeTerminalsByIds(others.flatMap((g) => g.paneIds));
      };

      const selectGroup = (grp, pill) => {
        if (!grp || isRenaming) return;
        ns._userActivatedTerminal = true;
        if (activeGroupId !== grp.groupId) {
          activeGroupId = grp.groupId;
          ns.setActiveGroupId?.(instanceTabId, activeGroupId);
          Array.from(sessionsEl.children || sessionsEl.childNodes || []).forEach((c) => {
            c.classList?.toggle?.('active', c === pill || c._item?.grp?.groupId === grp.groupId);
          });
          renderStage();
          if (rootId) {
            callbacks.onSessionChange?.();
          }
        }
        focusPane(getActiveTid(), 220);
        pollVisiblePanes();
      };

      window.AgyUI?.reconcileTabStrip?.(sessionsEl, stripItems, {
        idDatasetKey: 'termTid',
        emptyHint: 'Drop a terminal tab here',
        addButton: hasSessions
          ? {
              role: 'term-add-tab',
              testId: 'aux-pane-new-tab-button',
              title: 'New Terminal Tab',
              onClick: () => spawnTerminal(''),
            }
          : null,
        onSelect: (_id, item, _e, pill) => selectGroup(item?.grp, pill),
        onClose: (_id, item) => closeTerminalsByIds(item.grp.paneIds),
        onUnpin: (_id, item) => togglePin(item.grp),
        onRenameStart: () => {
          ns._cancelTermFocus?.();
          isRenaming = true;
        },
        onRenameCancel: () => {
          isRenaming = false;
          focusPane(getActiveTid());
        },
        onRename: commitRename,
        onContextMenu: (_id, item, e, pill) => {
          const grp = item.grp;
          const focTid = grp.focusedPaneId || grp.paneIds[0];
          const isPinned = Boolean(grp.pinned);
          const t = terminals.find((x) => x.terminalId === focTid);
          const others = tabGroups.filter((g) => g.groupId !== grp.groupId && !g.pinned);
          const right = tabGroups.slice(item.gIdx + 1).filter((g) => !g.pinned);
          const getQuote = () => {
            const selContent = (
              engineMode === 'jetbox'
                ? sharedPanes.get(focTid)?.jetboxSelection
                : sharedPanes.get(focTid)?.emu?.getSelection()
            ) || '';
            return ns.copyTerminalQuoteToClipboard({
              terminalId: focTid,
              title: resolveTitle(focTid, t?.title || 'pwsh'),
              selectionContent: selContent,
            });
          };
          ns.openTabContextMenu?.(e, [
            { id: isPinned ? 'unpin-tab' : 'pin-tab', label: isPinned ? 'Unpin Tab' : 'Pin Tab', onClick: () => togglePin(grp) },
            { id: 'rename-tab', label: 'Rename Terminal…', onClick: () => startRename(pill, focTid) },
            { id: 'split-tab', label: 'Split Terminal Right', onClick: () => spawnTerminal(focTid) },
            {
              id: 'quote-tab',
              label: 'Quote Terminal in Chat',
              onClick: () => ns.showTerminalQuoteToast?.(rootEl, `Copied @${getQuote().cleanName} mention pill — press Ctrl+V in chat`),
            },
            {
              id: 'quote-ask-tab',
              label: 'Quote & Ask Agent…',
              onClick: () =>
                ns.openTerminalMiniComposer?.(rootEl, getQuote(), {
                  conversationId: conversationId && conversationId !== '_new' ? conversationId : (t?.conversationId || ''),
                }),
            },
            {
              id: 'toggle-engine',
              label: engineMode === 'jetbox' ? 'Switch to Direct VT100 Engine' : 'Switch to Native Terminal Engine',
              onClick: toggleEngine,
            },
            { separator: true },
            { id: 'close-tab', label: 'Close Tab', disabled: isPinned, onClick: () => closeTerminalsByIds(grp.paneIds) },
            { id: 'close-other-tabs', label: 'Close Other Tabs', disabled: !others.length, onClick: () => closeOthers(grp.groupId, others) },
            {
              id: 'close-tabs-to-the-right',
              label: 'Close Tabs to the Right',
              disabled: !right.length,
              onClick: () => closeTerminalsByIds(right.flatMap((g) => g.paneIds)),
            },
          ]);
        },
        bindDrag: (pill, item) =>
          ns.bindTermPointerDrag?.(pill, {
            kind: 'tab',
            groupId: () => (pill._item || item).grp.groupId,
            terminalId: () => (pill._item || item).id,
            instanceTabId,
            sessionsEl,
            stageEl,
            getActiveGroupId: () => getActiveGroup()?.groupId || '',
            getSlotKey: () => slotKey,
            onClick: () => selectGroup((pill._item || item).grp, pill),
            onSameInstanceDrop: applyDropResult,
          }),
      });
    }

    const renderStage = () =>
      ns._renderTermStagePanes({
        stageEl,
        active: getActiveTerm(),
        activeTid: getActiveTid(),
        visibleIds: getVisibleIds(),
        terminals,
        engineMode,
        conversationId,
        isVisible: () => isVisible,
        getActiveTid,
        resolveTitle,
        focusPane,
        ensurePane: ensureDirectPane,
        onSpawnEmpty: () => spawnTerminal(),
      });

    async function spawnTerminal(splitFromId = '') {
      const activeTid = getActiveTid();
      const activeGrp = getActiveGroup();
      const sRect = stageEl.getBoundingClientRect?.() || { width: 0, height: 0 };
      const paneCount = (activeGrp?.paneIds?.length || 1) + 1;
      const paneW = sRect.width > 80 ? (splitFromId ? sRect.width / paneCount : sRect.width) : 0;
      const directEmu = engineMode === 'direct' ? sharedPanes.get(activeTid)?.emu : null;
      const dims = directEmu
        ? directEmu.getDimensions()
        : {
            cols: paneW ? Math.max(24, Math.min(240, Math.floor((paneW - 24) / 7.6))) : 0,
            rows: sRect.height > 40 ? Math.max(6, Math.min(120, Math.floor((sRect.height - 16) / 17))) : 0,
          };
      if (splitFromId && activeGrp) {
        pendingSplit = { groupId: activeGrp.groupId, afterPaneId: splitFromId };
      }
      const created = await ns.apiCall('/api/terminal/create', {
        workspacePath,
        conversationId,
        splitFromTerminalId: splitFromId || '',
        cols: dims.cols,
        rows: dims.rows,
      });
      if (!created?.terminalId) {
        pendingSplit = null;
        return;
      }
      created.title = ns.formatTermTitle(created.title || 'pwsh');
      if (rootId) {
        ns.saveGroupMap({ ...ns.readGroupMap(), [created.terminalId]: rootId });
      }
      terminals = [...terminals.filter((t) => t.terminalId !== created.terminalId), created];
      if (splitFromId && activeGrp) {
        activeGroupId = activeGrp.groupId;
        tabGroups = ns.insertSplitPane(tabGroups, activeGroupId, splitFromId, created.terminalId);
        pendingSplit = null;
        saveGroups();
      } else {
        activeGroupId = created.terminalId;
        ns.setActiveGroupId?.(instanceTabId, activeGroupId);
        normalizeGroupState();
      }
      refreshView();
      ns._userActivatedTerminal = true;
      focusPane(created.terminalId);
      pollVisiblePanes();
      await callbacks.onRefreshState?.();
    }

    splitBtn?.addEventListener('click', () => {
      const tid = getActiveTid();
      if (tid) {
        spawnTerminal(tid);
      }
    });

    popoutBtn?.addEventListener('click', () => {
      const activeGrp = getActiveGroup();
      if (!activeGrp?.paneIds.length) return;
      if (rootId) {
        ns.demoteHangarTabIntoInstance(instanceTabId, { targetInstanceTabId: ns.TERMINAL_TAB_ID, zone: 'strip' });
        if (callbacks.onCrossInstanceMerge) {
          callbacks.onCrossInstanceMerge({
            removedSidecarId: instanceTabId,
            targetInstanceTabId: ns.TERMINAL_TAB_ID,
            targetPane: slotKey,
          });
        } else {
          callbacks.onSelectTab?.(ns.TERMINAL_TAB_ID, slotKey);
        }
        return;
      }
      const paneSet = new Set(activeGrp.paneIds);
      const res = ns.promoteDragToHangarBar({
        kind: 'tab',
        groupId: activeGrp.groupId,
        terminalId: getActiveTid(),
        instanceTabId,
      });
      paneSet.forEach((tid) => {
        const pane = sharedPanes.get(tid);
        if (pane?.wrap) {
          pane.wrap._mountedParent = null;
          pane.wrap.remove?.();
        }
      });
      terminals = terminals.filter((t) => !paneSet.has(t.terminalId));
      normalizeGroupState();
      refreshView();
      if (res?.newSidecarId) {
        if (callbacks.onPromoteToHangarTab) {
          callbacks.onPromoteToHangarTab({
            sidecarId: res.newSidecarId,
            replacedSidecarId: res.replacedSidecarId,
            targetPane: slotKey,
            afterTabId: instanceTabId,
          });
        } else {
          callbacks.onSelectTab?.(res.newSidecarId, slotKey);
        }
      }
    });

    let pollTimer = null;
    let idlePollStreak = 0;
    let disposed = false;

    const stopPollLoop = () => {
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    const isEffectivelyVisible = () => Boolean(isVisible && !ns.isHostHidden?.());

    const schedulePollLoop = () => {
      stopPollLoop();
      engineMode = ns.readEngineMode();
      if (disposed || !isEffectivelyVisible() || engineMode !== 'direct') return;
      const delayMs = idlePollStreak >= 3 ? 220 : 70;
      pollTimer = setTimeout(async () => {
        pollTimer = null;
        await pollVisiblePanes();
        schedulePollLoop();
      }, delayMs);
      pollTimer?.unref?.();
    };

    async function pollVisiblePanes() {
      engineMode = ns.readEngineMode();
      if (pollBusy || !isEffectivelyVisible() || engineMode !== 'direct') return false;
      pollBusy = true;
      try {
        const active = await ns._pollVisibleTermPanes({ visibleIds: getVisibleIds(), terminals, resolveTitle, renderToolbar });
        idlePollStreak = active ? 0 : Math.min(10, idlePollStreak + 1);
        return active;
      } finally {
        pollBusy = false;
      }
    }

    const postJetboxVisibility = () => {
      const msgType = isEffectivelyVisible() ? 'hangar-jetbox-shown' : 'hangar-jetbox-hidden';
      for (const tid of getVisibleIds()) {
        try {
          sharedPanes.get(tid)?.frame?.contentWindow?.postMessage({ type: msgType, focus: false }, '*');
        } catch {
          /* ignore */
        }
      }
    };

    return {
      rootEl,
      syncHostVisibility: () => {
        postJetboxVisibility();
        schedulePollLoop();
      },
      setVisible: (vis) => {
        const nextVis = Boolean(vis);
        if (isVisible === false && nextVis) {
          ns._userActivatedTerminal = true;
          pendingFocus = true;
          idlePollStreak = 0;
        }
        const changed = nextVis !== isVisible;
        isVisible = nextVis;
        if (changed) {
          postJetboxVisibility();
        }
        schedulePollLoop();
      },
      focusTerminal: (tid) => {
        tabGroups = ns.readTabGroups(instanceTabId);
        const g = tabGroups.find((grp) => grp.paneIds.includes(tid));
        if (g) {
          g.focusedPaneId = tid;
          activeGroupId = g.groupId;
          pendingFocus = true;
          saveGroups();
        }
      },
      mountInto: (slotEl, nextSlotKey) => {
        slotKey = nextSlotKey;
        if (!slotEl.contains?.(rootEl)) {
          slotEl.appendChild(rootEl);
        }
        Array.from(slotEl.children || []).forEach((ch) => ch.classList?.toggle?.('hidden', ch !== rootEl));
      },
      sync: ({ nextTerminals, nextWorkspacePath = '', nextConversationId = '', cb = {} }) => {
        terminals = (Array.isArray(nextTerminals) ? nextTerminals : []).map((t) => {
          const clean = ns.formatTermTitle(t.title || 'pwsh');
          const shared = sharedPanes.get(t.terminalId);
          if (shared && t.title) {
            shared.title = clean;
          }
          return { ...t, title: clean };
        });
        workspacePath = nextWorkspacePath;
        callbacks = cb;
        conversationId = nextConversationId;
        normalizeGroupState();
        refreshView();
        if (pendingFocus && isVisible) {
          pendingFocus = false;
          const actTid = getActiveTid();
          if (actTid) {
            focusPane(actTid);
          }
        }
        pollVisiblePanes();
        schedulePollLoop();
      },
      handleJetboxEvent: (type, payload = {}, sourceWin) =>
        ns._handleJetboxTermEvent(type, payload, sourceWin, {
          visibleIds: getVisibleIds(),
          terminals,
          rootEl,
          conversationId,
          getActiveTerm,
          setFocusedPane,
          resolveTitle,
          renderToolbar,
        }),
      dispose: () => {
        disposed = true;
        stopPollLoop();
        rootEl.remove?.();
      },
    };
  }

  ns.renderTerminalSlots = function renderTerminalSlots({
    topTermEl,
    bottomTermEl,
    topSlotId,
    bottomSlotId,
    splitEnabled,
    terminals = [],
    workspacePath = '',
    conversationId = '',
    ...cb
  }) {
    const liveTerms = (terminals || []).filter((t) => !ns.isTerminalClosing(t.terminalId));
    const activeTabIds = new Set();
    const popped = ns.getPoppedTerminalIds();
    const liveIds = new Set(liveTerms.map((t) => t.terminalId));
    if (liveTerms.length > 0) {
      ns._disposeTermPanes([...sharedPanes.keys()].filter((tid) => !liveIds.has(tid)));
    }
    const slots = [
      { key: 'top', el: topTermEl, tabId: topSlotId, slotClass: 'slot-top' },
      {
        key: 'bottom',
        el: bottomTermEl,
        tabId: splitEnabled && bottomSlotId !== topSlotId ? bottomSlotId : '',
        slotClass: 'slot-bottom',
      },
    ];
    for (const s of slots) {
      if (!s.el) continue;
      const vis = ns.isTerminalTabId(s.tabId);
      s.el.classList.toggle('hidden', !vis);
      s.el.classList.toggle(s.slotClass, vis);
      if (!vis) continue;
      activeTabIds.add(s.tabId);
      const rootId = String(s.tabId).startsWith(ns.TERMINAL_TAB_PREFIX)
        ? String(s.tabId).slice(ns.TERMINAL_TAB_PREFIX.length)
        : '';
      if (!instanceControllers.has(s.tabId)) {
        instanceControllers.set(s.tabId, createInstanceController(s.tabId, rootId));
      }
      const ctrl = instanceControllers.get(s.tabId);
      ctrl.mountInto(s.el, s.key);
      ctrl.setVisible(true);
      ctrl.sync({
        nextTerminals: ns.getInstanceTerminals(liveTerms, rootId),
        nextWorkspacePath: workspacePath,
        nextConversationId: conversationId,
        cb,
      });
    }
    for (const [tabId, ctrl] of instanceControllers.entries()) {
      if (!activeTabIds.has(tabId)) {
        ctrl.setVisible(false);
      }
      if (
        !activeTabIds.has(tabId) &&
        tabId !== ns.TERMINAL_TAB_ID &&
        !popped.has(tabId.slice(ns.TERMINAL_TAB_PREFIX.length))
      ) {
        ns.disposeTerminalInstance(tabId);
      }
    }
  };

  ns.syncTerminalVisibility = () => {
    instanceControllers.forEach((ctrl) => ctrl.syncHostVisibility?.());
  };
})();
