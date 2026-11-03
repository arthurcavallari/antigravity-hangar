/** @fileoverview Side Chat thread state, workspace hydration, and cross-instance tab promotion/demotion. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  ns.SIDECHAT_TAB_ID = '__sidechat__';
  ns.SIDECHAT_TAB_PREFIX = 'sidechat__';
  ns.isSideChatTabId = (tabId = '') =>
    tabId === ns.SIDECHAT_TAB_ID || String(tabId || '').startsWith(ns.SIDECHAT_TAB_PREFIX);

  const CUSTOM_TITLES_KEY = 'hangar.sideChatCustomTitles';
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
    poppedIds: new Set(),
    groupMap: {},
    activeByInstance: new Map(),
    boxes: new Map(),
    frames: new Map(),
  });

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
      const res = await ns.notifyAgent?.(
        ns.formatTerminalAgentMessage(cur, input.value),
        hostObj._convId || '',
        `Terminal Quote: ${cur.cleanName}`
      );
      if (res?.ok === false) {
        throw new Error(res.error || 'Could not send message to agent');
      }
      input.value = '';
      syncH();
      onDone?.();
      ns.showTerminalQuoteToast(hostObj._toastRoot || root, `Sent quote from "${cur.cleanName}" to Main Chat`);
    } catch (err) {
      ns.showTerminalQuoteToast(hostObj._toastRoot || root, err?.message || 'Failed to send to Agent');
    }
    Object.assign(sendBtn, { disabled: false, textContent: idleLabel });
  };

  ns._resolveSideChatRootId = (cid) => {
    if (!cid) return '';
    if (sc.poppedIds.has(cid)) return cid;
    if (sc.groupMap[cid] && sc.poppedIds.has(sc.groupMap[cid])) return sc.groupMap[cid];
    return '';
  };

  ns._resolveSideChatTabId = (cid) => {
    const rootId = ns._resolveSideChatRootId(cid);
    return rootId ? `${ns.SIDECHAT_TAB_PREFIX}${rootId}` : ns.SIDECHAT_TAB_ID;
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

  ns.resolveSideChatTitle = (t) =>
    t ? (ns.readCustomSideChatTitles()[t.cascadeId] || t.title || 'Side Chat') : 'Side Chat';
  ns.getPoppedSideChatIds = () => new Set(sc.poppedIds);
  ns.getSideChatGroupMap = () => ({ ...sc.groupMap });
  ns.getActiveSideChatId = (tabId = ns.SIDECHAT_TAB_ID) =>
    sc.activeByInstance.get(tabId) || (tabId === ns.SIDECHAT_TAB_ID ? sc.activeId : '');
  ns.setActiveSideChatId = (tabId = ns.SIDECHAT_TAB_ID, cid = '') => {
    if (cid) {
      sc.activeByInstance.set(tabId, cid);
    } else {
      sc.activeByInstance.delete(tabId);
    }
    if (tabId === ns.SIDECHAT_TAB_ID) {
      sc.activeId = cid;
    }
  };

  ns.getInstanceSideChats = (all = sc.threads, rootId = '') =>
    all.filter((t) =>
      rootId
        ? sc.poppedIds.has(rootId) && (t.cascadeId === rootId || sc.groupMap[t.cascadeId] === rootId)
        : !sc.poppedIds.has(t.cascadeId) && !sc.poppedIds.has(sc.groupMap[t.cascadeId])
    );

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
    })),
    poppedIds: [...sc.poppedIds],
    groupMap: { ...sc.groupMap },
    activeByInstance: Object.fromEntries(sc.activeByInstance.entries()),
    customTitles: ns.readCustomSideChatTitles(),
  });

  ns.hydrateSideChatStateFromLayout = (layout = {}, workspacePath = '') => {
    const wsKey = String(workspacePath || '').trim().replace(/\\/g, '/').toLowerCase();
    if (sc.hydrated && sc.hydratedWsKey === wsKey) return;
    Object.assign(sc, {
      hydrated: true,
      hydratedWsKey: wsKey,
      threads: [],
      activeId: '',
      counter: 0,
      isOpen: false,
    });
    sc.poppedIds.clear();
    Object.keys(sc.groupMap).forEach((k) => delete sc.groupMap[k]);
    sc.activeByInstance.clear();
    const raw = wsKey ? layout?.sideChatStateByWorkspace?.[wsKey] : layout?.sideChatState;
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
            cascadeId: String(t.cascadeId),
            title: String(t.title || 'Side Chat'),
            parentConversationId: String(t.parentConversationId || ''),
            hasActivity: false,
            pinned: Boolean(t.pinned),
            quotePayload: null,
          }));
      }
      sc.counter = Math.max(
        sc.counter,
        typeof raw.sideChatCounter === 'number' ? raw.sideChatCounter : 0,
        sc.threads.length
      );
      if (Array.isArray(raw.poppedIds)) {
        raw.poppedIds.filter(Boolean).forEach((id) => sc.poppedIds.add(String(id)));
      }
      if (raw.groupMap && typeof raw.groupMap === 'object') {
        Object.assign(sc.groupMap, raw.groupMap);
      }
      if (raw.activeByInstance && typeof raw.activeByInstance === 'object') {
        Object.entries(raw.activeByInstance).forEach(([k, v]) => {
          if (v) {
            sc.activeByInstance.set(k, String(v));
          }
        });
      }
      if (raw.activeCascadeId) {
        sc.activeId = String(raw.activeCascadeId);
      }
      if (typeof raw.isDocked === 'boolean') {
        sc.isDocked = raw.isDocked;
      }
      if (typeof raw.isOpen === 'boolean') {
        sc.isOpen = raw.isOpen;
      }
    }
    const closedSet = new Set(Array.isArray(layout?.closedTabIds) ? layout.closedTabIds : []);
    if (!wsKey) {
      const candidateTabs = [
        ...(layout?.tabOrder || []),
        ...(layout?.topSplitTabIds || []),
        layout?.pinnedTopSidecarId || '',
      ];
      for (const tabId of candidateTabs) {
        const cid = String(tabId).startsWith(ns.SIDECHAT_TAB_PREFIX) && !closedSet.has(tabId)
          ? String(tabId).slice(ns.SIDECHAT_TAB_PREFIX.length)
          : '';
        if (!cid) continue;
        sc.poppedIds.add(cid);
        if (!sc.threads.some((t) => t.cascadeId === cid)) {
          sc.counter += 1;
          sc.threads.push({
            cascadeId: cid,
            title: `Side Chat #${sc.counter}`,
            parentConversationId: '',
            hasActivity: false,
            pinned: false,
            quotePayload: null,
          });
        }
        if (!sc.activeByInstance.has(tabId)) {
          sc.activeByInstance.set(tabId, cid);
        }
      }
    }
    if (ns.getInstanceSideChats(sc.threads, '').length > 0 && !closedSet.has(ns.SIDECHAT_TAB_ID)) {
      sc.isOpen = true;
    }
  };

  ns.getSideChatState = () => ({
    threads: sc.threads.map((t) => ({ ...t })),
    activeCascadeId: sc.activeId,
    isOpen: sc.isOpen,
    isDocked: sc.isDocked,
    poppedIds: [...sc.poppedIds],
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
    rootId = '',
    popOut = false,
    quotePayload = null,
  } = {}) {
    const instTabId = rootId ? `${ns.SIDECHAT_TAB_PREFIX}${rootId}` : ns.SIDECHAT_TAB_ID;
    if (!forceNew && !popOut) {
      const instThreads = ns.getInstanceSideChats(sc.threads, rootId);
      const existing =
        instThreads.find((t) => t.cascadeId === ns.getActiveSideChatId(instTabId)) ||
        instThreads[instThreads.length - 1];
      if (existing) {
        return Object.assign(existing, quotePayload ? { quotePayload } : {});
      }
      if (sc.startInFlight) {
        return sc.startInFlight;
      }
    }
    const gen = sc.generation;
    const run = (async () => {
      sc.counter += 1;
      const idx = sc.counter;
      let cascadeId = `sidechat-${Date.now()}-${idx}`;
      let createdRemote = false;
      try {
        const res = await ns.apiCall?.('/api/terminal/sidechat/start', { parentConversationId });
        if (res?.cascadeId) {
          cascadeId = String(res.cascadeId);
          createdRemote = true;
        }
      } catch {
        /* ignore */
      }
      if (gen !== sc.generation || (!sc.isOpen && !popOut && !rootId)) {
        if (createdRemote) {
          ns.apiCall?.('/api/terminal/sidechat/delete', { cascadeId })?.catch?.(() => {});
        }
        return null;
      }
      const thread = {
        cascadeId,
        title: labelHint ? `Side Chat #${idx} · ${labelHint}` : `Side Chat #${idx}`,
        parentConversationId: String(parentConversationId || ''),
        hasActivity: false,
        pinned: false,
        quotePayload: quotePayload || null,
      };
      sc.threads.push(thread);
      if (popOut) {
        sc.poppedIds.add(cascadeId);
      } else if (rootId) {
        sc.groupMap[cascadeId] = rootId;
      }
      ns.setActiveSideChatId(popOut ? `${ns.SIDECHAT_TAB_PREFIX}${cascadeId}` : instTabId, cascadeId);
      return thread;
    })();
    sc.startInFlight = run;
    try {
      return await run;
    } finally {
      if (sc.startInFlight === run) {
        sc.startInFlight = null;
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

  const rekeyPoppedRoot = (oldTabId, oldRoot, nextRoot, activeCid) => {
    const nextTabId = `${ns.SIDECHAT_TAB_PREFIX}${nextRoot}`;
    const b = sc.boxes.get(oldTabId);
    const ordered = [...sc.poppedIds].map((id) => (id === oldRoot ? nextRoot : id));
    sc.poppedIds.clear();
    ordered.forEach((id) => sc.poppedIds.add(id));
    delete sc.groupMap[nextRoot];
    Object.entries(sc.groupMap).forEach(([k, v]) => {
      if (v === oldRoot) {
        sc.groupMap[k] = nextRoot;
      }
    });
    if (b && sc.boxes.delete(oldTabId)) {
      sc.boxes.set(nextTabId, b);
    }
    b?._setInstance?.(nextTabId, nextRoot);
    sc.activeByInstance.delete(oldTabId);
    ns.setActiveSideChatId(nextTabId, activeCid);
    b?._syncThreadsUi?.(activeCid, null);
    return nextTabId;
  };

  ns.deleteSideChatsByIds = async function deleteSideChatsByIds(cids = [], instanceTabId = ns.SIDECHAT_TAB_ID) {
    const targetIds = cids.filter(Boolean);
    if (!targetIds.length) return;
    const rmSet = new Set(targetIds);
    const rootId = instanceTabId.startsWith(ns.SIDECHAT_TAB_PREFIX)
      ? instanceTabId.slice(ns.SIDECHAT_TAB_PREFIX.length)
      : '';
    for (const cid of targetIds) {
      delete sc.groupMap[cid];
      ns.saveCustomSideChatTitle(cid, '');
      ns.disposeSideChatFrame(cid);
      ns.apiCall?.('/api/terminal/sidechat/delete', { cascadeId: cid })?.catch?.(() => {});
    }
    const prevIds = ns.getInstanceSideChats(sc.threads, rootId).map((t) => t.cascadeId);
    const prevAct = ns.getActiveSideChatId(instanceTabId) || prevIds[0] || '';
    sc.threads = sc.threads.filter((t) => !rmSet.has(t.cascadeId));
    const remIds = ns.getInstanceSideChats(sc.threads, rootId).map((t) => t.cascadeId);
    const remSet = new Set(remIds);
    const pIdx = prevIds.indexOf(prevAct);
    const nextAct = remSet.has(prevAct)
      ? prevAct
      : ((pIdx >= 0 ? prevIds.slice(pIdx + 1).find((id) => remSet.has(id)) : '') ||
          remIds[remIds.length - 1] ||
          '');
    if (rootId && !remIds.length) {
      sc.poppedIds.delete(rootId);
      Object.entries(sc.groupMap).forEach(([k, v]) => {
        if (v === rootId) {
          delete sc.groupMap[k];
        }
      });
      sc.boxes.get(instanceTabId)?.remove?.();
      sc.boxes.delete(instanceTabId);
      sc.activeByInstance.delete(instanceTabId);
      ns.notifySideChatState({ closedSidecarId: instanceTabId });
      return;
    }
    if (rootId && rmSet.has(rootId)) {
      const nextTabId = rekeyPoppedRoot(instanceTabId, rootId, remIds[0], nextAct);
      ns.notifySideChatState({ replacedSidecarId: { from: instanceTabId, to: nextTabId } });
      return;
    }
    if (!rootId && !remIds.length) {
      ns.closeSideChatDrawer?.({ deleteAll: sc.threads.length === 0, notify: true });
      return;
    }
    ns.setActiveSideChatId(instanceTabId, nextAct);
    sc.boxes.get(instanceTabId)?._syncThreadsUi?.(nextAct, null);
    ns.notifySideChatState();
  };

  ns.closeSideChatInstance = async (tabId = '') => {
    const rId = String(tabId || '').startsWith(ns.SIDECHAT_TAB_PREFIX)
      ? String(tabId).slice(ns.SIDECHAT_TAB_PREFIX.length)
      : '';
    if (!rId) {
      ns.closeSideChatDrawer?.({ deleteAll: false, notify: false });
      return;
    }
    const cids = ns.getInstanceSideChats(sc.threads, rId).map((t) => t.cascadeId);
    if (!cids.includes(rId)) {
      cids.push(rId);
    }
    await ns.deleteSideChatsByIds(cids, tabId);
  };

  ns.reorderSideChatThreadsInInstance = (rootId = '', movedCid = '', targetIndex = 0) => {
    const inst = ns.getInstanceSideChats(sc.threads, rootId);
    const srcIdx = inst.findIndex((t) => t.cascadeId === movedCid);
    if (srcIdx < 0) return;
    const [moved] = inst.splice(srcIdx, 1);
    const dstIdx = Math.max(0, Math.min(inst.length, targetIndex > srcIdx ? targetIndex - 1 : targetIndex));
    inst.splice(dstIdx, 0, moved);
    const ordered = [...inst.filter((t) => t.pinned), ...inst.filter((t) => !t.pinned)];
    const instSet = new Set(ordered.map((t) => t.cascadeId));
    let k = 0;
    sc.threads = sc.threads.map((t) => (instSet.has(t.cascadeId) ? ordered[k++] : t));
  };

  ns.promoteSideChatToHangarBar = function promoteSideChatToHangarBar(dragPayload) {
    const cid = dragPayload?.cascadeId;
    if (!cid) return null;
    const srcTabId = dragPayload.instanceTabId || ns.SIDECHAT_TAB_ID;
    const srcRoot = srcTabId.startsWith(ns.SIDECHAT_TAB_PREFIX)
      ? srcTabId.slice(ns.SIDECHAT_TAB_PREFIX.length)
      : '';
    const remaining = ns.getInstanceSideChats(sc.threads, srcRoot).filter((t) => t.cascadeId !== cid);
    if (srcRoot && !remaining.length) {
      return { newSidecarId: srcTabId, replacedSidecarId: null };
    }
    const newSidecarId = `${ns.SIDECHAT_TAB_PREFIX}${cid}`;
    sc.poppedIds.add(cid);
    delete sc.groupMap[cid];
    ns.setActiveSideChatId(newSidecarId, cid);
    const vpEl = typeof document?.getElementById === 'function' ? document.getElementById('main-viewport') : null;
    const targetRoot = vpEl || ns._sideChatBox?.parentElement || ns._sideChatBox?._toastRoot || document.body;
    ns.ensureSideChatBox?.(newSidecarId, targetRoot)?._syncThreadsUi?.(cid, null);
    let replacedSidecarId = null;
    if (srcRoot && cid === srcRoot && remaining.length > 0) {
      const nextTabId = rekeyPoppedRoot(
        srcTabId,
        srcRoot,
        remaining[0].cascadeId,
        remaining[remaining.length - 1].cascadeId
      );
      replacedSidecarId = { from: srcTabId, to: nextTabId };
    } else if (srcRoot || remaining.length > 0) {
      const targetTab = srcRoot ? srcTabId : ns.SIDECHAT_TAB_ID;
      const nextAct = remaining[remaining.length - 1]?.cascadeId || srcRoot;
      ns.setActiveSideChatId(targetTab, nextAct);
      sc.boxes.get(targetTab)?._syncThreadsUi?.(nextAct, null);
    } else {
      sc.isOpen = false;
      sc.boxes.get(ns.SIDECHAT_TAB_ID)?.classList?.add?.('hidden');
      replacedSidecarId = { from: ns.SIDECHAT_TAB_ID, to: newSidecarId };
    }
    return { newSidecarId, replacedSidecarId };
  };
})();
