/** @fileoverview iTerm2-style Terminal TabGroup state model, storage persistence, and reconciliation. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  ns.TERMINAL_TAB_ID = '__terminal__';
  ns.TERMINAL_TAB_PREFIX = 'terminal__';
  ns.isTerminalTabId = (tabId = '') => tabId === ns.TERMINAL_TAB_ID || String(tabId || '').startsWith(ns.TERMINAL_TAB_PREFIX);
  let mainTerminalOpen = false, hydratedTermState = false, isHydratingTerm = false, lastTermStateJson = '', onPersistTermState = null, activeTermWsKey = '';
  const ENGINE_STORAGE_KEY = 'hangar.terminalEngine.v2', POPPED_STORAGE_KEY = 'hangar.poppedTerminalIds', GROUP_STORAGE_KEY = 'hangar.terminalGroupMap', TAB_GROUPS_STORAGE_KEY = 'hangar.terminalTabGroups';
  const resolveInstKey = (id = '__terminal__') => (id === ns.TERMINAL_TAB_ID && activeTermWsKey) ? `${ns.TERMINAL_TAB_ID}@${activeTermWsKey}` : id;
  const readJson = (key, fb) => { try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fb)) || fb; } catch { return fb; } };
  const writeJson = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ } };
  const readAllStoredGroups = () => readJson(TAB_GROUPS_STORAGE_KEY, {});
  const writeAllStoredGroups = (all) => writeJson(TAB_GROUPS_STORAGE_KEY, all);
  const activeGroupByInstance = new Map();
  ns.setTerminalPersistCallback = (fn) => { onPersistTermState = typeof fn === 'function' ? fn : null; };
  ns.serializeTerminalState = () => ({
    mainTerminalOpen: Boolean(mainTerminalOpen), engineMode: ns.readEngineMode(),
    poppedTerminalIds: [...ns.getPoppedTerminalIds()], terminalGroupMap: ns.readGroupMap(),
    terminalTabGroups: readAllStoredGroups(), terminalCustomTitles: ns.readCustomTermTitles(),
    activeGroupByInstance: Object.fromEntries(activeGroupByInstance.entries()),
  });
  const notifyTermPersist = () => {
    if (isHydratingTerm || !onPersistTermState) return;
    const next = ns.serializeTerminalState();
    const json = JSON.stringify(next);
    if (json === lastTermStateJson) return;
    lastTermStateJson = json;
    onPersistTermState(next);
  };
  ns.isMainTerminalOpen = () => mainTerminalOpen;
  ns.setMainTerminalOpen = (v) => {
    const next = Boolean(v);
    if (mainTerminalOpen === next) return;
    mainTerminalOpen = next;
    notifyTermPersist();
  };
  ns.readEngineMode = () => { try { return localStorage.getItem(ENGINE_STORAGE_KEY) === 'direct' ? 'direct' : 'jetbox'; } catch { return 'jetbox'; } };
  ns.saveEngineMode = (mode) => {
    try { localStorage.setItem(ENGINE_STORAGE_KEY, mode); } catch { /* ignore */ }
    notifyTermPersist();
  };
  ns.readCustomTermTitles = () => readJson('hangar.terminalCustomTitles', {});
  ns.saveCustomTermTitle = (tid, title) => {
    const m = ns.readCustomTermTitles();
    if (title) m[tid] = title;
    else delete m[tid];
    writeJson('hangar.terminalCustomTitles', m);
    notifyTermPersist();
  };
  ns.getPoppedTerminalIds = () => {
    const r = readJson(POPPED_STORAGE_KEY, []);
    return new Set(Array.isArray(r) ? r : []);
  };
  ns.setPoppedTerminalIds = (idSet) => {
    writeJson(POPPED_STORAGE_KEY, [...idSet]);
    notifyTermPersist();
  };
  ns.readGroupMap = () => readJson(GROUP_STORAGE_KEY, {});
  ns.saveGroupMap = (map) => {
    writeJson(GROUP_STORAGE_KEY, map);
    notifyTermPersist();
  };
  ns.getInstanceTerminals = (allTerminals = [], rootId = '') => {
    const popped = ns.getPoppedTerminalIds(), groupMap = ns.readGroupMap();
    return rootId
      ? allTerminals.filter((t) => popped.has(rootId) && (t.terminalId === rootId || groupMap[t.terminalId] === rootId))
      : allTerminals.filter((t) => !popped.has(t.terminalId) && !popped.has(groupMap[t.terminalId]));
  };
  ns.formatTermTitle = (raw = '') => {
    const s = String(raw || '').trim().replace(/^(?:Administrator:\s*)/i, '');
    if (!s) return 'pwsh';
    const dash = s.match(/^(?:[A-Za-z]:\\.+\\[^\\]+|Windows PowerShell|PowerShell[^-]*|Command Prompt)\s+-\s+(.+)$/i);
    const target = dash ? dash[1].trim() : s;
    const m = target.match(/^[A-Za-z]:\\.+\\([^\\]+)$/i) || target.match(/^\/.+\/([^/]+)$/);
    return m ? m[1] : target;
  };
  ns.getActiveGroupId = (instanceTabId = '__terminal__') => activeGroupByInstance.get(resolveInstKey(instanceTabId)) || activeGroupByInstance.get(instanceTabId) || '';
  ns.setActiveGroupId = (instanceTabId = '__terminal__', groupId = '') => {
    const k = resolveInstKey(instanceTabId);
    const prev = activeGroupByInstance.get(k) || '';
    if (groupId) activeGroupByInstance.set(k, groupId);
    else activeGroupByInstance.delete(k);
    if (!activeTermWsKey && groupId) activeGroupByInstance.set(instanceTabId, groupId);
    else if (!activeTermWsKey) activeGroupByInstance.delete(instanceTabId);
    if (prev !== (groupId || '')) notifyTermPersist();
  };
  ns.readTabGroups = (instanceTabId = '__terminal__') => {
    const all = readAllStoredGroups();
    const list = all[resolveInstKey(instanceTabId)] || all[instanceTabId];
    return Array.isArray(list) ? list.filter((g) => g && Array.isArray(g.paneIds) && g.paneIds.length > 0) : [];
  };
  ns.saveTabGroups = (instanceTabId = '__terminal__', groups = []) => {
    const all = readAllStoredGroups(), k = resolveInstKey(instanceTabId);
    if (!groups || !groups.length) delete all[k];
    else all[k] = groups.map((g) => ({ groupId: g.groupId, paneIds: [...g.paneIds], focusedPaneId: g.focusedPaneId, ...(g.pinned ? { pinned: true } : {}) }));
    writeAllStoredGroups(all);
    notifyTermPersist();
  };
  ns.migrateTabGroups = function migrateTabGroups(fromTabId, toTabId, paneIdSet) {
    const all = readAllStoredGroups(), fk = resolveInstKey(fromTabId), tk = resolveInstKey(toTabId);
    const fromList = Array.isArray(all[fk] || all[fromTabId]) ? (all[fk] || all[fromTabId]) : [], toList = Array.isArray(all[tk] || all[toTabId]) ? (all[tk] || all[toTabId]) : [], moving = [], staying = [];
    for (const g of fromList) {
      const moved = (g?.paneIds || []).filter((id) => paneIdSet.has(id)), kept = (g?.paneIds || []).filter((id) => !paneIdSet.has(id));
      if (moved.length) moving.push({ groupId: g.groupId || moved[0], paneIds: moved, focusedPaneId: moved.includes(g.focusedPaneId) ? g.focusedPaneId : moved[0], ...(g.pinned ? { pinned: true } : {}) });
      if (kept.length) staying.push({ groupId: g.groupId || kept[0], paneIds: kept, focusedPaneId: kept.includes(g.focusedPaneId) ? g.focusedPaneId : kept[0], ...(g.pinned ? { pinned: true } : {}) });
    }
    if (!staying.length) delete all[fk];
    else all[fk] = staying;
    all[tk] = [...toList, ...moving];
    writeAllStoredGroups(all);
    notifyTermPersist();
  };
  ns.hydrateTerminalStateFromLayout = function hydrateTerminalStateFromLayout(layout = {}, liveTerminals = [], workspacePath = '') {
    isHydratingTerm = true;
    activeTermWsKey = String(workspacePath || '').trim().replace(/\\/g, '/').toLowerCase();
    try {
      const ts = layout?.terminalState;
      if (!hydratedTermState && ts && typeof ts === 'object') {
        hydratedTermState = true;
        if (ts.engineMode === 'direct' || ts.engineMode === 'jetbox') try { localStorage.setItem(ENGINE_STORAGE_KEY, ts.engineMode); } catch { /* ignore */ }
        if (Array.isArray(ts.poppedTerminalIds)) writeJson(POPPED_STORAGE_KEY, ts.poppedTerminalIds);
        if (ts.terminalGroupMap && typeof ts.terminalGroupMap === 'object') writeJson(GROUP_STORAGE_KEY, ts.terminalGroupMap);
        if (ts.terminalTabGroups && typeof ts.terminalTabGroups === 'object') writeAllStoredGroups(ts.terminalTabGroups);
        if (ts.terminalCustomTitles && typeof ts.terminalCustomTitles === 'object') writeJson('hangar.terminalCustomTitles', ts.terminalCustomTitles);
        if (ts.activeGroupByInstance && typeof ts.activeGroupByInstance === 'object') {
          Object.entries(ts.activeGroupByInstance).forEach(([k, v]) => v && activeGroupByInstance.set(k, String(v)));
        }
        lastTermStateJson = JSON.stringify(ns.serializeTerminalState());
      }
      const showExt = layout?.showExternalTerminals !== false;
      const activeLive = (Array.isArray(liveTerminals) ? liveTerminals : []).filter((t) => t?.terminalId && (showExt || !t.isExternal) && !ns.isTerminalClosing?.(t.terminalId));
      const liveIds = new Set(activeLive.map((t) => t.terminalId)), closed = new Set(Array.isArray(layout?.closedTabIds) ? layout.closedTabIds : []);
      if (liveIds.size > 0) {
        const popped = ns.getPoppedTerminalIds();
        let poppedChanged = false;
        for (const id of [...(layout?.tabOrder || []), ...(layout?.topSplitTabIds || []), layout?.pinnedTopSidecarId || '']) {
          if (!String(id).startsWith(ns.TERMINAL_TAB_PREFIX) || closed.has(id)) continue;
          const tid = String(id).slice(ns.TERMINAL_TAB_PREFIX.length);
          if (liveIds.has(tid) && !popped.has(tid)) poppedChanged = Boolean(popped.add(tid));
        }
        if (poppedChanged) writeJson(POPPED_STORAGE_KEY, [...popped]);
      }
      mainTerminalOpen = !closed.has(ns.TERMINAL_TAB_ID) && ns.getInstanceTerminals(activeLive, '').length > 0;
    } finally {
      isHydratingTerm = false;
    }
    notifyTermPersist();
  };
  ns.reconcileTabGroups = function reconcileTabGroups(groups = [], validTerminals = [], pendingSplit = null, splitGroupMap = null) {
    const isPending = Boolean(pendingSplit && !(pendingSplit instanceof Map) && (pendingSplit.groupId || pendingSplit.afterPaneId));
    const effSplitMap = splitGroupMap || (!isPending && pendingSplit && typeof pendingSplit === 'object' ? pendingSplit : null), effPending = isPending ? pendingSplit : null, validTerminalIds = [], splitByTid = new Map();
    for (const item of Array.isArray(validTerminals) ? validTerminals : []) {
      const tid = typeof item === 'string' ? item : item?.terminalId;
      if (!tid) continue;
      validTerminalIds.push(tid);
      const sg = (typeof item === 'object' && item?.splitGroupId) || (effSplitMap instanceof Map ? effSplitMap.get(tid) : effSplitMap?.[tid]);
      if (sg) splitByTid.set(tid, String(sg));
    }
    const validSet = new Set(validTerminalIds), seen = new Set(), next = [];
    let consumedPending = false;
    for (const g of Array.isArray(groups) ? groups : []) {
      const oldPanes = g?.paneIds || [];
      const paneIds = oldPanes.filter((tid) => validSet.has(tid) && !seen.has(tid) && seen.add(tid));
      if (!paneIds.length) continue;
      const fIdx = oldPanes.indexOf(g?.focusedPaneId);
      const focusedPaneId = paneIds.includes(g.focusedPaneId) ? g.focusedPaneId : ((fIdx >= 0 ? oldPanes.slice(fIdx + 1).find((id) => paneIds.includes(id)) : '') || paneIds[fIdx >= 0 ? paneIds.length - 1 : 0]);
      next.push({ groupId: String(g.groupId || paneIds[0]), paneIds, focusedPaneId, ...(g.pinned ? { pinned: true } : {}) });
    }
    for (const tid of validTerminalIds) {
      if (seen.has(tid)) continue;
      seen.add(tid);
      const sg = splitByTid.get(tid) || '';
      const pTarget = effPending && !consumedPending ? next.find((g) => g.groupId === effPending.groupId || g.paneIds.includes(effPending.afterPaneId)) : null;
      const sgTarget = !pTarget && sg ? next.find((g) => g.groupId === sg || g.paneIds.includes(sg) || g.paneIds.some((pid) => splitByTid.get(pid) === sg)) : null;
      if (pTarget) {
        pTarget.paneIds.splice(pTarget.paneIds.indexOf(effPending.afterPaneId) >= 0 ? pTarget.paneIds.indexOf(effPending.afterPaneId) + 1 : pTarget.paneIds.length, 0, tid);
        pTarget.focusedPaneId = tid;
        consumedPending = true;
      } else if (sgTarget) sgTarget.paneIds.push(tid);
      else next.push({ groupId: tid, paneIds: [tid], focusedPaneId: tid });
    }
    return { groups: [...next.filter((g) => g.pinned), ...next.filter((g) => !g.pinned)], consumedPending };
  };
  ns.insertSplitPane = function insertSplitPane(groups = [], groupId = '', afterPaneId = '', newPaneId = '') {
    if (!newPaneId) return groups;
    const cleaned = [];
    for (const g of groups) {
      const paneIds = (g.paneIds || []).filter((id) => id !== newPaneId);
      if (paneIds.length) cleaned.push({ ...g, paneIds, focusedPaneId: paneIds.includes(g.focusedPaneId) ? g.focusedPaneId : paneIds[0] });
    }
    const target = cleaned.find((g) => g.groupId === groupId || g.paneIds.includes(afterPaneId));
    if (!target) return [...cleaned, { groupId: newPaneId, paneIds: [newPaneId], focusedPaneId: newPaneId }];
    const idx = target.paneIds.indexOf(afterPaneId);
    target.paneIds.splice(idx >= 0 ? idx + 1 : target.paneIds.length, 0, newPaneId);
    target.focusedPaneId = newPaneId;
    return cleaned;
  };
  ns._closeInstanceTerminalsByIds = async function closeInstanceTerminalsByIds(tids, ctx) {
    const targetIds = (tids || []).filter(Boolean);
    if (!targetIds.length) return;
    const { rootId, instanceTabId, slotKey, getTerminals, setTerminals, normalizeGroupState, refreshView, getActiveTid, focusPane, callbacks } = ctx;
    const popped = ns.getPoppedTerminalIds(), groupMap = ns.readGroupMap(), rmSet = new Set(targetIds);
    ns._disposeTermPanes?.(targetIds, groupMap);
    const remTerms = getTerminals().filter((t) => !rmSet.has(t.terminalId));
    setTerminals(remTerms);
    if (!rootId && !remTerms.length) ns.setMainTerminalOpen?.(false);
    normalizeGroupState();
    const notifyRemoved = (removedSidecarId, replacedSidecarId = null, targetInstanceTabId = '') => (
      callbacks().onCrossInstanceMerge
        ? callbacks().onCrossInstanceMerge({ removedSidecarId, replacedSidecarId, targetInstanceTabId, targetPane: slotKey() })
        : callbacks().onSelectTab?.(targetInstanceTabId, slotKey())
    );
    if (rootId && !remTerms.length) {
      popped.delete(rootId);
      Object.entries(groupMap).forEach(([k, v]) => v === rootId && delete groupMap[k]);
      ns.setPoppedTerminalIds(popped);
      ns.saveGroupMap(groupMap);
      notifyRemoved(instanceTabId);
    } else if (rootId && rmSet.has(rootId)) {
      const nextRoot = remTerms[0].terminalId, nextTabId = `${ns.TERMINAL_TAB_PREFIX}${remTerms[0].terminalId}`;
      delete groupMap[nextRoot];
      Object.entries(groupMap).forEach(([k, v]) => { if (v === rootId) groupMap[k] = nextRoot; });
      ns.setPoppedTerminalIds(new Set([...popped].map((id) => (id === rootId ? nextRoot : id))));
      ns.saveGroupMap(groupMap);
      ns.migrateTabGroups(instanceTabId, nextTabId, new Set(remTerms.map((t) => t.terminalId)));
      notifyRemoved('', { from: instanceTabId, to: nextTabId }, nextTabId);
    } else {
      if (!rootId) targetIds.forEach((tid) => popped.delete(tid));
      if (!rootId) ns.setPoppedTerminalIds(popped);
      ns.saveGroupMap(groupMap);
      if (!rootId && !remTerms.length) notifyRemoved(ns.TERMINAL_TAB_ID);
    }
    refreshView();
    if (getActiveTid()) focusPane(getActiveTid());
    await ns._closeTerminalsOnServer?.(targetIds);
    await callbacks().onRefreshState?.();
  };
})();
