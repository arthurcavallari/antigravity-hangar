/**
 * @fileoverview Renders the Discover (Marketplace catalog) and Sideload (Local / GitHub)
 * sub-panes inside Hangar's Extensions view.
 */

(function () {
  const ns = (window.Hangar = window.Hangar || {});

  let searchQuery = '';
  let activeCategory = 'all';
  let sideloadScope = 'project';
  let sideloadFeedback = null; // { tone: 'ok' | 'err' | 'info', text: string }

  ns.clearSideloadFeedback = function clearSideloadFeedback() {
    sideloadFeedback = null;
  };

  ns.setDiscoverQuery = function setDiscoverQuery(query = '') {
    searchQuery = String(query);
    activeCategory = 'all';
  };

  // Shown when Hangar's scan of the downloaded code found more access than the user had agreed to
  ns.scannedTierConsentHtml = function scannedTierConsentHtml(scannedTier, verb = 'Install') {
    const tier = ns.formatCapabilityTier(scannedTier);
    return `<strong>${ns.escHtml(tier.label)}:</strong> Hangar's scan of the downloaded code found it needs this access. ${verb} anyway?`;
  };

  function declaredTierConsentHtml(declaredTier) {
    const tier = ns.formatCapabilityTier(declaredTier);
    return `<strong>${ns.escHtml(tier.label)}:</strong> Grants local CLI or agent cascade access. Proceed?`;
  }

  function reconcileDiscoverList(paneEl) {
    const { sidecars = [], plugins = [], registryPackages = [] } = paneEl._ctx || {};
    const listEl = paneEl.querySelector('[data-role="discover-list"]');
    if (!listEl) return;

    const installedIds = new Set([...sidecars.map((s) => s.sidecarId), ...plugins.map((p) => p.pluginId).filter(Boolean)]);
    const q = searchQuery.toLowerCase().trim();
    const filtered = registryPackages.filter((pkg) => {
      const matchesCat = activeCategory === 'all' || (pkg.categories || []).includes(activeCategory);
      const matchesQuery =
        !q ||
        pkg.name.toLowerCase().includes(q) ||
        pkg.id.toLowerCase().includes(q) ||
        (pkg.tagline || '').toLowerCase().includes(q);
      return matchesCat && matchesQuery;
    });

    const seenIds = new Set();
    for (let i = 0; i < filtered.length; i++) {
      const pkg = filtered[i];
      seenIds.add(pkg.id);
      const isInstalled = installedIds.has(pkg.id) || Boolean(pkg.isInstalled);
      const tier = ns.formatCapabilityTier(pkg.capabilityTier);
      const requiresConsent = Boolean(pkg.capabilityTier && pkg.capabilityTier !== 'TIER_1_TELEMETRY');

      let card = listEl.querySelector(`.manager-card[data-pkg-id="${CSS.escape(pkg.id)}"]`);
      if (!card) {
        card = document.createElement('div');
        card.className = 'manager-card';
        card.dataset.pkgId = pkg.id;
        card.innerHTML = `
          <div class="manager-card-header">
            <div class="manager-card-title-group">
              <div class="manager-card-title-row">
                <span data-role="pkg-title" class="manager-card-title"></span>
                <span data-role="pkg-tier" class="badge" title="Capability Tier"></span>
                <span data-role="pkg-kind" class="badge-group"></span>
              </div>
              <div data-role="pkg-meta" class="manager-card-meta"></div>
            </div>
            <div class="manager-card-actions">
              <button type="button" data-role="pkg-install-btn" class="agy-btn has-icon"></button>
            </div>
          </div>
          <div data-role="pkg-desc" class="manager-card-desc"></div>
          <div data-role="consent-bar" class="consent-bar hidden">
            <span data-role="consent-text" class="consent-text"></span>
            <div class="consent-actions">
              <button type="button" data-role="consent-cancel" class="agy-btn agy-btn-outline">Cancel</button>
              <button type="button" data-role="consent-confirm" class="agy-btn agy-btn-primary">Confirm Install</button>
            </div>
          </div>
          <div data-role="card-error" class="sideload-banner err hidden" role="alert"></div>
        `;

        const btn = card.querySelector('[data-role="pkg-install-btn"]');
        const consentBar = card.querySelector('[data-role="consent-bar"]');
        const consentText = card.querySelector('[data-role="consent-text"]');
        const errorEl = card.querySelector('[data-role="card-error"]');
        const resetInstallBtn = (label) => {
          btn.disabled = false;
          btn.dataset.btnState = label === 'Install' ? 'install' : 'retry';
          btn.innerHTML = `${ns.iconSvg('download', 13)}<span>${label}</span>`;
        };
        // Plugins install through plugin-panes.js: a dry-run port fills this card's consent bar first
        const pluginEls = { btn, consentBar, consentText, errorEl, reset: resetInstallBtn };
        const runInstall = async () => {
          if (card._isInstalling || card._isInstalled) return;
          card._isInstalling = true;
          btn.disabled = true;
          btn.dataset.btnState = 'installing';
          btn.innerHTML = `<span>Installing…</span>`;
          consentBar.classList.add('hidden');
          errorEl.classList.add('hidden');
          try {
            const curPkg = card._pkg;
            const ctx = paneEl._ctx || {};
            const wsPath = ctx.activeWorkspace?.workspacePath;
            const isGlobalPkg = (curPkg.workspaceTriggers?.files || []).includes('*');
            const res = await ctx.onInstallRemote?.({
              sidecarId: curPkg.id,
              ...ns.sidecarReleaseFields(curPkg.release),
              version: curPkg.latestVersion || '1.0.0',
              scope: isGlobalPkg ? 'global' : 'project',
              workspaces: isGlobalPkg ? ['*'] : wsPath ? [wsPath] : ['*'],
              acceptedTier: card._acceptedTier || curPkg.capabilityTier || 'TIER_1_TELEMETRY',
            });
            card._isInstalling = false;
            if (res?.needsConsent) {
              card._pendingTier = res.scannedTier;
              consentText.innerHTML = ns.scannedTierConsentHtml(res.scannedTier);
              consentBar.classList.remove('hidden');
              resetInstallBtn('Install');
              return;
            }
            ctx.onSwitchTab?.('installed');
          } catch (err) {
            card._isInstalling = false;
            resetInstallBtn('Retry Install');
            errorEl.textContent = err.message || 'Install failed';
            errorEl.classList.remove('hidden');
          }
        };

        btn.addEventListener('click', () => {
          if (card._isInstalled || card._isInstalling) return;
          if (card._pkg.kind === 'plugin') return ns.previewPluginInstall?.(card, pluginEls, paneEl._ctx || {}, card._pkg);
          // Every attempt starts from the registry's listed tier; a scanned one must be re-confirmed
          card._pendingTier = '';
          card._acceptedTier = '';
          consentText.innerHTML = declaredTierConsentHtml(card._pkg.capabilityTier);
          if (card._requiresConsent) {
            consentBar.classList.remove('hidden');
          } else {
            runInstall();
          }
        });
        card.querySelector('[data-role="consent-cancel"]').addEventListener('click', () => {
          card._pendingTier = '';
          consentBar.classList.add('hidden');
        });
        card.querySelector('[data-role="consent-confirm"]').addEventListener('click', () => {
          if (card._pkg.kind === 'plugin') return ns.confirmPluginInstall?.(card, pluginEls, paneEl._ctx || {}, card._pkg);
          card._acceptedTier = card._pendingTier || card._pkg.capabilityTier || 'TIER_1_TELEMETRY';
          runInstall();
        });
      }

      card._pkg = pkg;
      card._isInstalled = isInstalled;
      card._requiresConsent = requiresConsent;

      const isPlugin = pkg.kind === 'plugin';
      const metaSig = JSON.stringify({
        name: pkg.name,
        kind: [pkg.kind || 'sidecar', pkg.port?.from || ''],
        tierState: tier.state,
        tierLabel: tier.label,
        verified: Boolean(pkg.author?.verified),
        author: pkg.author?.name || 'Community',
        ver: pkg.latestVersion || '1.0.0',
        cats: (pkg.categories || []).join(', '),
        tagline: pkg.tagline || '',
      });
      if (card.dataset.metaSig !== metaSig) {
        card.dataset.metaSig = metaSig;
        card.querySelector('[data-role="pkg-title"]').textContent = pkg.name;
        const tierEl = card.querySelector('[data-role="pkg-tier"]');
        tierEl.className = `badge ${tier.state}`;
        tierEl.innerHTML = `${ns.iconSvg('shield', 11)}<span>${ns.escHtml(tier.label)}</span>`;
        card.querySelector('[data-role="pkg-kind"]').innerHTML = isPlugin ? ns.pluginBadgesHtml?.(pkg) || '' : '';
        card.querySelector('[data-role="pkg-meta"]').innerHTML = `
          ${pkg.author?.verified ? ns.iconSvg('verified', 12) : ''}
          <span>${ns.escHtml(pkg.author?.name || 'Community')} • v${ns.escHtml(pkg.latestVersion || '1.0.0')} • ${ns.escHtml((pkg.categories || []).join(', '))}</span>
        `;
        card.querySelector('[data-role="pkg-desc"]').textContent = pkg.tagline || '';
        // A plugin's consent text is its port report, which only a fresh preview may replace
        if (!isPlugin) {
          card.querySelector('[data-role="consent-text"]').innerHTML = card._pendingTier
            ? ns.scannedTierConsentHtml(card._pendingTier)
            : declaredTierConsentHtml(pkg.capabilityTier);
        }
      }

      if (!card._isInstalling) {
        const btn = card.querySelector('[data-role="pkg-install-btn"]');
        const targetState = isInstalled ? 'installed' : btn.dataset.btnState === 'retry' ? 'retry' : 'install';
        if (isInstalled) {
          card.querySelector('[data-role="consent-bar"]')?.classList.add('hidden');
        }
        if (btn.dataset.btnState !== targetState) {
          btn.dataset.btnState = targetState;
          btn.className = `agy-btn ${isInstalled ? 'agy-btn-outline' : 'agy-btn-primary'} has-icon`;
          btn.disabled = isInstalled;
          btn.innerHTML = `${ns.iconSvg(isInstalled ? 'check' : 'download', 13)}<span>${isInstalled ? 'Installed' : 'Install'}</span>`;
          if (isInstalled) btn.removeAttribute('title');
        }
      }

      if (listEl.children[i] !== card) {
        listEl.insertBefore(card, listEl.children[i] || null);
      }
    }

    for (const child of Array.from(listEl.querySelectorAll('.manager-card'))) {
      if (!seenIds.has(child.dataset.pkgId)) child.remove();
    }
  }

  ns.renderDiscoverPane = function renderDiscoverPane(paneEl, ctx = {}) {
    if (!paneEl) return;
    paneEl._ctx = ctx;

    let shell = paneEl.querySelector('[data-role="discover-shell"]');
    if (!shell) {
      const categories = ['all', 'telemetry', 'devops', 'productivity'];
      paneEl.innerHTML = `
        <div data-role="discover-shell">
          <div class="discover-toolbar">
            <div class="search-box">
              ${ns.iconSvg('search', 14)}
              <input type="search" data-role="discover-search" class="search-input" placeholder="Search sidecars and plugins…" />
            </div>
            <div class="agy-toggle-group">
              ${categories.map((c) => `<button type="button" data-cat="${c}" class="agy-toggle-item">${c.charAt(0).toUpperCase() + c.slice(1)}</button>`).join('')}
            </div>
          </div>
          <div data-role="discover-list"></div>
        </div>
      `;
      shell = paneEl.querySelector('[data-role="discover-shell"]');
      const searchInput = shell.querySelector('[data-role="discover-search"]');
      searchInput.value = searchQuery;
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value;
        reconcileDiscoverList(paneEl);
      });

      shell.querySelectorAll('[data-cat]').forEach((btn) => {
        btn.addEventListener('click', () => {
          activeCategory = btn.dataset.cat;
          shell.querySelectorAll('[data-cat]').forEach((b) => {
            b.classList.toggle('active', b.dataset.cat === activeCategory);
          });
          reconcileDiscoverList(paneEl);
        });
      });
    }

    const searchInput = shell.querySelector('[data-role="discover-search"]');
    if (searchInput && document.activeElement !== searchInput && searchInput.value !== searchQuery) {
      searchInput.value = searchQuery;
    }
    shell.querySelectorAll('[data-cat]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.cat === activeCategory);
    });

    reconcileDiscoverList(paneEl);
  };

  function syncSideloadState(paneEl) {
    const shell = paneEl?.querySelector('[data-role="sideload-shell"]');
    if (!shell) return;
    const { activeWorkspace } = paneEl._ctx || {};
    const wsName = activeWorkspace?.workspaceName || 'Current Workspace';

    const bannerEl = shell.querySelector('[data-role="sideload-banner"]');
    if (bannerEl) {
      if (sideloadFeedback) {
        bannerEl.className = `sideload-banner ${sideloadFeedback.tone}`;
        bannerEl.textContent = sideloadFeedback.text;
      } else {
        bannerEl.className = 'sideload-banner hidden';
        bannerEl.textContent = '';
      }
    }

    const wsLabelEl = shell.querySelector('[data-role="ws-scope-label"]');
    if (wsLabelEl && wsLabelEl.textContent !== wsName) {
      wsLabelEl.textContent = wsName;
    }

    shell.querySelectorAll('[data-scope]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.scope === sideloadScope);
    });
  }

  ns.renderSideloadPane = function renderSideloadPane(paneEl, ctx = {}) {
    if (!paneEl) return;
    paneEl._ctx = ctx;

    let shell = paneEl.querySelector('[data-role="sideload-shell"]');
    if (!shell) {
      paneEl.innerHTML = `
        <div data-role="sideload-shell">
          <div data-role="sideload-banner" class="sideload-banner hidden"></div>
          <div class="manager-card">
            <div class="manager-card-header">
              <div class="manager-card-title-group">
                <div class="manager-card-title-row">
                  <span class="manager-card-title">Link Local Sidecar Folder</span>
                  <span class="badge running">Development</span>
                </div>
                <div class="manager-card-meta">Creates a live NTFS junction / symlink to a local directory containing sidecar.json</div>
              </div>
              <div class="agy-toggle-group">
                <button type="button" data-scope="project" class="agy-toggle-item">${ns.iconSvg('folder', 13)}<span data-role="ws-scope-label"></span></button>
                <button type="button" data-scope="global" class="agy-toggle-item">${ns.iconSvg('keep', 13)}<span>Global (*)</span></button>
              </div>
            </div>
            <div class="ws-add-row">
              <input type="text" data-role="local-path-input" class="ws-input" placeholder="Local directory path (e.g. C:/path/to/my/agy-sidecar)…" />
              <button type="button" data-role="validate-btn" class="agy-btn agy-btn-outline has-icon">${ns.iconSvg('shield', 13)}<span>Validate</span></button>
              <button type="button" data-role="link-btn" class="agy-btn agy-btn-primary has-icon">${ns.iconSvg('link', 13)}<span>Link Folder</span></button>
            </div>
          </div>

          <div class="manager-card">
            <div class="manager-card-header">
              <div class="manager-card-title-group">
                <div class="manager-card-title-row">
                  <span class="manager-card-title">Install from GitHub Repository</span>
                  <span class="badge starting">Git Clone</span>
                </div>
                <div class="manager-card-meta">Clones into ~/.gemini/hangar/packages/ with --ignore-scripts protection</div>
              </div>
            </div>
            <div class="ws-add-row">
              <input type="text" data-role="github-repo-input" class="ws-input" placeholder="https://github.com/owner/repo or owner/repo…" />
              <button type="button" data-role="github-install-btn" class="agy-btn agy-btn-primary has-icon">${ns.iconSvg('download', 13)}<span>Install</span></button>
            </div>
            <div data-role="gh-consent-bar" class="consent-bar hidden">
              <span data-role="gh-consent-text"></span>
              <div class="consent-actions">
                <button type="button" data-role="gh-consent-cancel" class="agy-btn agy-btn-outline">Cancel</button>
                <button type="button" data-role="gh-consent-confirm" class="agy-btn agy-btn-primary">Confirm Install</button>
              </div>
            </div>
          </div>
        </div>
      `;
      shell = paneEl.querySelector('[data-role="sideload-shell"]');

      shell.querySelectorAll('[data-scope]').forEach((btn) => {
        btn.addEventListener('click', () => {
          sideloadScope = btn.dataset.scope;
          syncSideloadState(paneEl);
        });
      });

      const localInput = shell.querySelector('[data-role="local-path-input"]');
      shell.querySelector('[data-role="validate-btn"]').addEventListener('click', async () => {
        const folderPath = localInput.value.trim();
        if (!folderPath) return;
        try {
          const res = await paneEl._ctx?.onInspectLocal?.(folderPath);
          const tier = ns.formatCapabilityTier(res.capabilityTier);
          sideloadFeedback = {
            tone: 'ok',
            text: `Verified "${res.displayName}" (${res.id}@${res.version}) • ${tier.label}${res.hasLifecycleScripts ? ' • ⚠️ Has lifecycle scripts' : ''}`,
          };
        } catch (err) {
          sideloadFeedback = { tone: 'err', text: err.message };
        }
        syncSideloadState(paneEl);
      });

      shell.querySelector('[data-role="link-btn"]').addEventListener('click', async () => {
        const folderPath = localInput.value.trim();
        if (!folderPath) return;
        const curCtx = paneEl._ctx || {};
        const wsPath = curCtx.activeWorkspace?.workspacePath || '';
        try {
          const res = await curCtx.onLinkLocal?.({
            folderPath,
            scope: sideloadScope,
            workspaces: sideloadScope === 'global' ? ['*'] : wsPath ? [wsPath] : ['*'],
          });
          localInput.value = '';
          sideloadFeedback = { tone: 'ok', text: `Linked ${res.sidecarId} and enabled via Language Server.` };
          curCtx.onSwitchTab?.('installed');
        } catch (err) {
          sideloadFeedback = { tone: 'err', text: err.message };
          syncSideloadState(paneEl);
        }
      });

      const ghInput = shell.querySelector('[data-role="github-repo-input"]');
      const ghConsentBar = shell.querySelector('[data-role="gh-consent-bar"]');
      const ghConsentText = shell.querySelector('[data-role="gh-consent-text"]');
      // Set when Hangar's scan found Tier 2/3 code; confirming accepts that tier for the retry
      let ghPendingTier = '';
      shell.querySelector('[data-role="github-install-btn"]').addEventListener('click', () => {
        if (!ghInput.value.trim()) return;
        ghPendingTier = '';
        ghConsentText.innerHTML =
          '<strong>Unverified GitHub Repo:</strong> Sidecar will run as a local Node.js process. Proceed?';
        ghConsentBar.classList.remove('hidden');
      });
      shell.querySelector('[data-role="gh-consent-cancel"]').addEventListener('click', () => {
        ghPendingTier = '';
        ghConsentBar.classList.add('hidden');
      });
      shell.querySelector('[data-role="gh-consent-confirm"]').addEventListener('click', async () => {
        const gitRepo = ghInput.value.trim();
        if (!gitRepo) return;
        ghConsentBar.classList.add('hidden');
        const curCtx = paneEl._ctx || {};
        const wsPath = curCtx.activeWorkspace?.workspacePath || '';
        try {
          const res = await curCtx.onInstallRemote?.({
            gitRepo,
            scope: sideloadScope,
            workspaces: sideloadScope === 'global' ? ['*'] : wsPath ? [wsPath] : ['*'],
            acceptedTier: ghPendingTier || 'TIER_1_TELEMETRY',
          });
          if (res?.needsConsent) {
            ghPendingTier = res.scannedTier;
            ghConsentText.innerHTML = ns.scannedTierConsentHtml(res.scannedTier);
            ghConsentBar.classList.remove('hidden');
            return;
          }
          ghPendingTier = '';
          ghInput.value = '';
          sideloadFeedback = { tone: 'ok', text: `Installed ${res.sidecarId} from GitHub.` };
          curCtx.onSwitchTab?.('installed');
        } catch (err) {
          sideloadFeedback = { tone: 'err', text: err.message };
          syncSideloadState(paneEl);
        }
      });
    }

    syncSideloadState(paneEl);
  };
})();
