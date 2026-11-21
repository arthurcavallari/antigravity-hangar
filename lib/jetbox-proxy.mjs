/** @fileoverview Proxies Antigravity's native jetbox_web bundle in Aux-Pane-Only terminal mode and Side Question conversation mode. */
import { readFileSync } from 'node:fs';
import { APP_STORAGE_PATH, CONFIG_JSON_PATH, readJsonSafe } from 'antigravity-sidecar-kit/config';
import { getLsConfig } from 'antigravity-sidecar-kit/rpc';
import { getCurrentRequestContext, isLoopbackOrigin, verifySidecarToken } from 'antigravity-sidecar-kit/state-sync';
import { fetchMergedCascadeTrajectories, hangarRpc, readJetboxStateSnapshot } from './ls-rpc.mjs';
import { awaitAudioPoll, evictStaleAudioStreams } from './jetbox-audio.mjs';
import {
  awaitChatPoll,
  closeTerminalSideChatStreams,
  deleteTerminalSideChat,
  evictStaleChatStreams,
  pollChatStream,
  promoteTerminalSideChat,
  renameTerminalSideChat,
  startTerminalSideChat,
} from './jetbox-sidechat.mjs';
import { awaitVcsPoll, evictStaleVcsStreams } from './jetbox-vcs.mjs';
import { ALLOWED_JETBOX_RPCS, JETBOX_STATIC_ASSETS, NOOP_JETBOX_RPCS, QUOTE_DIR_URI, isStrictJetboxRpc, parseJetboxCookieToken, proxyStaticArtifact, syncQuoteWithHostWindow, writeQuoteFile } from './jetbox-rpc-policy.mjs';
import {
  getTerminalHiddenScheme,
  markHangarTerminalId,
  recordTerminalHiddenScheme,
  withHangarWorkspaceUris,
  withSharedWorkspaceUris,
} from './terminal-uris.mjs';

export {
  closeTerminalSideChatStreams,
  deleteTerminalSideChat,
  evictStaleChatStreams,
  pollChatStream,
  promoteTerminalSideChat,
  renameTerminalSideChat,
  startTerminalSideChat,
  syncQuoteWithHostWindow,
  writeQuoteFile,
};

const PLUGIN_ORIGIN_RE = /^plugin:\/\/[a-z0-9][a-z0-9._-]*-\d+\/?$/i;
function parseUrlToken(rawUrl) {
  if (!rawUrl) return '';
  try {
    return new URL(rawUrl, 'http://127.0.0.1').searchParams.get('token') || '';
  } catch {
    return '';
  }
}

export function checkJetboxAuth(data, rawCtx = {}, { requireToken = true } = {}) {
  const ctx = (rawCtx && (rawCtx.req || rawCtx.headers || rawCtx.query || rawCtx.origin !== undefined)) ? rawCtx : (getCurrentRequestContext?.() || rawCtx || {});
  const req = ctx?.req || (ctx?.headers ? ctx : data?.headers ? data : null);
  const headers = req?.headers || ctx?.headers || data?.headers || null;
  if (headers?.['sec-fetch-site'] === 'cross-site') {
    return { ok: false, status: 403, error: 'Forbidden cross-site request' };
  }
  const origin = headers?.origin ?? ctx?.origin ?? data?.origin;
  if (origin !== undefined && !isLoopbackOrigin(origin) && !PLUGIN_ORIGIN_RE.test(String(origin))) {
    return { ok: false, status: 403, error: 'Forbidden origin' };
  }
  const expectedToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
  if (expectedToken && (requireToken || headers || data?.token !== undefined || ctx?.query)) {
    const rawHeaderTok = headers?.['x-sidecar-token'] ?? headers?.['X-Sidecar-Token'];
    const headerTok = Array.isArray(rawHeaderTok) ? rawHeaderTok[0] : (rawHeaderTok || '');
    const refererTok = parseUrlToken(headers?.referer);
    const cookieTok = parseJetboxCookieToken(headers?.cookie);
    const urlTok = ctx?.query?.token ?? ctx?.query?.get?.('token') ?? data?.token ?? parseUrlToken(req?.url);
    if (!verifySidecarToken(String(headerTok || urlTok || refererTok || cookieTok || ''), expectedToken)) {
      return { ok: false, status: 401, error: 'Unauthorized' };
    }
  }
  return { ok: true, status: 200, uiToken: expectedToken || String(data?.token || '') };
}

