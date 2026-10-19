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

  ns.renderDiscoverPane = function renderDiscoverPane(
    paneEl,
    { sidecars, registryPackages, activeWorkspace, onInstallRemote, onSwitchTab }
  ) {
    const installedIds = new Set((sidecars || []).map((s) => s.sidecarId));
    const categories = ['all', 'telemetry', 'devops', 'productivity'];
    const filtered = (registryPackages || []).filter((pkg) => {
      const matchesCat = activeCategory === 'all' || (pkg.categories || []).includes(activeCategory);
      const q = searchQuery.toLowerCase().trim();
      const matchesQuery =
        !q ||
        pkg.name.toLowerCase().includes(q) ||
        pkg.id.toLowerCase().includes(q) ||
        (pkg.tagline || '').toLowerCase().includes(q);
      return matchesCat && matchesQuery;
    });

    paneEl.innerHTML = `
      <div class="discover-toolbar">
        <div class="search-box">
          ${ns.iconSvg('search', 14)}
          <input type="search" data-role="discover-search" class="search-input" placeholder="Search marketplace sidecars…" value="${ns.escHtml(searchQuery)}" />
        </div>
        <div class="agy-toggle-group">
          ${categories.map((c) => `<button type="button" data-cat="${c}" class="agy-toggle-item${activeCategory === c ? ' active' : ''}">${c.charAt(0).toUpperCase() + c.slice(1)}</button>`).join('')}
        </div>
      </div>
      <div data-role="discover-list"></div>
    `;

    const searchInput = paneEl.querySelector('[data-role="discover-search"]');
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value;
      ns.renderDiscoverPane(paneEl, { sidecars, registryPackages, activeWorkspace, onInstallRemote, onSwitchTab });
      const nextInput = paneEl.querySelector('[data-role="discover-search"]');
      nextInput?.focus();
      nextInput?.setSelectionRange(searchQuery.length, searchQuery.length);
    });

    paneEl.querySelectorAll('[data-cat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeCategory = btn.dataset.cat;
        ns.renderDiscoverPane(paneEl, { sidecars, registryPackages, activeWorkspace, onInstallRemote, onSwitchTab });
      });
    });

    const listEl = paneEl.querySelector('[data-role="discover-list"]');
    for (const pkg of filtered) {
      const isInstalled = installedIds.has(pkg.id) || pkg.isInstalled;
      const tier = ns.formatCapabilityTier(pkg.capabilityTier);
      const requiresConsent = pkg.capabilityTier && pkg.capabilityTier !== 'TIER_1_TELEMETRY';
      const card = document.createElement('div');
      card.className = 'manager-card';
      card.innerHTML = `
        <div class="manager-card-header">
          <div class="manager-card-title-group">
            <div class="manager-card-title-row">
              <span class="manager-card-title">${ns.escHtml(pkg.name)}</span>
              <span class="badge ${tier.state}" title="Capability Tier">${ns.iconSvg('shield', 11)}<span>${ns.escHtml(tier.label)}</span></span>
            </div>
            <div class="manager-card-meta">
              ${pkg.author?.verified ? ns.iconSvg('verified', 12) : ''}
              <span>${ns.escHtml(pkg.author?.name || 'Community')} • v${ns.escHtml(pkg.latestVersion || '1.0.0')} • ${ns.escHtml((pkg.categories || []).join(', '))}</span>
            </div>
          </div>
          <div class="manager-card-actions">
            <button type="button" data-role="pkg-install-btn" class="agy-btn ${isInstalled ? 'agy-btn-outline' : 'agy-btn-primary'} has-icon" ${isInstalled ? 'disabled' : ''}>
              ${ns.iconSvg(isInstalled ? 'check' : 'download', 13)}
              <span>${isInstalled ? 'Installed' : 'Install'}</span>
            </button>
          </div>
        </div>
        <div class="manager-card-desc">${ns.escHtml(pkg.tagline || '')}</div>
        <div data-role="consent-bar" class="consent-bar hidden">
          <span><strong>${ns.escHtml(tier.label)}:</strong> Grants local CLI or agent cascade access. Proceed?</span>
          <div class="consent-actions">
            <button type="button" data-role="consent-cancel" class="agy-btn agy-btn-outline">Cancel</button>
            <button type="button" data-role="consent-confirm" class="agy-btn agy-btn-primary">Confirm Install</button>
          </div>
        </div>
      `;
      const btn = card.querySelector('[data-role="pkg-install-btn"]');
      const consentBar = card.querySelector('[data-role="consent-bar"]');
      const runInstall = async () => {
        btn.disabled = true;
        btn.innerHTML = `<span>Installing…</span>`;
        consentBar.classList.add('hidden');
        try {
          const wsPath = activeWorkspace?.workspacePath;
          const isGlobalPkg = (pkg.workspaceTriggers?.files || []).includes('*');
          await onInstallRemote?.({
            sidecarId: pkg.id,
            gitRepo: pkg.release?.gitRepo || '',
            tarballUrl: pkg.release?.tarballUrl || '',
            version: pkg.latestVersion || '1.0.0',
            scope: isGlobalPkg ? 'global' : 'project',
            workspaces: isGlobalPkg ? ['*'] : wsPath ? [wsPath] : ['*'],
          });
          onSwitchTab?.('installed');
        } catch (err) {
          btn.disabled = false;
          btn.innerHTML = `${ns.iconSvg('download', 13)}<span>Retry Install</span>`;
          btn.title = err.message || 'Install failed';
        }
      };

      if (!isInstalled) {
        btn.addEventListener('click', () => {
          if (requiresConsent) {
            consentBar.classList.remove('hidden');
          } else {
            runInstall();
          }
        });
        card.querySelector('[data-role="consent-cancel"]').addEventListener('click', () => {
          consentBar.classList.add('hidden');
        });
        card.querySelector('[data-role="consent-confirm"]').addEventListener('click', runInstall);
      }
      listEl.appendChild(card);
    }
  };

  ns.renderSideloadPane = function renderSideloadPane(
    paneEl,
    { activeWorkspace, onLinkLocal, onInstallRemote, onInspectLocal, onSwitchTab, rerender }
  ) {
    const wsName = activeWorkspace?.workspaceName || 'Current Workspace';
    const wsPath = activeWorkspace?.workspacePath || '';
    paneEl.innerHTML = `
      ${sideloadFeedback ? `<div class="sideload-banner ${ns.escHtml(sideloadFeedback.tone)}">${ns.escHtml(sideloadFeedback.text)}</div>` : ''}
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
            <button type="button" data-scope="project" class="agy-toggle-item${sideloadScope === 'project' ? ' active' : ''}">${ns.iconSvg('folder', 13)}<span>${ns.escHtml(wsName)}</span></button>
            <button type="button" data-scope="global" class="agy-toggle-item${sideloadScope === 'global' ? ' active' : ''}">${ns.iconSvg('keep', 13)}<span>Global (*)</span></button>
          </div>
        </div>
        <div class="ws-add-row">
          <input type="text" data-role="local-path-input" class="ws-input" placeholder="Local directory path (e.g. D:/Docker/services/agy-sidecar)…" />
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
          <span><strong>Unverified GitHub Repo:</strong> Sidecar will run as a local Node.js process. Proceed?</span>
          <div class="consent-actions">
            <button type="button" data-role="gh-consent-cancel" class="agy-btn agy-btn-outline">Cancel</button>
            <button type="button" data-role="gh-consent-confirm" class="agy-btn agy-btn-primary">Confirm Install</button>
          </div>
        </div>
      </div>
    `;

    paneEl.querySelectorAll('[data-scope]').forEach((btn) => {
      btn.addEventListener('click', () => {
        sideloadScope = btn.dataset.scope;
        rerender();
      });
    });

    const localInput = paneEl.querySelector('[data-role="local-path-input"]');
    paneEl.querySelector('[data-role="validate-btn"]').addEventListener('click', async () => {
      const folderPath = localInput.value.trim();
      if (!folderPath) return;
      try {
        const res = await onInspectLocal?.(folderPath);
        const tier = ns.formatCapabilityTier(res.capabilityTier);
        sideloadFeedback = {
          tone: 'ok',
          text: `Verified "${res.displayName}" (${res.id}@${res.version}) • ${tier.label}${res.hasLifecycleScripts ? ' • ⚠️ Has lifecycle scripts' : ''}`,
        };
      } catch (err) {
        sideloadFeedback = { tone: 'err', text: err.message };
      }
      rerender();
    });

    paneEl.querySelector('[data-role="link-btn"]').addEventListener('click', async () => {
      const folderPath = localInput.value.trim();
      if (!folderPath) return;
      try {
        const res = await onLinkLocal?.({
          folderPath,
          scope: sideloadScope,
          workspaces: sideloadScope === 'global' ? ['*'] : wsPath ? [wsPath] : ['*'],
        });
        sideloadFeedback = { tone: 'ok', text: `Linked ${res.sidecarId} and enabled via Language Server.` };
        onSwitchTab?.('installed');
      } catch (err) {
        sideloadFeedback = { tone: 'err', text: err.message };
        rerender();
      }
    });

    const ghInput = paneEl.querySelector('[data-role="github-repo-input"]');
    const ghConsentBar = paneEl.querySelector('[data-role="gh-consent-bar"]');
    paneEl.querySelector('[data-role="github-install-btn"]').addEventListener('click', () => {
      if (!ghInput.value.trim()) return;
      ghConsentBar.classList.remove('hidden');
    });
    paneEl.querySelector('[data-role="gh-consent-cancel"]').addEventListener('click', () => {
      ghConsentBar.classList.add('hidden');
    });
    paneEl.querySelector('[data-role="gh-consent-confirm"]').addEventListener('click', async () => {
      const gitRepo = ghInput.value.trim();
      if (!gitRepo) return;
      ghConsentBar.classList.add('hidden');
      try {
        const res = await onInstallRemote?.({
          gitRepo,
          scope: sideloadScope,
          workspaces: sideloadScope === 'global' ? ['*'] : wsPath ? [wsPath] : ['*'],
        });
        sideloadFeedback = { tone: 'ok', text: `Installed ${res.sidecarId} from GitHub.` };
        onSwitchTab?.('installed');
      } catch (err) {
        sideloadFeedback = { tone: 'err', text: err.message };
        rerender();
      }
    });
  };
})();
