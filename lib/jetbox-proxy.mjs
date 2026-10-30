/**
 * @fileoverview Proxies Antigravity's native jetbox_web bundle in Aux-Pane-Only
 * terminal mode, isolating GetSidecars and routing gRPC-Web RPCs + StreamTerminalOutput.
 */
import { callLsRpc, getLsConfig } from 'antigravity-sidecar-kit/rpc';

class DefaultResponse {
  constructor(body, { contentType = 'text/plain', status = 200, headers } = {}) {
    this.body = body; this.contentType = contentType; this.status = status; this.headers = headers;
  }
}
const assetCache = new Map();

async function fetchLsAsset(pathname, contentType, ResponseClass = DefaultResponse) {
  const { lsAddress: lsAddr } = getLsConfig();
  if (!lsAddr) return new ResponseClass('Missing ANTIGRAVITY_LS_ADDRESS', { status: 503, contentType: 'text/plain' });
  const cacheKey = `${lsAddr}:${pathname}`;
  if (assetCache.has(cacheKey)) return new ResponseClass(assetCache.get(cacheKey), { status: 200, contentType });
  const upstream = await fetch(`http://${lsAddr}${pathname}`);
  if (!upstream.ok) return new ResponseClass(`Upstream ${pathname} returned ${upstream.status}`, { status: upstream.status, contentType: 'text/plain' });
  const buf = Buffer.from(await upstream.arrayBuffer());
  assetCache.set(cacheKey, buf);
  return new ResponseClass(buf, { status: 200, contentType });
}

