/**
 * @fileoverview Renders and reconciles the Sidecar Extension Manager tab shell
 * and Installed extensions pane.
 */

(function () {
  const ns = (window.Hangar = window.Hangar || {});

  let activeSubTab = 'installed'; // 'installed' | 'discover' | 'sideload' | 'settings'
  let settingsFeedback = null; // { tone: 'ok' | 'err', text: string }

  ns.setExtensionsSubTab = function setExtensionsSubTab(tab) {
    activeSubTab = tab;
    settingsFeedback = null;
  };

  function renderRuleList(ruleListEl, sc, onRemovePattern) {
    const patterns = Array.isArray(sc.workspaces) ? sc.workspaces : [];
    const sig = JSON.stringify(patterns);
    if (ruleListEl.dataset.sig === sig) return;
    ruleListEl.dataset.sig = sig;
    ruleListEl.innerHTML = '';

    if (patterns.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'store-subtitle';
      empty.textContent = 'No workspace rules — hidden in all workspaces.';
      ruleListEl.appendChild(empty);
      return;
    }

    for (const pattern of patterns) {
      const row = document.createElement('div');
      row.className = 'ws-rule-item';
      const iconName = pattern === '*' ? 'globe' : pattern.includes('*') ? 'code_blocks' : 'folder';
      const code = document.createElement('span');
      code.className = 'ws-rule-code';
      code.textContent = pattern === '*' ? '* (All Workspaces)' : pattern;

      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'ws-rule-remove';
      rmBtn.title = `Remove rule "${pattern}"`;
      rmBtn.setAttribute('aria-label', `Remove rule ${pattern}`);
      rmBtn.innerHTML = ns.iconSvg('close', 14);
      rmBtn.addEventListener('click', () => onRemovePattern(pattern));

      row.append(ns.iconEl(iconName, 14), code, rmBtn);
      ruleListEl.appendChild(row);
    }
  }

  // Shows a failed card action (uninstall, update, rule save, ...) inline instead of dropping it
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

  function renderWorkspaceSuggestions(sugEl, { suggestions = [], onApplySuggestion }) {
    if (!sugEl) return;
    const list = Array.isArray(suggestions) ? suggestions : [];
    sugEl.classList.toggle('hidden', list.length === 0);
    sugEl._onApplySuggestion = onApplySuggestion;
    const sig = JSON.stringify(list.map((s) => [s.sidecarId, s.name, s.reason, s.actionType]));
    if (sugEl.dataset.sig === sig) return;
    sugEl.dataset.sig = sig;
    sugEl.innerHTML = '';
    if (list.length === 0) return;

    const header = document.createElement('div');
    header.className = 'popover-sug-header';
    header.textContent = 'Suggested for this workspace';
    sugEl.appendChild(header);

    for (const sug of list) {
      const item = document.createElement('div');
      item.className = 'popover-sug-row';

      const info = document.createElement('div');
      info.className = 'popover-sug-info';
      const nameEl = document.createElement('span');
      nameEl.className = 'popover-sug-name';
      nameEl.textContent = sug.name;
      const reasonEl = document.createElement('span');
      reasonEl.className = 'popover-sug-reason';
      reasonEl.textContent = sug.reason;
      info.append(nameEl, reasonEl);

      const actBtn = document.createElement('button');
      actBtn.type = 'button';
      actBtn.className = 'agy-btn agy-btn-primary has-icon';
      const isInstall = sug.actionType === 'install';
      actBtn.innerHTML = `${ns.iconSvg(isInstall ? 'download' : 'check', 13)}<span>${isInstall ? 'Install…' : 'Enable'}</span>`;
      if (isInstall) actBtn.title = 'Opens this sidecar in Discover to review its capability tier before installing';
      actBtn.addEventListener('click', () => sugEl._onApplySuggestion?.(sug));

      item.append(info, actBtn);
      sugEl.appendChild(item);
    }
  }

  function reconcileInstalledPane(
    paneEl,
    {
      sidecars,
      registryPackages,
      activeWorkspace,
      onManageSidecar,
      onSaveWorkspaces,
      onToggleAutoHibernate,
      onInstallRemote,
      onUninstallSidecar,
    }
  ) {
    const regMap = new Map((registryPackages || []).map((p) => [p.id, p]));
    const seenIds = new Set();

    for (const sc of sidecars || []) {
      seenIds.add(sc.sidecarId);
      let card = paneEl.querySelector(`.agy-card[data-sidecar-id="${CSS.escape(sc.sidecarId)}"]`);

      if (!card) {
        card = document.createElement('div');
        card.className = 'agy-card';
        card.dataset.sidecarId = sc.sidecarId;
        card.innerHTML = `
          <div class="agy-card-header">
            <div class="manager-card-title-group">
              <div class="manager-card-title-row">
                <span data-role="title" class="manager-card-title"></span>
                <span data-role="status-badge" class="agy-badge"></span>
              </div>
              <div class="agy-card-meta">
                ${ns.iconSvg('folder', 13)}
                <span data-role="meta-sub"></span>
              </div>
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
                <span class="agy-switch-thumb"></span>
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
              <div class="agy-toggle-group">
                <button type="button" data-role="global-btn" class="agy-toggle-item">
                  ${ns.iconSvg('globe', 13)}<span>Global (*)</span>
                </button>
                <button type="button" data-role="add-ws-btn" class="agy-toggle-item"></button>
              </div>
            </div>
          </div>
          <div data-role="rule-list" class="ws-rule-list"></div>
          <div class="ws-add-row">
            <input type="text" class="ws-input" placeholder="Add workspace path or glob (e.g. C:/Projects/app, *backend*)…" />
            <button type="button" data-role="add-rule-btn" class="agy-btn agy-btn-secondary has-icon">
              ${ns.iconSvg('add', 14)}<span>Add</span>
            </button>
          </div>
        `;

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
          if (e.key === 'Enter') {
            e.preventDefault();
            commitNewPattern();
          }
        });
        card.querySelector('[data-role="add-rule-btn"]').addEventListener('click', commitNewPattern);
        card.querySelector('[data-role="hibernate-btn"]').addEventListener('click', () => {
          if (!card._sc || card._sc.autoHibernateLocked) return;
          runCardAction(card, () => onToggleAutoHibernate?.(card._sc));
        });
        card.querySelector('[data-role="global-btn"]').addEventListener('click', () => {
          const curSc = card._sc;
          const isGlobal = (curSc.workspaces || []).includes('*');
          const fallback = card._activeWorkspace?.workspacePath ? [card._activeWorkspace.workspacePath] : [];
          runCardAction(card, () => onSaveWorkspaces(curSc, isGlobal ? fallback : ['*']));
        });
        card.querySelector('[data-role="add-ws-btn"]').addEventListener('click', () => {
          const currentWs = card._activeWorkspace?.workspacePath || '';
          if (!currentWs) return;
          const existing = (card._sc.workspaces || []).filter((w) => w !== '*');
          const hasCurrent =
            !(card._sc.workspaces || []).includes('*') &&
            existing.some((w) => w.toLowerCase() === currentWs.toLowerCase());
          const next = hasCurrent
            ? existing.filter((w) => w.toLowerCase() !== currentWs.toLowerCase())
            : Array.from(new Set([...existing, currentWs]));
          runCardAction(card, () => onSaveWorkspaces(card._sc, next));
        });
        const procBtn = card.querySelector('[data-role="proc-btn"]');
        procBtn.addEventListener('click', async () => {
          if (procBtn.disabled) return;
          const nextOn = !card._sc.isRunning;
          procBtn.disabled = true;
          procBtn.classList.toggle('on', nextOn);
          procBtn.setAttribute('aria-checked', String(nextOn));
          await runCardAction(card, () =>
            onManageSidecar(card._sc.sidecarId, nextOn ? 'SIDECAR_ACTION_ENABLE' : 'SIDECAR_ACTION_DISABLE')
          );
          procBtn.disabled = false;
          procBtn.classList.toggle('on', Boolean(card._sc.isRunning));
          procBtn.setAttribute('aria-checked', String(Boolean(card._sc.isRunning)));
        });
        card.querySelector('[data-role="restart-btn"]').addEventListener('click', () =>
          runCardAction(card, () => onManageSidecar(card._sc.sidecarId, 'SIDECAR_ACTION_RESTART'))
        );
        const fixAgentBtn = card.querySelector('[data-role="fix-agent-btn"]');
        fixAgentBtn?.addEventListener('click', async () => {
          const curSc = card._sc;
          if (!curSc || fixAgentBtn.disabled) return;
          fixAgentBtn.disabled = true;
          const convId = card._activeWorkspace?.conversationId || '';
          await runCardAction(card, async () => {
            const msg = `Sidecar "${curSc.displayName || curSc.sidecarId}" (${curSc.sidecarId}) is in an errored state (${curSc.statusBadge || 'ERROR'}). Please inspect its setup and server logs and fix the issue.`;
            const res = await ns.notifyAgent?.(msg, convId, `Sidecar Error: ${curSc.sidecarId}`);
            if (res?.ok === false) throw new Error(res.error || 'Could not send message to agent');
            const span = fixAgentBtn.querySelector('span');
            if (span) { span.textContent = 'Sent to Agent'; setTimeout(() => { span.textContent = 'Fix with Agent'; }, 2000); }
          });
          fixAgentBtn.disabled = false;
        });
        const uninstallBtn = card.querySelector('[data-role="uninstall-btn"]');
        const uninstallConfirm = card.querySelector('[data-role="uninstall-confirm"]');
        uninstallBtn.addEventListener('click', () => {
          card.querySelector('[data-role="uninstall-confirm-text"]').textContent =
            `Uninstall ${card._sc.displayName || card._sc.sidecarId}? This removes its link and downloaded packages.`;
          uninstallConfirm.classList.remove('hidden');
        });
        card.querySelector('[data-role="uninstall-cancel"]').addEventListener('click', () => {
          uninstallConfirm.classList.add('hidden');
        });
        card.querySelector('[data-role="uninstall-confirm-btn"]').addEventListener('click', async () => {
          uninstallConfirm.classList.add('hidden');
          uninstallBtn.disabled = true;
          await runCardAction(card, () => onUninstallSidecar?.(card._sc.sidecarId));
          uninstallBtn.disabled = false;
        });
        const upBtn = card.querySelector('[data-role="update-btn"]');
        const updateConfirm = card.querySelector('[data-role="update-confirm"]');
        // acceptedTier is the tier recorded at install (or the registry's listing); an update that
        // scans higher comes back as needsConsent and must be confirmed before anything is replaced
        const runUpdate = async (acceptedTier) => {
          const pkg = card._regPkg;
          const curSc = card._sc;
          const gitRepo = pkg?.release?.gitRepo || curSc?.gitRepo || '';
          const tarballUrl = pkg?.release?.tarballUrl || curSc?.tarballUrl || '';
          const sha256 = (pkg?.release?.sha256 ?? curSc?.sha256) || '';
          const version = pkg?.latestVersion || curSc?.latestVersion || 'latest';
          if (!gitRepo && !tarballUrl) return;
          upBtn.disabled = true;
          updateConfirm.classList.add('hidden');
          await runCardAction(card, async () => {
            const res = await onInstallRemote?.({
              sidecarId: curSc.sidecarId,
              gitRepo,
              tarballUrl,
              sha256,
              version,
              scope: curSc.scope,
              workspaces: curSc.workspaces,
              acceptedTier,
            });
            if (res?.needsConsent) {
              card._pendingTier = res.scannedTier;
              card.querySelector('[data-role="update-confirm-text"]').innerHTML =
                ns.scannedTierConsentHtml(res.scannedTier, 'Update');
              updateConfirm.classList.remove('hidden');
            }
          });
          upBtn.disabled = false;
        };
        upBtn.addEventListener('click', () => {
          card._pendingTier = '';
          runUpdate(card._sc.capabilityTier || card._regPkg?.capabilityTier || 'TIER_1_TELEMETRY');
        });
        card.querySelector('[data-role="update-cancel"]').addEventListener('click', () => {
          card._pendingTier = '';
          updateConfirm.classList.add('hidden');
        });
        card.querySelector('[data-role="update-confirm-btn"]').addEventListener('click', () => {
          runUpdate(card._pendingTier);
        });
        paneEl.appendChild(card);
      }

      card._sc = sc;
      card._activeWorkspace = activeWorkspace;
      card._regPkg = regMap.get(sc.sidecarId) || null;

      const hasUpdate = Boolean(sc.updateAvailable || card._regPkg?.updateAvailable);
      const latestVer = card._regPkg?.latestVersion || sc.latestVersion || '';
      const verLabel = hasUpdate && latestVer
        ? `v${sc.installedVersion || '1.0.0'} → v${latestVer}`
        : `v${sc.installedVersion || '1.0.0'}`;

      const badgeInfo = ns.formatStatusBadge(sc.statusBadge, sc.isRunning, sc.isErrored);
      card.querySelector('[data-role="title"]').textContent = sc.displayName;
      card.querySelector('[data-role="meta-sub"]').textContent =
        `${sc.sidecarId} • ${verLabel} • ${sc.source}${sc.webPort ? ` • :${sc.webPort}` : ''}`;

      const statusBadge = card.querySelector('[data-role="status-badge"]');
      const badgeSig = `${badgeInfo.state}:${badgeInfo.label}`;
      if (statusBadge.dataset.sig !== badgeSig) {
        statusBadge.dataset.sig = badgeSig;
        statusBadge.className = `agy-badge ${badgeInfo.state}`;
        statusBadge.innerHTML = `<span class="agy-badge-dot"></span><span>${ns.escHtml(badgeInfo.label)}</span>`;
      }
      card.querySelector('[data-role="desc"]').textContent = sc.description || 'No description provided.';

      const canUninstall = !sc.sidecarId.includes('/') && !sc.parentPluginId && !String(sc.source || '').startsWith('plugin:');
      card.querySelector('[data-role="uninstall-btn"]').classList.toggle('hidden', !canUninstall);
      card.querySelector('[data-role="fix-agent-btn"]')?.classList.toggle('hidden', !sc.isErrored);

      const upBtn = card.querySelector('[data-role="update-btn"]');
      upBtn.classList.toggle('hidden', !hasUpdate);
      if (hasUpdate && latestVer) {
        upBtn.title = `Update ${sc.displayName} to v${latestVer}`;
      }

      const hibBtn = card.querySelector('[data-role="hibernate-btn"]');
      const hibSig = `${Boolean(sc.autoHibernate)}:${Boolean(sc.autoHibernateLocked)}`;
      if (hibBtn.dataset.sig !== hibSig) {
        hibBtn.dataset.sig = hibSig;
        hibBtn.className = `agy-btn has-icon ${sc.autoHibernate ? 'agy-btn-secondary' : 'agy-btn-outline'}`;
        hibBtn.innerHTML = `${ns.iconSvg('bolt', 13)}<span>Auto-Sleep</span>`;
        hibBtn.title = sc.autoHibernateLocked
          ? "A plugin's sidecar starts and stops with its plugin, so it never hibernates"
          : 'Automatically hibernate process when workspace is inactive';
        hibBtn.disabled = Boolean(sc.autoHibernateLocked);
        hibBtn.setAttribute('aria-pressed', String(Boolean(sc.autoHibernate)));
      }

      const isGlobal = (sc.workspaces || []).includes('*');
      card.querySelector('[data-role="global-btn"]').classList.toggle('active', isGlobal);

      const addWsBtn = card.querySelector('[data-role="add-ws-btn"]');
      const currentWs = activeWorkspace?.workspacePath || '';
      const alreadyHasCurrent = Boolean(
        currentWs && !isGlobal && (sc.workspaces || []).some((w) => w.toLowerCase() === currentWs.toLowerCase())
      );
      addWsBtn.classList.toggle('active', alreadyHasCurrent);
      const wsBtnLabel = activeWorkspace?.workspaceName || 'Workspace';
      const wsBtnSig = `${alreadyHasCurrent}:${wsBtnLabel}`;
      if (addWsBtn.dataset.sig !== wsBtnSig) {
        addWsBtn.dataset.sig = wsBtnSig;
        addWsBtn.innerHTML = `${ns.iconSvg(alreadyHasCurrent ? 'check' : 'add', 13)}<span>${ns.escHtml(wsBtnLabel)}</span>`;
      }
      addWsBtn.disabled = !currentWs;

      renderRuleList(card.querySelector('[data-role="rule-list"]'), sc, (patternToRemove) => {
        runCardAction(card, () =>
          onSaveWorkspaces(card._sc, (card._sc.workspaces || []).filter((w) => w !== patternToRemove))
        );
      });

      const procBtn = card.querySelector('[data-role="proc-btn"]');
      if (!procBtn.disabled) {
        procBtn.classList.toggle('on', Boolean(sc.isRunning));
        procBtn.setAttribute('aria-checked', String(Boolean(sc.isRunning)));
      }
    }

    for (const child of Array.from(paneEl.querySelectorAll('.agy-card'))) {
      if (!seenIds.has(child.dataset.sidecarId)) child.remove();
    }
  }

  function renderSettingsPane(paneEl, opts = {}) {
    if (!paneEl) return;
    paneEl._opts = opts;
    let shell = paneEl.querySelector('[data-role="settings-shell"]');
    if (!shell) {
      paneEl.innerHTML = `
        <div data-role="settings-shell">
          <div data-role="settings-banner" class="agy-banner hidden" role="status"></div>
          <div class="agy-card">
            <div class="agy-card-header">
              <div class="manager-card-title-group">
                <div class="manager-card-title-row">
                  <span class="manager-card-title">Idle Process Hibernation</span>
                  <span data-role="settings-ttl-badge" class="agy-badge running"></span>
                </div>
                <div class="agy-card-meta">Minutes an inactive project's sidecars stay running before Auto-Sleep stops their Node.js processes (1–240 min)</div>
              </div>
              <div class="agy-toggle-group">
                <button type="button" data-role="ttl-5" data-ttl="5" class="agy-toggle-item">5m</button>
                <button type="button" data-role="ttl-10" data-ttl="10" class="agy-toggle-item">10m</button>
                <button type="button" data-role="ttl-30" data-ttl="30" class="agy-toggle-item">30m</button>
                <button type="button" data-role="ttl-60" data-ttl="60" class="agy-toggle-item">60m</button>
              </div>
            </div>
            <div class="ws-add-row">
              <input type="number" min="1" max="240" data-role="settings-ttl-input" class="ws-input" placeholder="Custom idle timeout in minutes (1–240)…" />
              <button type="button" data-role="settings-ttl-save" class="agy-btn agy-btn-secondary">Apply</button>
            </div>
          </div>
          <div class="agy-card">
            <div class="agy-card-header">
              <div class="manager-card-title-group">
                <div class="manager-card-title-row">
                  <span class="manager-card-title">Automatic Updates</span>
                </div>
                <div class="agy-card-meta">Automatically install updates for Hangar and managed extensions when capabilities do not escalate</div>
              </div>
              <div class="agy-toggle-group">
                <button type="button" data-role="auto-update-off" class="agy-toggle-item">Off</button>
                <button type="button" data-role="auto-update-on" class="agy-toggle-item">On</button>
              </div>
            </div>
          </div>
          <div class="agy-card">
            <div class="agy-card-header">
              <div class="manager-card-title-group">
                <div class="manager-card-title-row">
                  <span class="manager-card-title">Extensions Entrypoint</span>
                </div>
                <div class="agy-card-meta">Show Extensions as a tab in the tab bar or as a compact icon button on the top-right bar</div>
              </div>
              <div class="agy-toggle-group">
                <button type="button" data-role="ext-mode-tab" class="agy-toggle-item">Tab Bar</button>
                <button type="button" data-role="ext-mode-button" class="agy-toggle-item">Top-Bar Button</button>
              </div>
            </div>
          </div>
          <div class="agy-card">
            <div class="agy-card-header">
              <div class="manager-card-title-group">
                <div class="manager-card-title-row">
                  <span class="manager-card-title">Interactive Terminal</span>
                </div>
                <div class="agy-card-meta">Show Terminal as a tab in the tab bar or as a compact icon button on the top-right bar</div>
              </div>
              <div class="agy-toggle-group">
                <button type="button" data-role="term-mode-tab" class="agy-toggle-item">Tab Bar</button>
                <button type="button" data-role="term-mode-button" class="agy-toggle-item">Top-Bar Button</button>
              </div>
            </div>
            <div class="manager-section-bar">
              <span class="manager-section-label">Terminal Engine (Native xterm.js iframe or Direct VT100)</span>
              <div class="agy-toggle-group">
                <button type="button" data-role="engine-jetbox" class="agy-toggle-item">Native (Jetbox)</button>
                <button type="button" data-role="engine-direct" class="agy-toggle-item">Direct VT100</button>
              </div>
            </div>
            <div class="manager-section-bar">
              <span class="manager-section-label">External Workspace Terminals (Tabs opened outside Hangar)</span>
              <div class="agy-toggle-group">
                <button type="button" data-role="ext-terms-show" class="agy-toggle-item">Show External</button>
                <button type="button" data-role="ext-terms-hide" class="agy-toggle-item">Hangar Only</button>
              </div>
            </div>
          </div>
        </div>
      `;
      shell = paneEl.querySelector('[data-role="settings-shell"]');
      const applyUpdate = async (patch, okMsg) => {
        try {
          await paneEl._opts?.onUpdateSettings?.(patch);
          settingsFeedback = okMsg ? { tone: 'ok', text: okMsg } : null;
        } catch (err) {
          settingsFeedback = { tone: 'err', text: err?.message || 'Could not save settings' };
        }
        renderSettingsPane(paneEl, paneEl._opts);
      };
      for (const mins of [5, 10, 30, 60]) {
        shell.querySelector(`[data-role="ttl-${mins}"]`)?.addEventListener('click', () => {
          applyUpdate({ hibernateAfterIdleMinutes: mins }, `Updated Auto-Sleep idle timeout to ${mins}m.`);
        });
      }
      const ttlInput = shell.querySelector('[data-role="settings-ttl-input"]');
      const commitTtl = () => {
        const val = Math.max(1, Math.min(240, Math.round(Number(ttlInput.value) || 0)));
        if (!Number.isFinite(val) || val < 1) return;
        applyUpdate({ hibernateAfterIdleMinutes: val }, `Updated Auto-Sleep idle timeout to ${val}m.`);
      };
      ttlInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault?.(); commitTtl(); } });
      shell.querySelector('[data-role="settings-ttl-save"]')?.addEventListener('click', commitTtl);

      shell.querySelector('[data-role="auto-update-off"]')?.addEventListener('click', () => {
        applyUpdate({ autoUpdate: false }, 'Disabled automatic updates.');
      });
      shell.querySelector('[data-role="auto-update-on"]')?.addEventListener('click', () => {
        applyUpdate({ autoUpdate: true }, 'Enabled automatic updates.');
      });

      shell.querySelector('[data-role="ext-mode-tab"]')?.addEventListener('click', () => {
        applyUpdate({ extensionsDisplayMode: 'tab' }, 'Showing Extensions as a tab in the tab bar.');
      });
      shell.querySelector('[data-role="ext-mode-button"]')?.addEventListener('click', () => {
        applyUpdate({ extensionsDisplayMode: 'button' }, 'Showing Extensions as a top-bar icon button.');
      });
      shell.querySelector('[data-role="term-mode-tab"]')?.addEventListener('click', () => {
        applyUpdate({ terminalDisplayMode: 'tab' }, 'Showing Terminal as a tab in the tab bar.');
      });
      shell.querySelector('[data-role="term-mode-button"]')?.addEventListener('click', () => {
        applyUpdate({ terminalDisplayMode: 'button' }, 'Showing Terminal as a top-bar icon button.');
      });
      shell.querySelector('[data-role="ext-terms-show"]')?.addEventListener('click', () => {
        applyUpdate({ showExternalTerminals: true }, 'Showing external workspace terminals inside Hangar.');
      });
      shell.querySelector('[data-role="ext-terms-hide"]')?.addEventListener('click', () => {
        applyUpdate({ showExternalTerminals: false }, 'Hiding external terminals (showing Hangar terminals only).');
      });

      const setEngine = (mode) => {
        ns.saveEngineMode?.(mode);
        settingsFeedback = { tone: 'ok', text: `Switched interactive terminal engine to ${mode === 'direct' ? 'Direct VT100' : 'Native (Jetbox)'}.` };
        renderSettingsPane(paneEl, paneEl._opts);
      };
      shell.querySelector('[data-role="engine-jetbox"]')?.addEventListener('click', () => setEngine('jetbox'));
      shell.querySelector('[data-role="engine-direct"]')?.addEventListener('click', () => setEngine('direct'));
    }

    const bannerEl = shell.querySelector('[data-role="settings-banner"]');
    if (bannerEl) {
      bannerEl.className = settingsFeedback ? `agy-banner ${settingsFeedback.tone === 'err' ? 'is-error' : 'is-success'}` : 'agy-banner hidden';
      bannerEl.textContent = settingsFeedback ? settingsFeedback.text : '';
    }

    const ttl = Number(opts.layout?.hibernateAfterIdleMinutes ?? 10) || 10;
    const ttlBadge = shell.querySelector('[data-role="settings-ttl-badge"]');
    if (ttlBadge) ttlBadge.textContent = `${ttl}m TTL`;
    for (const mins of [5, 10, 30, 60]) {
      shell.querySelector(`[data-role="ttl-${mins}"]`)?.classList.toggle('active', ttl === mins);
    }
    const ttlInput = shell.querySelector('[data-role="settings-ttl-input"]');
    if (ttlInput && document.activeElement !== ttlInput) ttlInput.value = String(ttl);

    const autoUpdate = Boolean(opts.layout?.autoUpdate);
    shell.querySelector('[data-role="auto-update-off"]')?.classList.toggle('active', !autoUpdate);
    shell.querySelector('[data-role="auto-update-on"]')?.classList.toggle('active', autoUpdate);

    const extMode = opts.layout?.extensionsDisplayMode === 'button' ? 'button' : 'tab';
    shell.querySelector('[data-role="ext-mode-tab"]')?.classList.toggle('active', extMode === 'tab');
    shell.querySelector('[data-role="ext-mode-button"]')?.classList.toggle('active', extMode === 'button');

    const termMode = opts.layout?.terminalDisplayMode === 'button' ? 'button' : 'tab';
    shell.querySelector('[data-role="term-mode-tab"]')?.classList.toggle('active', termMode === 'tab');
    shell.querySelector('[data-role="term-mode-button"]')?.classList.toggle('active', termMode === 'button');

    const engineMode = ns.readEngineMode?.() === 'direct' ? 'direct' : 'jetbox';
    shell.querySelector('[data-role="engine-jetbox"]')?.classList.toggle('active', engineMode === 'jetbox');
    shell.querySelector('[data-role="engine-direct"]')?.classList.toggle('active', engineMode === 'direct');

    const showExtTerms = opts.layout?.showExternalTerminals !== false;
    shell.querySelector('[data-role="ext-terms-show"]')?.classList.toggle('active', showExtTerms);
    shell.querySelector('[data-role="ext-terms-hide"]')?.classList.toggle('active', !showExtTerms);
  }

  ns.renderExtensionsTab = function renderExtensionsTab(opts = {}) {
    const { storeViewEl, sidecars = [], hangar = null } = opts;
    if (!storeViewEl) return;

    let shell = storeViewEl.querySelector('[data-role="store-shell"]');
    if (!shell) {
      storeViewEl.innerHTML = `
        <div data-role="store-shell">
          <div data-role="hangar-update-banner" class="agy-banner update hidden">
            <div class="hangar-update-info">
              ${ns.iconSvg('bolt', 14)}
              <span data-role="hangar-update-text"></span>
            </div>
            <button type="button" data-role="hangar-self-update-btn" class="agy-btn agy-btn-primary has-icon">
              ${ns.iconSvg('download', 13)}<span>Update Hangar</span>
            </button>
          </div>
          <div data-role="hangar-update-error" class="agy-banner is-error hidden" role="alert"></div>
          <div class="store-header">
            <div>
              <div class="store-title">
                <span>UI Extensions</span>
                <span data-role="total-count" class="agy-count-pill"></span>
                <span data-role="active-ws-pill" class="agy-count-pill"></span>
                <span data-role="hangar-ver-pill" class="agy-count-pill hidden"></span>
              </div>
              <div class="store-subtitle">Manage workspace scopes, discover sidecars and plugins, or link local folders</div>
            </div>
            <div class="store-header-right">
              <div data-role="subtab-group" class="agy-toggle-group" role="tablist">
                <button type="button" data-subtab="installed" class="agy-toggle-item">Installed</button>
                <button type="button" data-subtab="discover" class="agy-toggle-item">Discover</button>
                <button type="button" data-subtab="sideload" class="agy-toggle-item">Sideload</button>
              </div>
              <button type="button" data-role="check-updates-btn" class="agy-icon-btn" title="Check for updates" aria-label="Check for updates">
                ${ns.iconSvg('refresh', 14)}
              </button>
              <button type="button" data-role="settings-btn" class="agy-icon-btn" title="Hangar settings" aria-label="Hangar settings" aria-pressed="false">
                ${ns.iconSvg('settings', 14)}
              </button>
              <span data-role="running-count" class="agy-badge running"></span>
            </div>
          </div>
          <div data-role="pane-installed">
            <div data-role="workspace-suggestions" class="workspace-suggestions hidden"></div>
            <div data-role="installed-sidecars"></div>
            <div data-role="installed-plugins" class="hidden"></div>
          </div>
          <div data-role="pane-discover" class="hidden"></div>
          <div data-role="pane-sideload" class="hidden"></div>
          <div data-role="pane-settings" class="hidden"></div>
        </div>
      `;
      shell = storeViewEl.querySelector('[data-role="store-shell"]');
      shell.querySelectorAll('[data-subtab]').forEach((btn) => {
        btn.addEventListener('click', () => {
          activeSubTab = btn.dataset.subtab;
          settingsFeedback = null;
          ns.clearSideloadFeedback?.();
          ns.renderExtensionsTab(storeViewEl._lastOpts || opts);
        });
      });

      const settingsBtn = shell.querySelector('[data-role="settings-btn"]');
      settingsBtn?.addEventListener('click', () => {
        activeSubTab = activeSubTab === 'settings' ? 'installed' : 'settings';
        settingsFeedback = null;
        ns.clearSideloadFeedback?.();
        ns.renderExtensionsTab(storeViewEl._lastOpts || opts);
      });

      const checkBtn = shell.querySelector('[data-role="check-updates-btn"]');
      checkBtn?.addEventListener('click', async () => {
        checkBtn.disabled = true;
        try {
          await (storeViewEl._lastOpts || opts)?.onCheckUpdates?.();
        } finally {
          checkBtn.disabled = false;
        }
      });

      const selfUpBtn = shell.querySelector('[data-role="hangar-self-update-btn"]');
      const selfUpError = shell.querySelector('[data-role="hangar-update-error"]');
      selfUpBtn?.addEventListener('click', async () => {
        const curOpts = storeViewEl._lastOpts || opts;
        const h = curOpts?.hangar;
        if (!h || selfUpBtn.disabled) return;
        selfUpError.classList.add('hidden');
        selfUpBtn.disabled = true;
        selfUpBtn.innerHTML = `<span>Updating Hangar…</span>`;
        try {
          await curOpts.onSelfUpdate?.({
            gitRepo: h.gitRepo || '',
            tarballUrl: h.tarballUrl || '',
            sha256: h.sha256 || '',
            version: h.latestVersion || 'latest',
          });
          selfUpBtn.innerHTML = `${ns.iconSvg('download', 13)}<span>Update Hangar</span>`;
          selfUpBtn.disabled = false;
        } catch (err) {
          selfUpError.textContent = err?.message || 'Self-update failed';
          selfUpError.classList.remove('hidden');
          selfUpBtn.innerHTML = `${ns.iconSvg('download', 13)}<span>Retry Update</span>`;
          selfUpBtn.disabled = false;
        }
      });
    }
    storeViewEl._lastOpts = opts;

    const hangarBanner = shell.querySelector('[data-role="hangar-update-banner"]');
    const hangarText = shell.querySelector('[data-role="hangar-update-text"]');
    const hasHangarUpdate = Boolean(hangar?.updateAvailable);
    hangarBanner?.classList.toggle('hidden', !hasHangarUpdate);
    if (!hasHangarUpdate) shell.querySelector('[data-role="hangar-update-error"]')?.classList.add('hidden');
    if (hasHangarUpdate && hangarText) {
      hangarText.innerHTML = `<strong>Hangar v${ns.escHtml(hangar.latestVersion)}</strong> is available (installed: v${ns.escHtml(hangar.installedVersion || '1.0.0')})`;
    }

    shell.querySelector('[data-role="total-count"]').textContent = String(sidecars.length);
    const wsPill = shell.querySelector('[data-role="active-ws-pill"]');
    const wsName = opts.activeWorkspace?.workspaceName || 'Global';
    const wsPath = opts.activeWorkspace?.workspacePath || 'Global (*)';
    const wsSig = `${wsName}:${wsPath}`;
    if (wsPill && wsPill.dataset.sig !== wsSig) {
      wsPill.dataset.sig = wsSig;
      wsPill.title = `Active Workspace: ${wsPath}`;
      wsPill.innerHTML = `${ns.iconSvg('folder', 12)}<span>${ns.escHtml(wsName)}</span>`;
    }
    const verPill = shell.querySelector('[data-role="hangar-ver-pill"]');
    const instVer = String(hangar?.installedVersion || '').trim();
    if (verPill) {
      verPill.classList.toggle('hidden', !instVer);
      if (instVer && verPill.dataset.ver !== instVer) {
        verPill.dataset.ver = instVer;
        verPill.title = `Installed Antigravity Hangar version: v${instVer}`;
        verPill.textContent = `Hangar v${instVer}`;
      }
    }
    const runningCount = sidecars.filter((s) => s.isRunning).length;
    const runningCountEl = shell.querySelector('[data-role="running-count"]');
    if (runningCountEl.dataset.count !== String(runningCount)) {
      runningCountEl.dataset.count = String(runningCount);
      runningCountEl.innerHTML = `<span class="agy-badge-dot"></span><span>${runningCount} Running</span>`;
    }

    shell.querySelectorAll('[data-subtab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.subtab === activeSubTab);
    });
    const settingsBtn = shell.querySelector('[data-role="settings-btn"]');
    if (settingsBtn) {
      const isSettings = activeSubTab === 'settings';
      settingsBtn.classList.toggle('active', isSettings);
      settingsBtn.setAttribute('aria-pressed', String(isSettings));
    }

    const installedPane = shell.querySelector('[data-role="pane-installed"]');
    const discoverPane = shell.querySelector('[data-role="pane-discover"]');
    const sideloadPane = shell.querySelector('[data-role="pane-sideload"]');
    const settingsPane = shell.querySelector('[data-role="pane-settings"]');

    installedPane.classList.toggle('hidden', activeSubTab !== 'installed');
    discoverPane.classList.toggle('hidden', activeSubTab !== 'discover');
    sideloadPane.classList.toggle('hidden', activeSubTab !== 'sideload');
    settingsPane?.classList.toggle('hidden', activeSubTab !== 'settings');

    const switchTab = (tab) => {
      activeSubTab = tab;
      settingsFeedback = null;
      ns.renderExtensionsTab(storeViewEl._lastOpts || opts);
    };

    if (activeSubTab === 'installed') {
      renderWorkspaceSuggestions(installedPane.querySelector('[data-role="workspace-suggestions"]'), {
        suggestions: opts.suggestions,
        onApplySuggestion: opts.onApplySuggestion,
      });
      reconcileInstalledPane(installedPane.querySelector('[data-role="installed-sidecars"]'), { ...opts, onSwitchTab: switchTab });
      ns.renderInstalledPlugins?.(installedPane.querySelector('[data-role="installed-plugins"]'), { ...opts, onSwitchTab: switchTab });
    } else if (activeSubTab === 'discover') {
      ns.renderDiscoverPane?.(discoverPane, { ...opts, onSwitchTab: switchTab });
    } else if (activeSubTab === 'sideload') {
      ns.renderSideloadPane?.(sideloadPane, {
        ...opts,
        onSwitchTab: switchTab,
        rerender: () => ns.renderExtensionsTab(storeViewEl._lastOpts || opts),
      });
    } else if (activeSubTab === 'settings') {
      renderSettingsPane(settingsPane, opts);
    }
  };
})();
