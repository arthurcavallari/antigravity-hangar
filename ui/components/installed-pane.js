/** @fileoverview Renders and reconciles workspace suggestions and installed sidecar cards. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  const expandedGlobIds = new Set();

  function getCardGlobPatterns(sc) {
    const isGlobal = sc?.scope === 'global' || (sc?.workspaces || []).includes('*');
    if (isGlobal) {
      return Array.isArray(sc?.savedGlobs) ? sc.savedGlobs.filter((w) => w && w !== '*') : [];
    }
    return Array.isArray(sc?.workspaces) ? sc.workspaces.filter((w) => w && w !== '*') : [];
  }

  function syncCardGlobsExpanded(card, isOpen) {
    const toggleBtn = card.querySelector('[data-role="globs-toggle"]');
    const drawerEl = card.querySelector('[data-role="globs-drawer"]');
    card.classList.toggle('is-scope-open', Boolean(isOpen));
    toggleBtn?.setAttribute('aria-expanded', String(Boolean(isOpen)));
    drawerEl?.classList.toggle('hidden', !isOpen);
  }

  function renderRuleList(ruleListEl, patterns, onRemovePattern) {
    const sig = JSON.stringify(patterns);
    if (ruleListEl.dataset.sig === sig) return;
    ruleListEl.dataset.sig = sig;
    ns.setHtml(
      ruleListEl,
      patterns.length ? '' : ns.html`<div class="store-subtitle">No auto-open globs configured.</div>`,
    );
    for (const pattern of patterns) {
      const row = Object.assign(document.createElement('div'), { className: 'ws-rule-item' });
      const code = Object.assign(document.createElement('span'), {
        className: 'ws-rule-code',
        textContent: pattern,
      });
      const rmBtn = ns.setHtml(
        Object.assign(document.createElement('button'), {
          type: 'button',
          className: 'ws-rule-remove',
          title: `Remove glob "${pattern}"`,
        }),
        ns.iconSvg('close', 14),
      );
      rmBtn.setAttribute('aria-label', `Remove glob ${pattern}`);
      rmBtn.addEventListener('click', () => onRemovePattern(pattern));
      const iconName = pattern.includes('*') ? 'code_blocks' : 'folder';
      row.append(ns.iconEl(iconName, 14), code, rmBtn);
      ruleListEl.appendChild(row);
    }
  }

  async function runCardAction(card, action, triggerBtn = null, spin = false) {
    if (card._busy) return;
    card._busy = true;
    const errorEl = card.querySelector('[data-role="card-error"]');
    errorEl.classList.add('hidden');
    if (triggerBtn) {
      triggerBtn.disabled = true;
      if (spin) triggerBtn.classList?.add?.('spinning');
    }
    try {
      await action();
    } catch (err) {
      errorEl.textContent = err?.message || 'Action failed';
      errorEl.classList.remove('hidden');
    } finally {
      card._busy = false;
      if (triggerBtn) {
        if (spin) triggerBtn.classList?.remove?.('spinning');
        const keepDisabled =
          (triggerBtn.dataset?.role === 'proc-btn' && Boolean(card._sc?.builtin)) ||
          (triggerBtn.dataset?.role === 'hibernate-btn' && Boolean(card._sc?.autoHibernateLocked));
        triggerBtn.disabled = keepDisabled;
      }
    }
  }

  ns.renderWorkspaceSuggestions = function renderWorkspaceSuggestions(sugEl, { suggestions = [], onApplySuggestion }) {
    if (!sugEl) return;
    const list = Array.isArray(suggestions) ? suggestions : [];
    sugEl.classList.toggle('hidden', list.length === 0);
    sugEl._onApplySuggestion = onApplySuggestion;
    const sig = JSON.stringify(list.map((s) => [s.sidecarId, s.name, s.reason, s.actionType]));
    if (sugEl.dataset.sig === sig) return;
    sugEl.dataset.sig = sig;
    ns.setHtml(sugEl, list.length ? ns.html`<div class="popover-sug-header">Suggested for this workspace</div>` : '');
    for (const sug of list) {
      const isInstall = sug.actionType === 'install';
      const item = Object.assign(document.createElement('div'), { className: 'popover-sug-row' });
      const info = Object.assign(document.createElement('div'), { className: 'popover-sug-info' });
      info.append(
        Object.assign(document.createElement('span'), { className: 'popover-sug-name', textContent: sug.name }),
        Object.assign(document.createElement('span'), { className: 'popover-sug-reason', textContent: sug.reason }),
      );
      const actBtn = ns.setHtml(
        Object.assign(document.createElement('button'), { type: 'button', className: 'agy-btn agy-btn-primary has-icon' }),
        ns.html`${ns.iconSvg(isInstall ? 'download' : 'open_in_new', 16)}<span>${isInstall ? 'Install…' : 'Open'}</span>`,
      );
      if (isInstall) actBtn.title = 'Opens this sidecar in Discover to review its capability tier before installing';
      actBtn.addEventListener('click', () => sugEl._onApplySuggestion?.(sug));
      item.append(info, actBtn);
      sugEl.appendChild(item);
    }
  };

  function createInstalledCard(
    scId,
    {
      onManageSidecar,
      onToggleGlobalSidecar,
      onSaveWorkspaces,
      onToggleAutoHibernate,
      onInstallRemote,
      onUninstallSidecar,
    },
  ) {
    const card = Object.assign(document.createElement('div'), { className: 'agy-card' });
    card.dataset.sidecarId = scId;
    const drawerId = `ws-globs-${String(scId).replace(/[^a-z0-9_-]/gi, '-')}`;
    ns.setHtml(card, ns.html`
      <div class="agy-card-header">
        <div class="manager-card-title-group">
          <div class="manager-card-title-row">
            <img data-role="card-logo" class="hangar-card-logo hidden" width="18" height="18" alt="" />
            <span data-role="title" class="manager-card-title"></span>
            <span data-role="status-badge" class="agy-badge"></span>
            <span data-role="builtin-badge" class="agy-badge hidden">Built-in</span>
          </div>
          <div class="agy-card-meta">${ns.iconSvg('folder', 13)}<span data-role="meta-sub"></span></div>
        </div>
        <div class="agy-card-actions">
          <button type="button" data-role="fix-agent-btn" class="agy-btn agy-btn-outline has-icon hidden" title="Send sidecar error diagnostics to the agent">
            ${ns.iconSvg('bolt', 16)}<span>Fix with Agent</span>
          </button>
          <button type="button" data-role="update-btn" class="agy-btn agy-btn-primary has-icon hidden" title="Update sidecar">
            ${ns.iconSvg('download', 16)}<span>Update</span>
          </button>
          <button type="button" data-role="restart-btn" class="agy-icon-btn" title="Restart sidecar" aria-label="Restart sidecar">
            ${ns.iconSvg('refresh', 16)}
          </button>
          <button type="button" data-role="uninstall-btn" class="agy-icon-btn" title="Uninstall sidecar" aria-label="Uninstall sidecar">
            ${ns.iconSvg('delete', 16)}
          </button>
          <button type="button" role="switch" data-role="proc-btn" class="agy-switch" title="Enable or disable sidecar" aria-label="Enable or disable sidecar">
            <agy-switch><span class="agy-switch-thumb"></span></agy-switch>
          </button>
        </div>
      </div>
      <div data-role="uninstall-confirm" class="agy-consent-bar hidden">
        <span data-role="uninstall-confirm-text"></span>
        <div class="consent-actions">
          <button type="button" data-role="uninstall-cancel" class="agy-btn agy-btn-outline">Cancel</button>
          <button type="button" data-role="uninstall-confirm-btn" class="agy-btn agy-btn-danger">Uninstall</button>
        </div>
      </div>
      <div data-role="update-confirm" class="agy-consent-bar hidden">
        <span data-role="update-confirm-text"></span>
        <div class="consent-actions">
          <button type="button" data-role="update-cancel" class="agy-btn agy-btn-outline">Cancel</button>
          <button type="button" data-role="update-confirm-btn" class="agy-btn agy-btn-primary">Confirm Update</button>
        </div>
      </div>
      <div data-role="card-error" class="agy-banner err hidden" role="alert"></div>
      <div data-role="desc" class="manager-card-desc"></div>
      <div class="ws-card-footer">
        <div class="manager-scope-actions">
          <button type="button" data-role="global-btn" class="agy-btn has-icon">
            ${ns.iconSvg('globe', 16)}<span>All Workspaces</span>
          </button>
          <button type="button" data-role="hibernate-btn" class="agy-btn has-icon"></button>
        </div>
        <button
          type="button"
          data-role="globs-toggle"
          class="ws-globs-toggle"
          aria-expanded="false"
          aria-controls="${drawerId}"
        >
          ${ns.iconSvg('expand_more', 16, 'ws-scope-chev')}
          <span>Auto-open globs</span>
          <span data-role="globs-count" class="agy-count-pill hidden"></span>
        </button>
      </div>
      <div id="${drawerId}" data-role="globs-drawer" class="ws-scope-drawer hidden">
        <div data-role="rule-list" class="ws-rule-list"></div>
        <div class="ws-add-row">
          <input type="text" class="ws-input" aria-label="Auto-open glob pattern" placeholder="Auto-open when workspace matches glob (e.g. *backend*, *api*)…" />
          <button type="button" data-role="add-rule-btn" class="agy-btn agy-btn-secondary has-icon">
            ${ns.iconSvg('add', 16)}<span>Add</span>
          </button>
        </div>
      </div>
    `);
    const q = (role) => card.querySelector(`[data-role="${role}"]`);
    q('card-logo')?.addEventListener?.('error', () => {
      q('card-logo')?.classList?.add?.('hidden');
    });
    q('globs-toggle').addEventListener('click', () => {
      const id = card._sc?.sidecarId || scId;
      const nextOpen = !expandedGlobIds.has(id);
      if (nextOpen) {
        expandedGlobIds.add(id);
      } else {
        expandedGlobIds.delete(id);
      }
      syncCardGlobsExpanded(card, nextOpen);
    });
    const wsInput = card.querySelector('.ws-input');
    const commitNewPattern = () => {
      const raw = wsInput.value.trim();
      if (!raw) return;
      const incoming = raw.split(',').map((s) => s.trim()).filter((s) => s && s !== '*');
      if (!incoming.length) return;
      const existing = getCardGlobPatterns(card._sc);
      wsInput.value = '';
      runCardAction(
        card,
        () => onSaveWorkspaces?.(card._sc, Array.from(new Set([...existing, ...incoming]))),
        q('add-rule-btn'),
      );
    };
    wsInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      commitNewPattern();
    });
    q('add-rule-btn').addEventListener('click', commitNewPattern);
    const hibBtnEl = q('hibernate-btn');
    hibBtnEl.addEventListener('click', () => {
      if (card._sc && !card._sc.autoHibernateLocked) {
        runCardAction(card, () => onToggleAutoHibernate?.(card._sc), hibBtnEl);
      }
    });
    const globalBtnEl = q('global-btn');
    globalBtnEl.addEventListener('click', () => {
      if (!card._sc) return;
      if (typeof onToggleGlobalSidecar === 'function') {
        runCardAction(card, () => onToggleGlobalSidecar(card._sc), globalBtnEl);
        return;
      }
      const isGlobal = card._sc.scope === 'global' || (card._sc.workspaces || []).includes('*');
      const fallback = getCardGlobPatterns(card._sc);
      runCardAction(card, () => onSaveWorkspaces?.(card._sc, isGlobal ? fallback : ['*']), globalBtnEl);
    });
    const procBtn = q('proc-btn');
    const syncSwitch = (el, on, dis) => {
      if (window.AgyUI?.syncSwitchState) {
        window.AgyUI.syncSwitchState(el, on, dis);
        return;
      }
      el.classList.toggle('on', Boolean(on));
      el.setAttribute('aria-checked', String(Boolean(on)));
      if (dis !== undefined) el.disabled = Boolean(dis);
    };
    procBtn.addEventListener('click', async () => {
      if (procBtn.disabled || card._busy) return;
      const nextOn = !card._sc.isRunning;
      syncSwitch(procBtn, nextOn, true);
      await runCardAction(
        card,
        () => onManageSidecar?.(card._sc.sidecarId, nextOn ? 'SIDECAR_ACTION_ENABLE' : 'SIDECAR_ACTION_DISABLE'),
      );
      syncSwitch(procBtn, Boolean(card._sc.isRunning), false);
    });
    const restartBtn = q('restart-btn');
    restartBtn.addEventListener('click', () => {
      runCardAction(card, () => onManageSidecar(card._sc.sidecarId, 'SIDECAR_ACTION_RESTART'), restartBtn, true);
    });
    const fixAgentBtn = q('fix-agent-btn');
    fixAgentBtn?.addEventListener('click', async () => {
      const curSc = card._sc;
      if (!curSc || fixAgentBtn.disabled) return;
      fixAgentBtn.disabled = true;
      await runCardAction(card, async () => {
        const rawConv = card._activeWorkspace?.conversationId || '';
        const convId = rawConv === '_new' ? '' : rawConv;
        const wsPath = card._activeWorkspace?.workspacePath || ns.getActiveWorkspacePath?.() || '';
        const extra = wsPath ? { workspace: wsPath } : {};
        const msg = `Sidecar "${curSc.displayName || curSc.sidecarId}" (${curSc.sidecarId}) is in an errored state (${curSc.statusBadge || 'ERROR'}). Please inspect its setup and server logs and fix the issue.`;
        const res = await (ns.notifyAgent?.(msg, convId, `Sidecar Error: ${curSc.sidecarId}`, extra) ||
          window.AgyShell?.notifyAgent?.(msg, convId, `Sidecar Error: ${curSc.sidecarId}`, extra));
        if (res?.ok === false) throw new Error(res.error || 'Could not send message to agent');
        const span = fixAgentBtn.querySelector('span');
        if (span) {
          span.textContent = 'Sent to Agent';
          setTimeout(() => {
            span.textContent = 'Fix with Agent';
          }, 2000);
        }
      });
      fixAgentBtn.disabled = false;
    });
    const uninstallBtn = q('uninstall-btn');
    const uninstallConfirm = q('uninstall-confirm');
    const uninstallCancelBtn = q('uninstall-cancel');
    uninstallBtn.addEventListener('click', () => {
      q('uninstall-confirm-text').textContent = `Uninstall ${card._sc.displayName || card._sc.sidecarId}? This removes its link and downloaded packages.`;
      uninstallConfirm.classList.remove('hidden');
      uninstallCancelBtn?.focus?.();
    });
    uninstallCancelBtn.addEventListener('click', () => {
      uninstallConfirm.classList.add('hidden');
      uninstallBtn?.focus?.();
    });
    q('uninstall-confirm-btn').addEventListener('click', async () => {
      uninstallConfirm.classList.add('hidden');
      uninstallBtn.disabled = true;
      await runCardAction(card, () => onUninstallSidecar?.(card._sc.sidecarId));
      uninstallBtn.disabled = false;
    });
    const upBtn = q('update-btn');
    const updateConfirm = q('update-confirm');
    const runUpdate = async (acceptedTier) => {
      const pkg = card._regPkg;
      const curSc = card._sc;
      const gitRepo = pkg?.release?.gitRepo || curSc?.gitRepo || '';
      const tarballUrl = pkg?.release?.tarballUrl || curSc?.tarballUrl || '';
      if (!gitRepo && !tarballUrl) return;
      upBtn.disabled = true;
      updateConfirm.classList.add('hidden');
      await runCardAction(card, async () => {
        const res = await onInstallRemote?.({
          sidecarId: curSc.sidecarId,
          gitRepo,
          tarballUrl,
          sha256: (pkg?.release?.sha256 ?? curSc?.sha256) || '',
          version: pkg?.latestVersion || curSc?.latestVersion || 'latest',
          scope: curSc.scope,
          workspaces: curSc.workspaces,
          acceptedTier,
        });
        if (res?.needsConsent) {
          card._pendingTier = res.scannedTier;
          ns.setHtml(q('update-confirm-text'), ns.scannedTierConsentHtml(res.scannedTier, 'Update'));
          updateConfirm.classList.remove('hidden');
        }
      });
      upBtn.disabled = false;
    };
    upBtn.addEventListener('click', () => {
      card._pendingTier = '';
      runUpdate(card._sc.capabilityTier || card._regPkg?.capabilityTier || 'TIER_1_TELEMETRY');
    });
    q('update-cancel').addEventListener('click', () => {
      card._pendingTier = '';
      updateConfirm.classList.add('hidden');
    });
    q('update-confirm-btn').addEventListener('click', () => runUpdate(card._pendingTier));
    return card;
  }

  ns.reconcileInstalledPane = function reconcileInstalledPane(paneEl, opts) {
    const { sidecars, registryPackages, activeWorkspace, onSaveWorkspaces } = opts;
    const regMap = new Map((registryPackages || []).map((p) => [p.id, p]));
    const seenIds = new Set();
    for (const sc of sidecars || []) {
      seenIds.add(sc.sidecarId);
      let card = paneEl.querySelector(`.agy-card[data-sidecar-id="${CSS.escape(sc.sidecarId)}"]`);
      if (!card) {
        card = createInstalledCard(sc.sidecarId, opts);
        paneEl.appendChild(card);
      }
      const q = (role) => card.querySelector(`[data-role="${role}"]`);
      Object.assign(card, { _sc: sc, _activeWorkspace: activeWorkspace, _regPkg: regMap.get(sc.sidecarId) || null });
      const hasUpdate = Boolean(sc.updateAvailable || card._regPkg?.updateAvailable);
      const latestVer = card._regPkg?.latestVersion || sc.latestVersion || '';
      const verLabel = hasUpdate && latestVer
        ? `v${sc.installedVersion || '1.0.0'} → v${latestVer}`
        : `v${sc.installedVersion || '1.0.0'}`;
      const badgeInfo = ns.formatStatusBadge(sc.statusBadge, sc.isRunning, sc.isErrored);
      const scLabel = sc.displayName || sc.sidecarId;
      const logoEl = q('card-logo');
      const logoSrc = sc.iconUrl
        ? (ns.resolveSidecarAssetUrl ? ns.resolveSidecarAssetUrl(sc.iconUrl) : String(sc.iconUrl))
        : '';
      if (logoEl) {
        logoEl.classList.toggle('hidden', !logoSrc);
        if (logoSrc && logoEl.getAttribute('src') !== logoSrc) {
          logoEl.setAttribute('src', logoSrc);
          logoEl.src = logoSrc;
        }
      }
      q('title').textContent = sc.displayName;
      q('restart-btn').title = `Restart ${scLabel}`;
      q('restart-btn').setAttribute?.('aria-label', `Restart ${scLabel}`);
      q('uninstall-btn').title = `Uninstall ${scLabel}`;
      q('uninstall-btn').setAttribute?.('aria-label', `Uninstall ${scLabel}`);
      q('proc-btn').title = sc.builtin
        ? 'Built-in Antigravity sidecar — managed by the IDE'
        : `Enable or disable ${scLabel}`;
      q('proc-btn').setAttribute?.('aria-label', `Enable or disable ${scLabel}`);

      const metaParts = [sc.sidecarId];
      if (!sc.builtin) metaParts.push(verLabel, sc.source);
      if (sc.webPort) metaParts.push(`:${sc.webPort}`);
      q('meta-sub').textContent = metaParts.filter(Boolean).join(' • ');
      q('builtin-badge')?.classList.toggle('hidden', !sc.builtin);
      const statusBadge = q('status-badge');
      const badgeSig = `${badgeInfo.state}:${badgeInfo.label}`;
      if (statusBadge.dataset.sig !== badgeSig) {
        statusBadge.dataset.sig = badgeSig;
        statusBadge.className = `agy-badge ${badgeInfo.state}`;
        ns.setHtml(statusBadge, ns.html`<span class="agy-badge-dot"></span><span>${ns.escHtml(badgeInfo.label)}</span>`);
      }
      q('desc').textContent = sc.description || 'No description provided.';

      const isGlobal = sc.scope === 'global' || (sc.workspaces || []).includes('*');
      const globalBtn = q('global-btn');
      globalBtn.className = `agy-btn has-icon ${isGlobal ? 'agy-btn-secondary' : 'agy-btn-outline'}`;
      globalBtn.classList.toggle('active', isGlobal);
      globalBtn.setAttribute?.('aria-pressed', String(isGlobal));
      globalBtn.title = isGlobal
        ? 'Shown across all workspaces — click to keep open per project instead'
        : 'Show this sidecar tab across all workspaces';

      const hibBtn = q('hibernate-btn');
      const hibSig = `${Boolean(sc.autoHibernate)}:${Boolean(sc.autoHibernateLocked)}`;
      if (hibBtn.dataset.sig !== hibSig) {
        hibBtn.dataset.sig = hibSig;
        hibBtn.className = `agy-btn has-icon ${sc.autoHibernate ? 'agy-btn-secondary' : 'agy-btn-outline'}`;
        ns.setHtml(hibBtn, ns.html`${ns.iconSvg('bolt', 16)}<span>Auto-Sleep</span>`);
        hibBtn.title = sc.autoHibernateLocked
          ? "A plugin's sidecar starts and stops with its plugin, so it never hibernates"
          : 'Automatically hibernate process when tab is closed or workspace is inactive';
        hibBtn.disabled = Boolean(sc.autoHibernateLocked);
        hibBtn.setAttribute('aria-pressed', String(Boolean(sc.autoHibernate)));
      }

      const globPatterns = getCardGlobPatterns(sc);
      const globsCountEl = q('globs-count');
      globsCountEl.textContent = globPatterns.length > 0 ? String(globPatterns.length) : '';
      globsCountEl.classList.toggle('hidden', globPatterns.length === 0);
      syncCardGlobsExpanded(card, expandedGlobIds.has(sc.sidecarId));
      renderRuleList(q('rule-list'), globPatterns, (pat) => {
        runCardAction(card, () => onSaveWorkspaces?.(card._sc, getCardGlobPatterns(card._sc).filter((w) => w !== pat)));
      });

      const canUninstall = ns.canUninstallSidecar
        ? ns.canUninstallSidecar(sc)
        : (!sc.sidecarId.includes('/') && !sc.parentPluginId && !String(sc.source || '').startsWith('plugin:'));
      q('uninstall-btn').classList.toggle('hidden', !canUninstall);
      q('fix-agent-btn')?.classList.toggle('hidden', !sc.isErrored);
      const upBtn = q('update-btn');
      upBtn.classList.toggle('hidden', !hasUpdate);
      if (hasUpdate && latestVer) upBtn.title = `Update ${sc.displayName} to v${latestVer}`;

      const procBtn = q('proc-btn');
      if (sc.builtin) {
        if (window.AgyUI?.syncSwitchState) {
          window.AgyUI.syncSwitchState(procBtn, Boolean(sc.isRunning), true);
        } else {
          procBtn.classList.toggle('on', Boolean(sc.isRunning));
          procBtn.setAttribute('aria-checked', String(Boolean(sc.isRunning)));
          procBtn.disabled = true;
        }
      } else if (!card._busy) {
        if (window.AgyUI?.syncSwitchState) {
          window.AgyUI.syncSwitchState(procBtn, Boolean(sc.isRunning), false);
        } else {
          procBtn.classList.toggle('on', Boolean(sc.isRunning));
          procBtn.setAttribute('aria-checked', String(Boolean(sc.isRunning)));
          procBtn.disabled = false;
        }
      }
    }
    for (const child of Array.from(paneEl.querySelectorAll('.agy-card'))) {
      if (!seenIds.has(child.dataset.sidecarId)) {
        expandedGlobIds.delete(child.dataset.sidecarId);
        child.remove();
      }
    }
  };
})();
