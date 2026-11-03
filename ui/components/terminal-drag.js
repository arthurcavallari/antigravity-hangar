/** @fileoverview Terminal TabGroup drag-and-drop, cross-instance promotion/demotion, and drop zone controllers. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  ns.applyTerminalDrop = function applyTerminalDrop(groups = [], dragPayload = null, dropTarget = null) {
    if (!dragPayload || !dropTarget) return { groups, activeGroupId: '' };
    const next = groups.map((g) => ({ groupId: g.groupId, paneIds: [...g.paneIds], focusedPaneId: g.focusedPaneId, ...(g.pinned ? { pinned: true } : {}) }));
    const srcGroupIdx = next.findIndex((g) => g.groupId === dragPayload.groupId || g.paneIds.includes(dragPayload.terminalId));
    if (srcGroupIdx < 0) return { groups: next, activeGroupId: '' };
    const srcGroup = next[srcGroupIdx];
    if (dropTarget.zone === 'strip') {
      const rawIdx = typeof dropTarget.index === 'number' ? dropTarget.index : next.length;
      if (dragPayload.kind === 'tab' || srcGroup.paneIds.length <= 1) {
        const [removed] = next.splice(srcGroupIdx, 1);
        next.splice(Math.max(0, Math.min(next.length, rawIdx > srcGroupIdx ? rawIdx - 1 : rawIdx)), 0, removed);
        return { groups: [...next.filter((g) => g.pinned), ...next.filter((g) => !g.pinned)], activeGroupId: removed.groupId };
      }
      const tid = dragPayload.terminalId;
      const detached = { groupId: tid, paneIds: [tid], focusedPaneId: tid };
      srcGroup.paneIds = srcGroup.paneIds.filter((id) => id !== tid);
      if (srcGroup.focusedPaneId === tid) srcGroup.focusedPaneId = srcGroup.paneIds[0] || '';
      next.splice(Math.max(0, Math.min(next.length, rawIdx)), 0, detached);
      return { groups: [...next.filter((g) => g.pinned), ...next.filter((g) => !g.pinned)], activeGroupId: detached.groupId };
    }
    if (dropTarget.zone === 'pane') {
      const dstGroup = next.find((g) => g.groupId === dropTarget.targetGroupId || g.paneIds.includes(dropTarget.targetPaneId));
      if (!dstGroup || (dragPayload.kind === 'tab' && srcGroup.groupId === dstGroup.groupId) || (dragPayload.kind === 'pane' && dragPayload.terminalId === dropTarget.targetPaneId)) return { groups: next, activeGroupId: dstGroup?.groupId || srcGroup.groupId };
      const movingPanes = dragPayload.kind === 'tab' ? [...srcGroup.paneIds] : [dragPayload.terminalId];
      for (const g of next) {
        g.paneIds = g.paneIds.filter((id) => !movingPanes.includes(id));
        if (!g.paneIds.includes(g.focusedPaneId)) g.focusedPaneId = g.paneIds[0] || '';
      }
      const tIdx = dstGroup.paneIds.indexOf(dropTarget.targetPaneId);
      dstGroup.paneIds.splice(tIdx < 0 ? dstGroup.paneIds.length : (dropTarget.side === 'left' ? tIdx : tIdx + 1), 0, ...movingPanes);
      dstGroup.focusedPaneId = movingPanes[0];
      return { groups: next.filter((g) => g.paneIds.length > 0), activeGroupId: dstGroup.groupId };
    }
    return { groups: next, activeGroupId: srcGroup.groupId };
  };
  ns.promoteDragToHangarBar = function promoteDragToHangarBar(dragPayload) {
    if (!dragPayload?.terminalId) return null;
    const srcTabId = dragPayload.instanceTabId || ns.TERMINAL_TAB_ID, srcGroups = ns.readTabGroups(srcTabId);
    const srcGrp = srcGroups.find((g) => g.groupId === dragPayload.groupId || g.paneIds.includes(dragPayload.terminalId));
    const movingPanes = dragPayload.kind === 'tab' && srcGrp ? [...srcGrp.paneIds] : [dragPayload.terminalId];
    const moveSet = new Set(movingPanes), stayingGroups = [], popped = ns.getPoppedTerminalIds(), groupMap = ns.readGroupMap();
    for (const g of srcGroups) {
      const kept = (g.paneIds || []).filter((id) => !moveSet.has(id));
      if (kept.length) stayingGroups.push({ groupId: kept.includes(g.groupId) ? g.groupId : kept[0], paneIds: kept, focusedPaneId: kept.includes(g.focusedPaneId) ? g.focusedPaneId : kept[0] });
    }
    if (srcTabId.startsWith(ns.TERMINAL_TAB_PREFIX)) {
      const srcRoot = srcTabId.slice(ns.TERMINAL_TAB_PREFIX.length);
      for (const id of [srcRoot, ...Object.keys(groupMap).filter((k) => groupMap[k] === srcRoot)].filter((id) => !moveSet.has(id) && !stayingGroups.some((g) => g.paneIds.includes(id)))) stayingGroups.push({ groupId: id, paneIds: [id], focusedPaneId: id });
    }
    const remainingPanes = stayingGroups.flatMap((g) => g.paneIds);
    if (srcTabId.startsWith(ns.TERMINAL_TAB_PREFIX) && !remainingPanes.length) return { newSidecarId: srcTabId, replacedSidecarId: null };
    let replacedSidecarId = null;
    if (srcTabId.startsWith(ns.TERMINAL_TAB_PREFIX) && moveSet.has(srcTabId.slice(ns.TERMINAL_TAB_PREFIX.length))) {
      const srcRoot = srcTabId.slice(ns.TERMINAL_TAB_PREFIX.length), nextSrcRoot = remainingPanes[0], nextSrcTabId = ns.TERMINAL_TAB_PREFIX + remainingPanes[0];
      const ordered = [...popped].map((id) => (id === srcRoot ? nextSrcRoot : id));
      popped.clear();
      ordered.forEach((id) => popped.add(id));
      delete groupMap[nextSrcRoot];
      for (const remId of remainingPanes.slice(1)) groupMap[remId] = nextSrcRoot;
      ns.saveTabGroups(srcTabId, []);
      ns.saveTabGroups(nextSrcTabId, stayingGroups);
      ns.disposeTerminalInstance?.(srcTabId);
      replacedSidecarId = { from: srcTabId, to: nextSrcTabId };
    } else ns.saveTabGroups(srcTabId, stayingGroups);
    const newRoot = movingPanes[0], newSidecarId = ns.TERMINAL_TAB_PREFIX + movingPanes[0];
    popped.add(newRoot);
    delete groupMap[newRoot];
    for (const sibId of movingPanes.slice(1)) groupMap[sibId] = newRoot;
    ns.setPoppedTerminalIds(popped);
    ns.saveGroupMap(groupMap);
    ns.saveTabGroups(newSidecarId, [{ groupId: newRoot, paneIds: movingPanes, focusedPaneId: moveSet.has(dragPayload.terminalId) ? dragPayload.terminalId : newRoot }]);
    return { newSidecarId, replacedSidecarId };
  };

  ns.demoteHangarTabIntoInstance = function demoteHangarTabIntoInstance(sourceSidecarId, dropTarget = {}) {
    const targetInstanceTabId = dropTarget.targetInstanceTabId || ns.TERMINAL_TAB_ID;
    if (sourceSidecarId === targetInstanceTabId) return false;
    if (sourceSidecarId === ns.TERMINAL_TAB_ID && String(targetInstanceTabId).startsWith(ns.TERMINAL_TAB_PREFIX)) return ns.demoteHangarTabIntoInstance(targetInstanceTabId, { ...dropTarget, targetInstanceTabId: ns.TERMINAL_TAB_ID });
    if (!String(sourceSidecarId || '').startsWith(ns.TERMINAL_TAB_PREFIX)) return false;
    const rootId = sourceSidecarId.slice(ns.TERMINAL_TAB_PREFIX.length), popped = ns.getPoppedTerminalIds(), groupMap = ns.readGroupMap(), srcGroups = ns.readTabGroups(sourceSidecarId);
    const groupedPanes = srcGroups.flatMap((g) => g.paneIds || []);
    const mapPanes = [rootId, ...Object.keys(groupMap).filter((k) => groupMap[k] === rootId)];
    const allSourcePanes = [...groupedPanes, ...mapPanes.filter((id) => !groupedPanes.includes(id))];
    const srcSet = new Set(allSourcePanes);
    popped.delete(rootId);
    if (targetInstanceTabId === ns.TERMINAL_TAB_ID) {
      ns.setMainTerminalOpen(true);
      allSourcePanes.forEach((tid) => delete groupMap[tid]);
      Object.entries(groupMap).forEach(([k, v]) => v === rootId && delete groupMap[k]);
    } else if (targetInstanceTabId.startsWith(ns.TERMINAL_TAB_PREFIX)) {
      const otherRoot = targetInstanceTabId.slice(ns.TERMINAL_TAB_PREFIX.length);
      allSourcePanes.forEach((tid) => (tid === otherRoot ? delete groupMap[tid] : (groupMap[tid] = otherRoot)));
    }
    ns.setPoppedTerminalIds(popped);
    ns.saveGroupMap(groupMap);
    const dstGroups = [];
    for (const g of ns.readTabGroups(targetInstanceTabId)) {
      const pIds = (g.paneIds || []).filter((id) => !srcSet.has(id));
      if (pIds.length) dstGroups.push({ groupId: g.groupId, paneIds: pIds, focusedPaneId: pIds.includes(g.focusedPaneId) ? g.focusedPaneId : pIds[0] });
    }
    if (dropTarget.zone === 'pane' && dropTarget.targetPaneId) {
      const dstGrp = dstGroups.find((g) => g.paneIds.includes(dropTarget.targetPaneId)) || dstGroups[0];
      if (!dstGrp) dstGroups.push({ groupId: allSourcePanes[0], paneIds: [...allSourcePanes], focusedPaneId: allSourcePanes[0] });
      else {
        const tIdx = dstGrp.paneIds.indexOf(dropTarget.targetPaneId);
        dstGrp.paneIds.splice(tIdx < 0 ? dstGrp.paneIds.length : (dropTarget.side === 'left' ? tIdx : tIdx + 1), 0, ...allSourcePanes);
        dstGrp.focusedPaneId = allSourcePanes[0];
      }
    } else {
      const movingGroups = srcGroups.length ? srcGroups : [{ groupId: rootId, paneIds: allSourcePanes, focusedPaneId: rootId }];
      dstGroups.splice(typeof dropTarget.index === 'number' ? Math.max(0, Math.min(dstGroups.length, dropTarget.index)) : dstGroups.length, 0, ...movingGroups);
    }
    ns.saveTabGroups(sourceSidecarId, []);
    ns.saveTabGroups(targetInstanceTabId, dstGroups);
    ns.disposeTerminalInstance?.(sourceSidecarId);
    ns.focusTerminalInInstance?.(targetInstanceTabId, allSourcePanes[0]);
    return true;
  };
  ns.mergeTermDragIntoInstance = function mergeTermDragIntoInstance(drag, dropTarget = {}) {
    if (!drag?.terminalId || !dropTarget?.targetInstanceTabId || drag.instanceTabId === dropTarget.targetInstanceTabId) return null;
    const prom = ns.promoteDragToHangarBar(drag);
    if (!prom?.newSidecarId) return null;
    let finalTargetId = dropTarget.targetInstanceTabId, removedSidecarId = prom.newSidecarId, replacedSidecarId = prom.replacedSidecarId;
    ns.demoteHangarTabIntoInstance(prom.newSidecarId, dropTarget);
    if (drag.instanceTabId === ns.TERMINAL_TAB_ID && finalTargetId.startsWith(ns.TERMINAL_TAB_PREFIX) && !ns.readTabGroups(ns.TERMINAL_TAB_ID).length) {
      ns.demoteHangarTabIntoInstance(finalTargetId, { targetInstanceTabId: ns.TERMINAL_TAB_ID, zone: 'strip' });
      ns.focusTerminalInInstance?.(ns.TERMINAL_TAB_ID, drag.terminalId);
      removedSidecarId = finalTargetId;
      replacedSidecarId = { from: finalTargetId, to: ns.TERMINAL_TAB_ID };
      finalTargetId = ns.TERMINAL_TAB_ID;
    }
    return { removedSidecarId, replacedSidecarId, targetInstanceTabId: finalTargetId, targetPane: dropTarget.pane || '' };
  };
  let hangarDropCfg = {};
  ns.activeTermDrag = null;
  ns.setTabShift = (el, px = 0) => {
    if (!el) return;
    el._shiftX = px || 0;
    if (el.style) el.style.transform = px ? `translateX(${px}px)` : '';
  };
  ns.getUnshiftedRect = (el) => {
    const r = el.getBoundingClientRect(), tx = el._shiftX || 0;
    return tx ? { left: r.left - tx, right: r.right - tx, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : r;
  };
  ns.clearAllTermDropIndicators = () => {
    ns.activeTermDrag = null;
    document.body?.classList?.remove('dragging-tab');
    document.querySelectorAll?.('.drop-left, .drop-right, .drop-target, .is-dragging, .merge-drop-target, .split-drop-target').forEach((el) => el.classList?.remove('drop-left', 'drop-right', 'drop-target', 'is-dragging', 'merge-drop-target', 'split-drop-target'));
    if (!ns.isPointerOnTab) document.querySelectorAll?.('.agy-tab').forEach((el) => ns.setTabShift(el, 0));
  };
  ns.bindHangarChromeDropZone = (cfg = {}) => { hangarDropCfg = { ...hangarDropCfg, ...cfg }; };
  ns.getHangarDropCfg = () => hangarDropCfg;
  ns.measurePillStrip = (sourceStrip, btn, startX, startY, selector = '.agy-tab') => window.AgyUI?.measureStrip?.(sourceStrip, btn, startX, startY, selector) || null;
  ns.inspectHangarPointerOverTerminal = (clientX, clientY, draggedSidecarId, checkShells = true) => ns.inspectHangarPointerOverInstance?.(clientX, clientY, draggedSidecarId, checkShells, {
    isKindTabId: ns.isTerminalTabId, shellSel: '.term-shell[data-instance-tab-id]', pillSel: '.agy-tab[data-term-tid]',
    isShellHidden: (s) => Boolean(s.closest?.('.hidden')), getShellPane: (s) => (s.closest?.('#terminal-bottom-view') ? 'bottom' : 'top'),
  }) || null;

  ns.checkOutOfRailPromote = function checkOutOfRailPromote(e, sourceSlot, isKindTabId) {
    const dropCfg = ns.getHangarDropCfg?.() || {}, splitEnabled = Boolean(dropCfg.bottomBarEl && !dropCfg.bottomBarEl.classList.contains('hidden'));
    const cRect = dropCfg.chromeBarEl?.getBoundingClientRect?.(), bRect = splitEnabled ? dropCfg.bottomBarEl?.getBoundingClientRect?.() : null;
    const inChrome = Boolean(cRect && cRect.height > 0 && e.clientY >= cRect.top - 14 && e.clientY <= cRect.bottom + 4);
    const inBottomBar = Boolean(bRect && bRect.height > 0 && e.clientY >= bRect.top - 14 && e.clientY <= bRect.bottom + 4);
    const hRect = splitEnabled ? document.getElementById('split-resize-handle')?.getBoundingClientRect?.() : null;
    const pointerSlot = !splitEnabled ? 'top' : (e.clientY < (hRect ? hRect.top + hRect.height / 2 : window.innerHeight / 2) ? 'top' : 'bottom');
    if (!inChrome && !inBottomBar && !(splitEnabled && pointerSlot !== sourceSlot)) return null;
    const pane = inChrome ? 'top' : inBottomBar ? 'bottom' : pointerSlot;
    const tabs = Array.from(document.getElementById(pane === 'bottom' ? 'bottom-tab-strip' : 'tab-strip')?.querySelectorAll('.agy-tab[data-sidecar-id]') || []);
    let beforeTabId = null;
    if (inChrome || inBottomBar) {
      for (const tabEl of tabs) {
        const r = ns.getUnshiftedRect ? ns.getUnshiftedRect(tabEl) : tabEl.getBoundingClientRect();
        if (beforeTabId === null && e.clientX < r.left + r.width * (isKindTabId(tabEl.dataset.sidecarId) ? 0.12 : 0.5)) beforeTabId = tabEl.dataset.sidecarId;
      }
      let shifted = false;
      for (const sib of tabs) {
        if (sib.dataset.sidecarId === beforeTabId) shifted = true;
        ns.setTabShift?.(sib, shifted ? 72 : 0);
      }
    }
    (pane === 'bottom' ? dropCfg.bottomBarEl : dropCfg.chromeBarEl)?.classList.add('split-drop-target');
    if (splitEnabled && !inChrome && !inBottomBar) document.querySelector(pane === 'bottom' ? '.slot-bottom:not(.hidden)' : '.slot-top:not(.hidden)')?.classList.add('split-drop-target');
    return { type: 'promote', pane: splitEnabled ? pane : 'single', beforeTabId };
  };

  ns.bindTermPointerDrag = function bindTermPointerDrag(el, cfg = {}) {
    const curGid = () => (typeof cfg.groupId === 'function' ? cfg.groupId() : cfg.groupId);
    const makeDrag = () => ({ kind: cfg.kind, groupId: curGid(), terminalId: cfg.terminalId, instanceTabId: cfg.instanceTabId, sourceSlot: cfg.getSlotKey?.() || 'top' });
    ns.bindCrossInstancePillDrag?.(el, {
      itemId: cfg.terminalId || 'term', sessionsEl: cfg.sessionsEl, ignoreSelector: '[data-close-gid], [data-pin-gid], [data-role="tab-pin"], [data-role="pane-close"]',
      shouldDetach: () => cfg.kind === 'pane',
      createGhost: cfg.kind === 'tab' ? undefined : (btnEl, dragState) => {
        btnEl.classList.add('is-dragging');
        Object.assign(dragState, { grabOffsetX: 36, grabOffsetY: 11, draggedWidth: 96, draggedHeight: 22 });
        const ghost = Object.assign(document.createElement('div'), { className: 'agy-tab active agy-tab-drag-ghost' });
        ns.setHtml(ghost, ns.html`${ns.iconSvg?.('terminal', 13) || ''}<span class="agy-tab-label">${ns.escHtml?.(cfg.getTitle?.() || 'pwsh') || 'pwsh'}</span>`);
        return ghost;
      },
      getTabId: () => cfg.instanceTabId, getSlot: () => cfg.getSlotKey?.() || 'top', inspectMerge: ns.inspectHangarPointerOverTerminal, isKindTabId: ns.isTerminalTabId,
      onDragStart: () => Object.assign(ns, { isPointerOnTab: true, pointerTermInstanceId: cfg.instanceTabId, activeTermDrag: makeDrag() }),
      onDragEnd: () => {
        Object.assign(ns, { isPointerOnTab: false, pointerTermInstanceId: '' });
        el.classList.remove('is-dragging');
      },
      checkOwnTarget: (e, dragState, clearHover) => {
        const ownTRect = (cfg.sessionsEl?.closest?.('.term-toolbar') || cfg.sessionsEl)?.getBoundingClientRect?.();
        if (cfg.kind !== 'pane' || !ownTRect || e.clientX < ownTRect.left || e.clientX > ownTRect.right || e.clientY < ownTRect.top - 10 || e.clientY > ownTRect.bottom + 10) return null;
        clearHover();
        cfg.sessionsEl?.classList?.add('drop-target');
        const hitIdx = dragState.sourceTabs.findIndex((t) => e.clientX < ns.getUnshiftedRect(t).left + ns.getUnshiftedRect(t).width / 2);
        const idx = hitIdx >= 0 ? hitIdx : dragState.sourceTabs.length;
        dragState.sourceTabs.forEach((p, i) => ns.setTabShift(p, i >= idx ? 68 : 0));
        return { type: 'same', target: { zone: 'strip', index: idx } };
      },
      checkStageTarget: (e) => {
        const activeGid = cfg.getActiveGroupId?.() || '';
        if (cfg.kind === 'tab' && curGid() === activeGid) return null;
        for (const pEl of cfg.stageEl?.querySelectorAll?.('.term-pane[data-terminal-id]') || []) {
          if (pEl.classList?.contains?.('hidden')) continue;
          const pid = pEl.dataset.terminalId, pRect = pEl.getBoundingClientRect();
          if (!pid || (cfg.kind === 'pane' && pid === cfg.terminalId) || pRect.width <= 0 || e.clientX < pRect.left || e.clientX > pRect.right || e.clientY < pRect.top || e.clientY > pRect.bottom) continue;
          const side = (e.clientX - pRect.left) < pRect.width / 2 ? 'left' : 'right';
          pEl.classList.toggle('drop-left', side === 'left');
          pEl.classList.toggle('drop-right', side === 'right');
          return { type: 'same', target: { zone: 'pane', targetGroupId: activeGid, targetPaneId: pid, side } };
        }
        return null;
      },
      onSameDrop: (target) => cfg.onSameInstanceDrop?.(makeDrag(), target),
      onMergeDrop: (target) => ns.mergeTermDragIntoInstance(makeDrag(), target),
      onPromoteDrop: () => ns.promoteDragToHangarBar(makeDrag()),
      onClick: cfg.onClick,
    });
  };
  ns.bindGroupPillDrag = ns.bindTermPointerDrag;
})();