export function buildJetboxTerminalHtml({
  cascadeId = '', terminalId = '', hostTheme = 'dark',
  csrfToken = getLsConfig().csrfToken || '', uiToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '',
} = {}) {
  const safeTheme = hostTheme === 'light' ? 'light' : 'dark', q = uiToken ? `?token=${encodeURIComponent(uiToken)}` : '';
  const bootConfig = JSON.stringify({ productName: 'antigravity', csrfToken, appVersion: '2.28.0', releaseChannel: 'stable', devMode: true });
  const bootParams = JSON.stringify({ cascadeId: String(cascadeId || ''), terminalId: String(terminalId || '') });
  return `<!doctype html>
<html lang="en" style="color-scheme: ${safeTheme};">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Antigravity Native Terminal</title>
  <script src="/preload.js${q}"></script>
  <script>
    window.__APP_CONFIG__ = ${bootConfig};
    window.process = window.process || { env: { NODE_ENV: 'production' } };
    if (!window.process.platform) { const ua = navigator.userAgent || ''; window.process.platform = ua.includes('Windows') ? 'win32' : ua.includes('Mac') ? 'darwin' : 'linux'; }
    (() => {
      const { cascadeId, terminalId } = ${bootParams};
      const effectiveCascadeId = (cascadeId && cascadeId !== '_new') ? cascadeId : (terminalId || 'hangar-terminal'), tabId = terminalId ? 'terminal__' + terminalId : 'terminal';
      try {
        const v1Pane = { isPaneOpen: true, activeTabId: 'terminal', tabs: [], persistentTabState: { terminal: { conversationId: effectiveCascadeId, activeTerminalUuid: terminalId } } };
        localStorage.setItem('aux-pane-session', JSON.stringify({ conversationPanes: { [effectiveCascadeId]: v1Pane }, newConversationPanes: {}, homePane: v1Pane, conversationScopeProviders: { [effectiveCascadeId]: ['terminal'] } }));
        localStorage.setItem('aux-pane-v2-session', JSON.stringify({ version: 1, conversationPanes: { [effectiveCascadeId]: { tabs: [], activeTabId: tabId } }, newConversationPanes: {} }));
      } catch {}
      try { history.replaceState(null, '', '/c/' + encodeURIComponent(effectiveCascadeId) + '?tab=' + encodeURIComponent(tabId) + '&hostTheme=${safeTheme}&defaultThemeMode=${safeTheme}'); } catch {}
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
      window.addEventListener('message', (e) => {
        if (e.data?.type === 'theme-change' && e.data?.payload?.cssVariables) { savedThemeVars = e.data.payload.cssVariables; applySavedTheme(); }
        else if (e.data?.type === 'hangar-clear-selection') { const ctx = findTerminalContext(); try { ctx.xterm?.clearSelection?.(); ctx.dismissPopup?.(); } catch {} }
      });
      const postToParent = (type, payload) => { if (window.parent && window.parent !== window) window.parent.postMessage({ type, payload }, '*'); };
      const nativeFetch = window.fetch.bind(window), sidecarFetch = () => window.sidecar?.fetch || nativeFetch;
      const LS_PREFIX = '/exa.language_server_pb.LanguageServerService/', GRPC_WEB_HEADERS = { 'Content-Type': 'application/grpc-web+json' };
      const STATE_STUB = { appState: { agentOnboardingCompleted: 2 }, userConfig: { userSettings: { themeMode: '${safeTheme}' === 'light' ? 2 : 1 } } };

      function encodeConnectFrame(obj, flags = 0) {
        const bytes = new TextEncoder().encode(typeof obj === 'string' ? obj : JSON.stringify(obj ?? {})), frame = new Uint8Array(5 + bytes.length);
        frame[0] = flags & 0xff; new DataView(frame.buffer).setUint32(1, bytes.length, false); frame.set(bytes, 5); return frame;
      }
      const encodeGrpcTrailer = (status = 0) => encodeConnectFrame('grpc-status: ' + status + '\\r\\n', 0x80);
      function makeGrpcUnaryResponse(obj) {
        const data = encodeConnectFrame(obj, 0), trailer = encodeGrpcTrailer(0), out = new Uint8Array(data.length + trailer.length);
        out.set(data, 0); out.set(trailer, data.length);
        return new window.Response(out, { status: 200, headers: GRPC_WEB_HEADERS });
      }
      const makeGrpcStreamResponse = (initialFrames = []) => new window.Response(new ReadableStream({
        start(controller) { for (const f of initialFrames) controller.enqueue(encodeConnectFrame(f, 0)); },
      }), { status: 200, headers: GRPC_WEB_HEADERS });
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
              await new Promise((r) => setTimeout(r, 45));
            }
          },
          cancel() { cancelled = true; },
        });
      }

      window.fetch = async function patchedFetch(input, init = {}) {
        const rawUrl = typeof input === 'string' ? input : input?.url || '';
        let pathname = rawUrl;
        try { pathname = new URL(rawUrl, window.location.origin).pathname; } catch {}
        if (pathname.startsWith(LS_PREFIX)) {
          const method = pathname.slice(LS_PREFIX.length);
          if (method === 'GetSidecars') return makeGrpcUnaryResponse({ sidecars: [] });
          if (method === 'SubscribeToSidecars') return makeGrpcStreamResponse([{ sidecars: [] }]);
          if (method === 'JetboxReadState') { setTimeout(applySavedTheme, 50); return makeGrpcUnaryResponse(STATE_STUB); }
          if (method === 'JetboxSubscribeToState') return makeGrpcStreamResponse([STATE_STUB]);
          if (method === 'StreamTerminalOutput') {
            const reqObj = decodeConnectRequest(init.body);
            return new window.Response(createTerminalConnectStream(reqObj.terminalId || terminalId), { status: 200, headers: GRPC_WEB_HEADERS });
          }
          if (method.startsWith('Stream') || method.startsWith('Subscribe') || method.startsWith('JetboxSubscribe') || method.startsWith('Watch') || method.endsWith('Stream')) return makeGrpcStreamResponse([]);
          const rpcRes = await sidecarFetch()('/api/terminal/ls-rpc', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method, body: decodeConnectRequest(init.body), targetTerminalId: terminalId, targetConversationId: effectiveCascadeId }),
          });
          return makeGrpcUnaryResponse(await rpcRes.json().catch(() => ({})));
        }
        return nativeFetch(input, init);
      };

      function buildScopePayload(tid, title, selectionContent) {
        const cleanName = String(title || currentTermTitle || 'terminal').replace(/[\\[\\]()\\r\\n]+/g, ' ').replace(/\\s+/g, ' ').trim() || 'terminal';
        const termObj = { processId: String(tid || terminalId || ''), name: cleanName, ...(selectionContent ? { selectionContent: String(selectionContent) } : {}) };
        const contextScopeJson = JSON.stringify({ terminal: termObj });
        const lexicalJson = JSON.stringify({ namespace: 'chat-editor', nodes: [
          { trigger: '@', value: 'contextScopeItemMention', data: { data: contextScopeJson }, type: 'contextScopeItemMention', version: 1 },
          { detail: 0, format: 0, mode: 'normal', style: '', text: ' ', type: 'text', version: 1 },
        ] });
        return { cleanName, contextScopeJson, lexicalJson, plainText: '[' + cleanName + '](terminal;' + termObj.processId + ') ' };
      }

      function copyScopePayload(payload) {
        let ok = false, probe = null;
        const onCopy = (e) => {
          if (!e.clipboardData) return;
          e.preventDefault(); e.stopPropagation();
          e.clipboardData.setData('text/plain', payload.plainText);
          e.clipboardData.setData('application/x-lexical-editor', payload.lexicalJson);
          e.clipboardData.setData('application/context-scope-item-cider', payload.contextScopeJson);
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
        return { selectionText: selectionText || xterm?.getSelection?.() || window.getSelection?.()?.toString?.() || '', termId, termTitle, xterm, dismissPopup };
      }

      let cachedQuoteCtx = null, lastReportedSel = '';
      function triggerJetboxQuote(ctx) {
        if (!ctx?.selectionText?.trim()) return false;
        const copied = copyScopePayload(buildScopePayload(ctx.termId, ctx.termTitle, ctx.selectionText));
        try { ctx.xterm?.clearSelection?.(); ctx.dismissPopup?.(); } catch {}
        postToParent('hangar-jetbox-quote-clicked', { terminalId: ctx.termId, title: ctx.termTitle, selectionContent: ctx.selectionText, copied });
        return true;
      }

      const notifyFocus = () => postToParent('hangar-jetbox-pane-focused', { terminalId });
      ['pointerdown', 'focusin'].forEach((ev) => window.addEventListener(ev, notifyFocus, true));
      window.addEventListener('mousedown', (e) => {
        const btn = e.target?.closest?.('.selection-popup button');
        if (btn) { cachedQuoteCtx = findTerminalContext(btn); btn.setAttribute('draggable', 'true'); e.stopPropagation(); }
      }, true);
      window.addEventListener('dragstart', (e) => {
        const btn = e.target?.closest?.('.selection-popup button');
        const ctx = btn && e.dataTransfer ? (cachedQuoteCtx?.selectionText ? cachedQuoteCtx : findTerminalContext(btn)) : null;
        if (!ctx?.selectionText?.trim()) return;
        const payload = buildScopePayload(ctx.termId, ctx.termTitle, ctx.selectionText);
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('application/context-scope-item-cider', payload.contextScopeJson);
        e.dataTransfer.setData('application/x-lexical-editor', payload.lexicalJson);
        e.dataTransfer.setData('text/plain', payload.plainText);
      }, true);
      window.addEventListener('dragend', () => { if (cachedQuoteCtx) { try { cachedQuoteCtx.xterm?.clearSelection?.(); cachedQuoteCtx.dismissPopup?.(); } catch {} cachedQuoteCtx = null; } }, true);
      window.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('.selection-popup button');
        if (btn) { e.preventDefault(); e.stopPropagation(); triggerJetboxQuote(cachedQuoteCtx?.selectionText ? cachedQuoteCtx : findTerminalContext(btn)); cachedQuoteCtx = null; }
      }, true);
      window.addEventListener('keydown', (e) => {
        const isQuoteKey = ((e.altKey && !e.ctrlKey && !e.metaKey) || ((e.metaKey || e.ctrlKey) && !e.altKey)) && !e.shiftKey && e.key?.toLowerCase?.() === 'l';
        const ctx = isQuoteKey ? findTerminalContext(e.target) : null;
        if (ctx?.selectionText?.trim()) { e.preventDefault(); e.stopPropagation(); triggerJetboxQuote(ctx); }
      }, true);
      const syncSelection = (e) => setTimeout(() => {
        const ctx = findTerminalContext(e?.target);
        if (ctx.selectionText !== lastReportedSel) { lastReportedSel = ctx.selectionText; postToParent('hangar-jetbox-selection-changed', { terminalId: ctx.termId, title: ctx.termTitle, selectionContent: ctx.selectionText }); }
      }, 15);
      ['mouseup', 'keyup', 'blur', 'mouseleave'].forEach((ev) => window.addEventListener(ev, syncSelection, true));
    })();
  </script>
  <link rel="stylesheet" href="/jetbox.css${q}" /><link rel="stylesheet" href="/compiled_tailwind.css${q}" />
  <style>
    html, body, #root { height: 100%; width: 100%; margin: 0; overflow: hidden; background: var(--background, #101010); }
    #root > * { visibility: hidden; }
    [data-testid="terminal-tab-connecting"], [data-testid="terminal-tab-surface"], [data-testid="terminal-split-container"] {
      visibility: visible !important; position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 99999 !important; background: var(--background, #101010) !important;
    }
    [data-testid="terminal-tab-connecting"] *, [data-testid="terminal-tab-surface"] *, [data-testid="terminal-split-container"] *, .selection-popup, .selection-popup * { visibility: visible !important; }
    [data-testid="terminal-active"]:has(.xterm) > .pointer-events-none { display: none !important; }
  </style>
</head>
<body><div id="root"></div><script defer src="/prism_bundle.js${q}"></script><script src="/jetbox-main.js${q}"></script></body>
</html>`;
}

