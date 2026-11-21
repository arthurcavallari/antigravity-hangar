/** @fileoverview Docked Side Question companion pane controller and iframe lifecycle. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  const store = ns.sideChatStore;
  const sc = store?.state || ns._sc;

  const buildChatFrameSrc = (cascadeId) => {
    const isLight = window.AgyShell
      ? !window.AgyShell.isHostDarkTheme()
      : Boolean(document.body?.classList?.contains?.('theme-light'));
    const uiTok = ns.getUiToken?.() || new URLSearchParams(window.location?.search || '').get('token') || '';
    return `/jetbox-chat?cascadeId=${encodeURIComponent(cascadeId)}&hostTheme=${isLight ? 'light' : 'dark'}&v=9${uiTok ? `&token=${encodeURIComponent(uiTok)}` : ''}`;
  };

  const ATTR_MAP = {
    role: 'role',
    ariaLabel: 'aria-label',
    ariaExpanded: 'aria-expanded',
    ariaPressed: 'aria-pressed',
    title: 'title',
    allow: 'allow',
  };

  const mkEl = (ns._mkSideChatEl = function mkEl(tag, className, { html: rawHtml, ...rest } = {}, ds = {}, onClick = null) {
    const e = Object.assign(document.createElement(tag), { className, ...rest });
    for (const [prop, attr] of Object.entries(ATTR_MAP)) {
      if (rest[prop] !== undefined && rest[prop] !== '') {
        e.setAttribute?.(attr, String(rest[prop]));
      }
    }
    if (rawHtml !== undefined) {
      ns.setHtml(e, ns.rawHtml ? ns.rawHtml(rawHtml) : rawHtml);
    }
    e.dataset = Object.assign(e.dataset || {}, ds);
    for (const [k, v] of Object.entries(ds)) {
      if (v !== undefined) {
        const kebab = k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
        e.setAttribute?.(`data-${kebab}`, String(v));
      }
    }
    if (onClick) {
      e.addEventListener?.('click', (ev) => {
        ev?.stopPropagation?.();
        onClick(ev);
      });
    }
    return e;
  });

  const isTrustedSideChatMessage = (e) => {
    if (e?.origin !== undefined) {
      const locOrigin = window.location?.origin;
      const isPluginOrigin = (ns.PLUGIN_ORIGIN_RE || /^plugin:\/\/[a-z0-9][a-z0-9._-]*-\d+\/?$/i).test(String(e.origin));
      if (
        locOrigin
          ? e.origin !== locOrigin && !isPluginOrigin
          : !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(String(e.origin)) && !isPluginOrigin
      ) {
        return false;
      }
    }
    if (e?.source === null) return false;
    if (e?.source === undefined || e.source === window) return true;
    for (const box of sc.boxes.values()) {
      const chatWin = box?._els?.chatFrame?.contentWindow;
      const initWin = box?._els?.initialFrame?.contentWindow;
      if ((chatWin && chatWin === e.source) || (initWin && initWin === e.source)) return true;
    }
    for (const frame of sc.frames?.values?.() || []) {
      if (frame?.contentWindow && frame.contentWindow === e.source) return true;
    }
    return false;
  };

  const foreignNavIds = new Set();
  const overviewOpenIds = new Set();
  ns._onDisposeSideChatFrame = (cid) => {
    foreignNavIds.delete(cid);
    overviewOpenIds.delete(cid);
  };

  window.addEventListener?.('message', (e) => {
    const type = e.data?.type;
    if (!type || !String(type).startsWith('hangar-sidechat-')) return;
    if (!isTrustedSideChatMessage(e)) return;
    const payload = e.data?.payload || {};
    const tabId = ns.SIDECHAT_TAB_ID;
    const box = sc.boxes.get(tabId) || ns._sideChatBox;
    const slotPane = box?.dataset?.slot === 'bottom' ? 'bottom' : 'top';
    if (type === 'hangar-sidechat-quote-injected') {
      const th = sc.threads.find((t) => t.cascadeId === payload.cascadeId);
      const wasActive = Boolean(th?.hasActivity);
      if (store) {
        store.markThreadActivity(payload.cascadeId, true);
      } else if (th) {
        th.hasActivity = true;
      }
      if (box?._pendingQuote) {
        box._pendingQuote = null;
      }
      if (th && !wasActive) {
        ns.notifySideChatState?.();
      }
    } else if (type === 'hangar-sidechat-open-terminal') {
      if (payload.cascadeId) {
        overviewOpenIds.delete(payload.cascadeId);
      }
      if (box) {
        box._overviewOpen = false;
      }
      box?._els?.overviewBtn?.classList?.remove?.('active');
      box?._els?.overviewBtn?.blur?.();
      ns.notifySideChatState?.({
        openTerminal: true,
        pane: slotPane,
        sourceTabId: tabId,
      });
    } else if (type === 'hangar-sidechat-overview-state') {
      const isOpen = Boolean(payload.open);
      if (payload.cascadeId) {
        if (isOpen) {
          overviewOpenIds.add(payload.cascadeId);
        } else {
          overviewOpenIds.delete(payload.cascadeId);
        }
      }
      if (box && (!payload.cascadeId || ns.getActiveSideChatId() === payload.cascadeId)) {
        box._overviewOpen = isOpen;
        box._els?.overviewBtn?.classList?.toggle?.('active', box._overviewOpen);
        if (!isOpen) {
          box._els?.overviewBtn?.blur?.();
        }
      }
    } else if (type === 'hangar-sidechat-foreign-nav') {
      const expCid = payload.expectedCascadeId || payload.cascadeId || '';
      const isForeign = payload.active !== undefined ? Boolean(payload.active) : Boolean(payload.cascadeId && payload.cascadeId !== expCid);
      if (expCid) {
        if (isForeign) {
          foreignNavIds.add(expCid);
        } else {
          foreignNavIds.delete(expCid);
        }
      }
      if (box && (!expCid || ns.getActiveSideChatId() === expCid)) {
        box._els?.backBtn?.classList?.toggle?.('hidden', !isForeign);
      }
    } else if (type === 'hangar-sidechat-switch-cascade' && sc.threads.some((t) => t.cascadeId === payload.cascadeId)) {
      ns.setActiveSideChatId(payload.cascadeId);
      box?._syncThreadsUi?.(payload.cascadeId, null);
      ns.notifySideChatState?.({ activateTab: true, targetTabId: tabId, pane: slotPane });
    } else if (type === 'hangar-sidechat-open-parent') {
      const fallbackParent = sc.threads.find((t) => t.cascadeId === payload.cascadeId)?.parentConversationId || '';
      const parentId = String(payload.parentConversationId || fallbackParent || '').trim();
      if (!parentId) return;
      if (sc.threads.some((t) => t.cascadeId === parentId)) {
        ns.setActiveSideChatId(parentId);
        box?._syncThreadsUi?.(parentId, null);
        ns.notifySideChatState?.({ activateTab: true, targetTabId: tabId, pane: slotPane });
      } else {
        (ns.openHostConversation || window.sidecar?.toggleConversation)?.(parentId);
      }
    } else if (type === 'hangar-sidechat-run-state') {
      const cid = String(payload.cascadeId || '').trim();
      const th = cid ? sc.threads.find((t) => t.cascadeId === cid) : null;
      if (th) {
        const wasActive = Boolean(th.hasActivity);
        if (payload.isRunning !== undefined) {
          th.isRunning = Boolean(payload.isRunning);
        }
        if (payload.hasActivity || payload.isRunning) {
          th.hasActivity = true;
        }
        box?._syncPromoteBtn?.();
        if (!wasActive && th.hasActivity) {
          ns.notifySideChatState?.();
        }
      }
    } else if (type === 'hangar-sidechat-open-sidecar') {
      const cands = Array.isArray(payload.candidateIds) ? payload.candidateIds : [];
      const rawId = String(payload.sidecarId || cands[0] || '').trim();
      if (!rawId) return;
      let targetTabId = rawId === 'dashboard' ? (ns.EXTENSIONS_TAB_ID || '__extensions__') : '';
      if (rawId !== 'dashboard' && typeof document.querySelectorAll === 'function') {
        const known = Array.from(document.querySelectorAll('[data-sidecar-id]'))
          .map((el) => el.dataset?.sidecarId || el.getAttribute?.('data-sidecar-id') || '')
          .filter(Boolean);
        const hit =
          cands.find((id) => known.includes(id)) ||
          known.find((id) => cands.some((c) => id === c || id.endsWith('/' + c) || id.endsWith('--' + c)));
        if (hit) {
          targetTabId = hit;
        }
      }
      if (!targetTabId) return;
      ns.notifySideChatState?.({
        activateTab: true,
        targetTabId,
        pane: slotPane,
      });
    }
  });

  ns.ensureSideChatBox = function ensureSideChatBox(_instanceTabId, root) {
    const curTabId = ns.SIDECHAT_TAB_ID;
    let box = sc.boxes.get(curTabId) || root?._hangarQuoteComposer || ns._sideChatBox;
    if (box) return box;
    box = mkEl('div', 'term-quote-composer', {}, { dockMode: 'docked', instanceTabId: curTabId });
    const hdr = mkEl('div', 'term-toolbar term-quote-composer-hdr');
    const sessionsEl = mkEl('agy-tab-strip', 'agy-tab-strip agy-tab-strip-sub', { ariaLabel: 'Side Question threads' }, { role: 'sessions' });
    const overflowBtn = mkEl(
      'button',
      'agy-icon-btn agy-tab-overflow-btn hidden',
      {
        type: 'button',
        title: 'More Side Questions',
        ariaLabel: 'More Side Questions',
        html: ns.iconSvg?.('more_horiz', 16) || '⋯',
      },
      { role: 'sidechat-overflow' }
    );
    const overflowPopover = mkEl(
      'div',
      'agy-tab-overflow-popover',
      {},
      { role: 'sidechat-overflow-popover' }
    );
    overflowPopover.setAttribute?.('popover', 'auto');
    const actionsEl = mkEl('div', 'term-toolbar-actions');

    const spawnNewInInstance = async () => {
      box._payload = { cleanName: 'terminal', terminalId: '', selectionContent: '' };
      const thread = await ns.ensureSideChatThread({
        parentConversationId: box._convId || '',
        labelHint: '',
        forceNew: true,
      });
      if (thread?.cascadeId) {
        box._syncThreadsUi(thread.cascadeId, null);
      }
      ns.notifySideChatState();
    };

    const confirmBar = mkEl(
      'div',
      'agy-consent-bar sidechat-consent-bar hidden',
      { role: 'alertdialog', ariaLabel: 'Confirm Delete Side Question' },
      { role: 'sidechat-delete-confirm' }
    );
    const confirmText = mkEl('div', 'consent-text', {}, { role: 'sidechat-delete-confirm-text' });
    const confirmActions = mkEl('div', 'consent-actions');
    let pendingDeleteState = null;
    const closeDeleteConfirm = (restoreFocus = false) => {
      pendingDeleteState = null;
      confirmBar.classList?.add?.('hidden');
      if (restoreFocus) {
        const actCid = ns.getActiveSideChatId();
        const activePill = actCid
          ? Array.from(sessionsEl.querySelectorAll?.('.agy-tab') || []).find((el) => el.dataset?.cascadeId === actCid)
          : null;
        activePill?.focus?.();
      }
    };
    const executeConfirmedDelete = () => {
      const cur = pendingDeleteState;
      closeDeleteConfirm(false);
      if (!cur) return;
      if (cur.deleteAll) {
        ns.closeSideChatDrawer?.({ deleteAll: true, notify: true });
      } else {
        ns.deleteSideChatsByIds(cur.targetIds);
      }
    };
    const openDeleteConfirm = (targetIds = [], opts = {}) => {
      const ids = targetIds.filter(Boolean);
      if (!ids.length) return;
      const targetSet = new Set(ids);
      const targets = sc.threads.filter((t) => targetSet.has(t.cascadeId));
      const hasExt = targets.some((t) => t.isExternal);
      const extSuffix = hasExt ? ' (also deletes shared Antigravity thread)' : '';
      pendingDeleteState = { targetIds: ids, deleteAll: Boolean(opts.deleteAll) };
      if (ids.length === 1) {
        const th = targets[0] || sc.threads.find((t) => t.cascadeId === ids[0]);
        const label = ns.resolveSideChatTitle(th);
        confirmText.textContent = `Delete Side Question "${label}"${extSuffix}? This cannot be undone.`;
        confirmDeleteBtn.textContent = 'Delete';
      } else {
        confirmText.textContent = `Delete ${ids.length} Side Questions${extSuffix}? This cannot be undone.`;
        confirmDeleteBtn.textContent = opts.deleteAll ? 'Delete All' : `Delete (${ids.length})`;
      }
      confirmBar.classList?.remove?.('hidden');
      confirmCancelBtn.focus?.();
    };
    const confirmCancelBtn = mkEl(
      'button',
      'agy-btn agy-btn-secondary',
      { type: 'button', textContent: 'Cancel' },
      { role: 'sidechat-delete-cancel' },
      () => closeDeleteConfirm(true)
    );
    const confirmDeleteBtn = mkEl(
      'button',
      'agy-btn agy-btn-danger',
      { type: 'button', textContent: 'Delete' },
      { role: 'sidechat-delete-confirm-btn' },
      () => executeConfirmedDelete()
    );
    confirmActions.append?.(confirmCancelBtn, confirmDeleteBtn);
    confirmBar.append?.(confirmText, confirmActions);
    confirmBar.addEventListener?.('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault?.();
        e.stopPropagation?.();
        closeDeleteConfirm(true);
      }
    });

    const backBtn = mkEl(
      'button',
      'agy-btn agy-btn-outline term-sidechat-main-btn hidden',
      { type: 'button', title: 'Return to the active Side Question thread', textContent: '↩ Back to Side Question' },
      { role: 'sidechat-back' },
      () => {
        const actCid = ns.getActiveSideChatId();
        if (!actCid) return;
        foreignNavIds.delete(actCid);
        backBtn.classList?.add?.('hidden');
        const target = sc.frames.get(actCid) || box._els.chatFrame;
        if (target?.dataset) {
          target.dataset.loadedCascadeId = actCid;
        }
        if (target) {
          target.src = buildChatFrameSrc(actCid);
        }
      }
    );
    const deleteBtn = mkEl(
      'button',
      'agy-icon-btn',
      {
        type: 'button',
        title: 'Delete Side Question',
        ariaLabel: 'Delete Side Question',
        html: ns.iconSvg?.('delete', 16) || '🗑',
      },
      { action: 'kill', role: 'sidechat-delete', testid: 'side-question-tab-delete' },
      () => {
        const activeId = ns.getActiveSideChatId() || sc.threads[0]?.cascadeId || '';
        if (activeId) {
          (ns.requestDeleteSideChats || ns.deleteSideChatsByIds)([activeId]);
        }
      }
    );
    const syncDeleteBtn = () => {
      const actCid = ns.getActiveSideChatId() || sc.threads[0]?.cascadeId || '';
      const th = sc.threads.find((t) => t.cascadeId === actCid);
      deleteBtn.disabled = !th;
    };
    const promoteBtn = mkEl(
      'button',
      'agy-icon-btn',
      {
        type: 'button',
        title: 'Promote to Conversation',
        ariaLabel: 'Promote to conversation',
        html: ns.iconSvg?.('promote_to_chat', 16) || '↗',
      },
      { action: 'promote', role: 'sidechat-promote', testid: 'side-question-tab-promote' },
      () => ns.promoteSideChat?.(ns.getActiveSideChatId())
    );
    const syncPromoteBtn = () => {
      const actCid = ns.getActiveSideChatId() || sc.threads[0]?.cascadeId || '';
      const th = sc.threads.find((t) => t.cascadeId === actCid);
      const isPromoting = Boolean(actCid && sc.promotingIds?.has?.(actCid));
      const isRunning = Boolean(th?.isRunning);
      promoteBtn.disabled = !th || isRunning || isPromoting;
      if (isPromoting) {
        promoteBtn.title = 'Promoting to Conversation…';
      } else if (isRunning) {
        promoteBtn.title = 'Cannot promote while Side Question is running';
      } else {
        promoteBtn.title = 'Promote to Conversation';
      }
    };
    const overviewBtn = mkEl(
      'button',
      'agy-icon-btn',
      {
        type: 'button',
        title: 'Toggle Overview Panel',
        ariaLabel: 'Toggle Overview Panel',
        ariaPressed: 'false',
        html: ns.iconSvg?.('overview', 16) || '☰',
      },
      { action: 'overview', role: 'sidechat-overview' },
      () => {
        box._overviewOpen = !box._overviewOpen;
        const actCid = ns.getActiveSideChatId();
        if (actCid) {
          if (box._overviewOpen) {
            overviewOpenIds.add(actCid);
          } else {
            overviewOpenIds.delete(actCid);
          }
        }
        overviewBtn.classList?.toggle?.('active', box._overviewOpen);
        overviewBtn.setAttribute?.('aria-pressed', String(Boolean(box._overviewOpen)));
        if (!box._overviewOpen) {
          overviewBtn.blur?.();
        }
        try {
          box._els.chatFrame?.contentWindow?.postMessage(
            { type: 'hangar-sidechat-toggle-overview', open: box._overviewOpen },
            '*'
          );
        } catch {
          /* ignore */
        }
      }
    );

    actionsEl.append?.(backBtn, promoteBtn, deleteBtn, overviewBtn);
    hdr.append?.(sessionsEl, overflowBtn, actionsEl);

    const createFrame = (isInitial = false) => {
      const f = mkEl(
        'iframe',
        `term-sidechat-frame${isInitial ? ' hidden' : ''}`,
        { _isInitialFrame: isInitial, title: 'Docked Side Question', allow: ns.SIDECAR_IFRAME_ALLOW || '' },
        { role: 'sidechat-frame', loadedCascadeId: '' }
      );
      f.addEventListener?.('load', () => {
        try {
          if (ns.getLatestThemeEvent?.()) {
            f.contentWindow?.postMessage(ns.getLatestThemeEvent(), '*');
          }
          if (box._overviewOpen) {
            f.contentWindow?.postMessage({ type: 'hangar-sidechat-toggle-overview', open: true }, '*');
          }
          if (box._pendingQuote && f.dataset?.loadedCascadeId === ns.getActiveSideChatId()) {
            f.contentWindow?.postMessage({ type: 'hangar-inject-terminal-quote', payload: box._pendingQuote }, '*');
          }
        } catch {
          /* ignore */
        }
      });
      return f;
    };

    const chatFrame = createFrame(true);
    box.append?.(hdr, overflowPopover, confirmBar, chatFrame);
    root?.appendChild?.(box);
    box._overviewOpen = false;
    box._els = {
      backBtn,
      deleteBtn,
      promoteBtn,
      overviewBtn,
      overflowBtn,
      overflowPopover,
      confirmBar,
      confirmText,
      confirmCancelBtn,
      confirmDeleteBtn,
      sessionsEl,
      chatFrame,
      initialFrame: chatFrame,
    };

    const { renderSessionStrip: baseRenderSessionStrip } = ns.createSideChatStripController({
      sessionsEl,
      overflowBtn,
      overflowPopover,
      getConversationId: () => box._convId || '',
      spawnNewInInstance,
      syncThreadsUi: (cid, q) => box._syncThreadsUi(cid, q),
    });
    const renderSessionStrip = () => {
      if (pendingDeleteState && !pendingDeleteState.targetIds.some((id) => sc.threads.some((t) => t.cascadeId === id))) {
        closeDeleteConfirm(false);
      }
      syncPromoteBtn();
      syncDeleteBtn();
      baseRenderSessionStrip();
    };

    box._syncThreadsUi = (targetCascadeId, quoteToInject) => {
      closeDeleteConfirm(false);
      backBtn.classList?.toggle?.('hidden', !targetCascadeId || !foreignNavIds.has(targetCascadeId));
      box._overviewOpen = Boolean(targetCascadeId && overviewOpenIds.has(targetCascadeId));
      overviewBtn.classList?.toggle?.('active', box._overviewOpen);
      overviewBtn.setAttribute?.('aria-pressed', String(Boolean(box._overviewOpen)));
      overviewBtn.disabled = !targetCascadeId;
      if (!box._overviewOpen) {
        overviewBtn.blur?.();
      }
      ns.setActiveSideChatId(targetCascadeId);
      const th = sc.threads.find((t) => t.cascadeId === targetCascadeId);
      if (quoteToInject && (quoteToInject.selectionContent || quoteToInject.terminalId)) {
        if (th) {
          Object.assign(th, { hasActivity: true, quotePayload: quoteToInject });
        }
        box._pendingQuote = {
          terminalId: quoteToInject.terminalId || '',
          title: quoteToInject.cleanName || 'terminal',
          selectionContent: quoteToInject.selectionContent || '',
          promptText: quoteToInject.promptText || '',
          autoSubmit: Boolean(quoteToInject.autoSubmit),
        };
      }
      if (th?.quotePayload) {
        box._payload = th.quotePayload;
      }
      renderSessionStrip();
      const allFrames = new Set([
        chatFrame,
        ...sc.frames.values(),
        ...(box.querySelectorAll?.('.term-sidechat-frame') || []),
      ]);
      if (!targetCascadeId) {
        for (const f of allFrames) {
          f.classList?.add?.('hidden');
        }
        return;
      }
      let targetFrame = sc.frames.get(targetCascadeId);
      if (!targetFrame) {
        targetFrame = (!chatFrame.dataset?.loadedCascadeId || chatFrame.dataset.loadedCascadeId === targetCascadeId)
          ? chatFrame
          : createFrame(false);
        sc.frames.set(targetCascadeId, targetFrame);
      }
      if (targetFrame.parentElement !== box && !box.contains?.(targetFrame)) {
        box.appendChild?.(targetFrame);
      }
      allFrames.add(targetFrame);
      for (const f of allFrames) {
        if (f === chatFrame || f.parentElement === box || box.contains?.(f)) {
          const hideFrame = f !== targetFrame;
          const wasHidden = Boolean(f.classList?.contains?.('hidden'));
          f.classList?.toggle?.('hidden', hideFrame);
          if (hideFrame !== wasHidden) {
            try {
              f.contentWindow?.postMessage({ type: hideFrame ? 'hangar-jetbox-hidden' : 'hangar-jetbox-shown', focus: false }, '*');
            } catch {
              /* ignore */
            }
          }
        }
      }
      box._els.chatFrame = targetFrame;
      if ((targetFrame.dataset?.loadedCascadeId || '') !== targetCascadeId) {
        if (targetFrame.dataset) {
          targetFrame.dataset.loadedCascadeId = targetCascadeId;
        }
        targetFrame.src = buildChatFrameSrc(targetCascadeId);
      } else {
        try {
          targetFrame.contentWindow?.postMessage(
            { type: 'hangar-sidechat-toggle-overview', open: Boolean(box._overviewOpen) },
            '*'
          );
          if (box._pendingQuote) {
            targetFrame.contentWindow?.postMessage(
              { type: 'hangar-inject-terminal-quote', payload: box._pendingQuote },
              '*'
            );
          }
        } catch {
          /* ignore */
        }
      }
    };

    Object.assign(box, {
      _renderSessionStrip: renderSessionStrip,
      _syncPromoteBtn: syncPromoteBtn,
      _syncDeleteBtn: syncDeleteBtn,
      _openDeleteConfirm: openDeleteConfirm,
      _closeDeleteConfirm: closeDeleteConfirm,
    });
    sc.boxes.set(curTabId, box);
    if (root) {
      root._hangarQuoteComposer = box;
    }
    ns._sideChatBox = box;
    return box;
  };

  ns.renderSideChatSlot = function renderSideChatSlot({
    viewportEl,
    topSlotId,
    bottomSlotId,
    splitEnabled,
    conversationId = '',
  } = {}) {
    const isScSlot = (id) => Boolean(id === ns.SIDECHAT_TAB_ID && sc.isOpen);
    const topAct = isScSlot(topSlotId);
    const botAct = Boolean(splitEnabled && bottomSlotId && bottomSlotId !== topSlotId && isScSlot(bottomSlotId));
    if ((topAct || botAct) && viewportEl) {
      ns.ensureSideChatBox(ns.SIDECHAT_TAB_ID, viewportEl);
    }
    const cleanConv = conversationId && conversationId !== '_new' ? String(conversationId) : '';
    const box = sc.boxes.get(ns.SIDECHAT_TAB_ID) || ns._sideChatBox;
    if (!box) return;
    box._convId = cleanConv;
    const isVisible = topAct || botAct;
    if (viewportEl && !viewportEl.contains?.(box)) {
      viewportEl.appendChild?.(box);
    }
    Object.assign(box.dataset, { dockMode: 'docked', slot: botAct ? 'bottom' : 'top' });
    box.classList?.toggle?.('slot-top', topAct);
    box.classList?.toggle?.('slot-bottom', botAct);
    const wasBoxHidden = Boolean(box.classList?.contains?.('hidden'));
    box.classList?.toggle?.('hidden', !isVisible);
    const effVis = Boolean(isVisible && !ns.isHostHidden?.());
    if (wasBoxHidden === isVisible || box.dataset.jetboxVisible !== (effVis ? '1' : '0')) {
      box.dataset.jetboxVisible = effVis ? '1' : '0';
      try {
        box._els?.chatFrame?.contentWindow?.postMessage(
          { type: effVis ? 'hangar-jetbox-shown' : 'hangar-jetbox-hidden', focus: false },
          '*'
        );
      } catch {
        /* ignore */
      }
    }
    if (isVisible) {
      const actCid = ns.getActiveSideChatId() || sc.threads[0]?.cascadeId || '';
      if (!actCid) {
        box._syncThreadsUi?.('', null);
      } else if (box._els?.chatFrame?.dataset?.loadedCascadeId !== actCid) {
        box._syncThreadsUi?.(actCid, null);
      } else {
        box._renderSessionStrip?.();
      }
    }
  };

  ns.closeSideChatDrawer = function closeSideChatDrawer({ deleteAll = true, notify = true } = {}) {
    ns._sideChatBox?._closeDeleteConfirm?.();
    if (deleteAll) {
      for (const t of [...sc.threads, ...(sc.closedThreads || [])]) {
        ns.disposeSideChatFrame(t.cascadeId);
        ns.saveCustomSideChatTitle(t.cascadeId, '');
        sc.deletedIds?.add?.(t.cascadeId);
        sc.knownHangarIds?.delete?.(t.cascadeId);
        sc.promotingIds?.delete?.(t.cascadeId);
        sc.closedCascadeIds?.delete?.(t.cascadeId);
        sc.externalMetaById?.delete?.(t.cascadeId);
        ns.apiCall?.('/api/terminal/sidechat/delete', {
          cascadeId: t.cascadeId,
          parentConversationId: t.parentConversationId || '',
        })?.catch?.(() => {});
      }
      Object.assign(sc, {
        generation: sc.generation + 1,
        counter: 0,
        startInFlight: null,
        threads: [],
        closedThreads: [],
        activeId: '',
      });
      sc.inFlightStarts?.clear?.();
      sc.pendingRenames.clear();
      foreignNavIds.clear();
      overviewOpenIds.clear();
      const cf = ns._sideChatBox?._els?.chatFrame;
      if (ns._sideChatBox?._els?.sessionsEl) {
        ns.clear(ns._sideChatBox._els.sessionsEl);
      }
      if (cf?.dataset) {
        cf.dataset.loadedCascadeId = '';
      }
      if (cf) {
        cf.src = 'about:blank';
      }
    } else {
      const drawerCids = sc.threads.filter((t) => t?.cascadeId).map((t) => t.cascadeId);
      for (const cid of drawerCids) {
        ns.disposeSideChatFrame(cid);
      }
      const cf = ns._sideChatBox?._els?.chatFrame;
      if (cf?.dataset) {
        cf.dataset.loadedCascadeId = '';
      }
      if (cf) {
        cf.src = 'about:blank';
      }
      ns.apiCall?.('/api/terminal/sidechat/close-stream', {
        cascadeIds: drawerCids,
        all: true,
      })?.catch?.(() => {});
    }
    sc.isOpen = false;
    if (ns._sideChatBox) {
      ns._sideChatBox._pendingQuote = null;
      ns._sideChatBox.classList?.add?.('hidden');
    }
    if (notify) {
      ns.notifySideChatState({ closedTab: true });
    }
  };
})();
