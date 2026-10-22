/**
 * @fileoverview Plugin parts of Hangar's Extensions view: the Plugin and ported-from badges, the port
 * report shown before consent, the preview -> consent -> install flow, and the Installed plugins list.
 * Plugins have no web UI, so they never get a tab.
 */

(function () {
  const ns = (window.Hangar = window.Hangar || {});

  const SOURCE_LABELS = { claude: 'Claude Code', gemini: 'Gemini CLI', cursor: 'Cursor', roo: 'Roo Code', codex: 'Codex' };

  // "Plugin", plus where a port came from. Takes a registry package ({ port }) or an installed plugin ({ portedFrom }).
  ns.pluginBadgesHtml = function pluginBadgesHtml({ port, portedFrom } = {}) {
    const sources = portedFrom?.length ? portedFrom : port?.from && port.from !== 'auto' ? [port.from] : [];
    const label = sources.map((s) => SOURCE_LABELS[s] || s).join(' + ') || 'another tool';
    const ported = port || sources.length ? `<span class="badge stopped">Ported from ${ns.escHtml(label)}</span>` : '';
    return `<span class="badge starting">Plugin</span>${ported}`;
  };

  function reportList(title, items) {
    if (!items.length) return '';
    return `<div class="port-report-title">${ns.escHtml(title)} (${items.length})</div><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
  }

  // The consent text for a plugin: its scanned tier, what will and won't port, audit findings, and the restart
  ns.pluginConsentHtml = function pluginConsentHtml(res = {}) {
    const esc = ns.escHtml;
    const report = res.report || {};
    const tier = ns.formatCapabilityTier(res.scannedTier || report.tier);
    const native = (report.ecosystems || []).includes('antigravity');
    const flags = (report.flags || []).map((f) =>
      `<strong>${esc(f.severity)}</strong> ${esc(f.kind)}${f.file ? ` in <code>${esc(f.file)}${f.line ? `:${f.line}` : ''}</code>` : ''}`);
    const unported = (report.unported || []).map((u) => `<code>${esc(u.item)}</code>: ${esc(u.reason)}`);
    const ported = (report.ported || []).map(esc);
    const summary = native
      ? `${flags.length} audit finding${flags.length === 1 ? '' : 's'}`
      : `${ported.length} ported • ${unported.length} not ported • ${flags.length} audit finding${flags.length === 1 ? '' : 's'}`;
    const why = (report.tierReasons || []).join('; ') || 'what Hangar found in the plugin it will install';
    return `
      <div><strong>${esc(tier.label)}:</strong> ${esc(why)}. Install anyway?</div>
      <details class="port-report"${flags.length || unported.length ? ' open' : ''}>
        <summary>${native ? 'Scan' : 'Port report'}: ${esc(summary)}</summary>
        ${reportList('Audit findings', flags)}
        ${reportList('Not ported', unported)}
        ${reportList('Ported', ported)}
        ${reportList('Warnings', (report.warnings || []).map(esc))}
      </details>
      <div class="port-report-note">Antigravity loads new plugins when it starts, so restart it after installing.</div>`;
  };

  function pluginPayload(pkg, consent = {}) {
    const release = pkg.release || {};
    return {
      pluginId: pkg.id,
      gitRepo: release.gitRepo || '',
      tarballUrl: release.tarballUrl || '',
      sha256: release.sha256 || '',
      ref: release.ref || '',
      path: release.path || '',
      port: pkg.port || null,
      version: pkg.latestVersion || '',
      ...consent,
    };
  }

  function showConsent(card, els, res) {
    // Installing with exactly what the user saw: a different scan comes back as needsConsent again
    card._pluginConsent = { acceptedTier: res.scannedTier, acceptedFlags: res.flagsDigest || '' };
    els.consentText.innerHTML = ns.pluginConsentHtml(res);
    els.consentBar.classList.remove('hidden');
  }

  // els: { btn, consentBar, consentText, errorEl, reset(label) } of a Discover or Installed card
  async function runPluginStep(card, els, busyLabel, idleLabel, step) {
    if (card._isInstalling) return;
    card._isInstalling = true;
    els.btn.disabled = true;
    els.btn.dataset.btnState = 'installing';
    els.btn.innerHTML = `<span>${busyLabel}</span>`;
    els.consentBar.classList.add('hidden');
    els.errorEl.classList.add('hidden');
    let failed = false;
    try {
      await step();
    } catch (err) {
      failed = true;
      els.errorEl.textContent = err?.message || `${idleLabel} failed`;
      els.errorEl.classList.remove('hidden');
    } finally {
      card._isInstalling = false;
      els.reset(failed ? `Retry ${idleLabel}` : idleLabel);
    }
  }

  // Step 1: a dry-run port, whose report fills the consent bar
  ns.previewPluginInstall = function previewPluginInstall(card, els, ctx, pkg, idleLabel = 'Install') {
    card._pluginConsent = null;
    return runPluginStep(card, els, 'Checking…', idleLabel, async () => {
      showConsent(card, els, await ctx.onPreviewPlugin?.(pluginPayload(pkg)));
    });
  };

  // Step 2, on Confirm: the real install
  ns.confirmPluginInstall = function confirmPluginInstall(card, els, ctx, pkg, idleLabel = 'Install') {
    if (!card._pluginConsent) return Promise.resolve();
    return runPluginStep(card, els, idleLabel === 'Update' ? 'Updating…' : 'Installing…', idleLabel, async () => {
      const res = await ctx.onInstallPlugin?.(pluginPayload(pkg, card._pluginConsent));
      if (res?.needsConsent) return showConsent(card, els, res);
      card._pluginConsent = null;
      ctx.onSwitchTab?.('installed');
    });
  };

  function countsText(counts) {
    if (!counts) return 'not loaded yet';
    const parts = [['skills', 'skill'], ['agents', 'agent'], ['rules', 'rule'], ['hooks', 'hook'], ['mcpServers', 'MCP server']]
      .filter(([key]) => counts[key] > 0)
      .map(([key, noun]) => `${counts[key]} ${noun}${counts[key] === 1 ? '' : 's'}`);
    return parts.join(', ') || 'empty';
  }

  function createPluginCard(dir) {
    const card = document.createElement('div');
    card.className = 'manager-card';
    card.dataset.pluginDir = dir;
    card.innerHTML = `
      <div class="manager-card-header">
        <div class="manager-card-title-group">
          <div class="manager-card-title-row">
            <span data-role="title" class="manager-card-title"></span>
            <span data-role="badges" class="badge-group"></span>
          </div>
          <div class="manager-card-meta">${ns.iconSvg('extension', 13)}<span data-role="meta"></span></div>
        </div>
        <div class="manager-card-actions">
          <button type="button" data-role="update-btn" class="agy-btn agy-btn-primary has-icon hidden"></button>
          <button type="button" data-role="uninstall-btn" class="icon-btn hidden" title="Uninstall plugin" aria-label="Uninstall plugin">
            ${ns.iconSvg('delete', 14)}
          </button>
        </div>
      </div>
      <div data-role="restart-note" class="sideload-banner hidden">Installed. Restart Antigravity to load it.</div>
      <div data-role="consent-bar" class="consent-bar hidden">
        <span data-role="consent-text" class="consent-text"></span>
        <div class="consent-actions">
          <button type="button" data-role="consent-cancel" class="agy-btn agy-btn-outline">Cancel</button>
          <button type="button" data-role="consent-confirm" class="agy-btn agy-btn-primary">Confirm Update</button>
        </div>
      </div>
      <div data-role="uninstall-confirm" class="consent-bar hidden">
        <span data-role="uninstall-confirm-text"></span>
        <div class="consent-actions">
          <button type="button" data-role="uninstall-cancel" class="agy-btn agy-btn-outline">Cancel</button>
          <button type="button" data-role="uninstall-confirm-btn" class="agy-btn agy-btn-primary">Uninstall</button>
        </div>
      </div>
      <div data-role="card-error" class="sideload-banner err hidden" role="alert"></div>
    `;

    const q = (role) => card.querySelector(`[data-role="${role}"]`);
    const els = {
      btn: q('update-btn'),
      consentBar: q('consent-bar'),
      consentText: q('consent-text'),
      errorEl: q('card-error'),
      reset: (label) => {
        els.btn.disabled = false;
        els.btn.dataset.btnState = '';
        els.btn.innerHTML = `${ns.iconSvg('download', 13)}<span>${ns.escHtml(label)}</span>`;
      },
    };
    els.reset('Update');
    els.btn.addEventListener('click', () => {
      if (card._regPkg) ns.previewPluginInstall(card, els, card._ctx, card._regPkg, 'Update');
    });
    q('consent-cancel').addEventListener('click', () => {
      card._pluginConsent = null;
      els.consentBar.classList.add('hidden');
    });
    q('consent-confirm').addEventListener('click', () => {
      if (card._regPkg) ns.confirmPluginInstall(card, els, card._ctx, card._regPkg, 'Update');
    });

    const uninstallBtn = q('uninstall-btn');
    const uninstallConfirm = q('uninstall-confirm');
    uninstallBtn.addEventListener('click', () => {
      const p = card._plugin;
      q('uninstall-confirm-text').textContent =
        `Uninstall ${p.name}?${p.disabled ? ' Hangar turns it back on first, so a later reinstall is not left disabled.' : ''}`;
      uninstallConfirm.classList.remove('hidden');
    });
    q('uninstall-cancel').addEventListener('click', () => uninstallConfirm.classList.add('hidden'));
    q('uninstall-confirm-btn').addEventListener('click', async () => {
      uninstallConfirm.classList.add('hidden');
      els.errorEl.classList.add('hidden');
      uninstallBtn.disabled = true;
      try {
        await card._ctx.onUninstallPlugin?.(card._plugin.pluginId);
      } catch (err) {
        els.errorEl.textContent = err?.message || 'Uninstall failed';
        els.errorEl.classList.remove('hidden');
      } finally {
        uninstallBtn.disabled = false;
      }
    });
    return card;
  }

  function syncPluginCard(card) {
    const p = card._plugin;
    const managed = Boolean(p.pluginId);
    const tier = p.capabilityTier ? ns.formatCapabilityTier(p.capabilityTier) : null;
    const sig = JSON.stringify([p.name, p.portedFrom, p.disabled, p.builtin, p.restartRequired, p.capabilityTier, p.installedVersion, p.counts]);
    if (card.dataset.sig !== sig) {
      card.dataset.sig = sig;
      card.querySelector('[data-role="title"]').textContent = p.name;
      card.querySelector('[data-role="badges"]').innerHTML = [
        ns.pluginBadgesHtml(p),
        tier ? `<span class="badge ${tier.state}">${ns.iconSvg('shield', 11)}<span>${ns.escHtml(tier.shortLabel)}</span></span>` : '',
        p.restartRequired ? '<span class="badge hibernated">Restart to load</span>' : '',
        p.disabled ? '<span class="badge stopped">Disabled</span>' : '',
        p.builtin ? '<span class="badge stopped">Built-in</span>' : '',
      ].join('');
      const origin = managed ? (p.installedVersion ? `v${p.installedVersion}` : 'Hangar') : p.builtin ? 'ships with Antigravity' : 'installed outside Hangar';
      card.querySelector('[data-role="meta"]').textContent = `${p.dir} • ${origin} • ${countsText(p.counts)}`;
      card.querySelector('[data-role="restart-note"]').classList.toggle('hidden', !p.restartRequired);
    }
    card.querySelector('[data-role="uninstall-btn"]').classList.toggle('hidden', !managed);
    const canUpdate = managed && Boolean(card._regPkg?.updateAvailable);
    const updateBtn = card.querySelector('[data-role="update-btn"]');
    updateBtn.classList.toggle('hidden', !canUpdate && !card._isInstalling);
    if (canUpdate) updateBtn.title = `Update ${p.name} to v${card._regPkg.latestVersion}`;
  }

  ns.renderInstalledPlugins = function renderInstalledPlugins(sectionEl, ctx = {}) {
    if (!sectionEl) return;
    const plugins = ctx.plugins || [];
    sectionEl.classList.toggle('hidden', plugins.length === 0);
    let listEl = sectionEl.querySelector('[data-role="plugin-list"]');
    if (!listEl) {
      sectionEl.innerHTML = `
        <div class="store-header plugin-section-header">
          <div>
            <div class="store-title"><span>Plugins</span><span data-role="plugin-count" class="count-pill"></span></div>
            <div class="store-subtitle">Skills, agents, rules, hooks and MCP servers for the agent. Plugins have no panel, so they don't get a tab.</div>
          </div>
        </div>
        <div data-role="plugin-list"></div>
      `;
      listEl = sectionEl.querySelector('[data-role="plugin-list"]');
    }
    sectionEl.querySelector('[data-role="plugin-count"]').textContent = String(plugins.length);

    const regMap = new Map((ctx.registryPackages || []).map((p) => [p.id, p]));
    const seen = new Set();
    plugins.forEach((plugin, i) => {
      seen.add(plugin.dir);
      const card = listEl.querySelector(`.manager-card[data-plugin-dir="${CSS.escape(plugin.dir)}"]`) || createPluginCard(plugin.dir);
      card._plugin = plugin;
      card._ctx = ctx;
      card._regPkg = plugin.pluginId ? regMap.get(plugin.pluginId) || null : null;
      syncPluginCard(card);
      if (listEl.children[i] !== card) listEl.insertBefore(card, listEl.children[i] || null);
    });
    for (const child of Array.from(listEl.children)) {
      if (!seen.has(child.dataset.pluginDir)) child.remove();
    }
  };
})();
