/** @fileoverview Proxies Antigravity's native jetbox_web bundle in Aux-Pane-Only terminal mode and Side-Chat conversation mode. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { callLsRpc, encodeConnectFrame as encodeConnectFrameBuf, getLsConfig, parseConnectFrames as parseConnectFramesBuf } from 'antigravity-sidecar-kit/rpc';
import { getCurrentRequestContext, isLoopbackOrigin, verifySidecarToken } from 'antigravity-sidecar-kit/state-sync';

export function checkJetboxAuth(data, rawCtx = {}, { requireToken = true } = {}) {
  const ctx = (rawCtx && (rawCtx.req || rawCtx.headers || rawCtx.query || rawCtx.origin !== undefined)) ? rawCtx : (getCurrentRequestContext?.() || rawCtx || {});
  const req = ctx?.req || (ctx?.headers ? ctx : data?.headers ? data : null);
  const headers = req?.headers || ctx?.headers || data?.headers || null;
  const origin = headers?.origin ?? ctx?.origin ?? data?.origin;
  if (origin !== undefined && !isLoopbackOrigin(origin)) {
    return { ok: false, status: 403, error: 'Forbidden origin' };
  }
  const expectedToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
  if (expectedToken && (requireToken || headers || data?.token !== undefined || ctx?.query)) {
    const headerTok = headers
      ? Array.isArray(headers['x-sidecar-token'])
        ? headers['x-sidecar-token'][0]
        : headers['x-sidecar-token'] || headers['x-codeium-csrf-token']
      : '';
    let refererTok = '';
    if (headers?.referer) {
      try {
        refererTok = new URL(headers.referer, 'http://127.0.0.1').searchParams.get('token') || '';
      } catch {}
    }
    const urlTok =
      ctx?.query?.token ??
      ctx?.query?.get?.('token') ??
      data?.token ??
      (req?.url ? new URL(req.url, 'http://127.0.0.1').searchParams.get('token') : '') ??
      refererTok ??
      '';
    const provided = String(headerTok || urlTok || refererTok || '');
    if (!verifySidecarToken(provided, expectedToken)) {
      return { ok: false, status: 401, error: 'Unauthorized' };
    }
  }
  return { ok: true, status: 200, uiToken: expectedToken || String(data?.token || '') };
}

class DefaultResponse {
  constructor(body, { contentType = 'text/plain', status = 200, headers } = {}) { this.body = body; this.contentType = contentType; this.status = status; this.headers = headers; }
}
export const MAX_ASSET_CACHE_ENTRIES = 32;
const assetCache = new Map(), chatStreams = new Map(), QUOTE_DIR = join(tmpdir(), 'hangar-quotes');
try { mkdirSync(QUOTE_DIR, { recursive: true }); } catch {}
const QUOTE_DIR_URI = pathToFileURL(QUOTE_DIR).href.replace(/\/+$/, '').replace(/^file:\/\/\/([A-Z]):/, (_, d) => `file:///${d.toLowerCase()}:`);
function writeQuoteFile(name, text) {
  const safe = (String(name || 'terminal').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'terminal') + '-quote.txt';
  try { mkdirSync(QUOTE_DIR, { recursive: true }); writeFileSync(join(QUOTE_DIR, safe), String(text || ''), 'utf8'); } catch {}
  return `${QUOTE_DIR_URI}/${encodeURIComponent(safe)}`;
}

export async function syncQuoteWithHostWindow({ conversationId = '', terminalId = '', name = 'terminal', selectionContent = '', action = 'stage', cdpPort = 0, fetchFn = globalThis.fetch, WebSocketClass = globalThis.WebSocket } = {}) {
  try {
    let port = Number(cdpPort) || 0;
    if (!port) {
      const candidates = [
        process.env.APPDATA && join(process.env.APPDATA, 'Antigravity', 'DevToolsActivePort'),
        join(homedir(), 'AppData', 'Roaming', 'Antigravity', 'DevToolsActivePort'),
        join(homedir(), '.config', 'Antigravity', 'DevToolsActivePort'),
        join(homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'),
      ].filter(Boolean);
      for (const p of candidates) {
        try { const first = readFileSync(p, 'utf8').split(/\r?\n/)[0]?.trim(); if (first && /^\d+$/.test(first)) { port = Number(first); break; } } catch {}
      }
    }
    if (!port || typeof fetchFn !== 'function' || typeof WebSocketClass !== 'function') return { ok: false, reason: 'no-cdp-port' };
    const targets = await fetchFn(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1200) }).then((r) => r.json()).catch(() => []);
    const list = Array.isArray(targets) ? targets : [];
    const cid = String(conversationId || '').trim().replace(/^hangar:/, '');
    const pages = list.filter((t) => t?.type === 'page' && t?.webSocketDebuggerUrl && !String(t?.url || '').startsWith('devtools://'));
    if (!pages.length) return { ok: false, reason: 'no-hub-page' };
    const hangarFrames = list.filter((t) => t?.type === 'iframe' && String(t?.url || '').includes('plugin://hangar-'));
    const cidParentIds = new Set(cid && cid !== '_new' ? hangarFrames.filter((f) => String(f.url || '').includes(cid)).map((f) => f.parentId).filter(Boolean) : []);
    const activePageIds = new Set(hangarFrames.map((f) => f.parentId).filter(Boolean));
    const target = (cid && cid !== '_new' && (pages.find((t) => cidParentIds.has(t.id)) || pages.find((t) => String(t.url || '').includes(cid))))
      || pages.find((t) => activePageIds.has(t.id))
      || pages.find((t) => t.title === 'Hub' || String(t.url || '').includes('/c/'))
      || pages[0];
    const cleanName = String(name || 'terminal').replace(/[\[\]()\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || 'terminal';
    const scopeJson = JSON.stringify({ terminal: { processId: String(terminalId || ''), name: cleanName, ...(selectionContent ? { selectionContent: String(selectionContent) } : {}) } });
    const expr = `(() => {
      const scopeJson = ${JSON.stringify(scopeJson)}, action = ${JSON.stringify(action)};
      window.__hangarPendingQuote = { scopeJson, ts: Date.now() };
      if (!window.__hangarDropHookInstalled) {
        window.__hangarDropHookInstalled = true;
        window.addEventListener('drop', (e) => {
          const pq = window.__hangarPendingQuote;
          if (!pq || (Date.now() - pq.ts > 60000)) return;
          if (e.dataTransfer?.files?.length > 0) return;
          if (e.isTrusted) window.__hangarLastNativeDropTs = Date.now();
          if (e.dataTransfer) {
            const origGetData = e.dataTransfer.getData.bind(e.dataTransfer);
            let patched = false;
            try {
              const nativeScope = origGetData('application/context-scope-item-cider') || origGetData('application/context-scope-item') || '';
              const scopeToUse = nativeScope || pq.scopeJson;
              e.dataTransfer.getData = (type) => (type === 'application/context-scope-item-cider' || type === 'application/context-scope-item') ? scopeToUse : ((type === 'text/uri-list' || type === 'text/plain') ? '' : origGetData(type));
              patched = true;
            } catch {}
            if (patched) setTimeout(() => { if (window.__hangarPendingQuote === pq) window.__hangarPendingQuote = null; }, 50);
          }
        }, true);
      }
      if (action === 'drop') {
        if (Date.now() - (window.__hangarLastNativeDropTs || 0) < 900) return 'already-dropped-natively';
        if (Date.now() - (window.__hangarLastInjectedDropTs || 0) < 700) return 'already-injected';
        window.__hangarLastInjectedDropTs = Date.now();
        const dt = new DataTransfer();
        dt.setData('application/context-scope-item', scopeJson);
        dt.setData('application/context-scope-item-cider', scopeJson);
        window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        const ed = document.querySelector('[data-lexical-editor="true"]');
        if (ed) ed.focus();
        window.__hangarPendingQuote = null;
        return 'injected-drop';
      }
      return 'staged';
    })()`;
    const result = await new Promise((resolve) => {
      const ws = new WebSocketClass(target.webSocketDebuggerUrl);
      const timer = setTimeout(() => { try { ws.close(); } catch {} resolve('timeout'); }, 1500);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
      ws.onmessage = (ev) => {
        try { const msg = JSON.parse(String(ev.data || '')); if (msg.id === 1) { clearTimeout(timer); try { ws.close(); } catch {} resolve(msg.result?.result?.value || 'done'); } } catch {}
      };
      ws.onerror = () => { clearTimeout(timer); resolve('error'); };
    });
    return { ok: true, result, targetId: target.id };
  } catch (err) { return { ok: false, reason: err?.message || 'error' }; }
}

async function fetchLsAsset(pathname, contentType, ResponseClass = DefaultResponse) {
  const { lsAddress: lsAddr } = getLsConfig();
  if (!lsAddr) return new ResponseClass('Missing ANTIGRAVITY_LS_ADDRESS', { status: 503, contentType: 'text/plain' });
  const cacheKey = `${lsAddr}:${pathname}`;
  if (assetCache.has(cacheKey)) return new ResponseClass(assetCache.get(cacheKey), { status: 200, contentType });
  const upstream = await fetch(`http://${lsAddr}${pathname}`);
  if (!upstream.ok) return new ResponseClass(`Upstream ${pathname} returned ${upstream.status}`, { status: upstream.status, contentType: 'text/plain' });
  const buf = Buffer.from(await upstream.arrayBuffer());
  if (assetCache.size >= MAX_ASSET_CACHE_ENTRIES) {
    const oldestKey = assetCache.keys().next().value;
    if (oldestKey !== undefined) assetCache.delete(oldestKey);
  }
  assetCache.set(cacheKey, buf);
  return new ResponseClass(buf, { status: 200, contentType });
}

export function evictStaleChatStreams(nowMs = Date.now(), maxIdleMs = 120_000) {
  let evicted = 0;
  for (const [k, entry] of chatStreams.entries()) {
    if (nowMs - (entry.lastPolledAt ?? entry.createdAt ?? 0) > maxIdleMs) {
      try { entry.abortController?.abort?.(); } catch {}
      try { entry.req?.destroy?.(); } catch {}
      chatStreams.delete(k);
      evicted += 1;
    }
  }
  return evicted;
}

export async function startTerminalSideChat({ parentConversationId = '', cascadeId = '', rpcFn = callLsRpc } = {}) {
  const newId = String(cascadeId || '').trim() || randomUUID();
  const parentId = String(parentConversationId || '').trim().replace(/^hangar:/, '');
  const req = {
    cascadeId: newId,
    trajectoryType: 22,
    source: 12,
    ...(parentId && parentId !== '_new' ? { baseTrajectoryIdentifier: { cascadeId: parentId } } : {}),
  };
  await rpcFn('StartCascade', req);
  return { ok: true, cascadeId: newId, parentConversationId: parentId && parentId !== '_new' ? parentId : '' };
}

export async function deleteTerminalSideChat({ cascadeId = '', rpcFn = callLsRpc } = {}) {
  const cid = String(cascadeId || '').trim();
  if (!cid) throw new Error('cascadeId is required');
  for (const [k, entry] of chatStreams.entries()) {
    if (entry.conversationId === cid) { try { entry.abortController?.abort(); } catch {} chatStreams.delete(k); }
  }
  await rpcFn('DeleteCascadeTrajectory', { cascadeId: cid }).catch(() => {});
  return { ok: true, cascadeId: cid };
}

export function pollChatStream({ conversationId = '', subscriberId = 'sidechat', trajectoryVerbosity = 1, afterSeq = 0, fetchFn = globalThis.fetch } = {}) {
  const now = Date.now();
  evictStaleChatStreams(now);
  const cid = String(conversationId || '').trim();
  if (!cid) return { chunks: [], seq: 0, closed: false };
  const subId = String(subscriberId || 'sidechat').trim(), key = `${cid}:${subId}`;
  let entry = chatStreams.get(key);
  if (!entry) {
    entry = { key, conversationId: cid, subscriberId: subId, seq: 0, chunks: [], connecting: false, connected: false, closed: false, nextRetryAt: 0, abortController: null, createdAt: now, lastPolledAt: now };
    chatStreams.set(key, entry);
  } else {
    entry.lastPolledAt = now;
  }
  const { lsAddress: lsAddr, csrfToken: csrf } = getLsConfig();
  if (!entry.connecting && !entry.connected && !entry.closed && Date.now() >= entry.nextRetryAt && lsAddr && csrf && typeof fetchFn === 'function') {
    entry.connecting = true; entry.nextRetryAt = Date.now() + 1200;
    const ac = new AbortController(); entry.abortController = ac;
    (async () => {
      let reader = null;
      try {
        const res = await fetchFn(`http://${lsAddr}/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/connect+json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': csrf },
          body: encodeConnectFrameBuf({ conversationId: cid, subscriberId: subId, trajectoryVerbosity: Number(trajectoryVerbosity) || 1 }),
          signal: ac.signal,
        });
        entry.connecting = false;
        if (!res.ok || !res.body) return;
        entry.connected = true; reader = res.body.getReader();
        let carry = Buffer.alloc(0);
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          carry = Buffer.concat([carry, Buffer.from(value)]);
          const parsed = parseConnectFramesBuf(carry); carry = parsed.rest;
          for (const frame of parsed.frames) {
            if (frame.flags === 0 && frame.data) {
              entry.seq += 1; entry.chunks.push({ seq: entry.seq, frameData: frame.data });
              if (entry.chunks.length > 240) entry.chunks.splice(0, 80);
            } else if ((frame.flags & 2) === 2 && frame.data?.error) entry.closed = true;
          }
        }
      } catch {} finally {
        try { reader?.releaseLock(); } catch {}
        entry.connecting = false; entry.connected = false;
      }
    })();
  }
  const minSeq = Number(afterSeq) || 0;
  return { conversationId: cid, subscriberId: subId, seq: entry.seq, closed: entry.closed, chunks: entry.chunks.filter((c) => c.seq > minSeq) };
}
export const pollSideChatStream = pollChatStream;

function safeScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function buildJetboxHtml({ mode = 'terminal', cascadeId = '', terminalId = '', hostTheme = 'dark', uiToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '' } = {}) {
  const isChat = mode === 'chat', safeTheme = hostTheme === 'light' ? 'light' : 'dark', q = uiToken ? `?token=${encodeURIComponent(uiToken)}` : '';
  const bootConfig = safeScriptJson({ productName: 'antigravity', csrfToken: 'hangar-jetbox-proxy', appVersion: '2.28.0', releaseChannel: 'stable', devMode: true });
  const bootParams = safeScriptJson({ mode: isChat ? 'chat' : 'terminal', cascadeId: String(cascadeId || ''), terminalId: String(terminalId || ''), quoteDirUri: QUOTE_DIR_URI, uiToken: String(uiToken || '') });
  const sharedChromeHideCss = `
    .agy-shell { --sidebar-width: 0px !important; --static-cluster-width: 0px !important; }
    .agy-shell > div:has(> [data-testid="title-menu-bar"]),
    .agy-shell > [data-testid="layout-status-bar"],
    .agy-shell > div.flex-1.relative > div.absolute.left-0.top-0.z-50,
    [role="navigation"][aria-label="Sidebar"],
    div:has(> [role="navigation"][aria-label="Sidebar"]),
    div:has(> div > [role="navigation"][aria-label="Sidebar"]),
    [data-testid="sidebar-sash"],
    div:has(> div > [data-testid="sidebar-sash"]),
    [data-testid="sidebar-popover-backdrop"],
    div:has(+ div > [data-testid="overview-panel-host"]),
    .\\@container\\/titlebar,
    [data-pane-id] > div:has([data-testid="pane-titlebar-toolbar"]),
    div.shrink-0:has(> .\\@container\\/titlebar),
    .agy-sheet > div.h-10.shrink-0:has(.\\@container\\/titlebar),
    [data-testid="bottom-terminal-panel"] { display: none !important; visibility: hidden !important; pointer-events: none !important; width: 0 !important; min-width: 0 !important; height: 0 !important; min-height: 0 !important; }`;
  const styleBlock = isChat
    ? `html, body, #root { height: 100%; width: 100%; margin: 0; overflow: hidden; background: var(--background, #101010); }
    ${sharedChromeHideCss}
    .agy-shell:not(:has([data-aux-pane-open="true"])) > div.flex-1.relative > div.absolute.right-0.top-0.z-50 { display: none !important; }
    html:not([data-hangar-overview="open"]) [data-testid="overview-panel-host"] { --overview-panel-reserve: 0px !important; --overview-panel-gutter-reserve: 0px !important; }
    html:not([data-hangar-overview="open"]) [data-testid="overview-panel-host-overlay"],
    html:not([data-hangar-overview="open"]) [data-testid="overview-panel-host-gutter"],
    html:not([data-hangar-overview="open"]) [data-testid="overview-panel-host-sibling"],
    html:not([data-hangar-overview="open"]) [data-testid="overview-panel-overlay-backdrop"] { display: none !important; }
    div[title="Open side-by-side view"] { pointer-events: none !important; cursor: default !important; }
    div[title="Open side-by-side view"] button { pointer-events: none !important; text-decoration: none !important; }
    div[title="Open side-by-side view"] button svg:last-child { display: none !important; }
    [data-testid="conversation-view"] { min-height: 0; z-index: 10 !important; }`
    : `html, body, #root { height: 100%; width: 100%; margin: 0; overflow: hidden; background: var(--background, #101010); }
    ${sharedChromeHideCss}
    .agy-shell > div.flex-1.relative > div.absolute.right-0.top-0.z-50 { display: none !important; }
    #root, #root *:not([data-testid="terminal-split-container"]):not([data-testid="terminal-split-container"] *) { container-type: normal !important; contain: none !important; isolation: auto !important; transform: none !important; filter: none !important; backdrop-filter: none !important; }
    #root *:not([data-testid="terminal-tab-connecting"]):not([data-testid="terminal-tab-connecting"] *):not([data-testid="terminal-tab-surface"]):not([data-testid="terminal-tab-surface"] *):not([data-testid="terminal-split-container"]):not([data-testid="terminal-split-container"] *):not(.selection-popup):not(.selection-popup *) { visibility: hidden !important; pointer-events: none !important; }
    [data-testid="conversation-view"], [data-testid="conversation-view-drag-tint"], [data-testid="input-card-drag-highlight"], [data-testid="terminal-active"]:has(.xterm) > .pointer-events-none { display: none !important; visibility: hidden !important; pointer-events: none !important; }
    [data-testid="terminal-tab-connecting"], [data-testid="terminal-tab-surface"], [data-testid="terminal-split-container"] { visibility: visible !important; pointer-events: auto !important; position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 99999 !important; background: var(--background, #101010) !important; }
    [data-testid="terminal-tab-connecting"] *, [data-testid="terminal-tab-surface"] *, [data-testid="terminal-split-container"] *, .selection-popup, .selection-popup * { visibility: visible !important; }
    .selection-popup { pointer-events: auto !important; width: auto !important; white-space: nowrap !important; }
    .selection-popup button:not([data-hangar-ask]) { -webkit-user-drag: element !important; cursor: grab !important; }
    .selection-popup button[data-hangar-ask] { border-left: 1px solid var(--border, rgba(128,128,128,0.25)) !important; cursor: pointer !important; }
    .selection-popup button > * { pointer-events: none !important; }`;
  return `<!doctype html>
<html lang="en" style="color-scheme: ${safeTheme};">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${isChat ? 'Antigravity Side Chat' : 'Antigravity Native Terminal'}</title>
  <script src="/preload.js${q}"></script>
  <script>
    window.__APP_CONFIG__ = ${bootConfig};
    window.process = window.process || { env: { NODE_ENV: 'production' } };
    if (!window.process.platform) { const ua = navigator.userAgent || ''; window.process.platform = ua.includes('Windows') ? 'win32' : ua.includes('Mac') ? 'darwin' : 'linux'; }
    (() => {
      const { mode, cascadeId, terminalId, quoteDirUri, uiToken } = ${bootParams};
      let userFocusAllowed = false;
      ['pointerdown', 'mousedown', 'keydown'].forEach((ev) => window.addEventListener?.(ev, () => { userFocusAllowed = true; }, true));
      window.addEventListener?.('blur', () => { userFocusAllowed = false; });
      const canStealFocus = () => {
        try {
          if (window.parent?.document?.querySelector?.('.agy-rename-input')) return false;
          return Boolean(userFocusAllowed || document.hasFocus?.() || window.parent?.document?.hasFocus?.());
        } catch { return Boolean(userFocusAllowed || document.hasFocus?.()); }
      };
      if (window.HTMLElement?.prototype?.focus) {
        const origFocus = window.HTMLElement.prototype.focus;
        window.HTMLElement.prototype.focus = function (...args) { if (canStealFocus()) return origFocus.apply(this, args); };
      }
      if (typeof window.focus === 'function') {
        const origWinFocus = window.focus.bind(window);
        window.focus = function (...args) { if (canStealFocus()) return origWinFocus(...args); };
      }
      if (uiToken && typeof window.Worker === 'function') {
        const OrigWorker = window.Worker;
        window.Worker = function PatchedWorker(scriptURL, options) {
          let nextUrl = String(scriptURL || '');
          try {
            const u = new URL(nextUrl, window.location.origin);
            if (u.origin === window.location.origin && !u.searchParams.has('token')) {
              u.searchParams.set('token', uiToken);
              nextUrl = u.pathname + u.search + u.hash;
            }
          } catch {}
          return new OrigWorker(nextUrl, options);
        };
        window.Worker.prototype = OrigWorker.prototype;
      }
      let effectiveCascadeId = mode === 'chat' ? (cascadeId || 'hangar-sidechat') : (terminalId || ((cascadeId && cascadeId !== '_new') ? cascadeId : 'hangar-terminal'));
      const tabId = terminalId ? 'terminal__' + terminalId : 'terminal';
      try {
        const rawLs = window.localStorage, mem = new Map();
        const isoLs = {
          getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : (rawLs?.getItem?.(k) ?? null)),
          setItem: (k, v) => { mem.set(String(k), String(v)); },
          removeItem: (k) => { mem.delete(String(k)); },
          clear: () => { mem.clear(); },
        };
        Object.defineProperty(window, 'localStorage', { value: isoLs, configurable: true });
        if (mode === 'chat') {
          const v1Chat = { isPaneOpen: false, activeTabId: '', tabs: [], persistentTabState: {} };
          window.localStorage.setItem('aux-pane-session', JSON.stringify({ conversationPanes: { [effectiveCascadeId]: v1Chat }, newConversationPanes: {}, homePane: v1Chat, conversationScopeProviders: {} }));
          window.localStorage.setItem('aux-pane-v2-session', JSON.stringify({ version: 1, conversationPanes: { [effectiveCascadeId]: { tabs: [], activeTabId: undefined } }, newConversationPanes: {} }));
        } else {
          const v1Pane = { isPaneOpen: true, activeTabId: 'terminal', tabs: [], persistentTabState: { terminal: { conversationId: effectiveCascadeId, activeTerminalUuid: terminalId } } };
          window.localStorage.setItem('aux-pane-session', JSON.stringify({ conversationPanes: { [effectiveCascadeId]: v1Pane }, newConversationPanes: {}, homePane: v1Pane, conversationScopeProviders: { [effectiveCascadeId]: ['terminal'] } }));
          window.localStorage.setItem('aux-pane-v2-session', JSON.stringify({ version: 1, conversationPanes: { [effectiveCascadeId]: { tabs: [], activeTabId: tabId } }, newConversationPanes: {} }));
        }
      } catch {}
      if (typeof window.ResizeObserver === 'function') {
        const OrigRO = window.ResizeObserver;
        window.ResizeObserver = class extends OrigRO {
          constructor(cb) {
            super((entries, obs) => {
              if ((Number(window.innerWidth) || 0) < 40 || (Number(window.innerHeight) || 0) < 24) return;
              const valid = entries.filter((e) => (e?.contentRect?.width || 0) >= 40 && (e?.contentRect?.height || 0) >= 24);
              if (valid.length) cb(valid, obs);
            });
          }
        };
      }
      try {
        const routeSuffix = mode === 'chat' ? '?hostTheme=${safeTheme}&defaultThemeMode=${safeTheme}' : '?tab=' + encodeURIComponent(tabId) + '&hostTheme=${safeTheme}&defaultThemeMode=${safeTheme}';
        history.replaceState(null, '', '/c/' + encodeURIComponent(effectiveCascadeId) + routeSuffix);
      } catch {}
      if (window.customElements) { const origDefine = window.customElements.define; window.customElements.define = (n, c, o) => { if (!window.customElements.get(n)) origDefine.call(window.customElements, n, c, o); }; }
      const origRaf = window.requestAnimationFrame?.bind(window), origCaf = window.cancelAnimationFrame?.bind(window);
      if (origRaf) {
        const rafMap = new Map(); let nextRafId = 1;
        window.requestAnimationFrame = (cb) => {
          const id = nextRafId++; let done = false;
          const run = (ts) => { if (done) return; done = true; const e = rafMap.get(id); rafMap.delete(id); if (e?.nId && origCaf) origCaf(e.nId); if (e?.tId) clearTimeout(e.tId); cb(ts); };
          rafMap.set(id, { nId: origRaf(run), tId: setTimeout(() => run(window.performance?.now?.() || Date.now()), 20) }); return id;
        };
        window.cancelAnimationFrame = (id) => { const e = rafMap.get(id); if (e) { rafMap.delete(id); if (e.nId && origCaf) origCaf(e.nId); if (e.tId) clearTimeout(e.tId); } else if (origCaf) origCaf(id); };
      }

      let savedThemeVars = null, currentTermTitle = '';
      const applySavedTheme = () => { if (!savedThemeVars || !document.documentElement) return; for (const [k, v] of Object.entries(savedThemeVars)) if (v) document.documentElement.style.setProperty(k, v); };
      const postToParent = (type, payload) => { if (window.parent && window.parent !== window) window.parent.postMessage({ type, payload }, '*'); };
      const nativeFetch = window.fetch.bind(window), sidecarFetch = () => (url, opts = {}) => {
        const fn = window.sidecar?.fetch || nativeFetch;
        const headers = { ...(opts.headers || {}), ...(uiToken ? { 'X-Sidecar-Token': uiToken } : {}) };
        return fn(url, { ...opts, headers });
      };
      const LS_PREFIX = '/exa.language_server_pb.LanguageServerService/', GRPC_WEB_HEADERS = { 'Content-Type': 'application/grpc-web+json' };
      const STATE_STUB = { appState: { agentOnboardingCompleted: 2 }, userConfig: { userSettings: { themeMode: '${safeTheme}' === 'light' ? 2 : 1 } } };

      function encodeConnectFrame(obj, flags = 0) {
        const bytes = new TextEncoder().encode(typeof obj === 'string' ? obj : JSON.stringify(obj ?? {})), frame = new Uint8Array(5 + bytes.length);
        frame[0] = flags & 0xff; new DataView(frame.buffer).setUint32(1, bytes.length, false); frame.set(bytes, 5); return frame;
      }
      const encodeGrpcTrailer = (status = 0) => encodeConnectFrame('grpc-status: ' + status + '\\r\\n', 0x80);
      function makeGrpcUnaryResponse(obj) {
        const data = encodeConnectFrame(obj, 0), trailer = encodeGrpcTrailer(0), out = new Uint8Array(data.length + trailer.length);
        out.set(data, 0); out.set(trailer, data.length); return new window.Response(out, { status: 200, headers: GRPC_WEB_HEADERS });
      }
      const makeGrpcStreamResponse = (initialFrames = []) => new window.Response(new ReadableStream({ start(c) { for (const f of initialFrames) c.enqueue(encodeConnectFrame(f, 0)); } }), { status: 200, headers: GRPC_WEB_HEADERS });
      function decodeConnectRequest(body) {
        if (!body) return {};
        if (typeof body === 'string') { try { return JSON.parse(body); } catch { return {}; } }
        try {
          const u8 = body instanceof Uint8Array ? body : new Uint8Array(body.buffer || body, body.byteOffset || 0, body.byteLength ?? body.length);
          const jsonSlice = u8.length >= 5 && u8[0] === 0 ? u8.subarray(5, 5 + new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(1, false)) : u8;
          return JSON.parse(new TextDecoder().decode(jsonSlice));
        } catch { return {}; }
      }
      function createTerminalConnectStream(reqTerminalId) {
        let afterSeq = 0, cancelled = false, lastTitle = '', lastCwd = '';
        return new ReadableStream({
          async start(controller) {
            while (!cancelled) {
              try {
                const res = await sidecarFetch()('/api/terminal/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ terminalId: reqTerminalId, afterSeq }) });
                const data = await res.json();
                for (const chunk of data.chunks || []) {
                  afterSeq = Math.max(afterSeq, chunk.seq || 0);
                  if (chunk.outputBase64) controller.enqueue(encodeConnectFrame({ output: chunk.outputBase64, isScrollback: Boolean(chunk.isScrollback) }, 0));
                  if (chunk.rawFrame?.title && chunk.rawFrame.title !== lastTitle) { lastTitle = currentTermTitle = chunk.rawFrame.title; controller.enqueue(encodeConnectFrame({ title: lastTitle }, 0)); postToParent('hangar-jetbox-title-changed', { terminalId: reqTerminalId, title: lastTitle }); }
                  if (chunk.rawFrame?.cwd && chunk.rawFrame.cwd !== lastCwd) { lastCwd = chunk.rawFrame.cwd; controller.enqueue(encodeConnectFrame({ cwd: lastCwd }, 0)); }
                }
                if (data.title && data.title !== lastTitle) { lastTitle = currentTermTitle = data.title; controller.enqueue(encodeConnectFrame({ title: data.title }, 0)); postToParent('hangar-jetbox-title-changed', { terminalId: reqTerminalId, title: data.title }); }
                if (data.cwd && data.cwd !== lastCwd) { lastCwd = data.cwd; controller.enqueue(encodeConnectFrame({ cwd: data.cwd }, 0)); }
                if (data.exited) { controller.enqueue(encodeConnectFrame({ exitCode: data.exitCode ?? 0 }, 0)); controller.enqueue(encodeGrpcTrailer(0)); controller.close(); break; }
              } catch {}
              await new Promise((r) => setTimeout(r, (window.innerWidth === 0 || document.hidden) ? 250 : 45));
            }
          },
          cancel() { cancelled = true; },
        });
      }
      function createChatConnectStream(reqBody) {
        let afterSeq = 0, cancelled = false;
        const convId = reqBody?.conversationId || effectiveCascadeId, subId = reqBody?.subscriberId || 'sidechat', verbosity = reqBody?.trajectoryVerbosity ?? 1;
        return new ReadableStream({
          async start(controller) {
            while (!cancelled) {
              try {
                const res = await sidecarFetch()('/api/terminal/chat-poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: convId, subscriberId: subId, trajectoryVerbosity: verbosity, afterSeq }) });
                const data = await res.json();
                for (const chunk of data.chunks || []) {
                  afterSeq = Math.max(afterSeq, chunk.seq || 0);
                  if (chunk.frameData) controller.enqueue(encodeConnectFrame(chunk.frameData, 0));
                }
                if (data.closed) { controller.enqueue(encodeGrpcTrailer(0)); controller.close(); break; }
              } catch {}
              await new Promise((r) => setTimeout(r, (window.innerWidth === 0 || document.hidden) ? 250 : 45));
            }
          },
          cancel() { cancelled = true; },
        });
      }
      function createSummariesConnectStream() {
        let cancelled = false;
        return new ReadableStream({
          async start(controller) {
            while (!cancelled) {
              try {
                const res = await sidecarFetch()('/api/terminal/ls-rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'GetAllCascadeTrajectories', body: {} }) });
                const data = await res.json().catch(() => ({}));
                if (data?.trajectorySummaries) controller.enqueue(encodeConnectFrame({ updates: data.trajectorySummaries, deletes: [] }, 0));
              } catch {}
              await new Promise((r) => setTimeout(r, 2500));
            }
          },
          cancel() { cancelled = true; },
        });
      }
      window.fetch = async function patchedFetch(input, init = {}) {
        const rawUrl = typeof input === 'string' ? input : input?.url || '';
        let pathname = rawUrl; try { pathname = new URL(rawUrl, window.location.origin).pathname; } catch {}
        if (pathname.startsWith(LS_PREFIX)) {
          const method = pathname.slice(LS_PREFIX.length);
          if (method === 'GetSidecars') return makeGrpcUnaryResponse({ sidecars: [] });
          if (method === 'HasAuthToken') return makeGrpcUnaryResponse({ hasToken: true });
          if (method === 'SubscribeToSidecars') return makeGrpcStreamResponse([{ sidecars: [] }]);
          if (method === 'JetboxReadState') { setTimeout(applySavedTheme, 50); return makeGrpcUnaryResponse(STATE_STUB); }
          if (method === 'JetboxSubscribeToState') return makeGrpcStreamResponse([STATE_STUB]);
          if (method === 'StreamTerminalOutput') return new window.Response(createTerminalConnectStream(decodeConnectRequest(init.body).terminalId || terminalId), { status: 200, headers: GRPC_WEB_HEADERS });
          if (mode === 'chat' && method === 'StreamAgentStateUpdates') {
            const reqBody = decodeConnectRequest(init.body);
            if (reqBody?.conversationId && reqBody.conversationId !== effectiveCascadeId) {
              postToParent('hangar-sidechat-foreign-nav', { cascadeId: reqBody.conversationId, expectedCascadeId: effectiveCascadeId });
            }
            return new window.Response(createChatConnectStream(reqBody), { status: 200, headers: GRPC_WEB_HEADERS });
          }
          if (mode === 'chat' && method === 'JetboxSubscribeToSummaries') return new window.Response(createSummariesConnectStream(), { status: 200, headers: GRPC_WEB_HEADERS });
          if (method.startsWith('Stream') || method.startsWith('Subscribe') || method.startsWith('JetboxSubscribe') || method.startsWith('Watch') || method.endsWith('Stream')) return makeGrpcStreamResponse([]);
          const rpcRes = await sidecarFetch()('/api/terminal/ls-rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, body: decodeConnectRequest(init.body), targetTerminalId: terminalId, targetConversationId: effectiveCascadeId }) });
          return makeGrpcUnaryResponse(await rpcRes.json().catch(() => ({})));
        }
        return nativeFetch(input, init);
      };

      function buildScopePayload(tid, title, selectionContent) {
        const cleanName = String(title || currentTermTitle || 'terminal').replace(/[\\[\\]()\\r\\n]+/g, ' ').replace(/\\s+/g, ' ').trim() || 'terminal';
        const safeFile = (cleanName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'terminal') + '-quote.txt';
        const quoteFileUri = quoteDirUri ? quoteDirUri + '/' + encodeURIComponent(safeFile) : '';
        const termObj = { processId: String(tid || terminalId || ''), name: cleanName, ...(selectionContent ? { selectionContent: String(selectionContent) } : {}) };
        const contextScopeJson = JSON.stringify({ terminal: termObj }), lexicalJson = JSON.stringify({ namespace: 'Input', nodes: [
          { detail: 0, format: 0, mode: 'segmented', style: '', text: '', trigger: '@', value: 'contextScopeItemMention', scopeItem: contextScopeJson, data: { data: contextScopeJson }, type: 'contextScopeItemMention', version: 1 },
          { detail: 0, format: 0, mode: 'normal', style: '', text: ' ', type: 'text', version: 1 },
        ] });
        return { cleanName, contextScopeJson, lexicalJson, quoteFileUri, plainText: '[' + cleanName + '](terminal;' + termObj.processId + ') ' };
      }
      function injectTerminalQuoteIntoComposer(quoteOpts = {}, attempt = 0) {
        const ed = document.querySelector?.('[data-lexical-editor="true"]');
        if (!ed && attempt < 50) { setTimeout(() => injectTerminalQuoteIntoComposer(quoteOpts, attempt + 1), 40); return false; }
        const payload = buildScopePayload(quoteOpts.terminalId, quoteOpts.title || quoteOpts.cleanName, quoteOpts.selectionContent);
        let dt = null;
        try { dt = new DataTransfer(); } catch {
          const map = {};
          dt = { types: [], setData(k, v) { map[k] = String(v); if (!this.types.includes(k)) this.types.push(k); }, getData(k) { return map[k] || ''; } };
        }
        dt.setData('application/context-scope-item', payload.contextScopeJson);
        dt.setData('application/context-scope-item-cider', payload.contextScopeJson);
        dt.setData('application/x-lexical-editor', payload.lexicalJson);
        dt.setData('text/plain', payload.plainText);
        let dropEv = null;
        try { dropEv = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }); } catch {
          dropEv = { type: 'drop', bubbles: true, cancelable: true, dataTransfer: dt, preventDefault() {}, stopPropagation() {} };
        }
        if (!dropEv.dataTransfer) try { Object.defineProperty(dropEv, 'dataTransfer', { value: dt }); } catch {}
        window.dispatchEvent?.(dropEv);
        if (ed) {
          ed.focus?.();
          if (quoteOpts.promptText) {
            setTimeout(() => {
              ed.focus?.();
              try { document.execCommand?.('insertText', false, ' ' + String(quoteOpts.promptText)); } catch {}
              if (quoteOpts.autoSubmit) {
                setTimeout(() => {
                  ed.focus?.();
                  try { ed.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })); } catch {}
                }, 60);
              }
            }, 45);
          }
        }
        postToParent('hangar-sidechat-quote-injected', { cascadeId: effectiveCascadeId, terminalId: quoteOpts.terminalId || '', cleanName: payload.cleanName });
        return true;
      }
      function setOverviewPanelOpen(wantOpen) {
        const open = Boolean(wantOpen);
        if (document.documentElement) {
          if (open) document.documentElement.setAttribute('data-hangar-overview', 'open');
          else document.documentElement.removeAttribute('data-hangar-overview');
        }
        const ov = document.querySelector?.('[data-testid="overview-panel-host"]');
        const fk = ov && Object.keys(ov).find((k) => k.startsWith('__reactFiber$'));
        for (let f = fk ? ov[fk] : null, d = 0; f && d < 15; d++, f = f.return) {
          const val = f.memoizedProps?.value;
          if (val && typeof val.togglePanel === 'function' && 'isPanelVisible' in val) {
            const curOpen = val.breakpoint === 'small' ? Boolean(val.overlayOpen) : Boolean(val.isPanelVisible);
            if (curOpen !== open) {
              try { val.togglePanel(); } catch {}
            }
            break;
          }
        }
        postToParent('hangar-sidechat-overview-state', { cascadeId: effectiveCascadeId, open });
      }
      function focusJetboxTerminal(attempt = 0) {
        if (!canStealFocus()) return;
        try { window.focus?.(); } catch {}
        const ctx = findTerminalContext(), ta = document.querySelector?.('.xterm-helper-textarea');
        if (ctx?.xterm?.focus || ta) {
          try { ctx.xterm?.focus?.(); } catch {}
          try { ta?.focus?.({ preventScroll: true }); } catch {}
        } else if (attempt < 25) setTimeout(() => focusJetboxTerminal(attempt + 1), 40);
      }
      window.addEventListener('message', (e) => {
        if (e.source !== undefined && e.source !== window.parent) return;
        if (e.origin && e.origin !== window.location?.origin) return;
        if (e.data?.type === 'theme-change' && e.data?.payload?.cssVariables) { savedThemeVars = e.data.payload.cssVariables; applySavedTheme(); }
        else if (e.data?.type === 'hangar-jetbox-shown') { try { window.dispatchEvent?.(new Event('resize')); } catch {} if (e.data?.focus !== false) focusJetboxTerminal(); }
        else if (e.data?.type === 'hangar-jetbox-focus') focusJetboxTerminal();
        else if (e.data?.type === 'hangar-clear-selection') { const ctx = findTerminalContext(); try { ctx.xterm?.clearSelection?.(); ctx.dismissPopup?.(); } catch {} }
        else if (e.data?.type === 'hangar-inject-terminal-quote' && e.data?.payload) {
          if (e.source !== window.parent) return;
          injectTerminalQuoteIntoComposer(e.data.payload);
        }
        else if (e.data?.type === 'hangar-sidechat-toggle-overview') setOverviewPanelOpen(e.data.open);
        else if (e.data?.type === 'hangar-sidechat-switch-cascade' && e.data?.payload?.cascadeId) {
          if (e.source !== window.parent) return;
          effectiveCascadeId = String(e.data.payload.cascadeId);
          try {
            history.pushState(null, '', '/c/' + encodeURIComponent(effectiveCascadeId) + '?hostTheme=${safeTheme}&defaultThemeMode=${safeTheme}');
            let popEv; try { popEv = new PopStateEvent('popstate'); } catch { popEv = { type: 'popstate' }; }
            window.dispatchEvent?.(popEv);
          } catch {}
          if (e.data.payload.quote) setTimeout(() => injectTerminalQuoteIntoComposer(e.data.payload.quote), 60);
        }
      });

      function copyScopePayload(payload) {
        let ok = false, probe = null;
        const onCopy = (e) => {
          if (!e.clipboardData) return;
          e.preventDefault(); e.stopPropagation();
          e.clipboardData.setData('text/plain', payload.plainText); e.clipboardData.setData('application/x-lexical-editor', payload.lexicalJson);
          e.clipboardData.setData('application/context-scope-item', payload.contextScopeJson); e.clipboardData.setData('application/context-scope-item-cider', payload.contextScopeJson);
          ok = true;
        };
        document.addEventListener('copy', onCopy, true);
        try {
          const sel = window.getSelection?.();
          if (sel && (!sel.rangeCount || sel.isCollapsed) && typeof document.createRange === 'function' && document.body) {
            probe = document.createElement('span'); probe.textContent = payload.plainText; probe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none;';
            document.body.appendChild(probe); const r = document.createRange(); r.selectNodeContents(probe); sel.removeAllRanges?.(); sel.addRange?.(r);
          }
          document.execCommand('copy');
        } catch {}
        document.removeEventListener('copy', onCopy, true);
        if (probe) { try { window.getSelection?.()?.removeAllRanges?.(); probe.remove(); } catch {} }
        return ok;
      }

      function findTerminalContext(startNode) {
        const el = (startNode?.nodeType === 1 ? startNode : startNode?.parentElement)?.closest?.('[data-testid="terminal-active"]')
          || document.querySelector('[data-testid^="terminal-pane-"][data-active="true"] [data-testid="terminal-active"]') || document.querySelector('[data-testid="terminal-active"]');
        let selectionText = '', termTitle = currentTermTitle, termId = terminalId, xterm = null, dismissPopup = null, foundProc = false;
        for (const node of [document.querySelector('.selection-popup'), el]) {
          const fk = node && Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
          for (let f = fk ? node[fk] : null, d = 0; f && d < 18; d++, f = f.return) {
            const p = f.memoizedProps, selTxt = p?.selection?.text || p?.selection?.context?.textSelection, dismiss = p?.onDismiss || p?.dismiss, proc = p?.process || p?.terminal || p?.activeTerminal;
            if (selTxt && !selectionText) selectionText = selTxt;
            if (typeof dismiss === 'function' && !dismissPopup) dismissPopup = dismiss;
            if (proc?.terminalId && !foundProc) { termId = proc.terminalId; if (proc.title) termTitle = proc.title; foundProc = true; }
            for (let s = f.memoizedState; s && !xterm; s = s.next) {
              const cand = typeof s.memoizedState?.getSelection === 'function' ? s.memoizedState : (typeof s.memoizedState?.current?.getSelection === 'function' ? s.memoizedState.current : null);
              if (cand) xterm = cand;
            }
          }
        }
        return { selectionText: selectionText || xterm?.getSelection?.() || window.getSelection?.()?.toString?.() || cachedQuoteCtx?.selectionText || lastReportedSel || '', termId, termTitle, xterm, dismissPopup };
      }
      if (mode === 'chat') {
        window.addEventListener?.('click', (e) => {
          const tgt = e.target?.closest ? e.target : e.target?.parentElement;
          if (tgt?.getAttribute?.('data-testid') === 'overview-panel-overlay-backdrop') {
            setOverviewPanelOpen(false);
            return;
          }
          if (tgt?.closest?.('[data-testid="overview-panel-row-terminal"]')) {
            e.preventDefault?.();
            e.stopPropagation?.();
            e.stopImmediatePropagation?.();
            setOverviewPanelOpen(false);
            postToParent('hangar-sidechat-open-terminal', { cascadeId: effectiveCascadeId });
          }
        }, true);
        return;
      }
      let cachedQuoteCtx = null, lastReportedSel = '', isHoldingQuoteBtn = false, isDraggingQuote = false, restoreXtermFn = null;
      const getPopupBtn = (t) => (t?.closest ? t : t?.parentElement)?.closest?.('.selection-popup button');
      const releaseQuoteHold = (clearSel) => {
        isHoldingQuoteBtn = false; if (restoreXtermFn) { try { restoreXtermFn(); } catch {} restoreXtermFn = null; }
        if (clearSel && cachedQuoteCtx) { try { cachedQuoteCtx.xterm?.clearSelection?.(); cachedQuoteCtx.dismissPopup?.(); } catch {} cachedQuoteCtx = null; }
      };
      document.addEventListener?.('selectionchange', (e) => { if (isHoldingQuoteBtn) e.stopImmediatePropagation?.(); }, true);
      function ensureAskButton() {
        const popup = document.querySelector?.('.selection-popup'), quoteBtn = popup?.querySelector?.('button:not([data-hangar-ask])');
        if (!popup || !quoteBtn) return;
        quoteBtn.draggable = true; quoteBtn.setAttribute?.('draggable', 'true'); if (quoteBtn.style) quoteBtn.style.webkitUserDrag = 'element';
        if (!popup.querySelector?.('[data-hangar-ask]')) {
          if (quoteBtn.className) quoteBtn.className = quoteBtn.className.replace(/\\bflex-1\\b/g, '').trim();
          const askBtn = document.createElement('button'), row = quoteBtn.parentElement || popup;
          askBtn.type = 'button'; askBtn.className = ((quoteBtn.className || '') + ' border-l border-border whitespace-nowrap').trim();
          askBtn.setAttribute?.('data-hangar-ask', 'true'); askBtn.draggable = false; askBtn.setAttribute?.('draggable', 'false'); askBtn.innerHTML = '<span>Quote &amp; Ask</span>';
          row.appendChild?.(askBtn);
        }
        const vw = Number(window.innerWidth) || document.documentElement?.clientWidth || 0, pRect = popup.offsetParent?.getBoundingClientRect?.();
        const maxR = Math.min(vw > 0 ? vw : Infinity, pRect?.right > 0 ? pRect.right : Infinity) - 8, r = popup.getBoundingClientRect?.();
        if (Number.isFinite(maxR) && r && r.width > 0 && popup.style) {
          const curL = parseFloat(popup.style.left);
          if (r.right > maxR + 0.5 && !Number.isNaN(curL)) {
            const nextL = Math.max(8, Math.round(curL - (r.right - maxR)));
            if (Math.abs(nextL - curL) >= 1) popup.style.left = nextL + 'px';
          } else if (r.left < 7.5 && !Number.isNaN(curL)) {
            const nextL = Math.round(curL + (8 - r.left));
            if (Math.abs(nextL - curL) >= 1) popup.style.left = nextL + 'px';
          }
        }
      }
      if (typeof MutationObserver === 'function' && document.documentElement) new MutationObserver(ensureAskButton).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
      function triggerJetboxQuote(ctx, askAgent = false) {
        if (!ctx?.selectionText?.trim()) return false;
        const copied = copyScopePayload(buildScopePayload(ctx.termId, ctx.termTitle, ctx.selectionText));
        releaseQuoteHold(false); try { ctx.xterm?.clearSelection?.(); ctx.dismissPopup?.(); } catch {}
        postToParent('hangar-jetbox-quote-clicked', { terminalId: ctx.termId, title: ctx.termTitle, selectionContent: ctx.selectionText, copied, askAgent: Boolean(askAgent) });
        return true;
      }
      const saveQuoteFile = (ctx) => { if (ctx?.selectionText?.trim()) try { sidecarFetch()('/api/terminal/ls-rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'WriteQuoteFile', conversationId: cascadeId, terminalId: ctx.termId || terminalId, name: ctx.termTitle || currentTermTitle || 'terminal', selectionContent: ctx.selectionText }) }).catch(() => {}); } catch {} };
      ['pointerdown', 'focusin'].forEach((ev) => window.addEventListener(ev, (e) => { if (getPopupBtn(e.target)) { e.stopPropagation(); return; } postToParent('hangar-jetbox-pane-focused', { terminalId }); }, true));
      window.addEventListener('mousedown', (e) => {
        ensureAskButton(); const btn = getPopupBtn(e.target); if (!btn) { if (isHoldingQuoteBtn && !isDraggingQuote) releaseQuoteHold(false); return; }
        cachedQuoteCtx = findTerminalContext(btn); saveQuoteFile(cachedQuoteCtx); e.stopPropagation();
        if (btn.getAttribute?.('data-hangar-ask') === 'true') { e.preventDefault(); return; }
        btn.draggable = true; btn.setAttribute?.('draggable', 'true'); isHoldingQuoteBtn = true; isDraggingQuote = false;
        const xt = cachedQuoteCtx?.xterm, lockedTxt = cachedQuoteCtx?.selectionText || '';
        if (xt && lockedTxt && !restoreXtermFn) {
          const origClr = xt.clearSelection, origGet = xt.getSelection;
          xt.clearSelection = () => {}; xt.getSelection = () => lockedTxt;
          restoreXtermFn = () => { xt.clearSelection = origClr; xt.getSelection = origGet; };
        }
      }, true);
      window.addEventListener('dragstart', (e) => {
        const btn = getPopupBtn(e.target), ctx = btn && e.dataTransfer ? (cachedQuoteCtx?.selectionText ? cachedQuoteCtx : findTerminalContext(btn)) : null;
        if (!ctx?.selectionText?.trim()) return;
        isDraggingQuote = true; saveQuoteFile(ctx); e.stopPropagation?.();
        const payload = buildScopePayload(ctx.termId, ctx.termTitle, ctx.selectionText);
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('application/context-scope-item', payload.contextScopeJson);
        e.dataTransfer.setData('application/context-scope-item-cider', payload.contextScopeJson);
        e.dataTransfer.setData('application/x-lexical-editor', payload.lexicalJson);
        e.dataTransfer.setData('text/plain', payload.plainText);
      }, true);
      ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => { e.stopPropagation?.(); if ((ev === 'dragenter' || ev === 'dragover') && (isDraggingQuote || Array.from(e.dataTransfer?.types || []).some((t) => String(t).includes('context-scope-item')))) { e.preventDefault?.(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } }, true));
      window.addEventListener('dragend', (e) => {
        const ctx = cachedQuoteCtx, sel = ctx?.selectionText?.trim() || '', tid = ctx?.termId || terminalId, ttl = ctx?.termTitle || currentTermTitle || 'terminal';
        if (sel) {
          copyScopePayload(buildScopePayload(tid, ttl, sel));
          const cx = Number(e?.clientX) || 0, cy = Number(e?.clientY) || 0, vw = Number(window.innerWidth) || 0, vh = Number(window.innerHeight) || 0;
          const outside = (cx < 0 || cy < 0 || (vw > 0 && cx > vw) || (vh > 0 && cy > vh)) && !(cx === 0 && cy === 0);
          postToParent('hangar-jetbox-quote-dragend', { terminalId: tid, title: ttl, selectionContent: sel, clientX: cx, clientY: cy, outsideFrame: outside, dropEffect: e?.dataTransfer?.dropEffect || 'none' });
          if (outside && (cx < 0 || !window.parent || window.parent === window)) {
            try { sidecarFetch()('/api/terminal/ls-rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'InjectQuoteDrop', conversationId: cascadeId, terminalId: tid, name: ttl, selectionContent: sel }) }).catch(() => {}); } catch {}
          }
        }
        isDraggingQuote = false; releaseQuoteHold(true);
      }, true);
      window.addEventListener('click', (e) => {
        if (mode === 'chat' && e.target?.closest?.('div[title="Open side-by-side view"]')) { e.preventDefault(); e.stopPropagation(); return; }
        const btn = getPopupBtn(e.target);
        if (btn) { e.preventDefault(); e.stopPropagation(); const isAsk = btn.getAttribute?.('data-hangar-ask') === 'true' || btn.dataset?.hangarAsk === 'true'; triggerJetboxQuote(cachedQuoteCtx?.selectionText ? cachedQuoteCtx : findTerminalContext(btn), isAsk); cachedQuoteCtx = null; }
      }, true);
      window.addEventListener('keydown', (e) => {
        const isQuoteKey = ((e.altKey && !e.ctrlKey && !e.metaKey) || ((e.metaKey || e.ctrlKey) && !e.altKey)) && !e.shiftKey && e.key?.toLowerCase?.() === 'l';
        const ctx = isQuoteKey ? findTerminalContext(e.target) : null;
        if (ctx?.selectionText?.trim()) { e.preventDefault(); e.stopPropagation(); triggerJetboxQuote(ctx, false); }
      }, true);
      const syncSelection = (e) => {
        if (e?.type === 'mouseup' && getPopupBtn(e.target)) e.stopPropagation();
        if (e?.type === 'mouseup' && isHoldingQuoteBtn && !isDraggingQuote) setTimeout(() => { if (!isDraggingQuote) releaseQuoteHold(false); }, 0);
        if (isHoldingQuoteBtn || isDraggingQuote) return;
        setTimeout(() => {
          if (isHoldingQuoteBtn || isDraggingQuote) return; ensureAskButton(); setTimeout(ensureAskButton, 35);
          const ctx = findTerminalContext(e?.target); if (ctx.selectionText?.trim()) { cachedQuoteCtx = ctx; saveQuoteFile(ctx); }
          if (ctx.selectionText !== lastReportedSel) { lastReportedSel = ctx.selectionText; postToParent('hangar-jetbox-selection-changed', { terminalId: ctx.termId, title: ctx.termTitle, selectionContent: ctx.selectionText }); }
        }, 15);
      };
      ['mouseup', 'keyup', 'blur', 'mouseleave'].forEach((ev) => window.addEventListener(ev, syncSelection, true));
    })();
  </script>
  <link rel="stylesheet" href="/jetbox.css${q}" /><link rel="stylesheet" href="/compiled_tailwind.css${q}" />
  <style>${styleBlock}</style>
</head>
<body><div id="root"></div><script src="/prism_bundle.js${q}"></script><script src="/jetbox-main.js${q}"></script></body>
</html>`;
}

export const buildJetboxTerminalHtml = (opts = {}) => buildJetboxHtml({ ...opts, mode: 'terminal' });
export const buildJetboxChatHtml = (opts = {}) => buildJetboxHtml({ ...opts, mode: 'chat' });

const ALLOWED_JETBOX_RPCS = new Set([
  'ListTerminals', 'CreateTerminal', 'SendTerminalInput', 'CloseTerminal', 'RenameTerminal',
  'GetUserStatus', 'GetAllCascadeTrajectories', 'GetCascadeTrajectory', 'GetCascadeTrajectorySteps',
  'GetCascadeTrajectoryGeneratorMetadata', 'GetTrajectoryTurns', 'GetTurnDiff', 'GetTrajectoryFileDiffs',
  'GetCodeActionDiff', 'GetChapterTitles', 'GetCodeValidationStates', 'RequestAgentStatePageUpdate',
  'StartCascade', 'SendUserCascadeMessage', 'SendAllQueuedMessages', 'DeleteQueuedUserInputStep',
  'CancelCascadeInvocation', 'CancelCascadeSteps', 'ForceStopCascadeTree', 'HandleCascadeUserInteraction',
  'RegisterInteraction', 'RevertToCascadeStep', 'GetRevertPreview', 'DeleteCascadeTrajectory',
  'ForkConversation', 'UpdateConversationAnnotations', 'GetCascadeModelConfigs', 'GetCascadeModelConfigData',
  'GetCommandModelConfigs', 'GetSlashCommands', 'GetAllWorkflows', 'GetAllRules', 'GetAllSkills',
  'GetCustomizationStates', 'GetAgentScripts', 'GetAllCustomAgentConfigs', 'ListContextProviders',
  'SearchContext', 'ResolveContextUri', 'SearchFiles', 'SearchConversations', 'StatUri', 'ReadFile',
  'ReadDir', 'ResolveFolder', 'GetRepoInfos', 'ListProjects', 'ReadProject', 'ReadProjects',
  'GetContribVariants', 'WarmUpEnvironment', 'SaveMediaAsArtifact', 'DeleteMediaArtifact',
  'GetWorkspaceInfos', 'GetAllPlugins', 'GetMcpServerStates', 'JetboxReadState', 'GetLocalUserInfo',
  'GetServerConfiguration', 'GetMendelFlags', 'HasAuthToken', 'GetAuthStatus', 'GetUpdateStatus',
  'GetVersionControlFileContent', 'GetCommitDetails', 'GetBattleWorktreeDiff', 'GetHover',
]);
const NOOP_JETBOX_RPCS = new Set(['JetboxWriteState', 'ManageSidecar', 'RecordError', 'RecordAnalyticsEvent', 'LogObservabilityData', 'ReportFeedbackMetadata']);

export function registerJetboxProxyRoutes(app, { ResponseClass = DefaultResponse, onTerminalInput } = {}) {
  for (const [p, u, c] of [
    ['/jetbox.css', '/jetbox.css', 'text/css; charset=utf-8'],
    ['/compiled_tailwind.css', '/compiled_tailwind.css', 'text/css; charset=utf-8'],
    ['/prism_bundle.js', '/prism_bundle.js', 'text/javascript; charset=utf-8'],
    ['/audio_processor.js', '/audio_processor.js', 'text/javascript; charset=utf-8'],
    ['/diff_worker.js', '/diff_worker.js', 'text/javascript; charset=utf-8'],
    ['/workers/pdfjs_loader.mjs', '/workers/pdfjs_loader.mjs', 'text/javascript; charset=utf-8'],
    ['/workers/pdf.worker.mjs', '/workers/pdf.worker.mjs', 'text/javascript; charset=utf-8'],
    ['/jetbox-main.js', '/main.js', 'text/javascript; charset=utf-8'],
  ]) app.page(p, () => fetchLsAsset(u, c, ResponseClass));
  const guardJson = (fn) => async (data, ctx) => {
    const auth = checkJetboxAuth(data, ctx, { requireToken: true });
    if (!auth.ok) return new ResponseClass(JSON.stringify({ ok: false, error: auth.error }), { status: auth.status, contentType: 'application/json; charset=utf-8' });
    return fn(data, ctx);
  };
  app.api('/jetbox-terminal', async (data, ctx) => {
    const auth = checkJetboxAuth(data, ctx, { requireToken: true });
    if (!auth.ok) return new ResponseClass(auth.error, { status: auth.status, contentType: 'text/plain; charset=utf-8', headers: { 'Cache-Control': 'no-store' } });
    return new ResponseClass(buildJetboxTerminalHtml({ cascadeId: data?.cascadeId, terminalId: data?.terminalId, hostTheme: data?.hostTheme, uiToken: auth.uiToken }), { contentType: 'text/html; charset=utf-8', headers: { 'Cache-Control': 'no-store' } });
  }, 'GET');
  app.api('/jetbox-chat', async (data, ctx) => {
    const auth = checkJetboxAuth(data, ctx, { requireToken: true });
    if (!auth.ok) return new ResponseClass(auth.error, { status: auth.status, contentType: 'text/plain; charset=utf-8', headers: { 'Cache-Control': 'no-store' } });
    return new ResponseClass(buildJetboxChatHtml({ cascadeId: data?.cascadeId, hostTheme: data?.hostTheme, uiToken: auth.uiToken }), { contentType: 'text/html; charset=utf-8', headers: { 'Cache-Control': 'no-store' } });
  }, 'GET');
  app.api('/api/terminal/sidechat/start', guardJson((data) => startTerminalSideChat(data || {})), 'POST');
  app.api('/api/terminal/sidechat/delete', guardJson((data) => deleteTerminalSideChat(data || {})), 'POST');
  app.api('/api/terminal/chat-poll', guardJson((data) => pollChatStream(data || {})), 'POST');
  app.api('/api/terminal/ls-rpc', guardJson(async (data) => {
    const method = String(data?.method || '').trim();
    if (!/^[A-Za-z0-9_]+$/.test(method)) throw new Error(`Disallowed Jetbox RPC method: ${method}`);
    if (method === 'WriteQuoteFile') {
      const uri = writeQuoteFile(data?.name, data?.selectionContent);
      syncQuoteWithHostWindow({ conversationId: data?.conversationId || data?.targetConversationId, terminalId: data?.terminalId || data?.targetTerminalId, name: data?.name, selectionContent: data?.selectionContent, action: 'stage' }).catch(() => {});
      return { uri };
    }
    if (method === 'InjectQuoteDrop') return syncQuoteWithHostWindow({ conversationId: data?.conversationId || data?.targetConversationId, terminalId: data?.terminalId || data?.targetTerminalId, name: data?.name || data?.title, selectionContent: data?.selectionContent, action: 'drop' });
    if (method === 'GetSidecars') return { sidecars: [] };
    if (method === 'HasAuthToken') return { hasToken: true };
    if (method === 'JetboxReadState') return { appState: { agentOnboardingCompleted: 2 }, userConfig: { userSettings: { themeMode: 1 } } };
    if (NOOP_JETBOX_RPCS.has(method) || (!ALLOWED_JETBOX_RPCS.has(method) && /^(Get|List|Fetch|Check|Has|Read|Resolve|Find|Query|Load)/.test(method))) return {};
    if (!ALLOWED_JETBOX_RPCS.has(method)) throw new Error(`Disallowed Jetbox RPC method: ${method}`);
    const reqBody = data?.body && typeof data.body === 'object' ? data.body : {};
    if (method === 'ListTerminals') {
      const targetTid = String(data?.targetTerminalId || '').trim(), targetCid = String(data?.targetConversationId || reqBody.conversationId || '').trim();
      if (!targetTid && !targetCid) return callLsRpc('ListTerminals', reqBody);
      const raw = await callLsRpc('ListTerminals', {}), list = Array.isArray(raw?.terminals) ? raw.terminals : [];
      const ids = targetTid ? targetTid.split(',').map((s) => s.trim()).filter(Boolean) : [];
      const byTid = ids.length ? list.filter((t) => ids.includes(t?.terminalId)) : [];
      const matched = ids.length ? (byTid.length ? byTid : list.filter((t) => ids.includes(t?.splitGroupId))) : list.filter((t) => !targetCid || !t?.conversationId || t.conversationId === targetCid || t.conversationId === `hangar:${targetCid}`);
      const forcedSg = ids.length >= 2 && matched.length >= 2 ? (ids[0] || matched[0]?.splitGroupId || matched[0]?.terminalId) : undefined;
      return { terminals: matched.map(({ splitGroupId, ...t }) => ({ ...t, conversationId: targetCid || t.conversationId || '', projectId: '', ...(forcedSg ? { splitGroupId: forcedSg } : (!ids.length && splitGroupId ? { splitGroupId } : {})), workspaceUri: '' })) };
    }
    if (method === 'CreateTerminal') {
      const sanitized = { ...reqBody }; if (sanitized.workspaceUri && !sanitized.projectId) sanitized.projectId = sanitized.workspaceUri; delete sanitized.workspaceUri;
      const cid = String(sanitized.conversationId || '').trim() || '_new';
      sanitized.conversationId = cid.startsWith('hangar:') ? cid : `hangar:${cid}`;
      return callLsRpc('CreateTerminal', sanitized);
    }
    if (method === 'SendTerminalInput' && reqBody.resize && ((Number(reqBody.resize.cols) || 0) < 10 || (Number(reqBody.resize.rows) || 0) < 3)) return {};
    if (method === 'SendTerminalInput' && reqBody.input) { try { onTerminalInput?.(reqBody.terminalId || data?.targetTerminalId || '', Buffer.from(String(reqBody.input), 'base64').toString('utf8')); } catch {} }
    const isStrictRpc = method.includes('Terminal') || /^(StartCascade|SendUserCascadeMessage|HandleCascadeUserInteraction|CancelCascadeInvocation|DeleteCascadeTrajectory)$/.test(method);
    return isStrictRpc ? callLsRpc(method, reqBody) : callLsRpc(method, reqBody).catch(() => ({}));
  }), 'POST');
}
