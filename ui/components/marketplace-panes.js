/** @fileoverview Renders the Discover (Marketplace catalog) and Sideload (Local / GitHub) sub-panes. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  let searchQuery = '';
  let activeCategory = 'all';
  let sideloadScope = 'project';
  let sideloadFeedback = null;
  ns.clearSideloadFeedback = () => {
    sideloadFeedback = null;
  };
  ns.setDiscoverQuery = (query = '') => {
    searchQuery = String(query);
    activeCategory = 'all';
  };
  ns.scannedTierConsentHtml = (tierId, verb = 'Install') => ns.html`<strong>${ns.escHtml(ns.formatCapabilityTier(tierId).label)}:</strong> Hangar's scan of the downloaded code found it needs this access. ${verb} anyway?`;
  const declaredTierConsentHtml = (tierId) => ns.html`<strong>${ns.escHtml(ns.formatCapabilityTier(tierId).label)}:</strong> Grants local CLI or agent cascade access. Proceed?`;

  function createDiscoverCard(pkgId, paneEl) {
    const card = Object.assign(document.createElement('div'), { className: 'agy-card' });
    card.dataset.pkgId = pkgId;
    ns.setHtml(card, ns.html`
      <div class="agy-card-header">
        <div class="manager-card-title-group">
          <div class="manager-card-title-row">
            <span data-role="pkg-title" class="manager-card-title"></span>
            <span data-role="pkg-tier" class="agy-badge" title="Capability Tier"></span>
            <span data-role="pkg-kind" class="badge-group"></span>
          </div>
          <div data-role="pkg-meta" class="agy-card-meta"></div>
        </div>
        <div class="agy-card-actions">
          <a
            data-role="pkg-sponsor-link"
            href="https://github.com/sponsors/arthurcavallari"
            target="_blank"
            rel="noopener noreferrer"
            class="agy-icon-btn sponsor-link-btn hidden"
            title="Sponsor author"
            aria-label="Sponsor author"
          >
            ${ns.iconSvg('favorite', 16)}
          </a>
          <button type="button" data-role="pkg-install-btn" class="agy-btn has-icon"></button>
        </div>
      </div>
      <div data-role="pkg-desc" class="manager-card-desc"></div>
      <div data-role="consent-bar" class="agy-consent-bar hidden">
        <span data-role="consent-text" class="consent-text"></span>
        <div class="consent-actions">
          <button type="button" data-role="consent-cancel" class="agy-btn agy-btn-outline">Cancel</button>
          <button type="button" data-role="consent-confirm" class="agy-btn agy-btn-primary">Confirm Install</button>
        </div>
      </div>
      <div data-role="card-error" class="agy-banner is-error hidden" role="alert"></div>
    `);
    const q = (role) => card.querySelector(`[data-role="${role}"]`);
    const btn = q('pkg-install-btn');
    const consentBar = q('consent-bar');
    const consentText = q('consent-text');
    const errorEl = q('card-error');
    const setBtn = (disabled, state, tpl) => {
      btn.disabled = disabled;
      ns.setHtml(btn, tpl);
      btn.dataset.btnState = state;
    };
    const resetInstallBtn = (label) => setBtn(
      false,
      label === 'Install' ? 'install' : 'retry',
      ns.html`${ns.iconSvg('download', 16)}<span>${label}</span>`,
    );
    const pluginEls = { btn, consentBar, consentText, errorEl, reset: resetInstallBtn };
    const runInstall = async () => {
      if (card._isInstalling || card._isInstalled) return;
      card._isInstalling = true;
      setBtn(true, 'installing', ns.html`<span>Installing…</span>`);
      consentBar.classList.add('hidden');
      errorEl.classList.add('hidden');
      try {
        const curPkg = card._pkg;
        const ctx = paneEl._ctx || {};
        const wsPath = ctx.activeWorkspace?.workspacePath;
        const isGlobalPkg = (curPkg.workspaceTriggers?.files || []).includes('*');
        const res = await ctx.onInstallRemote?.({
          sidecarId: curPkg.id,
          gitRepo: curPkg.release?.gitRepo || '',
          tarballUrl: curPkg.release?.tarballUrl || '',
          sha256: curPkg.release?.sha256 || '',
          version: curPkg.latestVersion || '1.0.0',
          scope: isGlobalPkg ? 'global' : 'project',
          workspaces: isGlobalPkg ? ['*'] : (wsPath ? [wsPath] : ['*']),
          acceptedTier: card._acceptedTier || curPkg.capabilityTier || 'TIER_1_TELEMETRY',
        });
        card._isInstalling = false;
        if (res?.needsConsent) {
          card._pendingTier = res.scannedTier;
          ns.setHtml(consentText, ns.scannedTierConsentHtml(res.scannedTier));
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
      if (card._pkg.kind === 'plugin') {
        ns.previewPluginInstall?.(card, pluginEls, paneEl._ctx || {}, card._pkg);
        return;
      }
      Object.assign(card, { _pendingTier: '', _acceptedTier: '' });
      ns.setHtml(consentText, declaredTierConsentHtml(card._pkg.capabilityTier));
      if (card._requiresConsent) {
        consentBar.classList.remove('hidden');
      } else {
        runInstall();
      }
    });
    q('consent-cancel').addEventListener('click', () => {
      card._pendingTier = '';
      consentBar.classList.add('hidden');
    });
    q('consent-confirm').addEventListener('click', () => {
      if (card._pkg.kind === 'plugin') {
        ns.confirmPluginInstall?.(card, pluginEls, paneEl._ctx || {}, card._pkg);
        return;
      }
      card._acceptedTier = card._pendingTier || card._pkg.capabilityTier || 'TIER_1_TELEMETRY';
      runInstall();
    });
    return card;
  }

  function reconcileDiscoverList(paneEl) {
    const { sidecars = [], plugins = [], registryPackages = [] } = paneEl._ctx || {};
    const listEl = paneEl.querySelector('[data-role="discover-list"]');
    if (!listEl) return;
    const installedIds = new Set([...sidecars.map((s) => s.sidecarId), ...plugins.map((p) => p.pluginId).filter(Boolean)]);
    const q = searchQuery.toLowerCase().trim();
    const filtered = registryPackages.filter((pkg) => {
      const matchesCat = activeCategory === 'all' || (pkg.categories || []).includes(activeCategory);
      const matchesQuery = !q ||
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
      const card = listEl.querySelector(`.agy-card[data-pkg-id="${CSS.escape(pkg.id)}"]`) || createDiscoverCard(pkg.id, paneEl);
      Object.assign(card, { _pkg: pkg, _isInstalled: isInstalled, _requiresConsent: requiresConsent });
      const isPlugin = pkg.kind === 'plugin';
      const metaSig = JSON.stringify([
        pkg.name,
        pkg.kind || 'sidecar',
        pkg.port?.from || '',
        tier.state,
        tier.label,
        Boolean(pkg.author?.verified),
        pkg.author?.name || 'Community',
        pkg.latestVersion || '1.0.0',
        (pkg.categories || []).join(', '),
        pkg.tagline || '',
        pkg.funding || '',
        pkg.license || '',
        pkg.homepage || '',
      ]);
      if (card.dataset.metaSig !== metaSig) {
        card.dataset.metaSig = metaSig;
        card.querySelector('[data-role="pkg-title"]').textContent = pkg.name;
        const sponsorEl = card.querySelector('[data-role="pkg-sponsor-link"]');
        const fundingUrl = ns.sanitizeHttpsUrl ? ns.sanitizeHttpsUrl(pkg.funding) : '';
        if (sponsorEl) {
          sponsorEl.classList.toggle('hidden', !fundingUrl);
          if (fundingUrl) {
            sponsorEl.href = fundingUrl;
            const sponsorTitle = pkg.author?.name ? `Sponsor ${pkg.author.name}` : `Sponsor ${pkg.name}`;
            sponsorEl.title = sponsorTitle;
            sponsorEl.setAttribute('aria-label', sponsorTitle);
          }
        }
        const homepageUrl = ns.sanitizeHttpsUrl ? ns.sanitizeHttpsUrl(pkg.homepage) : '';
        const tierEl = card.querySelector('[data-role="pkg-tier"]');
        tierEl.className = `agy-badge ${tier.state}`;
        ns.setHtml(tierEl, ns.html`${ns.iconSvg('shield', 11)}<span>${ns.escHtml(tier.label)}</span>`);
        ns.setHtml(card.querySelector('[data-role="pkg-kind"]'), isPlugin ? ns.pluginBadgesHtml?.(pkg) || '' : '');
        ns.setHtml(
          card.querySelector('[data-role="pkg-meta"]'),
          ns.html`
            ${pkg.author?.verified ? ns.iconSvg('verified', 12) : ''}
            <span>${ns.escHtml(pkg.author?.name || 'Community')} • v${ns.escHtml(pkg.latestVersion || '1.0.0')} • ${ns.escHtml((pkg.categories || []).join(', '))}${pkg.license ? ns.html` • <span data-role="pkg-license" title="License">${pkg.license}</span>` : ''}</span>
            ${homepageUrl ? ns.html`<a data-role="pkg-homepage" href="${homepageUrl}" target="_blank" rel="noopener noreferrer" title="Open the source">Source</a>` : ''}
          `,
        );
        card.querySelector('[data-role="pkg-desc"]').textContent = pkg.tagline || '';
        if (!isPlugin) {
          ns.setHtml(
            card.querySelector('[data-role="consent-text"]'),
            card._pendingTier ? ns.scannedTierConsentHtml(card._pendingTier) : declaredTierConsentHtml(pkg.capabilityTier),
          );
        }
      }
      if (!card._isInstalling) {
        const btn = card.querySelector('[data-role="pkg-install-btn"]');
        const targetState = isInstalled ? 'installed' : (btn.dataset.btnState === 'retry' ? 'retry' : 'install');
        if (isInstalled) card.querySelector('[data-role="consent-bar"]')?.classList.add('hidden');
        if (btn.dataset.btnState !== targetState) {
          btn.dataset.btnState = targetState;
          Object.assign(btn, {
            className: `agy-btn ${isInstalled ? 'agy-btn-outline' : 'agy-btn-primary'} has-icon`,
            disabled: isInstalled,
          });
          ns.setHtml(
            btn,
            ns.html`${ns.iconSvg(isInstalled ? 'check' : 'download', 13)}<span>${isInstalled ? 'Installed' : 'Install'}</span>`,
          );
          if (isInstalled) btn.removeAttribute('title');
        }
      }
      if (listEl.children[i] !== card) listEl.insertBefore(card, listEl.children[i] || null);
    }
    for (const child of Array.from(listEl.querySelectorAll('.agy-card'))) {
      if (!seenIds.has(child.dataset.pkgId)) child.remove();
    }
    let emptyEl = listEl.querySelector('[data-role="discover-empty"]');
    if (filtered.length === 0) {
      if (!emptyEl) {
        emptyEl = document.createElement('div');
        emptyEl.className = 'agy-empty-state';
        emptyEl.setAttribute('role', 'status');
        emptyEl.dataset.role = 'discover-empty';
        listEl.appendChild(emptyEl);
      }
      const msg = q
        ? `No sidecars or plugins match "${searchQuery.trim()}"${activeCategory !== 'all' ? ` in ${activeCategory}` : ''}.`
        : `No sidecars or plugins in ${activeCategory === 'all' ? 'the registry' : activeCategory}.`;
      if (emptyEl.textContent !== msg) emptyEl.textContent = msg;
    } else if (emptyEl) {
      emptyEl.remove();
    }
  }

  ns.renderDiscoverPane = function renderDiscoverPane(paneEl, ctx = {}) {
    if (!paneEl) return;
    paneEl._ctx = ctx;
    let shell = paneEl.querySelector('[data-role="discover-shell"]');
    if (!shell) {
      const categories = ['all', 'telemetry', 'devops', 'productivity', 'security'];
      const catButtons = categories.map(
        (c) => ns.html`<button type="button" data-cat="${c}" class="agy-toggle-item">${c.charAt(0).toUpperCase() + c.slice(1)}</button>`,
      );
      ns.setHtml(paneEl, ns.html`
        <div data-role="discover-shell">
          <div class="discover-toolbar">
            <div class="agy-search-box">
              <span class="agy-search-icon">${ns.iconSvg('search', 16)}</span>
              <input type="search" data-role="discover-search" class="agy-search-input" aria-label="Search sidecars and plugins" placeholder="Search sidecars and plugins…" />
            </div>
            <agy-toggle-group class="agy-toggle-group" aria-label="Filter by category">${catButtons}</agy-toggle-group>
          </div>
          <div data-role="discover-list"></div>
        </div>
      `);
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
          shell.querySelectorAll('[data-cat]').forEach((b) => b.classList.toggle('active', b.dataset.cat === activeCategory));
          const catGroup = shell.querySelector('agy-toggle-group');
          if (catGroup) catGroup.value = activeCategory;
          reconcileDiscoverList(paneEl);
        });
      });
    }
    const searchInput = shell.querySelector('[data-role="discover-search"]');
    if (searchInput && document.activeElement !== searchInput && searchInput.value !== searchQuery) {
      searchInput.value = searchQuery;
    }
    shell.querySelectorAll('[data-cat]').forEach((btn) => btn.classList.toggle('active', btn.dataset.cat === activeCategory));
    const catGroup = shell.querySelector('agy-toggle-group');
    if (catGroup) catGroup.value = activeCategory;
    reconcileDiscoverList(paneEl);
  };

  function syncSideloadState(paneEl) {
    const shell = paneEl?.querySelector('[data-role="sideload-shell"]');
    if (!shell) return;
    const wsName = paneEl._ctx?.activeWorkspace?.workspaceName || 'Current Workspace';
    const bannerEl = shell.querySelector('[data-role="sideload-banner"]');
    if (bannerEl) {
      bannerEl.className = sideloadFeedback
        ? `agy-banner ${sideloadFeedback.tone === 'err' ? 'is-error' : 'is-success'}`
        : 'agy-banner hidden';
      bannerEl.textContent = sideloadFeedback ? sideloadFeedback.text : '';
    }
    const wsLabelEl = shell.querySelector('[data-role="ws-scope-label"]');
    if (wsLabelEl && wsLabelEl.textContent !== wsName) wsLabelEl.textContent = wsName;
    shell.querySelectorAll('[data-scope]').forEach((btn) => btn.classList.toggle('active', btn.dataset.scope === sideloadScope));
    const scopeGroup = shell.querySelector('agy-toggle-group');
    if (scopeGroup) scopeGroup.value = sideloadScope;
  }

  ns.renderSideloadPane = function renderSideloadPane(paneEl, ctx = {}) {
    if (!paneEl) return;
    paneEl._ctx = ctx;
    let shell = paneEl.querySelector('[data-role="sideload-shell"]');
    if (!shell) {
      ns.setHtml(paneEl, ns.html`
        <div data-role="sideload-shell">
          <div data-role="sideload-banner" class="agy-banner hidden" role="status" aria-live="polite"></div>
          <div class="agy-card">
            <div class="agy-card-header">
              <div class="manager-card-title-group">
                <div class="manager-card-title-row">
                  <span class="manager-card-title">Link Local Sidecar Folder</span>
                  <span class="agy-badge running">Development</span>
                </div>
                <div class="agy-card-meta">Creates a live NTFS junction / symlink to a local directory containing sidecar.json</div>
              </div>
              <agy-toggle-group class="agy-toggle-group" aria-label="Sideload workspace scope">
                <button type="button" data-scope="project" class="agy-toggle-item">
                  ${ns.iconSvg('folder', 16)}<span data-role="ws-scope-label"></span>
                </button>
                <button type="button" data-scope="global" class="agy-toggle-item">
                  ${ns.iconSvg('globe', 16)}<span>Global (*)</span>
                </button>
              </agy-toggle-group>
            </div>
            <div class="ws-add-row">
              <input type="text" data-role="local-path-input" class="ws-input" aria-label="Local sidecar directory path" placeholder="Local directory path (e.g. C:/path/to/my/agy-sidecar)…" />
              <button type="button" data-role="validate-btn" class="agy-btn agy-btn-outline has-icon">
                ${ns.iconSvg('shield', 16)}<span>Validate</span>
              </button>
              <button type="button" data-role="link-btn" class="agy-btn agy-btn-primary has-icon">
                ${ns.iconSvg('link', 16)}<span>Link Folder</span>
              </button>
            </div>
          </div>
          <div class="agy-card">
            <div class="agy-card-header">
              <div class="manager-card-title-group">
                <div class="manager-card-title-row">
                  <span class="manager-card-title">Install from GitHub Repository</span>
                  <span class="agy-badge starting">Git Clone</span>
                </div>
                <div class="agy-card-meta">Clones into ~/.gemini/hangar/packages/ with --ignore-scripts protection</div>
              </div>
            </div>
            <div class="ws-add-row">
              <input type="text" data-role="github-repo-input" class="ws-input" aria-label="GitHub repository URL or owner/repo" placeholder="https://github.com/owner/repo or owner/repo…" />
              <button type="button" data-role="github-install-btn" class="agy-btn agy-btn-primary has-icon">
                ${ns.iconSvg('download', 16)}<span>Install</span>
              </button>
            </div>
            <div data-role="gh-consent-bar" class="agy-consent-bar hidden">
              <span data-role="gh-consent-text"></span>
              <div class="consent-actions">
                <button type="button" data-role="gh-consent-cancel" class="agy-btn agy-btn-outline">Cancel</button>
                <button type="button" data-role="gh-consent-confirm" class="agy-btn agy-btn-primary">Confirm Install</button>
              </div>
            </div>
          </div>
        </div>
      `);
      shell = paneEl.querySelector('[data-role="sideload-shell"]');
      const q = (role) => shell.querySelector(`[data-role="${role}"]`);
      const validateBtn = q('validate-btn');
      const linkBtn = q('link-btn');
      const ghInstallBtn = q('github-install-btn');
      const ghConfirmBtn = q('gh-consent-confirm');
      const actionBtns = [validateBtn, linkBtn, ghInstallBtn, ghConfirmBtn];
      const runSideload = async (fn) => {
        if (shell._busy) return;
        shell._busy = true;
        actionBtns.forEach((b) => {
          if (b) b.disabled = true;
        });
        try {
          await fn(paneEl._ctx || {});
        } catch (err) {
          sideloadFeedback = { tone: 'err', text: err.message };
        } finally {
          shell._busy = false;
          actionBtns.forEach((b) => {
            if (b) b.disabled = false;
          });
        }
        syncSideloadState(paneEl);
      };
      shell.querySelectorAll('[data-scope]').forEach((btn) => {
        btn.addEventListener('click', () => {
          sideloadScope = btn.dataset.scope;
          syncSideloadState(paneEl);
        });
      });
      const localInput = q('local-path-input');
      validateBtn.addEventListener('click', () => {
        const folderPath = localInput.value.trim();
        if (!folderPath) return;
        runSideload(async (curCtx) => {
          const res = await curCtx.onInspectLocal?.(folderPath);
          const tier = ns.formatCapabilityTier(res.capabilityTier);
          sideloadFeedback = {
            tone: 'ok',
            text: `Verified "${res.displayName}" (${res.id}@${res.version}) • ${tier.label}${res.hasLifecycleScripts ? ' • ⚠️ Has lifecycle scripts' : ''}`,
          };
        });
      });
      const triggerLinkLocal = () => {
        const folderPath = localInput.value.trim();
        if (!folderPath) return;
        runSideload(async (curCtx) => {
          const wsPath = curCtx.activeWorkspace?.workspacePath || '';
          const res = await curCtx.onLinkLocal?.({
            folderPath,
            scope: sideloadScope,
            workspaces: sideloadScope === 'global' ? ['*'] : (wsPath ? [wsPath] : ['*']),
          });
          localInput.value = '';
          sideloadFeedback = { tone: 'ok', text: `Linked ${res.sidecarId} and enabled via Language Server.` };
          curCtx.onSwitchTab?.('installed');
        });
      };
      linkBtn.addEventListener('click', triggerLinkLocal);
      localInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        triggerLinkLocal();
      });
      const ghInput = q('github-repo-input');
      const ghConsentBar = q('gh-consent-bar');
      const ghConsentText = q('gh-consent-text');
      let ghPendingTier = '';
      const triggerGhPrompt = () => {
        if (!ghInput.value.trim() || shell._busy) return;
        ghPendingTier = '';
        ns.setHtml(ghConsentText, ns.html`<strong>Unverified GitHub Repo:</strong> Sidecar will run as a local Node.js process. Proceed?`);
        ghConsentBar.classList.remove('hidden');
      };
      ghInstallBtn.addEventListener('click', triggerGhPrompt);
      ghInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        triggerGhPrompt();
      });
      q('gh-consent-cancel').addEventListener('click', () => {
        ghPendingTier = '';
        ghConsentBar.classList.add('hidden');
      });
      q('gh-consent-confirm').addEventListener('click', () => {
        const gitRepo = ghInput.value.trim();
        if (!gitRepo) return;
        ghConsentBar.classList.add('hidden');
        runSideload(async (curCtx) => {
          const wsPath = curCtx.activeWorkspace?.workspacePath || '';
          const res = await curCtx.onInstallRemote?.({
            gitRepo,
            scope: sideloadScope,
            workspaces: sideloadScope === 'global' ? ['*'] : (wsPath ? [wsPath] : ['*']),
            acceptedTier: ghPendingTier || 'TIER_1_TELEMETRY',
          });
          if (res?.needsConsent) {
            ghPendingTier = res.scannedTier;
            ns.setHtml(ghConsentText, ns.scannedTierConsentHtml(res.scannedTier));
            ghConsentBar.classList.remove('hidden');
            return;
          }
          ghPendingTier = '';
          ghInput.value = '';
          sideloadFeedback = { tone: 'ok', text: `Installed ${res.sidecarId} from GitHub.` };
          curCtx.onSwitchTab?.('installed');
        });
      });
    }
    syncSideloadState(paneEl);
  };
})();
