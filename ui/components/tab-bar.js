/**
 * @fileoverview Renders top and bottom Chrome tab bars using Antigravity 2.0's
 * C5 AuxPaneTab layout, Material Symbols SVGs, and 150ms translateX sibling slide physics.
 */

(function () {
  const ns = (window.Hangar = window.Hangar || {});
  ns.EXTENSIONS_TAB_ID = '__extensions__';

  const EXTENSIONS_TAB = {
    sidecarId: ns.EXTENSIONS_TAB_ID,
    displayName: 'Extensions',
    statusBadge: 'MANAGER',
    isVirtual: true,
    matchesWorkspace: true,
  };

  ns.partitionSplitTabs = function partitionSplitTabs(sidecars = [], layout = {}) {
    const workspaceTabs = [...sidecars.filter((sc) => sc.matchesWorkspace), EXTENSIONS_TAB];
    const tabOrder = Array.isArray(layout?.tabOrder) ? layout.tabOrder : [];
    if (tabOrder.length > 0) {
      const orderIndex = new Map(tabOrder.map((id, idx) => [id, idx]));
      workspaceTabs.sort(
        (a, b) => (orderIndex.get(a.sidecarId) ?? 9999) - (orderIndex.get(b.sidecarId) ?? 9999)
      );
    }

    const rawTopIds = Array.isArray(layout?.topSplitTabIds)
      ? layout.topSplitTabIds
      : layout?.pinnedTopSidecarId
        ? [layout.pinnedTopSidecarId]
        : workspaceTabs[0]
          ? [workspaceTabs[0].sidecarId]
          : [];
    const topSet = new Set(rawTopIds);
    const topTabs = workspaceTabs.filter((sc) => topSet.has(sc.sidecarId));
    const bottomTabs = workspaceTabs.filter((sc) => !topSet.has(sc.sidecarId));
    const activeSingleId =
      workspaceTabs.find((sc) => sc.sidecarId === layout?.pinnedTopSidecarId)?.sidecarId ||
      workspaceTabs[0]?.sidecarId ||
      '';
    const activeTopId =
      topTabs.find((sc) => sc.sidecarId === layout?.pinnedTopSidecarId)?.sidecarId ||
      topTabs[0]?.sidecarId ||
      '';
    return { workspaceTabs, topTabs, bottomTabs, activeSingleId, activeTopId, topSet };
  };

  function clearDropHighlights() {
    document.querySelectorAll('.split-drop-target').forEach((el) => el.classList.remove('split-drop-target'));
  }

  function cleanupAllDragGhosts() {
    ns.isPointerOnTab = false;
    document.querySelectorAll('.tab-drag-ghost').forEach((el) => el.remove());
    document.querySelectorAll('.hub-tab').forEach((el) => {
      el.classList.remove('is-dragging-source');
      el.style.transform = '';
    });
    document.body.classList.remove('dragging-tab');
    clearDropHighlights();
  }

  window.addEventListener('blur', cleanupAllDragGhosts);

  function measureStrip(sourceStrip, btn, startX, startY) {
    const sourceTabs = Array.from(sourceStrip.querySelectorAll('.hub-tab[data-sidecar-id]'));
    const draggedIndex = sourceTabs.indexOf(btn);
    const centers = [], rects = [];
    let minLeft = Infinity, maxRight = -Infinity, gap = 0, prevRight = null;
    sourceTabs.forEach((el) => {
      const r = el.getBoundingClientRect();
      rects.push(r);
      centers.push(r.left + r.width / 2);
      minLeft = Math.min(minLeft, r.left);
      maxRight = Math.max(maxRight, r.right);
      if (prevRight !== null && gap === 0) gap = Math.max(0, r.left - prevRight);
      prevRight = r.right;
    });
    const dRect = rects[draggedIndex] || btn.getBoundingClientRect();
    return {
      sourceStrip, sourceTabs, draggedIndex, centers,
      draggedWidth: dRect.width, draggedHeight: dRect.height,
      grabOffsetX: startX - dRect.left, grabOffsetY: startY - dRect.top,
      originalTop: dRect.top, minLeft,
      maxLeft: Math.max(minLeft, maxRight - dRect.width),
      draggedSlot: dRect.width + (gap || 1), locked: true, lockChangedAt: null,
    };
  }

  function createSidecarTabButton(sc, isActive, { pane = 'single', splitEnabled = false, onClick, onDropTab } = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `hub-tab${isActive ? ' active' : ''}`;
    btn.dataset.sidecarId = sc.sidecarId;
    btn.dataset.pane = pane;

    const iconSlot = document.createElement('span');
    iconSlot.className = 'hub-tab-icon-slot';

    if (sc.isVirtual) {
      btn.title = sc.displayName;
      iconSlot.innerHTML = ns.iconSvg('extension', 16);
      const label = document.createElement('span');
      label.textContent = sc.displayName;
      btn.append(iconSlot, label);
    } else {
      const badgeInfo = ns.formatStatusBadge(sc.statusBadge, sc.isRunning, sc.isErrored);
      btn.title = `${sc.displayName} (${badgeInfo.label})`;
      iconSlot.innerHTML = ns.iconSvg(sc.scope === 'global' ? 'keep' : 'folder', 15);
      const dot = document.createElement('span');
      dot.className = `status-dot ${badgeInfo.state}`;
      const label = document.createElement('span');
      label.textContent = sc.displayName;
      btn.append(iconSlot, label, dot);
    }

    let activePointerId = null, startX = 0, startY = 0, isDragging = false;
    let ghostEl = null, targetPane = pane, beforeTabId = null, dragMeta = null;

    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      cleanupAllDragGhosts();
      activePointerId = e.pointerId;
      ns.isPointerOnTab = true;
      startX = e.clientX;
      startY = e.clientY;
      isDragging = false;
      targetPane = pane;
      beforeTabId = null;
      dragMeta = null;
      btn.setPointerCapture(e.pointerId);
    });

    btn.addEventListener('pointermove', (e) => {
      if (activePointerId !== e.pointerId) return;
      if (!isDragging && Math.hypot(e.clientX - startX, e.clientY - startY) > 4) {
        isDragging = true;
        document.body.classList.add('dragging-tab');
        dragMeta = measureStrip(btn.parentElement, btn, startX, startY);
        btn.classList.add('is-dragging-source');
        ghostEl = btn.cloneNode(true);
        ghostEl.className = 'hub-tab active tab-drag-ghost';
        ghostEl.style.width = `${dragMeta.draggedWidth}px`;
        ghostEl.style.height = `${dragMeta.draggedHeight}px`;
        document.body.appendChild(ghostEl);
      }
      if (!isDragging || !ghostEl || !dragMeta) return;

      clearDropHighlights();
      if (!splitEnabled) {
        targetPane = 'single';
      } else {
        const handleRect = document.getElementById('split-resize-handle')?.getBoundingClientRect();
        const dividerY = handleRect ? handleRect.top + handleRect.height / 2 : window.innerHeight / 2;
        targetPane = e.clientY < dividerY ? 'top' : 'bottom';
      }

      const stripRect = dragMeta.sourceStrip.getBoundingClientRect();
      const nextLocked =
        targetPane === pane &&
        (!splitEnabled || (e.clientY >= stripRect.top - 36 && e.clientY <= stripRect.bottom + 36));
      if (nextLocked !== dragMeta.locked) {
        dragMeta.locked = nextLocked;
        dragMeta.lockChangedAt = performance.now();
      }

      const rawLeft = e.clientX - dragMeta.grabOffsetX;
      const left = dragMeta.locked ? Math.min(Math.max(rawLeft, dragMeta.minLeft), dragMeta.maxLeft) : rawLeft;
      const top = dragMeta.locked ? dragMeta.originalTop : e.clientY - dragMeta.grabOffsetY;
      const isAnimating = dragMeta.lockChangedAt !== null && performance.now() - dragMeta.lockChangedAt < 120;
      ghostEl.style.transition = isAnimating ? 'top 120ms ease-out, left 120ms ease-out' : '';
      ghostEl.style.left = `${left}px`;
      ghostEl.style.top = `${top}px`;

      if (targetPane === pane) {
        document.getElementById(pane === 'top' ? 'bottom-tab-strip' : 'tab-strip')
          ?.querySelectorAll('.hub-tab').forEach((el) => (el.style.transform = ''));

        const x = e.clientX - dragMeta.grabOffsetX + dragMeta.draggedWidth / 2;
        const halfW = dragMeta.draggedWidth / 2;
        let dropIndex = dragMeta.draggedIndex;
        for (let i = 0; i < dragMeta.centers.length; i++) {
          if (i < dragMeta.draggedIndex && x < dragMeta.centers[i] + halfW) dropIndex = Math.min(dropIndex, i);
          else if (i > dragMeta.draggedIndex && x > dragMeta.centers[i] - halfW) dropIndex = Math.max(dropIndex, i);
        }

        dragMeta.sourceTabs.forEach((el, i) => {
          if (i === dragMeta.draggedIndex) return;
          let shift = 0;
          if (dragMeta.draggedIndex < dropIndex && i > dragMeta.draggedIndex && i <= dropIndex) shift = -dragMeta.draggedSlot;
          else if (dragMeta.draggedIndex > dropIndex && i >= dropIndex && i < dragMeta.draggedIndex) shift = dragMeta.draggedSlot;
          el.style.transform = shift ? `translateX(${shift}px)` : '';
        });

        const otherIds = dragMeta.sourceTabs.filter((_, idx) => idx !== dragMeta.draggedIndex).map((el) => el.dataset.sidecarId);
        beforeTabId = dropIndex < otherIds.length ? otherIds[dropIndex] : null;
      } else {
        dragMeta.sourceTabs.forEach((el, i) => {
          if (i !== dragMeta.draggedIndex) {
            el.style.transform = i > dragMeta.draggedIndex ? `translateX(${-dragMeta.draggedSlot}px)` : '';
          }
        });

        const targetStrip = document.getElementById(targetPane === 'top' ? 'tab-strip' : 'bottom-tab-strip');
        const targetSibs = Array.from(targetStrip?.querySelectorAll('.hub-tab[data-sidecar-id]') || []);
        beforeTabId = null;
        targetSibs.forEach((sib) => {
          const r = sib.getBoundingClientRect();
          if (beforeTabId === null && e.clientX < r.left + r.width / 2) beforeTabId = sib.dataset.sidecarId;
          sib.style.transform = beforeTabId !== null ? `translateX(${dragMeta.draggedSlot}px)` : '';
        });

        document.getElementById(targetPane === 'top' ? 'chrome-bar' : 'bottom-tab-bar')?.classList.add('split-drop-target');
        document.querySelector(targetPane === 'top' ? '.slot-top:not(.hidden)' : '.slot-bottom:not(.hidden)')?.classList.add('split-drop-target');
      }
    });

    const endPointer = (e, cancelled = false) => {
      if (activePointerId !== e.pointerId) return;
      const wasDragging = isDragging;
      activePointerId = null;
      isDragging = false;
      ghostEl = null;
      dragMeta = null;
      try {
        if (btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId);
      } catch { /* Ignore */ }
      cleanupAllDragGhosts();
      if (!cancelled) {
        if (!wasDragging) onClick?.(sc.sidecarId);
        else onDropTab?.({ sidecarId: sc.sidecarId, sourcePane: pane, targetPane, beforeTabId });
      }
    };

    btn.addEventListener('pointerup', (e) => endPointer(e, false));
    btn.addEventListener('pointercancel', (e) => endPointer(e, true));
    btn.addEventListener('lostpointercapture', (e) => endPointer(e, true));
    return btn;
  }

  ns.renderTabBar = function renderTabBar({
    workspaceEl, tabStripEl, bottomTabBarEl, bottomTabStripEl, splitBtnEl,
    activeWorkspace, sidecars, bottomActiveTabId, layout,
    onSelectTopSplitTab, onSelectBottomSplitTab, onDropTab,
  }) {
    if (ns.isPointerOnTab) return;
    const splitEnabled = Boolean(layout?.splitViewEnabled);
    if (workspaceEl) {
      workspaceEl.textContent = activeWorkspace?.workspaceName || 'Global';
      workspaceEl.parentElement.title = `Active Workspace: ${activeWorkspace?.workspacePath || 'Global (*)'}`;
    }
    splitBtnEl?.classList.toggle('active', splitEnabled);

    const { workspaceTabs, topTabs, bottomTabs, activeSingleId, activeTopId } =
      ns.partitionSplitTabs(sidecars || [], layout);

    function populateStrip(stripEl, tabs, activeId, opts) {
      if (!stripEl) return;
      stripEl.innerHTML = '';
      if (tabs.length === 0) {
        const hint = document.createElement('span');
        hint.className = 'tab-drop-hint';
        hint.textContent = 'Drag a tab here';
        stripEl.appendChild(hint);
        return;
      }
      for (const sc of tabs) stripEl.appendChild(createSidecarTabButton(sc, sc.sidecarId === activeId, opts));
    }

    if (!splitEnabled) {
      bottomTabBarEl?.classList.add('hidden');
      populateStrip(tabStripEl, workspaceTabs, activeSingleId, { pane: 'single', splitEnabled: false, onClick: onSelectTopSplitTab, onDropTab });
      return;
    }

    populateStrip(tabStripEl, topTabs, activeTopId, { pane: 'top', splitEnabled: true, onClick: onSelectTopSplitTab, onDropTab });
    if (bottomTabBarEl && bottomTabStripEl) {
      bottomTabBarEl.classList.remove('hidden');
      populateStrip(bottomTabStripEl, bottomTabs, bottomActiveTabId, { pane: 'bottom', splitEnabled: true, onClick: onSelectBottomSplitTab, onDropTab });
    }
  };
})();
