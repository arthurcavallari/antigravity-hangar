/**
 * @fileoverview Manages persistent child sidecar iframes in a single DOM container,
 * postMessage relay bridge, and split-pane sash pointer resize handling.
 */

(function () {
  const ns = (window.Hangar = window.Hangar || {});

  const deckFrames = new Map(); // sidecarId -> HTMLIFrameElement
  let latestThemeEvent = null;
  let latestWorkspaceEvent = null;
  let lastConfigThemeSig = '';

  function broadcastToChildFrames(messageData) {
    if (!messageData) return;
    for (const frame of deckFrames.values()) {
      try {
        frame.contentWindow?.postMessage(messageData, '*');
      } catch {
        // Ignore unmounted frame errors
      }
    }
  }

  ns.applyThemePayload = function applyThemePayload(payload, fromHostMessage = false) {
    if (!payload || typeof payload.cssVariables !== 'object') return;
    if (!fromHostMessage) {
      const sig = JSON.stringify(payload.cssVariables);
      if (sig === lastConfigThemeSig && latestThemeEvent) return;
      lastConfigThemeSig = sig;
    }
    const rootStyle = document.documentElement.style;
    for (const [key, val] of Object.entries(payload.cssVariables)) {
      if (val) rootStyle.setProperty(key, val);
    }
    const isLight = payload.themeType === 'light' || payload.isDark === false;
    rootStyle.colorScheme = isLight ? 'light' : 'dark';
    if (document.body) {
      document.body.style.fontFamily =
        payload.cssVariables['--vscode-font-family'] ||
        'var(--font-sans, var(--vscode-font-family, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif))';
      document.body.classList.toggle('theme-light', isLight);
      document.body.classList.toggle('theme-dark', !isLight);
    }

    latestThemeEvent = { type: 'theme-change', payload };
    broadcastToChildFrames(latestThemeEvent);
  };

  function isFromChildFrame(source) {
    for (const frame of deckFrames.values()) {
      if (source && frame.contentWindow === source) return true;
    }
    return false;
  }

  ns.initPostMessageRelayBridge = function initPostMessageRelayBridge() {
    window.addEventListener('message', (event) => {
      const type = event.data?.type;
      if (!type) return;

      // Only child sidecars may ask the host to toggle panes; only the host may broadcast state to them
      const isToggle = type === 'toggle-aux-pane' || type === 'toggle-conversation';
      if (isToggle ? !isFromChildFrame(event.source) : !ns.isHostMessage(event.source)) return;

      if (type === 'theme-change' && event.data?.payload) {
        ns.applyThemePayload(event.data.payload, true);
      } else if (type === 'workspace-change') {
        latestWorkspaceEvent = event.data;
        broadcastToChildFrames(event.data);
      } else if (type === 'toggle-aux-pane' || type === 'toggle-conversation') {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage(event.data, '*');
        }
      }
    });
  };

  // Hidden deck frames stay mounted so tab switches are instant, but hiding them with CSS leaves
  // their document.hidden false. Tell each child when it is shown or hidden so it can pause polling.
  ns.VISIBILITY_MESSAGE_TYPE = 'sidecar-visibility';

  function postFrameVisibility(frame) {
    try {
      frame.contentWindow?.postMessage(
        { type: ns.VISIBILITY_MESSAGE_TYPE, payload: { visible: frame.dataset.visible === '1' } },
        '*'
      );
    } catch {
      // Ignore unmounted frame errors
    }
  }

  function setFrameVisibility(frame, visible) {
    const next = visible ? '1' : '0';
    if (frame.dataset.visible === next) return;
    frame.dataset.visible = next;
    postFrameVisibility(frame);
  }

  function attachFrameLoadRelay(frame) {
    frame.addEventListener('load', () => {
      if (latestThemeEvent) frame.contentWindow?.postMessage(latestThemeEvent, '*');
      if (latestWorkspaceEvent) frame.contentWindow?.postMessage(latestWorkspaceEvent, '*');
      // Anything posted before load went to the initial blank document
      postFrameVisibility(frame);
    });
  }

  function stripConversationParam(rawUrl = '') {
    try {
      const parsed = new URL(rawUrl);
      parsed.searchParams.delete('conversationId');
      return parsed.toString();
    } catch {
      return rawUrl;
    }
  }

  ns.clampSplitHeight = function clampSplitHeight(rawPx) {
    const num = Number(rawPx) || 185;
    const maxAllowed = Math.max(120, (window.innerHeight || 600) - 150);
    return Math.max(80, Math.min(maxAllowed, Math.round(num)));
  };

  ns.bindSplitResizeHandle = function bindSplitResizeHandle({ state, els, onSaveHeight }) {
    window.addEventListener('resize', () => {
      if (state.layout?.splitViewEnabled && !state.isResizingSplit && els.mainViewport) {
        els.mainViewport.style.setProperty(
          '--split-top-height',
          `${ns.clampSplitHeight(state.layout.pinnedTopHeightPx)}px`
        );
      }
    });

    if (!els.splitResizeHandle || !els.mainViewport) return;
    let dragStartY = 0;
    let dragStartHeight = 185;

    els.splitResizeHandle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      state.isResizingSplit = true;
      dragStartY = e.clientY;
      const topSlotEl = els.mainViewport.querySelector('.slot-top.visible, .slot-top:not(.hidden)');
      dragStartHeight =
        topSlotEl?.getBoundingClientRect().height || state.layout.pinnedTopHeightPx || 185;
      document.body.classList.add('resizing-split');
      els.splitResizeHandle.setPointerCapture(e.pointerId);
    });

    els.splitResizeHandle.addEventListener('pointermove', (e) => {
      if (!state.isResizingSplit) return;
      const nextHeight = ns.clampSplitHeight(dragStartHeight + (e.clientY - dragStartY));
      els.mainViewport.style.setProperty('--split-top-height', `${nextHeight}px`);
      state.layout.pinnedTopHeightPx = nextHeight;
    });

    const finishDrag = async (e) => {
      if (!state.isResizingSplit) return;
      state.isResizingSplit = false;
      document.body.classList.remove('resizing-split');
      try {
        if (els.splitResizeHandle.hasPointerCapture(e.pointerId)) {
          els.splitResizeHandle.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore release errors
      }
      await onSaveHeight?.(state.layout.pinnedTopHeightPx);
    };

    els.splitResizeHandle.addEventListener('pointerup', finishDrag);
    els.splitResizeHandle.addEventListener('pointercancel', finishDrag);
  };

  ns.reconcileIframeDeck = function reconcileIframeDeck({ state, els }) {
    const splitEnabled = Boolean(state.layout?.splitViewEnabled);
    const { bottomTabs, activeSingleId, activeTopId } = ns.partitionSplitTabs(
      state.sidecars || [],
      state.layout
    );

    els.mainViewport.classList.toggle('is-split', splitEnabled);
    els.splitDividerGroup?.classList.toggle('hidden', !splitEnabled);
    if (splitEnabled && !state.isResizingSplit) {
      els.mainViewport.style.setProperty(
        '--split-top-height',
        `${ns.clampSplitHeight(state.layout?.pinnedTopHeightPx)}px`
      );
    }

    const bottomIds = new Set(bottomTabs.map((s) => s.sidecarId));
    if (splitEnabled && (!state.bottomActiveTabId || !bottomIds.has(state.bottomActiveTabId))) {
      state.bottomActiveTabId = bottomTabs[0]?.sidecarId || '';
    }

    const topSlotId = splitEnabled ? activeTopId : activeSingleId;
    const bottomSlotId = splitEnabled ? state.bottomActiveTabId : '';

    for (const sc of state.sidecars || []) {
      const shouldKeepMounted = Boolean(sc.matchesWorkspace && sc.isRunning && sc.iframeUrl);
      if (!shouldKeepMounted) {
        const existing = deckFrames.get(sc.sidecarId);
        if (existing) {
          existing.remove();
          deckFrames.delete(sc.sidecarId);
        }
        continue;
      }

      const baseKey = stripConversationParam(sc.iframeUrl);
      let frame = deckFrames.get(sc.sidecarId);
      if (!frame) {
        frame = document.createElement('iframe');
        frame.className = 'child-sidecar-frame';
        frame.dataset.sidecarId = sc.sidecarId;
        frame.dataset.baseKey = baseKey;
        frame.dataset.loadedUrl = sc.iframeUrl;
        frame.src = sc.iframeUrl;
        attachFrameLoadRelay(frame);
        els.mainViewport.appendChild(frame);
        deckFrames.set(sc.sidecarId, frame);
      } else if (frame.dataset.baseKey !== baseKey) {
        frame.dataset.baseKey = baseKey;
        frame.dataset.loadedUrl = sc.iframeUrl;
        frame.src = sc.iframeUrl;
      } else if (frame.dataset.loadedUrl !== sc.iframeUrl) {
        frame.dataset.loadedUrl = sc.iframeUrl;
        try {
          const convId = new URL(sc.iframeUrl).searchParams.get('conversationId') || '';
          frame.contentWindow?.postMessage(
            { type: 'conversation-change', payload: { conversationId: convId } },
            '*'
          );
        } catch {
          // Ignore postMessage errors
        }
      }

      const isTop = sc.sidecarId === topSlotId;
      const isBottom = splitEnabled && sc.sidecarId === bottomSlotId;
      frame.classList.toggle('visible', isTop || isBottom);
      frame.classList.toggle('slot-top', isTop);
      frame.classList.toggle('slot-bottom', isBottom);
      setFrameVisibility(frame, isTop || isBottom);
    }

    const storeInTop = topSlotId === ns.EXTENSIONS_TAB_ID;
    const storeInBottom = splitEnabled && bottomSlotId === ns.EXTENSIONS_TAB_ID;
    els.storeView.classList.toggle('hidden', !storeInTop && !storeInBottom);
    els.storeView.classList.toggle('slot-top', storeInTop);
    els.storeView.classList.toggle('slot-bottom', storeInBottom);

    const topFrameMounted = storeInTop || (topSlotId && deckFrames.has(topSlotId));
    if (els.emptyTopState) {
      els.emptyTopState.classList.toggle('hidden', Boolean(topFrameMounted));
      if (!topFrameMounted) {
        const msg = topSlotId
          ? 'Sidecar is hibernated or stopped — enable it in 🧩 Extensions'
          : 'No tab in Top Split — drag a tab here';
        if (els.emptyTopState.dataset.msg !== msg) {
          els.emptyTopState.dataset.msg = msg;
          els.emptyTopState.innerHTML = `<div class="empty-split-zone"><span>${msg}</span></div>`;
        }
      }
    }

    const bottomFrameMounted =
      !splitEnabled || storeInBottom || (bottomSlotId && deckFrames.has(bottomSlotId));
    if (els.emptyDeckState) {
      els.emptyDeckState.classList.toggle('hidden', Boolean(bottomFrameMounted));
      if (!bottomFrameMounted) {
        const msg = bottomSlotId
          ? 'Sidecar is hibernated or stopped — enable it in 🧩 Extensions'
          : 'No tab in Bottom Split — drag a tab here';
        if (els.emptyDeckState.dataset.msg !== msg) {
          els.emptyDeckState.dataset.msg = msg;
          els.emptyDeckState.innerHTML = `<div class="empty-split-zone"><span>${msg}</span></div>`;
        }
      }
    }
  };
})();
