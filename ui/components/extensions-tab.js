/**
 * @fileoverview Renders and reconciles the Sidecar Extension Manager tab shell
 * and Installed extensions pane.
 */

(function () {
  const ns = (window.Hangar = window.Hangar || {});

  let activeSubTab = 'installed'; // 'installed' | 'discover' | 'sideload'

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
      const iconName = pattern === '*' ? 'keep' : pattern.includes('*') ? 'code_blocks' : 'folder';
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

  function reconcileInstalledPane(
    paneEl,
    { sidecars, registryPackages, activeWorkspace, onManageSidecar, onSaveWorkspaces, onInstallRemote, onUninstallSidecar }
  ) {
    const regMap = new Map((registryPackages || []).map((p) => [p.id, p]));
    const seenIds = new Set();

    for (const sc of sidecars || []) {
      seenIds.add(sc.sidecarId);
      let card = paneEl.querySelector(`.manager-card[data-sidecar-id="${CSS.escape(sc.sidecarId)}"]`);

      if (!card) {
        card = document.createElement('div');
        card.className = 'manager-card';
        card.dataset.sidecarId = sc.sidecarId;
        card.innerHTML = `
          <div class="manager-card-header">
            <div class="manager-card-title-group">
              <div class="manager-card-title-row">
                <span data-role="title" class="manager-card-title"></span>
                <span data-role="status-badge" class="badge"></span>
              </div>
              <div class="manager-card-meta">
                ${ns.iconSvg('folder', 13)}
                <span data-role="meta-sub"></span>
              </div>
            </div>
            <div class="manager-card-actions">
              <button type="button" data-role="update-btn" class="agy-btn agy-btn-primary has-icon hidden" title="Update sidecar">
                ${ns.iconSvg('download', 13)}<span>Update</span>
              </button>
              <button type="button" data-role="restart-btn" class="icon-btn" title="Restart sidecar" aria-label="Restart sidecar">
                ${ns.iconSvg('refresh', 14)}
              </button>
              <button type="button" data-role="uninstall-btn" class="icon-btn" title="Uninstall sidecar" aria-label="Uninstall sidecar">
                ${ns.iconSvg('delete', 14)}
              </button>
              <button type="button" role="switch" data-role="proc-btn" class="agy-switch" title="Enable or disable sidecar">
                <span class="agy-switch-thumb"></span>
              </button>
            </div>
          </div>
          <div data-role="desc" class="manager-card-desc"></div>
          <div class="manager-section-bar">
            <span class="manager-section-label">Workspace Scope</span>
            <div class="agy-toggle-group">
              <button type="button" data-role="global-btn" class="agy-toggle-item">
                ${ns.iconSvg('keep', 13)}<span>Global (*)</span>
              </button>
              <button type="button" data-role="add-ws-btn" class="agy-toggle-item"></button>
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
          onSaveWorkspaces(card._sc, Array.from(new Set([...existing, ...incoming])));
        };

        wsInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commitNewPattern();
          }
        });
        card.querySelector('[data-role="add-rule-btn"]').addEventListener('click', commitNewPattern);
        card.querySelector('[data-role="global-btn"]').addEventListener('click', () => {
          const curSc = card._sc;
          const isGlobal = (curSc.workspaces || []).includes('*');
          const fallback = card._activeWorkspace?.workspacePath ? [card._activeWorkspace.workspacePath] : [];
          onSaveWorkspaces(curSc, isGlobal ? fallback : ['*']);
        });
        card.querySelector('[data-role="add-ws-btn"]').addEventListener('click', () => {
          const currentWs = card._activeWorkspace?.workspacePath || '';
          if (!currentWs) return;
          const next = Array.from(new Set([...(card._sc.workspaces || []).filter((w) => w !== '*'), currentWs]));
          onSaveWorkspaces(card._sc, next);
        });
        card.querySelector('[data-role="proc-btn"]').addEventListener('click', () => {
          onManageSidecar(card._sc.sidecarId, card._sc.isRunning ? 'SIDECAR_ACTION_DISABLE' : 'SIDECAR_ACTION_ENABLE');
        });
        card.querySelector('[data-role="restart-btn"]').addEventListener('click', () =>
          onManageSidecar(card._sc.sidecarId, 'SIDECAR_ACTION_RESTART')
        );
        card.querySelector('[data-role="uninstall-btn"]').addEventListener('click', () => {
          onUninstallSidecar?.(card._sc.sidecarId);
        });
        card.querySelector('[data-role="update-btn"]').addEventListener('click', async (e) => {
          const pkg = card._regPkg;
          if (!pkg) return;
          const upBtn = e.currentTarget;
          upBtn.disabled = true;
          try {
            await onInstallRemote?.({
              sidecarId: pkg.id,
              gitRepo: pkg.release?.gitRepo,
              tarballUrl: pkg.release?.tarballUrl,
              version: pkg.latestVersion,
              scope: card._sc.scope,
              workspaces: card._sc.workspaces,
            });
          } catch (err) {
            upBtn.title = err.message || 'Update failed';
          } finally {
            upBtn.disabled = false;
          }
        });
        paneEl.appendChild(card);
      }

      card._sc = sc;
      card._activeWorkspace = activeWorkspace;
      card._regPkg = regMap.get(sc.sidecarId) || null;

      const badgeInfo = ns.formatStatusBadge(sc.statusBadge, sc.isRunning, sc.isErrored);
      card.querySelector('[data-role="title"]').textContent = sc.displayName;
      card.querySelector('[data-role="meta-sub"]').textContent =
        `${sc.sidecarId} • v${sc.installedVersion || '1.0.0'} • ${sc.source}${sc.webPort ? ` • :${sc.webPort}` : ''}`;

      const statusBadge = card.querySelector('[data-role="status-badge"]');
      statusBadge.className = `badge ${badgeInfo.state}`;
      statusBadge.innerHTML = `<span class="badge-dot"></span><span>${ns.escHtml(badgeInfo.label)}</span>`;
      card.querySelector('[data-role="desc"]').textContent = sc.description || 'No description provided.';

      const canUninstall = !sc.sidecarId.includes('/');
      card.querySelector('[data-role="uninstall-btn"]').classList.toggle('hidden', !canUninstall);

      const hasUpdate = Boolean(card._regPkg?.updateAvailable);
      card.querySelector('[data-role="update-btn"]').classList.toggle('hidden', !hasUpdate);

      const isGlobal = (sc.workspaces || []).includes('*');
      card.querySelector('[data-role="global-btn"]').classList.toggle('active', isGlobal);

      const addWsBtn = card.querySelector('[data-role="add-ws-btn"]');
      const currentWs = activeWorkspace?.workspacePath || '';
      const alreadyHasCurrent = currentWs && (sc.workspaces || []).some((w) => w.toLowerCase() === currentWs.toLowerCase());
      addWsBtn.classList.toggle('active', Boolean(alreadyHasCurrent) && !isGlobal);
      addWsBtn.innerHTML = `${ns.iconSvg(alreadyHasCurrent ? 'check' : 'add', 13)}<span>${ns.escHtml(activeWorkspace?.workspaceName || 'Workspace')}</span>`;
      addWsBtn.disabled = !currentWs || Boolean(alreadyHasCurrent);

      renderRuleList(card.querySelector('[data-role="rule-list"]'), sc, (patternToRemove) => {
        onSaveWorkspaces(card._sc, (card._sc.workspaces || []).filter((w) => w !== patternToRemove));
      });

      const procBtn = card.querySelector('[data-role="proc-btn"]');
      procBtn.classList.toggle('on', Boolean(sc.isRunning));
      procBtn.setAttribute('aria-checked', String(Boolean(sc.isRunning)));
    }

    for (const child of Array.from(paneEl.querySelectorAll('.manager-card'))) {
      if (!seenIds.has(child.dataset.sidecarId)) child.remove();
    }
  }

  ns.renderExtensionsTab = function renderExtensionsTab(opts = {}) {
    const { storeViewEl, sidecars = [] } = opts;
    if (!storeViewEl) return;

    let shell = storeViewEl.querySelector('[data-role="store-shell"]');
    if (!shell) {
      storeViewEl.innerHTML = `
        <div data-role="store-shell">
          <div class="store-header">
            <div>
              <div class="store-title"><span>UI Extensions</span><span data-role="total-count" class="count-pill"></span></div>
              <div class="store-subtitle">Manage workspace scopes, discover sidecars, or link local folders</div>
            </div>
            <div class="store-header-right">
              <div data-role="subtab-group" class="agy-toggle-group" role="tablist">
                <button type="button" data-subtab="installed" class="agy-toggle-item">Installed</button>
                <button type="button" data-subtab="discover" class="agy-toggle-item">Discover</button>
                <button type="button" data-subtab="sideload" class="agy-toggle-item">Sideload</button>
              </div>
              <span data-role="running-count" class="badge running"></span>
            </div>
          </div>
          <div data-role="pane-installed"></div>
          <div data-role="pane-discover" class="hidden"></div>
          <div data-role="pane-sideload" class="hidden"></div>
        </div>
      `;
      shell = storeViewEl.querySelector('[data-role="store-shell"]');
      shell.querySelectorAll('[data-subtab]').forEach((btn) => {
        btn.addEventListener('click', () => {
          activeSubTab = btn.dataset.subtab;
          ns.clearSideloadFeedback?.();
          ns.renderExtensionsTab(storeViewEl._lastOpts || opts);
        });
      });
    }
    storeViewEl._lastOpts = opts;

    shell.querySelector('[data-role="total-count"]').textContent = String(sidecars.length);
    const runningCount = sidecars.filter((s) => s.isRunning).length;
    shell.querySelector('[data-role="running-count"]').innerHTML = `<span class="badge-dot"></span><span>${runningCount} Running</span>`;

    shell.querySelectorAll('[data-subtab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.subtab === activeSubTab);
    });

    const installedPane = shell.querySelector('[data-role="pane-installed"]');
    const discoverPane = shell.querySelector('[data-role="pane-discover"]');
    const sideloadPane = shell.querySelector('[data-role="pane-sideload"]');

    installedPane.classList.toggle('hidden', activeSubTab !== 'installed');
    discoverPane.classList.toggle('hidden', activeSubTab !== 'discover');
    sideloadPane.classList.toggle('hidden', activeSubTab !== 'sideload');

    const switchTab = (tab) => {
      activeSubTab = tab;
      ns.renderExtensionsTab(storeViewEl._lastOpts || opts);
    };

    if (activeSubTab === 'installed') {
      reconcileInstalledPane(installedPane, { ...opts, onSwitchTab: switchTab });
    } else if (activeSubTab === 'discover') {
      ns.renderDiscoverPane?.(discoverPane, { ...opts, onSwitchTab: switchTab });
    } else if (activeSubTab === 'sideload') {
      ns.renderSideloadPane?.(sideloadPane, {
        ...opts,
        onSwitchTab: switchTab,
        rerender: () => ns.renderExtensionsTab(storeViewEl._lastOpts || opts),
      });
    }
  };
})();
