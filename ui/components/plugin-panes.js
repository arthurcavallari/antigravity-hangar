/** @fileoverview Plugin badges, port report consent flow, and Installed plugins list. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  const SOURCE_LABELS = {
    claude: 'Claude Code',
    gemini: 'Gemini CLI',
    cursor: 'Cursor',
    roo: 'Roo Code',
    codex: 'Codex',
  };

  ns.pluginBadgesHtml = function pluginBadgesHtml({ port, portedFrom } = {}) {
    const sources = portedFrom?.length ? portedFrom : (port?.from && port.from !== 'auto' ? [port.from] : []);
    const label = sources.map((s) => SOURCE_LABELS[s] || s).join(' + ') || 'another tool';
    const ported = port || sources.length
      ? `<span class="agy-badge stopped">Ported from ${ns.escHtml(label)}</span>`
      : '';
    return ns.rawHtml(`<span class="agy-badge starting">Plugin</span>${ported}`);
  };

  function reportList(title, items) {
    if (!items.length) return '';
    return `<div class="port-report-title">${ns.escHtml(title)} (${items.length})</div><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
  }

  ns.pluginConsentHtml = function pluginConsentHtml(res = {}) {
    const esc = ns.escHtml;
    const report = res.report || {};
    const tier = ns.formatCapabilityTier(res.scannedTier || report.tier);
    const native = (report.ecosystems || []).includes('antigravity');
    const flags = (report.flags || []).map(
      (f) => `<strong>${esc(f.severity)}</strong> ${esc(f.kind)}${f.file ? ` in <code>${esc(f.file)}${f.line ? `:${esc(f.line)}` : ''}</code>` : ''}`,
    );
    const unported = (report.unported || []).map((u) => `<code>${esc(u.item)}</code>: ${esc(u.reason)}`);
    const ported = (report.ported || []).map(esc);
    const summary = native
      ? `${flags.length} audit finding${flags.length === 1 ? '' : 's'}`
      : `${ported.length} ported • ${unported.length} not ported • ${flags.length} audit finding${flags.length === 1 ? '' : 's'}`;
    const why = (report.tierReasons || []).join('; ') || 'what Hangar found in the plugin it will install';
    return ns.rawHtml(`
      <div><strong>${esc(tier.label)}:</strong> ${esc(why)}. Install anyway?</div>
      <details class="port-report"${flags.length || unported.length ? ' open' : ''}>
        <summary>${native ? 'Scan' : 'Port report'}: ${esc(summary)}</summary>
        ${reportList('Audit findings', flags)}${reportList('Not ported', unported)}${reportList('Ported', ported)}${reportList('Warnings', (report.warnings || []).map(esc))}
      </details>
      <div class="port-report-note">Antigravity lists a new plugin as soon as it is installed. If it does not appear, restart Antigravity.</div>`);
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
    card._pluginConsent = { acceptedTier: res.scannedTier, acceptedFlags: res.flagsDigest || '' };
    ns.setHtml(els.consentText, ns.pluginConsentHtml(res));
    els.consentBar.classList.remove('hidden');
  }

  async function runPluginStep(card, els, busyLabel, idleLabel, step) {
    if (card._isInstalling) return;
    card._isInstalling = true;
    els.btn.disabled = true;
    els.btn.dataset.btnState = 'installing';
    ns.setHtml(els.btn, ns.html`<span>${busyLabel}</span>`);
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

  ns.previewPluginInstall = function previewPluginInstall(card, els, ctx, pkg, idleLabel = 'Install') {
    card._pluginConsent = null;
    return runPluginStep(card, els, 'Checking…', idleLabel, async () => {
      showConsent(card, els, await ctx.onPreviewPlugin?.(pluginPayload(pkg)));
    });
  };

  ns.confirmPluginInstall = function confirmPluginInstall(card, els, ctx, pkg, idleLabel = 'Install') {
    if (!card._pluginConsent) return Promise.resolve();
    return runPluginStep(card, els, idleLabel === 'Update' ? 'Updating…' : 'Installing…', idleLabel, async () => {
      const res = await ctx.onInstallPlugin?.(pluginPayload(pkg, card._pluginConsent));
      if (res?.needsConsent) {
        showConsent(card, els, res);
        return;
      }
      card._pluginConsent = null;
      ctx.onSwitchTab?.('installed');
    });
  };

  function countsText(counts) {
    if (!counts) return 'not loaded yet';
    return [
      ['skills', 'skill'],
      ['agents', 'agent'],
      ['rules', 'rule'],
      ['hooks', 'hook'],
      ['mcpServers', 'MCP server'],
    ]
      .filter(([key]) => counts[key] > 0)
      .map(([key, noun]) => `${counts[key]} ${noun}${counts[key] === 1 ? '' : 's'}`)
      .join(', ') || 'empty';
  }

  function createPluginCard(dir) {
    const card = Object.assign(document.createElement('div'), { className: 'agy-card' });
    card.dataset.pluginDir = dir;
    ns.setHtml(card, ns.html`
      <div class="agy-card-header">
        <div class="manager-card-title-group">
          <div class="manager-card-title-row">
            <span data-role="title" class="manager-card-title"></span>
            <span data-role="badges" class="badge-group"></span>
          </div>
          <div class="agy-card-meta">${ns.iconSvg('extension', 13)}<span data-role="meta"></span></div>
        </div>
        <div class="agy-card-actions">
          <button type="button" data-role="update-btn" class="agy-btn agy-btn-primary has-icon hidden"></button>
          <button type="button" data-role="uninstall-btn" class="agy-icon-btn hidden" title="Uninstall plugin" aria-label="Uninstall plugin">
            ${ns.iconSvg('delete', 14)}
          </button>
        </div>
      </div>
      <div data-role="restart-note" class="agy-banner hidden">Installed. Restart Antigravity to load it.</div>
      <div data-role="consent-bar" class="agy-consent-bar hidden">
        <span data-role="consent-text" class="consent-text"></span>
        <div class="consent-actions">
          <button type="button" data-role="consent-cancel" class="agy-btn agy-btn-outline">Cancel</button>
          <button type="button" data-role="consent-confirm" class="agy-btn agy-btn-primary">Confirm Update</button>
        </div>
      </div>
      <div data-role="uninstall-confirm" class="agy-consent-bar hidden">
        <span data-role="uninstall-confirm-text"></span>
        <div class="consent-actions">
          <button type="button" data-role="uninstall-cancel" class="agy-btn agy-btn-outline">Cancel</button>
          <button type="button" data-role="uninstall-confirm-btn" class="agy-btn agy-btn-danger">Uninstall</button>
        </div>
      </div>
      <div data-role="card-error" class="agy-banner is-error hidden" role="alert"></div>
    `);
    const q = (role) => card.querySelector(`[data-role="${role}"]`);
    const els = {
      btn: q('update-btn'),
      consentBar: q('consent-bar'),
      consentText: q('consent-text'),
      errorEl: q('card-error'),
      reset: (label) => {
        els.btn.disabled = false;
        els.btn.dataset.btnState = '';
        ns.setHtml(els.btn, ns.html`${ns.iconSvg('download', 13)}<span>${ns.escHtml(label)}</span>`);
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
    const uninstallCancelBtn = q('uninstall-cancel');
    uninstallBtn.addEventListener('click', () => {
      const p = card._plugin;
      q('uninstall-confirm-text').textContent = `Uninstall ${p.name}?`;
      uninstallConfirm.classList.remove('hidden');
      uninstallCancelBtn?.focus?.();
    });
    uninstallCancelBtn.addEventListener('click', () => {
      uninstallConfirm.classList.add('hidden');
      uninstallBtn?.focus?.();
    });
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
    card.dataset.pluginId = p.pluginId || p.dir || '';
    const diag = card._diag || p.diagnostics || null;
    const missingBins = (diag?.mcpServers || [])
      .filter((s) => s.transport === 'stdio' && s.commandExists === false)
      .map((s) => s.key);
    const missingVars = Array.from(new Set((diag?.mcpServers || []).flatMap((s) => s.missingEnvVars || [])));
    const managed = Boolean(p.pluginId);
    const tier = p.capabilityTier ? ns.formatCapabilityTier(p.capabilityTier) : null;
    const sig = JSON.stringify([
      p.name,
      p.portedFrom,
      p.disabled,
      p.builtin,
      p.restartRequired,
      p.capabilityTier,
      p.installedVersion,
      p.counts,
      missingBins,
      missingVars,
    ]);
    if (card.dataset.sig !== sig) {
      card.dataset.sig = sig;
      card.querySelector('[data-role="title"]').textContent = p.name;
      ns.setHtml(card.querySelector('[data-role="badges"]'), ns.rawHtml([
        ns.pluginBadgesHtml(p),
        tier ? `<span class="agy-badge ${ns.escHtml(tier.state)}">${ns.iconSvg('shield', 11)}<span>${ns.escHtml(tier.shortLabel)}</span></span>` : '',
        p.restartRequired ? '<span class="agy-badge hibernated">Restart to load</span>' : '',
        p.disabled ? '<span class="agy-badge stopped">Disabled</span>' : '',
        p.builtin ? '<span class="agy-badge stopped">Built-in</span>' : '',
        missingBins.length ? `<span class="agy-badge errored" title="Missing MCP command: ${ns.escHtml(missingBins.join(', '))}">Missing CLI</span>` : '',
        missingVars.length ? `<span class="agy-badge hibernated" title="Unset env vars: ${ns.escHtml(missingVars.join(', '))}">Needs Env (${missingVars.length})</span>` : '',
      ].join('')));
      const origin = managed
        ? (p.installedVersion ? `v${p.installedVersion}` : 'Hangar')
        : (p.builtin ? 'ships with Antigravity' : 'installed outside Hangar');
      card.querySelector('[data-role="meta"]').textContent = `${p.dir} • ${origin} • ${countsText(p.counts)}`;
      card.querySelector('[data-role="restart-note"]').classList.toggle('hidden', !p.restartRequired);
    }
    const uninstallBtn = card.querySelector('[data-role="uninstall-btn"]');
    uninstallBtn.classList.toggle('hidden', !managed);
    uninstallBtn.title = `Uninstall ${p.name}`;
    uninstallBtn.setAttribute?.('aria-label', `Uninstall ${p.name}`);
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
      ns.setHtml(sectionEl, ns.html`
        <div class="store-header plugin-section-header">
          <div>
            <div class="store-title">
              <span>Plugins</span>
              <span data-role="plugin-count" class="agy-count-pill"></span>
            </div>
            <div class="store-subtitle">Skills, agents, rules, hooks and MCP servers for the agent. Plugins have no panel, so they don't get a tab.</div>
          </div>
        </div>
        <div data-role="plugin-list"></div>
      `);
      listEl = sectionEl.querySelector('[data-role="plugin-list"]');
    }
    sectionEl.querySelector('[data-role="plugin-count"]').textContent = String(plugins.length);
    const regMap = new Map((ctx.registryPackages || []).map((p) => [p.id, p]));
    const diagMap = new Map((ctx.pluginDiagnostics || []).map((d) => [d.id, d]));
    const seen = new Set();
    plugins.forEach((plugin, i) => {
      seen.add(plugin.dir);
      const card = listEl.querySelector(`.agy-card[data-plugin-dir="${CSS.escape(plugin.dir)}"]`) || createPluginCard(plugin.dir);
      Object.assign(card, {
        _plugin: plugin,
        _ctx: ctx,
        _regPkg: plugin.pluginId ? regMap.get(plugin.pluginId) || null : null,
        _diag: diagMap.get(plugin.dir) || diagMap.get(plugin.pluginId) || null,
      });
      syncPluginCard(card);
      if (listEl.children[i] !== card) listEl.insertBefore(card, listEl.children[i] || null);
    });
    for (const child of Array.from(listEl.children)) {
      if (!seen.has(child.dataset.pluginDir)) child.remove();
    }
  };
})();
