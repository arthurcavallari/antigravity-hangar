/**
 * @fileoverview Antigravity terminal quoting & drag-to-chat integration.
 * Serializes TerminalScopeItemSchema / ContextScopeItemSchema for:
 *  1. Clipboard paste (`application/x-lexical-editor` + `text/plain` scope-item syntax)
 *  2. Drag-and-drop into chat (`application/context-scope-item-cider`)
 *  3. Native `.selection-popup` ("Quote Alt+L") selection popup and toast feedback.
 */

(function () {
  const ns = (window.Hangar = window.Hangar || {});

  ns.buildTerminalScopePayload = function buildTerminalScopePayload({
    terminalId = '',
    title = 'terminal',
    selectionContent = '',
    lastCommand = '',
  } = {}) {
    const cleanName = String(title || 'terminal')
      .replace(/[\[\]()\r\n]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || 'terminal';
    const pid = String(terminalId || '').trim();
    const sel = String(selectionContent || '');

    const terminalObj = { processId: pid, name: cleanName };
    if (lastCommand) terminalObj.lastCommand = String(lastCommand);
    if (sel) terminalObj.selectionContent = sel;

    const contextScopeJson = JSON.stringify({ terminal: terminalObj });
    const lexicalJson = JSON.stringify({
      namespace: 'chat-editor',
      nodes: [
        {
          type: 'contextScopeItemMention',
          trigger: '@',
          value: 'contextScopeItemMention',
          data: { data: contextScopeJson },
          version: 1,
        },
        { detail: 0, format: 0, mode: 'normal', style: '', text: ' ', type: 'text', version: 1 },
      ],
    });

    const safeLabel = cleanName.replace(/:/g, '-') || 'terminal';
    const plainText = pid
      ? `[${cleanName}](terminal;${pid}) `
      : `[${cleanName}](textBlock;label:${safeLabel}:${encodeURIComponent(sel)}) `;
    const textBlockFallback = `[${cleanName}](textBlock;label:${safeLabel}:${encodeURIComponent(sel)}) `;

    return {
      cleanName,
      terminalId: pid,
      selectionContent: sel,
      contextScopeJson,
      lexicalJson,
      plainText,
      textBlockFallback,
    };
  };

  ns.copyTerminalQuoteToClipboard = function copyTerminalQuoteToClipboard(opts = {}) {
    const payload = opts.lexicalJson ? opts : ns.buildTerminalScopePayload(opts);
    let copiedCustomMime = false;

    const onCopy = (e) => {
      if (!e.clipboardData) return;
      e.preventDefault();
      e.stopPropagation();
      e.clipboardData.setData('application/x-lexical-editor', payload.lexicalJson);
      e.clipboardData.setData('application/context-scope-item-cider', payload.contextScopeJson);
      e.clipboardData.setData('text/plain', payload.plainText);
      copiedCustomMime = true;
    };

    document.addEventListener('copy', onCopy, true);
    const probe = document.createElement('span');
    probe.textContent = payload.plainText;
    probe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none;';
    document.body?.appendChild?.(probe);

    try {
      const sel = window.getSelection?.();
      const savedRanges = [];
      if (sel && typeof document.createRange === 'function') {
        for (let i = 0; i < (sel.rangeCount || 0); i++) savedRanges.push(sel.getRangeAt(i).cloneRange());
        sel.removeAllRanges?.();
        const range = document.createRange();
        range.selectNodeContents(probe);
        sel.addRange?.(range);
      }
      document.execCommand?.('copy');
      if (sel && savedRanges.length) {
        sel.removeAllRanges?.();
        for (const r of savedRanges) sel.addRange?.(r);
      }
    } catch {
      // Fallback below if execCommand fails
    } finally {
      document.removeEventListener('copy', onCopy, true);
      probe.remove?.();
    }

    if (!copiedCustomMime && !opts.alreadyCopied && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(payload.textBlockFallback || payload.plainText).catch(() => {});
    }
    return payload;
  };

  ns.bindTerminalDragSource = function bindTerminalDragSource(el, getPayloadFn) {
    if (!el) return;
    el.draggable = true;
    el.setAttribute?.('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer) return;
      const raw = (typeof getPayloadFn === 'function' ? getPayloadFn() : getPayloadFn) || {};
      const payload = raw.contextScopeJson ? raw : ns.buildTerminalScopePayload(raw);
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('application/context-scope-item-cider', payload.contextScopeJson);
      if (payload.lexicalJson) e.dataTransfer.setData('application/x-lexical-editor', payload.lexicalJson);
      e.dataTransfer.setData('text/plain', payload.plainText);
    });
  };

  ns.showTerminalQuoteToast = function showTerminalQuoteToast(hostEl, message) {
    const root = hostEl || document.body;
    if (!root || !message) return;
    let toast = root._hangarQuoteToast;
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'term-quote-toast';
      root.appendChild?.(toast);
      root._hangarQuoteToast = toast;
    }
    toast.textContent = message;
    toast.className = 'term-quote-toast';
    toast.classList?.remove?.('hidden');
    if (toast._timer) clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList?.add?.('hidden'), 2600);
  };

  ns.createQuotePopupController = function createQuotePopupController(firstArg = {}, secondArg = {}) {
    const isDomArg = firstArg && typeof firstArg.appendChild === 'function' && !firstArg.containerEl;
    const opts = isDomArg ? secondArg : (firstArg || {});
    const hostEl = isDomArg ? firstArg : (opts.containerEl || document.body);
    const resolveMeta = () => {
      if (typeof opts.getTerminalMeta === 'function') return opts.getTerminalMeta() || {};
      return {
        terminalId: typeof opts.getTerminalId === 'function' ? opts.getTerminalId() : (opts.terminalId || ''),
        title: typeof opts.getTitle === 'function' ? opts.getTitle() : (opts.title || 'terminal'),
      };
    };

    const popup = document.createElement('div');
    popup.className = 'selection-popup term-quote-popup hidden';
    const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || '');
    const shortcutLabel = isMac ? '⌘L' : 'Alt+L';

    const quoteBtn = document.createElement('button');
    quoteBtn.type = 'button';
    quoteBtn.className = 'term-quote-btn';
    quoteBtn.title = 'Click to copy native chat mention pill (Ctrl+V in chat), or drag directly into chat';
    quoteBtn.innerHTML = `<span class="term-quote-label">Quote</span><span class="term-quote-kbd text-xs opacity-50">${shortcutLabel}</span>`;
    popup.appendChild?.(quoteBtn);
    hostEl?.appendChild?.(popup);

    let activeSelection = null;
    let toastRoot = hostEl;

    function currentPayload() {
      const meta = resolveMeta();
      return ns.buildTerminalScopePayload({
        terminalId: meta.terminalId || '',
        title: meta.title || 'terminal',
        selectionContent: activeSelection?.text || '',
      });
    }

    ns.bindTerminalDragSource(quoteBtn, currentPayload);
    quoteBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    quoteBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!activeSelection?.text) return;
      const text = activeSelection.text;
      const payload = ns.copyTerminalQuoteToClipboard(currentPayload());
      popup.classList?.add?.('hidden');
      activeSelection = null;
      window.getSelection?.()?.removeAllRanges?.();
      ns.showTerminalQuoteToast(toastRoot, `Quoted "${payload.cleanName}" (${text.split('\n').length} line${text.includes('\n') ? 's' : ''}) — press ${isMac ? '⌘V' : 'Ctrl+V'} in chat`);
      opts.onQuoted?.(payload);
    });

    const ctrl = {
      show(selInfo) {
        if (!selInfo?.text?.trim()) {
          activeSelection = null;
          popup.classList?.add?.('hidden');
          return;
        }
        activeSelection = selInfo;
        const rect = hostEl?.getBoundingClientRect?.() || { left: 0, top: 0, width: 300, height: 200 };
        const x = Math.max(8, Math.min((rect.width || 300) - 120, (selInfo.clientX || rect.left + 40) - rect.left));
        const rawY = (selInfo.clientY || rect.top + 40) - rect.top;
        const y = rawY + 42 > (rect.height || 200) ? Math.max(8, rawY - 38) : rawY + 12;
        popup.style.left = `${Math.round(x)}px`;
        popup.style.top = `${Math.round(y)}px`;
        popup.classList?.remove?.('hidden');
      },
      hide() {
        activeSelection = null;
        popup.classList?.add?.('hidden');
      },
      triggerQuote(text) {
        const trimmed = String(text ?? activeSelection?.text ?? window.getSelection?.()?.toString?.() ?? '').trim();
        if (!trimmed) return null;
        activeSelection = { text: trimmed };
        const payload = ns.copyTerminalQuoteToClipboard(currentPayload());
        popup.classList?.add?.('hidden');
        activeSelection = null;
        window.getSelection?.()?.removeAllRanges?.();
        ns.showTerminalQuoteToast(toastRoot, `Quoted "${payload.cleanName}" — press ${isMac ? '⌘V' : 'Ctrl+V'} in chat`);
        opts.onQuoted?.(payload);
        return payload;
      },
      bindToContainer(targetEl, customToastRoot) {
        if (customToastRoot) toastRoot = customToastRoot;
        if (!targetEl) return;
        targetEl.addEventListener('mouseup', (e) => {
          setTimeout(() => {
            const selText = window.getSelection?.()?.toString?.() || '';
            if (selText.trim()) ctrl.show({ text: selText, clientX: e?.clientX, clientY: e?.clientY });
            else ctrl.hide();
          }, 10);
        });
        targetEl.addEventListener('keydown', (e) => {
          const isQuoteKey = ((e.altKey && !e.ctrlKey && !e.metaKey) || ((e.metaKey || e.ctrlKey) && !e.altKey)) && !e.shiftKey && e.key?.toLowerCase?.() === 'l';
          if (!isQuoteKey) return;
          const selText = activeSelection?.text || window.getSelection?.()?.toString?.() || '';
          if (selText.trim()) {
            e.preventDefault?.();
            e.stopPropagation?.();
            ctrl.triggerQuote(selText);
          }
        });
      },
      showToast: (msg) => ns.showTerminalQuoteToast(toastRoot, msg),
    };
    return ctrl;
  };
})();
