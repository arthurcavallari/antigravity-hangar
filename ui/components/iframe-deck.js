/** @fileoverview Persistent child sidecar iframes, postMessage relay, and cross-pane tab drag controller. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  const deckFrames = new Map();
  let latestThemeEvent = null;
  let latestWorkspaceEvent = null;
  let lastConfigThemeSig = '';
  let hasLiveHostTheme = false;
  ns.getLatestThemeEvent = () => latestThemeEvent;
  ns.VISIBILITY_MESSAGE_TYPE = 'sidecar-visibility';

  function broadcastToChildFrames(messageData) {
    if (!messageData) return;
    const extra = typeof document.querySelectorAll === 'function'
      ? document.querySelectorAll('.term-jetbox-frame, .term-sidechat-frame')
      : [];
    for (const frame of [...deckFrames.values(), ...extra]) {
      try {
        frame.contentWindow?.postMessage(messageData, '*');
      } catch {
        /* ignore */
      }
    }
  }

  ns.applyThemePayload = function applyThemePayload(payload, fromHostMessage = false) {
    if (!payload || typeof payload.cssVariables !== 'object') return;
    if (fromHostMessage) {
      hasLiveHostTheme = true;
    } else {
      if (hasLiveHostTheme) return;
      const sig = JSON.stringify(payload.cssVariables);
      if (sig === lastConfigThemeSig && latestThemeEvent) return;
      lastConfigThemeSig = sig;
    }
    const rootStyle = document.documentElement.style;
    const hasHostFollowVars = Boolean(
      payload.cssVariables['--background'] ||
      payload.cssVariables['--foreground'] ||
      payload.cssVariables['--card'],
    );
    for (const [key, val] of Object.entries(payload.cssVariables)) {
      if (!val) continue;
      if (hasHostFollowVars && key.startsWith('--agy-')) {
        rootStyle.removeProperty?.(key);
      } else {
        rootStyle.setProperty(key, val);
      }
    }
    const isLight = payload.themeType === 'light' || payload.isDark === false;
    if (document.documentElement?.dataset) {
      document.documentElement.dataset.theme = isLight ? 'light' : 'dark';
    }
    rootStyle.colorScheme = isLight ? 'light' : 'dark';
    (ns.applyAgyThemeFromPayload || window.AgyShell?.applyAgyThemeFromPayload)?.(payload);
    if (document.body) {
      document.body.style.fontFamily = payload.cssVariables['--vscode-font-family'] ||
        'var(--font-sans, var(--vscode-font-family, system-ui, sans-serif))';
      document.body.classList.toggle('theme-light', isLight);
      document.body.classList.toggle('theme-dark', !isLight);
    }
    latestThemeEvent = { type: 'theme-change', payload };
    broadcastToChildFrames(latestThemeEvent);
  };

  const isFromChildFrame = (src) => Boolean(src && [...deckFrames.values()].some((f) => f.contentWindow === src));

  ns.initPostMessageRelayBridge = function initPostMessageRelayBridge() {
    window.addEventListener('message', (event) => {
      const type = event.data?.type;
      if (!type) return;
      const isToggle = type === 'toggle-aux-pane' || type === 'toggle-conversation';
      if (isToggle ? !isFromChildFrame(event.source) : !ns.isHostMessage(event.source)) return;
      if (type === 'theme-change' && event.data?.payload) {
        ns.applyThemePayload(event.data.payload, true);
      } else if (type === 'workspace-change') {
        latestWorkspaceEvent = event.data;
        broadcastToChildFrames(event.data);
      } else if (isToggle && window.parent && window.parent !== window) {
        window.parent.postMessage(event.data, '*');
      }
    });
  };

  function postFrameVisibility(frame) {
    try {
      frame.contentWindow?.postMessage(
        { type: ns.VISIBILITY_MESSAGE_TYPE, payload: { visible: frame.dataset.visible === '1' } },
        '*',
      );
    } catch {
      /* ignore */
    }
  }

  function setFrameVisibility(frame, visible) {
    const next = visible ? '1' : '0';
    if (frame.dataset.visible === next) return;
    frame.dataset.visible = next;
    postFrameVisibility(frame);
  }

  ns.syncDeckVisibility = function syncDeckVisibility() {
    const hostHidden = Boolean(ns.isHostHidden?.());
    for (const frame of deckFrames.values()) {
      const inSlot = Boolean(frame.classList?.contains?.('visible'));
      setFrameVisibility(frame, inSlot && !hostHidden);
    }
  };

  function stripConversationParam(rawUrl = '') {
    try {
      const parsed = new URL(rawUrl);
      parsed.searchParams.delete('conversationId');
      return parsed.toString();
    } catch {
      return rawUrl;
    }
  }

  ns.clampSplitHeight = (rawPx) => Math.max(
    80,
    Math.min(Math.max(120, (window.innerHeight || 600) - 150), Math.round(Number(rawPx) || 185)),
  );

  function cleanupAllDragGhosts() {
    Object.assign(ns, { isPointerOnTab: false, pointerTermInstanceId: '', pointerSideChatInstanceId: '' });
    ns.clearAllTermDropIndicators?.();
    document.querySelectorAll?.('.agy-tab-drag-ghost').forEach((el) => el.remove());
    document.querySelectorAll?.('.agy-tab').forEach((el) => {
      el.classList.remove('is-dragging-source', 'merge-drop-target');
      ns.setTabShift?.(el, 0);
    });
    document.body?.classList?.remove('dragging-tab');
    document.querySelectorAll?.('.split-drop-target').forEach((el) => el.classList.remove('split-drop-target'));
  }

  window.addEventListener?.('blur', cleanupAllDragGhosts);

  ns.bindHangarTabDrag = function bindHangarTabDrag(btn, sc) {
    const d = { pane: 'single', beforeId: null, drop: null, timer: null, hoverId: '', previewId: '' };
    const clearHover = () => {
      if (d.timer) clearTimeout(d.timer);
      Object.assign(d, { timer: null, hoverId: '' });
    };
    window.AgyUI?.bindTabDragController?.(btn, {
      tabSelector: '.agy-tab[data-sidecar-id]',
      pinnedRole: 'hub-add-tab',
      onDragStart: () => {
        ns.isPointerOnTab = true;
        Object.assign(d, { pane: btn._opts?.pane || 'single', beforeId: null, drop: null });
      },
      shouldDetach: (e) => {
        const pane = btn._opts?.pane || 'single';
        const splitEnabled = Boolean(btn._opts?.splitEnabled);
        const curId = btn._sc?.sidecarId || sc.sidecarId;
        const handleRect = splitEnabled ? document.getElementById('split-resize-handle')?.getBoundingClientRect() : null;
        const midY = handleRect ? handleRect.top + handleRect.height / 2 : window.innerHeight / 2;
        d.pane = !splitEnabled ? 'single' : (e.clientY < midY ? 'top' : 'bottom');
        d.drop = btn._sc?.isTerminal
          ? ns.inspectHangarPointerOverTerminal?.(e.clientX, e.clientY, curId, d.pane !== pane)
          : (btn._sc?.isSideChat ? ns.inspectHangarPointerOverSideChat?.(e.clientX, e.clientY, curId, d.pane !== pane) : null);
        return Boolean(d.drop || d.pane !== pane);
      },
      getMergeSpanFactor: (sib) => (
        (btn._sc?.isTerminal && sib?._sc?.isTerminal) || (btn._sc?.isSideChat && sib?._sc?.isSideChat) ? 0.12 : 1.0
      ),
      onOutOfRailMove: (e, dragState) => {
        document.querySelectorAll('.split-drop-target').forEach((el) => el.classList.remove('split-drop-target'));
        if (d.drop) {
          if (d.drop.zone === 'hub-tab' && d.hoverId !== d.drop.targetInstanceTabId) {
            clearHover();
            d.hoverId = d.drop.targetInstanceTabId;
            d.timer = setTimeout(() => {
              Object.assign(d, { timer: null, previewId: d.drop.targetInstanceTabId });
              btn._opts?.onPreviewTerminalSlot?.(d.drop.targetInstanceTabId, d.drop.pane);
            }, 350);
          } else if (d.drop.zone !== 'hub-tab') {
            clearHover();
          }
          return;
        }
        clearHover();
        if (d.previewId) {
          d.previewId = '';
          btn._opts?.onPreviewTerminalSlot?.('', btn._opts?.pane || 'single');
        }
        const tBar = document.getElementById(d.pane === 'top' ? 'chrome-bar' : 'bottom-tab-bar');
        const tRect = tBar?.getBoundingClientRect();
        const inBar = !tRect || !tRect.height || (e.clientY >= tRect.top - 14 && e.clientY <= tRect.bottom + 4);
        const isPin = Boolean(btn._sc?.isPinned);
        d.beforeId = null;
        const targetStrip = document.getElementById(d.pane === 'top' ? 'tab-strip' : 'bottom-tab-strip');
        Array.from(targetStrip?.querySelectorAll('.agy-tab[data-sidecar-id]') || []).forEach((sib) => {
          const sibPin = sib.dataset.pinned === 'true';
          const r = ns.getUnshiftedRect ? ns.getUnshiftedRect(sib) : sib.getBoundingClientRect();
          const sameKind = (btn._sc?.isTerminal && ns.isTerminalTabId?.(sib.dataset.sidecarId)) ||
            (btn._sc?.isSideChat && ns.isSideChatTabId?.(sib.dataset.sidecarId));
          const beforeSib = (isPin && !sibPin) || (isPin === sibPin && e.clientX < r.left + r.width * (sameKind ? 0.12 : 0.5));
          if (inBar && d.beforeId === null && beforeSib) {
            d.beforeId = sib.dataset.sidecarId;
          }
          ns.setTabShift?.(sib, inBar && d.beforeId !== null ? dragState.draggedSlot : 0);
        });
        tBar?.classList.add('split-drop-target');
        if (!inBar) {
          document.querySelector(d.pane === 'top' ? '.slot-top:not(.hidden)' : '.slot-bottom:not(.hidden)')?.classList.add('split-drop-target');
        }
      },
      onClearPreview: () => {
        clearHover();
        cleanupAllDragGhosts();
      },
      onDrop: (_e, dragState, cancelled) => {
        const pane = btn._opts?.pane || 'single';
        const curId = btn._sc?.sidecarId || sc.sidecarId;
        if (cancelled) {
          btn._opts?.onPreviewTerminalSlot?.('', pane);
          return;
        }
        if (d.drop && btn._opts?.onDropIntoTerminal) {
          btn._opts.onDropIntoTerminal({ sourceSidecarId: curId, ...d.drop });
          return;
        }
        if (dragState?.locked) {
          const otherIds = dragState.sourceTabs
            .filter((_, idx) => idx !== dragState.draggedIndex)
            .map((el) => el.dataset.sidecarId);
          const rawDropIdx = dragState.dropIdx ?? dragState.draggedIndex;
          const toIdx = rawDropIdx > dragState.draggedIndex ? rawDropIdx - 1 : rawDropIdx;
          d.beforeId = toIdx < otherIds.length ? otherIds[toIdx] : null;
        }
        btn._opts?.onDropTab?.({ sidecarId: curId, sourcePane: pane, targetPane: d.pane, beforeTabId: d.beforeId });
      },
    });
  };

  ns.reconcileIframeDeck = function reconcileIframeDeck({ state, els, onRefreshState }) {
    const splitEnabled = Boolean(state.layout?.splitViewEnabled);
    const { bottomTabs, activeSingleId, activeTopId } = ns.partitionSplitTabs(
      state.sidecars || [],
      state.layout,
      state.terminals || [],
    );
    els.mainViewport.classList.toggle('is-split', splitEnabled);
    els.splitDividerGroup?.classList.toggle('hidden', !splitEnabled);
    if (splitEnabled && !state.isResizingSplit) {
      els.mainViewport.style.setProperty('--split-top-height', `${ns.clampSplitHeight(state.layout?.pinnedTopHeightPx)}px`);
    }
    const bottomIds = new Set(bottomTabs.map((s) => s.sidecarId));
    const isSpecialBottom =
      (state.layout?.terminalDisplayMode === 'button' && state.bottomActiveTabId === ns.TERMINAL_TAB_ID && (typeof ns.isMainTerminalOpen === 'function' ? ns.isMainTerminalOpen() : true)) ||
      (state.layout?.extensionsDisplayMode === 'button' && state.bottomActiveTabId === ns.EXTENSIONS_TAB_ID);
    if (splitEnabled && (!state.bottomActiveTabId || (!bottomIds.has(state.bottomActiveTabId) && !isSpecialBottom))) {
      state.bottomActiveTabId = bottomTabs[0]?.sidecarId || '';
    }
    const topSlotId = splitEnabled ? activeTopId : activeSingleId;
    const bottomSlotId = splitEnabled ? state.bottomActiveTabId : '';
    for (const sc of state.sidecars || []) {
      if (!sc.matchesWorkspace || !sc.isRunning || !sc.iframeUrl) {
        deckFrames.get(sc.sidecarId)?.remove();
        deckFrames.delete(sc.sidecarId);
        continue;
      }
      const baseKey = stripConversationParam(sc.iframeUrl);
      const frameTitle = `${sc.displayName || sc.sidecarId} Sidecar`;
      let frame = deckFrames.get(sc.sidecarId);
      if (!frame) {
        frame = Object.assign(document.createElement('iframe'), {
          className: 'child-sidecar-frame',
          src: sc.iframeUrl,
          title: frameTitle,
        });
        frame.setAttribute?.('title', frameTitle);
        Object.assign(frame.dataset, { sidecarId: sc.sidecarId, baseKey, loadedUrl: sc.iframeUrl });
        frame.addEventListener('load', () => {
          if (latestThemeEvent) frame.contentWindow?.postMessage(latestThemeEvent, '*');
          if (latestWorkspaceEvent) frame.contentWindow?.postMessage(latestWorkspaceEvent, '*');
          postFrameVisibility(frame);
        });
        els.mainViewport.appendChild(frame);
        deckFrames.set(sc.sidecarId, frame);
      } else {
        if (frame.title !== frameTitle) {
          frame.title = frameTitle;
          frame.setAttribute?.('title', frameTitle);
        }
        if (frame.dataset.baseKey !== baseKey) {
          Object.assign(frame.dataset, { baseKey, loadedUrl: sc.iframeUrl });
          frame.src = sc.iframeUrl;
        } else if (frame.dataset.loadedUrl !== sc.iframeUrl) {
          frame.dataset.loadedUrl = sc.iframeUrl;
          try {
            const convId = new URL(sc.iframeUrl).searchParams.get('conversationId') || '';
            frame.contentWindow?.postMessage({ type: 'conversation-change', payload: { conversationId: convId } }, '*');
          } catch {
            /* ignore */
          }
        }
      }
      const isTop = sc.sidecarId === topSlotId;
      const isBottom = splitEnabled && sc.sidecarId === bottomSlotId;
      frame.classList.toggle('visible', isTop || isBottom);
      frame.classList.toggle('slot-top', isTop);
      frame.classList.toggle('slot-bottom', isBottom);
      setFrameVisibility(frame, (isTop || isBottom) && !ns.isHostHidden?.());
    }
    const storeInTop = topSlotId === ns.EXTENSIONS_TAB_ID;
    const storeInBottom = splitEnabled && bottomSlotId === ns.EXTENSIONS_TAB_ID;
    els.storeView.classList.toggle('hidden', !storeInTop && !storeInBottom);
    els.storeView.classList.toggle('slot-top', storeInTop);
    els.storeView.classList.toggle('slot-bottom', storeInBottom);
    const syncEmpty = (emptyEl, mounted, slotId, label) => {
      if (!emptyEl) return;
      emptyEl.classList.toggle('hidden', Boolean(mounted));
      if (!mounted) {
        const msg = slotId
          ? 'Sidecar is hibernated or stopped — enable it in 🧩 Extensions'
          : `No tab in ${label} — drag a tab here`;
        const sig = `${slotId || ''}::${msg}`;
        if (emptyEl.dataset.msg !== sig) {
          emptyEl.dataset.msg = sig;
          ns.setHtml(emptyEl, ns.html`
            <div class="empty-split-zone">
              <span>${ns.escHtml(msg)}</span>
              ${slotId ? ns.html`
                <button type="button" class="agy-btn agy-btn-primary has-icon" data-role="enable-sidecar" data-sidecar-id="${ns.escHtml(slotId)}">
                  ${ns.iconSvg('play_arrow', 14)}
                  <span>Enable Sidecar</span>
                </button>
              ` : ''}
            </div>
          `);
          const enableBtn = emptyEl.querySelector?.('[data-role="enable-sidecar"]');
          enableBtn?.addEventListener?.('click', async () => {
            if (enableBtn.disabled) return;
            enableBtn.disabled = true;
            try {
              await ns.apiCall?.('/api/sidecar/manage', {
                sidecarId: slotId,
                action: 'SIDECAR_ACTION_ENABLE',
              });
              await onRefreshState?.();
            } finally {
              enableBtn.disabled = false;
            }
          });
        }
      }
    };
    const hasTop = storeInTop ||
      Boolean(ns.isTerminalTabId?.(topSlotId)) ||
      Boolean(ns.isSideChatTabId?.(topSlotId)) ||
      (topSlotId && deckFrames.has(topSlotId));
    const hasBot = !splitEnabled ||
      storeInBottom ||
      Boolean(ns.isTerminalTabId?.(bottomSlotId)) ||
      Boolean(ns.isSideChatTabId?.(bottomSlotId)) ||
      (bottomSlotId && deckFrames.has(bottomSlotId));
    syncEmpty(els.emptyTopState, hasTop, topSlotId, 'Top Split');
    syncEmpty(els.emptyDeckState, hasBot, bottomSlotId, 'Bottom Split');
  };
})();
