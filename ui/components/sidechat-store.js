/** @fileoverview Side Chat thread state, workspace hydration, and native Side Question annotation sync. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  ns.SIDECHAT_TAB_ID = '__sidechat__';
  const LEGACY_SIDECHAT_TAB_PREFIX = 'sidechat__';
  ns.isSideChatTabId = (tabId = '') => tabId === ns.SIDECHAT_TAB_ID;
  const normScTabId = ns.normalizeLegacySideChatTabId || ((id = '') => (
    String(id || '').startsWith(LEGACY_SIDECHAT_TAB_PREFIX) ? ns.SIDECHAT_TAB_ID : String(id || '')
  ));

  const CUSTOM_TITLES_KEY = 'hangar.sideChatCustomTitles';
  const LEGACY_SIDECHAT_ID_RE = /^sidechat-\d+-\d+$/;
  const PENDING_RENAME_TTL_MS = 8_000;
  const genSideChatUuid = () => (
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        })
  );
  const sc = (ns._sc = {
    threads: [],
    activeId: '',
    counter: 0,
    generation: 0,
    hydrated: false,
    hydratedWsKey: null,
    isOpen: false,
    isDocked: true,
    onStateChange: null,
    startInFlight: null,
    pendingRenames: new Map(),
    boxes: new Map(),
    frames: new Map(),
  });
  ns.sideChatStore = {
    state: sc,
    getState: () => sc,
    getBox: (tabId = ns.SIDECHAT_TAB_ID) => sc.boxes.get(tabId),
    setBox: (tabId, box) => sc.boxes.set(tabId, box),
    deleteBox: (tabId) => sc.boxes.delete(tabId),
    getBoxes: () => sc.boxes,
    getFrame: (cid) => sc.frames.get(cid),
    setFrame: (cid, frame) => sc.frames.set(cid, frame),
    deleteFrame: (cid) => sc.frames.delete(cid),
    getFrames: () => sc.frames,
    getThreads: () => sc.threads,
    markThreadActivity: (cid, active = true) => {
      const th = sc.threads.find((t) => t.cascadeId === cid);
      if (th) {
        th.hasActivity = Boolean(active);
      }
      return th;
    },
  };

  ns._bindAutoTextarea = function bindAutoTextarea(input, minH = 38, maxH = 120) {
    const sync = () => {
      if (input.style) {
        input.style.height = 'auto';
      }
      if (input.style && input.scrollHeight) {
        input.style.height = `${Math.min(maxH, Math.max(minH, input.scrollHeight))}px`;
      }
    };
    input.addEventListener?.('input', sync);
    return sync;
  };

  ns._submitQuoteToMain = async function submitQuoteToMain(hostObj, root, sendBtn, idleLabel, input, syncH, onDone) {
    if (sendBtn.disabled) return;
    const cur = hostObj._payload || { cleanName: 'terminal', terminalId: '', selectionContent: '' };
    Object.assign(sendBtn, { disabled: true, textContent: 'Sending…' });
    try {
      const rawConv = hostObj._convId || '';
      const convId = rawConv === '_new' ? '' : rawConv;
      const wsPath = hostObj._workspace || ns.getActiveWorkspacePath?.() || '';
      const res = await ns.notifyAgent?.(
        ns.formatTerminalAgentMessage(cur, input.value),
        convId,
        `Terminal Quote: ${cur.cleanName}`,
        wsPath ? { workspace: wsPath } : {}
      );
      if (res?.ok === false) {
        throw new Error(res.error || 'Could not send message to agent');
      }
      input.value = '';
      syncH();
      onDone?.();
      ns.showTerminalQuoteToast(hostObj._toastRoot || root, `Sent quote from "${cur.cleanName}" to Main Chat`);
    } catch (err) {
      ns.showTerminalQuoteToast(hostObj._toastRoot || root, err?.message || 'Failed to send to Agent', true);
    }
    Object.assign(sendBtn, { disabled: false, textContent: idleLabel });
  };

  ns.readCustomSideChatTitles = () => {
    try {
      return JSON.parse(localStorage.getItem(CUSTOM_TITLES_KEY) || '{}') || {};
    } catch {
      return {};
    }
  };
  ns.saveCustomSideChatTitle = (cid, title) => {
    const m = ns.readCustomSideChatTitles();
    if (title) {
      m[cid] = title;
    } else {
      delete m[cid];
    }
    try {
      localStorage.setItem(CUSTOM_TITLES_KEY, JSON.stringify(m));
    } catch {
      /* ignore */
    }
  };

  ns.recordSideChatRename = (cid, rawTitle) => {
    if (!cid) return;
    const next = String(rawTitle || '').replace(/\s+/g, ' ').trim();
    ns.saveCustomSideChatTitle(cid, next);
    const th = sc.threads.find((t) => t.cascadeId === cid);
    if (next) {
      if (th) th.title = next;
      sc.pendingRenames.set(cid, { title: next, ts: Date.now() });
    } else {
      sc.pendingRenames.delete(cid);
      if (th && th._lastNativeTitle) {
        th.title = th._lastNativeTitle;
      }
    }
  };

  ns.resolveSideChatTitle = (t) =>
    t ? (ns.readCustomSideChatTitles()[t.cascadeId] || t.title || 'Side Chat') : 'Side Chat';

  ns.getActiveSideChatId = () => sc.activeId;
  ns.setActiveSideChatId = (first = '', second) => {
    sc.activeId = String((second === undefined ? first : second) || '');
  };
  ns.getInstanceSideChats = (all = sc.threads) => all;

  ns.serializeSideChatState = () => ({
    isOpen: Boolean(sc.isOpen),
    isDocked: Boolean(sc.isDocked),
    activeCascadeId: String(sc.activeId || ''),
    sideChatCounter: Number(sc.counter) || 0,
    threads: sc.threads.map((t) => ({
      cascadeId: String(t.cascadeId || ''),
      title: String(t.title || 'Side Chat'),
      parentConversationId: String(t.parentConversationId || ''),
      pinned: Boolean(t.pinned),
      ...(t.nativeLinked ? { nativeLinked: true } : {}),
    })),
    customTitles: ns.readCustomSideChatTitles(),
  });

  ns.hydrateSideChatStateFromLayout = (layout = {}, workspacePath = '', conversationId = '') => {
    const wsKey = String(workspacePath || '').trim().replace(/\\/g, '/').toLowerCase();
    const convKey = String(conversationId || '').trim();
    const scopeKey = wsKey || (convKey ? `conv:${convKey}` : '');
    const hasWsMap = Boolean(layout?.sideChatStateByWorkspace && typeof layout.sideChatStateByWorkspace === 'object');
    if (sc.hydrated && sc.hydratedWsKey === scopeKey && (scopeKey || !hasWsMap)) return;
    const unpersisted = sc.threads.filter(
      (t) =>
        t?._unpersisted &&
        (!t._createdWsKey ||
          t._createdWsKey === scopeKey ||
          (convKey && t._createdWsKey === `conv:${convKey}`) ||
          sc.startInFlight ||
          sc._pendingOpen)
    );
    const hadPendingOpen = Boolean(sc._pendingOpen || sc.startInFlight || (unpersisted.length > 0 && sc.isOpen));
    const prevActiveId = sc.activeId;
    Object.assign(sc, {
      hydrated: true,
      hydratedWsKey: scopeKey,
      threads: [],
      activeId: '',
      counter: 0,
      isOpen: false,
    });
    sc.pendingRenames.clear();
    const raw = scopeKey
      ? layout?.sideChatStateByWorkspace?.[scopeKey]
      : (!hasWsMap ? layout?.sideChatState : null);
    const legacyIdMap = new Map();
    const normCid = (rawId) => {
      const id = String(rawId || '');
      if (!LEGACY_SIDECHAT_ID_RE.test(id)) return id;
      if (!legacyIdMap.has(id)) {
        legacyIdMap.set(id, genSideChatUuid());
      }
      return legacyIdMap.get(id);
    };
    const rawPinnedTop = String(layout?._legacyPinnedSideChatTabId || layout?.pinnedTopSidecarId || '');
    let legacyPinnedCid = rawPinnedTop.startsWith(LEGACY_SIDECHAT_TAB_PREFIX)
      ? normCid(rawPinnedTop.slice(LEGACY_SIDECHAT_TAB_PREFIX.length))
      : '';
    if (raw && typeof raw === 'object') {
      if (raw.customTitles && typeof raw.customTitles === 'object') {
        try {
          localStorage.setItem(
            CUSTOM_TITLES_KEY,
            JSON.stringify({ ...raw.customTitles, ...ns.readCustomSideChatTitles() })
          );
        } catch {
          /* ignore */
        }
      }
      if (Array.isArray(raw.threads)) {
        sc.threads = raw.threads
          .filter((t) => t?.cascadeId)
          .map((t) => ({
            cascadeId: normCid(t.cascadeId),
            title: String(t.title || 'Side Chat'),
            parentConversationId: String(t.parentConversationId || ''),
            hasActivity: false,
            pinned: Boolean(t.pinned),
            quotePayload: null,
            nativeLinked: Boolean(t.nativeLinked),
            _lastNativeTitle: t.nativeLinked ? String(t.title || '') : '',
          }));
      }
      if (Array.isArray(raw.poppedIds)) {
        for (const rawPopId of raw.poppedIds) {
          const cid = normCid(rawPopId);
          if (cid && !sc.threads.some((t) => t.cascadeId === cid)) {
            sc.counter += 1;
            sc.threads.push({
              cascadeId: cid,
              title: ns.readCustomSideChatTitles()[cid] || `Side Chat #${sc.threads.length + 1}`,
              parentConversationId: '',
              hasActivity: false,
              pinned: false,
              quotePayload: null,
              nativeLinked: false,
              _lastNativeTitle: '',
            });
          }
        }
      }
      sc.counter = Math.max(
        sc.counter,
        typeof raw.sideChatCounter === 'number' ? raw.sideChatCounter : 0,
        sc.threads.length
      );
      if (legacyPinnedCid && raw.activeByInstance?.[rawPinnedTop]) {
        legacyPinnedCid = normCid(raw.activeByInstance[rawPinnedTop]);
      }
      if (raw.activeCascadeId) {
        sc.activeId = normCid(raw.activeCascadeId);
      }
      if (typeof raw.isDocked === 'boolean') {
        sc.isDocked = raw.isDocked;
      }
      if (typeof raw.isOpen === 'boolean') {
        sc.isOpen = raw.isOpen;
      }
    }
    for (const ut of unpersisted) {
      if (!sc.threads.some((t) => t.cascadeId === ut.cascadeId)) {
        sc.threads.push({ ...ut, _createdWsKey: scopeKey || ut._createdWsKey || '' });
      }
    }
    if (unpersisted.length > 0) {
      sc.counter = Math.max(sc.counter, sc.threads.length);
      if (!sc.activeId && prevActiveId) {
        sc.activeId = prevActiveId;
      }
    }
    const closedSet = new Set(Array.isArray(layout?.closedTabIds) ? layout.closedTabIds : []);
    if (hadPendingOpen) {
      sc.isOpen = true;
      closedSet.delete(ns.SIDECHAT_TAB_ID);
    }
    if (!scopeKey && !hasWsMap) {
      const candidateTabs = [
        ...(layout?.tabOrder || []),
        ...(layout?.topSplitTabIds || []),
        rawPinnedTop,
      ];
      for (const tabId of candidateTabs) {
        const cid = String(tabId).startsWith(LEGACY_SIDECHAT_TAB_PREFIX) && !closedSet.has(tabId)
          ? normCid(String(tabId).slice(LEGACY_SIDECHAT_TAB_PREFIX.length))
          : '';
        if (!cid) continue;
        if (!sc.threads.some((t) => t.cascadeId === cid)) {
          sc.counter += 1;
          sc.threads.push({
            cascadeId: cid,
            title: ns.readCustomSideChatTitles()[cid] || `Side Chat #${sc.counter}`,
            parentConversationId: '',
            hasActivity: false,
            pinned: false,
            quotePayload: null,
            nativeLinked: false,
            _lastNativeTitle: '',
          });
        }
      }
    }
    if (legacyPinnedCid && sc.threads.some((t) => t.cascadeId === legacyPinnedCid)) {
      sc.activeId = legacyPinnedCid;
    } else if (!sc.activeId && sc.threads.length > 0) {
      sc.activeId = sc.threads[0].cascadeId;
    }
    const pinnedIsSideChat =
      rawPinnedTop === ns.SIDECHAT_TAB_ID || rawPinnedTop.startsWith(LEGACY_SIDECHAT_TAB_PREFIX);
    if (sc.threads.length > 0 && (!closedSet.has(ns.SIDECHAT_TAB_ID) || pinnedIsSideChat)) {
      sc.isOpen = true;
    }
  };

  ns.syncNativeSideQuestions = function syncNativeSideQuestions(nativePayload, layout = {}) {
    if (!nativePayload || typeof nativePayload !== 'object') return false;
    const convId = String(nativePayload.conversationId || '').trim();
    if (!convId || convId === '_new') return false;
    const cascadeIds = Array.isArray(nativePayload.cascadeIds)
      ? [...new Set(nativePayload.cascadeIds.map((id) => String(id || '').trim()).filter(Boolean))]
      : [];
    const titles = nativePayload.titles && typeof nativePayload.titles === 'object' ? nativePayload.titles : {};
    const idSet = new Set(cascadeIds);
    let changed = false;

    const kept = [];
    for (const t of sc.threads) {
      if (idSet.has(t.cascadeId)) {
        if (t._unpersisted) delete t._unpersisted;
        if (!t.nativeLinked || t.parentConversationId !== convId) {
          t.nativeLinked = true;
          t.parentConversationId = convId;
          changed = true;
        }
        kept.push(t);
        continue;
      }
      if (t?._unpersisted || sc.startInFlight) {
        kept.push(t);
        continue;
      }
      if (t.nativeLinked) {
        if (t.parentConversationId === convId) {
          ns.disposeSideChatFrame(t.cascadeId);
          ns.saveCustomSideChatTitle(t.cascadeId, '');
          sc.pendingRenames.delete(t.cascadeId);
          changed = true;
          continue;
        }
        if (t.parentConversationId && t.parentConversationId !== convId && !t.pinned) {
          ns.disposeSideChatFrame(t.cascadeId);
          changed = true;
          continue;
        }
      }
      kept.push(t);
    }
    if (kept.length !== sc.threads.length) {
      sc.threads = kept;
      changed = true;
    }

    const now = Date.now();
    for (const cid of cascadeIds) {
      const nativeTitle = String(titles[cid] || '').replace(/\s+/g, ' ').trim();
      const existing = sc.threads.find((x) => x.cascadeId === cid);
      if (!existing) {
        const savedCustom = ns.readCustomSideChatTitles()[cid] || '';
        sc.threads.push({
          cascadeId: cid,
          title: nativeTitle || savedCustom || 'Side Question',
          parentConversationId: convId,
          hasActivity: false,
          pinned: false,
          quotePayload: null,
          nativeLinked: true,
          _lastNativeTitle: nativeTitle,
        });
        changed = true;
      } else {
        const pending = sc.pendingRenames.get(cid);
        if (pending) {
          if (nativeTitle && nativeTitle === pending.title) {
            sc.pendingRenames.delete(cid);
            existing._lastNativeTitle = nativeTitle;
          } else if (now - pending.ts >= PENDING_RENAME_TTL_MS) {
            sc.pendingRenames.delete(cid);
          }
        }
        if (!sc.pendingRenames.has(cid) && nativeTitle && nativeTitle !== existing._lastNativeTitle) {
          existing.title = nativeTitle;
          existing._lastNativeTitle = nativeTitle;
          if (ns.readCustomSideChatTitles()[cid] !== undefined) {
            ns.saveCustomSideChatTitle(cid, '');
          }
          changed = true;
        }
      }
    }

    if (sc.threads.some((x) => x.pinned)) {
      sc.threads = [...sc.threads.filter((x) => x.pinned), ...sc.threads.filter((x) => !x.pinned)];
    }
    sc.counter = Math.max(sc.counter, sc.threads.length);

    if (sc.threads.length === 0 && !sc.startInFlight && !sc._pendingOpen) {
      if (sc.isOpen || sc.activeId) {
        sc.activeId = '';
        ns.closeSideChatDrawer?.({ deleteAll: false, notify: false });
        changed = true;
      }
    } else if (sc.threads.length > 0) {
      if (!sc.activeId || !sc.threads.some((x) => x.cascadeId === sc.activeId)) {
        sc.activeId = sc.threads[sc.threads.length - 1].cascadeId;
        changed = true;
      }
      const closedSet = new Set(Array.isArray(layout?.closedTabIds) ? layout.closedTabIds : []);
      const pinnedTop = normScTabId(layout?.pinnedTopSidecarId || '');
      if (!sc.isOpen && (!closedSet.has(ns.SIDECHAT_TAB_ID) || pinnedTop === ns.SIDECHAT_TAB_ID)) {
        sc.isOpen = true;
        changed = true;
      }
    }
    return changed;
  };

  ns.getSideChatState = () => ({
    threads: sc.threads.map((t) => ({ ...t })),
    activeCascadeId: sc.activeId,
    isOpen: sc.isOpen,
    isDocked: sc.isDocked,
    sideChatState: ns.serializeSideChatState(),
  });
  ns.setSideChatDockCallback = (fn) => {
    sc.onStateChange = typeof fn === 'function' ? fn : null;
  };
  ns.notifySideChatState = (extra) => {
    const base = ns.getSideChatState();
    sc.onStateChange?.(extra ? { ...base, ...extra } : base);
  };

  ns.ensureSideChatThread = async function ensureSideChatThread({
    parentConversationId = '',
    labelHint = '',
    forceNew = false,
    quotePayload = null,
  } = {}) {
    if (!forceNew) {
      const existing =
        sc.threads.find((t) => t.cascadeId === sc.activeId) || sc.threads[sc.threads.length - 1];
      if (existing) {
        return Object.assign(existing, quotePayload ? { quotePayload } : {});
      }
      if (sc.startInFlight) {
        return sc.startInFlight;
      }
    }
    const gen = sc.generation;
    sc._pendingOpen = true;
    const run = (async () => {
      sc.counter += 1;
      const idx = sc.counter;
      let cascadeId = genSideChatUuid();
      let resolvedParentId = String(parentConversationId || '').trim();
      if (resolvedParentId === '_new') resolvedParentId = '';
      let createdRemote = false;
      try {
        const res = await ns.apiCall?.('/api/terminal/sidechat/start', {
          parentConversationId: resolvedParentId,
          cascadeId,
        });
        if (res?.cascadeId) {
          cascadeId = String(res.cascadeId);
          createdRemote = true;
        }
        if (res && typeof res === 'object' && 'parentConversationId' in res) {
          resolvedParentId = String(res.parentConversationId || '');
        }
      } catch {
        /* ignore */
      }
      if (gen !== sc.generation) {
        if (createdRemote) {
          ns.apiCall?.('/api/terminal/sidechat/delete', { cascadeId })?.catch?.(() => {});
        }
        return null;
      }
      const existing = sc.threads.find((t) => t.cascadeId === cascadeId);
      if (existing) {
        delete existing._unpersisted;
        if (quotePayload) existing.quotePayload = quotePayload;
        if (labelHint && existing.title === 'Side Question') {
          existing.title = `Side Chat #${idx} · ${labelHint}`;
        }
        sc.isOpen = true;
        ns.setActiveSideChatId(cascadeId);
        return existing;
      }
      const thread = {
        cascadeId,
        title: labelHint ? `Side Chat #${idx} · ${labelHint}` : `Side Chat #${idx}`,
        parentConversationId: resolvedParentId,
        hasActivity: false,
        pinned: false,
        quotePayload: quotePayload || null,
        nativeLinked: false,
        _lastNativeTitle: '',
        _unpersisted: true,
        _createdWsKey: sc.hydratedWsKey || '',
      };
      sc.threads.push(thread);
      sc.isOpen = true;
      ns.setActiveSideChatId(cascadeId);
      return thread;
    })();
    sc.startInFlight = run;
    try {
      return await run;
    } finally {
      if (sc.startInFlight === run) {
        sc.startInFlight = null;
        sc._pendingOpen = false;
      }
    }
  };

  ns.disposeSideChatFrame = (cid) => {
    const f = sc.frames.get(cid);
    if (!f) return;
    if (f.dataset) {
      f.dataset.loadedCascadeId = '';
    }
    f.src = 'about:blank';
    f.classList?.add?.('hidden');
    if (!f._isInitialFrame) {
      f.remove?.();
    }
    sc.frames.delete(cid);
  };

  ns.deleteSideChatsByIds = async function deleteSideChatsByIds(cids = []) {
    const targetIds = cids.filter(Boolean);
    if (!targetIds.length) return;
    const rmSet = new Set(targetIds);
    for (const cid of targetIds) {
      sc.pendingRenames.delete(cid);
      ns.saveCustomSideChatTitle(cid, '');
      ns.disposeSideChatFrame(cid);
      ns.apiCall?.('/api/terminal/sidechat/delete', { cascadeId: cid })?.catch?.(() => {});
    }
    const prevIds = sc.threads.map((t) => t.cascadeId);
    const prevAct = sc.activeId || prevIds[0] || '';
    sc.threads = sc.threads.filter((t) => !rmSet.has(t.cascadeId));
    const remIds = sc.threads.map((t) => t.cascadeId);
    if (!remIds.length) {
      ns.closeSideChatDrawer?.({ deleteAll: true, notify: true });
      return;
    }
    const remSet = new Set(remIds);
    const pIdx = prevIds.indexOf(prevAct);
    const nextAct = remSet.has(prevAct)
      ? prevAct
      : ((pIdx >= 0 ? prevIds.slice(pIdx + 1).find((id) => remSet.has(id)) : '') ||
          remIds[remIds.length - 1] ||
          '');
    ns.setActiveSideChatId(nextAct);
    sc.boxes.get(ns.SIDECHAT_TAB_ID)?._syncThreadsUi?.(nextAct, null);
    ns.notifySideChatState();
  };

  ns.reorderSideChatThreadsInInstance = (_rootId = '', movedCid = '', targetIndex = 0) => {
    const srcIdx = sc.threads.findIndex((t) => t.cascadeId === movedCid);
    if (srcIdx < 0) return;
    const next = [...sc.threads];
    const [moved] = next.splice(srcIdx, 1);
    const dstIdx = Math.max(0, Math.min(next.length, targetIndex > srcIdx ? targetIndex - 1 : targetIndex));
    next.splice(dstIdx, 0, moved);
    sc.threads = [...next.filter((t) => t.pinned), ...next.filter((t) => !t.pinned)];
  };
})();
