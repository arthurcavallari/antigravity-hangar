/** @fileoverview Renders and reconciles the Sidecar Extension Manager tab shell and Settings pane. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  let activeSubTab = 'installed';
  let settingsFeedback = null;
  ns.canUninstallSidecar = (sc) => (
    !sc.sidecarId.includes('/') && !sc.parentPluginId && !String(sc.source || '').startsWith('plugin:')
  );
  ns.setExtensionsSubTab = (tab) => {
    activeSubTab = tab;
    settingsFeedback = null;
  };
  ns.createExtensionsActions = function createExtensionsActions({
    state,
    apiCall,
    bumpLayoutSeq,
    saveLayoutUpdate,
    reopenClosed,
    refreshRegistry,
    refreshHangarState,
    renderAll,
  }) {
    const syncStore = async () => {
      await refreshRegistry();
      await refreshHangarState();
    };
    const callAndSync = (path, mapArg = (x) => x) => async (arg) => {
      const res = await apiCall(path, mapArg(arg));
      await syncStore();
      return res;
    };
    return {
      onCheckUpdates: syncStore,
      onUpdateSettings: async (patch) => {
        if (!apiCall) return;
        bumpLayoutSeq?.();
        const modeKeys = ['extensionsDisplayMode', 'terminalDisplayMode', 'showExternalTerminals'].filter(
          (k) => patch?.[k] !== undefined,
        );
        if (modeKeys.length) {
          for (const k of modeKeys) state.layout[k] = patch[k];
          state.layout.pinnedTopSidecarId = ns.EXTENSIONS_TAB_ID;
          patch = { ...patch, pinnedTopSidecarId: ns.EXTENSIONS_TAB_ID };
        }
        await saveLayoutUpdate(patch);
        await (patch?.autoUpdate ? syncStore() : refreshHangarState());
      },
      onSelfUpdate: async (payload) => {
        if (!apiCall) return;
        await apiCall('/api/store/self-update', payload);
        await new Promise((r) => setTimeout(r, 600));
        await syncStore();
        if (state.hangar?.updateAvailable !== false) {
          const poll = setInterval(async () => {
            await syncStore();
            if (state.hangar?.updateAvailable === false) {
              clearInterval(poll);
              window.location?.reload?.();
            }
          }, 600);
          setTimeout(() => clearInterval(poll), 10000).unref?.();
        }
      },
      onManageSidecar: async (sidecarId, action) => {
        if (!apiCall) return;
        if (action !== 'SIDECAR_ACTION_DISABLE') await reopenClosed?.(sidecarId);
        await apiCall('/api/sidecar/manage', { sidecarId, action });
        await refreshHangarState();
      },
      onSaveWorkspaces: async (sc, patterns) => {
        if (!apiCall) return;
        if (patterns.length) await reopenClosed?.(sc.sidecarId);
        await apiCall('/api/rules/update', {
          sidecarId: sc.sidecarId,
          scope: patterns.includes('*') ? 'global' : 'project',
          workspaces: patterns,
        });
        await refreshHangarState();
      },
      onToggleAutoHibernate: async (sc) => {
        if (!apiCall) return;
        await apiCall('/api/rules/update', {
          sidecarId: sc.sidecarId,
          autoHibernate: !sc.autoHibernate,
        });
        await refreshHangarState();
      },
      onApplySuggestion: async (sug) => {
        if (!apiCall) return;
        if (sug.actionType === 'install') {
          ns.setExtensionsSubTab?.('discover');
          ns.setDiscoverQuery?.(sug.sidecarId);
          renderAll?.();
          return;
        }
        await reopenClosed?.(sug.sidecarId);
        const curWs = (state.sidecars.find((s) => s.sidecarId === sug.sidecarId)?.workspaces || []).filter((w) => w !== '*');
        const wsPath = state.activeWorkspace?.workspacePath || '';
        await apiCall('/api/rules/update', {
          sidecarId: sug.sidecarId,
          scope: 'project',
          workspaces: wsPath ? Array.from(new Set([...curWs, wsPath])) : ['*'],
        });
        await apiCall('/api/sidecar/manage', { sidecarId: sug.sidecarId, action: 'SIDECAR_ACTION_ENABLE' });
        await refreshHangarState();
      },
      onInspectLocal: async (folderPath) => apiCall('/api/store/inspect', { folderPath }),
      onLinkLocal: callAndSync('/api/store/link-local'),
      onInstallRemote: callAndSync('/api/store/install'),
      onUninstallSidecar: callAndSync('/api/store/uninstall', (sidecarId) => ({ sidecarId })),
      onPreviewPlugin: async (payload) => apiCall('/api/store/port-preview', payload),
      onInstallPlugin: callAndSync('/api/store/install-plugin'),
      onUninstallPlugin: callAndSync('/api/store/uninstall-plugin', (pluginId) => ({ pluginId })),
    };
  };

  function renderSettingsPane(paneEl, opts = {}) {
    if (!paneEl) return;
    paneEl._opts = opts;
    let shell = paneEl.querySelector('[data-role="settings-shell"]');
    if (!shell) {
      ns.setHtml(paneEl, ns.html`
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
              <agy-toggle-group class="agy-toggle-group" aria-label="Auto-Sleep idle timeout presets">
                <button type="button" data-role="ttl-5" data-ttl="5" class="agy-toggle-item">5m</button>
                <button type="button" data-role="ttl-10" data-ttl="10" class="agy-toggle-item">10m</button>
                <button type="button" data-role="ttl-30" data-ttl="30" class="agy-toggle-item">30m</button>
                <button type="button" data-role="ttl-60" data-ttl="60" class="agy-toggle-item">60m</button>
              </agy-toggle-group>
            </div>
            <div class="ws-add-row">
              <input type="number" min="1" max="240" data-role="settings-ttl-input" class="ws-input" aria-label="Custom idle timeout in minutes (1 to 240)" placeholder="Custom idle timeout in minutes (1–240)…" />
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
              <agy-toggle-group class="agy-toggle-group" aria-label="Automatic Updates">
                <button type="button" data-role="auto-update-off" data-value="off" class="agy-toggle-item">Off</button>
                <button type="button" data-role="auto-update-on" data-value="on" class="agy-toggle-item">On</button>
              </agy-toggle-group>
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
              <agy-toggle-group class="agy-toggle-group" aria-label="Extensions Entrypoint">
                <button type="button" data-role="ext-mode-tab" data-value="tab" class="agy-toggle-item">Tab Bar</button>
                <button type="button" data-role="ext-mode-button" data-value="button" class="agy-toggle-item">Top-Bar Button</button>
              </agy-toggle-group>
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
              <agy-toggle-group class="agy-toggle-group" aria-label="Interactive Terminal entrypoint">
                <button type="button" data-role="term-mode-tab" data-value="tab" class="agy-toggle-item">Tab Bar</button>
                <button type="button" data-role="term-mode-button" data-value="button" class="agy-toggle-item">Top-Bar Button</button>
              </agy-toggle-group>
            </div>
            <div class="manager-section-bar">
              <span class="manager-section-label">Terminal Engine (Native xterm.js iframe or Direct VT100)</span>
              <agy-toggle-group class="agy-toggle-group" aria-label="Terminal Engine">
                <button type="button" data-role="engine-jetbox" data-value="jetbox" class="agy-toggle-item">Native (Jetbox)</button>
                <button type="button" data-role="engine-direct" data-value="direct" class="agy-toggle-item">Direct VT100</button>
              </agy-toggle-group>
            </div>
            <div class="manager-section-bar">
              <span class="manager-section-label">External Workspace Terminals (Tabs opened outside Hangar)</span>
              <agy-toggle-group class="agy-toggle-group" aria-label="External Workspace Terminals">
                <button type="button" data-role="ext-terms-show" data-value="show" class="agy-toggle-item">Show External</button>
                <button type="button" data-role="ext-terms-hide" data-value="hide" class="agy-toggle-item">Hangar Only</button>
              </agy-toggle-group>
            </div>
          </div>
          <div class="agy-card">
            <div class="agy-card-header">
              <div class="manager-card-title-group">
                <div class="manager-card-title-row">
                  <span class="manager-card-title">Support Hangar Development</span>
                </div>
                <div class="agy-card-meta">Hangar is free and MIT-licensed. Sponsor maintenance and new Antigravity sidecars on GitHub Sponsors.</div>
              </div>
              <a
                data-role="settings-sponsor-link"
                href="https://github.com/sponsors/arthurcavallari"
                target="_blank"
                rel="noopener noreferrer"
                class="agy-btn agy-btn-outline has-icon sponsor-cta-btn"
              >
                ${ns.iconSvg('favorite', 16)}<span>Sponsor</span>
              </a>
            </div>
          </div>
        </div>
      `);
      shell = paneEl.querySelector('[data-role="settings-shell"]');
      const q = (role) => shell.querySelector(`[data-role="${role}"]`);
      const applyUpdate = async (patch, okMsg) => {
        try {
          await paneEl._opts?.onUpdateSettings?.(patch);
          settingsFeedback = okMsg ? { tone: 'ok', text: okMsg } : null;
        } catch (err) {
          settingsFeedback = { tone: 'err', text: err?.message || 'Could not save settings' };
        }
        renderSettingsPane(paneEl, paneEl._opts);
      };
      const bindToggle = (role, patch, msg) => q(role)?.addEventListener('click', () => applyUpdate(patch, msg));
      for (const mins of [5, 10, 30, 60]) {
        bindToggle(`ttl-${mins}`, { hibernateAfterIdleMinutes: mins }, `Updated Auto-Sleep idle timeout to ${mins}m.`);
      }
      const ttlInput = q('settings-ttl-input');
      const commitTtl = () => {
        const raw = Number.parseInt(ttlInput?.value, 10);
        if (!Number.isFinite(raw) || raw < 1) {
          ttlInput?.focus?.();
          return;
        }
        const val = Math.min(240, raw);
        applyUpdate({ hibernateAfterIdleMinutes: val }, `Updated Auto-Sleep idle timeout to ${val}m.`);
      };
      ttlInput?.addEventListener('keydown', (e) => e.key === 'Enter' && commitTtl());
      q('settings-ttl-save')?.addEventListener('click', commitTtl);
      for (const [role, patch, msg] of [
        ['auto-update-off', { autoUpdate: false }, 'Disabled automatic updates.'],
        ['auto-update-on', { autoUpdate: true }, 'Enabled automatic updates.'],
        ['ext-mode-tab', { extensionsDisplayMode: 'tab' }, 'Showing Extensions as a tab in the tab bar.'],
        ['ext-mode-button', { extensionsDisplayMode: 'button' }, 'Showing Extensions as a top-bar icon button.'],
        ['term-mode-tab', { terminalDisplayMode: 'tab' }, 'Showing Terminal as a tab in the tab bar.'],
        ['term-mode-button', { terminalDisplayMode: 'button' }, 'Showing Terminal as a top-bar icon button.'],
        ['ext-terms-show', { showExternalTerminals: true }, 'Showing external workspace terminals inside Hangar.'],
        ['ext-terms-hide', { showExternalTerminals: false }, 'Hiding external terminals (showing Hangar terminals only).'],
      ]) {
        bindToggle(role, patch, msg);
      }
      const setEngine = (mode) => {
        ns.saveEngineMode?.(mode);
        settingsFeedback = {
          tone: 'ok',
          text: `Switched interactive terminal engine to ${mode === 'direct' ? 'Direct VT100' : 'Native (Jetbox)'}.`,
        };
        renderSettingsPane(paneEl, paneEl._opts);
      };
      q('engine-jetbox')?.addEventListener('click', () => setEngine('jetbox'));
      q('engine-direct')?.addEventListener('click', () => setEngine('direct'));
    }
    const q = (role) => shell.querySelector(`[data-role="${role}"]`);
    const bannerEl = q('settings-banner');
    if (bannerEl) {
      bannerEl.className = settingsFeedback
        ? `agy-banner ${settingsFeedback.tone === 'err' ? 'is-error' : 'is-success'}`
        : 'agy-banner hidden';
      bannerEl.textContent = settingsFeedback ? settingsFeedback.text : '';
    }
    const ttl = Number(opts.layout?.hibernateAfterIdleMinutes ?? 10) || 10;
    if (q('settings-ttl-badge')) q('settings-ttl-badge').textContent = `${ttl}m TTL`;
    for (const mins of [5, 10, 30, 60]) q(`ttl-${mins}`)?.classList.toggle('active', ttl === mins);
    if (q('settings-ttl-input') && document.activeElement !== q('settings-ttl-input')) {
      q('settings-ttl-input').value = String(ttl);
    }
    for (const [onRole, offRole, isOn] of [
      ['auto-update-on', 'auto-update-off', opts.layout?.autoUpdate],
      ['ext-mode-button', 'ext-mode-tab', opts.layout?.extensionsDisplayMode === 'button'],
      ['term-mode-button', 'term-mode-tab', opts.layout?.terminalDisplayMode === 'button'],
      ['engine-direct', 'engine-jetbox', ns.readEngineMode?.() === 'direct'],
      ['ext-terms-show', 'ext-terms-hide', opts.layout?.showExternalTerminals !== false],
    ]) {
      q(onRole)?.classList.toggle('active', Boolean(isOn));
      q(offRole)?.classList.toggle('active', !isOn);
    }
    shell.querySelectorAll?.('agy-toggle-group')?.forEach?.((g) => g.sync?.());
    const sponsorHref = ns.sanitizeHttpsUrl?.(opts.hangar?.funding) || ns.DEFAULT_SPONSOR_URL || 'https://github.com/sponsors/arthurcavallari';
    if (q('settings-sponsor-link')) {
      q('settings-sponsor-link').href = sponsorHref;
    }
  }

  ns.renderExtensionsTab = function renderExtensionsTab(opts = {}) {
    const { storeViewEl, sidecars = [], hangar = null } = opts;
    if (!storeViewEl) return;
    let shell = storeViewEl.querySelector('[data-role="store-shell"]');
    if (!shell) {
      ns.setHtml(storeViewEl, ns.html`
        <div data-role="store-shell">
          <div data-role="hangar-update-banner" class="agy-banner update hidden">
            <div class="hangar-update-info">
              ${ns.iconSvg('bolt', 16)}
              <span data-role="hangar-update-text"></span>
            </div>
            <button type="button" data-role="hangar-self-update-btn" class="agy-btn agy-btn-primary has-icon">
              ${ns.iconSvg('download', 16)}<span>Update Hangar</span>
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
              <agy-toggle-group data-role="subtab-group" class="agy-toggle-group" role="tablist" aria-label="Extensions views">
                <button type="button" data-subtab="installed" class="agy-toggle-item">Installed</button>
                <button type="button" data-subtab="discover" class="agy-toggle-item">Discover</button>
                <button type="button" data-subtab="sideload" class="agy-toggle-item">Sideload</button>
              </agy-toggle-group>
              <button type="button" data-role="check-updates-btn" class="agy-icon-btn" title="Check for updates" aria-label="Check for updates">
                ${ns.iconSvg('refresh', 16)}
              </button>
              <a
                data-role="sponsor-header-link"
                href="https://github.com/sponsors/arthurcavallari"
                target="_blank"
                rel="noopener noreferrer"
                class="agy-icon-btn sponsor-link-btn"
                title="Sponsor Hangar development"
                aria-label="Sponsor Hangar development"
              >
                ${ns.iconSvg('favorite', 16)}
              </a>
              <button type="button" data-role="settings-btn" class="agy-icon-btn" title="Hangar settings" aria-label="Hangar settings" aria-pressed="false">
                ${ns.iconSvg('settings', 16)}
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
      `);
      shell = storeViewEl.querySelector('[data-role="store-shell"]');
      const q = (role) => shell.querySelector(`[data-role="${role}"]`);
      const switchSubTab = (nextTab) => {
        activeSubTab = nextTab;
        settingsFeedback = null;
        ns.clearSideloadFeedback?.();
        ns.renderExtensionsTab(storeViewEl._lastOpts || opts);
      };
      shell.querySelectorAll('[data-subtab]').forEach((btn) => {
        btn.addEventListener('click', () => switchSubTab(btn.dataset.subtab));
      });
      q('settings-btn')?.addEventListener('click', () => {
        switchSubTab(activeSubTab === 'settings' ? 'installed' : 'settings');
      });
      const checkBtn = q('check-updates-btn');
      checkBtn?.addEventListener('click', async () => {
        checkBtn.disabled = true;
        checkBtn.classList?.add?.('spinning');
        try {
          await (storeViewEl._lastOpts || opts)?.onCheckUpdates?.();
        } finally {
          checkBtn.classList?.remove?.('spinning');
          checkBtn.disabled = false;
        }
      });
      const selfUpBtn = q('hangar-self-update-btn');
      const selfUpError = q('hangar-update-error');
      selfUpBtn?.addEventListener('click', async () => {
        const h = (storeViewEl._lastOpts || opts)?.hangar;
        if (!h || selfUpBtn.disabled) return;
        selfUpError.classList.add('hidden');
        selfUpBtn.disabled = true;
        ns.setHtml(selfUpBtn, ns.html`<span>Updating Hangar…</span>`);
        try {
          await (storeViewEl._lastOpts || opts).onSelfUpdate?.({
            gitRepo: h.gitRepo || '',
            tarballUrl: h.tarballUrl || '',
            sha256: h.sha256 || '',
            version: h.latestVersion || 'latest',
          });
          if ((storeViewEl._lastOpts || opts)?.hangar?.updateAvailable === false) {
            ns.setHtml(selfUpBtn, ns.html`${ns.iconSvg('download', 16)}<span>Update Hangar</span>`);
            selfUpBtn.disabled = false;
            window.location?.reload?.();
          } else {
            ns.setHtml(selfUpBtn, ns.html`<span>Restarting Hangar…</span>`);
          }
        } catch (err) {
          selfUpError.textContent = err?.message || 'Self-update failed';
          ns.setHtml(selfUpBtn, ns.html`${ns.iconSvg('download', 16)}<span>Retry Update</span>`);
          selfUpError.classList.remove('hidden');
          selfUpBtn.disabled = false;
        }
      });
    }
    storeViewEl._lastOpts = opts;
    const q = (role) => shell.querySelector(`[data-role="${role}"]`);
    const hasHangarUpdate = Boolean(hangar?.updateAvailable);
    q('hangar-update-banner')?.classList.toggle('hidden', !hasHangarUpdate);
    if (!hasHangarUpdate) q('hangar-update-error')?.classList.add('hidden');
    if (hasHangarUpdate && q('hangar-update-text')) {
      ns.setHtml(
        q('hangar-update-text'),
        ns.html`
          <strong>Hangar v${ns.escHtml(hangar.latestVersion)}</strong>
          is available (installed: v${ns.escHtml(hangar.installedVersion || '1.0.0')})
        `,
      );
    }
    q('total-count').textContent = String(sidecars.length);
    const wsPill = q('active-ws-pill');
    const wsName = opts.activeWorkspace?.workspaceName || 'Global';
    const wsPath = opts.activeWorkspace?.workspacePath || 'Global (*)';
    const wsSig = `${wsName}:${wsPath}`;
    if (wsPill && wsPill.dataset.sig !== wsSig) {
      wsPill.title = `Active Workspace: ${wsPath}`;
      ns.setHtml(wsPill, ns.html`${ns.iconSvg('folder', 12)}<span>${ns.escHtml(wsName)}</span>`);
      wsPill.dataset.sig = wsSig;
    }
    const verPill = q('hangar-ver-pill');
    const instVer = String(hangar?.installedVersion || '').trim();
    if (verPill) {
      verPill.classList.toggle('hidden', !instVer);
      if (instVer && verPill.dataset.ver !== instVer) {
        Object.assign(verPill, {
          title: `Installed Antigravity Hangar version: v${instVer}`,
          textContent: `Hangar v${instVer}`,
        });
      }
      if (instVer) verPill.dataset.ver = instVer;
    }
    const sponsorUrl = ns.sanitizeHttpsUrl?.(hangar?.funding) || ns.DEFAULT_SPONSOR_URL || 'https://github.com/sponsors/arthurcavallari';
    if (q('sponsor-header-link') && q('sponsor-header-link').href !== sponsorUrl) {
      q('sponsor-header-link').href = sponsorUrl;
    }
    const runningCount = sidecars.filter((s) => s.isRunning).length;
    const runningCountEl = q('running-count');
    if (runningCountEl.dataset.count !== String(runningCount)) {
      ns.setHtml(runningCountEl, ns.html`<span class="agy-badge-dot"></span><span>${runningCount} Running</span>`);
      runningCountEl.dataset.count = String(runningCount);
    }
    const subtabGroup = q('subtab-group');
    shell.querySelectorAll('[data-subtab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.subtab === activeSubTab);
    });
    if (subtabGroup) {
      subtabGroup.value = activeSubTab === 'settings' ? '' : activeSubTab;
      subtabGroup.sync?.();
    }
    q('settings-btn')?.classList.toggle('active', activeSubTab === 'settings');
    q('settings-btn')?.setAttribute('aria-pressed', String(activeSubTab === 'settings'));
    for (const tab of ['installed', 'discover', 'sideload', 'settings']) {
      q(`pane-${tab}`)?.classList.toggle('hidden', activeSubTab !== tab);
    }
    const switchTab = (tab) => {
      activeSubTab = tab;
      settingsFeedback = null;
      ns.renderExtensionsTab(storeViewEl._lastOpts || opts);
    };
    const installedPane = q('pane-installed');
    if (activeSubTab === 'installed') {
      ns.renderWorkspaceSuggestions?.(installedPane.querySelector('[data-role="workspace-suggestions"]'), {
        suggestions: opts.suggestions,
        onApplySuggestion: opts.onApplySuggestion,
      });
      ns.reconcileInstalledPane?.(installedPane.querySelector('[data-role="installed-sidecars"]'), {
        ...opts,
        onSwitchTab: switchTab,
      });
      ns.renderInstalledPlugins?.(installedPane.querySelector('[data-role="installed-plugins"]'), {
        ...opts,
        onSwitchTab: switchTab,
      });
    } else if (activeSubTab === 'discover') {
      ns.renderDiscoverPane?.(q('pane-discover'), { ...opts, onSwitchTab: switchTab });
    } else if (activeSubTab === 'sideload') {
      ns.renderSideloadPane?.(q('pane-sideload'), {
        ...opts,
        onSwitchTab: switchTab,
        rerender: () => ns.renderExtensionsTab(storeViewEl._lastOpts || opts),
      });
    } else if (activeSubTab === 'settings') {
      renderSettingsPane(q('pane-settings'), opts);
    }
  };
})();
