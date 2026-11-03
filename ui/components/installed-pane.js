/** @fileoverview Renders and reconciles workspace suggestions and installed sidecar cards. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});

  function renderRuleList(ruleListEl, sc, onRemovePattern) {
    const patterns = Array.isArray(sc.workspaces) ? sc.workspaces : [];
    const sig = JSON.stringify(patterns);
    if (ruleListEl.dataset.sig === sig) return;
    ruleListEl.dataset.sig = sig;
    ns.setHtml(
      ruleListEl,
      patterns.length ? '' : ns.html`<div class="store-subtitle">No workspace rules — hidden in all workspaces.</div>`,
    );
    for (const pattern of patterns) {
      const row = Object.assign(document.createElement('div'), { className: 'ws-rule-item' });
      const code = Object.assign(document.createElement('span'), {
        className: 'ws-rule-code',
        textContent: pattern === '*' ? '* (All Workspaces)' : pattern,
      });
      const rmBtn = ns.setHtml(
        Object.assign(document.createElement('button'), {
          type: 'button',
          className: 'ws-rule-remove',
          title: `Remove rule "${pattern}"`,
        }),
        ns.iconSvg('close', 14),
      );
      rmBtn.setAttribute('aria-label', `Remove rule ${pattern}`);
      rmBtn.addEventListener('click', () => onRemovePattern(pattern));
      const iconName = pattern === '*' ? 'globe' : (pattern.includes('*') ? 'code_blocks' : 'folder');
      row.append(ns.iconEl(iconName, 14), code, rmBtn);
      ruleListEl.appendChild(row);
    }
  }

  async function runCardAction(card, action) {
    const errorEl = card.querySelector('[data-role="card-error"]');
    errorEl.classList.add('hidden');
    try {
      await action();
    } catch (err) {
      errorEl.textContent = err?.message || 'Action failed';
      errorEl.classList.remove('hidden');
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
        ns.html`${ns.iconSvg(isInstall ? 'download' : 'check', 13)}<span>${isInstall ? 'Install…' : 'Enable'}</span>`,
      );
      if (isInstall) actBtn.title = 'Opens this sidecar in Discover to review its capability tier before installing';
      actBtn.addEventListener('click', () => sugEl._onApplySuggestion?.(sug));
      item.append(info, actBtn);
      sugEl.appendChild(item);
    }
  };

  function createInstalledCard(
    scId,
    { onManageSidecar, onSaveWorkspaces, onToggleAutoHibernate, onInstallRemote, onUninstallSidecar },
  ) {
    const card = Object.assign(document.createElement('div'), { className: 'agy-card' });
    card.dataset.sidecarId = scId;
    ns.setHtml(card, ns.html`
      <div class="agy-card-header">
        <div class="manager-card-title-group">
          <div class="manager-card-title-row">
            <span data-role="title" class="manager-card-title"></span>
            <span data-role="status-badge" class="agy-badge"></span>
          </div>
          <div class="agy-card-meta">${ns.iconSvg('folder', 13)}<span data-role="meta-sub"></span></div>
        </div>
        <div class="agy-card-actions">
          <button type="button" data-role="fix-agent-btn" class="agy-btn agy-btn-outline has-icon hidden" title="Send sidecar error diagnostics to the agent">
            ${ns.iconSvg('bolt', 13)}<span>Fix with Agent</span>
          </button>
          <button type="button" data-role="update-btn" class="agy-btn agy-btn-primary has-icon hidden" title="Update sidecar">
            ${ns.iconSvg('download', 13)}<span>Update</span>
          </button>
          <button type="button" data-role="restart-btn" class="agy-icon-btn" title="Restart sidecar" aria-label="Restart sidecar">
            ${ns.iconSvg('refresh', 14)}
          </button>
          <button type="button" data-role="uninstall-btn" class="agy-icon-btn" title="Uninstall sidecar" aria-label="Uninstall sidecar">
            ${ns.iconSvg('delete', 14)}
          </button>
          <button type="button" role="switch" data-role="proc-btn" class="agy-switch" title="Enable or disable sidecar">
            <agy-switch><span class="agy-switch-thumb"></span></agy-switch>
          </button>
        </div>
      </div>
      <div data-role="uninstall-confirm" class="agy-consent-bar hidden">
        <span data-role="uninstall-confirm-text"></span>
        <div class="consent-actions">
          <button type="button" data-role="uninstall-cancel" class="agy-btn agy-btn-outline">Cancel</button>
          <button type="button" data-role="uninstall-confirm-btn" class="agy-btn agy-btn-primary">Uninstall</button>
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
      <div class="manager-section-bar">
        <span class="manager-section-label">Workspace Scope</span>
        <div class="manager-scope-actions">
          <button type="button" data-role="hibernate-btn" class="agy-btn has-icon"></button>
          <agy-toggle-group class="agy-toggle-group">
            <button type="button" data-role="global-btn" class="agy-toggle-item">${ns.iconSvg('globe', 13)}<span>Global (*)</span></button>
            <button type="button" data-role="add-ws-btn" class="agy-toggle-item"></button>
          </agy-toggle-group>
        </div>
      </div>
      <div data-role="rule-list" class="ws-rule-list"></div>
      <div class="ws-add-row">
        <input type="text" class="ws-input" placeholder="Add workspace path or glob (e.g. C:/Projects/app, *backend*)…" />
        <button type="button" data-role="add-rule-btn" class="agy-btn agy-btn-secondary has-icon">
          ${ns.iconSvg('add', 14)}<span>Add</span>
        </button>
      </div>
    `);
    const q = (role) => card.querySelector(`[data-role="${role}"]`);
    const wsInput = card.querySelector('.ws-input');
    const commitNewPattern = () => {
      const raw = wsInput.value.trim();
      if (!raw) return;
      const incoming = raw.split(',').map((s) => s.trim()).filter(Boolean);
      const existing = (card._sc.workspaces || []).filter((w) => w !== '*' || incoming.includes('*'));
      wsInput.value = '';
      runCardAction(card, () => onSaveWorkspaces(card._sc, Array.from(new Set([...existing, ...incoming]))));
    };
    wsInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      commitNewPattern();
    });
    q('add-rule-btn').addEventListener('click', commitNewPattern);
    q('hibernate-btn').addEventListener('click', () => {
      if (card._sc && !card._sc.autoHibernateLocked) {
        runCardAction(card, () => onToggleAutoHibernate?.(card._sc));
      }
    });
    q('global-btn').addEventListener('click', () => {
      const isGlobal = (card._sc.workspaces || []).includes('*');
      const fallback = card._activeWorkspace?.workspacePath ? [card._activeWorkspace.workspacePath] : [];
      runCardAction(card, () => onSaveWorkspaces(card._sc, isGlobal ? fallback : ['*']));
    });
    q('add-ws-btn').addEventListener('click', () => {
      const currentWs = card._activeWorkspace?.workspacePath || '';
      if (!currentWs) return;
      const existing = (card._sc.workspaces || []).filter((w) => w !== '*');
      const hasCurrent = !(card._sc.workspaces || []).includes('*') &&
        existing.some((w) => w.toLowerCase() === currentWs.toLowerCase());
      const next = hasCurrent
        ? existing.filter((w) => w.toLowerCase() !== currentWs.toLowerCase())
        : Array.from(new Set([...existing, currentWs]));
      runCardAction(card, () => onSaveWorkspaces(card._sc, next));
    });
    const procBtn = q('proc-btn');
    procBtn.addEventListener('click', async () => {
      if (procBtn.disabled) return;
      const nextOn = !card._sc.isRunning;
      procBtn.disabled = true;
      procBtn.classList.toggle('on', nextOn);
      procBtn.setAttribute('aria-checked', String(nextOn));
      await runCardAction(
        card,
        () => onManageSidecar(card._sc.sidecarId, nextOn ? 'SIDECAR_ACTION_ENABLE' : 'SIDECAR_ACTION_DISABLE'),
      );
      procBtn.disabled = false;
      procBtn.classList.toggle('on', Boolean(card._sc.isRunning));
      procBtn.setAttribute('aria-checked', String(Boolean(card._sc.isRunning)));
    });
    q('restart-btn').addEventListener('click', () => {
      runCardAction(card, () => onManageSidecar(card._sc.sidecarId, 'SIDECAR_ACTION_RESTART'));
    });
    const fixAgentBtn = q('fix-agent-btn');
    fixAgentBtn?.addEventListener('click', async () => {
      const curSc = card._sc;
      if (!curSc || fixAgentBtn.disabled) return;
      fixAgentBtn.disabled = true;
      await runCardAction(card, async () => {
        const convId = card._activeWorkspace?.conversationId || '';
        const msg = `Sidecar "${curSc.displayName || curSc.sidecarId}" (${curSc.sidecarId}) is in an errored state (${curSc.statusBadge || 'ERROR'}). Please inspect its setup and server logs and fix the issue.`;
        const res = await (ns.notifyAgent?.(msg, convId, `Sidecar Error: ${curSc.sidecarId}`) ||
          window.AgyShell?.notifyAgent?.(msg, convId, `Sidecar Error: ${curSc.sidecarId}`));
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
    uninstallBtn.addEventListener('click', () => {
      q('uninstall-confirm-text').textContent = `Uninstall ${card._sc.displayName || card._sc.sidecarId}? This removes its link and downloaded packages.`;
      uninstallConfirm.classList.remove('hidden');
    });
    q('uninstall-cancel').addEventListener('click', () => uninstallConfirm.classList.add('hidden'));
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
      q('title').textContent = sc.displayName;
      q('meta-sub').textContent = `${sc.sidecarId} • ${verLabel} • ${sc.source}${sc.webPort ? ` • :${sc.webPort}` : ''}`;
      const statusBadge = q('status-badge');
      const badgeSig = `${badgeInfo.state}:${badgeInfo.label}`;
      if (statusBadge.dataset.sig !== badgeSig) {
        statusBadge.dataset.sig = badgeSig;
        statusBadge.className = `agy-badge ${badgeInfo.state}`;
        ns.setHtml(statusBadge, ns.html`<span class="agy-badge-dot"></span><span>${ns.escHtml(badgeInfo.label)}</span>`);
      }
      q('desc').textContent = sc.description || 'No description provided.';
      const canUninstall = ns.canUninstallSidecar
        ? ns.canUninstallSidecar(sc)
        : (!sc.sidecarId.includes('/') && !sc.parentPluginId && !String(sc.source || '').startsWith('plugin:'));
      q('uninstall-btn').classList.toggle('hidden', !canUninstall);
      q('fix-agent-btn')?.classList.toggle('hidden', !sc.isErrored);
      const upBtn = q('update-btn');
      upBtn.classList.toggle('hidden', !hasUpdate);
      if (hasUpdate && latestVer) upBtn.title = `Update ${sc.displayName} to v${latestVer}`;
      const hibBtn = q('hibernate-btn');
      const hibSig = `${Boolean(sc.autoHibernate)}:${Boolean(sc.autoHibernateLocked)}`;
      if (hibBtn.dataset.sig !== hibSig) {
        hibBtn.dataset.sig = hibSig;
        hibBtn.className = `agy-btn has-icon ${sc.autoHibernate ? 'agy-btn-secondary' : 'agy-btn-outline'}`;
        ns.setHtml(hibBtn, ns.html`${ns.iconSvg('bolt', 13)}<span>Auto-Sleep</span>`);
        hibBtn.title = sc.autoHibernateLocked
          ? "A plugin's sidecar starts and stops with its plugin, so it never hibernates"
          : 'Automatically hibernate process when workspace is inactive';
        hibBtn.disabled = Boolean(sc.autoHibernateLocked);
        hibBtn.setAttribute('aria-pressed', String(Boolean(sc.autoHibernate)));
      }
      const isGlobal = (sc.workspaces || []).includes('*');
      q('global-btn').classList.toggle('active', isGlobal);
      const addWsBtn = q('add-ws-btn');
      const currentWs = activeWorkspace?.workspacePath || '';
      const alreadyHasCurrent = Boolean(
        currentWs && !isGlobal && (sc.workspaces || []).some((w) => w.toLowerCase() === currentWs.toLowerCase()),
      );
      addWsBtn.classList.toggle('active', alreadyHasCurrent);
      const wsBtnLabel = activeWorkspace?.workspaceName || 'Workspace';
      const wsBtnSig = `${alreadyHasCurrent}:${wsBtnLabel}`;
      if (addWsBtn.dataset.sig !== wsBtnSig) {
        addWsBtn.dataset.sig = wsBtnSig;
        ns.setHtml(addWsBtn, ns.html`${ns.iconSvg(alreadyHasCurrent ? 'check' : 'add', 13)}<span>${ns.escHtml(wsBtnLabel)}</span>`);
      }
      addWsBtn.disabled = !currentWs;
      renderRuleList(q('rule-list'), sc, (pat) => {
        runCardAction(card, () => onSaveWorkspaces(card._sc, (card._sc.workspaces || []).filter((w) => w !== pat)));
      });
      const procBtn = q('proc-btn');
      if (!procBtn.disabled) {
        procBtn.classList.toggle('on', Boolean(sc.isRunning));
        procBtn.setAttribute('aria-checked', String(Boolean(sc.isRunning)));
      }
    }
    for (const child of Array.from(paneEl.querySelectorAll('.agy-card'))) {
      if (!seenIds.has(child.dataset.sidecarId)) child.remove();
    }
  };
})();
