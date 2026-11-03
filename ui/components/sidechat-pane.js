/** @fileoverview Docked Side Chat pane controller and iframe lifecycle. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  const sc = ns._sc;

  const buildChatFrameSrc = (cascadeId) => {
    const isLight = Boolean(document.body?.classList?.contains?.('theme-light'));
    const uiTok = ns.getUiToken?.() || new URLSearchParams(window.location?.search || '').get('token') || '';
    return `/jetbox-chat?cascadeId=${encodeURIComponent(cascadeId)}&hostTheme=${isLight ? 'light' : 'dark'}&v=7${uiTok ? `&token=${encodeURIComponent(uiTok)}` : ''}`;
  };

  const mkEl = (ns._mkSideChatEl = function mkEl(tag, className, { html: rawHtml, ...rest } = {}, ds = {}, onClick = null) {
    const e = Object.assign(document.createElement(tag), { className, ...rest });
    if (rawHtml !== undefined) {
      ns.setHtml(e, ns.html`${rawHtml}`);
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

  window.addEventListener?.('message', (e) => {
    const type = e.data?.type;
    const payload = e.data?.payload || {};
    const tabId = ns._resolveSideChatTabId?.(payload.cascadeId) || ns.SIDECHAT_TAB_ID;
    if (type === 'hangar-sidechat-quote-injected') {
      const th = sc.threads.find((t) => t.cascadeId === payload.cascadeId);
      if (th) {
        th.hasActivity = true;
      }
      sc.boxes.forEach((b) => {
        if (b._pendingQuote) {
          b._pendingQuote = null;
        }
      });
    } else if (type === 'hangar-sidechat-open-terminal') {
      const box = sc.boxes.get(tabId);
      if (box) {
        box._overviewOpen = false;
      }
      box?._els?.overviewBtn?.classList?.remove?.('active');
      ns.notifySideChatState?.({
        openTerminal: true,
        pane: box?.dataset?.slot === 'bottom' ? 'bottom' : 'top',
        sourceTabId: tabId,
      });
    } else if (type === 'hangar-sidechat-overview-state') {
      sc.boxes.forEach((b, id) => {
        if (!payload.cascadeId || ns.getActiveSideChatId(id) === payload.cascadeId) {
          b._overviewOpen = Boolean(payload.open);
          b._els?.overviewBtn?.classList?.toggle?.('active', b._overviewOpen);
        }
      });
    } else if (type === 'hangar-sidechat-foreign-nav') {
      sc.boxes.forEach((b, id) => {
        if (!payload.expectedCascadeId || ns.getActiveSideChatId(id) === payload.expectedCascadeId) {
          b._els?.backBtn?.classList?.remove?.('hidden');
        }
      });
    } else if (type === 'hangar-sidechat-switch-cascade' && sc.threads.some((t) => t.cascadeId === payload.cascadeId)) {
      ns.setActiveSideChatId(tabId, payload.cascadeId);
      sc.boxes.get(tabId)?._syncThreadsUi?.(payload.cascadeId, null);
      ns.notifySideChatState?.({ activateTab: true, targetTabId: tabId });
    }
  });

  const syncPreview = (ns._syncSideChatPreview = function syncPreview(els, rawSel) {
    const sel = String(rawSel || '').trim();
    const lines = sel ? sel.split(/\r?\n/) : [];
    els.badge.textContent = '';
    [els.badge, els.mainToggleBtn, els.mainBar].forEach((el) => el.classList?.add?.('hidden'));
    els.mainToggleBtn.classList?.remove?.('active');
    els.preview.textContent = lines.slice(0, 3).join('\n') + (lines.length > 3 ? '\n…' : '');
    els.preview.classList?.toggle?.('hidden', !sel);
  });

  ns.ensureSideChatBox = function ensureSideChatBox(instanceTabId, root) {
    let box =
      sc.boxes.get(instanceTabId) ||
      (instanceTabId === ns.SIDECHAT_TAB_ID ? (root?._hangarQuoteComposer || ns._sideChatBox) : null);
    if (box) return box;
    let curTabId = instanceTabId;
    let curRootId = instanceTabId.startsWith(ns.SIDECHAT_TAB_PREFIX)
      ? instanceTabId.slice(ns.SIDECHAT_TAB_PREFIX.length)
      : '';
    box = mkEl('div', 'term-quote-composer', {}, { dockMode: 'docked', instanceTabId: curTabId });
    const hdr = mkEl('div', 'term-toolbar term-quote-composer-hdr');
    const sessionsEl = mkEl('agy-tab-strip', 'agy-tab-strip', {}, { role: 'sessions' });
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
        rootId: curRootId,
      });
      if (thread?.cascadeId) {
        box._syncThreadsUi(thread.cascadeId, null);
      }
      ns.notifySideChatState();
    };

    const handlePopoutOrMerge = (targetCid = '') => {
      const actCid =
        targetCid ||
        ns.getActiveSideChatId(curTabId) ||
        ns.getInstanceSideChats(sc.threads, curRootId)[0]?.cascadeId ||
        '';
      if (!actCid) return;
      if (curRootId) {
        ns.demoteSideChatTabIntoInstance(curTabId, { targetInstanceTabId: ns.SIDECHAT_TAB_ID, zone: 'strip' });
        ns.notifySideChatState({
          activateTab: true,
          targetTabId: ns.SIDECHAT_TAB_ID,
          removedSidecarId: curTabId,
          replacedSidecarId: { from: curTabId, to: ns.SIDECHAT_TAB_ID },
          pane: box.dataset?.slot || '',
        });
        return;
      }
      const res = ns.promoteSideChatToHangarBar({ cascadeId: actCid, instanceTabId: curTabId });
      if (res?.newSidecarId) {
        ns.notifySideChatState({
          activateTab: true,
          targetTabId: res.newSidecarId,
          replacedSidecarId: res.replacedSidecarId,
          afterTabId: curTabId,
          pane: box.dataset?.slot || '',
        });
      }
    };

    const hide = (closeOpts = {}) => ns.closeSideChatDrawer({ deleteAll: true, ...closeOpts });
    const badge = mkEl('span', 'term-quote-composer-badge hidden');
    const threadSelect = mkEl('select', 'term-sidechat-select hidden', {}, { role: 'sidechat-select' });
    const hint = mkEl('span', 'term-quote-composer-hint hidden', { textContent: 'Side Chat (tools enabled)' });
    const mainBar = mkEl('div', 'term-sidechat-main-bar hidden');
    const preview = mkEl('pre', 'term-quote-composer-preview');
    const row = mkEl('div', 'term-quote-composer-row');
    const input = mkEl('textarea', 'term-quote-composer-input', {
      rows: 2,
      placeholder: 'Optional note for Main Chat… (Enter to send to Main Chat, Shift+Enter for new line)',
    });
    const syncHeight = () => ns._bindAutoTextarea?.(input, 38, 120)?.();
    input.addEventListener?.('input', syncHeight);

    const backBtn = mkEl(
      'button',
      'agy-btn agy-btn-outline term-sidechat-main-btn hidden',
      { type: 'button', title: 'Return to the active Side Chat thread', textContent: '↩ Back to Side Chat' },
      { role: 'sidechat-back' },
      () => {
        backBtn.classList?.add?.('hidden');
        const actCid = ns.getActiveSideChatId(curTabId);
        const f = sc.frames.get(actCid) || box._els.chatFrame;
        if (f?.dataset) {
          f.dataset.loadedCascadeId = actCid;
        }
        if (f) {
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
        if (nextShow) {
          setTimeout(() => input.focus?.(), 10);
        }
      }
    );
    const newThreadBtn = mkEl(
      'button',
      'agy-icon-btn hidden',
      { type: 'button', title: 'New Side Chat', html: ns.iconSvg?.('add', 16) || '+' },
      { action: 'new', role: 'sidechat-new' },
      () => spawnNewInInstance()
    );
    const deleteBtn = mkEl(
      'button',
      'agy-icon-btn hidden',
      { type: 'button', title: 'Delete Side Chat', html: ns.iconSvg?.('delete', 15) || '🗑' },
      { action: 'kill', role: 'sidechat-delete' },
      () => {
        const activeId = ns.getActiveSideChatId(curTabId);
        if (activeId) {
          ns.deleteSideChatsByIds([activeId], curTabId);
        } else {
          ns.closeSideChatDrawer({ deleteAll: true, notify: true });
        }
      }
    );
    const overviewBtn = mkEl(
      'button',
      'agy-icon-btn',
      { type: 'button', title: 'Toggle Overview Panel', html: ns.iconSvg?.('overview', 15) || '☰' },
      { action: 'overview', role: 'sidechat-overview' },
      () => {
        box._overviewOpen = !box._overviewOpen;
        overviewBtn.classList?.toggle?.('active', box._overviewOpen);
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
    const popoutBtn = mkEl(
      'button',
      'agy-icon-btn',
      {
        type: 'button',
        title: curRootId ? 'Merge back into main Side Chat tab' : 'Pin Side Chat Tab to Top Bar',
        html: ns.iconSvg?.('dock_to_right', 14) || '⧉',
      },
      { action: 'popout', role: 'sidechat-popout' },
      () => handlePopoutOrMerge()
    );
    const dockBtn = mkEl(
      'button',
      'agy-icon-btn term-sidechat-btn hidden',
      { type: 'button' },
      { role: 'sidechat-dock' },
      () => ns.setSideChatDocked(!sc.isDocked, true)
    );
    const closeBtn = mkEl('button', 'term-quote-composer-close hidden', { type: 'button', textContent: '×' }, {}, () => hide());
    actionsEl.append?.(
      badge,
      backBtn,
      mainToggleBtn,
      newThreadBtn,
      deleteBtn,
      overviewBtn,
      popoutBtn,
      threadSelect,
      hint,
      dockBtn,
      closeBtn
    );
    hdr.append?.(sessionsEl, actionsEl);

    const closeMainBar = () => {
      mainBar.classList?.add?.('hidden');
      mainToggleBtn.classList?.remove?.('active');
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
      if (!threadSelect.value || threadSelect.value === ns.getActiveSideChatId(curTabId)) return;
      ns.setActiveSideChatId(curTabId, threadSelect.value);
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
        { _isInitialFrame: isInitial },
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
          if (box._pendingQuote && f.dataset?.loadedCascadeId === ns.getActiveSideChatId(curTabId)) {
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
      popoutBtn,
      sessionsEl,
      chatFrame,
      initialFrame: chatFrame,
      mainBar,
      hint,
    };
    box._setInstance = (nextTabId, nextRootId) => {
      curTabId = nextTabId;
      curRootId = nextRootId;
      Object.assign(box.dataset || {}, { instanceTabId: curTabId });
      popoutBtn.title = curRootId ? 'Merge back into main Side Chat tab' : 'Pin Side Chat Tab to Top Bar';
      popoutBtn.classList?.toggle?.('active', Boolean(curRootId));
    };

    const { renderSessionStrip } = ns.createSideChatStripController({
      sessionsEl,
      popoutBtn,
      getTabId: () => curTabId,
      getRootId: () => curRootId,
      getSlot: () => box.dataset?.slot || 'top',
      spawnNewInInstance,
      handlePopoutOrMerge,
      syncThreadsUi: (cid, q) => box._syncThreadsUi(cid, q),
    });

    box._syncThreadsUi = (targetCascadeId, quoteToInject) => {
      backBtn.classList?.add?.('hidden');
      ns.setActiveSideChatId(curTabId, targetCascadeId);
      const optsMarkup = ns.getInstanceSideChats(sc.threads, curRootId)
        .map((t) => {
          const safeId = ns.escHtml?.(t.cascadeId) || t.cascadeId;
          const safeTitle = ns.escHtml?.(ns.resolveSideChatTitle(t)) || ns.resolveSideChatTitle(t);
          return `<option value="${safeId}"${t.cascadeId === targetCascadeId ? ' selected' : ''}>${safeTitle}</option>`;
        })
        .join('');
      ns.setHtml(threadSelect, ns.html`${optsMarkup}`);
      threadSelect.value = targetCascadeId;
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
          f.classList?.toggle?.('hidden', f !== targetFrame);
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
    if (curTabId === ns.SIDECHAT_TAB_ID && root) {
      root._hangarQuoteComposer = box;
    }
    if (curTabId === ns.SIDECHAT_TAB_ID) {
      ns._sideChatBox = box;
    }
    return box;
  };

  ns.renderSideChatSlot = function renderSideChatSlot({ viewportEl, topSlotId, bottomSlotId, splitEnabled } = {}) {
    const isScSlot = (id) => Boolean(ns.isSideChatTabId(id) && (id !== ns.SIDECHAT_TAB_ID || sc.isOpen));
    const topAct = isScSlot(topSlotId);
    const botAct = Boolean(splitEnabled && bottomSlotId && bottomSlotId !== topSlotId && isScSlot(bottomSlotId));
    if (topAct && viewportEl) {
      ns.ensureSideChatBox(topSlotId, viewportEl);
    }
    if (botAct && viewportEl) {
      ns.ensureSideChatBox(bottomSlotId, viewportEl);
    }
    for (const [tabId, box] of sc.boxes.entries()) {
      const inTop = Boolean(topAct && tabId === topSlotId);
      const inBot = Boolean(botAct && tabId === bottomSlotId);
      const isVisible = inTop || inBot;
      if (viewportEl && !viewportEl.contains?.(box)) {
        viewportEl.appendChild?.(box);
      }
      Object.assign(box.dataset, { dockMode: 'docked', slot: inBot ? 'bottom' : 'top' });
      box.classList?.toggle?.('slot-top', inTop);
      box.classList?.toggle?.('slot-bottom', inBot);
      box.classList?.toggle?.('hidden', !isVisible);
      if (isVisible) {
        const rId = tabId.startsWith(ns.SIDECHAT_TAB_PREFIX) ? tabId.slice(ns.SIDECHAT_TAB_PREFIX.length) : '';
        const actCid =
          ns.getActiveSideChatId(tabId) ||
          ns.getInstanceSideChats(sc.threads, rId)[0]?.cascadeId ||
          rId;
        if (actCid && box._els?.chatFrame?.dataset?.loadedCascadeId !== actCid) {
          box._syncThreadsUi?.(actCid, null);
        } else {
          box._renderSessionStrip?.();
        }
      }
      if (tabId !== ns.SIDECHAT_TAB_ID && !sc.poppedIds.has(tabId.slice(ns.SIDECHAT_TAB_PREFIX.length))) {
        box.remove?.();
        sc.boxes.delete(tabId);
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
      sc.poppedIds.clear();
      Object.keys(sc.groupMap).forEach((k) => delete sc.groupMap[k]);
      sc.activeByInstance.clear();
      for (const [id, b] of sc.boxes.entries()) {
        if (id === ns.SIDECHAT_TAB_ID) continue;
        b.remove?.();
        sc.boxes.delete(id);
      }
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
    }
    sc.isOpen = false;
    ns._sideChatBox?.classList?.add?.('hidden');
    if (notify) {
      ns.notifySideChatState({ closedTab: true });
    }
  };
})();
