/**
 * @fileoverview Antigravity terminal quoting, drag-to-chat, and tool-enabled Side Chat drawer.
 * Serializes TerminalScopeItemSchema / ContextScopeItemSchema for:
 *  1. Clipboard paste (`application/x-lexical-editor` + `text/plain` scope-item syntax)
 *  2. Drag-and-drop into chat (`application/context-scope-item-cider`)
 *  3. Selection popup ("Quote Alt+L" | "Quote & Ask") and progressive Side Chat drawer / split tab.
 */

(function () {
  const ns = (window.Hangar = window.Hangar || {});
  ns.SIDECHAT_TAB_ID = '__sidechat__';
  ns.SIDECHAT_TAB_PREFIX = 'sidechat__';
  ns.isSideChatTabId = (tabId = '') => tabId === ns.SIDECHAT_TAB_ID || String(tabId || '').startsWith(ns.SIDECHAT_TAB_PREFIX);

  const CUSTOM_TITLES_KEY = 'hangar.sideChatCustomTitles';
  ns.readCustomSideChatTitles = () => { try { const r = JSON.parse(localStorage.getItem(CUSTOM_TITLES_KEY) || '{}'); return r && typeof r === 'object' ? r : {}; } catch { return {}; } };
  ns.saveCustomSideChatTitle = (cid, title) => { try { const m = ns.readCustomSideChatTitles(); if (title) m[cid] = title; else delete m[cid]; localStorage.setItem(CUSTOM_TITLES_KEY, JSON.stringify(m)); } catch {} };

  let sideChatThreads = [], activeSideChatId = '', sideChatCounter = 0, sideChatGeneration = 0, hydratedFromLayout = false, hydratedSideChatWsKey = null;
  let isSideChatOpen = false, isSideChatDocked = true, onSideChatStateChange = null, startInFlight = null;
  const poppedSideChatIds = new Set(), sideChatGroupMap = {}, activeSideChatByInstance = new Map(), sideChatBoxes = new Map(), framesByCascadeId = new Map();

  ns.getPoppedSideChatIds = () => new Set(poppedSideChatIds);
  ns.getSideChatGroupMap = () => ({ ...sideChatGroupMap });
  ns.getActiveSideChatId = (instanceTabId = ns.SIDECHAT_TAB_ID) => activeSideChatByInstance.get(instanceTabId) || (instanceTabId === ns.SIDECHAT_TAB_ID ? activeSideChatId : '');
  ns.setActiveSideChatId = (instanceTabId = ns.SIDECHAT_TAB_ID, cascadeId = '') => {
    if (cascadeId) activeSideChatByInstance.set(instanceTabId, cascadeId);
    else activeSideChatByInstance.delete(instanceTabId);
    if (instanceTabId === ns.SIDECHAT_TAB_ID) activeSideChatId = cascadeId;
  };
  ns.getInstanceSideChats = (allThreads = sideChatThreads, rootId = '') => (
    rootId
      ? allThreads.filter((t) => poppedSideChatIds.has(rootId) && (t.cascadeId === rootId || sideChatGroupMap[t.cascadeId] === rootId))
      : allThreads.filter((t) => !poppedSideChatIds.has(t.cascadeId) && !poppedSideChatIds.has(sideChatGroupMap[t.cascadeId]))
  );

  ns.serializeSideChatState = () => ({
    isOpen: Boolean(isSideChatOpen),
    isDocked: Boolean(isSideChatDocked),
    activeCascadeId: String(activeSideChatId || ''),
    sideChatCounter: Number(sideChatCounter) || 0,
    threads: sideChatThreads.map((t) => ({
      cascadeId: String(t.cascadeId || ''),
      title: String(t.title || 'Side Chat'),
      parentConversationId: String(t.parentConversationId || ''),
      pinned: Boolean(t.pinned),
    })),
    poppedIds: [...poppedSideChatIds],
    groupMap: { ...sideChatGroupMap },
    activeByInstance: Object.fromEntries(activeSideChatByInstance.entries()),
    customTitles: ns.readCustomSideChatTitles(),
  });

  ns.hydrateSideChatStateFromLayout = (layout = {}, workspacePath = '') => {
    const wsKey = String(workspacePath || '').trim().replace(/\\/g, '/').toLowerCase();
    if (hydratedFromLayout && hydratedSideChatWsKey === wsKey) return;
    hydratedFromLayout = true;
    hydratedSideChatWsKey = wsKey;
    sideChatThreads = [];
    activeSideChatId = '';
    sideChatCounter = 0;
    isSideChatOpen = false;
    poppedSideChatIds.clear();
    for (const k of Object.keys(sideChatGroupMap)) delete sideChatGroupMap[k];
    activeSideChatByInstance.clear();
    const sc = wsKey ? layout?.sideChatStateByWorkspace?.[wsKey] : layout?.sideChatState;
    if (sc && typeof sc === 'object') {
      if (sc.customTitles && typeof sc.customTitles === 'object') {
        try { localStorage.setItem(CUSTOM_TITLES_KEY, JSON.stringify({ ...sc.customTitles, ...ns.readCustomSideChatTitles() })); } catch {}
      }
      if (Array.isArray(sc.threads)) {
        sideChatThreads = sc.threads
          .filter((t) => t && t.cascadeId)
          .map((t) => ({
            cascadeId: String(t.cascadeId),
            title: String(t.title || 'Side Chat'),
            parentConversationId: String(t.parentConversationId || ''),
            hasActivity: false,
            pinned: Boolean(t.pinned),
            quotePayload: null,
          }));
      }
      if (typeof sc.sideChatCounter === 'number' && sc.sideChatCounter > sideChatCounter) sideChatCounter = sc.sideChatCounter;
      else if (sideChatThreads.length > sideChatCounter) sideChatCounter = sideChatThreads.length;
      if (Array.isArray(sc.poppedIds)) sc.poppedIds.filter(Boolean).forEach((id) => poppedSideChatIds.add(String(id)));
      if (sc.groupMap && typeof sc.groupMap === 'object') Object.assign(sideChatGroupMap, sc.groupMap);
      if (sc.activeByInstance && typeof sc.activeByInstance === 'object') {
        for (const [k, v] of Object.entries(sc.activeByInstance)) if (v) activeSideChatByInstance.set(k, String(v));
      }
      if (sc.activeCascadeId) activeSideChatId = String(sc.activeCascadeId);
      if (typeof sc.isDocked === 'boolean') isSideChatDocked = sc.isDocked;
      if (typeof sc.isOpen === 'boolean') isSideChatOpen = sc.isOpen;
    }
    const closedSet = new Set(Array.isArray(layout?.closedTabIds) ? layout.closedTabIds : []);
    if (!wsKey) {
      const refTabs = [...(Array.isArray(layout?.tabOrder) ? layout.tabOrder : []), ...(Array.isArray(layout?.topSplitTabIds) ? layout.topSplitTabIds : []), layout?.pinnedTopSidecarId || ''];
      for (const tabId of refTabs) {
        if (String(tabId).startsWith(ns.SIDECHAT_TAB_PREFIX) && !closedSet.has(tabId)) {
          const cid = String(tabId).slice(ns.SIDECHAT_TAB_PREFIX.length);
          if (!cid) continue;
          poppedSideChatIds.add(cid);
          if (!sideChatThreads.some((t) => t.cascadeId === cid)) {
            const idx = ++sideChatCounter;
            sideChatThreads.push({ cascadeId: cid, title: `Side Chat #${idx}`, parentConversationId: '', hasActivity: false, pinned: false, quotePayload: null });
          }
          if (!activeSideChatByInstance.has(tabId)) activeSideChatByInstance.set(tabId, cid);
        }
      }
    }
    if (ns.getInstanceSideChats(sideChatThreads, '').length > 0 && !closedSet.has(ns.SIDECHAT_TAB_ID)) {
      isSideChatOpen = true;
    }
  };

  ns.getSideChatState = () => ({
    threads: sideChatThreads.map((t) => ({ ...t })),
    activeCascadeId: activeSideChatId,
    isOpen: isSideChatOpen,
    isDocked: isSideChatDocked,
    poppedIds: [...poppedSideChatIds],
    sideChatState: ns.serializeSideChatState(),
  });
  ns.setSideChatDockCallback = (fn) => { onSideChatStateChange = typeof fn === 'function' ? fn : null; };

  ns.buildTerminalScopePayload = function buildTerminalScopePayload({ terminalId = '', title = 'terminal', selectionContent = '', lastCommand = '' } = {}) {
    const cleanName = String(title || 'terminal').replace(/[\[\]()\r\n]/g, '').replace(/\s+/g, ' ').trim() || 'terminal';
    const pid = String(terminalId || '').trim(), sel = String(selectionContent || '');
    const terminalObj = { processId: pid, name: cleanName };
    if (lastCommand) terminalObj.lastCommand = String(lastCommand);
    if (sel) terminalObj.selectionContent = sel;
    const contextScopeJson = JSON.stringify({ terminal: terminalObj });
    const lexicalJson = JSON.stringify({
      namespace: 'Input',
      nodes: [
        { detail: 0, format: 0, mode: 'segmented', style: '', text: '', type: 'contextScopeItemMention', trigger: '@', value: 'contextScopeItemMention', scopeItem: contextScopeJson, data: { data: contextScopeJson }, version: 1 },
        { detail: 0, format: 0, mode: 'normal', style: '', text: ' ', type: 'text', version: 1 },
      ],
    });
    const safeLabel = cleanName.replace(/:/g, '-') || 'terminal';
    const textBlockFallback = `[${cleanName}](textBlock;label:${safeLabel}:${encodeURIComponent(sel)}) `;
    const plainText = pid ? `[${cleanName}](terminal;${pid}) ` : textBlockFallback;
    return { cleanName, terminalId: pid, selectionContent: sel, contextScopeJson, lexicalJson, plainText, textBlockFallback, quoteFileUri: String(arguments[0]?.quoteFileUri || '') };
  };

  ns.copyTerminalQuoteToClipboard = function copyTerminalQuoteToClipboard(opts = {}) {
    const payload = opts.lexicalJson ? opts : ns.buildTerminalScopePayload(opts);
    let copiedCustomMime = false;
    const onCopy = (e) => {
      if (!e.clipboardData) return;
      e.preventDefault(); e.stopPropagation();
      e.clipboardData.setData('application/x-lexical-editor', payload.lexicalJson);
      e.clipboardData.setData('application/context-scope-item', payload.contextScopeJson);
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
      const sel = window.getSelection?.(), savedRanges = [];
      if (sel && typeof document.createRange === 'function') {
        for (let i = 0; i < (sel.rangeCount || 0); i++) savedRanges.push(sel.getRangeAt(i).cloneRange());
        sel.removeAllRanges?.();
        const range = document.createRange(); range.selectNodeContents(probe); sel.addRange?.(range);
      }
      document.execCommand?.('copy');
      if (sel && savedRanges.length) { sel.removeAllRanges?.(); for (const r of savedRanges) sel.addRange?.(r); }
    } catch {} finally {
      document.removeEventListener('copy', onCopy, true); probe.remove?.();
    }
    if (!copiedCustomMime && !opts.alreadyCopied && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(payload.textBlockFallback || payload.plainText).catch(() => {});
    }
    return payload;
  };

  ['dragenter', 'dragover'].forEach((ev) => window.addEventListener?.(ev, (e) => {
    if (Array.from(e?.dataTransfer?.types || []).some((t) => String(t).toLowerCase().includes('context-scope-item'))) {
      e.preventDefault?.(); e.dataTransfer.dropEffect = 'copy';
    }
  }));

  ns.bindTerminalDragSource = function bindTerminalDragSource(el, getPayloadFn) {
    if (!el) return;
    el.draggable = true;
    el.setAttribute?.('draggable', 'true');
    if (el.style) el.style.webkitUserDrag = 'element';
    el.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer) return;
      const raw = (typeof getPayloadFn === 'function' ? getPayloadFn() : getPayloadFn) || {};
      const payload = raw.contextScopeJson ? raw : ns.buildTerminalScopePayload(raw);
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('application/context-scope-item', payload.contextScopeJson);
      e.dataTransfer.setData('application/context-scope-item-cider', payload.contextScopeJson);
      if (payload.lexicalJson) e.dataTransfer.setData('application/x-lexical-editor', payload.lexicalJson);
      e.dataTransfer.setData('text/plain', payload.plainText);
    });
  };

  ns.showTerminalQuoteToast = function showTerminalQuoteToast(hostEl, message) {
    if (window.AgyUI?.showToast) {
      window.AgyUI.showToast(message, { container: hostEl });
      return;
    }
    const root = hostEl || document.body;
    if (!root || !message) return;
    let toast = root._hangarQuoteToast;
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'agy-toast';
      root.appendChild?.(toast);
      root._hangarQuoteToast = toast;
    }
    toast.textContent = message;
    toast.className = 'agy-toast';
    toast.classList?.remove?.('hidden');
    if (toast._timer) clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList?.add?.('hidden'), 2600);
  };

  ns.formatTerminalAgentMessage = function formatTerminalAgentMessage(payload = {}, userPrompt = '') {
    const name = payload.cleanName || 'terminal';
    const sel = String(payload.selectionContent || '').trim();
    const quoteBlock = sel ? `From terminal "${name}":\n\`\`\`text\n${sel}\n\`\`\`` : `From terminal "${name}" (${(payload.plainText || '').trim()})`;
    const prompt = String(userPrompt || '').trim();
    return prompt ? `${quoteBlock}\n\n${prompt}` : quoteBlock;
  };

  function buildChatFrameSrc(cascadeId) {
    const isLight = Boolean(document.body?.classList?.contains?.('theme-light'));
    const uiTok = new URLSearchParams(window.location?.search || '').get('token') || '';
    return `/jetbox-chat?cascadeId=${encodeURIComponent(cascadeId)}&hostTheme=${isLight ? 'light' : 'dark'}&v=7${uiTok ? `&token=${encodeURIComponent(uiTok)}` : ''}`;
  }

  const resolveSideChatTitle = (t) => (t ? (ns.readCustomSideChatTitles()[t.cascadeId] || t.title || 'Side Chat') : 'Side Chat');

  async function ensureSideChatThread({ parentConversationId = '', labelHint = '', forceNew = false, rootId = '', popOut = false, quotePayload = null } = {}) {
    const instTabId = rootId ? `${ns.SIDECHAT_TAB_PREFIX}${rootId}` : ns.SIDECHAT_TAB_ID;
    if (!forceNew && !popOut) {
      const instThreads = ns.getInstanceSideChats(sideChatThreads, rootId);
      const actId = ns.getActiveSideChatId(instTabId);
      const existing = instThreads.find((t) => t.cascadeId === actId) || instThreads[instThreads.length - 1];
      if (existing) {
        if (quotePayload) existing.quotePayload = quotePayload;
        return existing;
      }
    }
    if (!forceNew && !popOut && startInFlight) return startInFlight;
    const gen = sideChatGeneration;
    const run = (async () => {
      const idx = ++sideChatCounter;
      const fallbackId = `sidechat-${Date.now()}-${idx}`;
      let cascadeId = fallbackId, createdRemote = false;
      try {
        const res = await ns.apiCall?.('/api/terminal/sidechat/start', { parentConversationId });
        if (res?.cascadeId) { cascadeId = String(res.cascadeId); createdRemote = true; }
      } catch {}
      if (gen !== sideChatGeneration || (!isSideChatOpen && !popOut && !rootId)) {
        if (createdRemote) ns.apiCall?.('/api/terminal/sidechat/delete', { cascadeId })?.catch?.(() => {});
        return null;
      }
      const title = labelHint ? `Side Chat #${idx} · ${labelHint}` : `Side Chat #${idx}`;
      const thread = { cascadeId, title, parentConversationId: String(parentConversationId || ''), hasActivity: false, pinned: false, quotePayload: quotePayload || null };
      sideChatThreads.push(thread);
      if (popOut) {
        poppedSideChatIds.add(cascadeId);
        ns.setActiveSideChatId(`${ns.SIDECHAT_TAB_PREFIX}${cascadeId}`, cascadeId);
      } else if (rootId) {
        sideChatGroupMap[cascadeId] = rootId;
        ns.setActiveSideChatId(instTabId, cascadeId);
      } else {
        ns.setActiveSideChatId(ns.SIDECHAT_TAB_ID, cascadeId);
      }
      return thread;
    })();
    startInFlight = run;
    try { return await run; } finally { if (startInFlight === run) startInFlight = null; }
  }

  function disposeThreadFrame(cid) {
    const f = framesByCascadeId.get(cid);
    if (f) {
      if (f.dataset) f.dataset.loadedCascadeId = '';
      f.src = 'about:blank';
      f.classList?.add?.('hidden');
      if (!f._isInitialFrame) f.remove?.();
      framesByCascadeId.delete(cid);
    }
  }

  async function deleteSideChatsByIds(cids = [], instanceTabId = ns.SIDECHAT_TAB_ID) {
    const targetIds = cids.filter(Boolean);
    if (!targetIds.length) return;
    const rmSet = new Set(targetIds);
    const rootId = instanceTabId.startsWith(ns.SIDECHAT_TAB_PREFIX) ? instanceTabId.slice(ns.SIDECHAT_TAB_PREFIX.length) : '';
    for (const cid of targetIds) {
      delete sideChatGroupMap[cid];
      ns.saveCustomSideChatTitle(cid, '');
      disposeThreadFrame(cid);
      ns.apiCall?.('/api/terminal/sidechat/delete', { cascadeId: cid })?.catch?.(() => {});
    }
    const prevIds = ns.getInstanceSideChats(sideChatThreads, rootId).map((t) => t.cascadeId), prevAct = ns.getActiveSideChatId(instanceTabId) || prevIds[0] || '';
    sideChatThreads = sideChatThreads.filter((t) => !rmSet.has(t.cascadeId));
    const rem = ns.getInstanceSideChats(sideChatThreads, rootId);
    const remIds = rem.map((t) => t.cascadeId), remSet = new Set(remIds), pIdx = prevIds.indexOf(prevAct);
    const nextAct = remSet.has(prevAct) ? prevAct : ((pIdx >= 0 ? prevIds.slice(pIdx + 1).find((id) => remSet.has(id)) : '') || remIds[remIds.length - 1] || '');
    if (rootId) {
      if (!rem.length) {
        poppedSideChatIds.delete(rootId);
        for (const [k, v] of Object.entries(sideChatGroupMap)) { if (v === rootId) delete sideChatGroupMap[k]; }
        const b = sideChatBoxes.get(instanceTabId);
        b?.remove?.();
        sideChatBoxes.delete(instanceTabId);
        activeSideChatByInstance.delete(instanceTabId);
        onSideChatStateChange?.({ ...ns.getSideChatState(), closedSidecarId: instanceTabId });
      } else if (rmSet.has(rootId)) {
        const nextRoot = rem[0].cascadeId, nextTabId = `${ns.SIDECHAT_TAB_PREFIX}${nextRoot}`;
        poppedSideChatIds.delete(rootId);
        poppedSideChatIds.add(nextRoot);
        delete sideChatGroupMap[nextRoot];
        for (const [k, v] of Object.entries(sideChatGroupMap)) { if (v === rootId) sideChatGroupMap[k] = nextRoot; }
        const b = sideChatBoxes.get(instanceTabId);
        if (b) {
          sideChatBoxes.delete(instanceTabId);
          sideChatBoxes.set(nextTabId, b);
          b._setInstance(nextTabId, nextRoot);
        }
        activeSideChatByInstance.delete(instanceTabId);
        ns.setActiveSideChatId(nextTabId, nextAct);
        b?._syncThreadsUi?.(nextAct, null);
        onSideChatStateChange?.({ ...ns.getSideChatState(), replacedSidecarId: { from: instanceTabId, to: nextTabId } });
      } else {
        ns.setActiveSideChatId(instanceTabId, nextAct);
        sideChatBoxes.get(instanceTabId)?._syncThreadsUi?.(nextAct, null);
        onSideChatStateChange?.(ns.getSideChatState());
      }
      return;
    }
    if (!rem.length) {
      ns.closeSideChatDrawer({ deleteAll: sideChatThreads.length === 0, notify: true });
      return;
    }
    ns.setActiveSideChatId(ns.SIDECHAT_TAB_ID, nextAct);
    sideChatBoxes.get(ns.SIDECHAT_TAB_ID)?._syncThreadsUi?.(nextAct, null);
    onSideChatStateChange?.(ns.getSideChatState());
  }

  ns.closeSideChatInstance = async function closeSideChatInstance(instanceTabId = '') {
    const rootId = String(instanceTabId || '').startsWith(ns.SIDECHAT_TAB_PREFIX) ? String(instanceTabId).slice(ns.SIDECHAT_TAB_PREFIX.length) : '';
    if (!rootId) {
      ns.closeSideChatDrawer({ deleteAll: false, notify: false });
      return;
    }
    const cids = ns.getInstanceSideChats(sideChatThreads, rootId).map((t) => t.cascadeId);
    if (!cids.includes(rootId)) cids.push(rootId);
    await deleteSideChatsByIds(cids, instanceTabId);
  };

  function reorderSideChatThreadsInInstance(rootId = '', movedCid = '', targetIndex = 0) {
    const inst = ns.getInstanceSideChats(sideChatThreads, rootId);
    const srcIdx = inst.findIndex((t) => t.cascadeId === movedCid);
    if (srcIdx < 0) return;
    const [moved] = inst.splice(srcIdx, 1);
    const adjIdx = Math.max(0, Math.min(inst.length, targetIndex > srcIdx ? targetIndex - 1 : targetIndex));
    inst.splice(adjIdx, 0, moved);
    const orderedInst = [...inst.filter((t) => t.pinned), ...inst.filter((t) => !t.pinned)];
    const instSet = new Set(orderedInst.map((t) => t.cascadeId));
    let k = 0;
    sideChatThreads = sideChatThreads.map((t) => (instSet.has(t.cascadeId) ? orderedInst[k++] : t));
  }

  ns.promoteSideChatToHangarBar = function promoteSideChatToHangarBar(dragPayload) {
    const cid = dragPayload?.cascadeId;
    if (!cid) return null;
    const srcTabId = dragPayload.instanceTabId || ns.SIDECHAT_TAB_ID;
    const srcRoot = srcTabId.startsWith(ns.SIDECHAT_TAB_PREFIX) ? srcTabId.slice(ns.SIDECHAT_TAB_PREFIX.length) : '';
    const instThreads = ns.getInstanceSideChats(sideChatThreads, srcRoot);
    const remaining = instThreads.filter((t) => t.cascadeId !== cid);
    if (srcRoot && !remaining.length) return { newSidecarId: srcTabId, replacedSidecarId: null };
    const newSidecarId = `${ns.SIDECHAT_TAB_PREFIX}${cid}`;
    poppedSideChatIds.add(cid);
    delete sideChatGroupMap[cid];
    ns.setActiveSideChatId(newSidecarId, cid);
    const vpEl = typeof document?.getElementById === 'function' ? document.getElementById('main-viewport') : null;
    const poppedBox = ensureSideChatBox(newSidecarId, vpEl || ns._sideChatBox?.parentElement || ns._sideChatBox?._toastRoot || document.body);
    poppedBox?._syncThreadsUi?.(cid, null);
    let replacedSidecarId = null;
    if (srcRoot && cid === srcRoot && remaining.length > 0) {
      const nextSrcRoot = remaining[0].cascadeId, nextSrcTabId = `${ns.SIDECHAT_TAB_PREFIX}${nextSrcRoot}`;
      const ordered = [...poppedSideChatIds].map((id) => (id === srcRoot ? nextSrcRoot : id));
      poppedSideChatIds.clear();
      ordered.forEach((id) => poppedSideChatIds.add(id));
      delete sideChatGroupMap[nextSrcRoot];
      for (const remTh of remaining.slice(1)) sideChatGroupMap[remTh.cascadeId] = nextSrcRoot;
      const b = sideChatBoxes.get(srcTabId);
      if (b) {
        sideChatBoxes.delete(srcTabId);
        sideChatBoxes.set(nextSrcTabId, b);
        b._setInstance(nextSrcTabId, nextSrcRoot);
        const nextAct = remaining[remaining.length - 1].cascadeId;
        activeSideChatByInstance.delete(srcTabId);
        ns.setActiveSideChatId(nextSrcTabId, nextAct);
        b._syncThreadsUi?.(nextAct, null);
      }
      replacedSidecarId = { from: srcTabId, to: nextSrcTabId };
    } else if (srcRoot) {
      const b = sideChatBoxes.get(srcTabId);
      const nextAct = remaining[remaining.length - 1]?.cascadeId || srcRoot;
      ns.setActiveSideChatId(srcTabId, nextAct);
      b?._syncThreadsUi?.(nextAct, null);
    } else {
      if (remaining.length > 0) {
        const nextMainId = remaining[remaining.length - 1].cascadeId;
        ns.setActiveSideChatId(ns.SIDECHAT_TAB_ID, nextMainId);
        sideChatBoxes.get(ns.SIDECHAT_TAB_ID)?._syncThreadsUi?.(nextMainId, null);
      } else {
        isSideChatOpen = false;
        sideChatBoxes.get(ns.SIDECHAT_TAB_ID)?.classList?.add?.('hidden');
        replacedSidecarId = { from: ns.SIDECHAT_TAB_ID, to: newSidecarId };
      }
    }
    return { newSidecarId, replacedSidecarId };
  };

  ns.demoteSideChatTabIntoInstance = function demoteSideChatTabIntoInstance(sourceSidecarId, dropTarget = {}) {
    const targetInstanceTabId = dropTarget.targetInstanceTabId || ns.SIDECHAT_TAB_ID;
    if (sourceSidecarId === targetInstanceTabId) return false;
    if (sourceSidecarId === ns.SIDECHAT_TAB_ID && String(targetInstanceTabId).startsWith(ns.SIDECHAT_TAB_PREFIX)) {
      return ns.demoteSideChatTabIntoInstance(targetInstanceTabId, { ...dropTarget, targetInstanceTabId: ns.SIDECHAT_TAB_ID });
    }
    if (!String(sourceSidecarId || '').startsWith(ns.SIDECHAT_TAB_PREFIX)) return false;
    const srcRoot = sourceSidecarId.slice(ns.SIDECHAT_TAB_PREFIX.length);
    const movingThreads = ns.getInstanceSideChats(sideChatThreads, srcRoot);
    const movingIds = movingThreads.map((t) => t.cascadeId);
    if (!movingIds.includes(srcRoot)) movingIds.unshift(srcRoot);
    poppedSideChatIds.delete(srcRoot);
    if (targetInstanceTabId === ns.SIDECHAT_TAB_ID) {
      for (const cid of movingIds) delete sideChatGroupMap[cid];
      for (const [k, v] of Object.entries(sideChatGroupMap)) { if (v === srcRoot) delete sideChatGroupMap[k]; }
      isSideChatOpen = true;
    } else if (targetInstanceTabId.startsWith(ns.SIDECHAT_TAB_PREFIX)) {
      const dstRoot = targetInstanceTabId.slice(ns.SIDECHAT_TAB_PREFIX.length);
      for (const cid of movingIds) {
        if (cid === dstRoot) delete sideChatGroupMap[cid];
        else sideChatGroupMap[cid] = dstRoot;
      }
    }
    if (typeof dropTarget.index === 'number') {
      const dstRoot = targetInstanceTabId.startsWith(ns.SIDECHAT_TAB_PREFIX) ? targetInstanceTabId.slice(ns.SIDECHAT_TAB_PREFIX.length) : '';
      for (let i = 0; i < movingIds.length; i++) reorderSideChatThreadsInInstance(dstRoot, movingIds[i], dropTarget.index + i);
    }
    const focCid = movingIds[0] || srcRoot;
    ns.setActiveSideChatId(targetInstanceTabId, focCid);
    const vpEl = typeof document?.getElementById === 'function' ? document.getElementById('main-viewport') : null;
    const dstBox = ensureSideChatBox(targetInstanceTabId, vpEl || ns._sideChatBox?.parentElement || ns._sideChatBox?._toastRoot || document.body);
    for (const cid of movingIds) {
      const f = framesByCascadeId.get(cid);
      if (f && f.parentElement !== dstBox) {
        f.classList?.toggle?.('hidden', cid !== focCid);
        dstBox?.appendChild?.(f);
      }
    }
    const oldBox = sideChatBoxes.get(sourceSidecarId);
    oldBox?.remove?.();
    sideChatBoxes.delete(sourceSidecarId);
    activeSideChatByInstance.delete(sourceSidecarId);
    dstBox?._syncThreadsUi?.(focCid, null);
    return true;
  };

  ns.mergeSideChatDragIntoInstance = function mergeSideChatDragIntoInstance(drag, dropTarget = {}) {
    if (!drag?.cascadeId || !dropTarget?.targetInstanceTabId || drag.instanceTabId === dropTarget.targetInstanceTabId) return null;
    const prom = ns.promoteSideChatToHangarBar(drag);
    if (!prom?.newSidecarId) return null;
    let finalTargetId = dropTarget.targetInstanceTabId, removedSidecarId = prom.newSidecarId, replacedSidecarId = prom.replacedSidecarId;
    ns.demoteSideChatTabIntoInstance(prom.newSidecarId, dropTarget);
    if (drag.instanceTabId === ns.SIDECHAT_TAB_ID && finalTargetId.startsWith(ns.SIDECHAT_TAB_PREFIX) && !ns.getInstanceSideChats(sideChatThreads, '').length) {
      ns.demoteSideChatTabIntoInstance(finalTargetId, { targetInstanceTabId: ns.SIDECHAT_TAB_ID, zone: 'strip' });
      ns.setActiveSideChatId(ns.SIDECHAT_TAB_ID, drag.cascadeId);
      sideChatBoxes.get(ns.SIDECHAT_TAB_ID)?._syncThreadsUi?.(drag.cascadeId, null);
      removedSidecarId = finalTargetId;
      replacedSidecarId = { from: finalTargetId, to: ns.SIDECHAT_TAB_ID };
      finalTargetId = ns.SIDECHAT_TAB_ID;
    }
    return { removedSidecarId, replacedSidecarId, targetInstanceTabId: finalTargetId, targetPane: dropTarget.pane || '' };
  };

  ns.inspectHangarPointerOverSideChat = function inspectHangarPointerOverSideChat(clientX, clientY, draggedSidecarId, checkShells = true) {
    document.querySelectorAll?.('.merge-drop-target, .drop-target').forEach((el) => el.classList?.remove('merge-drop-target', 'drop-target'));
    for (const shell of document.querySelectorAll?.('.term-quote-composer[data-instance-tab-id]') || []) {
      if (shell.dataset.instanceTabId !== draggedSidecarId) {
        shell.querySelectorAll?.('.agy-tab[data-cascade-id]:not(.is-dragging-source)').forEach((el) => ns.setTabShift?.(el, 0));
      }
    }
    if (!ns.isSideChatTabId(draggedSidecarId)) return null;
    const srcEl = document.querySelector?.(`.agy-tab[data-sidecar-id="${draggedSidecarId}"]`), srcR = srcEl ? (ns.getUnshiftedRect ? ns.getUnshiftedRect(srcEl) : srcEl.getBoundingClientRect()) : null;
    for (const el of document.querySelectorAll?.('.agy-tab[data-sidecar-id]') || []) {
      const sid = el.dataset.sidecarId, r = ns.getUnshiftedRect ? ns.getUnshiftedRect(el) : el.getBoundingClientRect();
      if (!sid || sid === draggedSidecarId || !ns.isSideChatTabId(sid) || r.width <= 0 || clientY < r.top - 18 || clientY > r.bottom + (!checkShells ? 18 : 4)) continue;
      const same = srcEl && srcEl.parentElement === el.parentElement, lPad = same && srcR && srcR.left < r.left ? 0 : r.width * 0.12, rPad = same && srcR && srcR.left > r.left ? 0 : r.width * 0.12;
      if (clientX >= r.left + lPad && clientX <= r.right - rPad) {
        el.classList.add('merge-drop-target');
        return { targetInstanceTabId: sid, zone: 'hub-tab', pane: el.dataset.pane || 'single' };
      }
    }
    if (!checkShells) return null;
    for (const shell of document.querySelectorAll?.('.term-quote-composer[data-instance-tab-id]') || []) {
      const targetInstanceTabId = shell.dataset.instanceTabId, sRect = shell.getBoundingClientRect();
      if (!targetInstanceTabId || targetInstanceTabId === draggedSidecarId || shell.classList?.contains?.('hidden') || sRect.width === 0 || clientX < sRect.left || clientX > sRect.right || clientY < sRect.top || clientY > sRect.bottom) continue;
      const pane = shell.dataset.slot || 'top', strip = shell.querySelector('.agy-tab-strip'), tRect = (shell.querySelector('.term-toolbar') || strip)?.getBoundingClientRect();
      shell.classList.add('drop-target'); strip?.classList.add('drop-target');
      const pills = Array.from(strip?.querySelectorAll('.agy-tab[data-cascade-id]') || []); let index = pills.length;
      if (tRect && clientY <= tRect.bottom + 10) {
        for (let i = 0; i < pills.length; i++) { const pr = ns.getUnshiftedRect ? ns.getUnshiftedRect(pills[i]) : pills[i].getBoundingClientRect(); if (clientX < pr.left + pr.width / 2) { index = i; break; } }
        pills.forEach((p, i) => ns.setTabShift?.(p, i >= index ? 68 : 0));
      }
      return { targetInstanceTabId, zone: 'strip', index, pane };
    }
    return null;
  };

  function ensureSideChatBox(instanceTabId, root) {
    let box = sideChatBoxes.get(instanceTabId) || (instanceTabId === ns.SIDECHAT_TAB_ID ? (root?._hangarQuoteComposer || ns._sideChatBox) : null);
    if (box) return box;
    let curTabId = instanceTabId;
    let curRootId = curTabId.startsWith(ns.SIDECHAT_TAB_PREFIX) ? curTabId.slice(ns.SIDECHAT_TAB_PREFIX.length) : '';
    let isRenaming = false;

    box = document.createElement('div');
    box.className = 'term-quote-composer';
    box.dataset = box.dataset || {};
    box.dataset.dockMode = 'docked';
    box.dataset.instanceTabId = curTabId;

    const hdr = document.createElement('div'); hdr.className = 'term-toolbar term-quote-composer-hdr';
    const sessionsEl = document.createElement('div'); sessionsEl.className = 'agy-tab-strip'; if (!sessionsEl.dataset) sessionsEl.dataset = {}; sessionsEl.dataset.role = 'sessions';
    sessionsEl.addEventListener?.('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && sessionsEl.scrollWidth > sessionsEl.clientWidth) { e.preventDefault?.(); sessionsEl.scrollLeft += e.deltaY; } }, { passive: false });

    const actionsEl = document.createElement('div'); actionsEl.className = 'term-toolbar-actions';
    const badge = document.createElement('span'); badge.className = 'term-quote-composer-badge hidden';
    const threadSelect = document.createElement('select'); threadSelect.className = 'term-sidechat-select hidden'; if (!threadSelect.dataset) threadSelect.dataset = {}; threadSelect.dataset.role = 'sidechat-select';
    const hint = document.createElement('span'); hint.className = 'term-quote-composer-hint hidden'; hint.textContent = 'Side Chat (tools enabled)';
    const backBtn = document.createElement('button'); backBtn.type = 'button'; backBtn.className = 'agy-btn agy-btn-outline term-sidechat-main-btn hidden'; if (!backBtn.dataset) backBtn.dataset = {}; backBtn.dataset.role = 'sidechat-back'; backBtn.title = 'Return to the active Side Chat thread'; backBtn.textContent = '↩ Back to Side Chat';
    const mainToggleBtn = document.createElement('button'); mainToggleBtn.type = 'button'; mainToggleBtn.className = 'agy-btn agy-btn-outline term-sidechat-main-btn hidden'; if (!mainToggleBtn.dataset) mainToggleBtn.dataset = {}; mainToggleBtn.dataset.role = 'sidechat-main-toggle'; mainToggleBtn.title = 'Send quoted output to the Main Conversation instead'; mainToggleBtn.textContent = 'Send to Main Chat';
    const newThreadBtn = document.createElement('button'); newThreadBtn.type = 'button'; newThreadBtn.className = 'agy-icon-btn hidden'; if (!newThreadBtn.dataset) newThreadBtn.dataset = {}; newThreadBtn.dataset.action = 'new'; newThreadBtn.dataset.role = 'sidechat-new'; newThreadBtn.title = 'New Side Chat'; newThreadBtn.innerHTML = ns.iconSvg?.('add', 16) || '+';
    const deleteBtn = document.createElement('button'); deleteBtn.type = 'button'; deleteBtn.className = 'agy-icon-btn hidden'; if (!deleteBtn.dataset) deleteBtn.dataset = {}; deleteBtn.dataset.action = 'kill'; deleteBtn.dataset.role = 'sidechat-delete'; deleteBtn.title = 'Delete Side Chat'; deleteBtn.innerHTML = ns.iconSvg?.('delete', 15) || '🗑';
    const overviewBtn = document.createElement('button'); overviewBtn.type = 'button'; overviewBtn.className = 'agy-icon-btn'; if (!overviewBtn.dataset) overviewBtn.dataset = {}; overviewBtn.dataset.action = 'overview'; overviewBtn.dataset.role = 'sidechat-overview'; overviewBtn.title = 'Toggle Overview Panel'; overviewBtn.innerHTML = ns.iconSvg?.('overview', 15) || '☰';
    const popoutBtn = document.createElement('button'); popoutBtn.type = 'button'; popoutBtn.className = 'agy-icon-btn'; if (!popoutBtn.dataset) popoutBtn.dataset = {}; popoutBtn.dataset.action = 'popout'; popoutBtn.dataset.role = 'sidechat-popout'; popoutBtn.title = curRootId ? 'Merge back into main Side Chat tab' : 'Pin Side Chat Tab to Top Bar'; popoutBtn.innerHTML = ns.iconSvg?.('dock_to_right', 14) || '⧉';
    const dockBtn = document.createElement('button'); dockBtn.type = 'button'; dockBtn.className = 'agy-icon-btn term-sidechat-btn hidden'; if (!dockBtn.dataset) dockBtn.dataset = {}; dockBtn.dataset.role = 'sidechat-dock';
    const closeBtn = document.createElement('button'); closeBtn.type = 'button'; closeBtn.className = 'term-quote-composer-close hidden'; closeBtn.textContent = '×';
    actionsEl.append?.(badge, backBtn, mainToggleBtn, newThreadBtn, deleteBtn, overviewBtn, popoutBtn, threadSelect, hint, dockBtn, closeBtn);
    hdr.append?.(sessionsEl, actionsEl);

    const mainBar = document.createElement('div'); mainBar.className = 'term-sidechat-main-bar hidden';
    const preview = document.createElement('pre'); preview.className = 'term-quote-composer-preview';
    const row = document.createElement('div'); row.className = 'term-quote-composer-row';
    const input = document.createElement('textarea'); input.className = 'term-quote-composer-input'; input.rows = 2;
    input.placeholder = 'Optional note for Main Chat… (Enter to send to Main Chat, Shift+Enter for new line)';
    const syncHeight = () => { if (input.style) { input.style.height = 'auto'; if (input.scrollHeight) input.style.height = `${Math.min(120, Math.max(38, input.scrollHeight))}px`; } };
    input.addEventListener?.('input', syncHeight);
    const sendBtn = document.createElement('button'); sendBtn.type = 'button'; sendBtn.className = 'agy-btn agy-btn-primary term-quote-composer-send'; sendBtn.textContent = 'Send to Main';
    row.append?.(input, sendBtn);
    mainBar.append?.(preview, row);

    const createFrame = (isInitial = false) => {
      const f = document.createElement('iframe');
      f.className = 'term-sidechat-frame';
      f._isInitialFrame = isInitial;
      if (!f.dataset) f.dataset = {};
      f.dataset.role = 'sidechat-frame';
      f.dataset.loadedCascadeId = '';
      f.addEventListener?.('load', () => {
        const te = ns.getLatestThemeEvent?.();
        if (te) try { f.contentWindow?.postMessage(te, '*'); } catch {}
        if (box._overviewOpen) {
          try { f.contentWindow?.postMessage({ type: 'hangar-sidechat-toggle-overview', open: true }, '*'); } catch {}
        }
        if (box._pendingQuote && f.dataset?.loadedCascadeId === ns.getActiveSideChatId(curTabId)) {
          const pq = box._pendingQuote;
          try { f.contentWindow?.postMessage({ type: 'hangar-inject-terminal-quote', payload: pq }, '*'); } catch {}
        }
      });
      return f;
    };
    const chatFrame = createFrame(true);
    chatFrame.classList?.add?.('hidden');

    box.append?.(hdr, mainBar, chatFrame);
    root?.appendChild?.(box);
    box._overviewOpen = false;
    box._els = { badge, preview, input, sendBtn, closeBtn, threadSelect, newThreadBtn, backBtn, mainToggleBtn, dockBtn, deleteBtn, overviewBtn, popoutBtn, sessionsEl, chatFrame, initialFrame: chatFrame, mainBar, hint };
    box._setInstance = (nextTabId, nextRootId) => {
      curTabId = nextTabId;
      curRootId = nextRootId;
      if (box.dataset) box.dataset.instanceTabId = curTabId;
      popoutBtn.title = curRootId ? 'Merge back into main Side Chat tab' : 'Pin Side Chat Tab to Top Bar';
      popoutBtn.classList?.toggle?.('active', Boolean(curRootId));
    };

    const spawnNewInInstance = async () => {
      box._payload = { cleanName: 'terminal', terminalId: '', selectionContent: '' };
      const thread = await ensureSideChatThread({ parentConversationId: box._convId || '', labelHint: '', forceNew: true, rootId: curRootId });
      if (thread?.cascadeId) box._syncThreadsUi(thread.cascadeId, null);
      onSideChatStateChange?.(ns.getSideChatState());
    };

    function startInlineRename(pill, t) {
      if (isRenaming || !t) return;
      const lbl = pill?._slots?.labelEl || pill?.querySelector?.('.agy-tab-label');
      if (!lbl) return;
      const renameFn = window.AgyUI?.startInlineRename || ns.startInlineRename;
      if (renameFn) {
        isRenaming = true;
        renameFn(pill, lbl, {
          initialValue: resolveSideChatTitle(t),
          inputClassName: 'agy-rename-input',
          onCommit: (rawNext) => {
            isRenaming = false;
            const next = String(rawNext || '').trim();
            ns.saveCustomSideChatTitle(t.cascadeId, next);
            if (next) ns.apiCall?.('/api/sidechat/rename', { cascadeId: t.cascadeId, title: next })?.catch?.(() => {});
            lbl.textContent = resolveSideChatTitle(t);
            renderSessionStrip();
            onSideChatStateChange?.(ns.getSideChatState());
          },
          onCancel: () => {
            isRenaming = false;
            lbl.textContent = resolveSideChatTitle(t);
            renderSessionStrip();
          },
        });
        return;
      }
      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'agy-rename-input'; inp.value = resolveSideChatTitle(t);
      let committed = false; isRenaming = true;
      const commit = (save) => {
        if (committed) return; committed = true; isRenaming = false;
        if (save) {
          const next = inp.value.trim();
          ns.saveCustomSideChatTitle(t.cascadeId, next);
          if (next) ns.apiCall?.('/api/sidechat/rename', { cascadeId: t.cascadeId, title: next })?.catch?.(() => {});
        }
        lbl.textContent = resolveSideChatTitle(t);
        inp.replaceWith?.(lbl);
        renderSessionStrip();
        onSideChatStateChange?.(ns.getSideChatState());
      };
      inp.addEventListener?.('keydown', (e) => { e.stopPropagation?.(); if (e.key === 'Enter') commit(true); else if (e.key === 'Escape') commit(false); });
      inp.addEventListener?.('blur', () => commit(true));
      ['pointerdown', 'click', 'dblclick'].forEach((ev) => inp.addEventListener?.(ev, (e) => e.stopPropagation?.()));
      lbl.replaceWith?.(inp); inp.focus?.(); inp.select?.();
    }

    const handlePopoutOrMerge = (targetCid = '') => {
      const instThreads = ns.getInstanceSideChats(sideChatThreads, curRootId);
      const actCid = targetCid || ns.getActiveSideChatId(curTabId) || instThreads[0]?.cascadeId || '';
      if (!actCid) return;
      if (curRootId) {
        const oldTabId = curTabId;
        ns.demoteSideChatTabIntoInstance(oldTabId, { targetInstanceTabId: ns.SIDECHAT_TAB_ID, zone: 'strip' });
        onSideChatStateChange?.({ ...ns.getSideChatState(), activateTab: true, targetTabId: ns.SIDECHAT_TAB_ID, removedSidecarId: oldTabId, replacedSidecarId: { from: oldTabId, to: ns.SIDECHAT_TAB_ID }, pane: box.dataset?.slot || '' });
      } else {
        const res = ns.promoteSideChatToHangarBar({ cascadeId: actCid, instanceTabId: curTabId });
        if (res?.newSidecarId) {
          onSideChatStateChange?.({ ...ns.getSideChatState(), activateTab: true, targetTabId: res.newSidecarId, replacedSidecarId: res.replacedSidecarId, afterTabId: curTabId, pane: box.dataset?.slot || '' });
        }
      }
    };

    function bindChatPillDrag(pill, t) {
      let activePointerId = null, startX = 0, startY = 0, isDragging = false, ghostEl = null, dragMeta = null, dropAction = null, hoverTimer = null, hoverTargetId = '', previewedTargetId = '';
      const clearHover = (resetPreview, slot) => {
        if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
        hoverTargetId = '';
        if (resetPreview && previewedTargetId) { previewedTargetId = ''; ns.getHangarDropCfg?.()?.onPreviewTerminalSlot?.('', slot); }
      };
      const endPointer = (e, cancelled = false) => {
        if (activePointerId !== e.pointerId) return;
        window.removeEventListener?.('pointerup', onWinPointerEnd, true); window.removeEventListener?.('pointercancel', onWinPointerCancel, true);
        const wasDragging = isDragging, finalAction = dropAction, slot = box.dataset?.slot || 'top', dropCfg = ns.getHangarDropCfg?.() || {};
        activePointerId = null; isDragging = false; dropAction = null; ns.isPointerOnTab = false; ns.pointerSideChatInstanceId = '';
        try { if (pill.hasPointerCapture?.(e.pointerId)) pill.releasePointerCapture(e.pointerId); } catch {}
        if (ghostEl) { ghostEl.remove?.(); ghostEl = null; }
        pill.classList?.remove?.('is-dragging-source', 'is-dragging');
        document.querySelectorAll?.('.agy-tab').forEach((n) => { n.classList?.remove?.('is-dragging-source'); ns.setTabShift?.(n, 0); });
        ns.clearAllTermDropIndicators?.();
        if (cancelled || !wasDragging || !finalAction) {
          clearHover(true, slot);
          if (!cancelled && !wasDragging) {
            pill.scrollIntoView?.({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
            if (ns.getActiveSideChatId(curTabId) !== t.cascadeId) {
              ns.setActiveSideChatId(curTabId, t.cascadeId);
              box._syncThreadsUi(t.cascadeId, null);
              onSideChatStateChange?.(ns.getSideChatState());
            }
          }
          return;
        }
        if (finalAction.type === 'same') {
          clearHover(true, slot);
          reorderSideChatThreadsInInstance(curRootId, t.cascadeId, finalAction.index);
          ns.setActiveSideChatId(curTabId, t.cascadeId);
          box._syncThreadsUi(t.cascadeId, null);
          onSideChatStateChange?.(ns.getSideChatState());
        } else if (finalAction.type === 'merge') {
          clearHover(false); previewedTargetId = '';
          const res = ns.mergeSideChatDragIntoInstance({ cascadeId: t.cascadeId, instanceTabId: curTabId }, finalAction.target);
          if (res) dropCfg.onMergeIntoTerminalTab?.(res); else dropCfg.onPreviewTerminalSlot?.('', slot);
        } else if (finalAction.type === 'promote') {
          clearHover(true, slot);
          const res = ns.promoteSideChatToHangarBar({ cascadeId: t.cascadeId, instanceTabId: curTabId });
          if (res?.newSidecarId) dropCfg.onPromoteToHangarTab?.({ sidecarId: res.newSidecarId, replacedSidecarId: res.replacedSidecarId, targetPane: finalAction.pane, beforeTabId: finalAction.beforeTabId });
        }
      };
      const onWinPointerEnd = (e) => endPointer(e, false), onWinPointerCancel = (e) => endPointer(e, true);
      pill.addEventListener?.('pointerdown', (e) => {
        if (e.button !== 0 || e.target?.closest?.('[data-close-cid], [data-pin-cid], .agy-tab-pin, [data-role="tab-pin"], [data-role="tab-close"], .agy-tab-close-wrap, .agy-rename-input')) return;
        ns.clearAllTermDropIndicators?.(); clearHover(false); previewedTargetId = ''; activePointerId = e.pointerId; ns.isPointerOnTab = true; ns.pointerSideChatInstanceId = curTabId;
        startX = e.clientX; startY = e.clientY; isDragging = false; ghostEl = null; dragMeta = null; dropAction = null;
        pill.setPointerCapture?.(e.pointerId);
        window.addEventListener?.('pointerup', onWinPointerEnd, true); window.addEventListener?.('pointercancel', onWinPointerCancel, true);
      });
      pill.addEventListener?.('pointermove', (e) => {
        if (activePointerId !== e.pointerId) return;
        const sourceSlot = box.dataset?.slot || 'top', dropCfg = ns.getHangarDropCfg?.() || {};
        if (!isDragging && Math.hypot(e.clientX - startX, e.clientY - startY) > 4) {
          isDragging = true; document.body?.classList?.add('dragging-tab');
          dragMeta = ns.measureStrip?.(sessionsEl, pill, startX, startY, '.agy-tab');
          if (dragMeta) {
            pill.classList?.add?.('is-dragging-source');
            ghostEl = pill.cloneNode(true); ghostEl.className = 'agy-tab active agy-tab-drag-ghost';
            ghostEl.style.width = `${dragMeta.draggedWidth}px`; ghostEl.style.height = `${dragMeta.draggedHeight}px`;
            document.body?.appendChild?.(ghostEl);
          }
        }
        if (!isDragging || !ghostEl || !dragMeta) return;
        document.querySelectorAll?.('.drop-target, .merge-drop-target, .split-drop-target').forEach((n) => n.classList?.remove('drop-target', 'merge-drop-target', 'split-drop-target'));
        document.querySelectorAll?.('.agy-tab').forEach((n) => ns.setTabShift?.(n, 0));
        const sRect = sessionsEl?.getBoundingClientRect?.() || { left: 0, right: 0, top: 0, bottom: 0 };
        const nextLocked = dragMeta.draggedIndex >= 0 && e.clientY >= sRect.top - 18 && e.clientY <= sRect.bottom + 18;
        if (nextLocked !== dragMeta.locked) { dragMeta.locked = nextLocked; dragMeta.lockChangedAt = Date.now(); }
        const rawLeft = e.clientX - dragMeta.grabOffsetX, left = dragMeta.locked ? Math.min(Math.max(rawLeft, dragMeta.minLeft), dragMeta.maxLeft) : rawLeft;
        ghostEl.style.transition = dragMeta.lockChangedAt && Date.now() - dragMeta.lockChangedAt < 120 ? 'top 120ms ease-out, left 120ms ease-out' : '';
        ghostEl.style.left = `${left}px`; ghostEl.style.top = `${dragMeta.locked ? dragMeta.originalTop : e.clientY - dragMeta.grabOffsetY}px`;
        if (dragMeta.locked) {
          clearHover(true, sourceSlot);
          if (sessionsEl.scrollWidth > sessionsEl.clientWidth) {
            if (e.clientX < sRect.left + 26) sessionsEl.scrollLeft -= 8;
            else if (e.clientX > sRect.right - 26) sessionsEl.scrollLeft += 8;
          }
          const x = e.clientX - dragMeta.grabOffsetX + dragMeta.draggedWidth / 2, scrollDelta = (sessionsEl.scrollLeft || 0) - dragMeta.startScrollLeft;
          const pinnedCount = dragMeta.sourceTabs.filter((el) => el.dataset?.pinned === 'true').length, isPin = pill.dataset?.pinned === 'true';
          let dropIdx = dragMeta.draggedIndex;
          for (let i = 0; i < dragMeta.centers.length; i++) {
            const c = dragMeta.centers[i] - scrollDelta, span = dragMeta.draggedWidth * 0.5;
            if (i < dragMeta.draggedIndex && x < c + span) dropIdx = Math.min(dropIdx, i);
            else if (i > dragMeta.draggedIndex && x > c - span) dropIdx = Math.max(dropIdx, i);
          }
          dropIdx = isPin ? Math.min(dropIdx, Math.max(0, pinnedCount - 1)) : Math.max(dropIdx, pinnedCount);
          dragMeta.sourceTabs.forEach((sib, i) => {
            if (i !== dragMeta.draggedIndex) ns.setTabShift?.(sib, (dragMeta.draggedIndex < dropIdx && i > dragMeta.draggedIndex && i <= dropIdx) ? -dragMeta.draggedSlot : (dragMeta.draggedIndex > dropIdx && i >= dropIdx && i < dragMeta.draggedIndex) ? dragMeta.draggedSlot : 0);
          });
          dropAction = { type: 'same', index: dropIdx > dragMeta.draggedIndex ? dropIdx + 1 : dropIdx };
          return;
        }
        dragMeta.sourceTabs.forEach((sib, i) => { if (i > dragMeta.draggedIndex) ns.setTabShift?.(sib, -dragMeta.draggedSlot); });
        const splitEnabled = Boolean(dropCfg.bottomBarEl && !dropCfg.bottomBarEl.classList.contains('hidden'));
        const mergeHit = ns.inspectHangarPointerOverSideChat(e.clientX, e.clientY, curTabId, true);
        if (mergeHit) {
          if (mergeHit.zone === 'hub-tab' && mergeHit.pane !== 'single' && mergeHit.pane !== sourceSlot && hoverTargetId !== mergeHit.targetInstanceTabId) {
            clearHover(false); hoverTargetId = mergeHit.targetInstanceTabId;
            hoverTimer = setTimeout(() => { hoverTimer = null; previewedTargetId = mergeHit.targetInstanceTabId; dropCfg.onPreviewTerminalSlot?.(mergeHit.targetInstanceTabId, mergeHit.pane); }, 350);
          } else if (mergeHit.zone !== 'hub-tab') clearHover(false);
          dropAction = { type: 'merge', target: mergeHit };
          return;
        }
        clearHover(true, sourceSlot);
        const cRect = dropCfg.chromeBarEl?.getBoundingClientRect?.(), bRect = splitEnabled ? dropCfg.bottomBarEl?.getBoundingClientRect?.() : null;
        const inChrome = Boolean(cRect && cRect.height > 0 && e.clientY >= cRect.top - 14 && e.clientY <= cRect.bottom + 4), inBottomBar = Boolean(bRect && bRect.height > 0 && e.clientY >= bRect.top - 14 && e.clientY <= bRect.bottom + 4);
        const hRect = splitEnabled ? document.getElementById('split-resize-handle')?.getBoundingClientRect?.() : null, pointerSlot = !splitEnabled ? 'top' : (e.clientY < (hRect ? hRect.top + hRect.height / 2 : window.innerHeight / 2) ? 'top' : 'bottom');
        if (inChrome || inBottomBar || (splitEnabled && pointerSlot !== sourceSlot)) {
          const pane = inChrome ? 'top' : inBottomBar ? 'bottom' : pointerSlot, tabs = Array.from(document.getElementById(pane === 'bottom' ? 'bottom-tab-strip' : 'tab-strip')?.querySelectorAll('.agy-tab[data-sidecar-id]') || []);
          let beforeTabId = null;
          if (inChrome || inBottomBar) {
            for (const tabEl of tabs) { const r = ns.getUnshiftedRect ? ns.getUnshiftedRect(tabEl) : tabEl.getBoundingClientRect(); if (beforeTabId === null && e.clientX < r.left + r.width * (ns.isSideChatTabId(tabEl.dataset.sidecarId) ? 0.12 : 0.5)) beforeTabId = tabEl.dataset.sidecarId; }
            let shifted = false; for (const sib of tabs) { if (sib.dataset.sidecarId === beforeTabId) shifted = true; ns.setTabShift?.(sib, shifted ? 72 : 0); }
          }
          (pane === 'bottom' ? dropCfg.bottomBarEl : dropCfg.chromeBarEl)?.classList.add('split-drop-target');
          if (splitEnabled && !inChrome && !inBottomBar) document.querySelector(pane === 'bottom' ? '.slot-bottom:not(.hidden)' : '.slot-top:not(.hidden)')?.classList.add('split-drop-target');
          dropAction = { type: 'promote', pane: splitEnabled ? pane : 'single', beforeTabId };
          return;
        }
        dropAction = null;
      });
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((evt) => pill.addEventListener?.(evt, (e) => endPointer(e, evt !== 'pointerup')));
    }

    function renderSessionStrip() {
      if (isRenaming || ns.pointerSideChatInstanceId === curTabId) return;
      const instThreads = ns.getInstanceSideChats(sideChatThreads, curRootId);
      const actCid = ns.getActiveSideChatId(curTabId) || instThreads[0]?.cascadeId || '';
      popoutBtn.classList?.toggle?.('active', Boolean(curRootId));
      popoutBtn.title = curRootId ? 'Merge back into main Side Chat tab' : 'Pin Side Chat Tab to Top Bar';
      const togglePin = (t) => {
        t.pinned = !t.pinned;
        sideChatThreads = [...sideChatThreads.filter((x) => x.pinned), ...sideChatThreads.filter((x) => !x.pinned)];
        renderSessionStrip();
        onSideChatStateChange?.(ns.getSideChatState());
      };
      const openChatPillMenu = (e, pill, t, idx) => {
        const isPinned = Boolean(t.pinned);
        const others = instThreads.filter((x) => x.cascadeId !== t.cascadeId && !x.pinned).map((x) => x.cascadeId);
        const right = instThreads.slice(idx + 1).filter((x) => !x.pinned).map((x) => x.cascadeId);
        ns.openTabContextMenu?.(e, [
          { id: isPinned ? 'unpin-tab' : 'pin-tab', label: isPinned ? 'Unpin Tab' : 'Pin Tab', onClick: () => togglePin(t) },
          { id: 'rename-tab', label: 'Rename Side Chat…', onClick: () => startInlineRename(pill, t) },
          { id: 'popout-tab', label: curRootId ? 'Merge into Main Side Chat Tab' : 'Pin Side Chat Tab to Top Bar', onClick: () => handlePopoutOrMerge(t.cascadeId) },
          { separator: true },
          { id: 'close-tab', label: 'Delete Side Chat', disabled: isPinned, onClick: () => deleteSideChatsByIds([t.cascadeId], curTabId) },
          { id: 'close-other-tabs', label: 'Delete Other Side Chats', disabled: !others.length, onClick: () => { ns.setActiveSideChatId(curTabId, t.cascadeId); deleteSideChatsByIds(others, curTabId); } },
          { id: 'close-tabs-to-the-right', label: 'Delete Side Chats to the Right', disabled: !right.length, onClick: () => deleteSideChatsByIds(right, curTabId) },
        ]);
      };
      if (window.AgyUI?.reconcileTabStrip) {
        const stripItems = instThreads.map((t, idx) => {
          const isCurrent = t.cascadeId === actCid, isPinned = Boolean(t.pinned), cleanTitle = resolveSideChatTitle(t);
          return {
            id: t.cascadeId,
            thread: t,
            idx,
            label: cleanTitle,
            icon: 'chat',
            iconSize: 15,
            active: isCurrent,
            pinned: isPinned,
            closable: !isPinned,
            closeTitle: 'Delete Side Chat',
            renamable: true,
            title: `${cleanTitle}${isPinned ? ' · Pinned' : ''} (Drag to reorder or move across Hangar, double-click to rename)`,
            dataset: { cascadeId: t.cascadeId, pinned: isPinned ? 'true' : 'false' },
          };
        });
        window.AgyUI.reconcileTabStrip(sessionsEl, stripItems, {
          idDatasetKey: 'cascadeId',
          closeTitle: 'Delete Side Chat',
          addButton: { role: 'sidechat-strip-add', title: 'New Side Chat', onClick: (e) => { e?.stopPropagation?.(); spawnNewInInstance(); } },
          onClose: (id) => deleteSideChatsByIds([id], curTabId),
          onUnpin: (_id, item) => togglePin(item.thread),
          onRenameStart: () => { isRenaming = true; },
          onRenameCancel: () => { isRenaming = false; },
          onRename: (_id, rawNext, item) => {
            isRenaming = false;
            const next = String(rawNext || '').trim();
            ns.saveCustomSideChatTitle(item.thread.cascadeId, next);
            if (next) ns.apiCall?.('/api/sidechat/rename', { cascadeId: item.thread.cascadeId, title: next })?.catch?.(() => {});
            renderSessionStrip();
            onSideChatStateChange?.(ns.getSideChatState());
          },
          onContextMenu: (_id, item, e, pill) => openChatPillMenu(e, pill, item.thread, item.idx),
          bindDrag: (pill, item) => bindChatPillDrag(pill, item.thread),
        });
        return;
      }
      ns.clear(sessionsEl);
      if (Array.isArray(sessionsEl.childNodes)) sessionsEl.childNodes.length = 0;
      instThreads.forEach((t, idx) => {
        const isCurrent = t.cascadeId === actCid, isPinned = Boolean(t.pinned), cleanTitle = resolveSideChatTitle(t);
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = `agy-tab${isCurrent ? ' active' : ''}`;
        if (!pill.dataset) pill.dataset = {};
        pill.dataset.pinned = isPinned ? 'true' : 'false';
        pill.dataset.cascadeId = t.cascadeId;
        pill.title = `${cleanTitle}${isPinned ? ' · Pinned' : ''} (Drag to reorder or move across Hangar, double-click to rename)`;
        const trailHtml = isPinned
          ? `<span class="agy-tab-pin" data-pin-cid="${ns.escHtml?.(t.cascadeId) || t.cascadeId}" title="Unpin Tab">${ns.iconSvg?.('keep', 16) || ''}</span>`
          : `<span class="agy-tab-close-wrap"><span class="agy-tab-close" data-close-cid="${ns.escHtml?.(t.cascadeId) || t.cascadeId}" title="Delete Side Chat">${ns.iconSvg?.('close', 14) || '×'}</span></span>`;
        pill.innerHTML = `<span class="agy-tab-icon">${ns.iconSvg?.('chat', 15) || ''}</span><span class="agy-tab-label">${ns.escHtml?.(cleanTitle) || cleanTitle}</span>${trailHtml}`;
        pill.querySelector?.('[data-close-cid]')?.addEventListener?.('click', (e) => { e.stopPropagation?.(); deleteSideChatsByIds([t.cascadeId], curTabId); });
        pill.querySelector?.('[data-pin-cid]')?.addEventListener?.('click', (e) => { e.stopPropagation?.(); togglePin(t); });
        pill.addEventListener?.('dblclick', (e) => { e.stopPropagation?.(); startInlineRename(pill, t); });
        pill.addEventListener?.('auxclick', (e) => { if (e.button === 1 && !isPinned) { e.preventDefault?.(); e.stopPropagation?.(); deleteSideChatsByIds([t.cascadeId], curTabId); } });
        pill.addEventListener?.('contextmenu', (e) => openChatPillMenu(e, pill, t, idx));
        bindChatPillDrag(pill, t);
        sessionsEl.appendChild?.(pill);
      });
      const addTabBtn = document.createElement('button');
      addTabBtn.type = 'button'; addTabBtn.className = 'agy-icon-btn agy-tab-add-btn'; if (!addTabBtn.dataset) addTabBtn.dataset = {}; addTabBtn.dataset.role = 'sidechat-strip-add'; addTabBtn.title = 'New Side Chat';
      addTabBtn.innerHTML = ns.iconSvg?.('add', 16) || '+';
      addTabBtn.addEventListener?.('click', (e) => { e.stopPropagation?.(); spawnNewInInstance(); });
      sessionsEl.appendChild?.(addTabBtn);
    }

    const hide = (closeOpts = {}) => ns.closeSideChatDrawer({ deleteAll: true, ...closeOpts });
    closeBtn.addEventListener?.('click', (e) => { e.stopPropagation?.(); hide(); });
    backBtn.addEventListener?.('click', (e) => {
      e.stopPropagation?.();
      backBtn.classList?.add?.('hidden');
      const actCid = ns.getActiveSideChatId(curTabId);
      if (actCid) {
        const f = framesByCascadeId.get(actCid) || box._els.chatFrame;
        if (f) {
          if (f.dataset) f.dataset.loadedCascadeId = actCid;
          f.src = buildChatFrameSrc(actCid);
        }
      }
    });
    mainToggleBtn.addEventListener?.('click', (e) => {
      e.stopPropagation?.();
      const nextShow = Boolean(mainBar.classList?.contains?.('hidden'));
      mainBar.classList?.toggle?.('hidden', !nextShow);
      mainToggleBtn.classList?.toggle?.('active', nextShow);
      if (nextShow) setTimeout(() => input.focus?.(), 10);
    });
    dockBtn.addEventListener?.('click', (e) => {
      e.stopPropagation?.();
      ns.setSideChatDocked(!isSideChatDocked, true);
    });
    newThreadBtn.addEventListener?.('click', (e) => { e.stopPropagation?.(); spawnNewInInstance(); });
    overviewBtn.addEventListener?.('click', (e) => {
      e.stopPropagation?.();
      box._overviewOpen = !box._overviewOpen;
      overviewBtn.classList?.toggle?.('active', box._overviewOpen);
      try { box._els.chatFrame?.contentWindow?.postMessage({ type: 'hangar-sidechat-toggle-overview', open: box._overviewOpen }, '*'); } catch {}
    });
    popoutBtn.addEventListener?.('click', (e) => { e.stopPropagation?.(); handlePopoutOrMerge(); });
    threadSelect.addEventListener?.('change', (e) => {
      e.stopPropagation?.();
      const nextId = threadSelect.value;
      if (nextId && nextId !== ns.getActiveSideChatId(curTabId)) {
        ns.setActiveSideChatId(curTabId, nextId);
        box._syncThreadsUi(nextId, null);
        onSideChatStateChange?.(ns.getSideChatState());
      }
    });
    deleteBtn.addEventListener?.('click', (e) => {
      e.stopPropagation?.();
      const actCid = ns.getActiveSideChatId(curTabId);
      if (!actCid) {
        ns.closeSideChatDrawer({ deleteAll: true, notify: true });
        return;
      }
      deleteSideChatsByIds([actCid], curTabId);
    });

    const submit = async () => {
      if (sendBtn.disabled) return;
      const cur = box._payload || { cleanName: 'terminal', terminalId: '', selectionContent: '' }, convId = box._convId || '';
      const msg = ns.formatTerminalAgentMessage(cur, input.value);
      sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
      try {
        const res = await ns.notifyAgent?.(msg, convId, `Terminal Quote: ${cur.cleanName}`);
        if (res?.ok === false) throw new Error(res.error || 'Could not send message to agent');
        input.value = ''; syncHeight(); mainBar.classList?.add?.('hidden'); mainToggleBtn.classList?.remove?.('active');
        ns.showTerminalQuoteToast(box._toastRoot || root, `Sent quote from "${cur.cleanName}" to Main Chat`);
      } catch (err) {
        ns.showTerminalQuoteToast(box._toastRoot || root, err?.message || 'Failed to send to Agent');
      } finally {
        sendBtn.disabled = false; sendBtn.textContent = 'Send to Main';
      }
    };
    sendBtn.addEventListener?.('click', (e) => { e.stopPropagation?.(); submit(); });
    input.addEventListener?.('keydown', (e) => {
      e.stopPropagation?.();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault?.(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault?.(); mainBar.classList?.add?.('hidden'); mainToggleBtn.classList?.remove?.('active'); }
    });

    box._syncThreadsUi = (targetCascadeId, quoteToInject) => {
      backBtn.classList?.add?.('hidden');
      ns.setActiveSideChatId(curTabId, targetCascadeId);
      const instThreads = ns.getInstanceSideChats(sideChatThreads, curRootId);
      threadSelect.innerHTML = instThreads.map((t) => `<option value="${ns.escHtml?.(t.cascadeId) || t.cascadeId}"${t.cascadeId === targetCascadeId ? ' selected' : ''}>${ns.escHtml?.(resolveSideChatTitle(t)) || resolveSideChatTitle(t)}</option>`).join('');
      threadSelect.value = targetCascadeId;
      const th = sideChatThreads.find((t) => t.cascadeId === targetCascadeId);
      if (quoteToInject && (quoteToInject.selectionContent || quoteToInject.terminalId)) {
        if (th) { th.hasActivity = true; th.quotePayload = quoteToInject; }
        box._pendingQuote = {
          terminalId: quoteToInject.terminalId || '',
          title: quoteToInject.cleanName || 'terminal',
          selectionContent: quoteToInject.selectionContent || '',
          promptText: quoteToInject.promptText || '',
          autoSubmit: Boolean(quoteToInject.autoSubmit),
        };
      }
      const activeQuote = th?.quotePayload || null;
      if (activeQuote) box._payload = activeQuote;
      const sel = String(activeQuote?.selectionContent || '').trim(), lines = sel ? sel.split(/\r?\n/) : [];
      badge.textContent = '';
      badge.classList?.add?.('hidden');
      mainToggleBtn.classList?.add?.('hidden');
      mainBar.classList?.add?.('hidden');
      mainToggleBtn.classList?.remove?.('active');
      preview.textContent = lines.slice(0, 3).join('\n') + (lines.length > 3 ? '\n…' : '');
      preview.classList?.toggle?.('hidden', !sel);

      renderSessionStrip();

      let targetFrame = framesByCascadeId.get(targetCascadeId);
      if (!targetFrame) {
        if (!chatFrame.dataset?.loadedCascadeId || chatFrame.dataset.loadedCascadeId === targetCascadeId) {
          targetFrame = chatFrame;
        } else {
          targetFrame = createFrame(false);
        }
        framesByCascadeId.set(targetCascadeId, targetFrame);
      }
      if (targetFrame.parentElement !== box && !box.contains?.(targetFrame)) box.appendChild?.(targetFrame);
      const allBoxFrames = new Set([chatFrame, ...framesByCascadeId.values(), ...(box.querySelectorAll?.('.term-sidechat-frame') || [])]);
      for (const f of allBoxFrames) {
        if (f === chatFrame || f.parentElement === box || box.contains?.(f)) {
          f.classList?.toggle?.('hidden', f !== targetFrame);
        }
      }
      box._els.chatFrame = targetFrame;
      const prevLoaded = targetFrame.dataset?.loadedCascadeId || '';
      if (prevLoaded !== targetCascadeId) {
        if (targetFrame.dataset) targetFrame.dataset.loadedCascadeId = targetCascadeId;
        targetFrame.src = buildChatFrameSrc(targetCascadeId);
      } else {
        try { targetFrame.contentWindow?.postMessage({ type: 'hangar-sidechat-toggle-overview', open: Boolean(box._overviewOpen) }, '*'); } catch {}
        if (box._pendingQuote) {
          try {
            targetFrame.contentWindow?.postMessage({ type: 'hangar-sidechat-quote-injected-req', payload: box._pendingQuote }, '*');
            targetFrame.contentWindow?.postMessage({ type: 'hangar-inject-terminal-quote', payload: box._pendingQuote }, '*');
          } catch {}
        }
      }
    };

    box._renderSessionStrip = renderSessionStrip;
    box._submit = submit; box._hide = hide;
    sideChatBoxes.set(curTabId, box);
    if (curTabId === ns.SIDECHAT_TAB_ID) {
      if (root) root._hangarQuoteComposer = box;
      ns._sideChatBox = box;
    }
    return box;
  }

  ns.openTerminalQuoteComposer = function openTerminalQuoteComposer(hostEl, rawPayload = {}, opts = {}) {
    const viewportEl = typeof document?.getElementById === 'function' ? document.getElementById('main-viewport') : null;
    const root = viewportEl || hostEl || document.body;
    if (!root || typeof document?.createElement !== 'function') return null;
    const hasQuote = Boolean(rawPayload && (rawPayload.selectionContent || rawPayload.terminalId || rawPayload.cleanName));
    const basePayload = hasQuote ? (rawPayload.cleanName ? rawPayload : ns.buildTerminalScopePayload(rawPayload)) : { cleanName: opts.title || 'terminal', terminalId: opts.terminalId || '', selectionContent: '' };
    const payload = { ...basePayload, promptText: String(rawPayload?.promptText || opts.promptText || ''), autoSubmit: Boolean(rawPayload?.autoSubmit ?? opts.autoSubmit) };
    const popOut = Boolean(opts.popOut);
    const existingTarget = opts.targetCascadeId ? sideChatThreads.find((t) => t.cascadeId === opts.targetCascadeId) : null;
    if (existingTarget) {
      const existingCid = existingTarget.cascadeId;
      const mappedRoot = sideChatGroupMap[existingCid];
      const rootId = poppedSideChatIds.has(existingCid) ? existingCid : (mappedRoot && poppedSideChatIds.has(mappedRoot) ? mappedRoot : '');
      const targetTabId = rootId ? `${ns.SIDECHAT_TAB_PREFIX}${rootId}` : ns.SIDECHAT_TAB_ID;
      const targetBox = ensureSideChatBox(targetTabId, root);
      if (hostEl && hostEl !== root) hostEl._hangarQuoteComposer = targetBox;
      targetBox._toastRoot = hostEl || root;
      targetBox._payload = payload;
      targetBox._convId = opts.conversationId || targetBox._convId || '';
      if (!rootId) {
        isSideChatOpen = true;
        isSideChatDocked = true;
        targetBox.dataset.dockMode = 'docked';
        targetBox.classList?.remove?.('hidden');
      }
      targetBox._syncThreadsUi?.(existingCid, hasQuote ? payload : null);
      onSideChatStateChange?.({ ...ns.getSideChatState(), activateTab: !opts.skipActivate, targetTabId, pane: opts.pane || '' });
      return targetBox;
    }
    const box = ensureSideChatBox(ns.SIDECHAT_TAB_ID, root);
    if (hostEl && hostEl !== root) hostEl._hangarQuoteComposer = box;
    box._toastRoot = hostEl || root;
    box._payload = payload;
    box._convId = opts.conversationId || box._convId || '';
    const sel = String(payload.selectionContent || '').trim(), lines = sel ? sel.split(/\r?\n/) : [];
    box._els.badge.textContent = '';
    box._els.badge.classList?.add?.('hidden');
    box._els.mainToggleBtn.classList?.add?.('hidden');
    box._els.mainBar.classList?.add?.('hidden');
    box._els.mainToggleBtn.classList?.remove?.('active');
    box._els.preview.textContent = lines.slice(0, 3).join('\n') + (lines.length > 3 ? '\n…' : '');
    box._els.preview.classList?.toggle?.('hidden', !sel);

    if (!popOut) {
      isSideChatOpen = true;
      isSideChatDocked = true;
      box.dataset.dockMode = 'docked';
      box.classList?.remove?.('hidden');
    }

    Promise.resolve(ensureSideChatThread({
      parentConversationId: box._convId,
      labelHint: hasQuote ? payload.cleanName : '',
      forceNew: Boolean(opts.forceNewThread || popOut),
      popOut,
      quotePayload: hasQuote ? payload : null,
    })).then((thread) => {
      if (thread?.cascadeId) {
        if (popOut) {
          const poppedTabId = `${ns.SIDECHAT_TAB_PREFIX}${thread.cascadeId}`;
          const poppedBox = ensureSideChatBox(poppedTabId, root);
          poppedBox._convId = box._convId;
          poppedBox._syncThreadsUi?.(thread.cascadeId, hasQuote ? payload : null);
          onSideChatStateChange?.({ ...ns.getSideChatState(), activateTab: !opts.skipActivate, targetTabId: poppedTabId, pane: opts.pane || '' });
        } else {
          box._syncThreadsUi?.(thread.cascadeId, hasQuote ? payload : null);
          onSideChatStateChange?.(ns.getSideChatState());
        }
      }
    });
    if (!popOut && !opts.skipActivate) onSideChatStateChange?.({ ...ns.getSideChatState(), activateTab: true, targetTabId: ns.SIDECHAT_TAB_ID, pane: opts.pane || '' });
    return box;
  };

  ns.openTerminalMiniComposer = function openTerminalMiniComposer(hostEl, rawPayload = {}, opts = {}) {
    const root = hostEl || document.body;
    if (!root || typeof document?.createElement !== 'function') return null;
    const isMac = /Mac|iPhone|iPad/i.test(navigator?.platform || '');
    const payload = rawPayload?.cleanName ? rawPayload : ns.buildTerminalScopePayload(rawPayload || {});
    let mini = root._hangarMiniComposer;
    if (!mini) {
      mini = document.createElement('div');
      mini.className = 'term-mini-composer';
      const hdr = document.createElement('div'); hdr.className = 'term-mini-header';
      const hdrLeft = document.createElement('div'); hdrLeft.className = 'term-mini-header-left';
      const badge = document.createElement('span'); badge.className = 'term-quote-composer-badge';
      const preview = document.createElement('pre'); preview.className = 'term-quote-composer-preview term-mini-preview';
      hdrLeft.append?.(badge, preview);
      const closeBtn = document.createElement('button'); closeBtn.type = 'button'; closeBtn.className = 'term-quote-composer-close term-mini-close'; closeBtn.title = 'Cancel (Esc)'; closeBtn.textContent = '×';
      hdr.append?.(hdrLeft, closeBtn);

      const input = document.createElement('textarea'); input.className = 'term-quote-composer-input term-mini-input'; input.rows = 2;
      input.placeholder = `Ask about this terminal output… (Enter to send to Main Chat, ${isMac ? '⌘+Enter' : 'Ctrl+Enter'} for Side Chat)`;
      const syncHeight = () => { if (input.style) { input.style.height = 'auto'; if (input.scrollHeight) input.style.height = `${Math.min(110, Math.max(36, input.scrollHeight))}px`; } };
      input.addEventListener?.('input', syncHeight);

      const footer = document.createElement('div'); footer.className = 'term-mini-footer';
      const hint = document.createElement('span'); hint.className = 'term-mini-hint'; hint.textContent = 'Esc to cancel · Shift+Enter for new line';
      const actions = document.createElement('div'); actions.className = 'term-mini-actions';
      const scSplit = document.createElement('div'); scSplit.className = 'term-mini-sidechat-split';
      const sideChatBtn = document.createElement('button'); sideChatBtn.type = 'button'; sideChatBtn.className = 'agy-btn agy-btn-outline term-mini-sidechat-btn';
      if (!sideChatBtn.dataset) sideChatBtn.dataset = {}; sideChatBtn.dataset.role = 'mini-ask-sidechat';
      const sideChatPickBtn = document.createElement('button'); sideChatPickBtn.type = 'button'; sideChatPickBtn.className = 'agy-btn agy-btn-outline term-mini-sidechat-pick';
      if (!sideChatPickBtn.dataset) sideChatPickBtn.dataset = {}; sideChatPickBtn.dataset.role = 'mini-pick-sidechat';
      sideChatPickBtn.title = 'Choose Side Chat thread (New Side Chat by default)';
      sideChatPickBtn.innerHTML = ns.iconSvg?.('expand_more', 14) || '▾';
      scSplit.append?.(sideChatBtn, sideChatPickBtn);

      const sendBtn = document.createElement('button'); sendBtn.type = 'button'; sendBtn.className = 'agy-btn agy-btn-primary term-mini-send-btn';
      if (!sendBtn.dataset) sendBtn.dataset = {}; sendBtn.dataset.role = 'mini-send-main';
      sendBtn.textContent = 'Send to Main ↵';
      actions.append?.(scSplit, sendBtn);
      footer.append?.(hint, actions);

      mini.append?.(hdr, input, footer);
      root.appendChild?.(mini);

      mini._targetCascadeId = '';
      const syncSideChatBtn = () => {
        const th = mini._targetCascadeId ? sideChatThreads.find((t) => t.cascadeId === mini._targetCascadeId) : null;
        if (!th) mini._targetCascadeId = '';
        const hasThreads = sideChatThreads.length > 0;
        sideChatPickBtn.classList?.toggle?.('hidden', !hasThreads);
        sideChatBtn.classList?.toggle?.('has-picker', hasThreads);
        const targetLabel = th ? `Ask in ${resolveSideChatTitle(th)}` : 'Ask in Side Chat';
        sideChatBtn.title = `${targetLabel} (${isMac ? '⌘+Enter' : 'Ctrl+Enter'})`;
        sideChatBtn.innerHTML = `<span>${ns.escHtml?.(targetLabel) || targetLabel}</span><span class="term-mini-kbd">${isMac ? '⌘↵' : 'Ctrl+↵'}</span>`;
      };
      mini._setTargetCascadeId = (cid = '') => {
        mini._targetCascadeId = String(cid || '');
        syncSideChatBtn();
        setTimeout(() => input.focus?.(), 10);
      };
      mini._hide = () => {
        mini.classList?.add?.('hidden');
      };
      mini._submitMain = async () => {
        if (sendBtn.disabled) return;
        const cur = mini._payload || { cleanName: 'terminal', terminalId: '', selectionContent: '' }, convId = mini._convId || '';
        const msg = ns.formatTerminalAgentMessage(cur, input.value);
        sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
        try {
          const res = await ns.notifyAgent?.(msg, convId, `Terminal Quote: ${cur.cleanName}`);
          if (res?.ok === false) throw new Error(res.error || 'Could not send message to agent');
          input.value = ''; syncHeight(); mini._hide();
          ns.showTerminalQuoteToast(mini._toastRoot || root, `Sent quote from "${cur.cleanName}" to Main Chat`);
        } catch (err) {
          ns.showTerminalQuoteToast(mini._toastRoot || root, err?.message || 'Failed to send to Agent');
        } finally {
          sendBtn.disabled = false; sendBtn.textContent = 'Send to Main ↵';
        }
      };
      mini._submit = mini._submitMain;
      mini._submitSideChat = (overrideTargetCid) => {
        const cur = mini._payload || { cleanName: 'terminal', terminalId: '', selectionContent: '' }, convId = mini._convId || '';
        const rawTarget = overrideTargetCid !== undefined ? String(overrideTargetCid || '') : mini._targetCascadeId;
        const validTarget = rawTarget && sideChatThreads.some((t) => t.cascadeId === rawTarget) ? rawTarget : '';
        const promptText = String(input.value || '').trim();
        input.value = ''; syncHeight(); mini._hide();
        return ns.openTerminalQuoteComposer(mini._toastRoot || root, {
          ...cur,
          promptText,
          autoSubmit: Boolean(promptText),
        }, {
          conversationId: convId,
          forceNewThread: !validTarget,
          targetCascadeId: validTarget,
        });
      };

      closeBtn.addEventListener?.('click', (e) => { e.stopPropagation?.(); mini._hide(); });
      sendBtn.addEventListener?.('click', (e) => { e.stopPropagation?.(); mini._submitMain(); });
      sideChatBtn.addEventListener?.('click', (e) => { e.stopPropagation?.(); mini._submitSideChat(); });
      sideChatPickBtn.addEventListener?.('click', (e) => {
        e.stopPropagation?.();
        const r = sideChatPickBtn.getBoundingClientRect?.() || { left: e.clientX || 120, top: e.clientY || 120 };
        const items = [
          {
            id: 'new-sidechat-target',
            icon: 'add',
            label: 'New Side Chat',
            checked: !mini._targetCascadeId,
            onClick: () => mini._setTargetCascadeId(''),
          },
        ];
        if (sideChatThreads.length > 0) {
          items.push({ separator: true });
          for (const t of sideChatThreads) {
            const ttl = resolveSideChatTitle(t);
            items.push({
              id: `target-${t.cascadeId}`,
              icon: 'chat',
              label: ttl,
              checked: mini._targetCascadeId === t.cascadeId,
              onClick: () => mini._setTargetCascadeId(t.cascadeId),
            });
          }
        }
        ns.openTabContextMenu?.({ clientX: r.left, clientY: Math.max(24, (r.top || 120) - 8), preventDefault() {}, stopPropagation() {} }, items);
      });
      input.addEventListener?.('keydown', (e) => {
        e.stopPropagation?.();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault?.(); mini._submitSideChat(); }
        else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault?.(); mini._submitMain(); }
        else if (e.key === 'Escape') { e.preventDefault?.(); mini._hide(); }
      });

      mini._els = { badge, preview, input, sendBtn, sideChatBtn, sideChatPickBtn, closeBtn, hint };
      mini._syncSideChatBtn = syncSideChatBtn;
      root._hangarMiniComposer = mini;
    }

    mini._toastRoot = root;
    mini._payload = payload;
    mini._convId = opts.conversationId || mini._convId || '';
    mini._targetCascadeId = '';
    mini._syncSideChatBtn?.();

    const sel = String(payload.selectionContent || '').trim(), lines = sel ? sel.split(/\r?\n/) : [];
    mini._els.badge.textContent = `@${payload.cleanName || 'terminal'}${lines.length ? ` (${lines.length} line${lines.length === 1 ? '' : 's'})` : ''}`;
    mini._els.preview.textContent = lines.slice(0, 3).join('\n') + (lines.length > 3 ? '\n…' : '');
    mini._els.preview.classList?.toggle?.('hidden', !sel);
    mini.classList?.remove?.('hidden');
    setTimeout(() => mini._els.input.focus?.(), 10);
    return mini;
  };

  ns.renderSideChatSlot = function renderSideChatSlot({ viewportEl, topSlotId, bottomSlotId, splitEnabled } = {}) {
    const isScSlot = (slotId) => Boolean(ns.isSideChatTabId(slotId) && (slotId !== ns.SIDECHAT_TAB_ID || isSideChatOpen));
    const topActive = isScSlot(topSlotId);
    const botActive = Boolean(splitEnabled && bottomSlotId && bottomSlotId !== topSlotId && isScSlot(bottomSlotId));
    if (topActive && viewportEl) ensureSideChatBox(topSlotId, viewportEl);
    if (botActive && viewportEl) ensureSideChatBox(bottomSlotId, viewportEl);
    for (const [tabId, box] of sideChatBoxes.entries()) {
      const inTop = Boolean(topActive && tabId === topSlotId);
      const inBot = Boolean(botActive && tabId === bottomSlotId);
      const isVisible = inTop || inBot;
      if (viewportEl && !viewportEl.contains?.(box)) viewportEl.appendChild?.(box);
      box.dataset.dockMode = 'docked';
      box.dataset.slot = inBot ? 'bottom' : 'top';
      box.classList?.toggle?.('slot-top', inTop);
      box.classList?.toggle?.('slot-bottom', inBot);
      box.classList?.toggle?.('hidden', !isVisible);
      if (isVisible) {
        const rId = tabId.startsWith(ns.SIDECHAT_TAB_PREFIX) ? tabId.slice(ns.SIDECHAT_TAB_PREFIX.length) : '';
        const instThreads = ns.getInstanceSideChats(sideChatThreads, rId);
        const actCid = ns.getActiveSideChatId(tabId) || instThreads[0]?.cascadeId || rId;
        if (actCid && box._els?.chatFrame?.dataset?.loadedCascadeId !== actCid) {
          box._syncThreadsUi?.(actCid, null);
        } else {
          box._renderSessionStrip?.();
        }
      }
      if (tabId !== ns.SIDECHAT_TAB_ID && !poppedSideChatIds.has(tabId.slice(ns.SIDECHAT_TAB_PREFIX.length))) {
        box.remove?.();
        sideChatBoxes.delete(tabId);
      }
    }
  };

  ns.setSideChatDocked = function setSideChatDocked(docked, notify = true) {
    const nextDocked = Boolean(docked), dockToggled = nextDocked !== isSideChatDocked;
    isSideChatDocked = nextDocked;
    if (isSideChatDocked) isSideChatOpen = true;
    const box = ns._sideChatBox;
    if (box) {
      box.dataset.dockMode = isSideChatDocked ? 'docked' : 'floating';
      if (box.style) {
        if (isSideChatDocked) {
          box._floatingHeight = box.style.height || '';
          box.style.height = '';
        } else if (box._floatingHeight !== undefined) {
          box.style.height = box._floatingHeight;
        }
      }
      box._els?.dockBtn?.classList?.toggle?.('active', isSideChatDocked);
      if (box._els?.dockBtn) box._els.dockBtn.title = isSideChatDocked ? 'Undock to Floating Drawer' : 'Dock Side Chat to Bottom Split';
      if (isSideChatOpen) box.classList?.remove?.('hidden');
    }
    if (notify) onSideChatStateChange?.({ ...ns.getSideChatState(), dockToggled });
  };

  ns.closeSideChatDrawer = function closeSideChatDrawer({ deleteAll = true, notify = true } = {}) {
    if (deleteAll) {
      ++sideChatGeneration;
      sideChatCounter = 0;
      startInFlight = null;
      for (const t of sideChatThreads) {
        disposeThreadFrame(t.cascadeId);
        ns.saveCustomSideChatTitle(t.cascadeId, '');
        ns.apiCall?.('/api/terminal/sidechat/delete', { cascadeId: t.cascadeId })?.catch?.(() => {});
      }
      sideChatThreads = [];
      activeSideChatId = '';
      poppedSideChatIds.clear();
      for (const k of Object.keys(sideChatGroupMap)) delete sideChatGroupMap[k];
      activeSideChatByInstance.clear();
      for (const [tabId, box] of sideChatBoxes.entries()) {
        if (tabId !== ns.SIDECHAT_TAB_ID) {
          box.remove?.();
          sideChatBoxes.delete(tabId);
        }
      }
      if (ns._sideChatBox?._els?.sessionsEl) ns._sideChatBox._els.sessionsEl.innerHTML = '';
      if (ns._sideChatBox?._els?.chatFrame) {
        const cf = ns._sideChatBox._els.chatFrame;
        if (cf.dataset) cf.dataset.loadedCascadeId = '';
        cf.src = 'about:blank';
      }
    }
    isSideChatOpen = false;
    ns._sideChatBox?.classList?.add?.('hidden');
    if (notify) onSideChatStateChange?.({ ...ns.getSideChatState(), closedTab: true });
  };

  ns.toggleTerminalSideChat = function toggleTerminalSideChat(hostEl, opts = {}) {
    if (isSideChatOpen && ns._sideChatBox && !ns._sideChatBox.classList?.contains?.('hidden')) {
      ns.closeSideChatDrawer({ deleteAll: true, notify: true });
      return false;
    }
    ns.openTerminalQuoteComposer(hostEl, {}, opts);
    return true;
  };

  window.addEventListener?.('message', (e) => {
    if (e.data?.type === 'hangar-sidechat-quote-injected') {
      const cid = e.data.payload?.cascadeId;
      const th = sideChatThreads.find((t) => t.cascadeId === cid);
      if (th) th.hasActivity = true;
      for (const box of sideChatBoxes.values()) {
        if (box._pendingQuote) box._pendingQuote = null;
      }
    } else if (e.data?.type === 'hangar-sidechat-open-terminal') {
      const cid = e.data.payload?.cascadeId;
      const mappedRoot = cid ? sideChatGroupMap[cid] : '';
      const rootId = cid && poppedSideChatIds.has(cid) ? cid : (mappedRoot && poppedSideChatIds.has(mappedRoot) ? mappedRoot : '');
      const tabId = rootId ? `${ns.SIDECHAT_TAB_PREFIX}${rootId}` : ns.SIDECHAT_TAB_ID;
      const box = sideChatBoxes.get(tabId);
      if (box) {
        box._overviewOpen = false;
        box._els?.overviewBtn?.classList?.remove?.('active');
      }
      const pane = box?.dataset?.slot === 'bottom' ? 'bottom' : 'top';
      onSideChatStateChange?.({ ...ns.getSideChatState(), openTerminal: true, pane, sourceTabId: tabId });
    } else if (e.data?.type === 'hangar-sidechat-overview-state') {
      const cid = e.data.payload?.cascadeId;
      for (const [tabId, box] of sideChatBoxes.entries()) {
        if (!cid || ns.getActiveSideChatId(tabId) === cid) {
          box._overviewOpen = Boolean(e.data.payload?.open);
          box._els?.overviewBtn?.classList?.toggle?.('active', box._overviewOpen);
        }
      }
    } else if (e.data?.type === 'hangar-sidechat-foreign-nav') {
      const expected = e.data.payload?.expectedCascadeId;
      for (const [tabId, box] of sideChatBoxes.entries()) {
        if (!expected || ns.getActiveSideChatId(tabId) === expected) {
          box._els?.backBtn?.classList?.remove?.('hidden');
        }
      }
    } else if (e.data?.type === 'hangar-sidechat-switch-cascade') {
      const targetCid = e.data.payload?.cascadeId;
      const th = sideChatThreads.find((t) => t.cascadeId === targetCid);
      if (th) {
        const mappedRoot = sideChatGroupMap[targetCid];
        const rootId = poppedSideChatIds.has(targetCid) ? targetCid : (mappedRoot && poppedSideChatIds.has(mappedRoot) ? mappedRoot : '');
        const tabId = rootId ? `${ns.SIDECHAT_TAB_PREFIX}${rootId}` : ns.SIDECHAT_TAB_ID;
        ns.setActiveSideChatId(tabId, targetCid);
        sideChatBoxes.get(tabId)?._syncThreadsUi?.(targetCid, null);
        onSideChatStateChange?.({ ...ns.getSideChatState(), activateTab: true, targetTabId: tabId });
      }
    }
  });

  ns.createQuotePopupController = function createQuotePopupController(firstArg = {}, secondArg = {}) {
    const isDomArg = firstArg && typeof firstArg.appendChild === 'function' && !firstArg.containerEl;
    const opts = isDomArg ? secondArg : (firstArg || {});
    const hostEl = isDomArg ? firstArg : (opts.containerEl || document.body);
    const resolveMeta = () => {
      if (typeof opts.getTerminalMeta === 'function') return opts.getTerminalMeta() || {};
      return {
        terminalId: typeof opts.getTerminalId === 'function' ? opts.getTerminalId() : (opts.terminalId || ''),
        title: typeof opts.getTitle === 'function' ? opts.getTitle() : (opts.title || 'terminal'),
        conversationId: opts.conversationId || '',
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
    const askBtn = document.createElement('button');
    askBtn.type = 'button';
    askBtn.className = 'term-quote-btn term-quote-ask-btn';
    askBtn.title = 'Open tool-enabled Side Chat with this selection (or send to Main Chat)';
    askBtn.innerHTML = `<span class="term-quote-label">Quote & Ask</span>`;
    popup.appendChild?.(quoteBtn);
    popup.appendChild?.(askBtn);
    hostEl?.appendChild?.(popup);

    let activeSelection = null;
    let toastRoot = hostEl;

    function currentPayload() {
      const meta = resolveMeta();
      return ns.buildTerminalScopePayload({
        terminalId: meta.terminalId || '',
        title: meta.title || 'terminal',
        selectionContent: activeSelection?.text || '',
        quoteFileUri: activeSelection?.quoteFileUri || '',
      });
    }

    const stageHostQuote = () => {
      if (!activeSelection?.text?.trim()) return;
      const meta = resolveMeta();
      ns.apiCall?.('/api/terminal/ls-rpc', { method: 'WriteQuoteFile', conversationId: meta.conversationId || '', terminalId: meta.terminalId || '', name: meta.title || 'terminal', selectionContent: activeSelection.text })?.catch?.(() => {});
    };
    ns.bindTerminalDragSource(quoteBtn, currentPayload);
    quoteBtn.addEventListener('mousedown', (e) => { e.stopPropagation(); stageHostQuote(); });
    quoteBtn.addEventListener('dragstart', () => stageHostQuote());
    quoteBtn.addEventListener('dragend', (e) => {
      const meta = resolveMeta(), payload = ns.copyTerminalQuoteToClipboard(currentPayload());
      const cx = Number(e?.clientX) || 0, cy = Number(e?.clientY) || 0, winW = Number(window.innerWidth) || 0, winH = Number(window.innerHeight) || 0;
      if (payload.selectionContent) {
        for (const scBox of sideChatBoxes.values()) {
          if (!scBox.classList?.contains?.('hidden')) {
            const sRect = scBox.getBoundingClientRect?.() || { left: 0, top: 0, right: 0, bottom: 0 };
            if (cx >= sRect.left && cx <= sRect.right && cy >= sRect.top && cy <= sRect.bottom) {
              try { scBox._els?.chatFrame?.contentWindow?.postMessage({ type: 'hangar-inject-terminal-quote', payload }, '*'); } catch {}
            }
          }
        }
      }
      if (payload.selectionContent && (cx < 0 || cy < 0 || (winW > 0 && cx > winW) || (winH > 0 && cy > winH)) && !(cx === 0 && cy === 0)) {
        ns.apiCall?.('/api/terminal/ls-rpc', { method: 'InjectQuoteDrop', conversationId: meta.conversationId || '', terminalId: payload.terminalId, title: payload.cleanName, selectionContent: payload.selectionContent })?.catch?.(() => {});
      }
      popup.classList?.add?.('hidden'); activeSelection = null; window.getSelection?.()?.removeAllRanges?.(); opts.onQuoted?.(payload);
    });
    askBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    const finishSelection = (askAgent = false) => {
      if (!activeSelection?.text) return null;
      const text = activeSelection.text, meta = resolveMeta();
      const payload = ns.copyTerminalQuoteToClipboard(currentPayload());
      popup.classList?.add?.('hidden');
      activeSelection = null;
      window.getSelection?.()?.removeAllRanges?.();
      if (askAgent) {
        ns.openTerminalMiniComposer(toastRoot, payload, { conversationId: meta.conversationId || '' });
      } else {
        ns.showTerminalQuoteToast(toastRoot, `Quoted "${payload.cleanName}" (${text.split('\n').length} line${text.includes('\n') ? 's' : ''}) — press ${isMac ? '⌘V' : 'Ctrl+V'} in chat`);
      }
      opts.onQuoted?.(payload);
      return payload;
    };
    quoteBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); finishSelection(false); });
    askBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); finishSelection(true); });

    const ctrl = {
      show(selInfo) {
        if (!selInfo?.text?.trim()) {
          activeSelection = null;
          popup.classList?.add?.('hidden');
          return;
        }
        activeSelection = selInfo;
        const meta = resolveMeta();
        ns.apiCall?.('/api/terminal/ls-rpc', { method: 'WriteQuoteFile', conversationId: meta.conversationId || '', terminalId: meta.terminalId || '', name: meta.title || 'terminal', selectionContent: selInfo.text })?.then?.((r) => { if (r?.uri && activeSelection === selInfo) activeSelection.quoteFileUri = r.uri; })?.catch?.(() => {});
        popup.classList?.remove?.('hidden');
        const rect = hostEl?.getBoundingClientRect?.() || { left: 0, top: 0, width: 300, height: 200 };
        const popRect = popup.getBoundingClientRect?.() || {};
        const popW = Math.max(215, Number(popRect.width) || Number(popup.offsetWidth) || 215);
        const popH = Math.max(32, Number(popRect.height) || Number(popup.offsetHeight) || 32);
        const x = Math.max(8, Math.min((rect.width || 300) - popW - 8, (selInfo.clientX || rect.left + 40) - rect.left));
        const rawY = (selInfo.clientY || rect.top + 40) - rect.top;
        const y = rawY + popH + 12 > (rect.height || 200) ? Math.max(8, rawY - popH - 6) : rawY + 12;
        popup.style.left = `${Math.round(x)}px`;
        popup.style.top = `${Math.round(y)}px`;
      },
      hide() {
        activeSelection = null;
        popup.classList?.add?.('hidden');
      },
      triggerQuote(text, askAgent = false) {
        const trimmed = String(text ?? activeSelection?.text ?? window.getSelection?.()?.toString?.() ?? '').trim();
        if (!trimmed) return null;
        activeSelection = { text: trimmed };
        return finishSelection(askAgent);
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