const ALLOWED_JETBOX_RPCS = new Set(['ListTerminals', 'CreateTerminal', 'SendTerminalInput', 'CloseTerminal', 'RenameTerminal', 'GetUserStatus', 'GetAllCascadeTrajectories', 'GetCascadeTrajectory', 'GetWorkspaceInfos', 'GetAllPlugins', 'GetMcpServerStates', 'JetboxReadState', 'GetLocalUserInfo', 'GetServerConfiguration', 'GetMendelFlags', 'HasAuthToken', 'GetAuthStatus', 'GetUpdateStatus']);
const NOOP_JETBOX_RPCS = new Set(['JetboxWriteState', 'ManageSidecar', 'RecordError', 'RecordAnalyticsEvent', 'LogObservabilityData', 'ReportFeedbackMetadata']);

export function registerJetboxProxyRoutes(app, { ResponseClass = DefaultResponse } = {}) {
  app.page('/jetbox.css', () => fetchLsAsset('/jetbox.css', 'text/css; charset=utf-8', ResponseClass));
  app.page('/compiled_tailwind.css', () => fetchLsAsset('/compiled_tailwind.css', 'text/css; charset=utf-8', ResponseClass));
  app.page('/prism_bundle.js', () => fetchLsAsset('/prism_bundle.js', 'text/javascript; charset=utf-8', ResponseClass));
  app.page('/audio_processor.js', () => fetchLsAsset('/audio_processor.js', 'text/javascript; charset=utf-8', ResponseClass));
  app.page('/jetbox-main.js', () => fetchLsAsset('/main.js', 'text/javascript; charset=utf-8', ResponseClass));
  app.api('/jetbox-terminal', async (data) => new ResponseClass(buildJetboxTerminalHtml({ cascadeId: data?.cascadeId, terminalId: data?.terminalId, hostTheme: data?.hostTheme, uiToken: data?.token || process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '' }), { contentType: 'text/html; charset=utf-8', headers: { 'Cache-Control': 'no-store' } }), 'GET');
  app.api('/api/terminal/ls-rpc', async (data) => {
    const method = String(data?.method || '').trim();
    if (method === 'GetSidecars') return { sidecars: [] };
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
      const matched = ids.length ? (byTid.length ? byTid : list.filter((t) => ids.includes(t?.splitGroupId))) : list.filter((t) => !targetCid || !t?.conversationId || t.conversationId === targetCid);
      const forcedSg = ids.length >= 2 && matched.length >= 2 ? (ids[0] || matched[0]?.splitGroupId || matched[0]?.terminalId) : undefined;
      return { terminals: matched.map(({ splitGroupId, ...t }) => ({ ...t, conversationId: targetCid || t.conversationId || '', projectId: '', ...(forcedSg ? { splitGroupId: forcedSg } : (!ids.length && splitGroupId ? { splitGroupId } : {})), workspaceUri: '' })) };
    }
    if (method.includes('Terminal')) return callLsRpc(method, reqBody);
    return callLsRpc(method, reqBody).catch(() => ({}));
  }, 'POST');
}
