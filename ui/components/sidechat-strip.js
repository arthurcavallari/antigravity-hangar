/** @fileoverview Side Chat session tab-strip controller, inline rename, and cross-instance drag-and-drop. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  const sc = ns._sc;
  ns.demoteSideChatTabIntoInstance = function demoteSideChatTabIntoInstance(sourceSidecarId, dropTarget = {}) {
    const targetInstanceTabId = dropTarget.targetInstanceTabId || ns.SIDECHAT_TAB_ID;
    if (sourceSidecarId === targetInstanceTabId) return false;
    if (sourceSidecarId === ns.SIDECHAT_TAB_ID && String(targetInstanceTabId).startsWith(ns.SIDECHAT_TAB_PREFIX)) return ns.demoteSideChatTabIntoInstance(targetInstanceTabId, { ...dropTarget, targetInstanceTabId: ns.SIDECHAT_TAB_ID });
    if (!String(sourceSidecarId || '').startsWith(ns.SIDECHAT_TAB_PREFIX)) return false;
    const srcRoot = sourceSidecarId.slice(ns.SIDECHAT_TAB_PREFIX.length), dstRoot = targetInstanceTabId.startsWith(ns.SIDECHAT_TAB_PREFIX) ? targetInstanceTabId.slice(ns.SIDECHAT_TAB_PREFIX.length) : '';
    const movingIds = ns.getInstanceSideChats(sc.threads, srcRoot).map((t) => t.cascadeId);
    if (!movingIds.includes(srcRoot)) movingIds.unshift(srcRoot);
    sc.poppedIds.delete(srcRoot);
    if (!dstRoot) {
      movingIds.forEach((cid) => delete sc.groupMap[cid]);
      Object.entries(sc.groupMap).forEach(([k, v]) => v === srcRoot && delete sc.groupMap[k]);
      sc.isOpen = true;
    } else movingIds.forEach((cid) => (cid === dstRoot ? delete sc.groupMap[cid] : (sc.groupMap[cid] = dstRoot)));
    if (typeof dropTarget.index === 'number') movingIds.forEach((cid, i) => ns.reorderSideChatThreadsInInstance(dstRoot, cid, dropTarget.index + i));
    const focCid = movingIds[0] || srcRoot;
    ns.setActiveSideChatId(targetInstanceTabId, focCid);
    const vpEl = typeof document?.getElementById === 'function' ? document.getElementById('main-viewport') : null;
    const dstBox = ns.ensureSideChatBox?.(targetInstanceTabId, vpEl || ns._sideChatBox?.parentElement || ns._sideChatBox?._toastRoot || document.body);
    for (const cid of movingIds) {
      const f = sc.frames.get(cid);
      if (!f || f.parentElement === dstBox) continue;
      f.classList?.toggle?.('hidden', cid !== focCid);
      dstBox?.appendChild?.(f);
    }
    sc.boxes.get(sourceSidecarId)?.remove?.();
    sc.boxes.delete(sourceSidecarId);
    sc.activeByInstance.delete(sourceSidecarId);
    dstBox?._syncThreadsUi?.(focCid, null);
    return true;
  };
  ns.mergeSideChatDragIntoInstance = function mergeSideChatDragIntoInstance(drag, dropTarget = {}) {
    if (!drag?.cascadeId || !dropTarget?.targetInstanceTabId || drag.instanceTabId === dropTarget.targetInstanceTabId) return null;
    const prom = ns.promoteSideChatToHangarBar(drag);
    if (!prom?.newSidecarId) return null;
    const state = { finalTargetId: dropTarget.targetInstanceTabId, removedSidecarId: prom.newSidecarId, replacedSidecarId: prom.replacedSidecarId };
    ns.demoteSideChatTabIntoInstance(prom.newSidecarId, dropTarget);
    if (drag.instanceTabId === ns.SIDECHAT_TAB_ID && state.finalTargetId.startsWith(ns.SIDECHAT_TAB_PREFIX) && !ns.getInstanceSideChats(sc.threads, '').length) {
      ns.demoteSideChatTabIntoInstance(state.finalTargetId, { targetInstanceTabId: ns.SIDECHAT_TAB_ID, zone: 'strip' });
      ns.setActiveSideChatId(ns.SIDECHAT_TAB_ID, drag.cascadeId);
      sc.boxes.get(ns.SIDECHAT_TAB_ID)?._syncThreadsUi?.(drag.cascadeId, null);
      Object.assign(state, { removedSidecarId: state.finalTargetId, replacedSidecarId: { from: state.finalTargetId, to: ns.SIDECHAT_TAB_ID }, finalTargetId: ns.SIDECHAT_TAB_ID });
    }
    return { removedSidecarId: state.removedSidecarId, replacedSidecarId: state.replacedSidecarId, targetInstanceTabId: state.finalTargetId, targetPane: dropTarget.pane || '' };
  };
  ns.inspectHangarPointerOverInstance = function inspectHangarPointerOverInstance(clientX, clientY, draggedSidecarId, checkShells, cfg) {
    document.querySelectorAll?.('.merge-drop-target, .drop-target, .drop-left, .drop-right').forEach((el) => el.classList?.remove('merge-drop-target', 'drop-target', 'drop-left', 'drop-right'));
    for (const shell of document.querySelectorAll?.(cfg.shellSel) || []) {
      if (shell.dataset.instanceTabId !== draggedSidecarId) shell.querySelectorAll?.(`${cfg.pillSel}:not(.is-dragging-source)`).forEach((el) => ns.setTabShift?.(el, 0));
    }
    if (!cfg.isKindTabId(draggedSidecarId)) return null;
    const rectOf = (el) => (ns.getUnshiftedRect ? ns.getUnshiftedRect(el) : el.getBoundingClientRect());
    const srcEl = document.querySelector?.(`.agy-tab[data-sidecar-id="${draggedSidecarId}"]`);
    const srcR = srcEl ? rectOf(srcEl) : null;
    for (const el of document.querySelectorAll?.('.agy-tab[data-sidecar-id]') || []) {
      const sid = el.dataset.sidecarId;
      const r = rectOf(el);
      if (!sid || sid === draggedSidecarId || !cfg.isKindTabId(sid) || r.width <= 0 || clientY < r.top - 18 || clientY > r.bottom + (!checkShells ? 18 : 4)) continue;
      const same = srcEl && srcEl.parentElement === el.parentElement;
      if (clientX >= r.left + (same && srcR && srcR.left < r.left ? 0 : r.width * 0.12) && clientX <= r.right - (same && srcR && srcR.left > r.left ? 0 : r.width * 0.12)) {
        el.classList.add('merge-drop-target');
        return { targetInstanceTabId: sid, zone: 'hub-tab', pane: el.dataset.pane || 'single' };
      }
    }
    if (!checkShells) return null;
    for (const shell of document.querySelectorAll?.(cfg.shellSel) || []) {
      const targetInstanceTabId = shell.dataset.instanceTabId;
      const sRect = shell.getBoundingClientRect();
      if (!targetInstanceTabId || targetInstanceTabId === draggedSidecarId || cfg.isShellHidden(shell) || sRect.width === 0 || clientX < sRect.left || clientX > sRect.right || clientY < sRect.top || clientY > sRect.bottom) continue;
      const strip = shell.querySelector('.agy-tab-strip');
      const tRect = (shell.querySelector('.term-toolbar') || strip)?.getBoundingClientRect();
      shell.classList.add('drop-target');
      strip?.classList.add('drop-target');
      const pills = Array.from(strip?.querySelectorAll(cfg.pillSel) || []);
      let index = pills.length;
      if (tRect && clientY <= tRect.bottom + 10) {
        const hitIdx = pills.findIndex((p) => clientX < rectOf(p).left + rectOf(p).width / 2);
        index = hitIdx >= 0 ? hitIdx : pills.length;
        pills.forEach((p, i) => ns.setTabShift?.(p, i >= index ? 68 : 0));
      }
      return { targetInstanceTabId, zone: 'strip', index, pane: cfg.getShellPane(shell) };
    }
    return null;
  };
  ns.inspectHangarPointerOverSideChat = (clientX, clientY, draggedSidecarId, checkShells = true) => ns.inspectHangarPointerOverInstance(clientX, clientY, draggedSidecarId, checkShells, {
    isKindTabId: ns.isSideChatTabId, shellSel: '.term-quote-composer[data-instance-tab-id]', pillSel: '.agy-tab[data-cascade-id]',
    isShellHidden: (s) => Boolean(s.classList?.contains?.('hidden')), getShellPane: (s) => s.dataset.slot || 'top',
  });
  ns.bindCrossInstancePillDrag = function bindCrossInstancePillDrag(el, cfg) {
    if (el?.dataset && el.dataset.tabId === undefined) el.dataset.tabId = cfg.itemId || 'tab';
    const st = { dropAction: null, hoverTimer: null, hoverTargetId: '', previewedId: '' };
    const clearHover = (resetPreview, slot) => {
      if (st.hoverTimer) clearTimeout(st.hoverTimer);
      Object.assign(st, { hoverTimer: null, hoverTargetId: '' });
      if (resetPreview && st.previewedId) {
        st.previewedId = '';
        ns.getHangarDropCfg?.()?.onPreviewTerminalSlot?.('', slot);
      }
    };
    window.AgyUI?.bindTabDragController?.(el, {
      stripEl: cfg.sessionsEl, tabSelector: '.agy-tab', pinnedRole: cfg.pinnedRole, ignoreSelector: cfg.ignoreSelector,
      shouldDetach: cfg.shouldDetach, createGhost: cfg.createGhost,
      onDragStart: (e, dragState) => {
        st.dropAction = null;
        cfg.onDragStart?.(e, dragState);
      },
      onOutOfRailMove: (e, dragState) => {
        const curTabId = cfg.getTabId(), sourceSlot = cfg.getSlot(), dropCfg = ns.getHangarDropCfg?.() || {};
        document.querySelectorAll?.('.drop-left, .drop-right, .drop-target, .merge-drop-target, .split-drop-target').forEach((n) => n.classList?.remove('drop-left', 'drop-right', 'drop-target', 'merge-drop-target', 'split-drop-target'));
        dragState.sourceTabs.forEach((sib, i) => ns.setTabShift?.(sib, i > dragState.draggedIndex ? -dragState.draggedSlot : 0));
        const ownHit = cfg.checkOwnTarget?.(e, dragState, () => clearHover(true, sourceSlot));
        if (ownHit) return void (st.dropAction = ownHit);
        const mergeHit = cfg.inspectMerge(e.clientX, e.clientY, curTabId, true);
        if (mergeHit) {
          if (mergeHit.zone === 'hub-tab' && mergeHit.pane !== 'single' && mergeHit.pane !== sourceSlot && st.hoverTargetId !== mergeHit.targetInstanceTabId) {
            clearHover(false, sourceSlot);
            st.hoverTargetId = mergeHit.targetInstanceTabId;
            st.hoverTimer = setTimeout(() => {
              Object.assign(st, { hoverTimer: null, previewedId: mergeHit.targetInstanceTabId });
              dropCfg.onPreviewTerminalSlot?.(mergeHit.targetInstanceTabId, mergeHit.pane);
            }, 350);
          } else if (mergeHit.zone !== 'hub-tab') clearHover(false, sourceSlot);
          return void (st.dropAction = { type: 'merge', target: mergeHit });
        }
        clearHover(true, sourceSlot);
        st.dropAction = cfg.checkStageTarget?.(e) || ns.checkOutOfRailPromote?.(e, sourceSlot, cfg.isKindTabId);
      },
      onDrop: (_e, finishedState, cancelled) => {
        const slot = cfg.getSlot(), dropCfg = ns.getHangarDropCfg?.() || {};
        cfg.onDragEnd?.();
        ns.clearAllTermDropIndicators?.();
        if (cancelled || !finishedState) return void clearHover(true, slot);
        if (finishedState.locked || st.dropAction?.type === 'same') {
          clearHover(true, slot);
          return void cfg.onSameDrop(finishedState.locked ? { zone: 'strip', index: finishedState.dropIdx } : st.dropAction.target);
        }
        if (st.dropAction?.type === 'merge') {
          clearHover(false, slot);
          st.previewedId = '';
          const res = cfg.onMergeDrop(st.dropAction.target);
          if (res) dropCfg.onMergeIntoTerminalTab?.(res);
          else dropCfg.onPreviewTerminalSlot?.('', slot);
        } else if (st.dropAction?.type === 'promote') {
          clearHover(true, slot);
          const res = cfg.onPromoteDrop();
          if (res?.newSidecarId) dropCfg.onPromoteToHangarTab?.({ sidecarId: res.newSidecarId, replacedSidecarId: res.replacedSidecarId, targetPane: st.dropAction.pane, beforeTabId: st.dropAction.beforeTabId });
        }
      },
      onClick: () => {
        el.scrollIntoView?.({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
        cfg.onClick?.();
      },
    });
  };
  ns.createSideChatStripController = function createSideChatStripController(ctx) {
    let isRenaming = false;
    const applyRename = (cid, rawNext) => {
      const next = String(rawNext || '').trim();
      ns.saveCustomSideChatTitle(cid, next);
      if (next) ns.apiCall?.('/api/sidechat/rename', { cascadeId: cid, title: next })?.catch?.(() => {});
      isRenaming = false;
      renderSessionStrip();
      ns.notifySideChatState();
    };
    const finishRename = (cid, lbl, t, rawNext, commit) => {
      if (commit) applyRename(cid, rawNext);
      else isRenaming = false;
      lbl.textContent = ns.resolveSideChatTitle(t);
      if (!commit) renderSessionStrip();
    };
    const startInlineRename = (pill, t) => {
      const lbl = pill?._slots?.labelEl || pill?.querySelector?.('.agy-tab-label');
      if (isRenaming || !t || !lbl) return;
      isRenaming = true;
      (window.AgyUI?.startInlineRename || ns.startInlineRename)?.(pill, lbl, { initialValue: ns.resolveSideChatTitle(t), inputClassName: 'agy-rename-input', onCommit: (rawNext) => finishRename(t.cascadeId, lbl, t, rawNext, true), onCancel: () => finishRename(t.cascadeId, lbl, t, '', false) });
    };
    function renderSessionStrip() {
      const curTabId = ctx.getTabId(), curRootId = ctx.getRootId();
      if (isRenaming || ns.pointerSideChatInstanceId === curTabId) return;
      const instThreads = ns.getInstanceSideChats(sc.threads, curRootId);
      const actCid = ns.getActiveSideChatId(curTabId) || instThreads[0]?.cascadeId || '';
      ctx.popoutBtn.classList?.toggle?.('active', Boolean(curRootId));
      ctx.popoutBtn.title = curRootId ? 'Merge back into main Side Chat tab' : 'Pin Side Chat Tab to Top Bar';
      const togglePin = (t) => {
        t.pinned = !t.pinned;
        sc.threads = [...sc.threads.filter((x) => x.pinned), ...sc.threads.filter((x) => !x.pinned)];
        renderSessionStrip();
        ns.notifySideChatState();
      };
      const selectThread = (cid) => {
        ns.setActiveSideChatId(ctx.getTabId(), cid);
        ctx.syncThreadsUi(cid, null);
        ns.notifySideChatState();
      };
      const items = instThreads.map((t, idx) => ({
        id: t.cascadeId, thread: t, idx, label: ns.resolveSideChatTitle(t), icon: 'chat', iconSize: 15, active: t.cascadeId === actCid, pinned: Boolean(t.pinned), closable: !t.pinned, closeTitle: 'Delete Side Chat', renamable: true,
        title: `${ns.resolveSideChatTitle(t)}${t.pinned ? ' · Pinned' : ''} (Drag to reorder or move across Hangar, double-click to rename)`, dataset: { cascadeId: t.cascadeId, pinned: t.pinned ? 'true' : 'false' },
      }));
      window.AgyUI?.reconcileTabStrip?.(ctx.sessionsEl, items, {
        idDatasetKey: 'cascadeId', closeTitle: 'Delete Side Chat', addButton: { role: 'sidechat-strip-add', title: 'New Side Chat', onClick: () => ctx.spawnNewInInstance() },
        onSelect: (id) => ns.getActiveSideChatId(ctx.getTabId()) !== id && selectThread(id),
        onClose: (id) => ns.deleteSideChatsByIds([id], curTabId), onUnpin: (_id, item) => togglePin(item.thread), onRenameStart: () => (isRenaming = true), onRenameCancel: () => (isRenaming = false), onRename: (_id, rawNext, item) => applyRename(item.thread.cascadeId, rawNext),
        onContextMenu: (_id, item, e, pill) => {
          const t = item.thread, others = instThreads.filter((x) => x.cascadeId !== item.thread.cascadeId && !x.pinned).map((x) => x.cascadeId), right = instThreads.slice(item.idx + 1).filter((x) => !x.pinned).map((x) => x.cascadeId);
          ns.openTabContextMenu?.(e, [
            { id: t.pinned ? 'unpin-tab' : 'pin-tab', label: t.pinned ? 'Unpin Tab' : 'Pin Tab', onClick: () => togglePin(t) },
            { id: 'rename-tab', label: 'Rename Side Chat…', onClick: () => startInlineRename(pill, t) },
            { id: 'popout-tab', label: curRootId ? 'Merge into Main Side Chat Tab' : 'Pin Side Chat Tab to Top Bar', onClick: () => ctx.handlePopoutOrMerge(t.cascadeId) },
            { separator: true },
            { id: 'close-tab', label: 'Delete Side Chat', disabled: Boolean(t.pinned), onClick: () => ns.deleteSideChatsByIds([t.cascadeId], curTabId) },
            {
              id: 'close-other-tabs', label: 'Delete Other Side Chats', disabled: !others.length,
              onClick: () => {
                ns.setActiveSideChatId(curTabId, t.cascadeId);
                ns.deleteSideChatsByIds(others, curTabId);
              },
            },
            { id: 'close-tabs-to-the-right', label: 'Delete Side Chats to the Right', disabled: !right.length, onClick: () => ns.deleteSideChatsByIds(right, curTabId) },
          ]);
        },
        bindDrag: (pill, item) => ns.bindCrossInstancePillDrag(pill, {
          itemId: item.thread.cascadeId, sessionsEl: ctx.sessionsEl, pinnedRole: 'sidechat-strip-add', ignoreSelector: '[data-close-cid], [data-pin-cid], [data-role="tab-pin"]', getTabId: ctx.getTabId, getSlot: ctx.getSlot, inspectMerge: ns.inspectHangarPointerOverSideChat, isKindTabId: ns.isSideChatTabId,
          onDragStart: () => Object.assign(ns, { isPointerOnTab: true, pointerSideChatInstanceId: ctx.getTabId() }), onDragEnd: () => Object.assign(ns, { isPointerOnTab: false, pointerSideChatInstanceId: '' }),
          onSameDrop: ({ index }) => {
            ns.reorderSideChatThreadsInInstance(ctx.getRootId(), item.thread.cascadeId, index);
            selectThread(item.thread.cascadeId);
          },
          onMergeDrop: (target) => ns.mergeSideChatDragIntoInstance({ cascadeId: item.thread.cascadeId, instanceTabId: ctx.getTabId() }, target),
          onPromoteDrop: () => ns.promoteSideChatToHangarBar({ cascadeId: item.thread.cascadeId, instanceTabId: ctx.getTabId() }),
          onClick: () => ns.getActiveSideChatId(ctx.getTabId()) !== item.thread.cascadeId && selectThread(item.thread.cascadeId),
        }),
      });
    }
    return { renderSessionStrip };
  };
})();
