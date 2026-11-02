/** @fileoverview Renders top and bottom Chrome tab bars using Antigravity 2.0's C5 AuxPaneTab layout, Material Symbols SVGs, scroll fade, and overflow popover. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  ns.EXTENSIONS_TAB_ID = '__extensions__'; ns.TERMINAL_TAB_ID = ns.TERMINAL_TAB_ID || '__terminal__'; ns.SIDECHAT_TAB_ID = ns.SIDECHAT_TAB_ID || '__sidechat__';
  ns.SIDECHAT_TAB_PREFIX = ns.SIDECHAT_TAB_PREFIX || 'sidechat__';
  ns.isSideChatTabId = ns.isSideChatTabId || ((tabId = '') => tabId === ns.SIDECHAT_TAB_ID || String(tabId || '').startsWith(ns.SIDECHAT_TAB_PREFIX));
  const TERMINAL_TAB = { sidecarId: ns.TERMINAL_TAB_ID, displayName: 'Terminal', statusBadge: 'TERMINAL', isVirtual: true, isTerminal: true, matchesWorkspace: true };
  const EXTENSIONS_TAB = { sidecarId: ns.EXTENSIONS_TAB_ID, displayName: 'Extensions', statusBadge: 'MANAGER', isVirtual: true, matchesWorkspace: true };
  const SIDECHAT_TAB = { sidecarId: ns.SIDECHAT_TAB_ID, displayName: 'Side Chat', statusBadge: 'RUNNING', isVirtual: true, isSideChat: true, matchesWorkspace: true };

  ns.partitionSplitTabs = function partitionSplitTabs(sidecars = [], layout = {}, terminals = []) {
    const popped = ns.getPoppedTerminalIds?.() || new Set(), customTitles = ns.readCustomTermTitles?.() || {}, grpMap = ns.readGroupMap?.() || {};
    const poppedSc = ns.getPoppedSideChatIds?.() || new Set(), customScTitles = ns.readCustomSideChatTitles?.() || {}, scGrpMap = ns.getSideChatGroupMap?.() || {};
    const pinnedSet = new Set(Array.isArray(layout?.pinnedTabIds) ? layout.pinnedTabIds : []), closedSet = new Set(Array.isArray(layout?.closedTabIds) ? layout.closedTabIds.filter((id) => !pinnedSet.has(id)) : []);
    const visibleTerminals = layout?.showExternalTerminals === false ? (terminals || []).filter((t) => !t?.isExternal) : (terminals || []);
    const termById = new Map(visibleTerminals.map((t) => [t.terminalId, t]));
    const poppedList = (terminals || []).length ? [...popped].filter((id) => termById.has(id)).map((id) => termById.get(id)) : [...popped].map((terminalId) => ({ terminalId, title: 'Terminal' }));
    const poppedTabs = poppedList.map((t, idx) => {
      const sidecarId = `terminal__${t.terminalId}`, grps = ns.readTabGroups?.(sidecarId) || [], actGid = ns.getActiveGroupId?.(sidecarId) || '';
      const actGrp = grps.find((g) => g.groupId === actGid) || grps[0] || null, focTid = actGrp?.focusedPaneId || actGrp?.paneIds?.[0] || t.terminalId;
      const base = customTitles[focTid] || `Terminal ${idx + 2}`, cnt = 1 + visibleTerminals.filter((x) => x.terminalId !== t.terminalId && grpMap[x.terminalId] === t.terminalId).length;
      const isExternal = Boolean(t.isExternal || visibleTerminals.some((x) => grpMap[x.terminalId] === t.terminalId && x.isExternal));
      return { sidecarId, terminalId: t.terminalId, displayName: cnt > 1 ? `${base} (${cnt})` : base, statusBadge: 'RUNNING', isVirtual: true, isTerminal: true, isExternal, matchesWorkspace: true };
    });
    const scState = ns.getSideChatState?.(), allScThreads = scState?.threads || [];
    const poppedScTabs = [...poppedSc].map((rootId, idx) => {
      const sidecarId = `${ns.SIDECHAT_TAB_PREFIX}${rootId}`;
      const instThreads = allScThreads.filter((t) => t.cascadeId === rootId || scGrpMap[t.cascadeId] === rootId);
      const actCid = ns.getActiveSideChatId?.(sidecarId) || instThreads[0]?.cascadeId || rootId;
      const actThread = instThreads.find((t) => t.cascadeId === actCid) || instThreads[0] || null;
      const base = customScTitles[actCid] || actThread?.title || `Side Chat ${idx + 2}`;
      const cnt = Math.max(1, instThreads.length);
      return { sidecarId, sideChatId: rootId, displayName: cnt > 1 ? `${base} (${cnt})` : base, statusBadge: 'RUNNING', isVirtual: true, isSideChat: true, matchesWorkspace: true };
    });
    const isTermBtn = layout?.terminalDisplayMode === 'button';
    const isExtBtn = layout?.extensionsDisplayMode === 'button';
    const unpoppedSc = ns.getInstanceSideChats ? ns.getInstanceSideChats(allScThreads, '') : allScThreads;
    const hasSideChat = Boolean((scState?.isOpen || closedSet.has(ns.SIDECHAT_TAB_ID) || pinnedSet.has(ns.SIDECHAT_TAB_ID) || unpoppedSc.length > 0) && (unpoppedSc.length > 0 || !poppedScTabs.length));
    const hasMainTerm = typeof ns.isMainTerminalOpen === 'function' ? Boolean(ns.isMainTerminalOpen() || closedSet.has(ns.TERMINAL_TAB_ID) || pinnedSet.has(ns.TERMINAL_TAB_ID)) : true;
    const virtualTabs = [...(!isTermBtn && hasMainTerm ? [TERMINAL_TAB] : []), ...poppedTabs, ...(hasSideChat ? [SIDECHAT_TAB] : []), ...poppedScTabs, ...(isExtBtn ? [] : [EXTENSIONS_TAB])];
    const allTabs = [...sidecars.filter((sc) => sc.matchesWorkspace), ...virtualTabs].map((sc) => ({ ...sc, isPinned: pinnedSet.has(sc.sidecarId), canClose: Boolean(sc.terminalId || sc.sideChatId || sc.isTerminal || sc.isSideChat) }));
    const tabOrder = Array.isArray(layout?.tabOrder) ? layout.tabOrder : [], orderIndex = new Map(tabOrder.map((id, idx) => [id, idx]));
    if (tabOrder.length > 0) allTabs.sort((a, b) => (orderIndex.get(a.sidecarId) ?? 9999) - (orderIndex.get(b.sidecarId) ?? 9999));
    const openTabs = allTabs.filter((sc) => !closedSet.has(sc.sidecarId)), closedTabs = allTabs.filter((sc) => closedSet.has(sc.sidecarId));
    const workspaceTabs = [...openTabs.filter((sc) => sc.isPinned), ...openTabs.filter((sc) => !sc.isPinned)];
    const rawTopIds = Array.isArray(layout?.topSplitTabIds) ? layout.topSplitTabIds : layout?.pinnedTopSidecarId ? [layout.pinnedTopSidecarId] : workspaceTabs[0] ? [workspaceTabs[0].sidecarId] : [];
    const topSet = new Set(rawTopIds), topTabs = workspaceTabs.filter((sc) => topSet.has(sc.sidecarId)), bottomTabs = workspaceTabs.filter((sc) => !topSet.has(sc.sidecarId));
    const specialBtnId = (isExtBtn && layout?.pinnedTopSidecarId === ns.EXTENSIONS_TAB_ID) || (isTermBtn && layout?.pinnedTopSidecarId === ns.TERMINAL_TAB_ID) ? layout.pinnedTopSidecarId : '';
    const activeSingleId = specialBtnId || workspaceTabs.find((sc) => sc.sidecarId === layout?.pinnedTopSidecarId)?.sidecarId || workspaceTabs[0]?.sidecarId || '';
    const activeTopId = specialBtnId || topTabs.find((sc) => sc.sidecarId === layout?.pinnedTopSidecarId)?.sidecarId || topTabs[0]?.sidecarId || '';
    return { workspaceTabs, topTabs, bottomTabs, closedTabs, activeSingleId, activeTopId, topSet, pinnedSet, closedSet };
  };

  function cleanupAllDragGhosts() {
    ns.isPointerOnTab = false; ns.pointerTermInstanceId = ''; ns.pointerSideChatInstanceId = ''; ns.clearAllTermDropIndicators?.();
    document.querySelectorAll('.tab-drag-ghost').forEach((el) => el.remove());
    document.querySelectorAll('.hub-tab, .term-session-pill, .sidechat-session-pill').forEach((el) => { el.classList.remove('is-dragging-source', 'merge-drop-target'); if (ns.setTabShift) ns.setTabShift(el, 0); else el.style.transform = ''; });
    document.body.classList.remove('dragging-tab');
    document.querySelectorAll('.split-drop-target').forEach((el) => el.classList.remove('split-drop-target'));
  }
  window.addEventListener('blur', cleanupAllDragGhosts);

  ns.measureStrip = function measureStrip(sourceStrip, btn, startX, startY, selector = '.hub-tab[data-sidecar-id]') {
    const sourceTabs = Array.from(sourceStrip?.querySelectorAll?.(selector) || []), centers = [], rects = [];
    let minLeft = Infinity, maxRight = -Infinity, gap = 0, prevRight = null;
    sourceTabs.forEach((el) => {
      const r = el.getBoundingClientRect(); rects.push(r); centers.push(r.left + r.width / 2);
      minLeft = Math.min(minLeft, r.left); maxRight = Math.max(maxRight, r.right);
      if (prevRight !== null && gap === 0) gap = Math.max(0, r.left - prevRight);
      prevRight = r.right;
    });
    const sRect = sourceStrip?.getBoundingClientRect?.() || { left: 0, right: 0, top: 0, bottom: 0 }, dRect = rects[sourceTabs.indexOf(btn)] || btn.getBoundingClientRect();
    return {
      sourceStrip, sourceTabs, draggedIndex: sourceTabs.indexOf(btn), centers, startScrollLeft: sourceStrip?.scrollLeft || 0,
      draggedWidth: dRect.width, draggedHeight: dRect.height, grabOffsetX: startX - dRect.left, grabOffsetY: startY - dRect.top,
      originalTop: dRect.top, minLeft: Math.max(minLeft, sRect.left), maxLeft: Math.max(sRect.left, Math.min(maxRight, sRect.right) - dRect.width),
      draggedSlot: dRect.width + (gap || 1), locked: true, lockChangedAt: null,
    };
  };

  function updateSidecarTabButton(btn, sc, isActive, opts = {}) {
    btn._sc = sc; btn._opts = opts; btn.dataset.pane = opts.pane || 'single'; btn.dataset.pinned = sc.isPinned ? 'true' : 'false'; btn.classList.toggle('active', Boolean(isActive));
    const iconSlot = btn.querySelector('.hub-tab-icon-slot'), label = btn.querySelector('[data-role="tab-label"]'), extBadge = btn.querySelector('[data-role="tab-ext-badge"]'), dot = btn.querySelector('[data-role="tab-dot"]'), pinEl = btn.querySelector('[data-role="tab-pin"]'), closeWrapEl = btn.querySelector('[data-role="tab-close-wrap"]'), closeEl = btn.querySelector('[data-role="tab-close"]'), pinSuffix = sc.isPinned ? ' · Pinned' : '';
    if (extBadge) { const showExt = Boolean(sc.isTerminal && sc.isExternal); extBadge.className = showExt ? 'term-external-badge' : 'term-external-badge hidden'; if (showExt && !extBadge.innerHTML) { extBadge.innerHTML = ns.iconSvg('open_in_new', 11); extBadge.title = 'Opened outside Hangar (shared with Antigravity)'; } }
    if (pinEl) { pinEl.className = sc.isPinned ? 'hub-tab-pin' : 'hub-tab-pin hidden'; if (sc.isPinned && !pinEl.innerHTML) { pinEl.innerHTML = ns.iconSvg('keep', 16); pinEl.title = 'Unpin Tab'; } }
    if (closeWrapEl && closeEl) { const showClose = Boolean(sc.canClose && !sc.isPinned); closeWrapEl.className = showClose ? 'hub-tab-close-wrap' : 'hub-tab-close-wrap hidden'; if (showClose) { if (!closeEl.innerHTML) closeEl.innerHTML = ns.iconSvg('close', 14); closeEl.title = ((sc.isSideChat && !sc.sideChatId) || (sc.isTerminal && !sc.terminalId)) ? 'Hide Tab' : 'Close Tab'; } }
    if (sc.isTerminal) {
      const extSuffix = sc.isExternal ? ' · Opened outside Hangar (shared with Antigravity)' : '';
      btn.title = `${sc.terminalId ? `${sc.displayName} (Terminal Session)` : 'Interactive Terminal'}${extSuffix}${pinSuffix}`;
      if (iconSlot && iconSlot.dataset.icon !== 'terminal') { iconSlot.dataset.icon = 'terminal'; iconSlot.innerHTML = ns.iconSvg('terminal', 16); }
      if (label && label.textContent !== sc.displayName) label.textContent = sc.displayName;
      if (dot) dot.className = 'status-dot hidden'; return;
    }
    if (sc.isSideChat) {
      btn.title = `${sc.displayName} (Tool-Enabled Terminal Side Chat)${pinSuffix}`;
      if (iconSlot && iconSlot.dataset.icon !== 'chat') { iconSlot.dataset.icon = 'chat'; iconSlot.innerHTML = ns.iconSvg('chat', 15); }
      if (label && label.textContent !== sc.displayName) label.textContent = sc.displayName;
      if (dot) dot.className = 'status-dot running'; return;
    }
    if (sc.isVirtual) {
      const updCount = Number(opts.updateCount || 0);
      btn.title = `${updCount > 0 ? `${sc.displayName} (${updCount} update${updCount === 1 ? '' : 's'} available)` : sc.displayName}${pinSuffix}`;
      if (iconSlot && iconSlot.dataset.icon !== 'extension') { iconSlot.dataset.icon = 'extension'; iconSlot.innerHTML = ns.iconSvg('extension', 16); }
      if (label && label.textContent !== sc.displayName) label.textContent = sc.displayName;
      if (dot) dot.className = updCount > 0 ? 'status-dot update' : 'status-dot hidden'; return;
    }
    const badgeInfo = ns.formatStatusBadge(sc.statusBadge, sc.isRunning, sc.isErrored), isGlobal = sc.scope === 'global', iconName = isGlobal ? 'globe' : 'folder';
    btn.title = `${sc.displayName} (${badgeInfo.label} · ${isGlobal ? 'Global' : 'Workspace'}${pinSuffix})`;
    if (iconSlot && iconSlot.dataset.icon !== iconName) { iconSlot.dataset.icon = iconName; iconSlot.innerHTML = ns.iconSvg(iconName, 15); }
    if (label && label.textContent !== sc.displayName) label.textContent = sc.displayName;
    if (dot) dot.className = `status-dot ${badgeInfo.state}`;
  }

  function createSidecarTabButton(sc, isActive, opts = {}) {
    const btn = document.createElement('button'), iconSlot = document.createElement('span'), label = document.createElement('span'), extBadge = document.createElement('span'), dot = document.createElement('span'), pinEl = document.createElement('span'), closeWrapEl = document.createElement('span'), closeEl = document.createElement('span');
    btn.type = 'button'; btn.className = 'hub-tab'; btn.dataset.sidecarId = sc.sidecarId;
    iconSlot.className = 'hub-tab-icon-slot'; label.className = 'hub-tab-label'; label.dataset.role = 'tab-label'; extBadge.dataset.role = 'tab-ext-badge'; dot.dataset.role = 'tab-dot'; pinEl.dataset.role = 'tab-pin'; closeWrapEl.dataset.role = 'tab-close-wrap'; closeEl.className = 'hub-tab-close'; closeEl.dataset.role = 'tab-close';
    closeWrapEl.appendChild(closeEl);
    btn.append(iconSlot, label, extBadge, dot, pinEl, closeWrapEl);
    updateSidecarTabButton(btn, sc, isActive, opts);
    pinEl.addEventListener('click', (e) => { e.stopPropagation(); btn._opts?.onContextAction?.({ action: 'toggle-pin', sidecarId: btn._sc?.sidecarId || sc.sidecarId }); });
    closeEl.addEventListener('click', (e) => { e.stopPropagation(); btn._opts?.onContextAction?.({ action: 'close', targetIds: [btn._sc?.sidecarId || sc.sidecarId], pane: btn._opts?.pane || 'single' }); });
    btn.addEventListener('auxclick', (e) => { if (e.button === 1 && !btn._sc?.isPinned) { e.preventDefault(); e.stopPropagation(); btn._opts?.onContextAction?.({ action: 'close', targetIds: [btn._sc?.sidecarId || sc.sidecarId], pane: btn._opts?.pane || 'single' }); } });
    btn.addEventListener('contextmenu', (e) => {
      const curSc = btn._sc || sc, curId = curSc.sidecarId, canClose = Boolean(curSc.canClose), isPinned = Boolean(curSc.isPinned), isGlobal = curSc.scope === 'global', pane = btn._opts?.pane || 'single';
      const stripTabs = btn._opts?.stripTabs || [], idx = stripTabs.findIndex((t) => t.sidecarId === curId);
      const others = stripTabs.filter((t) => t.sidecarId !== curId && !t.isPinned).map((t) => t.sidecarId);
      const right = (idx >= 0 ? stripTabs.slice(idx + 1) : []).filter((t) => !t.isPinned).map((t) => t.sidecarId);
      const scopeItems = !curSc.isVirtual && !curSc.isTerminal ? [
        { id: 'toggle-global', label: isGlobal ? 'Restrict to Current Workspace' : 'Show in All Workspaces (Global)', disabled: isGlobal && !btn._opts?.hasActiveWorkspace, onClick: () => btn._opts?.onContextAction?.({ action: 'toggle-global', sidecarId: curId }) },
        { separator: true },
      ] : [];
      const isCloseDestructive = Boolean(canClose && !(curSc.isSideChat && !curSc.sideChatId) && !(curSc.isTerminal && !curSc.terminalId));
      ns.openTabContextMenu?.(e, [
        { id: isPinned ? 'unpin-tab' : 'pin-tab', label: isPinned ? 'Unpin Tab' : 'Pin Tab', onClick: () => btn._opts?.onContextAction?.({ action: 'toggle-pin', sidecarId: curId }) },
        ...scopeItems,
        { id: isCloseDestructive ? 'close-tab' : 'hide-tab', label: isCloseDestructive ? 'Close Tab' : 'Hide Tab', disabled: isPinned, onClick: () => btn._opts?.onContextAction?.({ action: 'close', targetIds: [curId], pane }) },
        ...(curSc.isSideChat && !curSc.sideChatId ? [{ id: 'delete-sidechat', label: 'Delete Side Chat', onClick: () => btn._opts?.onContextAction?.({ action: 'delete-sidechat', pane }) }] : []),
        { id: 'close-other-tabs', label: 'Close Other Tabs', disabled: !others.length, onClick: () => btn._opts?.onContextAction?.({ action: 'close', targetIds: others, keepSidecarId: curId, pane }) },
        { id: 'close-tabs-to-the-right', label: 'Close Tabs to the Right', disabled: !right.length, onClick: () => btn._opts?.onContextAction?.({ action: 'close', targetIds: right, keepSidecarId: curId, pane }) },
      ]);
    });
    let activePointerId = null, startX = 0, startY = 0, isDragging = false, ghostEl = null, targetPane = 'single', beforeTabId = null, dragMeta = null;
    let termDropTarget = null, hoverTimer = null, hoverTargetId = '', previewedTargetId = '';
    const clearHoverTimer = () => { if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; } hoverTargetId = ''; };

    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target?.closest?.('[data-role="tab-pin"], [data-role="tab-close"], [data-role="tab-close-wrap"]')) return;
      cleanupAllDragGhosts(); clearHoverTimer(); previewedTargetId = ''; activePointerId = e.pointerId; ns.isPointerOnTab = true;
      startX = e.clientX; startY = e.clientY; isDragging = false; targetPane = btn._opts?.pane || 'single'; beforeTabId = null; dragMeta = null; termDropTarget = null;
      btn.setPointerCapture?.(e.pointerId);
      window.addEventListener?.('pointerup', onWinPointerEnd, true); window.addEventListener?.('pointercancel', onWinPointerCancel, true);
    });
    btn.addEventListener('pointermove', (e) => {
      if (activePointerId !== e.pointerId) return;
      const pane = btn._opts?.pane || 'single', splitEnabled = Boolean(btn._opts?.splitEnabled), curId = btn._sc?.sidecarId || sc.sidecarId;
      if (!isDragging && Math.hypot(e.clientX - startX, e.clientY - startY) > 4) {
        isDragging = true; document.body.classList.add('dragging-tab');
        dragMeta = ns.measureStrip(btn.parentElement, btn, startX, startY);
        btn.classList.add('is-dragging-source');
        ghostEl = btn.cloneNode(true); ghostEl.className = 'hub-tab active tab-drag-ghost';
        ghostEl.style.width = `${dragMeta.draggedWidth}px`; ghostEl.style.height = `${dragMeta.draggedHeight}px`;
        document.body.appendChild(ghostEl);
      }
      if (!isDragging || !ghostEl || !dragMeta) return;
      document.querySelectorAll('.split-drop-target').forEach((el) => el.classList.remove('split-drop-target'));
      const handleRect = splitEnabled ? document.getElementById('split-resize-handle')?.getBoundingClientRect() : null;
      targetPane = !splitEnabled ? 'single' : e.clientY < (handleRect ? handleRect.top + handleRect.height / 2 : window.innerHeight / 2) ? 'top' : 'bottom';
      const stripRect = dragMeta.sourceStrip.getBoundingClientRect(), nextLocked = targetPane === pane && (e.clientY >= stripRect.top - 18 && e.clientY <= stripRect.bottom + 18);
      if (nextLocked !== dragMeta.locked) { dragMeta.locked = nextLocked; dragMeta.lockChangedAt = performance.now(); }
      const rawLeft = e.clientX - dragMeta.grabOffsetX, left = dragMeta.locked ? Math.min(Math.max(rawLeft, dragMeta.minLeft), dragMeta.maxLeft) : rawLeft;
      ghostEl.style.transition = dragMeta.lockChangedAt && performance.now() - dragMeta.lockChangedAt < 120 ? 'top 120ms ease-out, left 120ms ease-out' : '';
      ghostEl.style.left = `${left}px`; ghostEl.style.top = `${dragMeta.locked ? dragMeta.originalTop : e.clientY - dragMeta.grabOffsetY}px`;
      const probeX = dragMeta.locked ? left + dragMeta.draggedWidth / 2 : e.clientX;
      termDropTarget = btn._sc?.isTerminal
        ? ns.inspectHangarPointerOverTerminal?.(probeX, e.clientY, curId, !dragMeta.locked)
        : btn._sc?.isSideChat
          ? ns.inspectHangarPointerOverSideChat?.(probeX, e.clientY, curId, !dragMeta.locked)
          : null;
      if (termDropTarget) {
        if (termDropTarget.zone === 'hub-tab' && hoverTargetId !== termDropTarget.targetInstanceTabId) {
          clearHoverTimer(); hoverTargetId = termDropTarget.targetInstanceTabId;
          hoverTimer = setTimeout(() => { hoverTimer = null; previewedTargetId = termDropTarget.targetInstanceTabId; btn._opts?.onPreviewTerminalSlot?.(termDropTarget.targetInstanceTabId, termDropTarget.pane); }, 350);
        } else if (termDropTarget.zone !== 'hub-tab') clearHoverTimer();
        document.querySelectorAll('.hub-tab').forEach((el) => { const idx = dragMeta.sourceTabs.indexOf(el); ns.setTabShift?.(el, !dragMeta.locked && idx > dragMeta.draggedIndex ? -dragMeta.draggedSlot : 0); });
        return;
      }
      clearHoverTimer(); if (previewedTargetId) { previewedTargetId = ''; btn._opts?.onPreviewTerminalSlot?.('', pane); }
      if (targetPane === pane) {
        if (dragMeta.sourceStrip.scrollWidth > dragMeta.sourceStrip.clientWidth) {
          if (e.clientX < stripRect.left + 26) dragMeta.sourceStrip.scrollLeft -= 10;
          else if (e.clientX > stripRect.right - 26) dragMeta.sourceStrip.scrollLeft += 10;
        }
        document.getElementById(pane === 'top' ? 'bottom-tab-strip' : 'tab-strip')?.querySelectorAll('.hub-tab').forEach((el) => (ns.setTabShift ? ns.setTabShift(el, 0) : (el.style.transform = '')));
        const x = e.clientX - dragMeta.grabOffsetX + dragMeta.draggedWidth / 2, scrollDelta = dragMeta.sourceStrip.scrollLeft - dragMeta.startScrollLeft;
        const pinnedCount = dragMeta.sourceTabs.filter((t) => t.dataset.pinned === 'true').length, isPin = Boolean(btn._sc?.isPinned);
        let dropIndex = dragMeta.draggedIndex;
        for (let i = 0; i < dragMeta.centers.length; i++) {
          const sameKindMerge = (btn._sc?.isTerminal && dragMeta.sourceTabs[i]?._sc?.isTerminal) || (btn._sc?.isSideChat && dragMeta.sourceTabs[i]?._sc?.isSideChat);
          const c = dragMeta.centers[i] - scrollDelta, span = dragMeta.draggedWidth * (sameKindMerge ? -0.38 : 0.5);
          if (i < dragMeta.draggedIndex && x < c + span) dropIndex = Math.min(dropIndex, i);
          else if (i > dragMeta.draggedIndex && x > c - span) dropIndex = Math.max(dropIndex, i);
        }
        dropIndex = isPin ? Math.min(dropIndex, Math.max(0, pinnedCount - 1)) : Math.max(dropIndex, pinnedCount);
        dragMeta.sourceTabs.forEach((el, i) => {
          if (i === dragMeta.draggedIndex) return;
          const shift = (dragMeta.draggedIndex < dropIndex && i > dragMeta.draggedIndex && i <= dropIndex) ? -dragMeta.draggedSlot
            : (dragMeta.draggedIndex > dropIndex && i >= dropIndex && i < dragMeta.draggedIndex) ? dragMeta.draggedSlot : 0;
          if (ns.setTabShift) ns.setTabShift(el, shift); else el.style.transform = shift ? `translateX(${shift}px)` : '';
        });
        const otherIds = dragMeta.sourceTabs.filter((_, idx) => idx !== dragMeta.draggedIndex).map((el) => el.dataset.sidecarId);
        beforeTabId = dropIndex < otherIds.length ? otherIds[dropIndex] : null;
      } else {
        dragMeta.sourceTabs.forEach((el, i) => { if (i !== dragMeta.draggedIndex) { const s = i > dragMeta.draggedIndex ? -dragMeta.draggedSlot : 0; if (ns.setTabShift) ns.setTabShift(el, s); else el.style.transform = s ? `translateX(${s}px)` : ''; } });
        const tBar = document.getElementById(targetPane === 'top' ? 'chrome-bar' : 'bottom-tab-bar'), tRect = tBar?.getBoundingClientRect();
        const inBar = !tRect || !tRect.height || (e.clientY >= tRect.top - 14 && e.clientY <= tRect.bottom + 4), isPin = Boolean(btn._sc?.isPinned);
        const targetSibs = Array.from(document.getElementById(targetPane === 'top' ? 'tab-strip' : 'bottom-tab-strip')?.querySelectorAll('.hub-tab[data-sidecar-id]') || []);
        beforeTabId = null;
        targetSibs.forEach((sib) => {
          const sibPin = sib.dataset.pinned === 'true', r = ns.getUnshiftedRect ? ns.getUnshiftedRect(sib) : sib.getBoundingClientRect();
          const sameKindTarget = (btn._sc?.isTerminal && ns.isTerminalTabId?.(sib.dataset.sidecarId)) || (btn._sc?.isSideChat && ns.isSideChatTabId?.(sib.dataset.sidecarId));
          if (inBar && beforeTabId === null && ((isPin && !sibPin) || (isPin === sibPin && e.clientX < r.left + r.width * (sameKindTarget ? 0.12 : 0.5)))) beforeTabId = sib.dataset.sidecarId;
          const s = inBar && beforeTabId !== null ? dragMeta.draggedSlot : 0; if (ns.setTabShift) ns.setTabShift(sib, s); else sib.style.transform = s ? `translateX(${s}px)` : '';
        });
        tBar?.classList.add('split-drop-target'); if (!inBar) document.querySelector(targetPane === 'top' ? '.slot-top:not(.hidden)' : '.slot-bottom:not(.hidden)')?.classList.add('split-drop-target');
      }
    });

    const endPointer = (e, cancelled = false) => {
      if (activePointerId !== e.pointerId) return;
      window.removeEventListener?.('pointerup', onWinPointerEnd, true); window.removeEventListener?.('pointercancel', onWinPointerCancel, true);
      const wasDragging = isDragging, pane = btn._opts?.pane || 'single', curId = btn._sc?.sidecarId || sc.sidecarId, finalTermDrop = termDropTarget;
      activePointerId = null; isDragging = false; ghostEl = null; dragMeta = null; termDropTarget = null; clearHoverTimer();
      try { if (btn.hasPointerCapture?.(e.pointerId)) btn.releasePointerCapture(e.pointerId); } catch {}
      cleanupAllDragGhosts();
      if (!cancelled) {
        if (!wasDragging) { btn.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' }); btn._opts?.onClick?.(curId); }
        else if (finalTermDrop && btn._opts?.onDropIntoTerminal) btn._opts.onDropIntoTerminal({ sourceSidecarId: curId, ...finalTermDrop });
        else btn._opts?.onDropTab?.({ sidecarId: curId, sourcePane: pane, targetPane, beforeTabId });
      } else if (wasDragging) btn._opts?.onPreviewTerminalSlot?.('', pane);
    };
    const onWinPointerEnd = (e) => endPointer(e, false), onWinPointerCancel = (e) => endPointer(e, true);
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((evt) => btn.addEventListener(evt, (e) => endPointer(e, evt !== 'pointerup')));
    return btn;
  }
  function setupStripScroll(stripEl, overflowBtnEl, getTabs, onSelectTab, popoverEl, getClosedTabs, onReopenTab) {
    if (!stripEl) return;
    if (overflowBtnEl) { overflowBtnEl._getTabs = getTabs; overflowBtnEl._onSelectTab = onSelectTab; overflowBtnEl._getClosedTabs = getClosedTabs; overflowBtnEl._onReopenTab = onReopenTab; }
    const update = () => {
      const { scrollLeft, scrollWidth, clientWidth } = stripEl, hasOverflow = scrollWidth > clientWidth + 1;
      const closedList = overflowBtnEl?._getClosedTabs?.() || [], hiddenCount = closedList.length, showBtn = hasOverflow || (stripEl.id !== 'bottom-tab-strip' && hiddenCount > 0);
      if (overflowBtnEl) {
        overflowBtnEl.classList.toggle('hidden', !showBtn); overflowBtnEl.classList.toggle('has-hidden-tabs', hiddenCount > 0);
        let badgeEl = overflowBtnEl.querySelector?.('.tab-overflow-badge');
        if (hiddenCount > 0) {
          if (!badgeEl && overflowBtnEl.appendChild) { badgeEl = document.createElement('span'); badgeEl.className = 'tab-overflow-badge'; overflowBtnEl.appendChild(badgeEl); }
          if (badgeEl) badgeEl.textContent = String(hiddenCount);
          overflowBtnEl.title = `${hasOverflow ? 'More tabs · ' : ''}${hiddenCount} hidden tab${hiddenCount === 1 ? '' : 's'}: ${closedList.map((t) => t.displayName).join(', ')}`;
        } else { badgeEl?.remove?.(); overflowBtnEl.title = 'More tabs'; }
      }
      if (!hasOverflow) { stripEl.style.webkitMaskImage = stripEl.style.maskImage = 'none'; return; }
      const atStart = scrollLeft <= 2, atEnd = scrollLeft + clientWidth >= scrollWidth - 2;
      stripEl.style.webkitMaskImage = stripEl.style.maskImage = (!atStart && !atEnd) ? 'linear-gradient(to right, transparent, black 38px, black calc(100% - 38px), transparent)'
        : (atStart && !atEnd) ? 'linear-gradient(to right, black calc(100% - 38px), transparent)' : (!atStart && atEnd) ? 'linear-gradient(to right, transparent, black 38px)' : 'none';
    };
    stripEl._updateScroll = update;
    if (!stripEl._scrollBound) {
      stripEl._scrollBound = true; stripEl.addEventListener('scroll', () => stripEl._updateScroll?.(), { passive: true });
      stripEl.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && stripEl.scrollWidth > stripEl.clientWidth) { e.preventDefault(); stripEl.scrollLeft += e.deltaY; } }, { passive: false });
      if (window.ResizeObserver) new ResizeObserver(() => stripEl._updateScroll?.()).observe(stripEl);
      if (window.MutationObserver) new MutationObserver(() => stripEl._updateScroll?.()).observe(stripEl, { childList: true, subtree: true, characterData: true });
    }
    update();
    if (overflowBtnEl && popoverEl && !overflowBtnEl._popoverBound) {
      overflowBtnEl._popoverBound = true;
      overflowBtnEl.addEventListener('pointerdown', () => { overflowBtnEl._wasOpenOnDown = Boolean(popoverEl.matches?.(':popover-open') && popoverEl._anchorBtn === overflowBtnEl); });
      overflowBtnEl.addEventListener('click', (e) => {
        e.stopPropagation(); if (overflowBtnEl._wasOpenOnDown) { try { popoverEl.hidePopover?.(); } catch {} return; }
        popoverEl._anchorBtn = overflowBtnEl;
        const r = overflowBtnEl.getBoundingClientRect(), spaceBelow = window.innerHeight - r.bottom - 8, flipUp = spaceBelow < 180 && r.top > spaceBelow;
        popoverEl.style.top = flipUp ? 'auto' : `${r.bottom + 4}px`; popoverEl.style.bottom = flipUp ? `${window.innerHeight - r.top + 4}px` : 'auto';
        popoverEl.style.maxHeight = `${Math.max(120, (flipUp ? r.top : window.innerHeight - r.bottom) - 12)}px`;
        popoverEl.style.left = `${Math.max(8, Math.min(window.innerWidth - 230, r.right - 220))}px`;
        const activeId = stripEl.querySelector('.hub-tab.active')?.dataset.sidecarId, hasOverflow = stripEl.scrollWidth > stripEl.clientWidth + 1;
        popoverEl.innerHTML = '';
        const appendItem = (tab, isClosed) => {
          const item = document.createElement('button'), left = document.createElement('span'), icon = document.createElement('span'), title = document.createElement('span');
          item.type = 'button'; item.className = `tab-overflow-item${isClosed ? ' is-hidden-tab' : tab.sidecarId === activeId ? ' active' : ''}`;
          left.className = 'tab-overflow-item-left'; icon.className = 'hub-tab-icon-slot'; title.className = 'tab-overflow-item-title';
          icon.innerHTML = ns.iconSvg(tab.isTerminal ? 'terminal' : tab.isSideChat ? 'chat' : tab.isVirtual ? 'extension' : (tab.scope === 'global' ? 'globe' : 'folder'), 15);
          title.textContent = tab.displayName; left.append(icon, title); item.append(left);
          if (isClosed) { item.title = `Show ${tab.displayName}`; const pill = document.createElement('span'); pill.className = 'tab-overflow-restore'; pill.textContent = 'Show'; item.append(pill); }
          else if (!tab.isVirtual) { const badge = ns.formatStatusBadge(tab.statusBadge, tab.isRunning, tab.isErrored), dot = document.createElement('span'); dot.className = `status-dot ${badge.state}`; item.append(dot); }
          else if (!tab.isTerminal && overflowBtnEl._updateCount > 0) { const dot = document.createElement('span'); dot.className = 'status-dot update'; item.append(dot); }
          if (!isClosed && tab.isPinned) { const pin = document.createElement('span'); pin.className = 'hub-tab-pin'; pin.innerHTML = ns.iconSvg('keep', 12); item.append(pin); }
          item.addEventListener('click', () => { popoverEl.hidePopover?.(); if (isClosed) overflowBtnEl._onReopenTab?.(tab.sidecarId); else { overflowBtnEl._onSelectTab?.(tab.sidecarId); stripEl.querySelector(`.hub-tab[data-sidecar-id="${CSS.escape(tab.sidecarId)}"]`)?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' }); } });
          popoverEl.appendChild(item);
        };
        if (hasOverflow) for (const tab of overflowBtnEl._getTabs?.() || []) appendItem(tab, false);
        const closedList = overflowBtnEl._getClosedTabs?.() || [];
        if (closedList.length) { const hdr = document.createElement('div'); hdr.className = 'tab-overflow-section'; hdr.textContent = `Hidden Tabs (${closedList.length})`; popoverEl.appendChild(hdr); for (const tab of closedList) appendItem(tab, true); }
        try { popoverEl.showPopover(); } catch { popoverEl.classList.toggle('hidden'); }
      });
    }
  }
  ns.renderTabBar = function renderTabBar({ tabStripEl, topOverflowBtnEl, bottomTabBarEl, bottomTabStripEl, bottomOverflowBtnEl, tabOverflowPopoverEl, terminalBtnEl, extensionsBtnEl, splitBtnEl, sidecars, terminals, registryPackages, hangar, bottomActiveTabId, layout, hasActiveWorkspace, onSelectTopSplitTab, onSelectBottomSplitTab, onDropTab, onPreviewTerminalSlot, onDropIntoTerminal, onContextAction }) {
    if (ns.isPointerOnTab) return;
    const splitEnabled = Boolean(layout?.splitViewEnabled), regMap = new Map((registryPackages || []).map((p) => [p.id, p]));
    splitBtnEl?.classList.toggle('active', splitEnabled);
    const updateCount = (sidecars || []).filter((s) => s.updateAvailable || regMap.get(s.sidecarId)?.updateAvailable).length + (hangar?.updateAvailable ? 1 : 0);
    if (topOverflowBtnEl) topOverflowBtnEl._updateCount = updateCount;
    if (bottomOverflowBtnEl) bottomOverflowBtnEl._updateCount = updateCount;
    const { workspaceTabs, topTabs, bottomTabs, closedTabs, activeSingleId, activeTopId } = ns.partitionSplitTabs(sidecars || [], layout, terminals || []);
    const isTermBtn = layout?.terminalDisplayMode === 'button';
    const termActive = (splitEnabled ? activeTopId : activeSingleId) === ns.TERMINAL_TAB_ID || (splitEnabled && bottomActiveTabId === ns.TERMINAL_TAB_ID);
    if (terminalBtnEl) {
      terminalBtnEl.classList.toggle('hidden', !isTermBtn);
      terminalBtnEl.classList.toggle('active', isTermBtn && termActive);
      terminalBtnEl.setAttribute?.('aria-pressed', String(Boolean(isTermBtn && termActive)));
    }
    const isExtBtn = layout?.extensionsDisplayMode === 'button';
    const extActive = (splitEnabled ? activeTopId : activeSingleId) === ns.EXTENSIONS_TAB_ID || (splitEnabled && bottomActiveTabId === ns.EXTENSIONS_TAB_ID);
    if (extensionsBtnEl) {
      extensionsBtnEl.classList.toggle('hidden', !isExtBtn);
      extensionsBtnEl.classList.toggle('active', isExtBtn && extActive);
      extensionsBtnEl.setAttribute?.('aria-pressed', String(Boolean(isExtBtn && extActive)));
      extensionsBtnEl.title = updateCount > 0 ? `Extensions (${updateCount} update${updateCount === 1 ? '' : 's'} available)` : 'Extensions';
    }
    const baseOpts = { updateCount, hasActiveWorkspace: Boolean(hasActiveWorkspace), onDropTab, onPreviewTerminalSlot, onDropIntoTerminal, onContextAction }, reopen = (sidecarId) => onContextAction?.({ action: 'reopen', sidecarId });
    function ensureHubAddButton(stripEl, stripOpts) {
      let addBtn = stripEl.querySelector?.('[data-role="hub-add-tab"]');
      if (!addBtn) {
        addBtn = document.createElement('button');
        addBtn.type = 'button'; addBtn.className = 'chrome-icon-btn term-strip-add-btn';
        addBtn.dataset.role = 'hub-add-tab'; addBtn.dataset.testid = 'hangar-new-tab-button';
        addBtn.title = 'Open Terminal or Side Chat'; addBtn.innerHTML = ns.iconSvg('add', 16);
        addBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const r = addBtn.getBoundingClientRect?.() || { left: e.clientX || 40, bottom: e.clientY || 36 };
          const pane = addBtn._opts?.pane || 'single';
          ns.openTabContextMenu?.(
            { clientX: r.left, clientY: (r.bottom || 36) + 4, preventDefault() {}, stopPropagation() {} },
            [
              { id: 'new-terminal', icon: 'terminal', label: 'New Terminal', onClick: () => addBtn._opts?.onContextAction?.({ action: 'new-terminal', pane }) },
              { id: 'new-sidechat', icon: 'chat', label: 'New Side Chat', onClick: () => addBtn._opts?.onContextAction?.({ action: 'new-sidechat', pane }) },
            ]
          );
        });
      }
      addBtn._opts = stripOpts;
      if (stripEl.children?.[stripEl.children.length - 1] !== addBtn) stripEl.appendChild(addBtn);
    }
    function populateStrip(stripEl, tabs, activeId, opts) {
      if (!stripEl) return;
      const stripOpts = { ...opts, stripTabs: tabs }, seenIds = new Set();
      if (!tabs.length) {
        stripEl._lastActiveId = ''; stripEl.querySelectorAll('.hub-tab').forEach((el) => el.remove());
        if (!stripEl.querySelector('.tab-drop-hint')) { const hint = document.createElement('span'); hint.className = 'tab-drop-hint'; hint.textContent = 'Drag a tab here'; stripEl.appendChild(hint); }
        ensureHubAddButton(stripEl, stripOpts);
        return;
      }
      stripEl.querySelectorAll('.tab-drop-hint').forEach((el) => el.remove());
      tabs.forEach((sc, i) => {
        seenIds.add(sc.sidecarId);
        let btn = stripEl.querySelector(`.hub-tab[data-sidecar-id="${CSS.escape(sc.sidecarId)}"]`);
        if (!btn) btn = createSidecarTabButton(sc, sc.sidecarId === activeId, stripOpts); else updateSidecarTabButton(btn, sc, sc.sidecarId === activeId, stripOpts);
        if (stripEl.children[i] !== btn) stripEl.insertBefore(btn, stripEl.children[i] || null);
      });
      stripEl.querySelectorAll('.hub-tab').forEach((child) => { if (!seenIds.has(child.dataset.sidecarId)) child.remove(); });
      ensureHubAddButton(stripEl, stripOpts);
      if (stripEl._lastActiveId !== activeId) { stripEl._lastActiveId = activeId; stripEl.querySelector('.hub-tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' }); }
    }
    if (!splitEnabled) {
      bottomTabBarEl?.classList.add('hidden'); bottomOverflowBtnEl?.classList.add('hidden');
      if (tabOverflowPopoverEl?._anchorBtn === bottomOverflowBtnEl) try { tabOverflowPopoverEl.hidePopover?.(); } catch {}
      populateStrip(tabStripEl, workspaceTabs, activeSingleId, { ...baseOpts, pane: 'single', splitEnabled: false, onClick: onSelectTopSplitTab });
      setupStripScroll(tabStripEl, topOverflowBtnEl, () => workspaceTabs, onSelectTopSplitTab, tabOverflowPopoverEl, () => closedTabs, reopen);
    } else {
      populateStrip(tabStripEl, topTabs, activeTopId, { ...baseOpts, pane: 'top', splitEnabled: true, onClick: onSelectTopSplitTab });
      setupStripScroll(tabStripEl, topOverflowBtnEl, () => topTabs, onSelectTopSplitTab, tabOverflowPopoverEl, () => closedTabs, reopen);
      if (bottomTabBarEl && bottomTabStripEl) { bottomTabBarEl.classList.remove('hidden'); populateStrip(bottomTabStripEl, bottomTabs, bottomActiveTabId, { ...baseOpts, pane: 'bottom', splitEnabled: true, onClick: onSelectBottomSplitTab }); setupStripScroll(bottomTabStripEl, bottomOverflowBtnEl, () => bottomTabs, onSelectBottomSplitTab, tabOverflowPopoverEl, () => closedTabs, reopen); }
    }
  };
})();
