/**
 * @fileoverview Renders the [+] Quick Project Pin Popover using Antigravity 2.0's
 * Popover (j_) container, ToggleGroup (HGb), and SidecarStatus (Zqb) pill badges.
 */

(function () {
  const ns = (window.Hangar = window.Hangar || {});

  ns.renderProjectPopover = function renderProjectPopover({
    popoverEl,
    activeWorkspace,
    sidecars,
    suggestions = [],
    onToggleWorkspaceRule,
    onToggleGlobalPin,
    onToggleAutoHibernate,
    onApplySuggestion,
  }) {
    if (!popoverEl) return;

    const wsPath = activeWorkspace?.workspacePath || '';
    const wsName = activeWorkspace?.workspaceName || 'Global';

    popoverEl.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'popover-header';
    header.innerHTML = `
      <span class="popover-header-ws">
        ${ns.iconSvg('folder', 14)}
        <span>${ns.escHtml(wsName)}</span>
      </span>
      <span class="popover-header-path" title="${ns.escHtml(wsPath || '*')}">${ns.escHtml(wsPath || '*')}</span>
    `;
    popoverEl.appendChild(header);

    for (const sc of sidecars || []) {
      const row = document.createElement('div');
      row.className = 'popover-row';

      const badgeInfo = ns.formatStatusBadge(sc.statusBadge, sc.isRunning, sc.isErrored);
      const top = document.createElement('div');
      top.className = 'popover-row-top';

      const titleSpan = document.createElement('span');
      titleSpan.textContent = sc.displayName;

      const badgeEl = document.createElement('span');
      badgeEl.className = `badge ${badgeInfo.state}`;
      badgeEl.innerHTML = `<span class="badge-dot"></span><span>${ns.escHtml(badgeInfo.label)}</span>`;

      top.append(titleSpan, badgeEl);

      const toggles = document.createElement('div');
      toggles.className = 'popover-toggles';

      const scopeGroup = document.createElement('div');
      scopeGroup.className = 'agy-toggle-group';

      const wsBtn = document.createElement('button');
      wsBtn.type = 'button';
      const isEnabledForCurrent =
        sc.scope !== 'global' &&
        wsPath &&
        sc.workspaces.some((w) => w.toLowerCase() === wsPath.toLowerCase());
      wsBtn.className = `agy-toggle-item${isEnabledForCurrent ? ' active' : ''}`;
      wsBtn.innerHTML = `${ns.iconSvg('folder', 13)}<span>${ns.escHtml(wsPath ? wsName : 'Project')}</span>`;
      wsBtn.disabled = !wsPath;
      wsBtn.addEventListener('click', () => onToggleWorkspaceRule(sc, wsPath));

      const globalBtn = document.createElement('button');
      globalBtn.type = 'button';
      globalBtn.className = `agy-toggle-item${sc.scope === 'global' ? ' active' : ''}`;
      globalBtn.innerHTML = `${ns.iconSvg('keep', 13)}<span>Global</span>`;
      globalBtn.addEventListener('click', () => onToggleGlobalPin(sc));

      scopeGroup.append(wsBtn, globalBtn);

      const hibBtn = document.createElement('button');
      hibBtn.type = 'button';
      hibBtn.className = `agy-btn has-icon ${sc.autoHibernate ? 'agy-btn-secondary' : 'agy-btn-outline'}`;
      hibBtn.innerHTML = `${ns.iconSvg('bolt', 13)}<span>Auto-Sleep</span>`;
      hibBtn.title = 'Automatically hibernate process when workspace is inactive';
      hibBtn.addEventListener('click', () => onToggleAutoHibernate(sc));

      toggles.append(scopeGroup, hibBtn);
      row.append(top, toggles);
      popoverEl.appendChild(row);
    }

    if (Array.isArray(suggestions) && suggestions.length > 0) {
      const sugSection = document.createElement('div');
      sugSection.className = 'popover-suggestions';

      const sugHeader = document.createElement('div');
      sugHeader.className = 'popover-sug-header';
      sugHeader.textContent = 'Suggested for this workspace';
      sugSection.appendChild(sugHeader);

      for (const sug of suggestions) {
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
        actBtn.innerHTML = `${ns.iconSvg(isInstall ? 'download' : 'check', 13)}<span>${isInstall ? 'Install' : 'Enable'}</span>`;
        actBtn.addEventListener('click', () => onApplySuggestion?.(sug));

        item.append(info, actBtn);
        sugSection.appendChild(item);
      }
      popoverEl.appendChild(sugSection);
    }
  };
})();
