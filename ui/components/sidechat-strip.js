/** @fileoverview Side Chat session tab-strip controller, inline rename, and within-strip reordering. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  const sc = ns.sideChatStore?.state || ns._sc;

  ns.createSideChatStripController = function createSideChatStripController(ctx) {
    let isRenaming = false;
    const applyRename = (t, rawNext) => {
      if (!t?.cascadeId) return;
      const cid = t.cascadeId;
      const next = String(rawNext || '').replace(/\s+/g, ' ').trim();
      const rawParent = String(t.parentConversationId || ctx.getConversationId?.() || '').trim();
      const parentConversationId = rawParent === '_new' ? '' : rawParent;
      ns.recordSideChatRename?.(cid, next);
      if (next) {
        ns.apiCall?.('/api/sidechat/rename', {
          cascadeId: cid,
          parentConversationId,
          title: next,
        })?.catch?.(() => {});
      }
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
      const lbl = pill?._slots?.labelEl || pill?.querySelector?.('.agy-tab-label');
      if (isRenaming || !t || !lbl) return;
      isRenaming = true;
      (window.AgyUI?.startInlineRename || ns.startInlineRename)?.(pill, lbl, {
        initialValue: ns.resolveSideChatTitle(t),
        inputClassName: 'agy-rename-input',
        onCommit: (rawNext) => finishRename(lbl, t, rawNext, true),
        onCancel: () => finishRename(lbl, t, '', false),
      });
    };

    function renderSessionStrip() {
      const curTabId = ns.SIDECHAT_TAB_ID;
      if (isRenaming || ns.pointerSideChatInstanceId === curTabId) return;
      const instThreads = sc.threads;
      const actCid = ns.getActiveSideChatId() || instThreads[0]?.cascadeId || '';
      const togglePin = (t) => {
        t.pinned = !t.pinned;
        sc.threads = [...sc.threads.filter((x) => x.pinned), ...sc.threads.filter((x) => !x.pinned)];
        renderSessionStrip();
        ns.notifySideChatState();
      };
      const selectThread = (cid) => {
        ns.setActiveSideChatId(cid);
        ctx.syncThreadsUi(cid, null);
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
        closable: !t.pinned,
        closeTitle: 'Delete Side Chat',
        renamable: true,
        title: `${ns.resolveSideChatTitle(t)}${t.pinned ? ' · Pinned' : ''} (Drag to reorder, double-click to rename)`,
        dataset: { cascadeId: t.cascadeId, pinned: t.pinned ? 'true' : 'false' },
      }));
      window.AgyUI?.reconcileTabStrip?.(ctx.sessionsEl, items, {
        idDatasetKey: 'cascadeId',
        closeTitle: 'Delete Side Chat',
        addButton: {
          role: 'sidechat-strip-add',
          title: 'New Side Chat',
          onClick: () => ctx.spawnNewInInstance(),
        },
        onSelect: (id) => {
          if (ns.getActiveSideChatId() !== id) {
            selectThread(id);
          }
        },
        onClose: (id) => ns.deleteSideChatsByIds([id]),
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
          ns.openTabContextMenu?.(e, [
            { id: t.pinned ? 'unpin-tab' : 'pin-tab', label: t.pinned ? 'Unpin Tab' : 'Pin Tab', onClick: () => togglePin(t) },
            { id: 'rename-tab', label: 'Rename Side Chat…', onClick: () => startInlineRename(pill, t) },
            { separator: true },
            {
              id: 'close-tab',
              label: 'Delete Side Chat',
              disabled: Boolean(t.pinned),
              onClick: () => ns.deleteSideChatsByIds([t.cascadeId]),
            },
            {
              id: 'close-other-tabs',
              label: 'Delete Other Side Chats',
              disabled: !others.length,
              onClick: () => {
                ns.setActiveSideChatId(t.cascadeId);
                ns.deleteSideChatsByIds(others);
              },
            },
            {
              id: 'close-tabs-to-the-right',
              label: 'Delete Side Chats to the Right',
              disabled: !right.length,
              onClick: () => ns.deleteSideChatsByIds(right),
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
    }

    return { renderSessionStrip };
  };
})();
