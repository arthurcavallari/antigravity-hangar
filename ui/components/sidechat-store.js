/** @fileoverview Side Question thread state, workspace hydration, and native Side Question annotation sync. */
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
  const MAX_DELETED_IDS = 256;
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
    closedThreads: [],
    closedCascadeIds: new Set(),
    deletedIds: new Set(),
    externalMetaById: new Map(),
    activeId: '',
    counter: 0,
    generation: 0,
    hydrated: false,
    hydratedWsKey: null,
    isOpen: false,
    isDocked: true,
    hideFromAntigravity: false,
    allowExternal: true,
    onStateChange: null,
    startInFlight: null,
    inFlightStarts: new Set(),
    knownHangarIds: new Set(),
    promotingIds: new Set(),
    pendingRenames: new Map(),
    boxes: new Map(),
    frames: new Map(),
  });

  function markClientDeletedId(cid = '') {
    const clean = String(cid || '').trim();
    if (!clean) return;
    sc.deletedIds.delete(clean);
    sc.deletedIds.add(clean);
    while (sc.deletedIds.size > MAX_DELETED_IDS) {
      const oldest = sc.deletedIds.values().next().value;
      if (oldest === undefined) break;
      sc.deletedIds.delete(oldest);
    }
  }

  ns.setHideHangarSideQuestions = (v) => {
    sc.hideFromAntigravity = Boolean(v);
  };
  ns.getHideHangarSideQuestions = () => Boolean(sc.hideFromAntigravity);
  ns.sideChatStore = {
    state: sc,
    getState: () => sc,
    markThreadActivity: (cid, active = true) => {
      const th =
        sc.threads.find((t) => t.cascadeId === cid) ||
        sc.closedThreads.find((t) => t.cascadeId === cid);
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
    const th =
      sc.threads.find((t) => t.cascadeId === cid) ||
      sc.closedThreads.find((t) => t.cascadeId === cid);
    sc.pendingRenames.set(cid, { title: next, ts: Date.now() });
    if (next) {
      if (th) th.title = next;
    } else if (th) {
      th.title = th._lastNativeTitle || 'Side Question';
    }
  };

  function reconcilePendingRename(cid, incomingTitle, target, now) {
    const pending = sc.pendingRenames.get(cid);
    if (!pending) return;
    if (incomingTitle === pending.title) {
      sc.pendingRenames.delete(cid);
      if (incomingTitle) {
        target._lastNativeTitle = incomingTitle;
      }
    } else if (now - pending.ts >= PENDING_RENAME_TTL_MS) {
      sc.pendingRenames.delete(cid);
    }
  }

  ns.resolveSideChatTitle = (t) =>
    t ? (ns.readCustomSideChatTitles()[t.cascadeId] || t.title || 'Side Question') : 'Side Question';

  ns.getActiveSideChatId = () => sc.activeId;
  ns.setActiveSideChatId = (first = '', second) => {
    sc.activeId = String((second === undefined ? first : second) || '');
  };
  ns.getInstanceSideChats = (all = sc.threads) => all;
  ns.getClosedSideChats = () =>
    sc.closedThreads.filter((t) => sc.allowExternal !== false || !t.isExternal);

  function serializeThreadRecord(t) {
    delete t._unpersisted;
    return {
      cascadeId: String(t.cascadeId || ''),
      title: String(t.title || 'Side Question'),
      parentConversationId: String(t.parentConversationId || ''),
      pinned: Boolean(t.pinned),
      ...(t.isExternal ? { isExternal: true } : {}),
      ...(t.hasActivity ? { hasActivity: true } : {}),
      ...(t.nativeLinked ? { nativeLinked: true } : {}),
      ...(t._lastNativeTitle ? { lastNativeTitle: String(t._lastNativeTitle) } : {}),
      ...(typeof t._baselineSteps === 'number' ? { baselineSteps: t._baselineSteps } : {}),
    };
  }

  function hydrateThreadRecord(t, normCid) {
    const cid = normCid(t.cascadeId);
    const isExternal = Boolean(t.isExternal);
    if (!isExternal) sc.knownHangarIds.add(cid);
    return {
      cascadeId: cid,
      title: String(t.title || 'Side Question'),
      parentConversationId: String(t.parentConversationId || ''),
      isExternal,
      isRunning: false,
      hasActivity: Boolean(t.hasActivity || isExternal),
      pinned: Boolean(t.pinned),
      quotePayload: null,
      nativeLinked: Boolean(t.nativeLinked),
      _lastNativeTitle: String(t.lastNativeTitle || ''),
      _baselineSteps: typeof t.baselineSteps === 'number' ? t.baselineSteps : undefined,
      _baselineTitle: undefined,
    };
  }

  ns.serializeSideChatState = () => ({
    isOpen: Boolean(sc.isOpen),
    isDocked: Boolean(sc.isDocked),
    activeCascadeId: String(sc.activeId || ''),
    sideChatCounter: Number(sc.counter) || 0,
    hangarCascadeIds: [...sc.knownHangarIds],
    closedCascadeIds: [...sc.closedCascadeIds],
    closedThreads: sc.closedThreads.map(serializeThreadRecord),
    externalThreadPrefs: Object.fromEntries(sc.externalMetaById.entries()),
    threads: sc.threads.map(serializeThreadRecord),
    customTitles: ns.readCustomSideChatTitles(),
  });

  ns.hydrateSideChatStateFromLayout = (layout = {}, workspacePath = '', conversationId = '') => {
    if (layout?.hideHangarSideQuestions !== undefined) {
      sc.hideFromAntigravity = Boolean(layout.hideHangarSideQuestions);
    }
    sc.allowExternal = layout?.showExternalSideQuestions !== false;
    const wsKey = String(workspacePath || '').trim().replace(/\\/g, '/').toLowerCase();
    const convKey = String(conversationId || '').trim();
    const scopeKey = wsKey || (convKey ? `conv:${convKey}` : '');
    const hasWsMap = Boolean(layout?.sideChatStateByWorkspace && typeof layout.sideChatStateByWorkspace === 'object');
    if (sc.hydrated && sc.hydratedWsKey === scopeKey && (scopeKey || !hasWsMap)) return;

    const unpersisted = sc.threads.filter(
      (t) =>
        t?._unpersisted &&
        t._createdWsKey &&
        (t._createdWsKey === scopeKey || (convKey && t._createdWsKey === `conv:${convKey}`))
    );
    const keepFrameIds = new Set(unpersisted.map((t) => t.cascadeId));
    for (const fid of [...sc.frames.keys()]) {
      if (!keepFrameIds.has(fid)) {
        ns.disposeSideChatFrame(fid);
      }
    }
    ns._sideChatBox?._closeDeleteConfirm?.();
    if (ns._sideChatBox) {
      ns._sideChatBox._convId = '';
    }

    const hadPendingOpen = Boolean(sc._pendingOpen || sc.inFlightStarts.size > 0 || (unpersisted.length > 0 && sc.isOpen));
    const prevActiveId = sc.activeId;
    Object.assign(sc, {
      generation: sc.generation + 1,
      hydrated: true,
      hydratedWsKey: scopeKey,
      threads: [],
      closedThreads: [],
      activeId: '',
      counter: 0,
      isOpen: false,
    });
    sc.closedCascadeIds.clear();
    sc.externalMetaById.clear();
    sc.knownHangarIds.clear();
    sc.promotingIds.clear();
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
        const cur = ns.readCustomSideChatTitles();
        let merged = false;
        for (const [k, v] of Object.entries(raw.customTitles)) {
          const nk = normCid(k);
          if (nk && v && !cur[nk]) {
            cur[nk] = String(v);
            merged = true;
          }
        }
        if (merged) {
          try {
            localStorage.setItem(CUSTOM_TITLES_KEY, JSON.stringify(cur));
          } catch {
            /* ignore */
          }
        }
      }
      if (raw.externalThreadPrefs && typeof raw.externalThreadPrefs === 'object') {
        for (const [k, v] of Object.entries(raw.externalThreadPrefs)) {
          if (k && v && typeof v === 'object') {
            sc.externalMetaById.set(normCid(k), { pinned: Boolean(v.pinned) });
          }
        }
      }
      if (Array.isArray(raw.hangarCascadeIds)) {
        for (const rawHid of raw.hangarCascadeIds) {
          const hid = normCid(rawHid);
          if (hid) sc.knownHangarIds.add(hid);
        }
      }
      if (Array.isArray(raw.closedCascadeIds)) {
        for (const rawCid of raw.closedCascadeIds) {
          const cid = normCid(rawCid);
          if (cid && !sc.deletedIds.has(cid)) sc.closedCascadeIds.add(cid);
        }
      }
      if (Array.isArray(raw.closedThreads)) {
        sc.closedThreads = raw.closedThreads
          .filter((t) => t?.cascadeId && !sc.deletedIds.has(normCid(t.cascadeId)))
          .map((t) => hydrateThreadRecord(t, normCid));
        for (const ct of sc.closedThreads) {
          sc.closedCascadeIds.add(ct.cascadeId);
        }
      }
      if (Array.isArray(raw.threads)) {
        sc.threads = raw.threads
          .filter((t) => {
            if (!t?.cascadeId) return false;
            const cid = normCid(t.cascadeId);
            if (sc.deletedIds.has(cid) || sc.closedCascadeIds.has(cid)) return false;
            if (!sc.allowExternal && t.isExternal) {
              sc.externalMetaById.set(cid, { pinned: Boolean(t.pinned) });
              return false;
            }
            return true;
          })
          .map((t) => hydrateThreadRecord(t, normCid));
      }
      if (Array.isArray(raw.poppedIds)) {
        for (const rawPopId of raw.poppedIds) {
          const cid = normCid(rawPopId);
          if (cid && !sc.threads.some((t) => t.cascadeId === cid) && !sc.closedCascadeIds.has(cid)) {
            sc.counter += 1;
            sc.knownHangarIds.add(cid);
            sc.threads.push({
              cascadeId: cid,
              title: ns.readCustomSideChatTitles()[cid] || `Side Question #${sc.threads.length + 1}`,
              parentConversationId: '',
              isExternal: false,
              isRunning: false,
              hasActivity: false,
              pinned: false,
              quotePayload: null,
              nativeLinked: false,
              _lastNativeTitle: '',
            });
          }
        }
      }
      sc.threads = [...sc.threads.filter((t) => t.pinned), ...sc.threads.filter((t) => !t.pinned)];
      Object.assign(sc, {
        counter: Math.max(Number(raw.sideChatCounter) || 0, sc.threads.length + sc.closedThreads.length),
        isDocked: true,
      });
      const candidateActive = legacyPinnedCid || normCid(raw.activeCascadeId || '');
      if (candidateActive && sc.threads.some((t) => t.cascadeId === candidateActive)) {
        sc.activeId = candidateActive;
      } else {
        sc.activeId = sc.threads[0]?.cascadeId || '';
      }
    }
    for (const ut of unpersisted) {
      if (!ut.isExternal) sc.knownHangarIds.add(ut.cascadeId);
      if (!sc.threads.some((t) => t.cascadeId === ut.cascadeId)) {
        sc.threads.push({ ...ut, _createdWsKey: scopeKey || ut._createdWsKey || '' });
      }
    }
    if (unpersisted.length > 0) {
      sc.counter = Math.max(sc.counter, sc.threads.length);
      if (prevActiveId && sc.threads.some((t) => t.cascadeId === prevActiveId)) {
        sc.activeId = prevActiveId;
      } else if (!sc.activeId) {
        sc.activeId = unpersisted[unpersisted.length - 1].cascadeId;
      }
    }
    const pinnedSet = new Set(Array.isArray(layout?.pinnedTabIds) ? layout.pinnedTabIds.map(normScTabId) : []);
    const closedSet = new Set(
      (Array.isArray(layout?.closedTabIds) ? layout.closedTabIds : []).filter((id) => !pinnedSet.has(normScTabId(id)))
    );
    const legacyOrder = !hasWsMap
      ? [
          ...(Array.isArray(layout?.tabOrder) ? layout.tabOrder : []),
          ...(Array.isArray(layout?.topSplitTabIds) ? layout.topSplitTabIds : []),
          rawPinnedTop,
        ].filter((id) => String(id || '').startsWith(LEGACY_SIDECHAT_TAB_PREFIX))
      : [];
    if (legacyOrder.length > 0) {
      for (const tabId of legacyOrder) {
        const cid = normCid(String(tabId).slice(LEGACY_SIDECHAT_TAB_PREFIX.length));
        if (!cid) continue;
        if (!sc.threads.some((t) => t.cascadeId === cid)) {
          sc.counter += 1;
          sc.knownHangarIds.add(cid);
          sc.threads.push({
            cascadeId: cid,
            title: ns.readCustomSideChatTitles()[cid] || `Side Question #${sc.counter}`,
            parentConversationId: '',
            isExternal: false,
            isRunning: false,
            hasActivity: false,
            pinned: false,
            quotePayload: null,
            nativeLinked: false,
            _lastNativeTitle: '',
          });
        }
        if (!legacyPinnedCid) legacyPinnedCid = cid;
      }
      if (legacyPinnedCid && sc.threads.some((t) => t.cascadeId === legacyPinnedCid)) {
        sc.activeId = legacyPinnedCid;
      }
    }
    const pinnedTop = normScTabId(layout?.pinnedTopSidecarId || '');
    const hasAnyVisible = sc.threads.length > 0 || ns.getClosedSideChats().length > 0;
    sc.isOpen = Boolean(
      hadPendingOpen ||
        (hasAnyVisible &&
          !closedSet.has(ns.SIDECHAT_TAB_ID) &&
          (raw?.isOpen !== false || pinnedTop === ns.SIDECHAT_TAB_ID || pinnedSet.has(ns.SIDECHAT_TAB_ID) || Boolean(legacyPinnedCid)))
    );
    if (!sc.activeId && sc.threads.length > 0) {
      sc.activeId = sc.threads[0].cascadeId;
    }
  };

  function applySideQuestionMeta(sideQuestionMeta) {
    if (!sideQuestionMeta || typeof sideQuestionMeta !== 'object') return false;
    const now = Date.now();
    let changed = false;
    for (const t of [...sc.threads, ...sc.closedThreads]) {
      const meta = sideQuestionMeta[t.cascadeId];
      if (!meta || typeof meta !== 'object') continue;
      const metaTitle = String(meta.title || '').replace(/\s+/g, ' ').trim();
      if (t._baselineSteps === undefined) {
        const isStandalone = !t.parentConversationId;
        t._baselineSteps = (t.hasActivity || t.isExternal || isStandalone) ? 0 : (Number(meta.stepCount) || 0);
        t._baselineTitle = (t.hasActivity || t.isExternal || isStandalone) ? '' : metaTitle;
      }
      const nextRun = Boolean(meta.isRunning);
      if (Boolean(t.isRunning) !== nextRun) {
        t.isRunning = nextRun;
        changed = true;
      }
      if (nextRun && !t.hasActivity) {
        t.hasActivity = true;
        changed = true;
      }
      if (typeof meta.stepCount === 'number' && meta.stepCount > t._baselineSteps && !t.hasActivity) {
        t.hasActivity = true;
        changed = true;
      }
      if (metaTitle) {
        if (metaTitle !== t._baselineTitle && !t.hasActivity) {
          t.hasActivity = true;
          changed = true;
        }
        if (!t.nativeLinked && metaTitle !== t._baselineTitle) {
          reconcilePendingRename(t.cascadeId, metaTitle, t, now);
          if (
            !sc.pendingRenames.has(t.cascadeId) &&
            !ns.readCustomSideChatTitles()[t.cascadeId] &&
            metaTitle !== t._lastNativeTitle &&
            metaTitle !== t.title
          ) {
            t.title = metaTitle;
            t._lastNativeTitle = metaTitle;
            changed = true;
          }
        }
      }
    }
    if (changed) {
      const box = sc.boxes.get(ns.SIDECHAT_TAB_ID) || ns._sideChatBox;
      box?._syncPromoteBtn?.();
      box?._syncDeleteBtn?.();
    }
    return changed;
  }
  ns.syncSideQuestionMeta = applySideQuestionMeta;

  ns.syncNativeSideQuestions = function syncNativeSideQuestions(nativePayload, layout = {}, sideQuestionMeta = null) {
    const showExternal = layout?.showExternalSideQuestions !== false;
    sc.allowExternal = showExternal;
    let changed = false;

    if (!showExternal && sc.threads.some((t) => t.isExternal)) {
      const keptHangar = [];
      for (const t of sc.threads) {
        if (t.isExternal) {
          sc.externalMetaById.set(t.cascadeId, { pinned: Boolean(t.pinned) });
          ns.disposeSideChatFrame(t.cascadeId);
          changed = true;
        } else {
          keptHangar.push(t);
        }
      }
      sc.threads = keptHangar;
    }

    const convId = nativePayload && typeof nativePayload === 'object'
      ? String(nativePayload.conversationId || '').trim()
      : '';
    if (convId && convId !== '_new') {
      const cascadeIds = Array.isArray(nativePayload.cascadeIds)
        ? [...new Set(nativePayload.cascadeIds.map((id) => String(id || '').trim()).filter((id) => id && !sc.deletedIds.has(id)))]
        : [];
      const titles = nativePayload.titles && typeof nativePayload.titles === 'object' ? nativePayload.titles : {};
      const idSet = new Set(cascadeIds);
      const prunedNativeIds = [];

      const kept = [];
      for (const t of sc.threads) {
        if (idSet.has(t.cascadeId)) {
          delete t._unpersisted;
          if (sc.knownHangarIds.has(t.cascadeId) && t.isExternal) {
            t.isExternal = false;
            changed = true;
          }
          if (!showExternal && t.isExternal) {
            sc.externalMetaById.set(t.cascadeId, { pinned: Boolean(t.pinned) });
            ns.disposeSideChatFrame(t.cascadeId);
            changed = true;
            continue;
          }
          if (!t.nativeLinked || t.parentConversationId !== convId) {
            t.nativeLinked = true;
            t.parentConversationId = convId;
            changed = true;
          }
          kept.push(t);
          continue;
        }
        if (t?._unpersisted || sc.inFlightStarts.size > 0 || sc.startInFlight) {
          kept.push(t);
          continue;
        }
        if (t.nativeLinked) {
          if (t.parentConversationId === convId) {
            prunedNativeIds.push(t.cascadeId);
            ns.disposeSideChatFrame(t.cascadeId);
            ns.saveCustomSideChatTitle(t.cascadeId, '');
            sc.pendingRenames.delete(t.cascadeId);
            sc.knownHangarIds.delete(t.cascadeId);
            sc.externalMetaById.delete(t.cascadeId);
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

      const keptClosed = [];
      for (const ct of sc.closedThreads) {
        if (!idSet.has(ct.cascadeId) && ct.nativeLinked && ct.parentConversationId === convId) {
          prunedNativeIds.push(ct.cascadeId);
          sc.closedCascadeIds.delete(ct.cascadeId);
          ns.saveCustomSideChatTitle(ct.cascadeId, '');
          sc.knownHangarIds.delete(ct.cascadeId);
          sc.externalMetaById.delete(ct.cascadeId);
          changed = true;
          continue;
        }
        keptClosed.push(ct);
      }
      if (keptClosed.length !== sc.closedThreads.length) {
        sc.closedThreads = keptClosed;
      }

      if (prunedNativeIds.length > 0) {
        ns.apiCall?.('/api/terminal/sidechat/close-stream', {
          cascadeIds: prunedNativeIds,
          markDeleted: true,
        })?.catch?.(() => {});
      }

      const now = Date.now();
      for (const cid of cascadeIds) {
        const nativeTitle = String(titles[cid] || '').replace(/\s+/g, ' ').trim();
        const closedMatch = sc.closedThreads.find((x) => x.cascadeId === cid);
        if (sc.closedCascadeIds.has(cid)) {
          if (closedMatch && nativeTitle && nativeTitle !== closedMatch._lastNativeTitle) {
            reconcilePendingRename(cid, nativeTitle, closedMatch, now);
            if (!sc.pendingRenames.has(cid)) {
              closedMatch.title = nativeTitle;
              closedMatch._lastNativeTitle = nativeTitle;
              changed = true;
            }
          }
          continue;
        }
        const existing = sc.threads.find((x) => x.cascadeId === cid);
        if (!existing) {
          const isExternal = !sc.knownHangarIds.has(cid);
          if (!showExternal && isExternal) continue;
          const savedCustom = ns.readCustomSideChatTitles()[cid] || '';
          const extPref = sc.externalMetaById.get(cid);
          sc.threads.push({
            cascadeId: cid,
            title: nativeTitle || savedCustom || 'Side Question',
            parentConversationId: convId,
            isExternal,
            isRunning: false,
            hasActivity: isExternal || Boolean(nativeTitle),
            pinned: Boolean(extPref?.pinned),
            quotePayload: null,
            nativeLinked: true,
            _lastNativeTitle: nativeTitle,
          });
          changed = true;
        } else {
          reconcilePendingRename(cid, nativeTitle, existing, now);
          if (!sc.pendingRenames.has(cid) && nativeTitle && nativeTitle !== existing._lastNativeTitle) {
            existing.title = nativeTitle;
            existing._lastNativeTitle = nativeTitle;
            existing.hasActivity = true;
            if (ns.readCustomSideChatTitles()[cid] !== undefined) {
              ns.saveCustomSideChatTitle(cid, '');
            }
            changed = true;
          }
        }
      }
    } else if (!changed) {
      return applySideQuestionMeta(sideQuestionMeta);
    }

    if (applySideQuestionMeta(sideQuestionMeta)) {
      changed = true;
    }

    if (sc.threads.some((x) => x.pinned)) {
      sc.threads = [...sc.threads.filter((x) => x.pinned), ...sc.threads.filter((x) => !x.pinned)];
    }
    sc.counter = Math.max(sc.counter, sc.threads.length + sc.closedThreads.length);

    const visibleClosedCount = ns.getClosedSideChats().length;
    if (sc.threads.length === 0 && !sc.inFlightStarts.size && !sc.startInFlight && !sc._pendingOpen) {
      if (sc.activeId) {
        sc.activeId = '';
        changed = true;
      }
      if (sc.isOpen && visibleClosedCount === 0) {
        ns.closeSideChatDrawer?.({ deleteAll: false, notify: false });
        changed = true;
      }
    } else if (sc.threads.length > 0) {
      if (!sc.activeId || !sc.threads.some((x) => x.cascadeId === sc.activeId)) {
        sc.activeId = sc.threads[sc.threads.length - 1].cascadeId;
        changed = true;
      }
      const pinnedSet = new Set(Array.isArray(layout?.pinnedTabIds) ? layout.pinnedTabIds.map(normScTabId) : []);
      const closedSet = new Set(
        (Array.isArray(layout?.closedTabIds) ? layout.closedTabIds : []).filter((id) => !pinnedSet.has(normScTabId(id)))
      );
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
    closedThreads: ns.getClosedSideChats().map((t) => ({ ...t })),
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
    const startWsKey = sc.hydratedWsKey;
    sc._pendingOpen = true;
    const run = (async () => {
      sc.counter += 1;
      const idx = sc.counter;
      let cascadeId = genSideChatUuid();
      let resolvedParentId = String(parentConversationId || '').trim();
      if (resolvedParentId === '_new') resolvedParentId = '';
      let createdRemote = false;
      const hideFromAntigravity = Boolean(sc.hideFromAntigravity);
      try {
        const res = await ns.apiCall?.('/api/terminal/sidechat/start', {
          parentConversationId: resolvedParentId,
          cascadeId,
          hideFromAntigravity,
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
      if (gen !== sc.generation || sc.hydratedWsKey !== startWsKey) {
        if (createdRemote) {
          ns.apiCall?.('/api/terminal/sidechat/delete', { cascadeId })?.catch?.(() => {});
        }
        return null;
      }
      sc.deletedIds.delete(cascadeId);
      sc.closedCascadeIds.delete(cascadeId);
      sc.closedThreads = sc.closedThreads.filter((t) => t.cascadeId !== cascadeId);
      sc.knownHangarIds.add(cascadeId);
      const hasInitialQuote = Boolean(quotePayload && (quotePayload.selectionContent || quotePayload.promptText));
      const existing = sc.threads.find((t) => t.cascadeId === cascadeId);
      if (existing) {
        delete existing._unpersisted;
        existing.isExternal = false;
        if (hasInitialQuote) existing.hasActivity = true;
        if (quotePayload) existing.quotePayload = quotePayload;
        if (labelHint && existing.title === 'Side Question') {
          existing.title = `Side Question #${idx} · ${labelHint}`;
        }
        sc.isOpen = true;
        ns.setActiveSideChatId(cascadeId);
        return existing;
      }
      const thread = {
        cascadeId,
        title: labelHint ? `Side Question #${idx} · ${labelHint}` : `Side Question #${idx}`,
        parentConversationId: resolvedParentId,
        isExternal: false,
        isRunning: false,
        hasActivity: hasInitialQuote,
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
    sc.inFlightStarts.add(run);
    sc.startInFlight = run;
    try {
      return await run;
    } finally {
      sc.inFlightStarts.delete(run);
      sc.startInFlight = sc.inFlightStarts.values().next().value || null;
      if (sc.inFlightStarts.size === 0) {
        sc._pendingOpen = false;
      }
    }
  };

  ns.disposeSideChatFrame = (cid) => {
    ns._onDisposeSideChatFrame?.(cid);
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

  ns.isSideChatNonEmpty = (t) => Boolean(
    t &&
      (t.isExternal ||
        t.hasActivity ||
        t.isRunning ||
        t.quotePayload?.selectionContent ||
        t.quotePayload?.promptText)
  );

  function computeNextActiveId(prevIds, prevAct, remIds) {
    if (!remIds.length) return '';
    const remSet = new Set(remIds);
    if (remSet.has(prevAct)) return prevAct;
    const pIdx = prevIds.indexOf(prevAct);
    return (
      (pIdx >= 0 ? prevIds.slice(pIdx + 1).find((id) => remSet.has(id)) : '') ||
      remIds[remIds.length - 1] ||
      ''
    );
  }

  ns.closeSideChatsByIds = function closeSideChatsByIds(cids = []) {
    const ids = cids.filter(Boolean);
    if (!ids.length) return;
    const closeSet = new Set(ids);
    const box = sc.boxes.get(ns.SIDECHAT_TAB_ID) || ns._sideChatBox;
    box?._closeDeleteConfirm?.();
    const prevIds = sc.threads.map((t) => t.cascadeId);
    const prevAct = sc.activeId || prevIds[0] || '';
    const kept = [];
    for (const t of sc.threads) {
      if (closeSet.has(t.cascadeId)) {
        ns.disposeSideChatFrame(t.cascadeId);
        sc.closedCascadeIds.add(t.cascadeId);
        sc.closedThreads = [
          ...sc.closedThreads.filter((ct) => ct.cascadeId !== t.cascadeId),
          { ...t, isRunning: false, pinned: false, quotePayload: null },
        ];
      } else {
        kept.push(t);
      }
    }
    sc.threads = kept;
    const nextAct = computeNextActiveId(prevIds, prevAct, sc.threads.map((t) => t.cascadeId));
    ns.setActiveSideChatId(nextAct);
    box?._syncThreadsUi?.(nextAct, null);
    ns.notifySideChatState();
  };

  ns.reopenSideChat = function reopenSideChat(cascadeId = '') {
    const cid = String(cascadeId || '').trim();
    if (!cid) return null;
    const closedTh = sc.closedThreads.find((t) => t.cascadeId === cid);
    sc.closedCascadeIds.delete(cid);
    sc.closedThreads = sc.closedThreads.filter((t) => t.cascadeId !== cid);
    let target = sc.threads.find((t) => t.cascadeId === cid);
    if (!target && closedTh) {
      target = { ...closedTh, isRunning: false };
      sc.threads.push(target);
    }
    if (!target) return null;
    sc.isOpen = true;
    ns.setActiveSideChatId(cid);
    const box = sc.boxes.get(ns.SIDECHAT_TAB_ID) || ns._sideChatBox;
    box?._syncThreadsUi?.(cid, null);
    ns.notifySideChatState({ activateTab: true, targetTabId: ns.SIDECHAT_TAB_ID });
    return target;
  };

  function pruneThreadsFromUi(targetIds = [], { deleteRemote = false } = {}) {
    const ids = targetIds.filter(Boolean);
    if (!ids.length) return;
    const rmSet = new Set(ids);
    const box = sc.boxes.get(ns.SIDECHAT_TAB_ID) || ns._sideChatBox;
    box?._closeDeleteConfirm?.();
    for (const cid of ids) {
      const th =
        sc.threads.find((t) => t.cascadeId === cid) ||
        sc.closedThreads.find((t) => t.cascadeId === cid);
      markClientDeletedId(cid);
      sc.pendingRenames.delete(cid);
      sc.knownHangarIds.delete(cid);
      sc.promotingIds.delete(cid);
      sc.closedCascadeIds.delete(cid);
      sc.externalMetaById.delete(cid);
      ns.saveCustomSideChatTitle(cid, '');
      ns.disposeSideChatFrame(cid);
      if (deleteRemote) {
        ns.apiCall?.('/api/terminal/sidechat/delete', {
          cascadeId: cid,
          parentConversationId: th?.parentConversationId || '',
        })?.catch?.(() => {});
      }
    }
    const prevIds = sc.threads.map((t) => t.cascadeId);
    const prevAct = sc.activeId || prevIds[0] || '';
    sc.threads = sc.threads.filter((t) => !rmSet.has(t.cascadeId));
    sc.closedThreads = sc.closedThreads.filter((t) => !rmSet.has(t.cascadeId));
    const remIds = sc.threads.map((t) => t.cascadeId);
    if (!remIds.length && !ns.getClosedSideChats().length) {
      ns.closeSideChatDrawer?.({ deleteAll: false, notify: true });
      return;
    }
    const nextAct = computeNextActiveId(prevIds, prevAct, remIds);
    ns.setActiveSideChatId(nextAct);
    box?._syncThreadsUi?.(nextAct, null);
    ns.notifySideChatState();
  }

  ns.removeSideChatsLocally = (cids = []) => pruneThreadsFromUi(cids, { deleteRemote: false });

  ns.deleteSideChatsByIds = async function deleteSideChatsByIds(cids = []) {
    pruneThreadsFromUi(cids, { deleteRemote: true });
  };

  ns.requestDeleteSideChats = function requestDeleteSideChats(cids = [], opts = {}) {
    const targetIds = cids.filter(Boolean);
    if (!targetIds.length) {
      if (opts.deleteAll) {
        ns.closeSideChatDrawer?.({ deleteAll: true, notify: true });
      }
      return false;
    }
    const targetSet = new Set(targetIds);
    const targets = sc.threads.filter((t) => targetSet.has(t.cascadeId));
    const nonEmpty = targets.filter((t) => ns.isSideChatNonEmpty(t));
    if (nonEmpty.length > 0) {
      let box = sc.boxes.get(ns.SIDECHAT_TAB_ID) || ns._sideChatBox;
      if (!box && typeof document !== 'undefined') {
        const vp = document.getElementById?.('main-viewport');
        if (vp) box = ns.ensureSideChatBox?.(ns.SIDECHAT_TAB_ID, vp);
      }
      if (box) {
        sc.isOpen = true;
        box.classList?.remove?.('hidden');
        if (typeof box._openDeleteConfirm === 'function') {
          box._openDeleteConfirm(targetIds, { deleteAll: Boolean(opts.deleteAll), targets });
          return true;
        }
      }
      if (typeof window.confirm === 'function' && !window.confirm('Delete Side Question? This cannot be undone.')) {
        return true;
      }
    }
    if (opts.deleteAll) {
      ns.closeSideChatDrawer?.({ deleteAll: true, notify: true });
    } else {
      ns.deleteSideChatsByIds(targetIds);
    }
    return false;
  };

  ns.promoteSideChat = async function promoteSideChat(cascadeId) {
    const cid = String(cascadeId || sc.activeId || '').trim();
    const th = sc.threads.find((t) => t.cascadeId === cid);
    if (!cid || !th || th.isRunning || sc.promotingIds.has(cid)) return null;
    const startWsKey = sc.hydratedWsKey;
    sc.promotingIds.add(cid);
    const box = sc.boxes.get(ns.SIDECHAT_TAB_ID) || ns._sideChatBox;
    box?._syncPromoteBtn?.();
    box?._renderSessionStrip?.();
    try {
      const res = await ns.apiCall?.('/api/sidechat/promote', {
        cascadeId: cid,
        parentConversationId: th.parentConversationId || '',
      });
      const newCascadeId = String(res?.newCascadeId || '').trim();
      if (res?.ok === false || !newCascadeId) {
        throw new Error(res?.error || 'Could not promote Side Question');
      }
      sc.promotingIds.delete(cid);
      markClientDeletedId(cid);
      if (sc.hydratedWsKey === startWsKey) {
        ns.removeSideChatsLocally([cid]);
        ns.openHostConversation?.(newCascadeId);
      } else {
        ns.onPrunePromotedWorkspaceThread?.(startWsKey, cid);
      }
      return res;
    } catch (err) {
      sc.promotingIds.delete(cid);
      box?._syncPromoteBtn?.();
      box?._renderSessionStrip?.();
      ns.showTerminalQuoteToast?.(
        box?._toastRoot || box || (typeof document !== 'undefined' ? document.body : null),
        err?.message || 'Failed to promote Side Question',
        true
      );
      return null;
    }
  };

  ns.reorderSideChatThreadsInInstance = (_rootId = '', movedCid = '', targetIndex = 0) => {
    const fromIdx = sc.threads.findIndex((t) => t.cascadeId === movedCid);
    if (fromIdx < 0) return false;
    const [moved] = sc.threads.splice(fromIdx, 1);
    const pinCount = sc.threads.filter((t) => t.pinned).length;
    const clamped = moved.pinned
      ? Math.max(0, Math.min(pinCount, targetIndex))
      : Math.max(pinCount, Math.min(sc.threads.length, targetIndex));
    sc.threads.splice(clamped, 0, moved);
    ns.notifySideChatState();
    return true;
  };
})();
