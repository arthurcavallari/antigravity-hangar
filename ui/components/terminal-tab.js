/** @fileoverview Dual-engine Interactive Terminal view (Direct VT100 + Native jetbox_web) with iTerm2-style TabGroups and per-pane split headers. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  ns.TERMINAL_TAB_ID = '__terminal__'; ns.TERMINAL_TAB_PREFIX = 'terminal__';
  ns.isTerminalTabId = ns.isTerminalTabId || ((tabId = '') => tabId === ns.TERMINAL_TAB_ID || String(tabId || '').startsWith(ns.TERMINAL_TAB_PREFIX));
  const instanceControllers = new Map(), sharedPanes = new Map(), closingIds = new Set();

  function createInstanceController(instanceTabId, rootId = '') {
    let tabGroups = ns.readTabGroups(instanceTabId), activeGroupId = tabGroups[0]?.groupId || rootId || '', pendingSplit = null, engineMode = ns.readEngineMode();
    let terminals = [], workspacePath = '', conversationId = '', callbacks = {}, pollBusy = false, isInstanceVisible = false, pendingFocus = false, currentSlotKey = 'top', isRenaming = false;
    const panes = sharedPanes, rootEl = document.createElement('div');
    rootEl.className = 'term-shell'; rootEl.dataset.instanceTabId = instanceTabId;
    rootEl.innerHTML = `<div class="term-toolbar"><div class="term-session-strip" data-role="sessions"></div><div class="term-toolbar-actions">
      <button type="button" class="chrome-icon-btn" data-action="split" data-testid="terminal-split-button" title="Split Terminal">${ns.iconSvg('splitscreen_vertical_add', 15)}</button>
      <button type="button" class="chrome-icon-btn" data-action="popout" title="${rootId ? 'Merge back into main Terminal tab' : 'Pin Terminal Tab to Top Bar'}">${ns.iconSvg('dock_to_right', 14)}</button>
    </div></div><div class="term-stage" data-role="stage"></div>`;
    const toolbarEl = rootEl.querySelector('.term-toolbar'), actionsEl = rootEl.querySelector('.term-toolbar-actions'), sessionsEl = rootEl.querySelector('[data-role="sessions"]'), stageEl = rootEl.querySelector('[data-role="stage"]');
    const popoutBtn = rootEl.querySelector('[data-action="popout"]'), splitBtn = rootEl.querySelector('[data-action="split"]');
    const getActiveGroup = () => tabGroups.find((g) => g.groupId === activeGroupId) || tabGroups[0] || null, getActiveTerminalId = () => getActiveGroup()?.focusedPaneId || terminals[0]?.terminalId || '';
    const getActiveTermObj = () => terminals.find((t) => t.terminalId === getActiveTerminalId()) || terminals[0] || null, getVisibleIds = () => getActiveGroup()?.paneIds || [];
    const focusPane = (tid) => {
      const run = () => {
        const p = panes.get(tid);
        if (engineMode === 'jetbox') { p?.frame?.focus?.(); p?.frame?.contentWindow?.focus?.(); try { p?.frame?.contentWindow?.postMessage({ type: 'hangar-jetbox-focus' }, '*'); } catch {} }
        else p?.emu?.focus();
      };
      run(); setTimeout(run, 0);
    };
    function applyDropResult(drag, dropTarget) {
      if (drag?.instanceTabId && drag.instanceTabId !== instanceTabId) { const res = ns.mergeTermDragIntoInstance?.(drag, { ...dropTarget, targetInstanceTabId: instanceTabId, pane: currentSlotKey }); if (res) callbacks.onCrossInstanceMerge?.(res); return; }
      const res = ns.applyTerminalDrop(tabGroups, drag, dropTarget);
      tabGroups = res.groups; if (res.activeGroupId) activeGroupId = res.activeGroupId; ns.setActiveGroupId?.(instanceTabId, activeGroupId); ns.saveTabGroups(instanceTabId, tabGroups);
      renderToolbar(); renderStage(); focusPane(getActiveTerminalId()); pollVisiblePanes(); if (rootId) callbacks.onSessionChange?.();
    }
    sessionsEl.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && sessionsEl.scrollWidth > sessionsEl.clientWidth) { e.preventDefault(); sessionsEl.scrollLeft += e.deltaY; } }, { passive: false });
    function normalizeGroupState() {
      const res = ns.reconcileTabGroups(ns.readTabGroups(instanceTabId), terminals, pendingSplit), storedAct = ns.getActiveGroupId?.(instanceTabId);
      tabGroups = res.groups; if (res.consumedPending) pendingSplit = null;
      if (storedAct && tabGroups.some((g) => g.groupId === storedAct)) activeGroupId = storedAct;
      if (!activeGroupId || !tabGroups.some((g) => g.groupId === activeGroupId)) activeGroupId = tabGroups[0]?.groupId || '';
      ns.setActiveGroupId?.(instanceTabId, activeGroupId); ns.saveTabGroups(instanceTabId, tabGroups);
    }
    function setFocusedPane(tid, focusInput = false) {
      const g = tabGroups.find((grp) => grp.paneIds.includes(tid)); if (!g) return;
      const changed = activeGroupId !== g.groupId || g.focusedPaneId !== tid;
      activeGroupId = g.groupId; g.focusedPaneId = tid; ns.setActiveGroupId?.(instanceTabId, activeGroupId); ns.saveTabGroups(instanceTabId, tabGroups);
      const vis = getVisibleIds();
      for (const id of vis) { const p = panes.get(id); if (p) { p.wrap.classList.toggle('is-focused-pane', id === tid && vis.length > 1); p.dotEl?.classList.toggle('active', id === tid); } }
      if (changed) { renderToolbar(); if (rootId) callbacks.onSessionChange?.(); }
      if (focusInput) focusPane(tid);
    }
    async function closeTerminalsByIds(tids = []) {
      const targetIds = tids.filter(Boolean); if (!targetIds.length) return;
      const popped = ns.getPoppedTerminalIds(), groupMap = ns.readGroupMap(), rmSet = new Set(targetIds);
      for (const tid of targetIds) { closingIds.add(tid); delete groupMap[tid]; panes.get(tid)?.emu?.dispose(); panes.get(tid)?.wrap?.remove(); panes.delete(tid); }
      terminals = terminals.filter((t) => !rmSet.has(t.terminalId)); normalizeGroupState();
      if (rootId) {
        if (!terminals.length) {
          popped.delete(rootId); for (const [k, v] of Object.entries(groupMap)) { if (v === rootId) delete groupMap[k]; }
          ns.setPoppedTerminalIds(popped); ns.saveGroupMap(groupMap); callbacks.onSelectTab?.(ns.TERMINAL_TAB_ID, currentSlotKey);
        } else if (rmSet.has(rootId)) {
          const nextRoot = terminals[0].terminalId, nextPopped = new Set([...popped].map((id) => (id === rootId ? nextRoot : id)));
          delete groupMap[nextRoot];
          for (const [k, v] of Object.entries(groupMap)) { if (v === rootId) groupMap[k] = nextRoot; }
          ns.setPoppedTerminalIds(nextPopped); ns.saveGroupMap(groupMap);
          ns.migrateTabGroups(instanceTabId, `${ns.TERMINAL_TAB_PREFIX}${nextRoot}`, new Set(terminals.map((t) => t.terminalId)));
          callbacks.onSelectTab?.(`${ns.TERMINAL_TAB_PREFIX}${nextRoot}`, currentSlotKey);
        } else ns.saveGroupMap(groupMap);
      } else {
        for (const tid of targetIds) popped.delete(tid);
        ns.setPoppedTerminalIds(popped);
        ns.saveGroupMap(groupMap);
        if (!terminals.length) {
          ns.setMainTerminalOpen?.(false);
          callbacks.onSelectTab?.('', currentSlotKey);
        }
      }
      renderToolbar(); renderStage(); const nextFoc = getActiveTerminalId(); if (nextFoc) focusPane(nextFoc);
      await Promise.all(targetIds.map((tid) => ns.apiCall('/api/terminal/close', { terminalId: tid }).catch(() => {})));
      await callbacks.onRefreshState?.(); setTimeout(() => targetIds.forEach((id) => closingIds.delete(id)), 1500);
    }
    const resolveTitle = (tid, fallback = 'pwsh') => ns.readCustomTermTitles?.()?.[tid] || ns.formatTermTitle(panes.get(tid)?.title || terminals.find((x) => x.terminalId === tid)?.title || fallback);
    function startInlineRename(pill, tid) {
      if (isRenaming) return;
      const livePill = pill?.isConnected === false ? Array.from(sessionsEl.children || []).find((c) => c.dataset?.termTid === tid) : pill;
      const lbl = livePill?.isConnected !== false ? livePill?.querySelector?.('.term-session-label') : null; if (!lbl) return;
      const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'term-rename-input'; inp.value = resolveTitle(tid);
      let committed = false; isRenaming = true;
      const commit = (save) => {
        if (committed) return; committed = true; isRenaming = false;
        if (save) { const next = inp.value.trim(); ns.saveCustomTermTitle?.(tid, next); ns.apiCall?.('/api/terminal/rename', { terminalId: tid, title: next })?.catch?.(() => {}); }
        lbl.textContent = resolveTitle(tid); inp.replaceWith?.(lbl); renderToolbar(); renderStage(); if (save && rootId) callbacks.onSessionChange?.();
      };
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') commit(true); else if (e.key === 'Escape') commit(false); });
      inp.addEventListener('blur', () => commit(true)); ['pointerdown', 'click', 'dblclick'].forEach((ev) => inp.addEventListener(ev, (e) => e.stopPropagation())); lbl.replaceWith?.(inp); inp.focus?.(); inp.select?.();
    }
    function ensureDirectPane(tid) {
      const bindHost = (pane) => {
        pane.host = { close: (ids) => closeTerminalsByIds(ids), focus: (id) => setFocusedPane(id, false), onTitle: (id, next) => { const t = terminals.find((x) => x.terminalId === id); if (t) t.title = next; renderToolbar(); }, getTitle: (id) => resolveTitle(id, pane.title) };
        Object.assign(pane.dragCfg, { kind: 'pane', groupId: () => getActiveGroup()?.groupId || '', terminalId: tid, instanceTabId, sessionsEl, stageEl, getActiveGroupId: () => getActiveGroup()?.groupId || '', getSlotKey: () => currentSlotKey, getTitle: () => pane.host.getTitle(tid), onClick: () => setFocusedPane(tid, true), onSameInstanceDrop: applyDropResult });
        return pane;
      };
      let p = panes.get(tid); if (p) return bindHost(p);
      const wrap = document.createElement('div'), headerEl = document.createElement('div'), resizerEl = document.createElement('div');
      wrap.className = 'term-pane'; wrap.dataset.terminalId = tid; wrap.dataset.testid = `terminal-pane-${tid}`; headerEl.className = 'term-pane-header hidden'; resizerEl.className = 'term-pane-resizer';
      headerEl.innerHTML = `<div class="term-pane-header-title"><span class="term-pane-dot" data-role="pane-dot"></span><span class="term-pane-title" data-role="pane-title">pwsh</span></div><button type="button" class="term-pane-close" data-role="pane-close" title="Close Split Pane">${ns.iconSvg('close', 12)}</button>`;
      wrap.append(resizerEl, headerEl);
      let rPid = null, rStartX = 0, rPrevEl = null, rPrevW = 0, rCurW = 0;
      resizerEl.addEventListener('pointerdown', (e) => { const prev = wrap._prevVisibleWrap || wrap.previousElementSibling; if (e.button !== 0 || !prev) return; e.preventDefault(); e.stopPropagation(); rPid = e.pointerId; rStartX = e.clientX; rPrevEl = prev; rPrevW = prev.getBoundingClientRect().width; rCurW = wrap.getBoundingClientRect().width; document.body?.classList?.add('resizing-split'); resizerEl.setPointerCapture?.(e.pointerId); });
      resizerEl.addEventListener('pointermove', (e) => { if (rPid !== e.pointerId || !rPrevEl) return; const dx = Math.max(80 - rPrevW, Math.min(rCurW - 80, e.clientX - rStartX)); rPrevEl.style.flex = `${rPrevW + dx} 1 0%`; wrap.style.flex = `${rCurW - dx} 1 0%`; });
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => resizerEl.addEventListener(ev, (e) => { if (rPid === e.pointerId) { rPid = null; rPrevEl = null; document.body?.classList?.remove('resizing-split'); try { resizerEl.releasePointerCapture?.(e.pointerId); } catch {} } }));
      const titleEl = headerEl.querySelector('[data-role="pane-title"]'), dotEl = headerEl.querySelector('[data-role="pane-dot"]'), closeBtn = headerEl.querySelector('[data-role="pane-close"]');
      closeBtn?.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); });
      closeBtn?.addEventListener('click', (e) => { e.stopPropagation(); p?.host?.close([tid]); });
      const emu = ns.createTerminalEmulator(wrap, {
        onInput: (data) => ns.apiCall('/api/terminal/input', { terminalId: tid, data }).catch(() => {}),
        onResize: (cols, rows) => { if (engineMode === 'direct') ns.apiCall('/api/terminal/input', { terminalId: tid, cols, rows }).catch(() => {}); },
        onTitleChange: (nextTitle) => { const clean = ns.formatTermTitle(nextTitle); if (p) p.title = clean; if (titleEl) titleEl.textContent = resolveTitle(tid, clean); p?.host?.onTitle(tid, clean); },
        onSelectionChange: (selInfo) => p?.quoteCtrl?.show(selInfo), onQuoteShortcut: (text) => p?.quoteCtrl?.triggerQuote(text),
      });
      const quoteCtrl = ns.createQuotePopupController(wrap, { getTerminalMeta: () => ({ terminalId: tid, title: resolveTitle(tid, p?.title || 'pwsh'), conversationId: conversationId && conversationId !== '_new' ? conversationId : '' }), onQuoted: () => p?.emu?.clearSelection() });
      wrap.addEventListener('mousedown', (e) => { if (!e.target?.closest?.('.term-pane-close')) p?.host?.focus(tid); });
      wrap.addEventListener('focusin', () => p?.host?.focus(tid));
      p = bindHost({ wrap, headerEl, titleEl, dotEl, viewportEl: wrap.querySelector?.('.term-viewport'), frame: null, emu, quoteCtrl, dragCfg: {}, afterSeq: 0, lastWasScrollback: false, title: '', jetboxSelection: '' });
      ns.bindTermPointerDrag?.(headerEl, p.dragCfg); panes.set(tid, p); return p;
    }
    function renderToolbar() {
      if (ns.activeTermDrag?.instanceTabId === instanceTabId || ns.pointerTermInstanceId === instanceTabId || isRenaming) return;
      engineMode = ns.readEngineMode();
      const activeGrp = getActiveGroup(), visibleIds = getVisibleIds(), hasSessions = tabGroups.length > 0;
      toolbarEl?.classList.toggle('hidden', !hasSessions); actionsEl?.classList.toggle('hidden', !hasSessions);
      popoutBtn?.classList.toggle('active', Boolean(rootId)); splitBtn?.classList.toggle('active', visibleIds.length > 1);
      sessionsEl.innerHTML = '';
      if (!hasSessions) return;
      const togglePin = (grp) => { grp.pinned = !grp.pinned; tabGroups = [...tabGroups.filter((g) => g.pinned), ...tabGroups.filter((g) => !g.pinned)]; ns.saveTabGroups(instanceTabId, tabGroups); renderToolbar(); };
      tabGroups.forEach((grp, gIdx) => {
        const isCurrent = grp.groupId === activeGrp?.groupId, focTid = grp.focusedPaneId || grp.paneIds[0], isPinned = Boolean(grp.pinned);
        const t = terminals.find((x) => x.terminalId === focTid), cleanTitle = resolveTitle(focTid, t?.title || 'pwsh');
        const pill = document.createElement('button');
        pill.type = 'button'; pill.className = `term-session-pill${isCurrent ? ' active' : ''}`; pill.dataset.pinned = isPinned ? 'true' : 'false'; pill.dataset.termTid = focTid;
        pill.title = `${cleanTitle}${t?.cwd ? ` — ${t.cwd}` : ''}${isPinned ? ' · Pinned' : ''} (Drag to reorder, split, or move across Hangar)`;
        const badgeHtml = grp.paneIds.length > 1 ? `<span class="term-split-badge">(${grp.paneIds.length})</span>` : '';
        const trailHtml = isPinned ? `<span class="term-session-pin" data-pin-gid="${ns.escHtml(grp.groupId)}" title="Unpin Tab">${ns.iconSvg('keep', 16)}</span>` : `<span class="term-session-close-wrap"><span class="term-session-close" data-close-gid="${ns.escHtml(grp.groupId)}" title="Close Tab">${ns.iconSvg('close', 14)}</span></span>`;
        pill.innerHTML = `${ns.iconSvg('terminal', 16)}<span class="term-session-label">${ns.escHtml(cleanTitle)}</span>${badgeHtml}${trailHtml}`;
        pill.querySelector('[data-close-gid]')?.addEventListener('click', (e) => { e.stopPropagation(); closeTerminalsByIds(grp.paneIds); });
        pill.querySelector('[data-pin-gid]')?.addEventListener('click', (e) => { e.stopPropagation(); togglePin(grp); });
        pill.addEventListener('dblclick', (e) => { e.stopPropagation(); startInlineRename(pill, focTid); });
        pill.addEventListener('auxclick', (e) => { if (e.button === 1 && !isPinned) { e.preventDefault(); e.stopPropagation(); closeTerminalsByIds(grp.paneIds); } });
        pill.addEventListener('contextmenu', (e) => {
          const others = tabGroups.filter((g) => g.groupId !== grp.groupId && !g.pinned), right = tabGroups.slice(gIdx + 1).filter((g) => !g.pinned);
          ns.openTabContextMenu?.(e, [
            { id: isPinned ? 'unpin-tab' : 'pin-tab', label: isPinned ? 'Unpin Tab' : 'Pin Tab', onClick: () => togglePin(grp) },
            { id: 'rename-tab', label: 'Rename Terminal…', onClick: () => startInlineRename(pill, focTid) },
            { id: 'split-tab', label: 'Split Terminal Right', onClick: () => spawnTerminal(focTid) },
            { id: 'quote-tab', label: 'Quote Terminal in Chat', onClick: () => { const sel = (engineMode === 'jetbox' ? panes.get(focTid)?.jetboxSelection : panes.get(focTid)?.emu?.getSelection()) || '', qp = ns.copyTerminalQuoteToClipboard({ terminalId: focTid, title: cleanTitle, selectionContent: sel }); ns.showTerminalQuoteToast?.(rootEl, `Copied @${qp.cleanName} mention pill — press Ctrl+V in chat`); } },
            { id: 'quote-ask-tab', label: 'Quote & Ask Agent…', onClick: () => { const sel = (engineMode === 'jetbox' ? panes.get(focTid)?.jetboxSelection : panes.get(focTid)?.emu?.getSelection()) || '', qp = ns.copyTerminalQuoteToClipboard({ terminalId: focTid, title: cleanTitle, selectionContent: sel }); ns.openTerminalQuoteComposer?.(rootEl, qp, { conversationId: conversationId && conversationId !== '_new' ? conversationId : (t?.conversationId || '') }); } },
            { id: 'toggle-engine', label: engineMode === 'jetbox' ? 'Switch to Direct VT100 Engine' : 'Switch to Native Terminal Engine', onClick: () => { ns.saveEngineMode(engineMode === 'jetbox' ? 'direct' : 'jetbox'); renderToolbar(); renderStage(); } },
            { separator: true },
            { id: 'close-tab', label: 'Close Tab', disabled: isPinned, onClick: () => closeTerminalsByIds(grp.paneIds) },
            { id: 'close-other-tabs', label: 'Close Other Tabs', disabled: !others.length, onClick: () => { activeGroupId = grp.groupId; ns.setActiveGroupId?.(instanceTabId, activeGroupId); closeTerminalsByIds(others.flatMap((g) => g.paneIds)); } },
            { id: 'close-tabs-to-the-right', label: 'Close Tabs to the Right', disabled: !right.length, onClick: () => closeTerminalsByIds(right.flatMap((g) => g.paneIds)) },
          ]);
        });
        ns.bindTermPointerDrag?.(pill, {
          kind: 'tab', groupId: grp.groupId, terminalId: focTid, instanceTabId, sessionsEl, stageEl, getActiveGroupId: () => getActiveGroup()?.groupId || '', getSlotKey: () => currentSlotKey,
          onClick: () => { if (activeGroupId !== grp.groupId) { activeGroupId = grp.groupId; ns.setActiveGroupId?.(instanceTabId, activeGroupId); for (const c of Array.from(sessionsEl.children || [])) c.classList?.toggle('active', c === pill); renderStage(); if (rootId) callbacks.onSessionChange?.(); } focusPane(getActiveTerminalId()); pollVisiblePanes(); }, onSameInstanceDrop: applyDropResult,
        });
        sessionsEl.appendChild(pill);
      });
      const addTabBtn = document.createElement('button');
      addTabBtn.type = 'button'; addTabBtn.className = 'chrome-icon-btn term-strip-add-btn'; addTabBtn.dataset.testid = 'aux-pane-new-tab-button'; addTabBtn.title = 'New Terminal Tab';
      addTabBtn.innerHTML = ns.iconSvg('add', 16); addTabBtn.addEventListener('click', (e) => { e.stopPropagation(); spawnTerminal(''); });
      sessionsEl.appendChild(addTabBtn);
    }
    function renderStage() {
      const active = getActiveTermObj(), activeTid = getActiveTerminalId();
      stageEl.dataset.testid = 'terminal-split-container';
      if (!active) {
        stageEl.innerHTML = `<div class="empty-split-zone"><button type="button" class="agy-btn agy-btn-primary has-icon" data-role="spawn-empty">${ns.iconSvg('add', 14)}<span>Launch Interactive Terminal</span></button></div>`;
        stageEl.querySelector('[data-role="spawn-empty"]')?.addEventListener('click', () => spawnTerminal()); return;
      }
      const visibleIds = getVisibleIds(), visSet = new Set(visibleIds), instanceIds = new Set(terminals.map((t) => t.terminalId));
      const isSplit = visibleIds.length > 1, isJetbox = engineMode === 'jetbox';
      const isLight = document.body.classList.contains('theme-light'), uiTok = new URLSearchParams(window.location?.search || '').get('token') || '';
      for (const ch of Array.from(stageEl.children || [])) {
        const cid = ch.dataset?.terminalId;
        if (!cid || !instanceIds.has(cid)) { ch._mountedParent = null; ch.remove?.(); }
        else if (!visSet.has(cid)) { ch.classList.add('hidden'); ch.classList.remove('is-split-secondary', 'is-focused-pane'); ch.dataset.active = 'false'; }
      }
      stageEl.querySelectorAll('.empty-split-zone').forEach((el) => el.remove());
      visibleIds.forEach((tid, idx) => {
        const p = ensureDirectPane(tid), t = terminals.find((x) => x.terminalId === tid), cleanTitle = resolveTitle(tid, p.title || t?.title || 'pwsh'), isFoc = tid === activeTid;
        const wasHidden = p.wrap.classList.contains('hidden');
        p.wrap.classList.remove('hidden');
        p.wrap.classList.toggle('is-split-secondary', isSplit && idx > 0);
        p.wrap._prevVisibleWrap = isSplit && idx > 0 ? panes.get(visibleIds[idx - 1])?.wrap || null : null;
        if (p.wrap?.style) { p.wrap.style.order = String(idx); if (!isSplit) p.wrap.style.flex = ''; }
        p.headerEl?.classList.toggle('hidden', !isSplit); if (p.titleEl && p.titleEl.textContent !== cleanTitle) p.titleEl.textContent = cleanTitle;
        p.dotEl?.classList.toggle('active', isFoc); p.wrap.dataset.active = isFoc ? 'true' : 'false';
        p.wrap.classList.toggle('is-focused-pane', isFoc && isSplit); p.viewportEl?.classList.toggle('hidden', isJetbox);
        if (isJetbox) {
          const effCid = (conversationId && conversationId !== '_new') ? conversationId : (t?.conversationId || tid), src = `/jetbox-terminal?cascadeId=${encodeURIComponent(effCid)}&terminalId=${encodeURIComponent(tid)}&hostTheme=${isLight ? 'light' : 'dark'}&v=10${uiTok ? `&token=${encodeURIComponent(uiTok)}` : ''}`;
          if (!p.frame) {
            p.frame = document.createElement('iframe'); p.frame.className = 'term-jetbox-frame'; p.frame.dataset.loadedSrc = src; p.frame.src = src;
            p.frame.addEventListener?.('load', () => { const te = ns.getLatestThemeEvent?.(); if (te) try { p.frame.contentWindow?.postMessage(te, '*'); } catch {} if (isInstanceVisible && tid === getActiveTerminalId()) focusPane(tid); });
            p.wrap.appendChild(p.frame);
          } else if (p.frame.dataset.loadedSrc !== src) { p.frame.dataset.loadedSrc = src; p.frame.src = src; }
          else if (wasHidden) { try { p.frame.contentWindow?.postMessage({ type: 'hangar-jetbox-shown', focus: isFoc }, '*'); } catch {} }
        } else if (p.frame) { p.frame.remove?.(); p.frame = null; }
        if (p.wrap.parentElement !== stageEl && p.wrap._mountedParent !== stageEl) { p.wrap._mountedParent = stageEl; stageEl.appendChild(p.wrap); }
      });
    }
    async function spawnTerminal(splitFromId = '') {
      const activeTid = getActiveTerminalId(), activeGrp = getActiveGroup(), sRect = stageEl.getBoundingClientRect?.() || { width: 0, height: 0 };
      const paneW = sRect.width > 80 ? (splitFromId ? sRect.width / ((activeGrp?.paneIds?.length || 1) + 1) : sRect.width) : 0;
      const dims = engineMode === 'direct' && panes.get(activeTid)?.emu ? panes.get(activeTid).emu.getDimensions() : { cols: paneW ? Math.max(24, Math.min(240, Math.floor((paneW - 24) / 7.6))) : 0, rows: sRect.height > 40 ? Math.max(6, Math.min(120, Math.floor((sRect.height - 16) / 17))) : 0 };
      if (splitFromId && activeGrp) pendingSplit = { groupId: activeGrp.groupId, afterPaneId: splitFromId };
      const created = await ns.apiCall('/api/terminal/create', { workspacePath, conversationId, splitFromTerminalId: splitFromId || '', cols: dims.cols, rows: dims.rows });
      if (created?.terminalId) {
        created.title = ns.formatTermTitle(created.title || 'pwsh');
        if (rootId) { const groupMap = ns.readGroupMap(); groupMap[created.terminalId] = rootId; ns.saveGroupMap(groupMap); }
        terminals = [...terminals.filter((t) => t.terminalId !== created.terminalId), created];
        if (splitFromId && activeGrp) { tabGroups = ns.insertSplitPane(tabGroups, activeGrp.groupId, splitFromId, created.terminalId); activeGroupId = activeGrp.groupId; pendingSplit = null; ns.setActiveGroupId?.(instanceTabId, activeGroupId); ns.saveTabGroups(instanceTabId, tabGroups); }
        else { activeGroupId = created.terminalId; ns.setActiveGroupId?.(instanceTabId, activeGroupId); normalizeGroupState(); }
        renderToolbar(); renderStage(); focusPane(created.terminalId); pollVisiblePanes(); await callbacks.onRefreshState?.();
      } else pendingSplit = null;
    }
    rootEl.querySelector('[data-action="split"]')?.addEventListener('click', () => { const tid = getActiveTerminalId(); if (tid) spawnTerminal(tid); });
    rootEl.querySelector('[data-action="popout"]')?.addEventListener('click', () => {
      const activeGrp = getActiveGroup(); if (!activeGrp || !activeGrp.paneIds.length) return;
      if (rootId) { ns.demoteHangarTabIntoInstance(instanceTabId, { targetInstanceTabId: ns.TERMINAL_TAB_ID, zone: 'strip' }); callbacks.onSelectTab?.(ns.TERMINAL_TAB_ID, currentSlotKey); }
      else {
        const paneSet = new Set(activeGrp.paneIds), res = ns.promoteDragToHangarBar({ kind: 'tab', groupId: activeGrp.groupId, terminalId: getActiveTerminalId(), instanceTabId });
        for (const tid of paneSet) { const p = panes.get(tid); if (p?.wrap) { p.wrap._mountedParent = null; p.wrap.remove?.(); } }
        terminals = terminals.filter((t) => !paneSet.has(t.terminalId)); normalizeGroupState(); renderToolbar(); renderStage();
        if (res?.newSidecarId) callbacks.onSelectTab?.(res.newSidecarId, currentSlotKey);
      }
    });
    async function pollVisiblePanes() {
      if (pollBusy || !isInstanceVisible || engineMode !== 'direct') return;
      pollBusy = true;
      try {
        for (const tid of getVisibleIds()) {
          const p = panes.get(tid); if (!p) continue;
          try {
            const data = await ns.apiCall('/api/terminal/poll', { terminalId: tid, afterSeq: p.afterSeq }), nextTitle = data.title ? ns.formatTermTitle(data.title) : '';
            if (nextTitle && nextTitle !== p.title) { p.title = nextTitle; if (p.titleEl) p.titleEl.textContent = resolveTitle(tid, nextTitle); const t = terminals.find((x) => x.terminalId === tid); if (t) { t.title = nextTitle; renderToolbar(); } }
            for (const chunk of data.chunks || []) {
              if ((chunk.seq || 0) <= p.afterSeq) continue;
              const isReset = Boolean(chunk.isScrollback && !p.lastWasScrollback); p.lastWasScrollback = Boolean(chunk.isScrollback); p.afterSeq = chunk.seq || p.afterSeq;
              if (chunk.text) p.emu.write(chunk.text, { reset: isReset });
            }
          } catch {}
        }
      } finally { pollBusy = false; }
    }
    const pollTimer = setInterval(pollVisiblePanes, 70);
    return {
      rootEl, setVisible(vis) { if (vis && !isInstanceVisible) pendingFocus = true; isInstanceVisible = Boolean(vis); },
      focusTerminal(tid) { tabGroups = ns.readTabGroups(instanceTabId); const g = tabGroups.find((grp) => grp.paneIds.includes(tid)); if (g) { activeGroupId = g.groupId; g.focusedPaneId = tid; ns.setActiveGroupId?.(instanceTabId, activeGroupId); ns.saveTabGroups(instanceTabId, tabGroups); pendingFocus = true; } },
      mountInto(slotEl, slotKey) { currentSlotKey = slotKey; if (!slotEl.contains?.(rootEl)) slotEl.appendChild(rootEl); for (const ch of Array.from(slotEl.children || [])) ch.classList?.toggle?.('hidden', ch !== rootEl); },
      sync({ nextTerminals, nextWorkspacePath, nextConversationId, cb }) {
        terminals = Array.isArray(nextTerminals) ? nextTerminals.map((t) => { const clean = ns.formatTermTitle(t.title || 'pwsh'), p = panes.get(t.terminalId); if (p && t.title) p.title = clean; return { ...t, title: clean }; }) : [];
        workspacePath = nextWorkspacePath || ''; conversationId = nextConversationId || ''; callbacks = cb || {};
        normalizeGroupState(); renderToolbar(); renderStage(); if (pendingFocus && isInstanceVisible) { pendingFocus = false; const actTid = getActiveTerminalId(); if (actTid) focusPane(actTid); } pollVisiblePanes();
      },
      handleJetboxEvent(type, payload = {}, sourceWin) {
        const tid = payload?.terminalId; if (!tid || !getVisibleIds().includes(tid)) return;
        const p = panes.get(tid), fWin = p?.frame?.contentWindow; if (sourceWin && fWin && fWin !== sourceWin) return;
        if (type !== 'hangar-jetbox-title-changed') setFocusedPane(tid, false);
        if (type === 'hangar-jetbox-selection-changed' && p) p.jetboxSelection = String(payload.selectionContent || '');
        else if (type === 'hangar-jetbox-title-changed' && payload.title) {
          const clean = ns.formatTermTitle(payload.title); if (p) p.title = clean;
          const t = terminals.find((x) => x.terminalId === tid); if (t) t.title = clean;
          if (p?.titleEl) p.titleEl.textContent = resolveTitle(tid, clean); renderToolbar();
        } else if (type === 'hangar-jetbox-quote-clicked') {
          const t = terminals.find((x) => x.terminalId === tid) || getActiveTermObj(); if (!t) return;
          const sel = String(payload.selectionContent || p?.jetboxSelection || ''), qp = ns.copyTerminalQuoteToClipboard({ terminalId: t.terminalId, title: resolveTitle(t.terminalId, payload.title || t.title || 'terminal'), selectionContent: sel, alreadyCopied: Boolean(payload.copied) });
          if (p) p.jetboxSelection = '';
          ns.showTerminalQuoteToast?.(rootEl, sel ? `Quoted selection from "${qp.cleanName}" — press Ctrl+V in chat` : `Copied @${qp.cleanName} mention pill — press Ctrl+V in chat`);
          if (payload.askAgent) ns.openTerminalQuoteComposer?.(rootEl, qp, { conversationId: conversationId && conversationId !== '_new' ? conversationId : (t.conversationId || '') });
        } else if (type === 'hangar-jetbox-quote-dragend') {
          const t = terminals.find((x) => x.terminalId === tid) || getActiveTermObj(); if (!t) return;
          const sel = String(payload.selectionContent || p?.jetboxSelection || '').trim(); if (!sel) return;
          const cleanTitle = resolveTitle(t.terminalId, payload.title || t.title || 'terminal');
          if (p) p.jetboxSelection = '';
          const fRect = p?.frame?.getBoundingClientRect?.() || { left: 0, top: 0, right: 0, bottom: 0 };
          const hx = fRect.left + (Number(payload.clientX) || 0), hy = fRect.top + (Number(payload.clientY) || 0);
          const scBoxes = [...(document.querySelectorAll?.('.term-quote-composer:not(.hidden)') || []), ...(ns._sideChatBox && !ns._sideChatBox.classList?.contains?.('hidden') ? [ns._sideChatBox] : [])];
          for (const scBox of new Set(scBoxes)) {
            const sRect = scBox.getBoundingClientRect?.() || { left: 0, top: 0, right: 0, bottom: 0 };
            if (hx >= sRect.left && hx <= sRect.right && hy >= sRect.top && hy <= sRect.bottom) {
              const qp = ns.buildTerminalScopePayload({ terminalId: t.terminalId, title: cleanTitle, selectionContent: sel });
              try { scBox._els?.chatFrame?.contentWindow?.postMessage({ type: 'hangar-inject-terminal-quote', payload: qp }, '*'); } catch {}
              return;
            }
          }
          const winW = Number(window.innerWidth) || fRect.right || 0, winH = Number(window.innerHeight) || fRect.bottom || 0;
          if (hx < 0 || hy < 0 || (winW > 0 && hx > winW) || (winH > 0 && hy > winH)) {
            const effCid = conversationId && conversationId !== '_new' ? conversationId : (t.conversationId || '');
            ns.apiCall?.('/api/terminal/ls-rpc', { method: 'InjectQuoteDrop', conversationId: effCid, terminalId: t.terminalId, title: cleanTitle, selectionContent: sel })?.catch?.(() => {});
          }
        }
      },
      dispose() { clearInterval(pollTimer); rootEl.remove?.(); },
    };
  }
  window.addEventListener('message', (e) => { if (e.data?.type?.startsWith?.('hangar-jetbox-')) for (const ctrl of instanceControllers.values()) ctrl.handleJetboxEvent(e.data.type, e.data.payload, e.source); });
  ns.disposeTerminalInstance = (tabId) => { instanceControllers.get(tabId)?.dispose(); instanceControllers.delete(tabId); };
  ns.closeTerminalInstance = async (tabId, allTerminals = []) => {
    const rId = String(tabId || '').startsWith(ns.TERMINAL_TAB_PREFIX) ? String(tabId).slice(ns.TERMINAL_TAB_PREFIX.length) : '';
    const tids = ns.getInstanceTerminals(allTerminals, rId).map((t) => t.terminalId); if (rId && !tids.includes(rId)) tids.push(rId);
    const popped = ns.getPoppedTerminalIds(), groupMap = ns.readGroupMap(); if (rId) popped.delete(rId);
    for (const tid of tids) { closingIds.add(tid); popped.delete(tid); delete groupMap[tid]; sharedPanes.get(tid)?.emu?.dispose(); sharedPanes.get(tid)?.wrap?.remove(); sharedPanes.delete(tid); }
    ns.setPoppedTerminalIds(popped); ns.saveGroupMap(groupMap); ns.saveTabGroups(tabId, []); ns.disposeTerminalInstance(tabId);
    await Promise.all(tids.map((tid) => ns.apiCall?.('/api/terminal/close', { terminalId: tid }).catch(() => {})));
    setTimeout(() => tids.forEach((id) => closingIds.delete(id)), 1500);
  };
  ns.focusTerminalInInstance = (tabId, tid) => { const grps = ns.readTabGroups(tabId), g = grps.find((grp) => grp.paneIds.includes(tid)); if (g) { g.focusedPaneId = tid; ns.setActiveGroupId?.(tabId, g.groupId); ns.saveTabGroups(tabId, grps); } instanceControllers.get(tabId)?.focusTerminal(tid); };
  ns.renderTerminalSlots = function renderTerminalSlots({ topTermEl, bottomTermEl, topSlotId, bottomSlotId, splitEnabled, terminals = [], workspacePath = '', conversationId = '', onRefreshState, onSelectTab, onCrossInstanceMerge, onSessionChange }) {
    const liveTerms = (terminals || []).filter((t) => !closingIds.has(t.terminalId)), liveIds = new Set(liveTerms.map((t) => t.terminalId));
    if (liveTerms.length > 0) { for (const [tid, p] of sharedPanes.entries()) { if (!liveIds.has(tid)) { p.emu?.dispose(); p.wrap?.remove(); sharedPanes.delete(tid); } } }
    const slots = [{ key: 'top', el: topTermEl, tabId: topSlotId, slotClass: 'slot-top' }, { key: 'bottom', el: bottomTermEl, tabId: splitEnabled && bottomSlotId !== topSlotId ? bottomSlotId : '', slotClass: 'slot-bottom' }], activeTabIds = new Set();
    for (const s of slots) {
      if (!s.el) continue;
      const isVisible = ns.isTerminalTabId(s.tabId); s.el.classList.toggle('hidden', !isVisible); s.el.classList.toggle(s.slotClass, isVisible);
      if (!isVisible) continue;
      activeTabIds.add(s.tabId);
      const rootId = String(s.tabId).startsWith(ns.TERMINAL_TAB_PREFIX) ? String(s.tabId).slice(ns.TERMINAL_TAB_PREFIX.length) : '';
      let ctrl = instanceControllers.get(s.tabId); if (!ctrl) { ctrl = createInstanceController(s.tabId, rootId); instanceControllers.set(s.tabId, ctrl); }
      ctrl.mountInto(s.el, s.key); ctrl.setVisible(true);
      ctrl.sync({ nextTerminals: ns.getInstanceTerminals(liveTerms, rootId), nextWorkspacePath: workspacePath, nextConversationId: conversationId, cb: { onRefreshState, onSelectTab, onCrossInstanceMerge, onSessionChange } });
    }
    const popped = ns.getPoppedTerminalIds();
    for (const [tabId, ctrl] of instanceControllers.entries()) {
      if (!activeTabIds.has(tabId)) { ctrl.setVisible(false); if (tabId !== ns.TERMINAL_TAB_ID && !popped.has(tabId.slice(ns.TERMINAL_TAB_PREFIX.length))) { ctrl.dispose(); instanceControllers.delete(tabId); } }
    }
  };
})();
