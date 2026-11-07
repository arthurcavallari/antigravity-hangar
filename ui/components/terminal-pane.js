/** @fileoverview Terminal split-pane lifecycle, resizer, Jetbox iframe mounting, polling, and instance cleanup. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  ns.TERMINAL_TAB_ID = '__terminal__';
  ns.TERMINAL_TAB_PREFIX = 'terminal__';
  ns.isTerminalTabId =
    ns.isTerminalTabId ||
    ((id = '') => id === ns.TERMINAL_TAB_ID || String(id || '').startsWith(ns.TERMINAL_TAB_PREFIX));

  const termStore = ns.terminalStore;
  const instanceControllers = (ns._termInstances = termStore?.instances || ns._termInstances || new Map());
  const sharedPanes = (ns._termSharedPanes = termStore?.sharedPanes || ns._termSharedPanes || new Map());
  const closingIds = termStore?.closingIds || new Set();

  ns.isTerminalClosing = (tid) => closingIds.has(tid);

  ns._disposeTermPanes = function disposeTermPanes(tids, groupMap) {
    for (const tid of tids) {
      closingIds.add(tid);
      if (groupMap) {
        delete groupMap[tid];
      }
      sharedPanes.get(tid)?.emu?.dispose();
      sharedPanes.get(tid)?.wrap?.remove();
      sharedPanes.delete(tid);
    }
  };

  ns._closeTerminalsOnServer = async function closeTerminalsOnServer(tids) {
    await Promise.all(tids.map((tid) => ns.apiCall?.('/api/terminal/close', { terminalId: tid }).catch(() => {})));
    setTimeout(() => tids.forEach((id) => closingIds.delete(id)), 1500);
  };

  let focusTimer = null;
  ns._userActivatedTerminal = false;
  ns._cancelTermFocus = () => {
    if (focusTimer) {
      clearTimeout(focusTimer);
    }
    focusTimer = null;
  };

  ns._focusTermPane = function focusTermPane(tid, engineMode, delayMs = 0) {
    ns._cancelTermFocus();
    const canFocus = () => {
      if (typeof document === 'undefined') return true;
      if (document.querySelector?.('.agy-rename-input')) return false;
      if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false;
      return true;
    };
    const run = () => {
      if (!canFocus()) return;
      const p = sharedPanes.get(tid);
      if (engineMode !== 'jetbox') {
        p?.emu?.focus();
        return;
      }
      p?.frame?.focus?.();
      p?.frame?.contentWindow?.focus?.();
      try {
        p?.frame?.contentWindow?.postMessage({ type: 'hangar-jetbox-focus' }, '*');
      } catch {
        /* ignore */
      }
    };
    if (delayMs > 0) {
      focusTimer = setTimeout(() => {
        focusTimer = null;
        run();
      }, delayMs);
    } else {
      run();
      focusTimer = setTimeout(() => {
        focusTimer = null;
        run();
      }, 0);
    }
  };

  function bindPaneResizer(resizerEl, wrap) {
    let st = null;
    resizerEl.addEventListener('pointerdown', (e) => {
      const prev = wrap._prevVisibleWrap || wrap.previousElementSibling;
      if (e.button !== 0 || !prev) return;
      e.preventDefault();
      e.stopPropagation();
      st = {
        id: e.pointerId,
        x: e.clientX,
        prev,
        pw: prev.getBoundingClientRect().width,
        cw: wrap.getBoundingClientRect().width,
      };
      document.body?.classList?.add('resizing-split');
      resizerEl.setPointerCapture?.(e.pointerId);
    });
    resizerEl.addEventListener('pointermove', (e) => {
      if (!st || st.id !== e.pointerId) return;
      const dx = Math.max(80 - st.pw, Math.min(st.cw - 80, e.clientX - st.x));
      st.prev.style.flex = `${st.pw + dx} 1 0%`;
      wrap.style.flex = `${st.cw - dx} 1 0%`;
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => {
      resizerEl.addEventListener(ev, (e) => {
        if (!st || st.id !== e.pointerId) return;
        st = null;
        document.body?.classList?.remove('resizing-split');
        try {
          resizerEl.releasePointerCapture?.(e.pointerId);
        } catch {
          /* ignore */
        }
      });
    });
  }

  ns._ensureDirectTermPane = function ensureDirectTermPane(tid, hostSpec) {
    const bindHost = (pane) => {
      pane.host = hostSpec;
      Object.assign(pane.dragCfg, {
        kind: 'pane',
        groupId: hostSpec.getActiveGroupId,
        terminalId: tid,
        instanceTabId: hostSpec.instanceTabId,
        sessionsEl: hostSpec.sessionsEl,
        stageEl: hostSpec.stageEl,
        getActiveGroupId: hostSpec.getActiveGroupId,
        getSlotKey: hostSpec.getSlotKey,
        getTitle: () => pane.host.getTitle(tid),
        onClick: () => pane.host.focus(tid, true),
        onSameInstanceDrop: hostSpec.onSameInstanceDrop,
      });
      return pane;
    };
    if (sharedPanes.has(tid)) {
      return bindHost(sharedPanes.get(tid));
    }
    const wrap = Object.assign(document.createElement('div'), { className: 'term-pane' });
    Object.assign(wrap.dataset, { terminalId: tid, testid: `terminal-pane-${tid}` });
    const headerEl = ns.setHtml(
      Object.assign(document.createElement('div'), { className: 'term-pane-header hidden' }),
      ns.html`
        <div class="term-pane-header-title">
          <span class="term-pane-dot" data-role="pane-dot"></span>
          <span class="term-pane-title" data-role="pane-title">pwsh</span>
        </div>
        <button
          type="button"
          class="term-pane-close"
          data-role="pane-close"
          title="Close Split Pane"
        >${ns.iconSvg('close', 12)}</button>
      `
    );
    const resizerEl = Object.assign(document.createElement('div'), { className: 'term-pane-resizer' });
    wrap.append(resizerEl, headerEl);
    bindPaneResizer(resizerEl, wrap);
    const titleEl = headerEl.querySelector('[data-role="pane-title"]');
    const closeBtn = headerEl.querySelector('[data-role="pane-close"]');
    let p = null;
    closeBtn?.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
    });
    closeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      p?.host?.close([tid]);
    });
    const emu = ns.createTerminalEmulator(wrap, {
      onInput: (data) => ns.apiCall('/api/terminal/input', { terminalId: tid, data }).catch(() => {}),
      onResize: (cols, rows) => {
        if (p?.host?.getEngineMode() === 'direct') {
          ns.apiCall('/api/terminal/input', { terminalId: tid, cols, rows }).catch(() => {});
        }
      },
      onTitleChange: (nextTitle) => {
        const clean = ns.formatTermTitle(nextTitle);
        if (p) {
          p.title = clean;
        }
        if (titleEl && p?.host) {
          titleEl.textContent = p.host.getTitle(tid, clean);
        }
        p?.host?.onTitle(tid, clean);
      },
      onSelectionChange: (selInfo) => p?.quoteCtrl?.show(selInfo),
      onQuoteShortcut: (text) => p?.quoteCtrl?.triggerQuote(text),
    });
    const quoteCtrl = ns.createQuotePopupController(wrap, {
      getTerminalMeta: () => ({
        terminalId: tid,
        title: p?.host ? p.host.getTitle(tid, p?.title || 'pwsh') : 'pwsh',
        conversationId: p?.host?.getConversationId() || '',
      }),
      onQuoted: () => p?.emu?.clearSelection(),
    });
    wrap.addEventListener('mousedown', (e) => {
      if (!e.target?.closest?.('.term-pane-close')) {
        p?.host?.focus(tid, false);
      }
    });
    wrap.addEventListener('focusin', () => p?.host?.focus(tid, false));
    p = bindHost({
      wrap,
      headerEl,
      titleEl,
      dotEl: headerEl.querySelector('[data-role="pane-dot"]'),
      viewportEl: wrap.querySelector?.('.term-viewport'),
      frame: null,
      emu,
      quoteCtrl,
      dragCfg: {},
      afterSeq: 0,
      lastWasScrollback: false,
      title: '',
      jetboxSelection: '',
    });
    ns.bindTermPointerDrag?.(headerEl, p.dragCfg);
    sharedPanes.set(tid, p);
    return p;
  };

  ns._renderTermStagePanes = function renderTermStagePanes(ctx) {
    const {
      stageEl,
      active,
      activeTid,
      visibleIds,
      terminals,
      engineMode,
      conversationId,
      isVisible,
      getActiveTid,
      resolveTitle,
      focusPane,
      ensurePane,
      onSpawnEmpty,
    } = ctx;
    stageEl.dataset.testid = 'terminal-split-container';
    if (!active) {
      ns.setHtml(
        stageEl,
        ns.html`
          <div class="empty-split-zone">
            <button type="button" class="agy-btn agy-btn-primary has-icon" data-role="spawn-empty">
              ${ns.iconSvg('add', 14)}
              <span>Launch Interactive Terminal</span>
            </button>
          </div>
        `
      );
      stageEl.querySelector('[data-role="spawn-empty"]')?.addEventListener('click', () => onSpawnEmpty());
      return;
    }
    const instanceIds = new Set(terminals.map((t) => t.terminalId));
    const visSet = new Set(visibleIds);
    const isSplit = visibleIds.length > 1;
    const isJetbox = engineMode === 'jetbox';
    const isLight = window.AgyShell ? !window.AgyShell.isHostDarkTheme() : Boolean(document.body?.classList?.contains?.('theme-light'));
    const uiTok = ns.getUiToken?.() || new URLSearchParams(window.location?.search || '').get('token') || '';
    for (const ch of Array.from(stageEl.children || [])) {
      const cid = ch.dataset?.terminalId;
      if (!cid || !instanceIds.has(cid)) {
        ch._mountedParent = null;
        ch.remove?.();
      } else if (!visSet.has(cid)) {
        if (!ch.classList.contains('hidden')) {
          try {
            sharedPanes.get(cid)?.frame?.contentWindow?.postMessage({ type: 'hangar-jetbox-hidden', focus: false }, '*');
          } catch {
            /* ignore */
          }
        }
        ch.classList.add('hidden');
        ch.classList.remove('is-split-secondary', 'is-focused-pane');
        ch.dataset.active = 'false';
      }
    }
    stageEl.querySelectorAll('.empty-split-zone, .agy-empty-state').forEach((el) => el.remove());
    visibleIds.forEach((tid, idx) => {
      const p = ensurePane(tid);
      const t = terminals.find((x) => x.terminalId === tid);
      const isFoc = tid === activeTid;
      const cleanTitle = resolveTitle(tid, p.title || t?.title || 'pwsh');
      const wasHidden = p.wrap.classList.contains('hidden');
      p.wrap.classList.remove('hidden');
      p.wrap.classList.toggle('is-split-secondary', isSplit && idx > 0);
      p.wrap._prevVisibleWrap = isSplit && idx > 0 ? sharedPanes.get(visibleIds[idx - 1])?.wrap || null : null;
      if (p.wrap?.style) {
        p.wrap.style.order = String(idx);
      }
      if (p.wrap?.style && !isSplit) {
        p.wrap.style.flex = '';
      }
      p.headerEl?.classList.toggle('hidden', !isSplit);
      if (p.titleEl && p.titleEl.textContent !== cleanTitle) {
        p.titleEl.textContent = cleanTitle;
      }
      p.dotEl?.classList.toggle('active', isFoc);
      p.wrap.dataset.active = isFoc ? 'true' : 'false';
      p.wrap.classList.toggle('is-focused-pane', isFoc && isSplit);
      p.viewportEl?.classList.toggle('hidden', isJetbox);
      if (isJetbox) {
        const effCid = conversationId && conversationId !== '_new' ? conversationId : (t?.conversationId || tid);
        const src = `/jetbox-terminal?cascadeId=${encodeURIComponent(effCid)}&terminalId=${encodeURIComponent(tid)}&hostTheme=${isLight ? 'light' : 'dark'}&v=11${uiTok ? `&token=${encodeURIComponent(uiTok)}` : ''}`;
        if (!p.frame) {
          p.frame = Object.assign(document.createElement('iframe'), { className: 'term-jetbox-frame', src });
          p.frame.dataset.loadedSrc = src;
          p.frame.addEventListener?.('load', () => {
            try {
              if (ns.getLatestThemeEvent?.()) {
                p.frame.contentWindow?.postMessage(ns.getLatestThemeEvent(), '*');
              }
            } catch {
              /* ignore */
            }
            if (ns._userActivatedTerminal && isVisible() && tid === getActiveTid()) {
              focusPane(tid);
            }
          });
          p.wrap.appendChild(p.frame);
        } else if (p.frame.dataset.loadedSrc !== src) {
          p.frame.dataset.loadedSrc = src;
          p.frame.src = src;
        } else if (wasHidden) {
          try {
            p.frame.contentWindow?.postMessage({ type: 'hangar-jetbox-shown', focus: false }, '*');
          } catch {
            /* ignore */
          }
        }
      } else if (p.frame) {
        p.frame.remove?.();
        p.frame = null;
      }
      if (p.wrap.parentElement !== stageEl && p.wrap._mountedParent !== stageEl) {
        p.wrap._mountedParent = stageEl;
        stageEl.appendChild(p.wrap);
      }
    });
  };

  ns._pollVisibleTermPanes = async function pollVisibleTermPanes({ visibleIds, terminals, resolveTitle, renderToolbar }) {
    let hadActivity = false;
    for (const tid of visibleIds) {
      const p = sharedPanes.get(tid);
      if (!p) continue;
      try {
        const data = await ns.apiCall('/api/terminal/poll', { terminalId: tid, afterSeq: p.afterSeq });
        const nextTitle = data.title ? ns.formatTermTitle(data.title) : '';
        if (nextTitle && nextTitle !== p.title) {
          hadActivity = true;
          p.title = nextTitle;
          if (p.titleEl) {
            p.titleEl.textContent = resolveTitle(tid, nextTitle);
          }
          const t = terminals.find((x) => x.terminalId === tid);
          if (t) {
            t.title = nextTitle;
            renderToolbar();
          }
        }
        for (const chunk of data.chunks || []) {
          if ((chunk.seq || 0) <= p.afterSeq) continue;
          hadActivity = true;
          const isReset = Boolean(chunk.isScrollback && !p.lastWasScrollback);
          p.lastWasScrollback = Boolean(chunk.isScrollback);
          p.afterSeq = chunk.seq || p.afterSeq;
          if (chunk.text) {
            p.emu.write(chunk.text, { reset: isReset });
          }
        }
      } catch {
        /* ignore */
      }
    }
    return hadActivity;
  };

  ns._handleJetboxTermEvent = function handleJetboxTermEvent(type, payload = {}, sourceWin, ctx) {
    const tid = payload?.terminalId;
    if (!tid || !ctx.visibleIds.includes(tid)) return;
    const p = sharedPanes.get(tid);
    if (sourceWin === null || (sourceWin !== undefined && sourceWin !== window && p?.frame?.contentWindow !== sourceWin)) return;
    if (type !== 'hangar-jetbox-title-changed') {
      ctx.setFocusedPane(tid, false);
    }
    if (type === 'hangar-jetbox-selection-changed' && p) {
      p.jetboxSelection = String(payload.selectionContent || '');
    } else if (type === 'hangar-jetbox-title-changed' && payload.title) {
      const clean = ns.formatTermTitle(payload.title);
      if (p) {
        p.title = clean;
      }
      const t = ctx.terminals.find((x) => x.terminalId === tid);
      if (t) {
        t.title = clean;
      }
      if (p?.titleEl) {
        p.titleEl.textContent = ctx.resolveTitle(tid, clean);
      }
      ctx.renderToolbar();
    } else if (type === 'hangar-jetbox-quote-clicked' || type === 'hangar-jetbox-quote-dragend') {
      const t = ctx.terminals.find((x) => x.terminalId === tid) || ctx.getActiveTerm();
      if (t) {
        ns.handleJetboxQuoteEvent?.(type, payload, {
          rootEl: ctx.rootEl,
          pane: p,
          term: t,
          title: ctx.resolveTitle(t.terminalId, payload.title || t.title || 'terminal'),
          conversationId: ctx.conversationId,
        });
      }
    }
  };

  window.addEventListener('message', (e) => {
    if (e?.source === null) return;
    if (e?.origin !== undefined) {
      const locOrigin = window.location?.origin;
      if (locOrigin ? e.origin !== locOrigin : !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(String(e.origin))) {
        return;
      }
    }
    if (e.data?.type?.startsWith?.('hangar-jetbox-')) {
      instanceControllers.forEach((c) => c.handleJetboxEvent(e.data.type, e.data.payload, e.source));
    }
  });

  ns.disposeTerminalInstance = (tabId) => {
    instanceControllers.get(tabId)?.dispose();
    instanceControllers.delete(tabId);
  };

  ns.closeTerminalInstance = async (tabId, allTerminals = []) => {
    const rId = String(tabId || '').startsWith(ns.TERMINAL_TAB_PREFIX)
      ? String(tabId).slice(ns.TERMINAL_TAB_PREFIX.length)
      : '';
    const tids = ns.getInstanceTerminals(allTerminals, rId).map((t) => t.terminalId);
    if (rId && !tids.includes(rId)) {
      tids.push(rId);
    }
    const popped = ns.getPoppedTerminalIds();
    const groupMap = ns.readGroupMap();
    [...(rId ? [rId] : []), ...tids].forEach((tid) => popped.delete(tid));
    ns._disposeTermPanes(tids, groupMap);
    ns.setPoppedTerminalIds(popped);
    ns.saveGroupMap(groupMap);
    ns.saveTabGroups(tabId, []);
    ns.disposeTerminalInstance(tabId);
    await ns._closeTerminalsOnServer(tids);
  };

  ns.focusTerminalInInstance = (tabId, tid) => {
    const grps = ns.readTabGroups(tabId);
    const g = grps.find((grp) => grp.paneIds.includes(tid));
    if (g) {
      g.focusedPaneId = tid;
      ns.setActiveGroupId?.(tabId, g.groupId);
      ns.saveTabGroups(tabId, grps);
    }
    instanceControllers.get(tabId)?.focusTerminal(tid);
  };
})();
