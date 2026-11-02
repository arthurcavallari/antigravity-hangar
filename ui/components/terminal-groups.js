/** @fileoverview iTerm2-style Terminal TabGroup state model, storage persistence, and drag-and-drop zones. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  ns.TERMINAL_TAB_ID = '__terminal__'; ns.TERMINAL_TAB_PREFIX = 'terminal__';
  ns.isTerminalTabId = (tabId = '') => tabId === ns.TERMINAL_TAB_ID || String(tabId || '').startsWith(ns.TERMINAL_TAB_PREFIX);
  let mainTerminalOpen = false, hydratedTermState = false, isHydratingTerm = false, lastTermStateJson = '', onPersistTermState = null, activeTermWsKey = '';
  const ENGINE_STORAGE_KEY = 'hangar.terminalEngine.v2', POPPED_STORAGE_KEY = 'hangar.poppedTerminalIds', GROUP_STORAGE_KEY = 'hangar.terminalGroupMap', TAB_GROUPS_STORAGE_KEY = 'hangar.terminalTabGroups';
  const resolveInstKey = (id = '__terminal__') => (id === ns.TERMINAL_TAB_ID && activeTermWsKey) ? `${ns.TERMINAL_TAB_ID}@${activeTermWsKey}` : id;
  const readAllStoredGroups = () => { try { const r = JSON.parse(localStorage.getItem(TAB_GROUPS_STORAGE_KEY) || '{}'); return r && typeof r === 'object' ? r : {}; } catch { return {}; } };
  const writeAllStoredGroups = (all) => { try { localStorage.setItem(TAB_GROUPS_STORAGE_KEY, JSON.stringify(all)); } catch {} };
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
    const next = ns.serializeTerminalState(), json = JSON.stringify(next);
    if (json === lastTermStateJson) return;
    lastTermStateJson = json; onPersistTermState(next);
  };
  ns.isMainTerminalOpen = () => mainTerminalOpen;
  ns.setMainTerminalOpen = (v) => { const next = Boolean(v); if (mainTerminalOpen !== next) { mainTerminalOpen = next; notifyTermPersist(); } };
  ns.readEngineMode = () => { try { return localStorage.getItem(ENGINE_STORAGE_KEY) === 'direct' ? 'direct' : 'jetbox'; } catch { return 'jetbox'; } };
  ns.saveEngineMode = (mode) => { try { localStorage.setItem(ENGINE_STORAGE_KEY, mode); } catch {} notifyTermPersist(); };
  ns.readCustomTermTitles = () => { try { const r = JSON.parse(localStorage.getItem('hangar.terminalCustomTitles') || '{}'); return r && typeof r === 'object' ? r : {}; } catch { return {}; } };
  ns.saveCustomTermTitle = (tid, title) => { try { const m = ns.readCustomTermTitles(); if (title) m[tid] = title; else delete m[tid]; localStorage.setItem('hangar.terminalCustomTitles', JSON.stringify(m)); } catch {} notifyTermPersist(); };
  ns.getPoppedTerminalIds = () => { try { const r = JSON.parse(localStorage.getItem(POPPED_STORAGE_KEY) || '[]'); return new Set(Array.isArray(r) ? r : []); } catch { return new Set(); } };
  ns.setPoppedTerminalIds = (idSet) => { try { localStorage.setItem(POPPED_STORAGE_KEY, JSON.stringify([...idSet])); } catch {} notifyTermPersist(); };
  ns.readGroupMap = () => { try { const r = JSON.parse(localStorage.getItem(GROUP_STORAGE_KEY) || '{}'); return r && typeof r === 'object' ? r : {}; } catch { return {}; } };
  ns.saveGroupMap = (map) => { try { localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify(map)); } catch {} notifyTermPersist(); };
  ns.getInstanceTerminals = (allTerminals = [], rootId = '') => { const popped = ns.getPoppedTerminalIds(), groupMap = ns.readGroupMap(); return rootId ? allTerminals.filter((t) => popped.has(rootId) && (t.terminalId === rootId || groupMap[t.terminalId] === rootId)) : allTerminals.filter((t) => !popped.has(t.terminalId) && !popped.has(groupMap[t.terminalId])); };
  ns.formatTermTitle = (raw = '') => {
    const s = String(raw || '').trim().replace(/^(?:Administrator:\s*)/i, '');
    if (!s) return 'pwsh';
    const dash = s.match(/^(?:[A-Za-z]:\\.+\\[^\\]+|Windows PowerShell|PowerShell[^-]*|Command Prompt)\s+-\s+(.+)$/i);
    const target = dash ? dash[1].trim() : s, m = target.match(/^[A-Za-z]:\\.+\\([^\\]+)$/i) || target.match(/^\/.+\/([^/]+)$/);
    return m ? m[1] : target;
  };
  ns.getActiveGroupId = (instanceTabId = '__terminal__') => activeGroupByInstance.get(resolveInstKey(instanceTabId)) || activeGroupByInstance.get(instanceTabId) || '';
  ns.setActiveGroupId = (instanceTabId = '__terminal__', groupId = '') => { const k = resolveInstKey(instanceTabId), prev = activeGroupByInstance.get(k) || ''; if (groupId) { activeGroupByInstance.set(k, groupId); if (!activeTermWsKey) activeGroupByInstance.set(instanceTabId, groupId); } else { activeGroupByInstance.delete(k); if (!activeTermWsKey) activeGroupByInstance.delete(instanceTabId); } if (prev !== (groupId || '')) notifyTermPersist(); };
  ns.readTabGroups = (instanceTabId = '__terminal__') => { const all = readAllStoredGroups(), list = all[resolveInstKey(instanceTabId)] || all[instanceTabId]; return Array.isArray(list) ? list.filter((g) => g && Array.isArray(g.paneIds) && g.paneIds.length > 0) : []; };
  ns.saveTabGroups = (instanceTabId = '__terminal__', groups = []) => { const all = readAllStoredGroups(), k = resolveInstKey(instanceTabId); if (!groups || !groups.length) delete all[k]; else all[k] = groups.map((g) => ({ groupId: g.groupId, paneIds: [...g.paneIds], focusedPaneId: g.focusedPaneId, ...(g.pinned ? { pinned: true } : {}) })); writeAllStoredGroups(all); notifyTermPersist(); };
  ns.migrateTabGroups = function migrateTabGroups(fromTabId, toTabId, paneIdSet) {
    const all = readAllStoredGroups(), fk = resolveInstKey(fromTabId), tk = resolveInstKey(toTabId), fromList = Array.isArray(all[fk] || all[fromTabId]) ? (all[fk] || all[fromTabId]) : [], toList = Array.isArray(all[tk] || all[toTabId]) ? (all[tk] || all[toTabId]) : [], moving = [], staying = [];
    for (const g of fromList) {
      const moved = (g?.paneIds || []).filter((id) => paneIdSet.has(id)), kept = (g?.paneIds || []).filter((id) => !paneIdSet.has(id));
      if (moved.length) moving.push({ groupId: g.groupId || moved[0], paneIds: moved, focusedPaneId: moved.includes(g.focusedPaneId) ? g.focusedPaneId : moved[0], ...(g.pinned ? { pinned: true } : {}) });
      if (kept.length) staying.push({ groupId: g.groupId || kept[0], paneIds: kept, focusedPaneId: kept.includes(g.focusedPaneId) ? g.focusedPaneId : kept[0], ...(g.pinned ? { pinned: true } : {}) });
    }
    if (!staying.length) delete all[fk]; else all[fk] = staying; all[tk] = [...toList, ...moving]; writeAllStoredGroups(all); notifyTermPersist();
  };
  ns.hydrateTerminalStateFromLayout = function hydrateTerminalStateFromLayout(layout = {}, liveTerminals = [], workspacePath = '') {
    isHydratingTerm = true;
    activeTermWsKey = String(workspacePath || '').trim().replace(/\\/g, '/').toLowerCase();
    try {
      const ts = layout?.terminalState;
      if (!hydratedTermState && ts && typeof ts === 'object') {
        hydratedTermState = true;
        if (ts.engineMode === 'direct' || ts.engineMode === 'jetbox') try { localStorage.setItem(ENGINE_STORAGE_KEY, ts.engineMode); } catch {}
        if (Array.isArray(ts.poppedTerminalIds)) try { localStorage.setItem(POPPED_STORAGE_KEY, JSON.stringify(ts.poppedTerminalIds)); } catch {}
        if (ts.terminalGroupMap && typeof ts.terminalGroupMap === 'object') try { localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify(ts.terminalGroupMap)); } catch {}
        if (ts.terminalTabGroups && typeof ts.terminalTabGroups === 'object') writeAllStoredGroups(ts.terminalTabGroups);
        if (ts.terminalCustomTitles && typeof ts.terminalCustomTitles === 'object') try { localStorage.setItem('hangar.terminalCustomTitles', JSON.stringify(ts.terminalCustomTitles)); } catch {}
        if (ts.activeGroupByInstance && typeof ts.activeGroupByInstance === 'object') {
          for (const [k, v] of Object.entries(ts.activeGroupByInstance)) if (v) activeGroupByInstance.set(k, String(v));
        }
        lastTermStateJson = JSON.stringify(ns.serializeTerminalState());
      }
      const showExt = layout?.showExternalTerminals !== false;
      const activeLive = (Array.isArray(liveTerminals) ? liveTerminals : []).filter((t) => t?.terminalId && (showExt || !t.isExternal) && !ns.isTerminalClosing?.(t.terminalId));
      const liveIds = new Set(activeLive.map((t) => t.terminalId));
      const closed = new Set(Array.isArray(layout?.closedTabIds) ? layout.closedTabIds : []);
      if (liveIds.size > 0) {
        const popped = ns.getPoppedTerminalIds(); let poppedChanged = false;
        for (const id of [...(layout?.tabOrder || []), ...(layout?.topSplitTabIds || []), layout?.pinnedTopSidecarId || '']) {
          if (String(id).startsWith(ns.TERMINAL_TAB_PREFIX) && !closed.has(id)) {
            const tid = String(id).slice(ns.TERMINAL_TAB_PREFIX.length);
            if (liveIds.has(tid) && !popped.has(tid)) { popped.add(tid); poppedChanged = true; }
          }
        }
        if (poppedChanged) try { localStorage.setItem(POPPED_STORAGE_KEY, JSON.stringify([...popped])); } catch {}
      }
      const unpopped = ns.getInstanceTerminals(activeLive, '');
      mainTerminalOpen = !closed.has(ns.TERMINAL_TAB_ID) && unpopped.length > 0;
    } finally { isHydratingTerm = false; }
    notifyTermPersist();
  };
  ns.reconcileTabGroups = function reconcileTabGroups(groups = [], validTerminals = [], pendingSplit = null, splitGroupMap = null) {
    const isPending = Boolean(pendingSplit && !(pendingSplit instanceof Map) && (pendingSplit.groupId || pendingSplit.afterPaneId));
    const effSplitMap = splitGroupMap || (!isPending && pendingSplit && typeof pendingSplit === 'object' ? pendingSplit : null), effPending = isPending ? pendingSplit : null, validTerminalIds = [], splitByTid = new Map();
    for (const item of Array.isArray(validTerminals) ? validTerminals : []) {
      const tid = typeof item === 'string' ? item : item?.terminalId; if (!tid) continue; validTerminalIds.push(tid);
      const sg = (typeof item === 'object' && item?.splitGroupId) || (effSplitMap instanceof Map ? effSplitMap.get(tid) : effSplitMap?.[tid]); if (sg) splitByTid.set(tid, String(sg));
    }
    const validSet = new Set(validTerminalIds), seen = new Set(), next = []; let consumedPending = false;
    for (const g of Array.isArray(groups) ? groups : []) {
      const oldPanes = g?.paneIds || [], paneIds = oldPanes.filter((tid) => validSet.has(tid) && !seen.has(tid) && seen.add(tid));
      if (paneIds.length) {
        const fIdx = oldPanes.indexOf(g?.focusedPaneId), focusedPaneId = paneIds.includes(g.focusedPaneId) ? g.focusedPaneId : ((fIdx >= 0 ? oldPanes.slice(fIdx + 1).find((id) => paneIds.includes(id)) : '') || paneIds[fIdx >= 0 ? paneIds.length - 1 : 0]);
        next.push({ groupId: String(g.groupId || paneIds[0]), paneIds, focusedPaneId, ...(g.pinned ? { pinned: true } : {}) });
      }
    }
    for (const tid of validTerminalIds) {
      if (seen.has(tid)) continue; seen.add(tid);
      const sg = splitByTid.get(tid) || '', pTarget = effPending && !consumedPending ? next.find((g) => g.groupId === effPending.groupId || g.paneIds.includes(effPending.afterPaneId)) : null;
      const sgTarget = !pTarget && sg ? next.find((g) => g.groupId === sg || g.paneIds.includes(sg) || g.paneIds.some((pid) => splitByTid.get(pid) === sg)) : null;
      if (pTarget) { pTarget.paneIds.splice(pTarget.paneIds.indexOf(effPending.afterPaneId) >= 0 ? pTarget.paneIds.indexOf(effPending.afterPaneId) + 1 : pTarget.paneIds.length, 0, tid); pTarget.focusedPaneId = tid; consumedPending = true; }
      else if (sgTarget) sgTarget.paneIds.push(tid); else next.push({ groupId: tid, paneIds: [tid], focusedPaneId: tid });
    }
    return { groups: [...next.filter((g) => g.pinned), ...next.filter((g) => !g.pinned)], consumedPending };
  };
  ns.insertSplitPane = function insertSplitPane(groups = [], groupId = '', afterPaneId = '', newPaneId = '') {
    if (!newPaneId) return groups; const cleaned = [];
    for (const g of groups) { const paneIds = (g.paneIds || []).filter((id) => id !== newPaneId); if (paneIds.length) cleaned.push({ ...g, paneIds, focusedPaneId: paneIds.includes(g.focusedPaneId) ? g.focusedPaneId : paneIds[0] }); }
    const target = cleaned.find((g) => g.groupId === groupId || g.paneIds.includes(afterPaneId));
    if (!target) { cleaned.push({ groupId: newPaneId, paneIds: [newPaneId], focusedPaneId: newPaneId }); return cleaned; }
    const idx = target.paneIds.indexOf(afterPaneId); target.paneIds.splice(idx >= 0 ? idx + 1 : target.paneIds.length, 0, newPaneId); target.focusedPaneId = newPaneId; return cleaned;
  };
  ns.applyTerminalDrop = function applyTerminalDrop(groups = [], dragPayload = null, dropTarget = null) {
    if (!dragPayload || !dropTarget) return { groups, activeGroupId: '' };
    const next = groups.map((g) => ({ groupId: g.groupId, paneIds: [...g.paneIds], focusedPaneId: g.focusedPaneId, ...(g.pinned ? { pinned: true } : {}) })), srcGroupIdx = next.findIndex((g) => g.groupId === dragPayload.groupId || g.paneIds.includes(dragPayload.terminalId));
    if (srcGroupIdx < 0) return { groups: next, activeGroupId: '' };
    const srcGroup = next[srcGroupIdx];
    if (dropTarget.zone === 'strip') {
      const rawIdx = typeof dropTarget.index === 'number' ? dropTarget.index : next.length;
      if (dragPayload.kind === 'tab' || srcGroup.paneIds.length <= 1) { const [removed] = next.splice(srcGroupIdx, 1); next.splice(Math.max(0, Math.min(next.length, rawIdx > srcGroupIdx ? rawIdx - 1 : rawIdx)), 0, removed); return { groups: [...next.filter((g) => g.pinned), ...next.filter((g) => !g.pinned)], activeGroupId: removed.groupId }; }
      const tid = dragPayload.terminalId, detached = { groupId: tid, paneIds: [tid], focusedPaneId: tid };
      srcGroup.paneIds = srcGroup.paneIds.filter((id) => id !== tid); if (srcGroup.focusedPaneId === tid) srcGroup.focusedPaneId = srcGroup.paneIds[0] || '';
      next.splice(Math.max(0, Math.min(next.length, rawIdx)), 0, detached); return { groups: [...next.filter((g) => g.pinned), ...next.filter((g) => !g.pinned)], activeGroupId: detached.groupId };
    }
    if (dropTarget.zone === 'pane') {
      const dstGroup = next.find((g) => g.groupId === dropTarget.targetGroupId || g.paneIds.includes(dropTarget.targetPaneId));
      if (!dstGroup || (dragPayload.kind === 'tab' && srcGroup.groupId === dstGroup.groupId) || (dragPayload.kind === 'pane' && dragPayload.terminalId === dropTarget.targetPaneId)) return { groups: next, activeGroupId: dstGroup?.groupId || srcGroup.groupId };
      const movingPanes = dragPayload.kind === 'tab' ? [...srcGroup.paneIds] : [dragPayload.terminalId];
      for (const g of next) { g.paneIds = g.paneIds.filter((id) => !movingPanes.includes(id)); if (!g.paneIds.includes(g.focusedPaneId)) g.focusedPaneId = g.paneIds[0] || ''; }
      const tIdx = dstGroup.paneIds.indexOf(dropTarget.targetPaneId);
      dstGroup.paneIds.splice(tIdx < 0 ? dstGroup.paneIds.length : (dropTarget.side === 'left' ? tIdx : tIdx + 1), 0, ...movingPanes);
      dstGroup.focusedPaneId = movingPanes[0]; return { groups: next.filter((g) => g.paneIds.length > 0), activeGroupId: dstGroup.groupId };
    }
    return { groups: next, activeGroupId: srcGroup.groupId };
  };
  ns.promoteDragToHangarBar = function promoteDragToHangarBar(dragPayload) {
    if (!dragPayload?.terminalId) return null;
    const srcTabId = dragPayload.instanceTabId || ns.TERMINAL_TAB_ID, srcGroups = ns.readTabGroups(srcTabId);
    const srcGrp = srcGroups.find((g) => g.groupId === dragPayload.groupId || g.paneIds.includes(dragPayload.terminalId));
    const movingPanes = dragPayload.kind === 'tab' && srcGrp ? [...srcGrp.paneIds] : [dragPayload.terminalId], moveSet = new Set(movingPanes), stayingGroups = [];
    for (const g of srcGroups) {
      const kept = (g.paneIds || []).filter((id) => !moveSet.has(id));
      if (kept.length) stayingGroups.push({ groupId: kept.includes(g.groupId) ? g.groupId : kept[0], paneIds: kept, focusedPaneId: kept.includes(g.focusedPaneId) ? g.focusedPaneId : kept[0] });
    }
    const popped = ns.getPoppedTerminalIds(), groupMap = ns.readGroupMap();
    if (srcTabId.startsWith(ns.TERMINAL_TAB_PREFIX)) {
      const srcRoot = srcTabId.slice(ns.TERMINAL_TAB_PREFIX.length);
      for (const id of [srcRoot, ...Object.keys(groupMap).filter((k) => groupMap[k] === srcRoot)].filter((id) => !moveSet.has(id) && !stayingGroups.some((g) => g.paneIds.includes(id)))) stayingGroups.push({ groupId: id, paneIds: [id], focusedPaneId: id });
    }
    const remainingPanes = stayingGroups.flatMap((g) => g.paneIds);
    if (srcTabId.startsWith(ns.TERMINAL_TAB_PREFIX) && !remainingPanes.length) return { newSidecarId: srcTabId, replacedSidecarId: null };
    let replacedSidecarId = null;
    if (srcTabId.startsWith(ns.TERMINAL_TAB_PREFIX) && moveSet.has(srcTabId.slice(ns.TERMINAL_TAB_PREFIX.length))) {
      const srcRoot = srcTabId.slice(ns.TERMINAL_TAB_PREFIX.length), nextSrcRoot = remainingPanes[0], nextSrcTabId = ns.TERMINAL_TAB_PREFIX + nextSrcRoot;
      const ordered = [...popped].map((id) => (id === srcRoot ? nextSrcRoot : id)); popped.clear(); ordered.forEach((id) => popped.add(id));
      delete groupMap[nextSrcRoot];
      for (const remId of remainingPanes.slice(1)) groupMap[remId] = nextSrcRoot;
      ns.saveTabGroups(srcTabId, []); ns.saveTabGroups(nextSrcTabId, stayingGroups);
      ns.disposeTerminalInstance?.(srcTabId); replacedSidecarId = { from: srcTabId, to: nextSrcTabId };
    } else ns.saveTabGroups(srcTabId, stayingGroups);
    const newRoot = movingPanes[0], newSidecarId = ns.TERMINAL_TAB_PREFIX + newRoot;
    popped.add(newRoot); delete groupMap[newRoot];
    for (const sibId of movingPanes.slice(1)) groupMap[sibId] = newRoot;
    ns.setPoppedTerminalIds(popped); ns.saveGroupMap(groupMap);
    ns.saveTabGroups(newSidecarId, [{ groupId: newRoot, paneIds: movingPanes, focusedPaneId: moveSet.has(dragPayload.terminalId) ? dragPayload.terminalId : newRoot }]);
    return { newSidecarId, replacedSidecarId };
  };
  ns.demoteHangarTabIntoInstance = function demoteHangarTabIntoInstance(sourceSidecarId, dropTarget = {}) {
    const targetInstanceTabId = dropTarget.targetInstanceTabId || ns.TERMINAL_TAB_ID;
    if (sourceSidecarId === targetInstanceTabId) return false;
    if (sourceSidecarId === ns.TERMINAL_TAB_ID && String(targetInstanceTabId).startsWith(ns.TERMINAL_TAB_PREFIX)) return ns.demoteHangarTabIntoInstance(targetInstanceTabId, { ...dropTarget, targetInstanceTabId: ns.TERMINAL_TAB_ID });
    if (!String(sourceSidecarId || '').startsWith(ns.TERMINAL_TAB_PREFIX)) return false;
    const rootId = sourceSidecarId.slice(ns.TERMINAL_TAB_PREFIX.length), popped = ns.getPoppedTerminalIds(), groupMap = ns.readGroupMap();
    const srcGroups = ns.readTabGroups(sourceSidecarId), groupedPanes = srcGroups.flatMap((g) => g.paneIds || []);
    const mapPanes = [rootId, ...Object.keys(groupMap).filter((k) => groupMap[k] === rootId)];
    const allSourcePanes = [...groupedPanes, ...mapPanes.filter((id) => !groupedPanes.includes(id))], srcSet = new Set(allSourcePanes);
    popped.delete(rootId);
    if (targetInstanceTabId === ns.TERMINAL_TAB_ID) {
      mainTerminalOpen = true;
      for (const tid of allSourcePanes) delete groupMap[tid];
      for (const [k, v] of Object.entries(groupMap)) { if (v === rootId) delete groupMap[k]; }
    } else if (targetInstanceTabId.startsWith(ns.TERMINAL_TAB_PREFIX)) {
      const otherRoot = targetInstanceTabId.slice(ns.TERMINAL_TAB_PREFIX.length);
      for (const tid of allSourcePanes) { if (tid === otherRoot) delete groupMap[tid]; else groupMap[tid] = otherRoot; }
    }
    ns.setPoppedTerminalIds(popped); ns.saveGroupMap(groupMap);
    const dstGroups = [];
    for (const g of ns.readTabGroups(targetInstanceTabId)) {
      const pIds = (g.paneIds || []).filter((id) => !srcSet.has(id));
      if (pIds.length) dstGroups.push({ groupId: g.groupId, paneIds: pIds, focusedPaneId: pIds.includes(g.focusedPaneId) ? g.focusedPaneId : pIds[0] });
    }
    if (dropTarget.zone === 'pane' && dropTarget.targetPaneId) {
      const dstGrp = dstGroups.find((g) => g.paneIds.includes(dropTarget.targetPaneId)) || dstGroups[0];
      if (!dstGrp) dstGroups.push({ groupId: allSourcePanes[0], paneIds: [...allSourcePanes], focusedPaneId: allSourcePanes[0] });
      else { const tIdx = dstGrp.paneIds.indexOf(dropTarget.targetPaneId); dstGrp.paneIds.splice(tIdx < 0 ? dstGrp.paneIds.length : (dropTarget.side === 'left' ? tIdx : tIdx + 1), 0, ...allSourcePanes); dstGrp.focusedPaneId = allSourcePanes[0]; }
    } else {
      const movingGroups = srcGroups.length ? srcGroups : [{ groupId: rootId, paneIds: allSourcePanes, focusedPaneId: rootId }];
      dstGroups.splice(typeof dropTarget.index === 'number' ? Math.max(0, Math.min(dstGroups.length, dropTarget.index)) : dstGroups.length, 0, ...movingGroups);
    }
    ns.saveTabGroups(sourceSidecarId, []); ns.saveTabGroups(targetInstanceTabId, dstGroups);
    ns.disposeTerminalInstance?.(sourceSidecarId); ns.focusTerminalInInstance?.(targetInstanceTabId, allSourcePanes[0]);
    return true;
  };
  ns.mergeTermDragIntoInstance = function mergeTermDragIntoInstance(drag, dropTarget = {}) {
    if (!drag?.terminalId || !dropTarget?.targetInstanceTabId || drag.instanceTabId === dropTarget.targetInstanceTabId) return null;
    const prom = ns.promoteDragToHangarBar(drag); if (!prom?.newSidecarId) return null;
    let finalTargetId = dropTarget.targetInstanceTabId, removedSidecarId = prom.newSidecarId, replacedSidecarId = prom.replacedSidecarId;
    ns.demoteHangarTabIntoInstance(prom.newSidecarId, dropTarget);
    if (drag.instanceTabId === ns.TERMINAL_TAB_ID && finalTargetId.startsWith(ns.TERMINAL_TAB_PREFIX) && !ns.readTabGroups(ns.TERMINAL_TAB_ID).length) {
      ns.demoteHangarTabIntoInstance(finalTargetId, { targetInstanceTabId: ns.TERMINAL_TAB_ID, zone: 'strip' });
      ns.focusTerminalInInstance?.(ns.TERMINAL_TAB_ID, drag.terminalId);
      removedSidecarId = finalTargetId; replacedSidecarId = { from: finalTargetId, to: ns.TERMINAL_TAB_ID }; finalTargetId = ns.TERMINAL_TAB_ID;
    }
    return { removedSidecarId, replacedSidecarId, targetInstanceTabId: finalTargetId, targetPane: dropTarget.pane || '' };
  };
  let hangarDropCfg = {}; ns.activeTermDrag = null;
  ns.setTabShift = (el, px = 0) => { if (!el) return; el._shiftX = px || 0; if (el.style) el.style.transform = px ? `translateX(${px}px)` : ''; };
  ns.getUnshiftedRect = (el) => { const r = el.getBoundingClientRect(), tx = el._shiftX || 0; return tx ? { left: r.left - tx, right: r.right - tx, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : r; };
  ns.clearAllTermDropIndicators = () => {
    ns.activeTermDrag = null; document.body?.classList?.remove('dragging-tab');
    document.querySelectorAll?.('.drop-left, .drop-right, .drop-target, .is-dragging, .merge-drop-target, .split-drop-target').forEach((el) => el.classList?.remove('drop-left', 'drop-right', 'drop-target', 'is-dragging', 'merge-drop-target', 'split-drop-target'));
    if (!ns.isPointerOnTab) document.querySelectorAll?.('.agy-tab').forEach((el) => ns.setTabShift(el, 0));
  };
  ns.bindHangarChromeDropZone = function bindHangarChromeDropZone(cfg = {}) { hangarDropCfg = { ...hangarDropCfg, ...cfg }; };
  ns.getHangarDropCfg = () => hangarDropCfg;
  ns.measurePillStrip = function measurePillStrip(sourceStrip, btn, startX, startY, selector = '.agy-tab') {
    if (window.AgyUI?.measureStrip) {
      return window.AgyUI.measureStrip(sourceStrip, btn, startX, startY, selector);
    }
    return ns.measureStrip ? ns.measureStrip(sourceStrip, btn, startX, startY, selector) : null;
  };
  ns.bindGroupPillDrag = function bindGroupPillDrag(el, cfg = {}) {
    return ns.bindTermPointerDrag(el, cfg);
  };
  ns.bindTermPointerDrag = function bindTermPointerDrag(el, cfg) {
    let activePointerId = null, startX = 0, startY = 0, isDragging = false, ghostEl = null, dragMeta = null, dropAction = null, hoverTimer = null, hoverTargetId = '', previewedTargetId = '';
    const clearHover = (resetPreview, slot) => { if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; } hoverTargetId = ''; if (resetPreview && previewedTargetId) { previewedTargetId = ''; hangarDropCfg.onPreviewTerminalSlot?.('', slot); } };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target?.closest?.('[data-close-gid], [data-pin-gid], .agy-tab-pin, [data-role="tab-pin"], [data-role="tab-close"], .agy-tab-close-wrap, [data-role="pane-close"], .agy-rename-input')) return;
      ns.clearAllTermDropIndicators(); clearHover(false); previewedTargetId = ''; activePointerId = e.pointerId; ns.isPointerOnTab = true; ns.pointerTermInstanceId = cfg.instanceTabId;
      startX = e.clientX; startY = e.clientY; isDragging = false; ghostEl = null; dragMeta = null; dropAction = null; el.setPointerCapture?.(e.pointerId);
      window.addEventListener?.('pointerup', onWinPointerEnd, true); window.addEventListener?.('pointercancel', onWinPointerCancel, true);
    });
    el.addEventListener('pointermove', (e) => {
      if (activePointerId !== e.pointerId) return;
      const { kind, groupId, terminalId, instanceTabId, sessionsEl, stageEl, getActiveGroupId, getSlotKey, getTitle } = cfg;
      const curGid = typeof groupId === 'function' ? groupId() : groupId, sourceSlot = getSlotKey?.() || 'top';
      if (!isDragging && Math.hypot(e.clientX - startX, e.clientY - startY) > 4) {
        isDragging = true; ns.activeTermDrag = { kind, groupId: curGid, terminalId, instanceTabId, sourceSlot }; document.body?.classList?.add('dragging-tab');
        dragMeta = ns.measurePillStrip(sessionsEl, el, startX, startY, '.agy-tab');
        if (kind === 'tab') {
          el.classList.add('is-dragging-source'); ghostEl = el.cloneNode(true); ghostEl.className = 'agy-tab active agy-tab-drag-ghost';
          ghostEl.style.width = `${dragMeta.draggedWidth}px`; ghostEl.style.height = `${dragMeta.draggedHeight}px`;
        } else {
          dragMeta.locked = false; el.classList.add('is-dragging'); ghostEl = document.createElement('div'); ghostEl.className = 'agy-tab active agy-tab-drag-ghost';
          ghostEl.innerHTML = `${ns.iconSvg?.('terminal', 13) || ''}<span class="agy-tab-label">${ns.escHtml?.(getTitle?.() || 'pwsh') || 'pwsh'}</span>`;
          dragMeta.grabOffsetX = 36; dragMeta.grabOffsetY = 11; dragMeta.draggedWidth = 96; dragMeta.draggedHeight = 22;
        }
        document.body?.appendChild(ghostEl);
      }
      if (!isDragging || !ghostEl || !dragMeta) return;
      document.querySelectorAll?.('.drop-left, .drop-right, .drop-target, .merge-drop-target, .split-drop-target').forEach((n) => n.classList?.remove('drop-left', 'drop-right', 'drop-target', 'merge-drop-target', 'split-drop-target'));
      document.querySelectorAll?.('.agy-tab').forEach((n) => ns.setTabShift(n, 0));
      const sRect = sessionsEl?.getBoundingClientRect?.() || { left: 0, right: 0, top: 0, bottom: 0 }, nextLocked = kind === 'tab' && dragMeta.draggedIndex >= 0 && e.clientY >= sRect.top - 18 && e.clientY <= sRect.bottom + 18;
      if (nextLocked !== dragMeta.locked) { dragMeta.locked = nextLocked; dragMeta.lockChangedAt = Date.now(); }
      const rawLeft = e.clientX - dragMeta.grabOffsetX, left = dragMeta.locked ? Math.min(Math.max(rawLeft, dragMeta.minLeft), dragMeta.maxLeft) : rawLeft;
      ghostEl.style.transition = dragMeta.lockChangedAt && Date.now() - dragMeta.lockChangedAt < 120 ? 'top 120ms ease-out, left 120ms ease-out' : '';
      ghostEl.style.left = `${left}px`; ghostEl.style.top = `${dragMeta.locked ? dragMeta.originalTop : e.clientY - dragMeta.grabOffsetY}px`;
      if (dragMeta.locked) {
        clearHover(true, sourceSlot);
        if (sessionsEl.scrollWidth > sessionsEl.clientWidth) { if (e.clientX < sRect.left + 26) sessionsEl.scrollLeft -= 8; else if (e.clientX > sRect.right - 26) sessionsEl.scrollLeft += 8; }
        const x = e.clientX - dragMeta.grabOffsetX + dragMeta.draggedWidth / 2, scrollDelta = (sessionsEl.scrollLeft || 0) - dragMeta.startScrollLeft;
        const pinnedCount = dragMeta.sourceTabs.filter((t) => t.dataset?.pinned === 'true').length, isPin = el.dataset?.pinned === 'true';
        let dropIdx = dragMeta.draggedIndex;
        for (let i = 0; i < dragMeta.centers.length; i++) {
          const c = dragMeta.centers[i] - scrollDelta, span = dragMeta.draggedWidth * 0.5;
          if (i < dragMeta.draggedIndex && x < c + span) dropIdx = Math.min(dropIdx, i); else if (i > dragMeta.draggedIndex && x > c - span) dropIdx = Math.max(dropIdx, i);
        }
        dropIdx = isPin ? Math.min(dropIdx, Math.max(0, pinnedCount - 1)) : Math.max(dropIdx, pinnedCount);
        dragMeta.sourceTabs.forEach((sib, i) => { if (i !== dragMeta.draggedIndex) ns.setTabShift(sib, (dragMeta.draggedIndex < dropIdx && i > dragMeta.draggedIndex && i <= dropIdx) ? -dragMeta.draggedSlot : (dragMeta.draggedIndex > dropIdx && i >= dropIdx && i < dragMeta.draggedIndex) ? dragMeta.draggedSlot : 0); });
        dropAction = { type: 'same', target: { zone: 'strip', index: dropIdx > dragMeta.draggedIndex ? dropIdx + 1 : dropIdx } }; return;
      }
      dragMeta.sourceTabs.forEach((sib, i) => { if (i > dragMeta.draggedIndex) ns.setTabShift(sib, -dragMeta.draggedSlot); });
      const ownTRect = (sessionsEl?.closest?.('.term-toolbar') || sessionsEl)?.getBoundingClientRect?.();
      if (kind === 'pane' && ownTRect && e.clientX >= ownTRect.left && e.clientX <= ownTRect.right && e.clientY >= ownTRect.top - 10 && e.clientY <= ownTRect.bottom + 10) {
        clearHover(true, sourceSlot); sessionsEl?.classList?.add('drop-target');
        let idx = dragMeta.sourceTabs.length;
        for (let i = 0; i < dragMeta.sourceTabs.length; i++) { const r = ns.getUnshiftedRect(dragMeta.sourceTabs[i]); if (e.clientX < r.left + r.width / 2) { idx = i; break; } }
        dragMeta.sourceTabs.forEach((p, i) => ns.setTabShift(p, i >= idx ? 68 : 0)); dropAction = { type: 'same', target: { zone: 'strip', index: idx } }; return;
      }
      const splitEnabled = Boolean(hangarDropCfg.bottomBarEl && !hangarDropCfg.bottomBarEl.classList.contains('hidden'));
      const mergeHit = ns.inspectHangarPointerOverTerminal(e.clientX, e.clientY, instanceTabId, true);
      if (mergeHit) {
        if (mergeHit.zone === 'hub-tab' && mergeHit.pane !== 'single' && mergeHit.pane !== sourceSlot && hoverTargetId !== mergeHit.targetInstanceTabId) {
          clearHover(false); hoverTargetId = mergeHit.targetInstanceTabId;
          hoverTimer = setTimeout(() => { hoverTimer = null; previewedTargetId = mergeHit.targetInstanceTabId; hangarDropCfg.onPreviewTerminalSlot?.(mergeHit.targetInstanceTabId, mergeHit.pane); }, 350);
        } else if (mergeHit.zone !== 'hub-tab') clearHover(false);
        dropAction = { type: 'merge', target: mergeHit }; return;
      }
      clearHover(true, sourceSlot);
      const activeGid = getActiveGroupId?.() || '';
      if (!(kind === 'tab' && curGid === activeGid)) {
        for (const pEl of stageEl?.querySelectorAll?.('.term-pane[data-terminal-id]') || []) {
          if (pEl.classList?.contains?.('hidden')) continue;
          const pid = pEl.dataset.terminalId, pRect = pEl.getBoundingClientRect();
          if (pid && !(kind === 'pane' && pid === terminalId) && pRect.width > 0 && e.clientX >= pRect.left && e.clientX <= pRect.right && e.clientY >= pRect.top && e.clientY <= pRect.bottom) {
            const side = (e.clientX - pRect.left) < pRect.width / 2 ? 'left' : 'right';
            pEl.classList.toggle('drop-left', side === 'left'); pEl.classList.toggle('drop-right', side === 'right');
            dropAction = { type: 'same', target: { zone: 'pane', targetGroupId: activeGid, targetPaneId: pid, side } }; return;
          }
        }
      }
      const cRect = hangarDropCfg.chromeBarEl?.getBoundingClientRect?.(), bRect = splitEnabled ? hangarDropCfg.bottomBarEl?.getBoundingClientRect?.() : null;
      const inChrome = Boolean(cRect && cRect.height > 0 && e.clientY >= cRect.top - 14 && e.clientY <= cRect.bottom + 4), inBottomBar = Boolean(bRect && bRect.height > 0 && e.clientY >= bRect.top - 14 && e.clientY <= bRect.bottom + 4);
      const hRect = splitEnabled ? document.getElementById('split-resize-handle')?.getBoundingClientRect?.() : null, pointerSlot = !splitEnabled ? 'top' : (e.clientY < (hRect ? hRect.top + hRect.height / 2 : window.innerHeight / 2) ? 'top' : 'bottom');
      if (inChrome || inBottomBar || (splitEnabled && pointerSlot !== sourceSlot)) {
        const pane = inChrome ? 'top' : inBottomBar ? 'bottom' : pointerSlot, tabs = Array.from(document.getElementById(pane === 'bottom' ? 'bottom-tab-strip' : 'tab-strip')?.querySelectorAll('.agy-tab[data-sidecar-id]') || []);
        let beforeTabId = null;
        if (inChrome || inBottomBar) {
          for (const t of tabs) { const r = ns.getUnshiftedRect(t); if (beforeTabId === null && e.clientX < r.left + r.width * (ns.isTerminalTabId(t.dataset.sidecarId) ? 0.12 : 0.5)) beforeTabId = t.dataset.sidecarId; }
          let shifted = false; for (const sib of tabs) { if (sib.dataset.sidecarId === beforeTabId) shifted = true; ns.setTabShift(sib, shifted ? 72 : 0); }
        }
        (pane === 'bottom' ? hangarDropCfg.bottomBarEl : hangarDropCfg.chromeBarEl)?.classList.add('split-drop-target');
        if (splitEnabled && !inChrome && !inBottomBar) document.querySelector(pane === 'bottom' ? '.slot-bottom:not(.hidden)' : '.slot-top:not(.hidden)')?.classList.add('split-drop-target');
        dropAction = { type: 'promote', pane: splitEnabled ? pane : 'single', beforeTabId }; return;
      }
      dropAction = null;
    });
    const endPointer = (e, cancelled = false) => {
      if (activePointerId !== e.pointerId) return;
      window.removeEventListener?.('pointerup', onWinPointerEnd, true); window.removeEventListener?.('pointercancel', onWinPointerCancel, true);
      const wasDragging = isDragging, drag = ns.activeTermDrag, finalAction = dropAction, slot = cfg.getSlotKey?.() || 'top';
      activePointerId = null; isDragging = false; dropAction = null; ns.isPointerOnTab = false; ns.pointerTermInstanceId = '';
      try { if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId); } catch {}
      if (ghostEl) { ghostEl.remove?.(); ghostEl = null; }
      el.classList.remove('is-dragging-source', 'is-dragging'); document.querySelectorAll?.('.agy-tab').forEach((n) => { n.classList.remove('is-dragging-source'); ns.setTabShift(n, 0); }); ns.clearAllTermDropIndicators();
      if (cancelled || !wasDragging || !finalAction) { clearHover(true, slot); if (!cancelled && !wasDragging) { el.scrollIntoView?.({ inline: 'nearest', block: 'nearest', behavior: 'smooth' }); cfg.onClick?.(); } return; }
      if (finalAction.type === 'same') { clearHover(true, slot); cfg.onSameInstanceDrop?.(drag, finalAction.target); }
      else if (finalAction.type === 'merge') { clearHover(false); previewedTargetId = ''; const res = ns.mergeTermDragIntoInstance(drag, finalAction.target); if (res) hangarDropCfg.onMergeIntoTerminalTab?.(res); else hangarDropCfg.onPreviewTerminalSlot?.('', slot); }
      else if (finalAction.type === 'promote') { clearHover(true, slot); const res = ns.promoteDragToHangarBar(drag); if (res?.newSidecarId) hangarDropCfg.onPromoteToHangarTab?.({ sidecarId: res.newSidecarId, replacedSidecarId: res.replacedSidecarId, targetPane: finalAction.pane, beforeTabId: finalAction.beforeTabId }); }
    };
    const onWinPointerEnd = (e) => endPointer(e, false), onWinPointerCancel = (e) => endPointer(e, true);
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((evt) => el.addEventListener(evt, (e) => endPointer(e, evt !== 'pointerup')));
  };
  ns.inspectHangarPointerOverTerminal = function inspectHangarPointerOverTerminal(clientX, clientY, draggedSidecarId, checkShells = true) {
    document.querySelectorAll?.('.merge-drop-target, .drop-target, .drop-left, .drop-right').forEach((el) => el.classList?.remove('merge-drop-target', 'drop-target', 'drop-left', 'drop-right'));
    for (const shell of document.querySelectorAll?.('.term-shell[data-instance-tab-id]') || []) {
      if (shell.dataset.instanceTabId !== draggedSidecarId) {
        shell.querySelectorAll?.('.agy-tab[data-term-tid]:not(.is-dragging-source)').forEach((el) => ns.setTabShift(el, 0));
      }
    }
    if (!ns.isTerminalTabId(draggedSidecarId)) return null;
    const srcEl = document.querySelector?.(`.agy-tab[data-sidecar-id="${draggedSidecarId}"]`), srcR = srcEl ? ns.getUnshiftedRect(srcEl) : null;
    for (const el of document.querySelectorAll?.('.agy-tab[data-sidecar-id]') || []) {
      const sid = el.dataset.sidecarId, r = ns.getUnshiftedRect(el);
      if (!sid || sid === draggedSidecarId || !ns.isTerminalTabId(sid) || r.width <= 0 || clientY < r.top - 18 || clientY > r.bottom + (! checkShells ? 18 : 4)) continue;
      const same = srcEl && srcEl.parentElement === el.parentElement, lPad = same && srcR && srcR.left < r.left ? 0 : r.width * 0.12, rPad = same && srcR && srcR.left > r.left ? 0 : r.width * 0.12;
      if (clientX >= r.left + lPad && clientX <= r.right - rPad) { el.classList.add('merge-drop-target'); return { targetInstanceTabId: sid, zone: 'hub-tab', pane: el.dataset.pane || 'single' }; }
    }
    if (!checkShells) return null;
    for (const shell of document.querySelectorAll?.('.term-shell[data-instance-tab-id]') || []) {
      const targetInstanceTabId = shell.dataset.instanceTabId, sRect = shell.getBoundingClientRect();
      if (!targetInstanceTabId || targetInstanceTabId === draggedSidecarId || shell.closest?.('.hidden') || sRect.width === 0 || clientX < sRect.left || clientX > sRect.right || clientY < sRect.top || clientY > sRect.bottom) continue;
      const pane = shell.closest?.('#terminal-bottom-view') ? 'bottom' : 'top', strip = shell.querySelector('.agy-tab-strip'), tRect = (shell.querySelector('.term-toolbar') || strip)?.getBoundingClientRect();
      shell.classList.add('drop-target'); strip?.classList.add('drop-target');
      const pills = Array.from(strip?.querySelectorAll('.agy-tab[data-term-tid]') || []); let index = pills.length;
      if (tRect && clientY <= tRect.bottom + 10) {
        for (let i = 0; i < pills.length; i++) { const pr = ns.getUnshiftedRect(pills[i]); if (clientX < pr.left + pr.width / 2) { index = i; break; } }
        pills.forEach((p, i) => ns.setTabShift(p, i >= index ? 68 : 0));
      }
      return { targetInstanceTabId, zone: 'strip', index, pane };
    }
    return null;
  };
})();
