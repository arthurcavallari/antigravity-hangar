/** @fileoverview Authenticated fetch wrapper, AgyUI/AgyShell delegation, and navigation handler for Hangar. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  ns.EXTENSIONS_TAB_ID = '__extensions__';
  ns.TERMINAL_TAB_ID = '__terminal__';
  ns.SIDECHAT_TAB_ID = '__sidechat__';
  ns.SIDECHAT_TAB_PREFIX = 'sidechat__';
  if (window.AgyShell) {
    Object.entries(window.AgyShell).forEach(([k, v]) => {
      if (ns[k] === undefined) ns[k] = v;
    });
  }
  const ui = window.AgyUI || {};
  const trustedHtml = new Set();
  const rawHtml = (str = '') => {
    const s = String(str ?? '');
    if (/[&<>"']/.test(s)) {
      if (trustedHtml.has(s)) {
        trustedHtml.delete(s);
      } else if (trustedHtml.size >= 10000) {
        trustedHtml.delete(trustedHtml.values().next().value);
      }
      trustedHtml.add(s);
    }
    return s;
  };
  const escapeRaw = (str = '') => String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  ns.rawHtml = ns.rawHtml || rawHtml;
  ns.escHtml = ns.escHtml || ((str = '') => rawHtml(ui.escHtml ? ui.escHtml(str) : escapeRaw(str)));
  const toHtml = (v) => {
    if (Array.isArray(v)) return v.map(toHtml).join('');
    if (v == null || typeof v !== 'object') {
      const s = String(v ?? '');
      return trustedHtml.has(s) ? s : escapeRaw(s);
    }
    return v.outerHTML ?? Array.from(v.childNodes || [], (c) => c.outerHTML ?? escapeRaw(c.textContent ?? '')).join('');
  };
  ns.html = ns.html || ((strings, ...vals) => rawHtml(strings.reduce(
    (a, s, i) => a + s + (i < vals.length ? toHtml(vals[i]) : ''),
    '',
  )));
  ns.setHtml = ns.setHtml || function setHtml(target, content) {
    if (!target) return target;
    if (content && typeof content === 'object' && !Array.isArray(content) && ('nodeType' in content || 'childNodes' in content)) {
      if (typeof target.replaceChildren === 'function') {
        target.replaceChildren(content);
      } else {
        while (target.firstChild) target.removeChild(target.firstChild);
        target.appendChild(content);
      }
      return target;
    }
    target.innerHTML = typeof content === 'string' ? content : toHtml(content ?? '');
    return target;
  };
  ns.el = ns.el || ui.el;
  ns.clear = ns.clear || ui.clear || ((target) => ns.setHtml(target, ''));
  const baseIconSvg = ui.iconSvg || ((name, size = 16, cls = '') => (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 -960 960 960" fill="currentColor" class="${['agy-icon', cls].filter(Boolean).join(' ')}" aria-hidden="true" data-icon="${name}"><path d="M120-240v-80h720v80H120Z"/></svg>`
  ));
  ns.iconSvg = ns.iconSvg || ((name, size = 16, cls = '') => rawHtml(baseIconSvg(name, size, cls)));
  ns.iconEl = ns.iconEl || ui.iconEl || ((name, size = 16, cls = '') => {
    const wrap = Object.assign(document.createElement('span'), { className: 'agy-icon-wrap' });
    return ns.setHtml(wrap, ns.iconSvg(name, size, cls)).firstElementChild;
  });
  ns.getUiToken = ns.getUiToken || (() => {
    try {
      const qTok = new URLSearchParams(window.location?.search || '').get('token');
      if (qTok) {
        window.__AGY_TOKEN__ = qTok;
        return qTok;
      }
      if (window.__AGY_TOKEN__) return window.__AGY_TOKEN__;
      for (const el of document?.querySelectorAll?.('script[src*="token="], link[href*="token="]') || []) {
        const rawUrl = el.getAttribute?.('src') || el.getAttribute?.('href') || '';
        const tok = new URL(rawUrl, 'http://127.0.0.1').searchParams.get('token');
        if (tok) {
          window.__AGY_TOKEN__ = tok;
          return tok;
        }
      }
    } catch {
      /* ignore */
    }
    return '';
  });
  ns.apiCall = ns.apiCall || (async function apiCall(path, body = {}) {
    const fn = window.sidecar?.fetch || window.fetch.bind(window);
    const urlToken = ns.getUiToken();
    const res = await fn(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(urlToken ? { 'X-Sidecar-Token': urlToken } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  });
  ns.formatStatusBadge = ns.formatStatusBadge || ui.formatStatusBadge || ((rawBadge = '', isRunning = false, isErrored = false) => {
    if (isRunning || rawBadge === 'RUNNING') return { label: 'Running', state: 'running' };
    if (isErrored || rawBadge === 'ERRORED') return { label: 'Error', state: 'errored' };
    if (rawBadge === 'HIBERNATED') return { label: 'Hibernated', state: 'hibernated' };
    if (rawBadge === 'STARTING') return { label: 'Starting', state: 'starting' };
    const fallback = rawBadge ? rawBadge.charAt(0).toUpperCase() + rawBadge.slice(1).toLowerCase() : 'Stopped';
    return { label: fallback, state: 'stopped' };
  });
  ns.openTabContextMenu = ns.openTabContextMenu || ui.openContextMenu;
  ns.closeTabContextMenu = ns.closeTabContextMenu || ui.closeContextMenu;
  ns.setupStripScroll = ns.setupStripScroll || ui.setupStripScroll;
  ns.measureStrip = ns.measureStrip || ui.measureStrip;
  ns.setTabShift = ns.setTabShift || ui.setTabShift;
  ns.getUnshiftedRect = ns.getUnshiftedRect || ui.getUnshiftedRect;
  ns.startInlineRename = ns.startInlineRename || ui.startInlineRename;
  ns.formatCapabilityTier = (tier = 'TIER_1_TELEMETRY') => {
    if (tier === 'TIER_3_AGENT_CONTROL') {
      return { label: 'Tier 3 · Agent Control', state: 'errored', shortLabel: 'Tier 3' };
    }
    if (tier === 'TIER_2_LOCAL_TOOLING') {
      return { label: 'Tier 2 · Local CLI', state: 'hibernated', shortLabel: 'Tier 2' };
    }
    return { label: 'Tier 1 · Telemetry', state: 'running', shortLabel: 'Tier 1' };
  };
  ns.isHostMessage = (source) => {
    for (let w = source ? window : null; w; w = w === w.parent ? null : w.parent) {
      if (source === w) return true;
    }
    return false;
  };
  const SAFE_ID_RE = (ns.SAFE_ID_RE = /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)?$/);
  const LOOPBACK_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;
  ns.isTrustedSidecarOrigin = (origin) => (
    origin === undefined || (Boolean(origin) && (origin === window.location?.origin || LOOPBACK_ORIGIN_RE.test(String(origin))))
  );
  const isSafeId = (val) => (
    typeof val === 'string' &&
    SAFE_ID_RE.test(val.trim()) &&
    !val.trim().split('/').some((s) => s === '.' || s === '..')
  );
  ns.handleHangarNavigateMessage = function handleHangarNavigateMessage(event) {
    const data = event?.data;
    if (!data || typeof data !== 'object' || data.type !== 'hangar-navigate' || event?.source === null || !ns.isTrustedSidecarOrigin(event.origin)) {
      return false;
    }
    const rawCandidate = (typeof data.pluginId === 'string' && data.pluginId.trim())
      ? data.pluginId
      : ((typeof data.sidecarId === 'string' && data.sidecarId.trim()) ? data.sidecarId : (data.targetId || ''));
    const rawId = String(rawCandidate).trim();
    if (!isSafeId(rawId)) return false;
    const effectiveSidecarId = isSafeId(data.targetId)
      ? data.targetId.trim()
      : (isSafeId(data.sidecarId) ? data.sidecarId.trim() : rawId);
    const targetTab = (typeof data.targetTab === 'string' && data.targetTab)
      ? data.targetTab
      : ((typeof data.tab === 'string' && data.tab) ? data.tab : 'plugins');
    const subTab = targetTab === 'plugins' || targetTab === 'sidecars' ? 'installed' : targetTab;
    ns.activeNavigatedPluginId = rawId;
    ns.activeNavigationTarget = { targetTab, pluginId: rawId, sidecarId: effectiveSidecarId };
    ns.setExtensionsSubTab?.(subTab);
    ns.onHangarNavigate?.({ targetTab, pluginId: rawId, sidecarId: effectiveSidecarId });
    if (typeof document !== 'undefined') {
      const storeView = document.getElementById?.('store-view');
      if (!storeView?.classList || storeView.classList.contains?.('hidden')) {
        const extTab = document.querySelector?.('.agy-tab[data-sidecar-id="__extensions__"]');
        if (extTab && !extTab.classList?.contains?.('active')) {
          extTab.click?.();
        } else if (!extTab) {
          document.getElementById?.('extensions-toggle-btn')?.click?.();
        }
      }
      document.querySelector?.(`[data-subtab="${subTab}"]`)?.click?.();
      for (const id of new Set([effectiveSidecarId, rawId].filter(Boolean))) {
        const selector = `.agy-card[data-plugin-dir="${id}"], .agy-card[data-plugin-id="${id}"], .agy-card[data-sidecar-id="${id}"], .agy-card[data-pkg-id="${id}"]`;
        const card = document.querySelector?.(selector);
        if (card) {
          card.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
          card.classList?.add?.('agy-card-highlight');
          break;
        }
      }
    }
    return true;
  };
  window.addEventListener?.('message', (e) => ns.handleHangarNavigateMessage(e));
})();
