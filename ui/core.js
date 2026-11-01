/**
 * @fileoverview Authenticated fetch wrapper, Material Symbols (0 -960 960 960) SVG icons,
 * and shared UI formatting utilities for Antigravity Hangar.
 */

(function () {
  const ns = (window.Hangar = window.Hangar || {});

  const PATHS = {
    folder:
      'M172.31-180Q142-180 121-201t-21-51.31V-707.69Q100-738 121-759t51.31-21H391.92l80,80H787.69Q818-700 839-679t21,51.31v375.38Q860-222 839-201t-51.31,21H172.31Zm0-60H787.69q5.39,0 8.85-3.46t3.46-8.85V-627.69q0-5.39-3.46-8.85T787.69-640H447.38l-80-80H172.31q-5.39,0-8.85,3.46T160-707.69v455.38q0,5.39 3.46,8.85t8.85,3.46Z',
    globe:
      'M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 31.5-155.5t86-127Q252-817 325-848.5T480-880q83 0 155.5 31.5t127 86q54.5 54.5 86 127T880-480q0 82-31.5 155t-86 127.5q-54.5 54.5-127 86T480-80Zm0-82q26-36 45-75t31-83H404q12 44 31 83t45 75Zm-104-16q-18-33-31.5-68.5T322-320H204q29 50 72.5 87t99.5 55Zm208 0q56-18 99.5-55t72.5-87H638q-9 38-22.5 73.5T584-178ZM170-400h136q-3-20-4.5-39.5T300-480q0-21 1.5-40.5T306-560H170q-5 20-7.5 39.5T160-480q0 21 2.5 40.5T170-400Zm216 0h188q3-20 4.5-39.5T580-480q0-21-1.5-40.5T574-560H386q-3 20-4.5 39.5T380-480q0 21 1.5 40.5T386-400Zm268 0h136q5-20 7.5-39.5T800-480q0-21-2.5-40.5T790-560H654q3 20 4.5 39.5T660-480q0 21-1.5 40.5T654-400Zm-16-240h118q-29-50-72.5-87T584-782q18 33 31.5 68.5T638-640Zm-234 0h152q-12-44-31-83t-45-75q-26 36-45 75t-31 83Zm-200 0h118q9-38 22.5-73.5T376-782q-56 18-99.5 55T204-640Z',
    keep:
      'M620-471.54L691.54-400v60H510v220L480-90l-30-30V-340H268.46v-60L340-471.54V-760H300v-60H660v60H620v288.46ZM354-400H606l-46-46V-760H400v314l-46,46Zm126,0Z',
    extension:
      'M208.85-197.69H713.46q3.85,0 6.35-2.69t2.5-6.54V-383.23l36.92-15.85q18.31-6.85 29.54-23.54T800-461.15q0-21.62-11.23-38.42t-29.54-24.04l-36.92-15.23V-715.38q0-4.23-2.5-6.73t-6.35-2.5H534.92l-7.31-51.08q-3.77-25.85-22.38-43.92t-44.08-18.08q-26.08,0-44.69,18.08t-22.38,43.92l-7.31,51.08H208.46q-3.46,0-5.96,2.5t-2.5,6.73V-624q51.77,17.15 84.15,62.04t32.38,100.81q0,57.31-32.19,102.19T200-297.69v90.77q0,3.85 2.5,6.54t6.35,2.69Zm0,60q-29,0-48.92-20.12T140-206.92V-347q48-1.54 82.27-33.58t34.27-80.58q0-45.62-34.46-78.12T140-575.69V-715.38q0-28.77 20.04-49t48.42-20.23H334.69q6.62-47.92 42.15-80.5t84.31-32.58q48.15,0 83.69,32.58t42.77,80.5H713.46q28.38,0 48.61,20.23t20.23,49v136.69q34.85,14.15 56.27,46.23T860-461.15q0,39.08-21.42,70.96t-56.27,46.58v136.69q0,29-20.23,49.11t-48.61,20.12H208.85Z',
    splitscreen:
      'M212.31-527.31q-30.31,0-51.31-21t-21-51.31V-747.69Q140-778 161-799t51.31-21H747.69Q778-820 799-799t21,51.31v148.08q0,30.31-21,51.31t-51.31,21H212.31Zm0-60H747.69q5.39,0 8.85-3.46t3.46-8.85V-747.69q0-5.39-3.46-8.85T747.69-760H212.31q-5.39,0-8.85,3.46T200-747.69v148.08q0,5.39 3.46,8.85t8.85,3.46Zm0,447.31Q182-140 161-161t-21-51.31V-360q0-30.31 21-51.31t51.31-21H747.69q30.31,0 51.31,21T820-360v147.69Q820-182 799-161t-51.31,21H212.31Zm0-60H747.69q5.39,0 8.85-3.46t3.46-8.85V-360q0-5.39-3.46-8.85t-8.85-3.46H212.31q-5.39,0-8.85,3.46T200-360v147.69q0,5.39 3.46,8.85t8.85,3.46Z',
    splitscreen_vertical_add:
      'M180-160q-24.75 0-42.37-17.63Q120-195.25 120-220v-520q0-24.75 17.63-42.38Q155.25-800 180-800h210q24.75 0 42.38 17.62Q450-764.75 450-740v520q0 24.75-17.62 42.37Q414.75-160 390-160H180Zm0-60h210v-520H180v520Zm390 60q-24.75 0-42.38-17.63Q510-195.25 510-220v-520q0-24.75 17.62-42.38Q545.25-800 570-800h210q24.75 0 42.38 17.62Q840-764.75 840-740v210h-60v-210H570v520h110v60H570Zm180-40v-100H650v-60h100v-100h60v100h100v60H810v100h-60Z',
    add:
      'M450-450H250q-12.75,0-21.37-8.63T220-480.01t8.62-21.37T250-510H450V-710q0-12.75 8.63-21.37T480.01-740t21.37,8.62T510-710v200H710q12.75,0 21.37,8.63T740-479.99t-8.62,21.37T710-450H510v200q0,12.75-8.63,21.37T479.99-220t-21.37-8.62T450-250V-450Z',
    play_arrow:
      'M340-236.16V-723.84L723.07-480L340-236.16ZM400-480Zm0,134L610.77-480L400-614v268Z',
    pause:
      'M530-220V-740H740v520H530Zm-310,0V-740H430v520H220Zm370-60h90V-680H590v400Zm-310,0h90V-680H280v400Z',
    refresh:
      'M481.54-180q-125.62,0-212.81-87.17T181.54-479.94t87.19-212.83T481.54-780q70.15,0 132.77,31.19t104.15,88.04V-780h60v244.61H533.85v-60h158q-31.62-57.92-87.69-91.27T481.54-720q-100,0-170,70t-70,170t70,170t170,70q77,0 139-44t87-116h63.23Q743.54-302.08 663.5-241.04T481.54-180Z',
    close:
      'M480-437.85L277.08-234.92q-8.31,8.31-20.88,8.5t-21.27-8.5T226.23-256t8.69-21.08L437.85-480L234.92-682.92q-8.31-8.31-8.5-20.88t8.5-21.27T256-733.77t21.08,8.69L480-522.15L682.92-725.08q8.31-8.31 20.88-8.5t21.27,8.5T733.77-704t-8.69,21.08L522.15-480L725.08-277.08q8.31,8.31 8.5,20.88t-8.5,21.27T704-226.23t-21.08-8.69L480-437.85Z',
    bolt:
      'M422-232L629-480H469l29-227L313-440H452L422-232ZM343.08-102.31l40-277.69h-185L527.69-855.77h49.23L537.31-540h220l-365,437.69H343.08Z',
    check:
      'M382-339.38L727.54-684.92q8.92-8.92 20.88-9.12t21.27,9.12T779-663.54t-9.31,21.38l-362.38,363Q396.46-268.31 382-268.31t-25.31-10.85l-167-167q-8.92-8.92-8.81-21.19t9.42-21.58t21.38-9.31t21.38,9.31L382-339.38Z',
    code_blocks:
      'M384-349.85l42.15-42.77L338.77-480l87-87l-42.15-42.77L253.85-480L384-349.85Zm192,0L706.15-480L576-610.15l-42.15,42.77L621.23-480l-87.38,87.38L576-349.85ZM212.31-140Q182-140 161-161t-21-51.31V-747.69Q140-778 161-799t51.31-21H747.69Q778-820 799-799t21,51.31v535.38Q820-182 799-161t-51.31,21H212.31Zm0-60H747.69q4.62,0 8.46-3.85t3.85-8.46V-747.69q0-4.62-3.85-8.46T747.69-760H212.31q-4.62,0-8.46,3.85T200-747.69v535.38q0,4.62 3.85,8.46t8.46,3.85Z',
    dock_to_right:
      'M212.31-140q-29.92,0-51.11-21.19T140-212.31V-747.69q0-29.92 21.19-51.11T212.31-820H747.69q29.92,0 51.11,21.19T820-747.69v535.38q0,29.92-21.19,51.11T747.69-140H212.31ZM320-200V-760H212.31q-4.62,0-8.46-3.85T200-747.69v535.38q0,4.62 3.85,8.46t8.46,3.85H320Zm60,0H747.69q4.62,0 8.46-3.85t3.85-8.46V-747.69q0-4.62-3.85-8.46T747.69-760H380v560Z',
    delete:
      'M280-120q-33,0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0,33-23.5,56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160,0h80v-360h-80v360ZM280-720v520-520Z',
    download:
      'M480-320L280-520l56-58l104,104v-326h80v326l104-104l56,58L480-320ZM240-160q-33,0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0,33-23.5,56.5T720-160H240Z',
    link:
      'M440-280H280q-83,0-141.5-58.5T80-480q0-83 58.5-141.5T280-680h160v80H280q-50,0-85,35t-35,85q0,50 35,85t85,35h160v80ZM320-440v-80h320v80H320Zm200,160v-80h160q50,0 85-35t35-85q0-50-35-85t-85-35H520v-80h160q83,0 141.5,58.5T880-480q0,83-58.5,141.5T680-280H520Z',
    search:
      'M784-120L532-372q-30,24-69,38t-83,14q-109,0-184.5-75.5T120-580q0-109 75.5-184.5T380-840q109,0 184.5,75.5T640-580q0,44-14,83t-38,69l252,252l-56,56ZM380-400q75,0 127.5-52.5T560-580q0-75-52.5-127.5T380-760q-75,0-127.5,52.5T200-580q0,75 52.5,127.5T380-400Z',
    verified:
      'M344-60L268-188l-144-32l14-148L40-480l98-112l-14-148l144-32l76-128l136,58l136-58l76,128l144,32l-14,148l98,112l-98,112l14,148l-144,32l-76,128l-136-58l-136,58Zm94-278l226-226l-56-58l-170,170l-86-84l-56,56l142,142Z',
    shield:
      'M480-80q-139-35-229.5-159.5T160-516v-244l320-120l320,120v244q0,152-90.5,276.5T480-80Zm0-84q104-33 172-132t68-220v-189l-240-90l-240,90v189q0,121 68,220t172,132Zm0-316Z',
    settings:
      'M370-80l-16-128q-13-5-24.5-12T307-235l-119,50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190l119,50q11-8 23-15t24-12l16-128h220l16,128q13,5 24.5,12t22.5,15l119-50l110,190l-103,78q1,7 1,13.5v27q0,6.5-2,13.5l103,78l-110,190l-118-50q-11,8-23,15t-24,12L590-80H370Zm70-80h79l14-106q31-8 57.5-23.5T639-327l99,41l39-68l-86-65q5-14 7-29.5t2-31.5q0-16-2-31.5t-7-29.5l86-65l-39-68l-99,42q-22-23-48.5-38.5T533-694l-13-106h-79l-14,106q-31,8-57.5,23.5T321-633l-99-41l-39,68l86,64q-5,15-7,30t-2,32q0,16 2,31t7,30l-86,65l39,68l99-42q22,23 48.5,38.5T427-266l13,106Zm42-180q58,0 99-41t41-99q0-58-41-99t-99-41q-59,0-99.5,41T342-480q0,58 40.5,99t99.5,41Zm-2-140Z',
    terminal:
      'M160-160q-33,0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h640q33,0 56.5,23.5T880-720v480q0,33-23.5,56.5T800-160H160Zm0-80h640v-400H160v400Zm140-40l-56-56l103-104l-104-104l57-56l160,160l-160,160Zm180,0v-80h240v80H480Z',
    chat:
      'M240-400h320v-80H240v80Zm0-120h480v-80H240v80Zm0-120h480v-80H240v80ZM80-80v-720q0-33 23.5-56.5T160-880h640q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H240L80-80Zm126-240h594v-480H160v525l46-45Zm-46 0v-480 480Z',
  };

  ns.apiCall = async function apiCall(path, body = {}) {
    const fn = window.sidecar?.fetch || window.fetch.bind(window);
    const res = await fn(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  };

  ns.iconSvg = function iconSvg(name, size = 16, className = '') {
    const cls = ['agy-icon', className].filter(Boolean).join(' ');
    if (name === 'terminal') {
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" class="${cls}" aria-hidden="true"><path transform="translate(18.775, 19.85) rotate(-180)" d="M10.925 14.05L11.975 13L8.9 9.925L11.975 6.85L10.925 5.8L6.8 9.925L10.925 14.05Z" fill="currentColor"/><path d="M11.675 14.95H16.175V13.45H11.675V14.95Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M3 5.25C3 4.00736 4.00736 3 5.25 3H18.75C19.9926 3 21 4.00736 21 5.25V18.75C21 19.9926 19.9926 21 18.75 21H5.25C4.00736 21 3 19.9926 3 18.75V5.25ZM5.25 4.5C4.83579 4.5 4.5 4.83579 4.5 5.25V18.75C4.5 19.1642 4.83579 19.5 5.25 19.5H18.75C19.1642 19.5 19.5 19.1642 19.5 18.75V5.25C19.5 4.83579 19.1642 4.5 18.75 4.5H5.25Z" fill="currentColor"/></svg>`;
    }
    const d = PATHS[name] || PATHS.code_blocks;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 -960 960 960" fill="currentColor" class="${cls}" aria-hidden="true"><path d="${d}"/></svg>`;
  };

  ns.iconEl = function iconEl(name, size = 16, className = '') {
    const wrap = document.createElement('span');
    wrap.className = 'agy-icon-wrap';
    wrap.innerHTML = ns.iconSvg(name, size, className);
    return wrap.firstElementChild;
  };

  ns.formatStatusBadge = function formatStatusBadge(rawBadge = '', isRunning = false, isErrored = false) {
    if (isRunning || rawBadge === 'RUNNING') return { label: 'Running', state: 'running' };
    if (isErrored || rawBadge === 'ERRORED') return { label: 'Error', state: 'errored' };
    if (rawBadge === 'HIBERNATED') return { label: 'Hibernated', state: 'hibernated' };
    if (rawBadge === 'STOPPED') return { label: 'Stopped', state: 'stopped' };
    if (rawBadge === 'STARTING') return { label: 'Starting', state: 'starting' };
    return {
      label: rawBadge ? rawBadge.charAt(0).toUpperCase() + rawBadge.slice(1).toLowerCase() : 'Stopped',
      state: 'stopped',
    };
  };

  ns.formatCapabilityTier = function formatCapabilityTier(tier = 'TIER_1_TELEMETRY') {
    if (tier === 'TIER_3_AGENT_CONTROL') {
      return { label: 'Tier 3 · Agent Control', state: 'errored', shortLabel: 'Tier 3' };
    }
    if (tier === 'TIER_2_LOCAL_TOOLING') {
      return { label: 'Tier 2 · Local CLI', state: 'hibernated', shortLabel: 'Tier 2' };
    }
    return { label: 'Tier 1 · Telemetry', state: 'running', shortLabel: 'Tier 1' };
  };

  // Host events (theme, workspace, conversation) come from Hangar's own window or an ancestor frame.
  // Child sidecar iframes are never ancestors, so they can't spoof them.
  ns.isHostMessage = function isHostMessage(source) {
    if (!source) return false;
    for (let w = window; ; w = w.parent) {
      if (source === w) return true;
      if (w === w.parent) return false;
    }
  };

  ns.escHtml = function escHtml(str = '') {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  let activeContextMenuEl = null;
  ns.closeTabContextMenu = function closeTabContextMenu() {
    if (activeContextMenuEl) { activeContextMenuEl.remove?.(); activeContextMenuEl = null; }
  };

  ns.openTabContextMenu = function openTabContextMenu(e, items = []) {
    e?.preventDefault?.(); e?.stopPropagation?.();
    ns.closeTabContextMenu();
    const validItems = (items || []).filter(Boolean);
    if (!validItems.length || !document.body) return null;
    const menu = document.createElement('div');
    menu.className = 'agy-context-menu';
    menu.setAttribute('role', 'menu');
    menu.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
    for (const item of validItems) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.className = 'agy-context-menu-sep'; sep.setAttribute('role', 'separator');
        menu.appendChild(sep); continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'agy-context-menu-item'; btn.setAttribute('role', 'menuitem');
      if (item.id) btn.dataset.menuId = item.id;
      btn.disabled = Boolean(item.disabled);
      const iconHtml = item.icon ? `<span class="hub-tab-icon-slot">${ns.iconSvg(item.icon, 15)}</span>` : '';
      btn.innerHTML = `${iconHtml}<span class="agy-context-menu-label">${ns.escHtml(item.label || '')}</span>`;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (btn.disabled) return;
        ns.closeTabContextMenu();
        item.onClick?.();
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    activeContextMenuEl = menu;
    const r = menu.getBoundingClientRect?.() || { width: 176, height: 132 };
    const maxW = (window.innerWidth || 800) - (r.width || 176) - 6, maxH = (window.innerHeight || 600) - (r.height || 132) - 6;
    menu.style.left = `${Math.max(6, Math.min(maxW, e?.clientX || 0))}px`;
    menu.style.top = `${Math.max(6, Math.min(maxH, e?.clientY || 0))}px`;
    return menu;
  };

  window.addEventListener?.('pointerdown', (e) => { if (activeContextMenuEl && !activeContextMenuEl.contains?.(e.target)) ns.closeTabContextMenu(); }, true);
  window.addEventListener?.('keydown', (e) => { if (e.key === 'Escape') ns.closeTabContextMenu(); }, true);
  window.addEventListener?.('blur', () => ns.closeTabContextMenu());
  window.addEventListener?.('wheel', () => ns.closeTabContextMenu(), { passive: true });
})();
