/**
 * @fileoverview Renders top and bottom Chrome tab bars using Antigravity 2.0's
 * C5 AuxPaneTab layout, Material Symbols SVGs, horizontal scroll fade, and overflow popover.
 */

(function () {
  const ns = (window.Hangar = window.Hangar || {});
  ns.EXTENSIONS_TAB_ID = '__extensions__';
  const EXTENSIONS_TAB = {
    sidecarId: ns.EXTENSIONS_TAB_ID, displayName: 'Extensions',
    statusBadge: 'MANAGER', isVirtual: true, matchesWorkspace: true,
  };

  ns.partitionSplitTabs = function partitionSplitTabs(sidecars = [], layout = {}) {
    const workspaceTabs = [...sidecars.filter((sc) => sc.matchesWorkspace), EXTENSIONS_TAB];
    const tabOrder = Array.isArray(layout?.tabOrder) ? layout.tabOrder : [];
    if (tabOrder.length > 0) {
      const orderIndex = new Map(tabOrder.map((id, idx) => [id, idx]));
      workspaceTabs.sort((a, b) => (orderIndex.get(a.sidecarId) ?? 9999) - (orderIndex.get(b.sidecarId) ?? 9999));
    }
    const rawTopIds = Array.isArray(layout?.topSplitTabIds)
      ? layout.topSplitTabIds : layout?.pinnedTopSidecarId ? [layout.pinnedTopSidecarId] : workspaceTabs[0] ? [workspaceTabs[0].sidecarId] : [];
    const topSet = new Set(rawTopIds);
    const topTabs = workspaceTabs.filter((sc) => topSet.has(sc.sidecarId));
    const bottomTabs = workspaceTabs.filter((sc) => !topSet.has(sc.sidecarId));
    const activeSingleId = workspaceTabs.find((sc) => sc.sidecarId === layout?.pinnedTopSidecarId)?.sidecarId || workspaceTabs[0]?.sidecarId || '';
    const activeTopId = topTabs.find((sc) => sc.sidecarId === layout?.pinnedTopSidecarId)?.sidecarId || topTabs[0]?.sidecarId || '';
    return { workspaceTabs, topTabs, bottomTabs, activeSingleId, activeTopId, topSet };
  };

  function cleanupAllDragGhosts() {
    ns.isPointerOnTab = false;
    document.querySelectorAll('.tab-drag-ghost').forEach((el) => el.remove());
    document.querySelectorAll('.hub-tab').forEach((el) => { el.classList.remove('is-dragging-source'); el.style.transform = ''; });
    document.body.classList.remove('dragging-tab');
    document.querySelectorAll('.split-drop-target').forEach((el) => el.classList.remove('split-drop-target'));
  }
  window.addEventListener('blur', cleanupAllDragGhosts);

  function measureStrip(sourceStrip, btn, startX, startY) {
    const sourceTabs = Array.from(sourceStrip.querySelectorAll('.hub-tab[data-sidecar-id]'));
    const centers = [], rects = [];
    let minLeft = Infinity, maxRight = -Infinity, gap = 0, prevRight = null;
    sourceTabs.forEach((el) => {
      const r = el.getBoundingClientRect();
      rects.push(r); centers.push(r.left + r.width / 2);
      minLeft = Math.min(minLeft, r.left); maxRight = Math.max(maxRight, r.right);
      if (prevRight !== null && gap === 0) gap = Math.max(0, r.left - prevRight);
      prevRight = r.right;
    });
    const sRect = sourceStrip.getBoundingClientRect(), dRect = rects[sourceTabs.indexOf(btn)] || btn.getBoundingClientRect();
    return {
      sourceStrip, sourceTabs, draggedIndex: sourceTabs.indexOf(btn), centers, startScrollLeft: sourceStrip.scrollLeft,
      draggedWidth: dRect.width, draggedHeight: dRect.height,
      grabOffsetX: startX - dRect.left, grabOffsetY: startY - dRect.top,
      originalTop: dRect.top, minLeft: Math.max(minLeft, sRect.left), maxLeft: Math.max(sRect.left, Math.min(maxRight, sRect.right) - dRect.width),
      draggedSlot: dRect.width + (gap || 1), locked: true, lockChangedAt: null,
    };
  }

  function updateSidecarTabButton(btn, sc, isActive, opts = {}) {
    btn._sc = sc; btn._opts = opts; btn.dataset.pane = opts.pane || 'single';
    btn.classList.toggle('active', Boolean(isActive));
    const iconSlot = btn.querySelector('.hub-tab-icon-slot'), label = btn.querySelector('[data-role="tab-label"]'), dot = btn.querySelector('[data-role="tab-dot"]');
    if (sc.isVirtual) {
      const updCount = Number(opts.updateCount || 0);
      btn.title = updCount > 0 ? `${sc.displayName} (${updCount} update${updCount === 1 ? '' : 's'} available)` : sc.displayName;
      if (iconSlot && iconSlot.dataset.icon !== 'extension') { iconSlot.dataset.icon = 'extension'; iconSlot.innerHTML = ns.iconSvg('extension', 16); }
      if (label && label.textContent !== sc.displayName) label.textContent = sc.displayName;
      if (dot) dot.className = updCount > 0 ? 'status-dot update' : 'status-dot hidden';
      return;
    }
    const badgeInfo = ns.formatStatusBadge(sc.statusBadge, sc.isRunning, sc.isErrored), iconName = sc.scope === 'global' ? 'keep' : 'folder';
    btn.title = `${sc.displayName} (${badgeInfo.label})`;
    if (iconSlot && iconSlot.dataset.icon !== iconName) { iconSlot.dataset.icon = iconName; iconSlot.innerHTML = ns.iconSvg(iconName, 15); }
    if (label && label.textContent !== sc.displayName) label.textContent = sc.displayName;
    if (dot) dot.className = `status-dot ${badgeInfo.state}`;
  }

  function createSidecarTabButton(sc, isActive, opts = {}) {
    const btn = document.createElement('button'), iconSlot = document.createElement('span'), label = document.createElement('span'), dot = document.createElement('span');
    btn.type = 'button'; btn.className = 'hub-tab'; btn.dataset.sidecarId = sc.sidecarId;
    iconSlot.className = 'hub-tab-icon-slot'; label.dataset.role = 'tab-label'; dot.dataset.role = 'tab-dot';
    btn.append(iconSlot, label, dot);
    updateSidecarTabButton(btn, sc, isActive, opts);
    let activePointerId = null, startX = 0, startY = 0, isDragging = false;
    let ghostEl = null, targetPane = 'single', beforeTabId = null, dragMeta = null;

    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      cleanupAllDragGhosts(); activePointerId = e.pointerId; ns.isPointerOnTab = true;
      startX = e.clientX; startY = e.clientY; isDragging = false;
      targetPane = btn._opts?.pane || 'single'; beforeTabId = null; dragMeta = null;
      btn.setPointerCapture(e.pointerId);
    });

    btn.addEventListener('pointermove', (e) => {
      if (activePointerId !== e.pointerId) return;
      const pane = btn._opts?.pane || 'single', splitEnabled = Boolean(btn._opts?.splitEnabled);
      if (!isDragging && Math.hypot(e.clientX - startX, e.clientY - startY) > 4) {
        isDragging = true; document.body.classList.add('dragging-tab');
        dragMeta = measureStrip(btn.parentElement, btn, startX, startY);
        btn.classList.add('is-dragging-source');
        ghostEl = btn.cloneNode(true);
        ghostEl.className = 'hub-tab active tab-drag-ghost';
        ghostEl.style.width = `${dragMeta.draggedWidth}px`; ghostEl.style.height = `${dragMeta.draggedHeight}px`;
        document.body.appendChild(ghostEl);
      }
      if (!isDragging || !ghostEl || !dragMeta) return;

      document.querySelectorAll('.split-drop-target').forEach((el) => el.classList.remove('split-drop-target'));
      const handleRect = splitEnabled ? document.getElementById('split-resize-handle')?.getBoundingClientRect() : null;
      targetPane = !splitEnabled ? 'single' : e.clientY < (handleRect ? handleRect.top + handleRect.height / 2 : window.innerHeight / 2) ? 'top' : 'bottom';

      const stripRect = dragMeta.sourceStrip.getBoundingClientRect();
      const nextLocked = targetPane === pane && (!splitEnabled || (e.clientY >= stripRect.top - 36 && e.clientY <= stripRect.bottom + 36));
      if (nextLocked !== dragMeta.locked) { dragMeta.locked = nextLocked; dragMeta.lockChangedAt = performance.now(); }

      const rawLeft = e.clientX - dragMeta.grabOffsetX;
      const left = dragMeta.locked ? Math.min(Math.max(rawLeft, dragMeta.minLeft), dragMeta.maxLeft) : rawLeft;
      ghostEl.style.transition = dragMeta.lockChangedAt && performance.now() - dragMeta.lockChangedAt < 120 ? 'top 120ms ease-out, left 120ms ease-out' : '';
      ghostEl.style.left = `${left}px`; ghostEl.style.top = `${dragMeta.locked ? dragMeta.originalTop : e.clientY - dragMeta.grabOffsetY}px`;

      if (targetPane === pane) {
        if (dragMeta.sourceStrip.scrollWidth > dragMeta.sourceStrip.clientWidth) {
          if (e.clientX < stripRect.left + 26) dragMeta.sourceStrip.scrollLeft -= 10;
          else if (e.clientX > stripRect.right - 26) dragMeta.sourceStrip.scrollLeft += 10;
        }
        document.getElementById(pane === 'top' ? 'bottom-tab-strip' : 'tab-strip')?.querySelectorAll('.hub-tab').forEach((el) => (el.style.transform = ''));
        const x = e.clientX - dragMeta.grabOffsetX + dragMeta.draggedWidth / 2, scrollDelta = dragMeta.sourceStrip.scrollLeft - dragMeta.startScrollLeft;
        let dropIndex = dragMeta.draggedIndex;
        for (let i = 0; i < dragMeta.centers.length; i++) {
          const c = dragMeta.centers[i] - scrollDelta;
          if (i < dragMeta.draggedIndex && x < c + dragMeta.draggedWidth / 2) dropIndex = Math.min(dropIndex, i);
          else if (i > dragMeta.draggedIndex && x > c - dragMeta.draggedWidth / 2) dropIndex = Math.max(dropIndex, i);
        }
        dragMeta.sourceTabs.forEach((el, i) => {
          if (i === dragMeta.draggedIndex) return;
          const shift = (dragMeta.draggedIndex < dropIndex && i > dragMeta.draggedIndex && i <= dropIndex) ? -dragMeta.draggedSlot
            : (dragMeta.draggedIndex > dropIndex && i >= dropIndex && i < dragMeta.draggedIndex) ? dragMeta.draggedSlot : 0;
          el.style.transform = shift ? `translateX(${shift}px)` : '';
        });
        const otherIds = dragMeta.sourceTabs.filter((_, idx) => idx !== dragMeta.draggedIndex).map((el) => el.dataset.sidecarId);
        beforeTabId = dropIndex < otherIds.length ? otherIds[dropIndex] : null;
      } else {
        dragMeta.sourceTabs.forEach((el, i) => {
          if (i !== dragMeta.draggedIndex) el.style.transform = i > dragMeta.draggedIndex ? `translateX(${-dragMeta.draggedSlot}px)` : '';
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
      const wasDragging = isDragging, pane = btn._opts?.pane || 'single', curId = btn._sc?.sidecarId || sc.sidecarId;
      activePointerId = null; isDragging = false; ghostEl = null; dragMeta = null;
      try { if (btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId); } catch { /* Ignore */ }
      cleanupAllDragGhosts();
      if (!cancelled) {
        if (!wasDragging) { btn.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' }); btn._opts?.onClick?.(curId); }
        else btn._opts?.onDropTab?.({ sidecarId: curId, sourcePane: pane, targetPane, beforeTabId });
      }
    };
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((evt) => btn.addEventListener(evt, (e) => endPointer(e, evt !== 'pointerup')));
    return btn;
  }

  function setupStripScroll(stripEl, overflowBtnEl, getTabs, onSelectTab, popoverEl) {
    if (!stripEl) return;
    const update = () => {
      const { scrollLeft, scrollWidth, clientWidth } = stripEl, hasOverflow = scrollWidth > clientWidth + 1;
      overflowBtnEl?.classList.toggle('hidden', !hasOverflow);
      if (!hasOverflow) {
        if (popoverEl?._anchorBtn === overflowBtnEl) try { popoverEl.hidePopover?.(); } catch { /* Ignore */ }
        stripEl.style.webkitMaskImage = stripEl.style.maskImage = 'none'; return;
      }
      const atStart = scrollLeft <= 2, atEnd = scrollLeft + clientWidth >= scrollWidth - 2;
      const mask = (!atStart && !atEnd) ? 'linear-gradient(to right, transparent, black 38px, black calc(100% - 38px), transparent)'
        : (atStart && !atEnd) ? 'linear-gradient(to right, black calc(100% - 38px), transparent)'
        : (!atStart && atEnd) ? 'linear-gradient(to right, transparent, black 38px)' : 'none';
      stripEl.style.webkitMaskImage = stripEl.style.maskImage = mask;
    };
    stripEl._updateScroll = update;
    if (!stripEl._scrollBound) {
      stripEl._scrollBound = true;
      stripEl.addEventListener('scroll', () => stripEl._updateScroll?.(), { passive: true });
      stripEl.addEventListener('wheel', (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && stripEl.scrollWidth > stripEl.clientWidth) { e.preventDefault(); stripEl.scrollLeft += e.deltaY; }
      }, { passive: false });
      if (window.ResizeObserver) new ResizeObserver(() => stripEl._updateScroll?.()).observe(stripEl);
      if (window.MutationObserver) new MutationObserver(() => stripEl._updateScroll?.()).observe(stripEl, { childList: true, subtree: true, characterData: true });
    }
    update();
    if (overflowBtnEl) { overflowBtnEl._getTabs = getTabs; overflowBtnEl._onSelectTab = onSelectTab; }
    if (overflowBtnEl && popoverEl && !overflowBtnEl._popoverBound) {
      overflowBtnEl._popoverBound = true;
      overflowBtnEl.addEventListener('pointerdown', () => {
        overflowBtnEl._wasOpenOnDown = Boolean(popoverEl.matches?.(':popover-open') && popoverEl._anchorBtn === overflowBtnEl);
      });
      overflowBtnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (overflowBtnEl._wasOpenOnDown) { try { popoverEl.hidePopover?.(); } catch { /* Ignore */ } return; }
        popoverEl._anchorBtn = overflowBtnEl;
        const r = overflowBtnEl.getBoundingClientRect(), spaceBelow = window.innerHeight - r.bottom - 8, flipUp = spaceBelow < 180 && r.top > spaceBelow;
        popoverEl.style.top = flipUp ? 'auto' : `${r.bottom + 4}px`;
        popoverEl.style.bottom = flipUp ? `${window.innerHeight - r.top + 4}px` : 'auto';
        popoverEl.style.maxHeight = `${Math.max(120, (flipUp ? r.top : window.innerHeight - r.bottom) - 12)}px`;
        popoverEl.style.left = `${Math.max(8, Math.min(window.innerWidth - 230, r.right - 220))}px`;
        const activeId = stripEl.querySelector('.hub-tab.active')?.dataset.sidecarId;
        popoverEl.innerHTML = '';
        for (const tab of overflowBtnEl._getTabs?.() || []) {
          const item = document.createElement('button'), left = document.createElement('span'), icon = document.createElement('span'), title = document.createElement('span');
          item.type = 'button'; item.className = `tab-overflow-item${tab.sidecarId === activeId ? ' active' : ''}`;
          left.className = 'tab-overflow-item-left'; icon.className = 'hub-tab-icon-slot'; title.className = 'tab-overflow-item-title';
          icon.innerHTML = ns.iconSvg(tab.isVirtual ? 'extension' : (tab.scope === 'global' ? 'keep' : 'folder'), 15);
          title.textContent = tab.displayName; left.append(icon, title); item.append(left);
          if (!tab.isVirtual) {
            const badge = ns.formatStatusBadge(tab.statusBadge, tab.isRunning, tab.isErrored), dot = document.createElement('span');
            dot.className = `status-dot ${badge.state}`; item.append(dot);
          } else if (overflowBtnEl._updateCount > 0) {
            const dot = document.createElement('span');
            dot.className = 'status-dot update'; item.append(dot);
          }
          item.addEventListener('click', () => {
            popoverEl.hidePopover?.(); overflowBtnEl._onSelectTab?.(tab.sidecarId);
            stripEl.querySelector(`.hub-tab[data-sidecar-id="${CSS.escape(tab.sidecarId)}"]`)?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
          });
          popoverEl.appendChild(item);
        }
        try { popoverEl.showPopover(); } catch { popoverEl.classList.toggle('hidden'); }
      });
    }
  }

  ns.renderTabBar = function renderTabBar({
    tabStripEl, topOverflowBtnEl, bottomTabBarEl, bottomTabStripEl, bottomOverflowBtnEl,
    tabOverflowPopoverEl, splitBtnEl, sidecars, registryPackages, hangar, bottomActiveTabId, layout,
    onSelectTopSplitTab, onSelectBottomSplitTab, onDropTab,
  }) {
    if (ns.isPointerOnTab) return;
    const splitEnabled = Boolean(layout?.splitViewEnabled);
    splitBtnEl?.classList.toggle('active', splitEnabled);

    const regMap = new Map((registryPackages || []).map((p) => [p.id, p]));
    const sidecarUpdateCount = (sidecars || []).filter(
      (s) => s.updateAvailable || regMap.get(s.sidecarId)?.updateAvailable
    ).length;
    const updateCount = sidecarUpdateCount + (hangar?.updateAvailable ? 1 : 0);
    if (topOverflowBtnEl) topOverflowBtnEl._updateCount = updateCount;
    if (bottomOverflowBtnEl) bottomOverflowBtnEl._updateCount = updateCount;

    const { workspaceTabs, topTabs, bottomTabs, activeSingleId, activeTopId } = ns.partitionSplitTabs(sidecars || [], layout);

    function populateStrip(stripEl, tabs, activeId, opts) {
      if (!stripEl) return;
      if (tabs.length === 0) {
        stripEl._lastActiveId = '';
        stripEl.querySelectorAll('.hub-tab').forEach((el) => el.remove());
        if (!stripEl.querySelector('.tab-drop-hint')) {
          const hint = document.createElement('span');
          hint.className = 'tab-drop-hint'; hint.textContent = 'Drag a tab here'; stripEl.appendChild(hint);
        }
        return;
      }
      stripEl.querySelectorAll('.tab-drop-hint').forEach((el) => el.remove());
      const seenIds = new Set();
      for (let i = 0; i < tabs.length; i++) {
        const sc = tabs[i]; seenIds.add(sc.sidecarId);
        let btn = stripEl.querySelector(`.hub-tab[data-sidecar-id="${CSS.escape(sc.sidecarId)}"]`);
        if (!btn) btn = createSidecarTabButton(sc, sc.sidecarId === activeId, opts);
        else updateSidecarTabButton(btn, sc, sc.sidecarId === activeId, opts);
        if (stripEl.children[i] !== btn) stripEl.insertBefore(btn, stripEl.children[i] || null);
      }
      stripEl.querySelectorAll('.hub-tab').forEach((child) => { if (!seenIds.has(child.dataset.sidecarId)) child.remove(); });
      if (stripEl._lastActiveId !== activeId) {
        stripEl._lastActiveId = activeId;
        stripEl.querySelector('.hub-tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
      }
    }

    if (!splitEnabled) {
      bottomTabBarEl?.classList.add('hidden'); bottomOverflowBtnEl?.classList.add('hidden');
      if (tabOverflowPopoverEl?._anchorBtn === bottomOverflowBtnEl) try { tabOverflowPopoverEl.hidePopover?.(); } catch { /* Ignore */ }
      populateStrip(tabStripEl, workspaceTabs, activeSingleId, { pane: 'single', splitEnabled: false, updateCount, onClick: onSelectTopSplitTab, onDropTab });
      setupStripScroll(tabStripEl, topOverflowBtnEl, () => workspaceTabs, onSelectTopSplitTab, tabOverflowPopoverEl);
    } else {
      populateStrip(tabStripEl, topTabs, activeTopId, { pane: 'top', splitEnabled: true, updateCount, onClick: onSelectTopSplitTab, onDropTab });
      setupStripScroll(tabStripEl, topOverflowBtnEl, () => topTabs, onSelectTopSplitTab, tabOverflowPopoverEl);
      if (bottomTabBarEl && bottomTabStripEl) {
        bottomTabBarEl.classList.remove('hidden');
        populateStrip(bottomTabStripEl, bottomTabs, bottomActiveTabId, { pane: 'bottom', splitEnabled: true, updateCount, onClick: onSelectBottomSplitTab, onDropTab });
        setupStripScroll(bottomTabStripEl, bottomOverflowBtnEl, () => bottomTabs, onSelectBottomSplitTab, tabOverflowPopoverEl);
      }
    }
  };
})();