export function createJetboxJsonGuard(ResponseClass) {
  return (fn) => async (data, ctx) => {
    const auth = checkJetboxAuth(data, ctx, { requireToken: true });
    if (!auth.ok) {
      const payload = { ok: false, error: auth.error, status: auth.status };
      return ResponseClass
        ? new ResponseClass(JSON.stringify(payload), { status: auth.status, contentType: 'application/json; charset=utf-8' })
        : payload;
    }
    return fn(data, ctx);
  };
}

class DefaultResponse {
  constructor(body, { contentType = 'text/plain', status = 200, headers } = {}) {
    this.body = body;
    this.contentType = contentType;
    this.status = status;
    this.headers = headers;
  }
}
export const MAX_ASSET_CACHE_ENTRIES = 128;
const SYMBOL_ICON_RE = /^\/symbols-icons\/icons\/(?:files|folders)\/[A-Za-z0-9._-]+\.svg$/;
const assetCache = new Map();

async function fetchLsAsset(pathname, contentType, ResponseClass = DefaultResponse, fetchFn = globalThis.fetch) {
  const { lsAddress: lsAddr } = getLsConfig();
  if (!lsAddr) return new ResponseClass('Missing ANTIGRAVITY_LS_ADDRESS', { status: 503, contentType: 'text/plain' });
  const cacheKey = `${lsAddr}:${pathname}`;
  if (assetCache.has(cacheKey)) return new ResponseClass(assetCache.get(cacheKey), { status: 200, contentType });
  const upstream = await fetchFn(`http://${lsAddr}${pathname}`);
  if (!upstream.ok) return new ResponseClass(`Upstream ${pathname} returned ${upstream.status}`, { status: upstream.status, contentType: 'text/plain' });
  const buf = Buffer.from(await upstream.arrayBuffer());
  if (assetCache.size >= MAX_ASSET_CACHE_ENTRIES) {
    const oldestKey = assetCache.keys().next().value;
    if (oldestKey !== undefined) assetCache.delete(oldestKey);
  }
  assetCache.set(cacheKey, buf);
  return new ResponseClass(buf, { status: 200, contentType });
}

const JETBOX_SHARED_CSS = readFileSync(new URL('../ui/jetbox/jetbox-shared.css', import.meta.url), 'utf8');
const JETBOX_CHAT_CSS = readFileSync(new URL('../ui/jetbox/jetbox-chat.css', import.meta.url), 'utf8');
const JETBOX_TERMINAL_CSS = readFileSync(new URL('../ui/jetbox/jetbox-terminal.css', import.meta.url), 'utf8');
const JETBOX_BOOTSTRAP_JS = readFileSync(new URL('../ui/jetbox/jetbox-bootstrap.js', import.meta.url), 'utf8');

function safeScriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

const HOST_STORAGE_KEYS = ['jetski.contrast', 'jetski.typeface', 'jetski.fontSize', 'theme-preset-light', 'theme-preset-dark', 'theme-custom-presets', 'editor-colors'];
function readHostJetboxSeed(configPath = CONFIG_JSON_PATH) {
  const storage = readJsonSafe(APP_STORAGE_PATH, {}) || {};
  const hostStorage = {};
  for (const k of HOST_STORAGE_KEYS) {
    if (storage[k] !== undefined && storage[k] !== null) hostStorage[k] = String(storage[k]);
  }
  const cfg = readJsonSafe(configPath, {}) || {};
  const userSettings = cfg?.userSettings && typeof cfg.userSettings === 'object' && !Array.isArray(cfg.userSettings)
    ? { ...cfg.userSettings }
    : {};
  return { hostStorage, userSettings };
}

function buildJetboxHtml({ mode = 'terminal', cascadeId = '', terminalId = '', hostTheme = 'dark', uiToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '', configPath = CONFIG_JSON_PATH } = {}) {
  const isChat = mode === 'chat';
  const safeTheme = hostTheme === 'light' ? 'light' : 'dark';
  const q = uiToken ? `?token=${encodeURIComponent(uiToken)}` : '';
  const { hostStorage, userSettings } = readHostJetboxSeed(configPath);
  const bootConfig = safeScriptJson({ productName: 'antigravity', csrfToken: 'hangar-jetbox-proxy', appVersion: '2.31.2', releaseChannel: 'stable', devMode: false });
  const bootParams = safeScriptJson({ mode: isChat ? 'chat' : 'terminal', cascadeId: String(cascadeId || ''), terminalId: String(terminalId || ''), quoteDirUri: QUOTE_DIR_URI, uiToken: String(uiToken || ''), safeTheme, themeQuery: `hostTheme=${safeTheme}&defaultThemeMode=${safeTheme}`, hostStorage, userSettings });
  const styleBlock = `${JETBOX_SHARED_CSS}\n${isChat ? JETBOX_CHAT_CSS : JETBOX_TERMINAL_CSS}`;
  return `<!doctype html>
<html lang="en" style="color-scheme: ${safeTheme};"><head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${isChat ? 'Antigravity Side Question' : 'Antigravity Native Terminal'}</title>
  <script>
    window.__APP_CONFIG__ = ${bootConfig};
    window.__HANGAR_JETBOX_PARAMS__ = ${bootParams};
${JETBOX_BOOTSTRAP_JS}
  </script>
  <script src="/preload.js${q}"></script>
  <link rel="stylesheet" href="/jetbox.css${q}" /><link rel="stylesheet" href="/compiled_tailwind.css${q}" /><link rel="stylesheet" href="/jetbox-tailwind.css${q}" />
  <style>${styleBlock}</style>
</head><body><div id="root"></div><script src="/prism_bundle.js${q}"></script><script src="/jetbox-main.js${q}"></script></body></html>`;
}

