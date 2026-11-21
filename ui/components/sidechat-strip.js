/** @fileoverview Side Question session tab-strip controller, inline rename, overflow reopen, and within-strip reordering. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  const sc = ns.sideChatStore?.state || ns._sc;

  ns.createSideChatStripController = function createSideChatStripController(ctx) {
    let isRenaming = false;
    let latestItems = [];

    const applyRename = (t, rawNext) => {
      if (!t?.cascadeId) return;
      const cid = t.cascadeId;
      const next = String(rawNext || '').replace(/\s+/g, ' ').trim();
      const rawParent = String(t.parentConversationId || ctx.getConversationId?.() || '').trim();
      const parentConversationId = rawParent === '_new' ? '' : rawParent;
      ns.recordSideChatRename?.(cid, next);
      ns.apiCall?.('/api/sidechat/rename', {
        cascadeId: cid,
        parentConversationId,
        title: next,
      })?.catch?.(() => {});
      isRenaming = false;
      renderSessionStrip();
      ns.notifySideChatState();
    };

    const finishRename = (lbl, t, rawNext, commit) => {
      if (commit) {
        applyRename(t, rawNext);
      } else {
        isRenaming = false;
      }
      lbl.textContent = ns.resolveSideChatTitle(t);
      if (!commit) {
        renderSessionStrip();
      }
    };

    const startInlineRename = (pill, t) => {
      const lbl = pill?.querySelector?.('.agy-tab-label');
      if (!lbl || isRenaming) return;
      isRenaming = true;
      (window.AgyUI?.startInlineRename || ns.startInlineRename)?.(
        pill,
        ns.resolveSideChatTitle(t),
        (rawNext, commit) => finishRename(lbl, t, rawNext, commit)
      );
    };

    const selectThread = (cid) => {
      ns.setActiveSideChatId(cid);
      ctx.syncThreadsUi(cid, null);
      ns.notifySideChatState();
    };

    const scrollFn = window.AgyUI?.setupStripScroll || ns.setupStripScroll;
    if (ctx.overflowBtn && ctx.overflowPopover) {
      scrollFn?.(
        ctx.sessionsEl,
        ctx.overflowBtn,
        () => latestItems,
        (id) => selectThread(id),
        ctx.overflowPopover,
        () =>
          (ns.getClosedSideChats?.() || []).map((ct) => ({
            id: ct.cascadeId,
            label: ns.resolveSideChatTitle(ct),
            icon: 'chat',
            iconSize: 14,
            externalBadge: Boolean(ct.isExternal),
            dataset: { cascadeId: ct.cascadeId },
          })),
        (cid) => ns.reopenSideChat?.(cid),
        { idDatasetKey: 'cascadeId' }
      );
    }

    function renderSessionStrip() {
      const curTabId = ns.SIDECHAT_TAB_ID;
      if (isRenaming || ns.pointerSideChatInstanceId === curTabId) return;
      const instThreads = sc.threads;
      const actCid = ns.getActiveSideChatId() || instThreads[0]?.cascadeId || '';
      const togglePin = (t) => {
        t.pinned = !t.pinned;
        if (t.isExternal) {
          sc.externalMetaById?.set?.(t.cascadeId, { pinned: Boolean(t.pinned) });
        }
        sc.threads = [...sc.threads.filter((x) => x.pinned), ...sc.threads.filter((x) => !x.pinned)];
        renderSessionStrip();
        ns.notifySideChatState();
      };
      const items = instThreads.map((t, idx) => ({
        id: t.cascadeId,
        thread: t,
        idx,
        label: ns.resolveSideChatTitle(t),
        icon: 'chat',
        iconSize: 14,
        active: t.cascadeId === actCid,
        pinned: Boolean(t.pinned),
        externalBadge: Boolean(t.isExternal),
        externalTitle: 'Opened outside Hangar (shared with Antigravity)',
        closable: !t.pinned,
        closeTitle: 'Close Side Question',
        renamable: true,
        title: `${ns.resolveSideChatTitle(t)}${t.pinned ? ' · Pinned' : ''}${t.isExternal ? ' · Opened outside Hangar (shared with Antigravity)' : ''} (Drag to reorder, double-click to rename)`,
        dataset: {
          cascadeId: t.cascadeId,
          pinned: t.pinned ? 'true' : 'false',
          external: t.isExternal ? 'true' : 'false',
        },
      }));
      latestItems = items;
      window.AgyUI?.reconcileTabStrip?.(ctx.sessionsEl, items, {
        idDatasetKey: 'cascadeId',
        closeTitle: 'Close Side Question',
        addButton: {
          role: 'sidechat-strip-add',
          title: 'New Side Question',
          onClick: () => ctx.spawnNewInInstance(),
        },
        onSelect: (id) => {
          if (ns.getActiveSideChatId() !== id) {
            selectThread(id);
          }
        },
        onClose: (id) => ns.closeSideChatsByIds?.([id]),
        onUnpin: (_id, item) => togglePin(item.thread),
        onRenameStart: () => {
          isRenaming = true;
        },
        onRenameCancel: () => {
          isRenaming = false;
        },
        onRename: (_id, rawNext, item) => applyRename(item.thread, rawNext),
        onContextMenu: (_id, item, e, pill) => {
          const t = item.thread;
          const others = instThreads
            .filter((x) => x.cascadeId !== t.cascadeId && !x.pinned)
            .map((x) => x.cascadeId);
          const right = instThreads
            .slice(item.idx + 1)
            .filter((x) => !x.pinned)
            .map((x) => x.cascadeId);
          const reqDel = ns.requestDeleteSideChats || ns.deleteSideChatsByIds;
          ns.openTabContextMenu?.(e, [
            { id: t.pinned ? 'unpin-tab' : 'pin-tab', label: t.pinned ? 'Unpin Tab' : 'Pin Tab', onClick: () => togglePin(t) },
            { id: 'rename-tab', label: 'Rename Side Question…', onClick: () => startInlineRename(pill, t) },
            {
              id: 'promote-tab',
              icon: 'promote_to_chat',
              label: 'Promote to Conversation',
              disabled: Boolean(t.isRunning || sc.promotingIds?.has?.(t.cascadeId)),
              onClick: () => ns.promoteSideChat?.(t.cascadeId),
            },
            { separator: true },
            {
              id: 'close-tab',
              label: 'Close Side Question',
              disabled: Boolean(t.pinned),
              onClick: () => ns.closeSideChatsByIds?.([t.cascadeId]),
            },
            {
              id: 'close-other-tabs',
              label: 'Close Other Side Questions',
              disabled: !others.length,
              onClick: () => {
                selectThread(t.cascadeId);
                ns.closeSideChatsByIds?.(others);
              },
            },
            {
              id: 'close-tabs-to-the-right',
              label: 'Close Side Questions to the Right',
              disabled: !right.length,
              onClick: () => ns.closeSideChatsByIds?.(right),
            },
            { separator: true },
            {
              id: 'delete-tab',
              icon: 'delete',
              label: 'Delete Side Question',
              onClick: () => reqDel([t.cascadeId]),
            },
          ]);
        },
        bindDrag: (pill, item) => {
          if (pill?.dataset && pill.dataset.tabId === undefined) {
            pill.dataset.tabId = item.thread.cascadeId;
          }
          window.AgyUI?.bindTabDragController?.(pill, {
            stripEl: () => ctx.sessionsEl,
            tabSelector: '.agy-tab[data-cascade-id]',
            idDatasetKey: 'cascadeId',
            pinnedRole: 'sidechat-strip-add',
            railPadY: 1e6,
            ignoreSelector: '[data-close-cid], [data-pin-cid], [data-role="tab-pin"]',
            onDragStart: () => {
              Object.assign(ns, { isPointerOnTab: true, pointerSideChatInstanceId: curTabId });
            },
            onClearPreview: () => {
              Object.assign(ns, { isPointerOnTab: false, pointerSideChatInstanceId: '' });
            },
            onDrop: (_e, finishedState, cancelled) => {
              Object.assign(ns, { isPointerOnTab: false, pointerSideChatInstanceId: '' });
              if (cancelled || !finishedState) return;
              ns.reorderSideChatThreadsInInstance('', item.thread.cascadeId, finishedState.dropIdx);
              selectThread(item.thread.cascadeId);
            },
            onClick: () => {
              pill.scrollIntoView?.({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
              if (ns.getActiveSideChatId() !== item.thread.cascadeId) {
                selectThread(item.thread.cascadeId);
              }
            },
          });
        },
      });
      ctx.sessionsEl._updateOverflow?.();
    }

    return { renderSessionStrip };
  };
})();
