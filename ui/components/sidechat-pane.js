/** @fileoverview Docked Side Chat companion pane controller and iframe lifecycle. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  const store = ns.sideChatStore;
  const sc = store?.state || ns._sc;

  const buildChatFrameSrc = (cascadeId) => {
    const isLight = window.AgyShell ? !window.AgyShell.isHostDarkTheme() : Boolean(document.body?.classList?.contains?.('theme-light'));
    const uiTok = ns.getUiToken?.() || new URLSearchParams(window.location?.search || '').get('token') || '';
    return `/jetbox-chat?cascadeId=${encodeURIComponent(cascadeId)}&hostTheme=${isLight ? 'light' : 'dark'}&v=9${uiTok ? `&token=${encodeURIComponent(uiTok)}` : ''}`;
  };

  const mkEl = (ns._mkSideChatEl = function mkEl(tag, className, { html: rawHtml, ...rest } = {}, ds = {}, onClick = null) {
    const e = Object.assign(document.createElement(tag), { className, ...rest });
    if (rawHtml !== undefined) {
      ns.setHtml(e, ns.rawHtml ? ns.rawHtml(rawHtml) : rawHtml);
    }
    e.dataset = Object.assign(e.dataset || {}, ds);
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

  window.addEventListener?.('message', (e) => {
    const type = e.data?.type;
    if (!type || !String(type).startsWith('hangar-sidechat-')) return;
    if (!isTrustedSideChatMessage(e)) return;
    const payload = e.data?.payload || {};
    const tabId = ns.SIDECHAT_TAB_ID;
    const box = sc.boxes.get(tabId) || ns._sideChatBox;
    if (type === 'hangar-sidechat-quote-injected') {
      store ? store.markThreadActivity(payload.cascadeId, true) : (() => {
        const th = sc.threads.find((t) => t.cascadeId === payload.cascadeId);
        if (th) {
          th.hasActivity = true;
        }
      })();
      if (box?._pendingQuote) {
        box._pendingQuote = null;
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
        pane: box?.dataset?.slot === 'bottom' ? 'bottom' : 'top',
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
      ns.notifySideChatState?.({ activateTab: true, targetTabId: tabId });
    } else if (type === 'hangar-sidechat-open-parent') {
      const parentId = String(payload.parentConversationId || '').trim();
      if (!parentId) return;
      if (sc.threads.some((t) => t.cascadeId === parentId)) {
        ns.setActiveSideChatId(parentId);
        box?._syncThreadsUi?.(parentId, null);
        ns.notifySideChatState?.({ activateTab: true, targetTabId: tabId });
      } else {
        window.sidecar?.toggleConversation?.(parentId);
      }
    } else if (type === 'hangar-sidechat-open-sidecar') {
      const cands = Array.isArray(payload.candidateIds) ? payload.candidateIds : [];
      const rawId = String(payload.sidecarId || cands[0] || '').trim();
      if (!rawId) return;
      let targetTabId = rawId === 'dashboard' ? (ns.EXTENSIONS_TAB_ID || '__extensions__') : rawId;
      if (rawId !== 'dashboard' && typeof document.querySelectorAll === 'function') {
        const known = Array.from(document.querySelectorAll('[data-sidecar-id]'))
          .map((el) => el.dataset?.sidecarId || el.getAttribute?.('data-sidecar-id') || '')
          .filter(Boolean);
        const hit = cands.find((id) => known.includes(id)) ||
          known.find((id) => cands.some((c) => id === c || id.endsWith('/' + c) || id.endsWith('--' + c)));
        if (hit) {
          targetTabId = hit;
        }
      }
      ns.notifySideChatState?.({
        activateTab: true,
        targetTabId,
        pane: box?.dataset?.slot === 'bottom' ? 'bottom' : 'top',
      });
    }
  });

  const syncPreview = (ns._syncSideChatPreview = function syncPreview(els, rawSel) {
    const sel = String(rawSel || '').trim();
    const lines = sel ? sel.split(/\r?\n/) : [];
    els.badge.textContent = '';
    [els.badge, els.mainToggleBtn, els.mainBar].forEach((el) => el.classList?.add?.('hidden'));
    els.mainToggleBtn.classList?.remove?.('active');
    els.mainToggleBtn.setAttribute?.('aria-expanded', 'false');
    els.preview.textContent = lines.slice(0, 3).join('\n') + (lines.length > 3 ? '\n…' : '');
    els.preview.classList?.toggle?.('hidden', !sel);
  });

  ns.ensureSideChatBox = function ensureSideChatBox(_instanceTabId, root) {
    const curTabId = ns.SIDECHAT_TAB_ID;
    let box = sc.boxes.get(curTabId) || root?._hangarQuoteComposer || ns._sideChatBox;
    if (box) return box;
    box = mkEl('div', 'term-quote-composer', {}, { dockMode: 'docked', instanceTabId: curTabId });
    const hdr = mkEl('div', 'term-toolbar term-quote-composer-hdr');
    const sessionsEl = mkEl('agy-tab-strip', 'agy-tab-strip agy-tab-strip-sub', {}, { role: 'sessions' });
    sessionsEl.setAttribute?.('aria-label', 'Side Chat threads');
    const actionsEl = mkEl('div', 'term-toolbar-actions');
    sessionsEl.addEventListener?.('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && sessionsEl.scrollWidth > sessionsEl.clientWidth) {
        e.preventDefault?.();
      }
      if (e.defaultPrevented) {
        sessionsEl.scrollLeft += e.deltaY;
      }
    }, { passive: false });

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

    const hide = (closeOpts = {}) => ns.closeSideChatDrawer({ deleteAll: true, ...closeOpts });
    const badge = mkEl('span', 'term-quote-composer-badge hidden');
    const threadSelect = mkEl('select', 'term-sidechat-select hidden', { ariaLabel: 'Select Side Chat thread' }, { role: 'sidechat-select' });
    threadSelect.setAttribute?.('aria-label', 'Select Side Chat thread');
    const hint = mkEl('span', 'term-quote-composer-hint hidden', { textContent: 'Side Chat (tools enabled)' });
    const mainBar = mkEl('div', 'term-sidechat-main-bar hidden');
    const preview = mkEl('pre', 'term-quote-composer-preview');
    const row = mkEl('div', 'term-quote-composer-row');
    const input = mkEl('textarea', 'term-quote-composer-input', {
      rows: 2,
      ariaLabel: 'Note for Main Chat',
      placeholder: 'Optional note for Main Chat… (Enter to send to Main Chat, Shift+Enter for new line)',
    });
    input.setAttribute?.('aria-label', 'Note for Main Chat');
    const syncHeight = () => ns._bindAutoTextarea?.(input, 38, 120)?.();
    input.addEventListener?.('input', syncHeight);

    const backBtn = mkEl(
      'button',
      'agy-btn agy-btn-outline term-sidechat-main-btn hidden',
      { type: 'button', title: 'Return to the active Side Chat thread', textContent: '↩ Back to Side Chat' },
      { role: 'sidechat-back' },
      () => {
        const actCid = ns.getActiveSideChatId();
        if (actCid) {
          foreignNavIds.delete(actCid);
        }
        backBtn.classList?.add?.('hidden');
        const f = sc.frames.get(actCid) || box._els.chatFrame;
        if (f?.dataset) {
          f.dataset.loadedCascadeId = actCid;
        }
        if (f) {
          try {
            f.contentWindow?.postMessage(
              { type: 'hangar-sidechat-switch-cascade', payload: { cascadeId: actCid } },
              '*'
            );
          } catch {
            /* ignore */
          }
          f.src = buildChatFrameSrc(actCid);
        }
      }
    );
    const mainToggleBtn = mkEl(
      'button',
      'agy-btn agy-btn-outline term-sidechat-main-btn hidden',
      { type: 'button', title: 'Send quoted output to the Main Conversation instead', textContent: 'Send to Main Chat' },
      { role: 'sidechat-main-toggle' },
      () => {
        const nextShow = Boolean(mainBar.classList?.contains?.('hidden'));
        mainBar.classList?.toggle?.('hidden', !nextShow);
        mainToggleBtn.classList?.toggle?.('active', nextShow);
        mainToggleBtn.setAttribute?.('aria-expanded', String(nextShow));
        if (nextShow) {
          setTimeout(() => input.focus?.(), 10);
        }
      }
    );
    mainToggleBtn.setAttribute?.('aria-expanded', 'false');
    const newThreadBtn = mkEl(
      'button',
      'agy-icon-btn hidden',
      { type: 'button', title: 'New Side Chat', ariaLabel: 'New Side Chat', html: ns.iconSvg?.('add', 16) || '+' },
      { action: 'new', role: 'sidechat-new' },
      () => spawnNewInInstance()
    );
    newThreadBtn.setAttribute?.('aria-label', 'New Side Chat');
    const deleteBtn = mkEl(
      'button',
      'agy-icon-btn hidden',
      { type: 'button', title: 'Delete Side Chat', ariaLabel: 'Delete Side Chat', html: ns.iconSvg?.('delete', 15) || '🗑' },
      { action: 'kill', role: 'sidechat-delete' },
      () => {
        const activeId = ns.getActiveSideChatId();
        if (activeId) {
          ns.deleteSideChatsByIds([activeId]);
        } else {
          ns.closeSideChatDrawer({ deleteAll: true, notify: true });
        }
      }
    );
    deleteBtn.setAttribute?.('aria-label', 'Delete Side Chat');
    const overviewBtn = mkEl(
      'button',
      'agy-icon-btn',
      { type: 'button', title: 'Toggle Overview Panel', ariaLabel: 'Toggle Overview Panel', html: ns.iconSvg?.('overview', 15) || '☰' },
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
    overviewBtn.setAttribute?.('aria-label', 'Toggle Overview Panel');
    overviewBtn.setAttribute?.('aria-pressed', 'false');
    const dockBtn = mkEl(
      'button',
      'agy-icon-btn term-sidechat-btn hidden',
      { type: 'button', ariaLabel: 'Dock Side Chat to Bottom Split' },
      { role: 'sidechat-dock' },
      () => ns.setSideChatDocked(!sc.isDocked, true)
    );
    dockBtn.setAttribute?.('aria-label', 'Dock Side Chat to Bottom Split');
    const closeBtn = mkEl('button', 'term-quote-composer-close hidden', { type: 'button', ariaLabel: 'Close Side Chat', textContent: '×' }, {}, () => hide());
    closeBtn.setAttribute?.('aria-label', 'Close Side Chat');
    actionsEl.append?.(
      badge,
      backBtn,
      mainToggleBtn,
      newThreadBtn,
      deleteBtn,
      overviewBtn,
      threadSelect,
      hint,
      dockBtn,
      closeBtn
    );
    hdr.append?.(sessionsEl, actionsEl);

    const closeMainBar = () => {
      mainBar.classList?.add?.('hidden');
      mainToggleBtn.classList?.remove?.('active');
      mainToggleBtn.setAttribute?.('aria-expanded', 'false');
    };
    const submit = () => ns._submitQuoteToMain(box, root, sendBtn, 'Send to Main', input, syncHeight, closeMainBar);
    const sendBtn = mkEl(
      'button',
      'agy-btn agy-btn-primary term-quote-composer-send',
      { type: 'button', textContent: 'Send to Main' },
      {},
      () => submit()
    );
    row.append?.(input, sendBtn);
    mainBar.append?.(preview, row);

    threadSelect.addEventListener?.('change', (e) => {
      e.stopPropagation?.();
      if (!threadSelect.value || threadSelect.value === ns.getActiveSideChatId()) return;
      ns.setActiveSideChatId(threadSelect.value);
      box._syncThreadsUi(threadSelect.value, null);
      ns.notifySideChatState();
    });
    input.addEventListener?.('keydown', (e) => {
      e.stopPropagation?.();
      const act = e.key === 'Enter' && !e.shiftKey && !e.isComposing
        ? submit
        : (e.key === 'Escape' ? closeMainBar : null);
      if (act) {
        e.preventDefault?.();
        act();
      }
    });

    const createFrame = (isInitial = false) => {
      const f = mkEl(
        'iframe',
        `term-sidechat-frame${isInitial ? ' hidden' : ''}`,
        { _isInitialFrame: isInitial, title: 'Docked Side Chat', allow: ns.SIDECAR_IFRAME_ALLOW || '' },
        { role: 'sidechat-frame', loadedCascadeId: '' }
      );
      f.setAttribute?.('title', 'Docked Side Chat');
      if (ns.SIDECAR_IFRAME_ALLOW) f.setAttribute?.('allow', ns.SIDECAR_IFRAME_ALLOW);
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
    box.append?.(hdr, mainBar, chatFrame);
    root?.appendChild?.(box);
    box._overviewOpen = false;
    box._els = {
      badge,
      preview,
      input,
      sendBtn,
      closeBtn,
      threadSelect,
      newThreadBtn,
      backBtn,
      mainToggleBtn,
      dockBtn,
      deleteBtn,
      overviewBtn,
      sessionsEl,
      chatFrame,
      initialFrame: chatFrame,
      mainBar,
      hint,
    };

    const syncSelectOptions = (selectedCid) => {
      const optsMarkup = sc.threads
        .map((t) => {
          const safeId = ns.escHtml?.(t.cascadeId) || t.cascadeId;
          const safeTitle = ns.escHtml?.(ns.resolveSideChatTitle(t)) || ns.resolveSideChatTitle(t);
          return `<option value="${safeId}"${t.cascadeId === selectedCid ? ' selected' : ''}>${safeTitle}</option>`;
        })
        .join('');
      ns.setHtml(threadSelect, ns.rawHtml ? ns.rawHtml(optsMarkup) : optsMarkup);
      if (selectedCid) threadSelect.value = selectedCid;
    };

    const { renderSessionStrip: baseRenderSessionStrip } = ns.createSideChatStripController({
      sessionsEl,
      getConversationId: () => box._convId || '',
      spawnNewInInstance,
      syncThreadsUi: (cid, q) => box._syncThreadsUi(cid, q),
    });
    const renderSessionStrip = () => {
      syncSelectOptions(ns.getActiveSideChatId() || sc.threads[0]?.cascadeId || '');
      baseRenderSessionStrip();
    };

    box._syncThreadsUi = (targetCascadeId, quoteToInject) => {
      backBtn.classList?.toggle?.('hidden', !foreignNavIds.has(targetCascadeId));
      box._overviewOpen = overviewOpenIds.has(targetCascadeId);
      overviewBtn.classList?.toggle?.('active', box._overviewOpen);
      overviewBtn.setAttribute?.('aria-pressed', String(Boolean(box._overviewOpen)));
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
      syncPreview(box._els, th?.quotePayload?.selectionContent);
      renderSessionStrip();
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
      const allFrames = new Set([
        chatFrame,
        ...sc.frames.values(),
        ...(box.querySelectorAll?.('.term-sidechat-frame') || []),
      ]);
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
            ['hangar-sidechat-quote-injected-req', 'hangar-inject-terminal-quote'].forEach((t) =>
              targetFrame.contentWindow?.postMessage({ type: t, payload: box._pendingQuote }, '*')
            );
          }
        } catch {
          /* ignore */
        }
      }
    };

    Object.assign(box, { _renderSessionStrip: renderSessionStrip, _submit: submit, _hide: hide });
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
    if (cleanConv) {
      box._convId = cleanConv;
    }
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
      if (actCid && box._els?.chatFrame?.dataset?.loadedCascadeId !== actCid) {
        box._syncThreadsUi?.(actCid, null);
      } else {
        box._renderSessionStrip?.();
      }
    }
  };

  ns.syncSideChatVisibility = function syncSideChatVisibility() {
    const hostHidden = Boolean(ns.isHostHidden?.());
    const allBoxes = new Set([...sc.boxes.values(), ...(ns._sideChatBox ? [ns._sideChatBox] : [])]);
    for (const box of allBoxes) {
      const boxOpen = !box.classList?.contains?.('hidden');
      const effVis = Boolean(boxOpen && !hostHidden);
      if (box.dataset) box.dataset.jetboxVisible = effVis ? '1' : '0';
      try {
        box._els?.chatFrame?.contentWindow?.postMessage(
          { type: effVis ? 'hangar-jetbox-shown' : 'hangar-jetbox-hidden', focus: false },
          '*'
        );
      } catch {
        /* ignore */
      }
    }
  };

  ns.setSideChatDocked = function setSideChatDocked(docked, notify = true) {
    const dockToggled = Boolean(docked) !== sc.isDocked;
    sc.isDocked = Boolean(docked);
    if (sc.isDocked) {
      sc.isOpen = true;
    }
    const box = ns._sideChatBox;
    if (box) {
      box.dataset.dockMode = sc.isDocked ? 'docked' : 'floating';
      if (box.style && sc.isDocked) {
        Object.assign(box, { _floatingHeight: box.style.height || '' });
      }
      if (box.style) {
        box.style.height = sc.isDocked ? '' : (box._floatingHeight ?? box.style.height);
      }
      box._els?.dockBtn?.classList?.toggle?.('active', sc.isDocked);
      if (box._els?.dockBtn) {
        box._els.dockBtn.title = sc.isDocked ? 'Undock to Floating Drawer' : 'Dock Side Chat to Bottom Split';
      }
      if (sc.isOpen) {
        box.classList?.remove?.('hidden');
      }
    }
    if (notify) {
      ns.notifySideChatState({ dockToggled });
    }
  };

  ns.closeSideChatDrawer = function closeSideChatDrawer({ deleteAll = true, notify = true } = {}) {
    if (deleteAll) {
      for (const t of sc.threads) {
        ns.disposeSideChatFrame(t.cascadeId);
        ns.saveCustomSideChatTitle(t.cascadeId, '');
        ns.apiCall?.('/api/terminal/sidechat/delete', { cascadeId: t.cascadeId })?.catch?.(() => {});
      }
      Object.assign(sc, {
        generation: sc.generation + 1,
        counter: 0,
        startInFlight: null,
        threads: [],
        activeId: '',
      });
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
        const frame = sc.frames?.get?.(cid);
        if (frame?.dataset) {
          frame.dataset.loadedCascadeId = '';
        }
        if (frame) {
          frame.src = 'about:blank';
        }
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
    ns._sideChatBox?.classList?.add?.('hidden');
    if (notify) {
      ns.notifySideChatState({ closedTab: true });
    }
  };
})();