export const buildJetboxTerminalHtml = (opts = {}) => buildJetboxHtml({ ...opts, mode: 'terminal' });
export const buildJetboxChatHtml = (opts = {}) => buildJetboxHtml({ ...opts, mode: 'chat' });

export function registerJetboxProxyRoutes(app, { ResponseClass = DefaultResponse, onTerminalInput, onMutate, getHideHangarTerminals, getHideHangarSideQuestions, rpcFn = hangarRpc, fetchFn = globalThis.fetch, configPath = CONFIG_JSON_PATH } = {}) {
  for (const [p, u, c] of JETBOX_STATIC_ASSETS) app.page(p, () => fetchLsAsset(u, c, ResponseClass, fetchFn));
  const serveSymbolIcon = (pathname = '/symbols-icons/icons/files/document.svg') =>
    SYMBOL_ICON_RE.test(pathname) && !pathname.includes('..')
      ? fetchLsAsset(pathname, 'image/svg+xml; charset=utf-8', ResponseClass, fetchFn)
      : new ResponseClass('Not found', { status: 404, contentType: 'text/plain; charset=utf-8' });
  app.page('/symbols-icons/*', serveSymbolIcon);
  app.page('/static/artifacts/*', (pathname, ctx) => proxyStaticArtifact(pathname, ctx, { checkAuth: checkJetboxAuth, ResponseClass, fetchFn }));
  if (typeof app.run === 'function' && !app._jetboxIconsAttached) {
    app._jetboxIconsAttached = true;
    const origRun = app.run.bind(app);
    app.run = async (...args) => {
      const server = await origRun(...args);
      if (server && typeof server.listeners === 'function' && !server._jetboxIconsAttached) {
        server._jetboxIconsAttached = true;
        const listeners = server.listeners('request');
        server.removeAllListeners('request');
        server.on('request', async (req, res) => {
          const rawUrl = String(req.url || '/');
          let pathname = '';
          try { pathname = new URL(rawUrl, 'http://127.0.0.1').pathname; } catch {}
          if (req.method === 'GET' && rawUrl.startsWith('/static/artifacts/')) {
            try {
              const out = await proxyStaticArtifact(rawUrl, { req }, { checkAuth: checkJetboxAuth, ResponseClass, fetchFn });
              res.writeHead(out.status || 200, { 'Content-Type': out.contentType || 'application/octet-stream', ...out.headers });
              res.end(out.body);
            } catch {
              res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end('Upstream error');
            }
            return;
          }
          if (req.method === 'GET' && SYMBOL_ICON_RE.test(pathname) && !pathname.includes('..')) {
            try {
              const out = await serveSymbolIcon(pathname);
              res.writeHead(out.status || 200, { 'Content-Type': out.contentType || 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400', ...out.headers });
              res.end(out.body);
            } catch {
              res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end('Upstream error');
            }
            return;
          }
          for (const fn of listeners) fn.call(server, req, res);
        });
      }
      return server;
    };
  }
  const guardJson = createJetboxJsonGuard(ResponseClass);
  const htmlHeaders = (tok) => ({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "frame-ancestors 'self' http://127.0.0.1:* http://localhost:* plugin://*",
    ...(tok ? { 'Set-Cookie': `hangar_jetbox_tok=${encodeURIComponent(tok)}; HttpOnly; SameSite=Lax; Path=/` } : {}),
  });
  app.api('/jetbox-terminal', async (data, ctx) => {
    const auth = checkJetboxAuth(data, ctx, { requireToken: true });
    if (!auth.ok) return new ResponseClass(auth.error, { status: auth.status, contentType: 'text/plain; charset=utf-8', headers: { 'Cache-Control': 'no-store' } });
    return new ResponseClass(buildJetboxTerminalHtml({ cascadeId: data?.cascadeId, terminalId: data?.terminalId, hostTheme: data?.hostTheme, uiToken: auth.uiToken, configPath }), { contentType: 'text/html; charset=utf-8', headers: htmlHeaders(auth.uiToken) });
  }, 'GET');
  app.api('/jetbox-chat', async (data, ctx) => {
    const auth = checkJetboxAuth(data, ctx, { requireToken: true });
    if (!auth.ok) return new ResponseClass(auth.error, { status: auth.status, contentType: 'text/plain; charset=utf-8', headers: { 'Cache-Control': 'no-store' } });
    return new ResponseClass(buildJetboxChatHtml({ cascadeId: data?.cascadeId, hostTheme: data?.hostTheme, uiToken: auth.uiToken, configPath }), { contentType: 'text/html; charset=utf-8', headers: htmlHeaders(auth.uiToken) });
  }, 'GET');
  if (!app._jetboxStreamSweepTimer) {
    app._jetboxStreamSweepTimer = setInterval(() => {
      evictStaleChatStreams();
      evictStaleVcsStreams();
      evictStaleAudioStreams();
    }, 30_000);
    app._jetboxStreamSweepTimer.unref?.();
  }
  app.api('/api/terminal/sidechat/start', guardJson(async (data) => {
    const res = await startTerminalSideChat({
      ...(data || {}),
      hideFromAntigravity: data?.hideFromAntigravity !== undefined
        ? Boolean(data.hideFromAntigravity)
        : Boolean(getHideHangarSideQuestions?.()),
      rpcFn,
    });
    onMutate?.();
    return res;
  }), 'POST');
  app.api('/api/terminal/sidechat/delete', guardJson(async (data) => {
    const res = await deleteTerminalSideChat({ ...(data || {}), rpcFn });
    onMutate?.();
    return res;
  }), 'POST');
  app.api('/api/terminal/sidechat/close-stream', guardJson((data) => closeTerminalSideChatStreams(data || {})), 'POST');
  app.api('/api/terminal/chat-poll', guardJson((data) => awaitChatPoll(data || {}, { fetchFn, rpcFn })), 'POST');
  app.api('/api/terminal/audio-poll', guardJson((data) => awaitAudioPoll(data || {}, { fetchFn })), 'POST');
  app.api('/api/terminal/vcs-poll', guardJson((data) => awaitVcsPoll(data || {}, { fetchFn })), 'POST');
  app.api('/api/terminal/ls-rpc', guardJson(async (data) => {
    const method = String(data?.method || '').trim();
    if (!/^[A-Za-z0-9_]+$/.test(method)) throw new Error(`Disallowed Jetbox RPC method: ${method}`);
    if (method === 'WriteQuoteFile') {
      const tid = data?.terminalId || data?.targetTerminalId || '';
      const uri = writeQuoteFile(data?.name, data?.selectionContent, tid);
      syncQuoteWithHostWindow({ conversationId: data?.conversationId || data?.targetConversationId, terminalId: tid, name: data?.name, selectionContent: data?.selectionContent, action: 'stage' }).catch(() => {});
      return { uri };
    }
    if (method === 'InjectQuoteDrop') return syncQuoteWithHostWindow({ conversationId: data?.conversationId || data?.targetConversationId, terminalId: data?.terminalId || data?.targetTerminalId, name: data?.name || data?.title, selectionContent: data?.selectionContent, action: 'drop' });
    if (method === 'GetSidecars') {
      if (data?.mode !== 'chat') return { sidecars: [] };
      const raw = await rpcFn('GetSidecars', {}).catch(() => ({}));
      const list = Array.isArray(raw?.sidecars) ? raw.sidecars : [];
      return { sidecars: list.map((s) => ({ ...s, webPort: 0, baseUrl: 'http://hangar-sidecar.invalid' })) };
    }
    if (method === 'HasAuthToken') return { hasToken: true };
    if (method === 'JetboxReadState') {
      const { orchestratorModel, orchestratorExecutorModel } = readHostJetboxSeed(configPath).userSettings;
      return {
        appState: { agentOnboardingCompleted: 2 },
        userConfig: {
          userSettings: {
            themeMode: 1,
            ...(orchestratorModel !== undefined ? { orchestratorModel } : {}),
            ...(orchestratorExecutorModel !== undefined ? { orchestratorExecutorModel } : {}),
          },
        },
      };
    }
    if (NOOP_JETBOX_RPCS.has(method) || (!ALLOWED_JETBOX_RPCS.has(method) && /^(Get|List|Fetch|Check|Has|Read|Resolve|Find|Query|Load)/.test(method))) return {};
    if (!ALLOWED_JETBOX_RPCS.has(method)) throw new Error(`Disallowed Jetbox RPC method: ${method}`);
    if (method === 'GetMergedCascadeTrajectories') return fetchMergedCascadeTrajectories({ rpcFn, fetchFn });
    if (method === 'ReadJetboxStateSnapshot') return readJetboxStateSnapshot({ fetchFn });
    const reqBody = data?.body && typeof data.body === 'object' ? data.body : {};
    if (method === 'ListTerminals') {
      const targetTid = String(data?.targetTerminalId || '').trim();
      const targetCid = String(data?.targetConversationId || reqBody.conversationId || '').trim();
      if (!targetTid && !targetCid) return rpcFn('ListTerminals', reqBody);
      const raw = await rpcFn('ListTerminals', {});
      const list = Array.isArray(raw?.terminals) ? raw.terminals : [];
      const ids = targetTid ? targetTid.split(',').map((s) => s.trim()).filter(Boolean) : [];
      const byTid = ids.length ? list.filter((t) => ids.includes(t?.terminalId)) : [];
      const matched = ids.length
        ? (byTid.length ? byTid : list.filter((t) => ids.includes(t?.splitGroupId)))
        : list.filter((t) => !targetCid || (t?.conversationId && (t.conversationId === targetCid || t.conversationId === `hangar:${targetCid}`)));
      const forcedSg = ids.length >= 2 && matched.length >= 2 ? (ids[0] || matched[0]?.splitGroupId || matched[0]?.terminalId) : undefined;
      return { terminals: matched.map(({ splitGroupId, ...t }) => ({ ...t, conversationId: targetCid || t.conversationId || '', projectId: '', ...(forcedSg ? { splitGroupId: forcedSg } : (!ids.length && splitGroupId ? { splitGroupId } : {})), workspaceUri: '' })) };
    }
    if (method === 'CreateTerminal') {
      const inheritedHide = reqBody.splitFromTerminalId
        ? getTerminalHiddenScheme(reqBody.splitFromTerminalId)
        : undefined;
      const hideTerm = inheritedHide !== undefined
        ? inheritedHide
        : (data?.hideHangarTerminals !== undefined
          ? Boolean(data.hideHangarTerminals)
          : (typeof getHideHangarTerminals === 'function' ? Boolean(getHideHangarTerminals()) : true));
      const sanitized = hideTerm ? withHangarWorkspaceUris(reqBody) : withSharedWorkspaceUris(reqBody);
      if (hideTerm) {
        const cid = String(sanitized.conversationId || '').trim() || '_new';
        sanitized.conversationId = cid.startsWith('hangar:') ? cid : `hangar:${cid}`;
      }
      const res = await rpcFn('CreateTerminal', sanitized);
      if (res?.terminal?.terminalId) {
        markHangarTerminalId(res.terminal.terminalId);
        recordTerminalHiddenScheme(res.terminal.terminalId, hideTerm);
      }
      onMutate?.();
      return res;
    }
    if (method === 'SendTerminalInput' && reqBody.resize && ((Number(reqBody.resize.cols) || 0) < 10 || (Number(reqBody.resize.rows) || 0) < 3)) return {};
    if (method === 'SendTerminalInput' && reqBody.input) {
      try {
        onTerminalInput?.(reqBody.terminalId || data?.targetTerminalId || '', Buffer.from(String(reqBody.input), 'base64').toString('utf8'), reqBody.inputStreamId, reqBody.inputOffset);
      } catch {}
    }
    if (method === 'DeleteCascadeTrajectory') {
      const delCid = String(reqBody.cascadeId || reqBody.conversationId || '').trim();
      const res = await deleteTerminalSideChat({ cascadeId: delCid, rpcFn });
      onMutate?.();
      return res;
    }
    if (method === 'StartCascade' && Boolean(getHideHangarSideQuestions?.()) && reqBody.baseTrajectoryIdentifier) {
      const stripped = { ...reqBody };
      delete stripped.baseTrajectoryIdentifier;
      return rpcFn('StartCascade', stripped);
    }
    const isStrictRpc = isStrictJetboxRpc(method);
    return isStrictRpc ? rpcFn(method, reqBody) : rpcFn(method, reqBody).catch(() => ({}));
  }), 'POST');
}
