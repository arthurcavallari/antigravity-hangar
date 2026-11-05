/** @fileoverview Antigravity terminal quoting, Lexical/Cider drag-to-chat, selection popup, and mini composer. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  const getSc = () => ns._sc || { threads: [], poppedIds: new Set(), groupMap: {}, boxes: new Map() };
  const mkEl = (tag, cls, { html: h, ...props } = {}, ds = {}, onClick = null) => {
    if (ns._mkSideChatEl) {
      return ns._mkSideChatEl(tag, cls, { html: h, ...props }, ds, onClick);
    }
    const el = Object.assign(document.createElement(tag), { className: cls, ...props });
    if (h !== undefined) {
      ns.setHtml?.(el, ns.rawHtml ? ns.rawHtml(h) : h);
    }
    return el;
  };

  ns.buildTerminalScopePayload = function buildTerminalScopePayload({
    terminalId = '',
    title = 'terminal',
    selectionContent = '',
    lastCommand = '',
    quoteFileUri = '',
  } = {}) {
    const cleanName = String(title || 'terminal')
      .replace(/[\[\]()\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'terminal';
    const pid = String(terminalId || '').trim();
    const sel = String(selectionContent || '');
    const contextScopeJson = JSON.stringify({
      terminal: {
        processId: pid,
        name: cleanName,
        ...(lastCommand ? { lastCommand: String(lastCommand) } : {}),
        ...(sel ? { selectionContent: sel } : {}),
      },
    });
    const lexicalJson = JSON.stringify({
      namespace: 'Input',
      nodes: [
        {
          detail: 0,
          format: 0,
          mode: 'segmented',
          style: '',
          text: '',
          type: 'contextScopeItemMention',
          trigger: '@',
          value: 'contextScopeItemMention',
          scopeItem: contextScopeJson,
          data: { data: contextScopeJson },
          version: 1,
        },
        {
          detail: 0,
          format: 0,
          mode: 'normal',
          style: '',
          text: ' ',
          type: 'text',
          version: 1,
        },
      ],
    });
    const textBlockFallback = `[${cleanName}](textBlock;label:${cleanName.replace(/:/g, '-') || 'terminal'}:${encodeURIComponent(sel)}) `;
    return {
      cleanName,
      terminalId: pid,
      selectionContent: sel,
      contextScopeJson,
      lexicalJson,
      plainText: pid ? `[${cleanName}](terminal;${pid}) ` : textBlockFallback,
      textBlockFallback,
      quoteFileUri: String(quoteFileUri || ''),
    };
  };

  const setScopeTransfer = (dt, p) => {
    const entries = [
      ['application/context-scope-item', p.contextScopeJson],
      ['application/context-scope-item-cider', p.contextScopeJson],
      ['text/plain', p.plainText],
      ...(p.lexicalJson ? [['application/x-lexical-editor', p.lexicalJson]] : []),
    ];
    entries.forEach(([k, v]) => dt.setData(k, v));
  };

  ns.copyTerminalQuoteToClipboard = function copyTerminalQuoteToClipboard(opts = {}) {
    const payload = opts.lexicalJson ? opts : ns.buildTerminalScopePayload(opts);
    let copied = false;
    const onCopy = (e) => {
      if (!e.clipboardData) return;
      e.preventDefault();
      e.stopPropagation();
      copied = true;
      setScopeTransfer(e.clipboardData, payload);
    };
    document.addEventListener('copy', onCopy, true);
    const probe = mkEl('span', '', { textContent: payload.plainText });
    if (probe.style) {
      probe.style.position = 'fixed';
      probe.style.left = '-9999px';
      probe.style.top = '-9999px';
      probe.style.opacity = '0';
      probe.style.pointerEvents = 'none';
    }
    document.body?.appendChild?.(probe);
    try {
      const sel = window.getSelection?.();
      const saved = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      const r = sel && typeof document.createRange === 'function' ? document.createRange() : null;
      r?.selectNodeContents(probe);
      if (r) {
        sel.removeAllRanges?.();
        sel.addRange?.(r);
      }
      document.execCommand?.('copy');
      if (sel && saved) {
        sel.removeAllRanges?.();
        sel.addRange?.(saved);
      }
    } catch {
      /* ignore */
    }
    document.removeEventListener('copy', onCopy, true);
    probe.remove?.();
    if (!copied && !opts.alreadyCopied && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(payload.textBlockFallback || payload.plainText).catch(() => {});
    }
    return payload;
  };

  ['dragenter', 'dragover'].forEach((ev) => {
    window.addEventListener?.(ev, (e) => {
      if (Array.from(e?.dataTransfer?.types || []).some((t) => String(t).toLowerCase().includes('context-scope-item'))) {
        e.preventDefault?.();
      }
      if (e?.defaultPrevented && e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
    });
  });

  ns.bindTerminalDragSource = function bindTerminalDragSource(el, getPayloadFn) {
    if (!el) return;
    el.draggable = true;
    el.setAttribute?.('draggable', 'true');
    if (el.style) {
      el.style.webkitUserDrag = 'element';
    }
    el.addEventListener('dragstart', (e) => {
      const raw = (e.dataTransfer && (typeof getPayloadFn === 'function' ? getPayloadFn() : getPayloadFn)) || null;
      if (raw) {
        e.dataTransfer.effectAllowed = 'copyMove';
        setScopeTransfer(e.dataTransfer, raw.contextScopeJson ? raw : ns.buildTerminalScopePayload(raw));
      }
    });
  };

  ns.showTerminalQuoteToast = function showTerminalQuoteToast(hostEl, message) {
    const root = hostEl || document.body;
    if (!root || !message) return;
    if (!root._hangarQuoteToast) {
      root._hangarQuoteToast = mkEl('div', 'agy-toast');
      root.appendChild?.(root._hangarQuoteToast);
    }
    const toast = Object.assign(root._hangarQuoteToast, { textContent: message, className: 'agy-toast' });
    toast.classList?.remove?.('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList?.add?.('hidden'), 2600);
  };

  ns.formatTerminalAgentMessage = function formatTerminalAgentMessage(payload = {}, userPrompt = '') {
    const name = payload.cleanName || 'terminal';
    const sel = String(payload.selectionContent || '').trim();
    const prompt = String(userPrompt || '').trim();
    const quoteBlock = sel
      ? `From terminal "${name}":\n\`\`\`text\n${sel}\n\`\`\``
      : `From terminal "${name}" (${(payload.plainText || '').trim()})`;
    return prompt ? `${quoteBlock}\n\n${prompt}` : quoteBlock;
  };

  ns.openTerminalQuoteComposer = function openTerminalQuoteComposer(hostEl, rawPayload = {}, opts = {}) {
    const sc = getSc();
    const root =
      (typeof document?.getElementById === 'function' ? document.getElementById('main-viewport') : null) ||
      hostEl ||
      document.body;
    if (!root || typeof document?.createElement !== 'function') return null;
    const hasQuote = Boolean(rawPayload && (rawPayload.selectionContent || rawPayload.terminalId || rawPayload.cleanName));
    const base = hasQuote
      ? (rawPayload.cleanName ? rawPayload : ns.buildTerminalScopePayload(rawPayload))
      : { cleanName: opts.title || 'terminal', terminalId: opts.terminalId || '', selectionContent: '' };
    const payload = {
      ...base,
      promptText: String(rawPayload?.promptText || opts.promptText || ''),
      autoSubmit: Boolean(rawPayload?.autoSubmit ?? opts.autoSubmit),
    };
    const popOut = Boolean(opts.popOut);
    const existing = opts.targetCascadeId ? sc.threads.find((t) => t.cascadeId === opts.targetCascadeId) : null;
    const targetTabId = existing ? ns._resolveSideChatTabId(existing.cascadeId) : ns.SIDECHAT_TAB_ID;
    const box = ns.ensureSideChatBox(targetTabId, root);
    Object.assign(box, {
      _toastRoot: hostEl || root,
      _payload: payload,
      _convId: opts.conversationId || box._convId || '',
    });
    if (hostEl && hostEl !== root) {
      hostEl._hangarQuoteComposer = box;
    }
    const openMain = () => {
      Object.assign(sc, { isOpen: true, isDocked: true });
      Object.assign(box.dataset, { dockMode: 'docked' });
      box.classList?.remove?.('hidden');
    };
    if (existing) {
      if (!ns._resolveSideChatRootId(existing.cascadeId)) {
        openMain();
      }
      box._syncThreadsUi?.(existing.cascadeId, hasQuote ? payload : null);
      ns.notifySideChatState({ activateTab: !opts.skipActivate, targetTabId, pane: opts.pane || '' });
      return box;
    }
    ns._syncSideChatPreview?.(box._els, payload.selectionContent);
    if (!popOut) {
      openMain();
    }
    Promise.resolve(
      ns.ensureSideChatThread({
        parentConversationId: box._convId,
        labelHint: hasQuote ? payload.cleanName : '',
        forceNew: Boolean(opts.forceNewThread || popOut),
        popOut,
        quotePayload: hasQuote ? payload : null,
      })
    ).then((th) => {
      const tId = th?.cascadeId ? (popOut ? `${ns.SIDECHAT_TAB_PREFIX}${th.cascadeId}` : ns.SIDECHAT_TAB_ID) : '';
      if (tId) {
        if (!popOut) {
          openMain();
        }
        const targetBox = popOut ? Object.assign(ns.ensureSideChatBox(tId, root), { _convId: box._convId }) : box;
        targetBox._syncThreadsUi?.(th.cascadeId, hasQuote ? payload : null);
        ns.notifySideChatState({ activateTab: !opts.skipActivate, targetTabId: tId, pane: opts.pane || '' });
      }
    });
    if (!popOut && !opts.skipActivate) {
      ns.notifySideChatState({ activateTab: true, targetTabId: ns.SIDECHAT_TAB_ID, pane: opts.pane || '' });
    }
    return box;
  };

  ns.toggleTerminalSideChat = (hostEl, opts = {}) => {
    const isVis = Boolean(getSc().isOpen && ns._sideChatBox && !ns._sideChatBox.classList?.contains?.('hidden'));
    if (isVis) {
      ns.closeSideChatDrawer({ deleteAll: true, notify: true });
    } else {
      ns.openTerminalQuoteComposer(hostEl, {}, opts);
    }
    return !isVis;
  };

  ns.openTerminalMiniComposer = function openTerminalMiniComposer(hostEl, rawPayload = {}, opts = {}) {
    const sc = getSc();
    const root = hostEl || document.body;
    const isMac = /Mac|iPhone|iPad/i.test(navigator?.platform || '');
    if (!root || typeof document?.createElement !== 'function') return null;
    const payload = rawPayload?.cleanName ? rawPayload : ns.buildTerminalScopePayload(rawPayload || {});
    let mini = root._hangarMiniComposer;
    if (!mini) {
      mini = mkEl('div', 'term-mini-composer');
      const hdr = mkEl('div', 'term-mini-header');
      const hdrLeft = mkEl('div', 'term-mini-header-left');
      const badge = mkEl('span', 'term-quote-composer-badge');
      const preview = mkEl('pre', 'term-quote-composer-preview term-mini-preview');
      const closeBtn = mkEl(
        'button',
        'term-quote-composer-close term-mini-close',
        { type: 'button', title: 'Cancel (Esc)', textContent: '×' },
        {},
        () => mini._hide()
      );
      hdrLeft.append?.(badge, preview);
      hdr.append?.(hdrLeft, closeBtn);
      const input = mkEl('textarea', 'term-quote-composer-input term-mini-input', {
        rows: 2,
        placeholder: `Ask about this terminal output… (Enter to send to Main Chat, ${isMac ? '⌘+Enter' : 'Ctrl+Enter'} for Side Chat)`,
      });
      const syncHeight = ns._bindAutoTextarea(input, 36, 110);
      const footer = mkEl('div', 'term-mini-footer');
      const hint = mkEl('span', 'term-mini-hint', { textContent: 'Esc to cancel · Shift+Enter for new line' });
      const actions = mkEl('div', 'term-mini-actions');
      const scSplit = mkEl('div', 'term-mini-sidechat-split');
      const sideChatBtn = mkEl(
        'button',
        'agy-btn agy-btn-outline term-mini-sidechat-btn',
        { type: 'button' },
        { role: 'mini-ask-sidechat' },
        () => mini._submitSideChat()
      );
      const sideChatPickBtn = mkEl(
        'button',
        'agy-btn agy-btn-outline term-mini-sidechat-pick',
        {
          type: 'button',
          title: 'Choose Side Chat thread (New Side Chat by default)',
          html: ns.iconSvg?.('expand_more', 14) || '▾',
        },
        { role: 'mini-pick-sidechat' },
        (e) => {
          const r = sideChatPickBtn.getBoundingClientRect?.() || { left: e?.clientX || 120, top: e?.clientY || 120 };
          const items = [
            {
              id: 'new-sidechat-target',
              icon: 'add',
              label: 'New Side Chat',
              checked: !mini._targetCascadeId,
              onClick: () => mini._setTargetCascadeId(''),
            },
            ...(sc.threads.length
              ? [
                  { separator: true },
                  ...sc.threads.map((t) => ({
                    id: `target-${t.cascadeId}`,
                    icon: 'chat',
                    label: ns.resolveSideChatTitle(t),
                    checked: mini._targetCascadeId === t.cascadeId,
                    onClick: () => mini._setTargetCascadeId(t.cascadeId),
                  })),
                ]
              : []),
          ];
          ns.openTabContextMenu?.(
            { clientX: r.left, clientY: Math.max(24, (r.top || 120) - 8), preventDefault() {}, stopPropagation() {} },
            items
          );
        }
      );
      const sendBtn = mkEl(
        'button',
        'agy-btn agy-btn-primary term-mini-send-btn',
        { type: 'button', textContent: 'Send to Main ↵' },
        { role: 'mini-send-main' },
        () => mini._submitMain()
      );
      scSplit.append?.(sideChatBtn, sideChatPickBtn);
      actions.append?.(scSplit, sendBtn);
      footer.append?.(hint, actions);
      mini.append?.(hdr, input, footer);
      root.appendChild?.(mini);

      const syncSideChatBtn = () => {
        const th = mini._targetCascadeId ? sc.threads.find((t) => t.cascadeId === mini._targetCascadeId) : null;
        if (!th) {
          mini._targetCascadeId = '';
        }
        sideChatPickBtn.classList?.toggle?.('hidden', !sc.threads.length);
        sideChatBtn.classList?.toggle?.('has-picker', sc.threads.length > 0);
        const label = th ? `Ask in ${ns.resolveSideChatTitle(th)}` : 'Ask in Side Chat';
        sideChatBtn.title = `${label} (${isMac ? '⌘+Enter' : 'Ctrl+Enter'})`;
        ns.setHtml(
          sideChatBtn,
          ns.html`<span>${ns.escHtml?.(label) || label}</span><span class="term-mini-kbd">${isMac ? '⌘↵' : 'Ctrl+↵'}</span>`
        );
      };
      const setTarget = (cid = '') => {
        mini._targetCascadeId = String(cid || '');
        syncSideChatBtn();
        setTimeout(() => input.focus?.(), 10);
      };
      const hide = () => mini.classList?.add?.('hidden');
      const submitMain = () => ns._submitQuoteToMain(mini, root, sendBtn, 'Send to Main ↵', input, syncHeight, hide);
      const submitSideChat = (overrideTargetCid) => {
        const cur = mini._payload || { cleanName: 'terminal', terminalId: '', selectionContent: '' };
        const promptText = String(input.value || '').trim();
        const rawTarget = overrideTargetCid !== undefined ? String(overrideTargetCid || '') : mini._targetCascadeId;
        const validTarget = rawTarget && sc.threads.some((t) => t.cascadeId === rawTarget) ? rawTarget : '';
        input.value = '';
        syncHeight();
        hide();
        return ns.openTerminalQuoteComposer(
          mini._toastRoot || root,
          { ...cur, promptText, autoSubmit: Boolean(promptText) },
          {
            conversationId: mini._convId || '',
            forceNewThread: !validTarget,
            targetCascadeId: validTarget,
          }
        );
      };
      input.addEventListener?.('keydown', (e) => {
        e.stopPropagation?.();
        const act = e.key === 'Escape'
          ? hide
          : (e.key === 'Enter' && !e.isComposing
              ? ((e.ctrlKey || e.metaKey) ? submitSideChat : (!e.shiftKey ? submitMain : null))
              : null);
        if (act) {
          e.preventDefault?.();
          act();
        }
      });
      Object.assign(mini, {
        _els: { badge, preview, input, sendBtn, sideChatBtn, sideChatPickBtn, closeBtn, hint },
        _syncSideChatBtn: syncSideChatBtn,
        _setTargetCascadeId: setTarget,
        _hide: hide,
        _submit: submitMain,
        _submitMain: submitMain,
        _submitSideChat: submitSideChat,
      });
      root._hangarMiniComposer = mini;
    }
    Object.assign(mini, {
      _toastRoot: root,
      _payload: payload,
      _convId: opts.conversationId || mini._convId || '',
      _targetCascadeId: '',
    });
    mini._syncSideChatBtn?.();
    const sel = String(payload.selectionContent || '').trim();
    const lines = sel ? sel.split(/\r?\n/) : [];
    mini._els.badge.textContent = `@${payload.cleanName || 'terminal'}${lines.length ? ` (${lines.length} line${lines.length === 1 ? '' : 's'})` : ''}`;
    mini._els.preview.textContent = lines.slice(0, 3).join('\n') + (lines.length > 3 ? '\n…' : '');
    mini._els.preview.classList?.toggle?.('hidden', !sel);
    mini.classList?.remove?.('hidden');
    setTimeout(() => mini._els.input.focus?.(), 10);
    return mini;
  };

  ns.createQuotePopupController = function createQuotePopupController(firstArg = {}, secondArg = {}) {
    const isDomArg = firstArg && typeof firstArg.appendChild === 'function' && !firstArg.containerEl;
    const opts = isDomArg ? secondArg : (firstArg || {});
    const hostEl = isDomArg ? firstArg : (firstArg?.containerEl || document.body);
    const isMac = /Mac|iPhone|iPad/i.test(navigator?.platform || '');
    const resolveMeta = () =>
      typeof opts.getTerminalMeta === 'function'
        ? (opts.getTerminalMeta() || {})
        : {
            terminalId: typeof opts.getTerminalId === 'function' ? opts.getTerminalId() : (opts.terminalId || ''),
            title: typeof opts.getTitle === 'function' ? opts.getTitle() : (opts.title || 'terminal'),
            conversationId: opts.conversationId || '',
          };
    const popup = mkEl('div', 'selection-popup term-quote-popup hidden');
    let activeSelection = null;
    const currentPayload = () =>
      ns.buildTerminalScopePayload({
        ...resolveMeta(),
        selectionContent: activeSelection?.text || '',
        quoteFileUri: activeSelection?.quoteFileUri || '',
      });
    const stageHostQuote = (sel = activeSelection) => {
      if (!sel?.text?.trim()) return;
      ns.apiCall?.('/api/terminal/ls-rpc', {
        method: 'WriteQuoteFile',
        conversationId: resolveMeta().conversationId || '',
        terminalId: resolveMeta().terminalId || '',
        name: resolveMeta().title || 'terminal',
        selectionContent: sel.text,
      })
        ?.then?.((r) => {
          if (r?.uri && activeSelection === sel) {
            activeSelection.quoteFileUri = r.uri;
          }
        })
        ?.catch?.(() => {});
    };
    const hide = () => {
      activeSelection = null;
      popup.classList?.add?.('hidden');
    };
    const finishSelection = (askAgent = false, e = null) => {
      e?.preventDefault?.();
      if (!activeSelection?.text) return null;
      const text = activeSelection.text;
      const meta = resolveMeta();
      const payload = ns.copyTerminalQuoteToClipboard(currentPayload());
      hide();
      window.getSelection?.()?.removeAllRanges?.();
      if (askAgent) {
        ns.openTerminalMiniComposer(hostEl, payload, { conversationId: meta.conversationId || '' });
      } else {
        ns.showTerminalQuoteToast(
          hostEl,
          `Quoted "${payload.cleanName}" (${text.split('\n').length} line${text.includes('\n') ? 's' : ''}) — press ${isMac ? '⌘V' : 'Ctrl+V'} in chat`
        );
      }
      opts.onQuoted?.(payload);
      return payload;
    };
    const quoteBtn = mkEl(
      'button',
      'term-quote-btn',
      {
        type: 'button',
        title: 'Click to copy native chat mention pill (Ctrl+V in chat), or drag directly into chat',
        html: `<span class="term-quote-label">Quote</span><span class="term-quote-kbd text-xs opacity-50">${isMac ? '⌘L' : 'Alt+L'}</span>`,
      },
      {},
      (e) => finishSelection(false, e)
    );
    const askBtn = mkEl(
      'button',
      'term-quote-btn term-quote-ask-btn',
      {
        type: 'button',
        title: 'Open tool-enabled Side Chat with this selection (or send to Main Chat)',
        html: '<span class="term-quote-label">Quote & Ask</span>',
      },
      {},
      (e) => finishSelection(true, e)
    );
    [quoteBtn, askBtn].forEach((b) => popup.appendChild?.(b));
    hostEl?.appendChild?.(popup);
    ns.bindTerminalDragSource(quoteBtn, currentPayload);
    quoteBtn.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      stageHostQuote();
    });
    quoteBtn.addEventListener('dragstart', () => stageHostQuote());
    quoteBtn.addEventListener('dragend', (e) => {
      const meta = resolveMeta();
      const payload = ns.copyTerminalQuoteToClipboard(currentPayload());
      const cx = Number(e?.clientX) || 0;
      const cy = Number(e?.clientY) || 0;
      const winW = Number(window.innerWidth) || 0;
      const winH = Number(window.innerHeight) || 0;
      if (payload.selectionContent) {
        for (const scBox of getSc().boxes.values()) {
          const sRect = !scBox.classList?.contains?.('hidden')
            ? (scBox.getBoundingClientRect?.() || { left: 0, top: 0, right: 0, bottom: 0 })
            : null;
          if (sRect && cx >= sRect.left && cx <= sRect.right && cy >= sRect.top && cy <= sRect.bottom) {
            try {
              scBox._els?.chatFrame?.contentWindow?.postMessage({ type: 'hangar-inject-terminal-quote', payload }, '*');
            } catch {
              /* ignore */
            }
          }
        }
        const outside = (cx < 0 || cy < 0 || (winW > 0 && cx > winW) || (winH > 0 && cy > winH)) && !(cx === 0 && cy === 0);
        if (outside) {
          ns.apiCall?.('/api/terminal/ls-rpc', {
            method: 'InjectQuoteDrop',
            conversationId: meta.conversationId || '',
            terminalId: payload.terminalId,
            title: payload.cleanName,
            selectionContent: payload.selectionContent,
          })?.catch?.(() => {});
        }
      }
      hide();
      window.getSelection?.()?.removeAllRanges?.();
      opts.onQuoted?.(payload);
    });
    askBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    return {
      show(selInfo) {
        if (!selInfo?.text?.trim()) {
          hide();
          return;
        }
        activeSelection = selInfo;
        stageHostQuote(activeSelection);
        popup.classList?.remove?.('hidden');
        const rect = hostEl?.getBoundingClientRect?.() || { left: 0, top: 0, width: 300, height: 200 };
        const popRect = popup.getBoundingClientRect?.() || {};
        const popW = Math.max(215, Number(popRect.width) || Number(popup.offsetWidth) || 215);
        const popH = Math.max(32, Number(popRect.height) || Number(popup.offsetHeight) || 32);
        const x = Math.max(8, Math.min((rect.width || 300) - popW - 8, (selInfo.clientX || rect.left + 40) - rect.left));
        const rawY = (selInfo.clientY || rect.top + 40) - rect.top;
        Object.assign(popup.style, {
          left: `${Math.round(x)}px`,
          top: `${Math.round(rawY + popH + 12 > (rect.height || 200) ? Math.max(8, rawY - popH - 6) : rawY + 12)}px`,
        });
      },
      hide,
      triggerQuote(text, askAgent = false) {
        const trimmed = String(text ?? activeSelection?.text ?? window.getSelection?.()?.toString?.() ?? '').trim();
        if (!trimmed) return null;
        activeSelection = { text: trimmed };
        return finishSelection(askAgent);
      },
      showToast: (msg) => ns.showTerminalQuoteToast(hostEl, msg),
    };
  };

  ns.handleJetboxQuoteEvent = function handleJetboxQuoteEvent(type, payload = {}, { rootEl, term, title, conversationId }) {
    const effCid = conversationId && conversationId !== '_new' ? conversationId : (term?.conversationId || '');
    if (type === 'hangar-jetbox-quote-dragend') {
      if (payload.outsideFrame && payload.selectionContent) {
        ns.apiCall('/api/terminal/ls-rpc', {
          method: 'InjectQuoteDrop',
          conversationId: effCid,
          terminalId: term.terminalId,
          title,
          selectionContent: payload.selectionContent,
        }).catch(() => {});
      }
      return;
    }
    const q = ns.copyTerminalQuoteToClipboard({
      terminalId: term.terminalId,
      title,
      selectionContent: payload.selectionContent || '',
      alreadyCopied: Boolean(payload.copied),
    });
    if (payload.askAgent) {
      ns.openTerminalMiniComposer(rootEl, q, { conversationId: effCid });
    } else {
      const msg = payload.selectionContent
        ? `Quoted selection from "${title}" — press Ctrl+V in chat`
        : `Copied @${q.cleanName} mention pill — press Ctrl+V in chat`;
      ns.showTerminalQuoteToast(rootEl, msg);
    }
  };
})();
